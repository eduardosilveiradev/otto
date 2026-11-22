import { test, expect } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { reminderItems, ackItems, applyAck, markReminderFired, parseNotify } from '../reminders.ts'
import { startTwin, phone, waitFor, type Twin } from './apptwin.ts'

const NOW = Date.parse('2026-11-12T10:00:00Z')
const at = (min: number) => NOW + min * 60_000
const trig = (o: Record<string, unknown> = {}) => ({ id: 'r1', type: 'cron', repeating: false, enabled: true, nextRun: at(30), notify: { text: 'call the dentist' }, ...o }) as Parameters<typeof reminderItems>[0][number]

test('only upcoming one-shot cron triggers with a notify line make the set', () => {
  const ts = [
    trig({ id: 'later', nextRun: at(90) }),
    trig({ id: 'soon' }),
    trig({ id: 'recurring', repeating: true }),
    trig({ id: 'plain', notify: undefined }),
    trig({ id: 'email', type: 'email' }),
    trig({ id: 'off', enabled: false }),
    trig({ id: 'gone', nextRun: at(-1) }),
  ]
  expect(reminderItems(ts, NOW)).toEqual([
    { id: 'soon', at: new Date(at(30)).toISOString(), text: 'call the dentist' },
    { id: 'later', at: new Date(at(90)).toISOString(), text: 'call the dentist' },
  ])
})

test('notify parsing: object or string, null or empty clears, long lines refused', () => {
  expect(parseNotify(undefined)).toBeUndefined()
  expect(parseNotify(null)).toBeNull()
  expect(parseNotify({ text: '  ' })).toBeNull()
  expect(parseNotify({ text: ' pay rent ' })).toEqual({ text: 'pay rent' })
  expect(parseNotify('pay rent')).toEqual({ text: 'pay rent' })
  expect(() => parseNotify({ text: 'x'.repeat(201) })).toThrow()
})

test('an ack counts only for the exact fire time, and only for upcoming reminders', () => {
  expect(ackItems('{"type":"ack","id":"x"}')).toBeNull()
  expect(ackItems('nope')).toBeNull()
  const items = ackItems(JSON.stringify({ type: 'reminders_ack', items: [{ id: 'r1', at: new Date(at(30)).toISOString() }, { id: 7 }, { id: 'r2', at: 'bad' }] }))!
  expect(items).toEqual([{ id: 'r1', at: at(30) }])
  const t = trig()
  expect(applyAck([t], [{ id: 'r1', at: at(31) }], NOW)).toBe(false)   // stale: the schedule moved
  expect(t.notify!.ackedAt).toBeUndefined()
  expect(applyAck([t], items, NOW)).toBe(true)
  expect(applyAck([t], items, NOW)).toBe(false)                        // already known: no save
  const recurring = trig({ repeating: true })
  expect(applyAck([recurring], items, NOW)).toBe(false)
})

test('firing marks it as posted by the phone only when the ack matches that run', () => {
  const t = trig()
  applyAck([t], [{ id: 'r1', at: at(30) }], NOW)
  markReminderFired(t)
  expect(t.notify!.onPhone).toBe(true)
  const moved = trig({ notify: { text: 'x', ackedAt: at(30), onPhone: true }, nextRun: at(45) })
  markReminderFired(moved)
  expect(moved.notify!.onPhone).toBeUndefined()
  const never = trig()
  markReminderFired(never)
  expect(never.notify!.onPhone).toBeUndefined()
})

// The wiring, on a real server: the frame on create/update/delete/fire, and the push only skipped after an ack.
async function barkTwin(): Promise<{ t: Twin; pushed: () => { body: string; id?: string }[] }> {
  const { mkdtempSync } = await import('fs')
  const { tmpdir } = await import('os')
  const dir = mkdtempSync(join(tmpdir(), 'otto-reminders-'))
  const pushes = join(dir, 'pushes.jsonl'), preload = join(dir, 'capture.ts')
  writeFileSync(pushes, '')
  writeFileSync(preload, `
    import { appendFileSync } from 'fs'
    const realFetch = globalThis.fetch
    globalThis.fetch = ((url, init) => {
      if (String(url).startsWith('https://api.day.app/')) {
        appendFileSync(${JSON.stringify(pushes)}, String(init?.body) + '\\n')
        return Promise.resolve(new Response('{}'))
      }
      return realFetch(url, init)
    }) as typeof fetch
  `)
  const t = await startTwin(undefined, { BARK_KEY: 'placeholder', OTTO_SCHEDULER_MS: '300' }, preload)
  return { t, pushed: () => readFileSync(pushes, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) }
}

const text = (r: unknown) => ((r as { content?: { text: string }[] }).content ?? [])[0]?.text ?? ''
const createdId = (r: unknown) => text(r).match(/created trigger ([0-9a-f]{8})/)?.[1]
const lastSet = (got: any[]) => [...got].reverse().find(f => f.type === 'reminders')?.items

test('reminders frame follows create, update, delete and fire; acked fires go out quiet with no Bark', async () => {
  const { t, pushed } = await barkTwin()
  try {
    const p = await phone(t)
    expect(await p.until(f => f.type === 'reminders')).toEqual({ type: 'reminders', items: [] })

    const soon = new Date(Date.now() + 4_000).toISOString()
    const later = new Date(Date.now() + 3_600_000).toISOString()
    const a = createdId(await t.call('create_trigger', { type: 'cron', schedule: soon, action: 'reply on chat_id app: stretch', notify: { text: 'stretch' } }))!
    const b = createdId(await t.call('create_trigger', { type: 'cron', schedule: later, action: 'reply on chat_id app: water', notify: { text: 'water' } }))!
    const plain = createdId(await t.call('create_trigger', { type: 'cron', schedule: later, action: 'check the mail' }))
    expect(plain).toBeTruthy()
    expect(text(await t.call('create_trigger', { type: 'cron', schedule: '0 9 * * *', action: 'x', notify: { text: 'daily' } }))).toContain('one-shot')
    expect(await waitFor(() => lastSet(p.got)?.length === 2)).toBe(true)
    expect(lastSet(p.got).map((i: any) => [i.id, i.text])).toEqual([[a, 'stretch'], [b, 'water']])

    await t.call('update_trigger', { id: b, notify: { text: 'drink water' } })
    expect(await waitFor(() => lastSet(p.got)?.[1]?.text === 'drink water')).toBe(true)
    await t.call('delete_trigger', { id: b })
    expect(await waitFor(() => lastSet(p.got)?.length === 1)).toBe(true)

    // The phone has `a` pending; then it goes away (closed app) before the minute.
    const frames = p.got.length
    p.send({ type: 'reminders_ack', items: [{ id: a, at: soon }] })
    expect(await waitFor(() => (JSON.parse(readFileSync(join(t.state, 'triggers.json'), 'utf8')) as any[]).find(x => x.id === a)?.notify?.ackedAt)).toBeTruthy()
    await Bun.sleep(200)
    expect(p.got.slice(frames).some(f => f.type === 'reminders')).toBe(false)   // an ack changes no set: no echo
    p.close()

    const fired = await waitFor(() => t.delivered.find(d => d.meta.trigger_id === a), 15_000)
    expect(fired).toBeTruthy()
    await t.call('reply', { chat_id: 'app', text: 'stretch', verbatim: true })
    await Bun.sleep(6_000)   // past the 5 s ack fallback
    expect(pushed().filter(x => x.body === 'stretch')).toEqual([])
    const rows = await (await fetch(`${t.url}/app/history`, { headers: { authorization: `Bearer ${t.token}` } })).json() as any[]
    expect(rows.find(r => r.text === 'stretch')?.quiet).toBe(true)
    const back = await phone(t)
    expect((await back.until(f => f.type === 'reminders'))?.items).toEqual([])
    back.close()

    // No ack (an older app, or never connected): today's behaviour, the reply pushes.
    const c = createdId(await t.call('create_trigger', { type: 'cron', schedule: new Date(Date.now() + 2_000).toISOString(), action: 'reply on chat_id app: unacked', notify: { text: 'unacked' } }))!
    expect(await waitFor(() => t.delivered.find(d => d.meta.trigger_id === c), 15_000)).toBeTruthy()
    await t.call('reply', { chat_id: 'app', text: 'unacked', verbatim: true })
    expect(await waitFor(() => pushed().some(x => x.body === 'unacked'))).toBe(true)
  } finally {
    await t.stop()
  }
}, 60_000)
