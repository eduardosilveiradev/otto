/** The app's trigger list against the real server (apptwin.ts): run one now, switch one, delete one. */
import { test, expect, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { startTwin, phone, waitFor, type Twin } from './apptwin.ts'

let t: Twin
afterAll(async () => { await t?.stop().catch(() => {}) })
const text = (r: any) => String(r?.content?.[0]?.text ?? '')
const post = (path: string, body: unknown, auth = `Bearer ${t.token}`) =>
  fetch(`${t.url}/app/dash/triggers/${path}`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
const triggers = () => JSON.parse(readFileSync(join(t.state, 'triggers.json'), 'utf8')) as any[]
const made = (r: unknown) => /created trigger \[?([\w-]+)/.exec(text(r))![1]

test('run fires the trigger as its schedule would and leaves the schedule alone; what it sends carries its src', async () => {
  t = await startTwin()
  const p = await phone(t)
  const at = new Date(Date.now() + 6 * 3600_000).toISOString()
  const id = made(await t.call('create_trigger', { type: 'cron', schedule: at, action: 'Tell the user the laundry is done.', allow_quiet_hours: true }))
  const watcher = made(await t.call('create_trigger', { type: 'email', condition: 'the landlord replies', action: 'tell the user' }))
  const before = triggers().find(x => x.id === id)

  const r = await post('run', { id })
  expect(r.status).toBe(202)
  expect(await r.json()).toEqual({ started: true })
  const fired = await waitFor(() => t.delivered.find(d => d.meta.event === 'trigger' && d.meta.trigger_id === id))
  expect(fired!.content).toContain('Tell the user the laundry is done.')
  const after = triggers().find(x => x.id === id)
  expect(after).toMatchObject({ enabled: true, schedule: at, nextRun: before.nextRun })   // still due at its own time
  expect(Number.isNaN(Date.parse(after.lastFired))).toBe(false)

  // Not read yet: a second press is refused, not queued behind the first.
  const again = await post('run', { id })
  expect(again.status).toBe(409)
  expect(await again.json()).toEqual({ error: 'running' })
  expect(t.delivered.filter(d => d.meta.trigger_id === id)).toHaveLength(1)

  // Whatever the turn it started sends is attributed to the trigger, as a scheduled fire's is.
  await t.call('reply', { chat_id: 'app', text: 'laundry is done', verbatim: true })
  expect(await p.until(f => f.type === 'message' && f.text === 'laundry is done')).toMatchObject({ src: `trigger:${id}` })

  expect((await post('run', { id: watcher })).status).toBe(400)   // an email watcher acts on a mail, and there is none
  expect((await post('run', { id: 'nope1234' })).status).toBe(404)
}, 90000)

test('toggle switches a one-shot and an email watcher; delete takes the tool\'s path and leaves an undo', async () => {
  const [oneShot, watcher] = triggers().map(x => x.id as string)
  const off = await post('toggle', { id: oneShot, enabled: false })
  expect(await off.json()).toMatchObject({ id: oneShot, type: 'cron', repeating: false, enabled: false })
  expect(triggers().find(x => x.id === oneShot).enabled).toBe(false)
  expect(await (await post('toggle', { id: oneShot, enabled: true })).json()).toMatchObject({ enabled: true })
  expect((await post('toggle', { id: watcher, enabled: false })).status).toBe(200)
  expect(triggers().find(x => x.id === watcher).enabled).toBe(false)

  expect(await (await post('delete', { id: watcher })).json()).toEqual({ deleted: true })
  expect(triggers().map(x => x.id)).toEqual([oneShot])
  const note = (JSON.parse(readFileSync(join(t.state, 'notes.json'), 'utf8')) as any[]).find(n => n.kind === 'write' && n.text.includes(watcher))
  expect(note.undo).toContain('create_trigger')
  expect((await post('delete', { id: watcher })).status).toBe(404)
  // The tool is the same removal: it finds the other one, then nothing.
  expect(text(await t.call('delete_trigger', { id: oneShot }))).toBe(`deleted ${oneShot}`)
  expect((await t.call('delete_trigger', { id: oneShot }) as any).isError).toBe(true)
  expect(triggers()).toEqual([])
}, 60000)

test('the trigger writes take no request without a device token', async () => {
  for (const path of ['run', 'delete', 'toggle']) {
    expect((await post(path, { id: 'x', enabled: true }, 'Bearer wrong')).status).toBe(401)
    expect((await fetch(`${t.url}/app/dash/triggers/${path}`, { method: 'POST', body: '{}' })).status).toBe(401)
  }
}, 30000)
