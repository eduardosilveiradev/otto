import { test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { catchUp, loadWaits, recordWait, WAIT_MS, type MacWait } from '../macwait.ts'

const NOW = Date.parse('2026-11-17T10:00:00Z')
const FIRED = '2026-11-17T09:40:00.000Z'
const file = () => join(mkdtempSync(join(tmpdir(), 'macwait-')), 'mac-wait.json')
const oneShot = { id: 'a1', action: 'Rebuild the desktop app', lastFired: FIRED, repeating: false }
const daily = { id: 'p2', action: 'Pick tonight\'s playlist', lastFired: FIRED, repeating: true, nextRun: NOW + 86_400_000 }

function harness(triggers: any[]) {
  const f = file(), fired: MacWait[] = []
  let up = false
  const check = (now = NOW) => catchUp(f, () => triggers, now, async () => up, w => (fired.push(w), true))
  return { f, fired, check, setUp: (v: boolean) => { up = v } }
}

test('records a Mac-unreachable run once, with its fire time and action', () => {
  const h = harness([oneShot])
  expect(recordWait(h.f, oneShot, NOW)).toBeUndefined()
  expect(loadWaits(h.f)).toEqual([{ id: 'a1', firedAt: FIRED, action: 'Rebuild the desktop app' }])
  expect(recordWait(h.f, oneShot, NOW)).toMatch(/already/)
  expect(recordWait(h.f, { ...oneShot, lastFired: undefined }, NOW)).toMatch(/never/)
})

test('re-fires once when the Mac answers, never twice', async () => {
  const h = harness([oneShot])
  recordWait(h.f, oneShot, NOW)
  expect(await h.check()).toBe(0)          // still unreachable
  h.setUp(true)
  expect(await h.check(NOW + 120_000)).toBe(1)
  expect(h.fired.map(w => w.id)).toEqual(['a1'])
  expect(await h.check(NOW + 240_000)).toBe(0)
  // The catch-up couldn't reach it either: the same run is not queued again.
  expect(recordWait(h.f, oneShot, NOW + 300_000)).toMatch(/already/)
  expect(await h.check(NOW + 360_000)).toBe(0)
  expect(h.fired.length).toBe(1)
})

test('drops an entry older than 24h', async () => {
  const h = harness([oneShot])
  recordWait(h.f, oneShot, NOW)
  h.setUp(true)
  expect(await h.check(Date.parse(FIRED) + WAIT_MS + 1)).toBe(0)
  expect(loadWaits(h.f)).toEqual([])
  expect(recordWait(h.f, oneShot, Date.parse(FIRED) + WAIT_MS + 1)).toMatch(/24h/)
})

test('drops a repeating trigger once its next regular run happened or is due', async () => {
  const t = { ...daily }
  const h = harness([t])
  recordWait(h.f, t, NOW)
  t.nextRun = NOW                          // due this tick: the cron loop runs it
  h.setUp(true)
  expect(await h.check()).toBe(0)
  expect(loadWaits(h.f)).toEqual([])
  const u = { ...daily }, g = harness([u])
  recordWait(g.f, u, NOW)
  u.lastFired = '2026-11-17T10:30:00.000Z' // the next run already went (hourly, say)
  g.setUp(true)
  expect(await g.check(NOW + 3_600_000)).toBe(0)
  expect(g.fired).toEqual([])
})
