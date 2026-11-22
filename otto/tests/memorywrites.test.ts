/**
 * The app's memory list against the real store (apptwin.ts): a forget takes the path the
 * `forget` tool takes, an edit the write `remember` makes, and neither touches a file itself.
 */
import { test, expect, afterAll } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { startTwin, type Twin } from './apptwin.ts'

let t: Twin
afterAll(async () => { await t?.stop().catch(() => {}) })
const text = (r: any) => String(r?.content?.[0]?.text ?? '')
const post = (path: string, body: unknown, auth = `Bearer ${t.token}`) =>
  fetch(`${t.url}/app/dash/${path}`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
const pub = (key: string) => 'm' + createHash('sha256').update(key).digest('hex').slice(0, 12)

test('forget and edit from the list change the store itself, for a durable memory and for a note', async () => {
  t = await startTwin()
  const home = join(t.state, '..', '..')
  expect(text(await t.call('remember', { kind: 'reference', name: 'wifi-password-place', description: 'where the wifi password is kept', text: 'In the drawer.' }))).toContain('stored memory [wifi-password-place]')
  expect(text(await t.call('remember', { kind: 'reference', name: 'bin-day', description: 'when the bins go out', text: 'Tuesday.' }))).toContain('stored memory')
  const loop = /\[(\w+)\]/.exec(text(await t.call('remember', { kind: 'loop', text: 'call the plumber' })))![1]
  const saved = /\[(\w+)\]/.exec(text(await t.call('remember', { kind: 'saved', text: 'a link worth keeping' })))![1]
  const file = (name: string) => join(home, '.claude', 'memory', 'global', `${name}.md`)
  expect(existsSync(file('wifi-password-place'))).toBe(true)

  // The snapshot the list is read from, as the nightly build would have left it.
  const item = (o: Record<string, unknown>) => ({ kind: 'reference', description: '', updated: '2026-03-01T00:00:00.000Z', hits: 0, ...o })
  writeFileSync(join(t.state, 'memory-viewer.json'), JSON.stringify({
    items: [
      item({ id: 'global/wifi-password-place', store: 'durable', scope: 'global', name: 'wifi-password-place', body: 'In the drawer.' }),
      item({ id: 'global/bin-day', store: 'durable', scope: 'global', name: 'bin-day', body: 'Tuesday.' }),
      item({ id: loop, store: 'notes', scope: 'notes', kind: 'loop', name: 'call the plumber', body: 'call the plumber' }),
      item({ id: saved, store: 'notes', scope: 'notes', kind: 'saved', name: 'a link worth keeping', body: 'a link worth keeping' }),
    ],
    summary: { text: '', note: '' }, generatedAt: '2026-03-01T00:00:00.000Z', graph: { links: [], similar: [], note: '' }, scopes: { global: 'global', notes: 'notes' },
  }))

  const edited = await post('memory/item', { id: pub('global/bin-day'), body: 'Wednesday now.' })
  expect(edited.status).toBe(200)
  expect(await edited.json()).toMatchObject({ name: 'bin-day', body: 'Wednesday now.' })
  const md = readFileSync(file('bin-day'), 'utf8')
  expect(md).toContain('Wednesday now.')
  expect(md).toContain('description: when the bins go out')   // only the text changed
  expect(md).toContain('type: reference')

  expect((await post('memory/item', { id: loop, body: 'call the plumber on Monday' })).status).toBe(200)
  expect(text(await t.call('recall', { query: 'plumber' }))).toContain('call the plumber on Monday')

  const gone = await post('memory/forget', { id: pub('global/wifi-password-place') })
  expect(await gone.json()).toMatchObject({ forgotten: true })
  expect(existsSync(file('wifi-password-place'))).toBe(false)
  expect(readFileSync(join(home, '.claude', 'memory', 'global', 'MEMORY.md'), 'utf8')).not.toContain('wifi-password-place')   // the index line went with it, as the tool does
  expect(existsSync(file('bin-day'))).toBe(true)

  expect((await post('memory/forget', { id: saved })).status).toBe(200)
  const notes = JSON.parse(readFileSync(join(t.state, 'notes.json'), 'utf8')) as { id: string }[]
  expect(notes.map(n => n.id)).toEqual([loop])
  // The tool still works on what is left, through the same function.
  expect(text(await t.call('forget', { id: loop }))).toContain(`forgot ${loop}`)
  expect((await t.call('forget', { id: loop }) as any).isError).toBe(true)

  expect((await post('memory/forget', { id: loop }, 'Bearer wrong')).status).toBe(401)
  expect((await fetch(`${t.url}/app/dash/memory/forget`, { method: 'POST', body: '{}' })).status).toBe(401)
}, 90000)
