/**
 * Show-off mode end to end (showoff.ts), against one throwaway server: the toggle, its expiry,
 * history cut to its start, personal reads hidden, and showoff="1" on what the session hears.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { startTwin, phone, waitFor, type Twin } from './apptwin.ts'
import { showoffLive } from '../showoff.ts'

let t: Twin
beforeAll(async () => { t = await startTwin() }, 60000)
afterAll(async () => { await t?.stop() })

const auth = () => ({ authorization: `Bearer ${t.token}` })
const showoff = (body?: unknown, headers: Record<string, string> = auth()) =>
  fetch(`${t.url}/app/showoff`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) })
const history = async () => (await fetch(`${t.url}/app/history`, { headers: auth() })).json() as Promise<any[]>
const dash = async (path: string) => (await fetch(`${t.url}/app/dash/${path}`, { headers: auth() })).json() as Promise<any>
const access = () => JSON.parse(readFileSync(join(t.state, 'access.json'), 'utf8'))
async function say(text: string, id: string) {
  const p = await phone(t)
  p.send({ type: 'message', id, text })
  await p.until(f => f.type === 'ack' && f.id === id)
  p.close()
  return (await waitFor(() => t.delivered.find(d => d.meta.message_id === id)))!.meta
}

test('showoffLive: live until `until`, off after', () => {
  const s = { since: '2026-01-01T10:00:00.000Z', until: '2026-01-01T11:00:00.000Z' }
  expect(showoffLive({ showoff: s }, Date.parse('2026-01-01T10:59:00Z'))).toEqual(s)
  expect(showoffLive({ showoff: s }, Date.parse('2026-01-01T11:00:00Z'))).toBeNull()
  expect(showoffLive({})).toBeNull()
  expect(showoffLive(null)).toBeNull()
})

test('the toggle needs an app token', async () => {
  expect((await showoff({ on: true })).status).toBe(200)
  expect((await showoff({ on: false })).status).toBe(200)
  expect((await showoff({ on: true }, {})).status).toBe(401)
  expect((await showoff({ on: true }, { authorization: 'Bearer not-a-token' })).status).toBe(401)
  expect((await showoff(undefined, {})).status).toBe(401)
  expect(access().showoff).toBeUndefined()
  expect((await showoff({ on: 'yes' })).status).toBe(400)
  expect((await showoff({ on: true, minutes: 0 })).status).toBe(400)
})

test('on: hello and a frame carry it, history starts at it, personal reads are hidden, messages say showoff="1"; off restores it all', async () => {
  const before = await say('my private plans', 'SO-before')
  expect(before.showoff).toBeUndefined()
  expect((await history()).some(h => h.id === 'SO-before')).toBe(true)

  const watcher = await phone(t)
  await Bun.sleep(5)
  const on = await (await showoff({ on: true })).json() as any
  expect(on.on).toBe(true)
  expect(Date.parse(on.until) - Date.parse(on.since)).toBeGreaterThan(59 * 60_000)
  expect(await watcher.until(f => f.type === 'showoff')).toMatchObject({ on: true, since: on.since, until: on.until })
  watcher.close()
  expect((await phone(t).then(async p => { const h = await p.until(f => f.type === 'hello'); p.close(); return h })).showoff).toEqual({ since: on.since, until: on.until })
  // Re-arming moves the end, keeps the start.
  const again = await (await showoff({ on: true, minutes: 90 })).json() as any
  expect(again.since).toBe(on.since)
  expect(Date.parse(again.until)).toBeGreaterThan(Date.parse(on.until))

  const during = await say('what can you do?', 'SO-during')
  expect(during.showoff).toBe('1')
  const ids = (await history()).map(h => h.id)
  expect(ids).toContain('SO-during')
  expect(ids).not.toContain('SO-before')
  expect((await fetch(`${t.url}/app/history?since=1970-01-01T00:00:00Z`, { headers: auth() }).then(r => r.json()) as any[]).map(h => h.id)).not.toContain('SO-before')
  expect((await dash('chat?thread=app')).messages.map((m: any) => m.id)).not.toContain('SO-before')

  expect(await dash('money')).toEqual({ records: [], byCurrency: [], byMonth: [], byCategory: [], hidden: true })
  expect(await dash('people')).toEqual({ cards: [], hidden: true })
  for (const p of ['places', 'memory', 'memory/item?id=x', 'memory/search?q=x', 'loops', 'brief', 'trips', 'packages']) expect((await dash(p)).hidden).toBe(true)
  for (const p of ['/app/stamps', '/app/gate', '/app/brief']) expect((await (await fetch(`${t.url}${p}`, { headers: auth() })).json() as any).hidden).toBe(true)

  expect(await (await showoff({ on: false })).json()).toEqual({ on: false, since: null, until: null })
  expect((await say('back to normal', 'SO-after')).showoff).toBeUndefined()
  expect((await history()).map(h => h.id)).toEqual(expect.arrayContaining(['SO-before', 'SO-during', 'SO-after']))
  expect((await dash('people')).hidden).toBeUndefined()
  expect((await dash('chat?thread=app')).messages.map((m: any) => m.id)).toContain('SO-before')
}, 60000)

test('expiry restores everything with no call', async () => {
  const a = access()
  a.showoff = { since: new Date(Date.now() - 2 * 3600_000).toISOString(), until: new Date(Date.now() - 1000).toISOString() }
  writeFileSync(join(t.state, 'access.json'), JSON.stringify(a))
  expect(await (await showoff()).json()).toEqual({ on: false, since: null, until: null })
  const p = await phone(t)
  expect((await p.until(f => f.type === 'hello')).showoff).toBeUndefined()
  p.close()
  expect((await say('expired', 'SO-expired')).showoff).toBeUndefined()
  expect((await history()).map(h => h.id)).toContain('SO-before')
  expect((await dash('money')).hidden).toBeUndefined()
}, 60000)
