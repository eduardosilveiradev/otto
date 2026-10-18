/**
 * Days-in-country limits: Schengen 90/180 and 183-day tax residence.
 *
 * Pure. The per-day list comes from trips.ts (countrySpans, the same entry-and-
 * exit-day-both counting daysInCountry uses). Whether any of this applies
 * depends on the user's citizenship, so nothing runs unless access.json says so.
 */

import { writeFileSync, readFileSync, renameSync } from 'fs'
import { countrySpans, type AirportTable, type Trip } from './trips.ts'

export type StayLimitsConfig = { schengen: boolean; taxCountries: string[] }
export type Day = { country: string; date: string }

/** Off unless the user turned it on. Tolerates a malformed access.json value. */
export function stayLimitsConfig(raw: unknown): StayLimitsConfig {
  const r = (raw ?? {}) as Partial<StayLimitsConfig>
  return {
    schengen: r.schengen === true,
    taxCountries: Array.isArray(r.taxCountries) ? r.taxCountries.filter(c => typeof c === 'string').map(c => c.toUpperCase()) : [],
  }
}
export const stayLimitsOn = (c: StayLimitsConfig) => c.schengen || c.taxCountries.length > 0

/** Schengen members by ISO 3166-1 alpha-2. Last checked 2026-10-13 (incl. Bulgaria and Romania, full members since 2025-01-01). */
export const SCHENGEN = new Set([
  'AT', 'BE', 'BG', 'HR', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IT', 'LV', 'LI',
  'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'CH',
])

const DAY_MS = 86_400_000
const add = (d: string, n: number) => new Date(Date.parse(d) + n * DAY_MS).toISOString().slice(0, 10)

/** Every day of every trip, per country, via trips.ts spans. A travel day appears under both countries. */
export function tripDays(trips: Trip[], airports: AirportTable): Day[] {
  const out: Day[] = []
  for (const t of trips) {
    for (const s of countrySpans(t, airports)) {
      for (let d = s.from; d <= s.to; d = add(d, 1)) out.push({ country: s.country, date: d })
    }
  }
  return out
}

export type SchengenUsage = { used: number; left: number; stayUntil: string | null; windowStart: string }

/** Days used in the 180 days ending `on` (inclusive), days left, and the last day they could stay until from `on`. */
export function schengenUsage(days: Day[], on: string): SchengenUsage {
  const dates = new Set(days.filter(d => SCHENGEN.has(d.country)).map(d => d.date))
  const count = (end: string) => {
    let n = 0
    for (let d = add(end, -179); d <= end; d = add(d, 1)) if (dates.has(d)) n++
    return n
  }
  const used = count(on)
  // Hypothetical: present from `on` onward. Walk forward until the window would pass 90.
  let until: string | null = null
  const sim = new Set(dates)
  for (let d = on, i = 0; i < 181; d = add(d, 1), i++) {
    sim.add(d)
    let n = 0
    for (let w = add(d, -179); w <= d; w = add(w, 1)) if (sim.has(w)) n++
    if (n > 90) break
    until = d
  }
  return { used, left: Math.max(0, 90 - used), stayUntil: until, windowStart: add(on, -179) }
}

/** Distinct days per country in a calendar year, with days left before 183. */
export function yearDays(days: Day[], year: number): { country: string; days: number; left: number }[] {
  const by = new Map<string, Set<string>>()
  for (const d of days) {
    if (!d.date.startsWith(`${year}-`)) continue
    by.set(d.country, (by.get(d.country) ?? new Set()).add(d.date))
  }
  return [...by].map(([country, s]) => ({ country, days: s.size, left: Math.max(0, 183 - s.size) }))
    .sort((a, b) => b.days - a.days)
}

export function formatLimits(days: Day[], cfg: StayLimitsConfig, today: string): string {
  const lines: string[] = []
  if (cfg.schengen) {
    const u = schengenUsage(days, today)
    lines.push(`Schengen: ${u.used}/90 used, ${u.left} left${u.stayUntil ? `, can stay until ${u.stayUntil}` : ', no stay possible now'}`)
  }
  const year = Number(today.slice(0, 4))
  for (const c of cfg.taxCountries) {
    const n = yearDays(days, year).find(y => y.country === c)?.days ?? 0
    lines.push(`${c} ${year}: ${n}/183, ${Math.max(0, 183 - n)} left`)
  }
  return lines.length ? `Limits\n${lines.join('\n')}` : ''
}

export const SCHENGEN_WARN_LEFT = 15
export const TAX_WARN_DAYS = 150

/**
 * Breaches not yet announced. `fired` is the set of keys already raised; a key
 * drops out once its breach clears (so it can fire again later), and tax keys
 * carry the year so each year starts fresh.
 */
export function stayAlerts(days: Day[], cfg: StayLimitsConfig, today: string, fired: string[]): { messages: string[]; fired: string[] } {
  const now = new Map<string, string>()
  if (cfg.schengen) {
    const u = schengenUsage(days, today)
    if (u.left < SCHENGEN_WARN_LEFT) now.set('schengen', `Schengen: ${u.left} days left of 90 (${u.used} used in the 180 days to ${today}).`)
  }
  const year = today.slice(0, 4)
  const yd = yearDays(days, Number(year))
  for (const c of cfg.taxCountries) {
    const n = yd.find(y => y.country === c)?.days ?? 0
    if (n > TAX_WARN_DAYS) now.set(`tax:${c}:${year}`, `${c}: ${n} days so far in ${year}, ${Math.max(0, 183 - n)} left before 183.`)
  }
  return {
    messages: [...now].filter(([k]) => !fired.includes(k)).map(([, m]) => m),
    fired: [...now.keys()],
  }
}

export function loadFired(file: string): string[] {
  try { const p = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(p) ? p : [] } catch { return [] }
}
export function saveFired(file: string, fired: string[]): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(fired) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
