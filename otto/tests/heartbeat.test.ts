import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  evaluate, describeOutage, readHeartbeat, writeHeartbeat, STALE_MS, CHECK_MS,
  type DeadmanState, type Heartbeat,
} from '../heartbeat.ts'
import { runDeadman, quietAt } from '../deadman.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-deadman-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const NOW = Date.parse('2026-08-12T09:00:00Z')
const beatAt = (ms: number): Heartbeat => ({ v: 1, pid: 4242, at: ms })
const ctx = (over = {}) => ({ pidAlive: () => false, ...over })

test('a fresh beat is fine and says nothing', () => {
  const v = evaluate(beatAt(NOW - 10_000), {}, NOW, ctx())
  expect(v.action.kind).toBe('none')
})

test('no heartbeat file is a fresh install, not an outage', () => {
  expect(evaluate(null, {}, NOW, ctx()).action.kind).toBe('none')
})

test('a stale beat raises, and says whether the process is wedged or gone', () => {
  const hb = beatAt(NOW - STALE_MS - 1)
  const seen = evaluate(hb, { lastCheckAt: NOW - CHECK_MS }, NOW, ctx())
  const gone = evaluate(hb, seen.state, NOW + CHECK_MS, ctx())
  expect(gone.action).toMatchObject({ kind: 'raise', pidAlive: false })
  const wedged = evaluate(hb, seen.state, NOW + CHECK_MS, ctx({ pidAlive: () => true }))
  expect(describeOutage(wedged.action as never)).toContain('not doing anything')
  expect(describeOutage(gone.action as never)).toContain('process is gone')
})

// The whole point: a six-hour outage checked every five minutes is one alert.
test('once raised, the same outage never raises again', () => {
  const hb = beatAt(NOW - 3_600_000)
  let state: DeadmanState = { lastCheckAt: NOW - CHECK_MS }
  const seen = evaluate(hb, state, NOW, ctx())
  expect(seen.action.kind).toBe('none')
  const first = evaluate(hb, seen.state, NOW + CHECK_MS, ctx())
  expect(first.action.kind).toBe('raise')
  state = { ...first.state, outage: { ...first.state.outage!, raisedAt: NOW } }
  for (let i = 2; i <= 72; i++) {
    const v = evaluate(hb, state, NOW + i * CHECK_MS, ctx())
    expect(v.action.kind).toBe('none')
    state = v.state
  }
})

test('a new beat closes the outage; the next silence is a new outage', () => {
  const state: DeadmanState = { lastCheckAt: NOW - CHECK_MS, outage: { since: NOW - 3_600_000, raisedAt: NOW - 3_000_000 } }
  const back = evaluate(beatAt(NOW - 5_000), state, NOW, ctx())
  expect(back.action.kind).toBe('recover')
  expect(back.state.outage).toBeUndefined()

  const later = NOW + STALE_MS + 60_000
  const s1 = evaluate(beatAt(NOW - 5_000), { ...back.state, lastCheckAt: later - CHECK_MS }, later, ctx())
  const again = evaluate(beatAt(NOW - 5_000), s1.state, later + CHECK_MS, ctx())
  expect(again.action.kind).toBe('raise')
})

test('waking from sleep gives the server one run before it is judged', () => {
  const v = evaluate(beatAt(NOW - 8 * 3_600_000), { lastCheckAt: NOW - 8 * 3_600_000 }, NOW, ctx())
  expect(v.action).toMatchObject({ kind: 'none' })
  expect((v.action as { why: string }).why).toContain('asleep')
  // ...and if it is still silent on the next ordinary run, it is an outage.
  const next = evaluate(beatAt(NOW - 8 * 3_600_000), v.state, NOW + CHECK_MS, ctx())
  expect(next.action.kind).toBe('none') // first stale reading, confirming
  const third = evaluate(beatAt(NOW - 8 * 3_600_000), next.state, NOW + 2 * CHECK_MS, ctx())
  expect(third.action.kind).toBe('raise')
})

test('quiet hours hold the alert without losing it or repeating it', () => {
  const hb = beatAt(NOW - 3_600_000)
  const held = evaluate(hb, { lastCheckAt: NOW - CHECK_MS }, NOW, ctx({ held: true }))
  expect(held.action.kind).toBe('none')
  expect(held.state.outage).toMatchObject({ since: hb.at })
  const confirmed = evaluate(hb, held.state, NOW + CHECK_MS, ctx({ held: true }))
  const lifted = evaluate(hb, confirmed.state, NOW + 2 * CHECK_MS, ctx({ held: false }))
  expect(lifted.action.kind).toBe('raise')
})

test('quiet-hours spec handles a window that crosses midnight', () => {
  const at = (h: number) => new Date(2026, 7, 12, h, 0).getTime()
  expect(quietAt('23:30-08:00', at(2))).toBe(true)
  expect(quietAt('23:30-08:00', at(12))).toBe(false)
  expect(quietAt(undefined, at(2))).toBe(false)
})

// --- the checker, end to end over a real state dir -----------------------

function stateDir(): string {
  const dir = mkdtempSync(join(tmp, 's-'))
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ allowFrom: ['1234567890'] }))
  return dir
}

test('the checker alerts once across many runs, files one loop, and closes it on recovery', async () => {
  const dir = stateDir()
  writeHeartbeat(join(dir, 'heartbeat.json'), beatAt(NOW - 3_600_000))
  const sent: string[] = []
  const deps = (now: number) => ({
    stateDir: dir, now, pidAlive: () => false, quiet: () => false,
    notify: async (t: string) => { sent.push(t) },
  })

  expect((await runDeadman(deps(NOW))).did).toBe('none') // first stale reading
  const r = await runDeadman(deps(NOW + CHECK_MS))
  expect(r.did).toBe('raised')
  for (let i = 2; i < 20; i++) await runDeadman(deps(NOW + i * CHECK_MS))
  expect(sent).toHaveLength(1)

  const notes = JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf8'))
  expect(notes).toHaveLength(1)
  expect(notes[0]).toMatchObject({ kind: 'loop', status: 'open', source: 'deadman' })

  writeHeartbeat(join(dir, 'heartbeat.json'), beatAt(NOW + 20 * CHECK_MS))
  const back = await runDeadman(deps(NOW + 20 * CHECK_MS + 1000))
  expect(back.did).toBe('recovered')
  expect(JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf8'))[0].status).toBe('done')
  expect(sent).toHaveLength(1)
})

test('a failed send is retried next run without a second loop note', async () => {
  const dir = stateDir()
  writeHeartbeat(join(dir, 'heartbeat.json'), beatAt(NOW - 3_600_000))
  let up = false
  const sent: string[] = []
  const deps = (now: number) => ({
    stateDir: dir, now, pidAlive: () => false, quiet: () => false,
    notify: async (t: string) => { if (!up) throw new Error('offline'); sent.push(t) },
  })
  expect((await runDeadman(deps(NOW))).did).toBe('none')
  expect((await runDeadman(deps(NOW + CHECK_MS))).did).toBe('notify-failed')
  up = true
  expect((await runDeadman(deps(NOW + 2 * CHECK_MS))).did).toBe('raised')
  expect((await runDeadman(deps(NOW + 3 * CHECK_MS))).did).toBe('none')
  expect(sent).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf8'))).toHaveLength(1)
})

// A 5-15 minute sleep is under the sleep-gap threshold, so the checker can wake
// before the server has beaten once. That must not be an alert.
test('a short sleep does not alert when the server beats before the next run', async () => {
  const dir = stateDir()
  const f = join(dir, 'heartbeat.json')
  writeHeartbeat(f, beatAt(NOW - STALE_MS - 60_000))
  const sent: string[] = []
  const deps = (now: number) => ({
    stateDir: dir, now, pidAlive: () => true, quiet: () => false,
    notify: async (t: string) => { sent.push(t) },
  })
  expect((await runDeadman(deps(NOW))).did).toBe('none')
  writeHeartbeat(f, beatAt(NOW + 30_000)) // the server catches up
  expect((await runDeadman(deps(NOW + CHECK_MS))).did).toBe('none')
  expect(sent).toHaveLength(0)
  expect(JSON.parse(readFileSync(join(dir, 'deadman.json'), 'utf8')).outage).toBeUndefined()
})

test('heartbeat file round-trips and rejects junk', () => {
  const dir = stateDir()
  const f = join(dir, 'heartbeat.json')
  writeHeartbeat(f, beatAt(NOW))
  expect(readHeartbeat(f)?.at).toBe(NOW)
  writeFileSync(f, '{"nope":1}')
  expect(readHeartbeat(f)).toBeNull()
  writeFileSync(f, 'garbage')
  expect(readHeartbeat(f)).toBeNull()
})
