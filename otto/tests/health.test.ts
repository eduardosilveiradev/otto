import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseHealthPayload, ingestHealthPayload, ingestSamples, emptyStore, dayKey,
  ewma, baseline, assess, outliers, formatAssessment, formatBody,
  loadHealth, saveHealth, MIN_BASELINE_POINTS,
  type HealthStore, type Point,
} from '../health.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-health-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

function payload(metrics: unknown[], workouts: unknown[] = []) {
  return { data: { metrics, workouts } }
}

function days(n: number, from = '2026-07-01'): string[] {
  const start = Date.parse(`${from}T00:00:00Z`)
  return Array.from({ length: n }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10))
}

function series(values: number[], from = '2026-07-01'): Point[] {
  return days(values.length, from).map((date, i) => ({ date, value: values[i] }))
}

// The export stamp is already local to wherever the user was standing.
test('the day key comes from the local date in the stamp', () => {
  expect(dayKey('2026-08-11 23:40:00 -0300')).toBe('2026-08-11')
  expect(dayKey('2026-08-11T23:40:00-03:00')).toBe('2026-08-11')
  expect(dayKey('rubbish')).toBeUndefined()
})

test('the qty shape and the Min/Avg/Max shape both parse', () => {
  const { samples } = parseHealthPayload(payload([
    { name: 'resting_heart_rate', units: 'bpm', data: [{ date: '2026-08-11 08:00:00 -0300', qty: 54 }] },
    { name: 'heart_rate', units: 'bpm', data: [{ date: '2026-08-11 08:00:00 -0300', Min: 48, Avg: 68, Max: 142 }] },
  ]))
  expect(samples).toEqual([
    { metric: 'resting_heart_rate', date: '2026-08-11', value: 54, units: 'bpm' },
    { metric: 'heart_rate', date: '2026-08-11', value: 68, units: 'bpm' },
  ])
})

// Deep sleep collapsing while total sleep holds is the interesting case, and a
// single "sleep" number hides it.
test('sleep is expanded into a metric per stage, plus efficiency', () => {
  const { samples } = parseHealthPayload(payload([{
    name: 'sleep_analysis', units: 'hr',
    data: [{ date: '2026-08-11 06:30:00 -0300', asleep: 6.4, deep: 1.1, rem: 1.5, core: 3.8, awake: 0.4, inBed: 8 }],
  }]))
  const byMetric = Object.fromEntries(samples.map(s => [s.metric, s.value]))
  expect(byMetric.sleep_asleep).toBe(6.4)
  expect(byMetric.sleep_deep).toBe(1.1)
  expect(byMetric.sleep_rem).toBe(1.5)
  expect(byMetric.sleep_efficiency).toBe(80)
})

test('workouts parse and become a daily training-load metric', () => {
  const store = emptyStore()
  ingestHealthPayload(store, payload([], [
    { name: 'Running', start: '2026-08-11 07:00:00 -0300', duration: 42, totalEnergy: { qty: 410, units: 'kcal' }, distance: { qty: 7.2, units: 'km' } },
    { name: 'Strength', start: '2026-08-11 18:00:00 -0300', duration: 30 },
  ]))
  expect(store.workouts).toHaveLength(2)
  expect(store.workouts[0]).toMatchObject({ type: 'Running', minutes: 42, kcal: 410, km: 7.2 })
  expect(store.metrics.workout_minutes.points[0].value).toBe(72)
})

test('a duration exported in seconds is not read as twelve hours of running', () => {
  const { workouts } = parseHealthPayload(payload([], [
    { name: 'Cycling', start: '2026-08-11 07:00:00 -0300', duration: 2700 },
  ]))
  expect(workouts[0].minutes).toBe(45)
})

test('a garbage payload yields nothing rather than throwing', () => {
  expect(parseHealthPayload(null).samples).toEqual([])
  expect(parseHealthPayload({ data: { metrics: 'nope' } }).samples).toEqual([])
  expect(parseHealthPayload(payload([{ name: 'steps', data: [{ date: 'x', qty: 1 }] }])).samples).toEqual([])
})

// The exporter re-sends today's numbers on every push.
test('the same day pushed twice is one point, updated', () => {
  const store = emptyStore()
  const push = (qty: number) => ingestHealthPayload(store, payload([
    { name: 'step_count', units: 'count', data: [{ date: '2026-08-11 09:00:00 -0300', qty }] },
  ]))
  push(3000)
  const second = push(9000)
  expect(store.metrics.step_count.points).toHaveLength(1)
  expect(store.metrics.step_count.points[0].value).toBe(9000)
  expect(second.added).toBe(1)
  expect(push(9000).added).toBe(0)
})

// 90kg and 198lb are not the same series and must not share a baseline.
test('a units change resets the series instead of averaging across it', () => {
  const store = emptyStore()
  ingestSamples(store, series([90, 90.2, 89.8]).map(p => ({ metric: 'weight_body_mass', date: p.date, value: p.value, units: 'kg' })))
  ingestSamples(store, [{ metric: 'weight_body_mass', date: '2026-07-10', value: 198, units: 'lb' }])
  expect(store.metrics.weight_body_mass.units).toBe('lb')
  expect(store.metrics.weight_body_mass.points).toEqual([{ date: '2026-07-10', value: 198 }])
})

test('the EWMA tracks the recent level, not the whole history', () => {
  const flat = ewma(series([50, 50, 50, 50, 50, 50, 50, 50]))!
  expect(flat).toBeCloseTo(50, 6)
  const rising = ewma(series([50, 50, 50, 50, 60, 60, 60, 60]))!
  expect(rising).toBeGreaterThan(53)
  expect(rising).toBeLessThan(60)
  expect(ewma([])).toBeUndefined()
})

// A four-day hole is four days of decay, not one step.
test('a gap in the data decays the EWMA by real time', () => {
  const dense = ewma([{ date: '2026-07-01', value: 40 }, { date: '2026-07-02', value: 60 }], 7)!
  const sparse = ewma([{ date: '2026-07-01', value: 40 }, { date: '2026-07-30', value: 60 }], 7)!
  expect(sparse).toBeGreaterThan(dense)
})

test('a baseline needs enough history to mean anything', () => {
  expect(baseline(series([50, 51, 52]))).toBeUndefined()
  const band = baseline(series(Array.from({ length: MIN_BASELINE_POINTS }, () => 50)))!
  expect(band.n).toBe(MIN_BASELINE_POINTS)
  expect(band.median).toBe(50)
  // A metric that never moves still gets a band with width, not a zero one.
  expect(band.high).toBeGreaterThan(band.median)
})

// One night on a plane must not widen the band enough to hide the next week.
test('the band is robust to a single terrible night', () => {
  const steady = series([58, 60, 59, 61, 57, 60, 58, 59, 60, 58])
  const withShock = [...steady.slice(0, -1), { date: steady[steady.length - 1].date, value: 12 }]
  const a = baseline(steady)!
  const b = baseline(withShock)!
  expect(Math.abs(b.median - a.median)).toBeLessThan(2)
  expect(b.spread).toBeLessThan(a.spread * 4)
})

test('today is judged against history that excludes today', () => {
  const store = emptyStore()
  ingestSamples(store, [
    ...series([58, 60, 59, 61, 57, 60, 58, 59, 60]).map(p => ({ metric: 'heart_rate_variability', date: p.date, value: p.value, units: 'ms' })),
    { metric: 'heart_rate_variability', date: '2026-07-10', value: 30, units: 'ms' },
  ])
  const a = assess(store, 'heart_rate_variability')!
  expect(a.date).toBe('2026-07-10')
  expect(a.verdict).toBe('low')
  expect(a.baseline!.median).toBeCloseTo(59, 5)
  expect(a.z!).toBeLessThan(-2)
})

test('a normal day reads as normal', () => {
  const store = emptyStore()
  ingestSamples(store, series([58, 60, 59, 61, 57, 60, 58, 59, 60, 59])
    .map(p => ({ metric: 'heart_rate_variability', date: p.date, value: p.value, units: 'ms' })))
  expect(assess(store, 'heart_rate_variability')!.verdict).toBe('normal')
})

test('too little history says unknown rather than guessing', () => {
  const store = emptyStore()
  ingestSamples(store, series([58, 60, 12]).map(p => ({ metric: 'heart_rate_variability', date: p.date, value: p.value })))
  const a = assess(store, 'heart_rate_variability')!
  expect(a.verdict).toBe('unknown')
  expect(a.baseline).toBeUndefined()
  expect(formatAssessment(a)).toContain('no baseline yet')
})

test('an unseen metric has nothing to assess', () => {
  expect(assess(emptyStore(), 'vo2_max')).toBeUndefined()
})

// Low HRV and low resting heart rate are not the same news.
test('direction turns a deviation into news', () => {
  const store = emptyStore()
  ingestSamples(store, [
    ...series([58, 60, 59, 61, 57, 60, 58, 59, 60]).map(p => ({ metric: 'heart_rate_variability', date: p.date, value: p.value, units: 'ms' })),
    { metric: 'heart_rate_variability', date: '2026-07-10', value: 30, units: 'ms' },
    ...series([54, 55, 54, 56, 53, 55, 54, 55, 54]).map(p => ({ metric: 'resting_heart_rate', date: p.date, value: p.value, units: 'bpm' })),
    { metric: 'resting_heart_rate', date: '2026-07-10', value: 44, units: 'bpm' },
  ])
  expect(formatAssessment(assess(store, 'heart_rate_variability')!)).toContain('worse than usual')
  expect(formatAssessment(assess(store, 'resting_heart_rate')!)).toContain('better than usual')
})

test('outliers are ranked by how far out they are', () => {
  const store = emptyStore()
  ingestSamples(store, [
    ...series([58, 60, 59, 61, 57, 60, 58, 59, 60]).map(p => ({ metric: 'heart_rate_variability', date: p.date, value: p.value })),
    { metric: 'heart_rate_variability', date: '2026-07-10', value: 20 },
    ...series([54, 55, 54, 56, 53, 55, 54, 55, 54]).map(p => ({ metric: 'resting_heart_rate', date: p.date, value: p.value })),
    { metric: 'resting_heart_rate', date: '2026-07-10', value: 58 },
  ])
  const found = outliers(store, '2026-07-10')
  expect(found[0].metric).toBe('heart_rate_variability')
  expect(found.map(f => f.metric)).toContain('resting_heart_rate')
  expect(formatBody(store, '2026-07-10')).toContain('heart_rate_variability')
})

test('a quiet day says so rather than reaching for something to report', () => {
  const store = emptyStore()
  ingestSamples(store, series([58, 60, 59, 61, 57, 60, 58, 59, 60, 59])
    .map(p => ({ metric: 'heart_rate_variability', date: p.date, value: p.value })))
  expect(formatBody(store)).toContain('inside the user’s normal range')
})

test('the store round-trips and a missing file is an empty store', () => {
  const file = join(tmp, 'health.json')
  const store = emptyStore()
  ingestHealthPayload(store, payload([
    { name: 'step_count', units: 'count', data: [{ date: '2026-08-11 09:00:00 -0300', qty: 8000 }] },
  ]))
  saveHealth(file, store)
  const back: HealthStore = loadHealth(file)
  expect(back.metrics.step_count.points).toEqual([{ date: '2026-08-11', value: 8000 }])
  expect(loadHealth(join(tmp, 'nope.json')).metrics).toEqual({})
})
