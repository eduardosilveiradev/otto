import { test, expect } from 'bun:test'
import {
  project, assess, recordTold, parseUsageLines, humanDuration, formatProjection,
  type Window, type BurnState,
} from '../spend'

const HOUR = 3_600_000
const START = Date.parse('2026-08-10T00:00:00Z')
const W: Window = { startedAt: START, lengthMs: 7 * 24 * HOUR, limit: 1_000_000 }
const evenly = (perHour: number, hours: number) =>
  Array.from({ length: hours }, (_, i) => ({ at: START + i * HOUR, tokens: perHour }))

const fresh: BurnState = { windowStartedAt: 0, told: [] }

test('projection is flat when usage is flat', () => {
  // 24h in, using 1/7 of the limit: projects to exactly the limit.
  const now = START + 24 * HOUR
  const p = project(evenly(1_000_000 / 7 / 24, 24), W, now)
  expect(p.usedFraction).toBeCloseTo(1 / 7, 2)
  expect(p.projectedFraction).toBeCloseTo(1, 1)
})

test('usage outside the window is not counted', () => {
  const before = [{ at: START - 5 * HOUR, tokens: 500_000 }]
  const p = project([...before, ...evenly(1000, 24)], W, START + 24 * HOUR)
  expect(p.used).toBe(24_000)
})

test('a heavy burn projects an exhaustion time inside the window', () => {
  const now = START + 24 * HOUR
  const p = project(evenly(20_000, 24), W, now) // 480k in a day
  expect(p.projectedFraction).toBeGreaterThan(1)
  expect(p.exhaustedAt).toBeDefined()
  expect(p.exhaustedAt!).toBeGreaterThan(now)
  expect(p.exhaustedAt!).toBeLessThan(START + W.lengthMs)
})

test('a light burn projects no exhaustion at all', () => {
  const p = project(evenly(100, 24), W, START + 24 * HOUR)
  expect(p.exhaustedAt).toBeUndefined()
  expect(p.projectedFraction).toBeLessThan(1)
})

test('nothing is said while the projection lands inside the window', () => {
  const p = project(evenly(100, 24), W, START + 24 * HOUR)
  expect(assess(p, fresh, W, START + 24 * HOUR)).toMatchObject({ speak: false, reason: 'inside-budget' })
})

test('an early spike is ignored rather than extrapolated', () => {
  // Ten minutes in, burning hard. The rate is real but the projection is noise.
  const now = START + 10 * 60_000
  const p = project([{ at: START + 60_000, tokens: 50_000 }], W, now)
  expect(p.projectedFraction).toBeGreaterThan(1)
  expect(assess(p, fresh, W, now)).toMatchObject({ speak: false, reason: 'too-early' })
})

test('it speaks once when a threshold is first crossed', () => {
  const now = START + 24 * HOUR
  const p = project(evenly(20_000, 24), W, now)
  const first = assess(p, fresh, W, now)
  expect(first.speak).toBe(true)
  expect(first).toMatchObject({ threshold: 1.25 })
})

test('and does not repeat the same threshold in the same window', () => {
  const now = START + 24 * HOUR
  const p = project(evenly(20_000, 24), W, now)
  const v = assess(p, fresh, W, now)
  const state = recordTold(fresh, W, (v as { threshold: number }).threshold)
  expect(assess(p, state, W, now)).toMatchObject({ speak: false, reason: 'already-told' })
})

test('a new window resets what has been reported', () => {
  const told = { windowStartedAt: START - 7 * 24 * HOUR, told: [0.8, 1.0, 1.25] }
  const now = START + 24 * HOUR
  const p = project(evenly(20_000, 24), W, now)
  expect(assess(p, told, W, now).speak).toBe(true)
})

test('crossing a higher threshold later still speaks', () => {
  const now = START + 24 * HOUR
  // 5,000/h over a 168h window against a 1M limit projects to ~0.84.
  const light = project(evenly(5_000, 24), W, now)
  const v1 = assess(light, fresh, W, now)
  expect(v1).toMatchObject({ speak: true, threshold: 0.8 })
  const state = recordTold(fresh, W, 0.8)
  const heavy = project(evenly(20_000, 24), W, now)
  expect(assess(heavy, state, W, now)).toMatchObject({ speak: true, threshold: 1.25 })
})

test('the message is a share of the window, never a dollar figure', () => {
  const now = START + 24 * HOUR
  const text = formatProjection(project(evenly(20_000, 24), W, now), now)
  expect(text).toMatch(/%/)
  expect(text).not.toMatch(/\$/)
  expect(text).toContain('runs out in about')
})

test('usage lines parse, and junk is skipped rather than thrown', () => {
  const lines = [
    JSON.stringify({ timestamp: '2026-08-10T01:00:00Z', usage: { input_tokens: 10, output_tokens: 5 } }),
    'not json at all',
    JSON.stringify({ timestamp: 'nonsense', usage: { output_tokens: 5 } }),
    JSON.stringify({ timestamp: '2026-08-10T02:00:00Z', message: { usage: { output_tokens: 7 } } }),
    JSON.stringify({ timestamp: '2026-08-10T03:00:00Z' }),
    '',
  ]
  const events = parseUsageLines(lines)
  expect(events).toHaveLength(2)
  expect(events[0].tokens).toBe(15)
  expect(events[1].tokens).toBe(7)
})

test('durations read like a person wrote them', () => {
  expect(humanDuration(90_000)).toBe('2m')
  expect(humanDuration(5 * HOUR)).toBe('5h')
  expect(humanDuration(72 * HOUR)).toBe('3d')
})

// --- plan windows from the status line -------------------------------------
import { parsePlanUsage, liveWindows, projectPlan, assessPlan, planSummary, PLAN_WINDOWS, PLAN_FRESH_MS } from '../spend'

const NOW_P = Date.parse('2026-10-21T18:00:00Z')
const sec = (ms: number) => Math.round(ms / 1000)

test('a status line reading is validated and clamped', () => {
  expect(parsePlanUsage(null, NOW_P)).toBeNull()
  expect(parsePlanUsage({ five_hour: { used_percentage: 'x', resets_at: 1 } }, NOW_P)).toBeNull()
  const u = parsePlanUsage({ five_hour: { used_percentage: 140, resets_at: sec(NOW_P) + 3600 } }, NOW_P)!
  expect(u.five_hour!.used_percentage).toBe(100)
  expect(u.seven_day).toBeUndefined()
})

test('stale readings and windows past their reset say nothing', () => {
  const u = parsePlanUsage({
    five_hour: { used_percentage: 50, resets_at: sec(NOW_P) - 60 },
    seven_day: { used_percentage: 10, resets_at: sec(NOW_P) + 86400 },
  }, NOW_P)!
  expect(liveWindows(u, NOW_P)).toEqual(['seven_day'])
  expect(liveWindows(u, NOW_P + PLAN_FRESH_MS + 1)).toEqual([])
})

test('a percentage projects like the token log: half used at half time lands at 100%', () => {
  const len = PLAN_WINDOWS.five_hour.lengthMs
  const { p } = projectPlan({ used_percentage: 50, resets_at: sec(NOW_P + len / 2) }, len, NOW_P)
  expect(p.elapsedFraction).toBeCloseTo(0.5, 2)
  expect(p.projectedFraction).toBeCloseTo(1, 2)
})

test('the 5-hour window speaks only when it will run out, and only once', () => {
  const len = PLAN_WINDOWS.five_hour.lengthMs
  // 45% used at half time: projects 90%, the weekly rules would warn, the 5-hour ones don't.
  const calm = parsePlanUsage({ five_hour: { used_percentage: 45, resets_at: sec(NOW_P + len / 2) } }, NOW_P)
  expect(assessPlan(calm, {}, NOW_P).text).toBeUndefined()
  // 80% at half time: runs out early.
  const hot = parsePlanUsage({ five_hour: { used_percentage: 80, resets_at: sec(NOW_P + len / 2) } }, NOW_P)
  const first = assessPlan(hot, {}, NOW_P)
  expect(first.text).toContain('5-hour limit')
  expect(assessPlan(hot, first.state, NOW_P).text).toBeUndefined()
})

test('the weekly window warns at the usual thresholds', () => {
  const len = PLAN_WINDOWS.seven_day.lengthMs
  const u = parsePlanUsage({ seven_day: { used_percentage: 45, resets_at: sec(NOW_P + len / 2) } }, NOW_P)
  expect(assessPlan(u, {}, NOW_P).text).toContain('weekly limit')
})

test('the summary names both windows', () => {
  const u = parsePlanUsage({
    five_hour: { used_percentage: 31, resets_at: sec(NOW_P + 2 * 3600_000) },
    seven_day: { used_percentage: 8, resets_at: sec(NOW_P + 6 * 86400_000) },
  }, NOW_P)
  expect(planSummary(u, NOW_P)).toBe('5-hour 31% (resets in 2h) · weekly 8% (resets in 6d)')
  expect(planSummary(null, NOW_P)).toBeUndefined()
})
