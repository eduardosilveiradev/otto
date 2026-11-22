/** How an approval ended reaches every open app, and one that was away can read it back. */
import { test, expect, afterAll } from 'bun:test'
import { createAppToken } from '../apptokens.ts'
import { startTwin, phone, selfEditOn, type Twin } from './apptwin.ts'

const twins: Twin[] = []
afterAll(async () => { for (const t of twins) await t.stop().catch(() => {}) })
const ask = (t: Twin, title: string) => t.call('ask_approval', { title, summary: 'A change to the server.', paths: ['otto/server.ts'] })
const history = (t: Twin, q = '', auth = `Bearer ${t.token}`) => fetch(`${t.url}/app/approvals/history${q}`, { headers: { authorization: auth } })

test('approval_done says approved, declined or expired, and the history read lists them newest first', async () => {
  const t = await startTwin(undefined, { OTTO_APPROVAL_TTL_MS: '1500' }); twins.push(t)
  selfEditOn(t)
  const p = await phone(t)
  const other = await phone(t)

  await ask(t, 'First change')
  const a = await p.until(f => f.type === 'approval')
  p.send({ type: 'approval', id: a.id, op: 'op-a', decision: 'approve' })
  // The device that didn't answer is told how it ended.
  expect(await other.until(f => f.type === 'approval_done' && f.id === a.id)).toMatchObject({ outcome: 'approved' })

  // The other device answers the same one a moment later: told how it really ended, not that it expired.
  const seen = other.got.length
  other.send({ type: 'approval', id: a.id, op: 'op-a-late', decision: 'decline' })
  expect(await other.until(f => f.type === 'ack' && f.id === 'op-a-late')).toMatchObject({ gone: true })
  expect(other.got.slice(seen).filter(f => f.type === 'approval_done' && f.id === a.id).map(f => f.outcome)).toEqual(['approved'])
  expect(other.got.slice(seen).some(f => f.type === 'message' && /expired/.test(f.text))).toBe(false)

  await ask(t, 'Second change')
  const b = await p.until(f => f.type === 'approval' && f.id !== a.id)
  p.send({ type: 'approval', id: b.id, op: 'op-b', decision: 'decline' })
  expect(await other.until(f => f.type === 'approval_done' && f.id === b.id)).toMatchObject({ outcome: 'declined' })

  await ask(t, 'Third change')
  const c = await p.until(f => f.type === 'approval' && ![a.id, b.id].includes(f.id))
  await Bun.sleep(1700)
  const late = await phone(t)   // a connect lists the live approvals, which sweeps the lapsed one
  expect(await p.until(f => f.type === 'approval_done' && f.id === c.id)).toMatchObject({ outcome: 'expired' })
  expect(late.got.some(f => f.type === 'approval' && f.id === c.id)).toBe(false)
  // An answer that arrives after it lapsed is told so too.
  p.send({ type: 'approval', id: c.id, op: 'op-c', decision: 'approve' })
  expect(await p.until(f => f.type === 'ack' && f.id === 'op-c')).toMatchObject({ gone: true })

  const rows = await (await history(t)).json() as any[]
  expect(rows.map(r => [r.title, r.outcome])).toEqual([['Third change', 'expired'], ['Second change', 'declined'], ['First change', 'approved']])
  expect(Object.keys(rows[0]).sort()).toEqual(['at', 'id', 'outcome', 'title'])
  expect(Number.isNaN(Date.parse(rows[0].at))).toBe(false)
  expect(await (await history(t, '?limit=1')).json()).toHaveLength(1)

  // It outlives a restart.
  const again = await t.restart(); twins.push(again)
  expect(await (await history(again)).json()).toHaveLength(3)
}, 90000)

test('the history read needs a native device token', async () => {
  const t = twins.at(-1)!
  expect((await fetch(`${t.url}/app/approvals/history`)).status).toBe(401)
  expect((await history(t, '', 'Bearer wrong')).status).toBe(401)
  // A dashboard token lives in a browser: it never reaches the native routes.
  const env = process.env.OTTO_STATE_DIR
  process.env.OTTO_STATE_DIR = t.state
  try {
    const dash = createAppToken('dashboard', { scope: 'write', origin: 'https://app.example.com' })
    expect((await history(t, '', `Bearer ${dash.token}`)).status).toBe(401)
  } finally { if (env === undefined) delete process.env.OTTO_STATE_DIR; else process.env.OTTO_STATE_DIR = env }
}, 30000)
