import { test, expect, afterEach } from 'bun:test'
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startTwin, phone, waitFor, type Twin } from './apptwin.ts'

let t: Twin
const clients: Awaited<ReturnType<typeof phone>>[] = []
afterEach(async () => { for (const p of clients.splice(0)) p.close(); if (t) await t.stop() })
async function connect(other = false) {
  let token = t.token
  if (other) {
    const made = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'apptokens.ts'), 'new', 'other-device'], {
      env: { PATH: process.env.PATH!, OTTO_STATE_DIR: t.state },
    })
    token = String(made.stdout).match(/[A-Za-z0-9_-]{24,}/)![0]
  }
  const p = await phone({ ...t, token }); clients.push(p)
  await p.until(f => f.type === 'hello')
  return p
}
async function message(p: Awaited<ReturnType<typeof phone>>, text = 'choose') {
  await t.call('reply', { chat_id: 'app', text, verbatim: true, buttons: [{ label: 'do it', data: 'perform this action' }, { label: 'skip', data: 'skip this action' }] })
  return (await p.until(f => f.type === 'message' && f.text === text)).id as string
}
const ack = (p: Awaited<ReturnType<typeof phone>>, id: string) => p.until(f => f.type === 'ack' && f.id === id)
const state = () => JSON.parse(readFileSync(join(t.state, 'app-sync.json'), 'utf8'))

test('desktop reads reach a connected phone, never the reading device or unread messages', async () => {
  t = await startTwin()
  const desk = await connect(), p = await connect(true)
  desk.send({ type: 'presence', focused: false })
  const id = await message(desk), unread = await message(desk, 'still unread')
  desk.send({ type: 'notifications_read', op: 'read-one', ids: [id] })
  expect(await p.until(f => f.type === 'notifications_read')).toEqual({ type: 'notifications_read', ids: [id] })
  expect(await ack(desk, 'read-one')).toBeTruthy()
  expect(desk.got.filter(f => f.type === 'notifications_read')).toHaveLength(0)
  expect(state()[`read:${unread}`]).toBeUndefined()
  desk.close()
  const again = await connect()
  await again.until(f => f.type === 'typing')
  expect(again.got.filter(f => f.type === 'notifications_read')).toHaveLength(0)
}, 60000)

test('offline phones each receive reads after reconnect, including after server restart', async () => {
  t = await startTwin()
  const desk = await connect()
  desk.send({ type: 'presence', focused: false })
  const id = await message(desk)
  desk.send({ type: 'notifications_read', op: 'read-offline', ids: [id] })
  expect(await ack(desk, 'read-offline')).toBeTruthy()
  t = await t.restart()
  for (let i = 0; i < 2; i++) {
    const p = await connect(true)
    expect(await p.until(f => f.type === 'notifications_read')).toEqual({ type: 'notifications_read', ids: [id] })
  }
}, 60000)

test('many desktop reads land in one write and reach a reconnecting phone as one frame', async () => {
  t = await startTwin()
  const desk = await connect()
  desk.send({ type: 'presence', focused: false })
  const ids = Array.from({ length: 120 }, (_, i) => `n${i}`)
  desk.send({ type: 'notifications_read', op: 'read-many', ids })
  expect(await ack(desk, 'read-many')).toBeTruthy()
  expect(Object.keys(state()).filter(k => k.startsWith('read:'))).toHaveLength(120)
  const p = await connect(true)
  await p.until(f => f.type === 'typing')
  const frames = p.got.filter(f => f.type === 'notifications_read')
  expect(frames).toHaveLength(1)
  expect(frames[0].ids).toEqual(ids)
}, 60000)

test('a phone cannot report desktop reads and malformed read ids do nothing', async () => {
  t = await startTwin()
  const p = await connect(), other = await connect(true)
  const id = await message(p)
  p.send({ type: 'notifications_read', op: 'phone-read', ids: [id] })
  expect(await ack(p, 'phone-read')).toBeTruthy()
  p.send({ type: 'presence', focused: false })
  p.send({ type: 'notifications_read', op: 'bad-read', ids: [id, 3] })
  expect(await ack(p, 'bad-read')).toBeTruthy()
  expect(other.got.filter(f => f.type === 'notifications_read')).toHaveLength(0)
}, 60000)

test('desktop taps reach a connected phone with the source message and chosen button, without echo', async () => {
  t = await startTwin()
  const desk = await connect(), p = await connect(true)
  desk.send({ type: 'presence', focused: false })
  const id = await message(desk)
  desk.send({ type: 'tap', id, op: 'tap-one', data: 'perform this action', label: 'do it' })
  expect(await p.until(f => f.type === 'button_tapped')).toMatchObject({ id, op: 'tap-one', data: 'perform this action', label: 'do it', ts: expect.any(String) })
  expect(await ack(desk, 'tap-one')).toBeTruthy()
  expect(desk.got.filter(f => f.type === 'button_tapped')).toHaveLength(0)
  expect(t.delivered.filter(d => d.content.includes('perform this action'))).toHaveLength(1)
}, 60000)

test('offline phones receive a tap after restart; another device and another button cannot run it again', async () => {
  t = await startTwin()
  const desk = await connect()
  const id = await message(desk)
  desk.send({ type: 'tap', id, op: 'tap-first', data: 'perform this action', label: 'do it' })
  expect(await ack(desk, 'tap-first')).toBeTruthy()
  t = await t.restart()
  const p = await connect(true)
  expect(await p.until(f => f.type === 'button_tapped')).toMatchObject({ id, op: 'tap-first' })
  p.send({ type: 'tap', id, op: 'tap-second', data: 'skip this action', label: 'skip' })
  expect(await ack(p, 'tap-second')).toBeTruthy()
  expect(t.delivered.filter(d => d.content.includes('skip this action'))).toHaveLength(0)
  expect(p.got.filter(f => f.type === 'button_tapped')).toHaveLength(1)
  const later = await connect(true)
  expect(await later.until(f => f.type === 'button_tapped')).toMatchObject({ id, op: 'tap-first' })
  const source = await connect()
  await source.until(f => f.type === 'typing')
  expect(source.got.filter(f => f.type === 'button_tapped')).toHaveLength(0)
}, 60000)

test('simultaneous taps with different operations execute the action only once', async () => {
  t = await startTwin()
  const desk = await connect(), p = await connect(true)
  const id = await message(desk)
  desk.send({ type: 'tap', id, op: 'race-a', data: 'perform this action', label: 'do it' })
  p.send({ type: 'tap', id, op: 'race-b', data: 'perform this action', label: 'do it' })
  expect(await ack(desk, 'race-a')).toBeTruthy()
  expect(await ack(p, 'race-b')).toBeTruthy()
  expect(await waitFor(() => t.delivered.some(d => d.content.includes('perform this action')))).toBe(true)
  expect(t.delivered.filter(d => d.content.includes('perform this action'))).toHaveLength(1)
}, 60000)


test('Bark pushes carry the app message id, and desktop reads delete only that id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-sync-bark-'))
  const file = join(dir, 'pushes.jsonl'), preload = join(dir, 'capture.ts')
  writeFileSync(file, '')
  writeFileSync(preload, `
    import { appendFileSync } from 'fs'
    const original = globalThis.fetch
    globalThis.fetch = ((url, init) => {
      if (String(url) === 'https://api.day.app/info') return Promise.resolve(Response.json({ version: 'v2.2.5' }))
      if (String(url).startsWith('https://api.day.app/')) {
        appendFileSync(${JSON.stringify(file)}, String(init?.body) + '\\n')
        return Promise.resolve(new Response('{}'))
      }
      return original(url, init)
    }) as typeof fetch
  `)
  t = await startTwin(undefined, { BARK_KEY: 'test-device-key' }, preload)
  const desk = await connect()
  desk.send({ type: 'presence', focused: false })
  // An ack is a barrier after the presence frame, with no sleeps needed.
  desk.send({ type: 'ping', op: 'presence-ready' })
  await ack(desk, 'presence-ready')
  await t.call('reply', { chat_id: 'app', text: 'choose', verbatim: true, bark: true })
  const { id } = await desk.until(f => f.type === 'message' && f.text === 'choose')
  await t.call('reply', { chat_id: 'app', text: 'critical notice', verbatim: true, critical: true })
  const critical = await desk.until(f => f.type === 'message' && f.text === 'critical notice')
  const pushes = () => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s))
  expect(pushes().find(p => p.body === 'choose')).toMatchObject({ id })
  expect(pushes().find(p => p.body === 'critical notice')).toMatchObject({ id: critical.id, level: 'critical', volume: 0 })
  desk.send({ type: 'notifications_read', op: 'bark-read', ids: [id] })
  expect(await ack(desk, 'bark-read')).toBeTruthy()
  expect(await waitFor(() => pushes().some(p => p.delete))).toBe(true)
  expect(pushes().filter(p => p.delete)).toEqual([{ id, delete: '1' }])
  // The currently hosted Bark service reports v2.0.0: never send it a delete
  // payload that an older server could turn into a new empty notification.
  await t.stop()
  writeFileSync(preload, readFileSync(preload, 'utf8').replace("'v2.2.5'", "'v2.0.0'"))
  t = await startTwin(undefined, { BARK_KEY: 'test-device-key' }, preload)
  const oldDesk = await connect()
  oldDesk.send({ type: 'presence', focused: false })
  const oldId = await message(oldDesk, 'older server')
  oldDesk.send({ type: 'notifications_read', op: 'old-bark-read', ids: [oldId] })
  expect(await ack(oldDesk, 'old-bark-read')).toBeTruthy()
  const other = await connect(true)
  expect(await other.until(f => f.type === 'notifications_read')).toMatchObject({ ids: [oldId] })
  await Bun.sleep(100)
  expect(pushes().filter(p => p.delete)).toEqual([{ id, delete: '1' }])
}, 60000)


test('legacy desktop taps resolve their source message and cannot bypass cross-device dedupe', async () => {
  t = await startTwin()
  const desk = await connect(), p = await connect(true)
  const id = await message(desk)
  desk.send({ type: 'tap', op: 'legacy-first', data: 'perform this action', label: 'do it' })
  expect(await p.until(f => f.type === 'button_tapped')).toMatchObject({ id, op: 'legacy-first' })
  expect(await ack(desk, 'legacy-first')).toBeTruthy()
  p.send({ type: 'tap', op: 'legacy-second', data: 'perform this action', label: 'do it' })
  expect(await ack(p, 'legacy-second')).toBeTruthy()
  expect(t.delivered.filter(d => d.content.includes('perform this action'))).toHaveLength(1)
}, 60000)

const seen = (ts: unknown, token = t.token, method = 'POST') => fetch(`${t.url}/app/seen`, {
  method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  ...(method === 'POST' ? { body: JSON.stringify({ ts }) } : {}),
})
async function desktop(p: Awaited<ReturnType<typeof phone>>) {
  p.send({ type: 'presence', focused: false })
  p.send({ type: 'ping', op: 'desktop-ready' })
  await ack(p, 'desktop-ready')
}

test('phone seen reaches only desktops, stays monotonic, and leaves inbound receipts alone', async () => {
  t = await startTwin()
  const p = await connect(), desk = await connect(true)
  await desktop(desk)
  expect(await desk.until(f => f.type === 'seen')).toEqual({ type: 'seen', ts: 0 })
  const ts = Date.now()
  expect((await seen(ts)).status).toBe(204)
  expect(await desk.until(f => f.type === 'seen' && f.ts === ts)).toEqual({ type: 'seen', ts })
  expect((await seen(ts - 1)).status).toBe(204)
  expect((await seen(ts)).status).toBe(204)
  expect(JSON.parse(readFileSync(join(t.state, 'app-seen.json'), 'utf8'))).toBe(ts)
  desk.send({ type: 'ping', op: 'seen-barrier' })
  await ack(desk, 'seen-barrier')
  expect(desk.got.filter(f => f.type === 'seen' && f.ts !== 0)).toEqual([{ type: 'seen', ts }])
  expect(p.got.filter(f => f.type === 'seen' || f.type === 'read')).toEqual([])
}, 60000)

test('seen catches up desktops after restart and on reconnect', async () => {
  t = await startTwin()
  const ts = Date.now()
  expect((await seen(ts)).status).toBe(204)
  t = await t.restart()
  expect((await seen(ts - 1)).status).toBe(204)
  const desk = await connect()
  await desktop(desk)
  expect(await desk.until(f => f.type === 'seen')).toEqual({ type: 'seen', ts })
  desk.close()
  const again = await connect()
  expect(await again.until(f => f.type === 'seen')).toEqual({ type: 'seen', ts })
}, 60000)

test('seen requires app authentication, a phone token, POST, and a valid timestamp', async () => {
  t = await startTwin()
  expect((await seen(1, 'invalid')).status).toBe(401)
  expect((await seen(1, t.token, 'GET')).status).toBe(405)
  for (const ts of [null, '123', -1, 1.5, 1e100]) expect((await seen(ts)).status).toBe(400)
  const malformed = await fetch(`${t.url}/app/seen`, {
    method: 'POST', headers: { authorization: `Bearer ${t.token}` }, body: '{',
  })
  expect(malformed.status).toBe(400)
  const desk = await connect()
  await desktop(desk)
  expect((await seen(Date.now())).status).toBe(403)
  desk.close()
  expect((await seen(Date.now())).status).toBe(403)
}, 60000)

/** A reply carrying two recorded cards (a memory and a loop, each with its own action) and one plain button. */
async function recordedMessage(p: Awaited<ReturnType<typeof phone>>) {
  await t.call('remember', { kind: 'reference', name: 'gate-code', description: 'the gate code place', text: 'On the fridge.' })
  await t.call('remember', { kind: 'loop', text: 'ring the dentist' })
  await t.call('reply', { chat_id: 'app', text: 'noted both', verbatim: true, buttons: [{ label: 'thanks', data: 'say thanks' }] })
  const m = await p.until(f => f.type === 'message' && f.text === 'noted both')
  expect(m.recorded.map((c: any) => c.kind)).toEqual(['memory', 'loop'])
  return m as { id: string; recorded: { id: string; kind: string; action: { label: string; data: string } }[] }
}
const historyRow = async (id: string) => ((await (await fetch(`${t.url}/app/history`, { headers: { authorization: `Bearer ${t.token}` } })).json()) as any[]).find(r => r.id === id)

test('each recorded card has its own one-shot action: one used leaves the card beside it, and the message button, live', async () => {
  t = await startTwin()
  const desk = await connect(), p = await connect(true)
  const m = await recordedMessage(desk)
  const [memory, loop] = m.recorded
  expect((await historyRow(m.id)).recorded.some((c: any) => 'done' in c)).toBe(false)

  desk.send({ type: 'tap', id: m.id, card: memory.id, op: 'card-1', data: memory.action.data, label: memory.action.label })
  expect(await ack(desk, 'card-1')).toBeTruthy()
  expect(await p.until(f => f.type === 'button_tapped')).toMatchObject({ id: m.id, card: memory.id, op: 'card-1', data: memory.action.data })
  expect(Object.keys(state())).toContain(`tap:${m.id}:${memory.id}`)

  // The loop beside it still takes its own tap, from the other device, and so does the plain button.
  p.send({ type: 'tap', id: m.id, card: loop.id, op: 'card-2', data: loop.action.data, label: loop.action.label })
  expect(await ack(p, 'card-2')).toBeTruthy()
  expect(await desk.until(f => f.type === 'button_tapped' && f.card === loop.id)).toMatchObject({ id: m.id, op: 'card-2' })
  desk.send({ type: 'tap', id: m.id, op: 'plain-1', data: 'say thanks', label: 'thanks' })
  expect(await ack(desk, 'plain-1')).toBeTruthy()
  expect(await p.until(f => f.type === 'button_tapped' && f.op === 'plain-1')).not.toHaveProperty('card')
  expect(await waitFor(() => t.delivered.some(d => d.content.includes('say thanks')))).toBe(true)

  // The first card again, from the other device under a new op: acked, not run.
  const taps = () => (JSON.parse(readFileSync(join(t.state, 'inbound-journal.json'), 'utf8')) as any[]).filter(e => e.text === memory.action.data).length
  const ran = taps()
  p.send({ type: 'tap', id: m.id, card: memory.id, op: 'card-1-again', data: memory.action.data, label: memory.action.label })
  expect(await ack(p, 'card-1-again')).toBeTruthy()
  expect(taps()).toBe(ran)

  const row = await historyRow(m.id)
  expect(row.recorded.map((c: any) => c.done)).toEqual([memory.action.label, loop.action.label])
}, 60000)

test('a card key takes only that card\'s own action, and a client that names no card lands on the same key', async () => {
  t = await startTwin()
  const desk = await connect(), p = await connect(true)
  const m = await recordedMessage(desk)
  const [memory, loop] = m.recorded

  // The message's button filed under a card, or one card's action under the other: acked, nothing runs, nothing is used up.
  desk.send({ type: 'tap', id: m.id, card: memory.id, op: 'forged-1', data: 'say thanks', label: 'thanks' })
  expect(await ack(desk, 'forged-1')).toBeTruthy()
  desk.send({ type: 'tap', id: m.id, card: loop.id, op: 'forged-2', data: memory.action.data, label: 'x' })
  expect(await ack(desk, 'forged-2')).toBeTruthy()
  desk.send({ type: 'tap', id: m.id, card: 'no-such-card', op: 'forged-3', data: loop.action.data, label: 'x' })
  expect(await ack(desk, 'forged-3')).toBeTruthy()
  await Bun.sleep(200)
  expect(t.delivered.some(d => d.content.includes('say thanks'))).toBe(false)
  expect(existsSync(join(t.state, 'app-sync.json')) ? Object.keys(state()) : []).toEqual([])
  expect(p.got.filter(f => f.type === 'button_tapped')).toHaveLength(0)

  // An older app sends no card: the server works out which card the action is, so a newer one can't run it again.
  p.send({ type: 'tap', id: m.id, op: 'old-app', data: loop.action.data, label: loop.action.label })
  expect(await ack(p, 'old-app')).toBeTruthy()
  expect(await desk.until(f => f.type === 'button_tapped')).toMatchObject({ id: m.id, card: loop.id })
  expect(Object.keys(state())).toEqual([`tap:${m.id}:${loop.id}`])
  expect((await historyRow(m.id)).recorded.map((c: any) => c.done)).toEqual([undefined, loop.action.label])
}, 60000)

test('a tap recorded under the whole message before cards had their own keys still blocks that action, and only that one', async () => {
  t = await startTwin()
  const desk = await connect()
  const m = await recordedMessage(desk)
  const [memory, loop] = m.recorded
  await t.stop()
  writeFileSync(join(t.state, 'app-sync.json'), JSON.stringify({ [`tap:${m.id}`]: { sources: ['old'], frame: { type: 'button_tapped', id: m.id, data: memory.action.data, label: memory.action.label, op: 'before', ts: new Date().toISOString() } } }))
  t = await t.restart()
  const p = await connect()
  p.send({ type: 'tap', id: m.id, card: memory.id, op: 'after-1', data: memory.action.data, label: memory.action.label })
  expect(await ack(p, 'after-1')).toBeTruthy()
  expect(Object.keys(state())).toEqual([`tap:${m.id}`])
  p.send({ type: 'tap', id: m.id, card: loop.id, op: 'after-2', data: loop.action.data, label: loop.action.label })
  expect(await ack(p, 'after-2')).toBeTruthy()
  expect(Object.keys(state()).sort()).toEqual([`tap:${m.id}`, `tap:${m.id}:${loop.id}`])
  expect((await historyRow(m.id)).recorded.map((c: any) => c.done)).toEqual([memory.action.label, loop.action.label])
}, 60000)
