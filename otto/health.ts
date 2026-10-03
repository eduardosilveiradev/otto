/**
 * The user’s body, as a series rather than a number.
 *
 * Health Auto Export can already POST everything Apple Health holds — sleep
 * stages, HRV, resting heart rate, weight, steps, workouts — at the loopback
 * webhook Otto is already listening on. Garmin data arrives the same way,
 * because the watch writes into Apple Health and Apple Health is what exports;
 * this accepts the Health export shape and knows nothing about Garmin's.
 *
 * The reason to store any of it is that a single reading means nothing. "HRV
 * 42ms" is not a fact anyone can act on. "HRV 42 against a normal of 58, third
 * day running" is, and the difference between the two is entirely in what came
 * before. So every metric carries a rolling series, an EWMA that tracks where
 * it is drifting, and a baseline band computed from the user’s own history.
 *
 * Three decisions worth stating:
 *
 *   The band is median and MAD, not mean and standard deviation. One terrible
 *   night — a flight, a fever, a watch that fell off — moves a mean enough to
 *   swallow the next week of real signal. The median does not notice it.
 *
 *   The EWMA is time-weighted, not per-sample. Health data has holes in it: a
 *   forgotten watch, a dead battery, four days in a country where the user did not
 *   wear it. Treating "the previous reading" as "yesterday" makes a gap look
 *   like continuity.
 *
 *   Nothing here interprets anything medically. It answers "is today outside
 *   the user’s own normal", per metric, with a direction so a caller can phrase it —
 *   low HRV and low resting heart rate are not the same news.
 *
 * The whole file is pure except the two store functions at the bottom.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type Point = { date: string; value: number }

export type MetricSeries = {
  metric: string
  units?: string
  /** Oldest first, one per day, capped. */
  points: Point[]
}

export type Workout = {
  date: string
  type: string
  minutes?: number
  kcal?: number
  km?: number
  start?: string
}

export type HealthStore = {
  metrics: Record<string, MetricSeries>
  workouts: Workout[]
  updatedAt: string
}

/** Half a year is plenty to establish a normal and short enough that last
 * winter's normal does not outvote this month's. */
const MAX_POINTS = 180
const MAX_WORKOUTS = 200

export function emptyStore(): HealthStore {
  return { metrics: {}, workouts: [], updatedAt: new Date().toISOString() }
}

/**
 * Which way is bad.
 *
 * Not a medical opinion — just the direction each metric moves when something
 * is off, so a caller can say "HRV is down" rather than "HRV is outside the
 * band", which nobody can act on.
 */
export const METRIC_DIRECTION: Record<string, 'higher-better' | 'lower-better' | 'neutral'> = {
  heart_rate_variability: 'higher-better',
  resting_heart_rate: 'lower-better',
  respiratory_rate: 'neutral',
  sleep_asleep: 'higher-better',
  sleep_deep: 'higher-better',
  sleep_rem: 'higher-better',
  sleep_efficiency: 'higher-better',
  step_count: 'higher-better',
  active_energy: 'higher-better',
  weight_body_mass: 'neutral',
  body_fat_percentage: 'neutral',
  vo2_max: 'higher-better',
  workout_minutes: 'higher-better',
}

// ---------------------------------------------------------------------------
// Parsing the export payload
// ---------------------------------------------------------------------------

export type Sample = { metric: string; date: string; value: number; units?: string }

/**
 * "2026-08-11 08:00:00 -0300" -> "2026-08-11".
 *
 * The date part of a Health export stamp is already local to where the user was, and
 * local is the only frame in which "last night's sleep" or "today's steps"
 * means anything. Reprojecting it into UTC would move every late-evening
 * workout onto the following day.
 */
export function dayKey(stamp: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(stamp.trim())
  if (m) return m[0]
  const t = Date.parse(stamp)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10)
}

function numeric(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

type RawPoint = Record<string, unknown>

/**
 * Turn one Health Auto Export payload into flat samples.
 *
 * Sleep is expanded rather than stored as one blob: the stages are separate
 * metrics with separate baselines, because deep sleep collapsing while total
 * sleep holds steady is the interesting case and a single "sleep" number hides
 * it. Efficiency is derived here for the same reason — asleep over in-bed is
 * the number that moves when something is wrong.
 */
export function parseHealthPayload(payload: unknown): { samples: Sample[]; workouts: Workout[] } {
  const samples: Sample[] = []
  const workouts: Workout[] = []
  const root = (payload as { data?: unknown })?.data ?? payload
  const metrics = (root as { metrics?: unknown })?.metrics
  const rawWorkouts = (root as { workouts?: unknown })?.workouts

  if (Array.isArray(metrics)) {
    for (const m of metrics as { name?: string; units?: string; data?: RawPoint[] }[]) {
      const name = typeof m?.name === 'string' ? m.name.trim().toLowerCase() : ''
      if (!name || !Array.isArray(m.data)) continue
      for (const p of m.data) {
        const date = dayKey(String(p?.date ?? ''))
        if (!date) continue

        if (name === 'sleep_analysis') {
          const asleep = numeric(p.asleep) ?? numeric(p.totalSleep)
          const inBed = numeric(p.inBed)
          const push = (metric: string, value?: number) => {
            if (value !== undefined) samples.push({ metric, date, value, units: m.units ?? 'hr' })
          }
          push('sleep_asleep', asleep)
          push('sleep_deep', numeric(p.deep))
          push('sleep_rem', numeric(p.rem))
          push('sleep_core', numeric(p.core))
          push('sleep_awake', numeric(p.awake))
          push('sleep_in_bed', inBed)
          if (asleep !== undefined && inBed !== undefined && inBed > 0) {
            samples.push({ metric: 'sleep_efficiency', date, value: (asleep / inBed) * 100, units: '%' })
          }
          continue
        }

        // qty is the single-value shape; Avg/Min/Max is the aggregated one, and
        // the average is the only one of the three with a meaningful baseline.
        const value = numeric(p.qty) ?? numeric(p.Avg) ?? numeric(p.avg)
        if (value === undefined) continue
        samples.push({ metric: name, date, value, ...(m.units ? { units: m.units } : {}) })
      }
    }
  }

  if (Array.isArray(rawWorkouts)) {
    for (const w of rawWorkouts as Record<string, unknown>[]) {
      const start = String(w?.start ?? w?.startDate ?? '')
      const date = dayKey(start)
      if (!date) continue
      const energy = (w.totalEnergy ?? w.activeEnergyBurned) as { qty?: unknown } | undefined
      const distance = w.distance as { qty?: unknown } | undefined
      const duration = numeric(w.duration)
      workouts.push({
        date,
        type: String(w.name ?? w.workoutActivityType ?? 'workout'),
        // Health exports duration in minutes; anything over a couple of hours
        // in that field is seconds from an older exporter version.
        ...(duration !== undefined ? { minutes: duration > 600 ? Math.round(duration / 60) : Math.round(duration) } : {}),
        ...(numeric(energy?.qty) !== undefined ? { kcal: Math.round(numeric(energy?.qty)!) } : {}),
        ...(numeric(distance?.qty) !== undefined ? { km: numeric(distance?.qty)! } : {}),
        ...(start ? { start } : {}),
      })
    }
  }

  return { samples, workouts }
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Fold samples into the store, last write wins per day.
 *
 * The exporter re-sends today's numbers on every push — steps at 09:00 and
 * again at 18:00 are the same day's metric, not two — so a same-day sample
 * replaces rather than appends. Historical days re-sent unchanged are a no-op.
 */
export function ingestSamples(store: HealthStore, samples: Sample[]): { store: HealthStore; added: number } {
  let added = 0
  for (const s of samples) {
    if (!Number.isFinite(s.value)) continue
    const series = store.metrics[s.metric] ?? { metric: s.metric, points: [] }
    if (s.units && !series.units) series.units = s.units
    // A metric whose units changed (kg to lb) is not the same series any more,
    // and averaging across the switch would produce a body weight of 90 that
    // means nothing. Keep the newest units and drop the incompatible history.
    if (s.units && series.units && s.units !== series.units) {
      series.units = s.units
      series.points = []
    }
    const i = series.points.findIndex(p => p.date === s.date)
    if (i >= 0) {
      if (series.points[i].value !== s.value) { series.points[i] = { date: s.date, value: s.value }; added++ }
    } else {
      series.points.push({ date: s.date, value: s.value })
      added++
    }
    series.points.sort((a, b) => a.date.localeCompare(b.date))
    if (series.points.length > MAX_POINTS) series.points.splice(0, series.points.length - MAX_POINTS)
    store.metrics[s.metric] = series
  }
  store.updatedAt = new Date().toISOString()
  return { store, added }
}

export function ingestWorkouts(store: HealthStore, workouts: Workout[]): { store: HealthStore; added: number } {
  let added = 0
  for (const w of workouts) {
    const exists = store.workouts.some(x => x.date === w.date && x.type === w.type && x.start === w.start)
    if (exists) continue
    store.workouts.push(w)
    added++
  }
  store.workouts.sort((a, b) => a.date.localeCompare(b.date))
  if (store.workouts.length > MAX_WORKOUTS) store.workouts.splice(0, store.workouts.length - MAX_WORKOUTS)

  // Daily training load, so it gets a baseline like everything else.
  const byDay = new Map<string, number>()
  for (const w of store.workouts) {
    if (w.minutes === undefined) continue
    byDay.set(w.date, (byDay.get(w.date) ?? 0) + w.minutes)
  }
  ingestSamples(store, [...byDay].map(([date, value]) => ({ metric: 'workout_minutes', date, value, units: 'min' })))
  return { store, added }
}

export function ingestHealthPayload(store: HealthStore, payload: unknown): { store: HealthStore; added: number; metrics: string[] } {
  const { samples, workouts } = parseHealthPayload(payload)
  const a = ingestSamples(store, samples).added
  const b = ingestWorkouts(store, workouts).added
  return { store, added: a + b, metrics: [...new Set(samples.map(s => s.metric))] }
}

// ---------------------------------------------------------------------------
// Normal, and what is outside it
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

/**
 * Time-weighted EWMA.
 *
 * The weight of a previous value decays by half every `halfLifeDays` of real
 * time, so a four-day gap in the data is four days of decay and not one step.
 */
export function ewma(points: Point[], halfLifeDays = 7): number | undefined {
  if (!points.length) return undefined
  let acc = points[0].value
  let prev = Date.parse(points[0].date)
  for (let i = 1; i < points.length; i++) {
    const at = Date.parse(points[i].date)
    const dt = Math.max(0, (at - prev) / DAY_MS)
    const alpha = 1 - Math.pow(0.5, dt / halfLifeDays)
    acc = acc + alpha * (points[i].value - acc)
    prev = at
  }
  return acc
}

export type Baseline = {
  n: number
  median: number
  /** Median absolute deviation, scaled to be comparable to a standard deviation. */
  spread: number
  low: number
  high: number
}

/** Minimum history before a band means anything. Below this, say "unknown". */
export const MIN_BASELINE_POINTS = 7

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * The user’s own normal for one metric.
 *
 * Median and MAD rather than mean and standard deviation: one night on a plane
 * should not widen the band enough to hide the next week. `exclude` keeps the
 * day being judged out of the history it is judged against, which otherwise
 * drags the band towards whatever today happens to be.
 */
export function baseline(points: Point[], o: { windowDays?: number; exclude?: string; k?: number; asOf?: string } = {}): Baseline | undefined {
  const windowDays = o.windowDays ?? 60
  const k = o.k ?? 2
  const asOf = Date.parse(o.asOf ?? points[points.length - 1]?.date ?? '')
  const from = Number.isNaN(asOf) ? -Infinity : asOf - windowDays * DAY_MS

  const values = points
    .filter(p => p.date !== o.exclude)
    .filter(p => { const t = Date.parse(p.date); return Number.isNaN(t) || t >= from })
    .map(p => p.value)
  if (values.length < MIN_BASELINE_POINTS) return undefined

  const med = median(values)
  const mad = median(values.map(v => Math.abs(v - med)))
  // 1.4826 makes MAD comparable to a standard deviation for normal-ish data.
  // A metric that never varies gets a floor so the band is not zero-width.
  const spread = Math.max(mad * 1.4826, Math.abs(med) * 0.01, 1e-9)
  return { n: values.length, median: med, spread, low: med - k * spread, high: med + k * spread }
}

export type Assessment = {
  metric: string
  date: string
  value: number
  verdict: 'low' | 'normal' | 'high' | 'unknown'
  /** How many spreads from the user’s median. Signed. */
  z?: number
  baseline?: Baseline
  ewma?: number
  units?: string
  direction: 'higher-better' | 'lower-better' | 'neutral'
}

/** Is this day outside the user’s own normal for this metric? */
export function assess(store: HealthStore, metric: string, date?: string, o: { windowDays?: number; k?: number } = {}): Assessment | undefined {
  const series = store.metrics[metric]
  if (!series?.points.length) return undefined
  const point = date ? series.points.find(p => p.date === date) : series.points[series.points.length - 1]
  if (!point) return undefined

  const band = baseline(series.points, { ...o, exclude: point.date, asOf: point.date })
  const direction = METRIC_DIRECTION[metric] ?? 'neutral'
  const common = {
    metric, date: point.date, value: point.value, direction,
    ...(series.units ? { units: series.units } : {}),
    ...(ewma(series.points) !== undefined ? { ewma: ewma(series.points)! } : {}),
  }
  if (!band) return { ...common, verdict: 'unknown' }

  const z = (point.value - band.median) / band.spread
  const verdict = point.value < band.low ? 'low' : point.value > band.high ? 'high' : 'normal'
  return { ...common, verdict, z, baseline: band }
}

/** Everything outside its band on a given day, furthest out first. */
export function outliers(store: HealthStore, date?: string, o: { windowDays?: number; k?: number } = {}): Assessment[] {
  return Object.keys(store.metrics)
    .map(m => assess(store, m, date, o))
    .filter((a): a is Assessment => Boolean(a) && a!.verdict !== 'normal' && a!.verdict !== 'unknown')
    .sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0))
}

export function formatAssessment(a: Assessment): string {
  const value = Math.abs(a.value) >= 100 ? Math.round(a.value) : Math.round(a.value * 10) / 10
  const units = a.units ? ` ${a.units}` : ''
  if (a.verdict === 'unknown') return `${a.metric}: ${value}${units} (no baseline yet)`
  const normal = Math.round(a.baseline!.median * 10) / 10
  if (a.verdict === 'normal') return `${a.metric}: ${value}${units} (normal, usually ${normal})`
  const worse =
    a.direction === 'neutral' ? '' :
      (a.verdict === 'low') === (a.direction === 'higher-better') ? ' — worse than usual' : ' — better than usual'
  return `${a.metric}: ${value}${units} ${a.verdict} vs the user’s usual ${normal}${worse}`
}

export function formatBody(store: HealthStore, date?: string): string {
  const found = outliers(store, date)
  if (!found.length) return 'body metrics all inside the user’s normal range'
  return found.slice(0, 4).map(formatAssessment).join('; ')
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function loadHealth(file: string): HealthStore {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as HealthStore
    if (!parsed || typeof parsed !== 'object' || !parsed.metrics) return emptyStore()
    return { metrics: parsed.metrics, workouts: parsed.workouts ?? [], updatedAt: parsed.updatedAt ?? '' }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: health.json corrupt, moved aside.\n')
    }
    return emptyStore()
  }
}

export function saveHealth(file: string, store: HealthStore): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export const HEALTH_FILE = join(
  process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'),
  'health.json',
)
