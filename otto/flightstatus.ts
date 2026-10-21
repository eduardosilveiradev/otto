/**
 * Live flight status — the provider behind `FlightStatusProvider` in triplife.ts.
 *
 * AeroDataBox through RapidAPI's Basic plan: 400 units a month free, 1 request
 * a second, non-commercial. A flight-by-number lookup is a Tier 2 endpoint at 2
 * units a call, so the plan is about 200 status calls a month. Everything here
 * is shaped by that budget:
 *
 *   window   a flight is polled from 6 h before departure until 30 min after
 *            landing, hourly until 2 h out, then every 15 min around departure
 *            and 45 min once airborne
 *   budget   `flights.monthlyCalls` (default 150) a month across all flights,
 *            and at most 30 calls for any one flight; a failed call is charged
 *            like a good one
 *   dedupe   what was already said is kept as `told` keys in flights.json, so
 *            a restart repeats nothing and a re-estimate within the tolerance
 *            says nothing new
 *
 * Without AERODATABOX_KEY in ~/.otto/state/.env there is no provider: the
 * stub stays wired and nothing is polled, logged or sent. Fetch is injected so
 * the tests run offline.
 */

import { homedir } from 'os'
import { join } from 'path'
import type { FlightSegment } from './trips.ts'
import { type FlightStatus, type FlightStatusProvider, segmentKey, departureAt, arrivalAt, wallClock } from './triplife.ts'
import { loadState, saveState } from './statefile.ts'

export const FLIGHTS_FILE = join(process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'), 'flights.json')

const MIN = 60_000
const HOUR = 60 * MIN

export const WATCH_FROM_MS = 6 * HOUR
export const PER_FLIGHT_CALLS = 30
export const DEFAULT_MONTHLY_CALLS = 150
export const DEFAULT_DELAY_MINUTES = 15

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** `status` is absent until a call has answered; a miss still sets polledAt and counts. */
export type FlightWatch = { status?: FlightStatus; polledAt: string; calls: number; told: string[] }
export type FlightsState = {
  /** UTC YYYY-MM the call count belongs to. */
  month: string
  calls: number
  flights: Record<string, FlightWatch>
}

export const loadFlightsState = (file: string): FlightsState =>
  loadState(file, () => ({ month: '', calls: 0, flights: {} }), v => !!(v as any)?.flights && typeof (v as any).flights === 'object' && !Array.isArray((v as any).flights))

export const saveFlightsState = (file: string, s: FlightsState): void => saveState(file, s)

/** A new UTC month starts the plan's counter over. */
export function rollMonth(state: FlightsState, now: number): void {
  const month = new Date(now).toISOString().slice(0, 7)
  if (state.month !== month) { state.month = month; state.calls = 0 }
}

/** Forget flights no trip has any more. Returns whether anything went. */
export function pruneFlights(state: FlightsState, liveKeys: string[]): boolean {
  let changed = false
  for (const k of Object.keys(state.flights)) if (!liveKeys.includes(k)) { delete state.flights[k]; changed = true }
  return changed
}

export function flightsConfig(access?: { flights?: { delayMinutes?: unknown; monthlyCalls?: unknown } }): { delayMinutes: number; monthlyCalls: number } {
  const pos = (v: unknown, d: number) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d
  return {
    delayMinutes: pos(access?.flights?.delayMinutes, DEFAULT_DELAY_MINUTES),
    monthlyCalls: pos(access?.flights?.monthlyCalls, DEFAULT_MONTHLY_CALLS),
  }
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export const AERODATABOX_HOST = 'aerodatabox.p.rapidapi.com'

export function aeroDataBox(key: string | undefined, doFetch: typeof fetch = fetch): FlightStatusProvider | undefined {
  if (!key) return undefined
  return {
    async status(seg) {
      const url = `https://${AERODATABOX_HOST}/flights/Number/${encodeURIComponent(seg.flight)}/${seg.depart.local.slice(0, 10)}?dateLocalRole=Departure&withLocation=false`
      const res = await doFetch(url, {
        headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': AERODATABOX_HOST, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      })
      if (res.status === 204 || res.status === 404) return undefined
      if (!res.ok) throw new Error(`aerodatabox ${res.status}`)
      return fromAeroDataBox(await res.json(), seg)
    },
  }
}

type Leg = {
  status?: string
  lastUpdatedUtc?: string
  departure?: Side
  arrival?: Side
}
type Side = {
  airport?: { iata?: string }
  revisedTime?: { utc?: string }
  runwayTime?: { utc?: string }
  quality?: string[]
  gate?: string
  terminal?: string
}

/** "2026-10-02 17:35Z" or ISO to ISO-ish; anything Date cannot read is dropped. */
const utc = (t: unknown): string | undefined => {
  if (typeof t !== 'string') return undefined
  const s = t.replace(' ', 'T')
  return Number.isNaN(Date.parse(s)) ? undefined : s
}

const STATES: Record<string, FlightStatus['state']> = {
  Canceled: 'cancelled', CanceledUncertain: 'cancelled', Diverted: 'diverted', Arrived: 'landed',
  Departed: 'departed', EnRoute: 'departed', Approaching: 'departed', Boarding: 'boarding', GateClosed: 'boarding',
}

/** One AeroDataBox answer (an array of legs sharing the number) to the leg this segment is. */
export function fromAeroDataBox(items: unknown, seg: FlightSegment, asOf = new Date().toISOString()): FlightStatus | undefined {
  if (!Array.isArray(items)) return undefined
  const legs = (items as Leg[]).filter(i =>
    (!seg.from || i?.departure?.airport?.iata === seg.from)
    && (!seg.to || i?.arrival?.airport?.iata === seg.to || i?.status === 'Diverted'))
  const leg = legs.find(i => i.departure?.quality?.includes('Live')) ?? legs[0]
  if (!leg) return undefined
  const state = STATES[leg.status ?? ''] ?? 'scheduled'
  const dep = leg.departure, arr = leg.arrival
  const landedAt = arr?.airport?.iata
  return {
    state,
    estimatedDepartUtc: utc(dep?.revisedTime?.utc) ?? utc(dep?.runwayTime?.utc),
    estimatedArriveUtc: utc(arr?.revisedTime?.utc) ?? utc(arr?.runwayTime?.utc),
    gate: dep?.gate, terminal: dep?.terminal,
    ...(state === 'diverted' && landedAt && landedAt !== seg.to ? { divertedTo: landedAt } : {}),
    asOf: utc(leg.lastUpdatedUtc) ?? asOf,
  }
}

// ---------------------------------------------------------------------------
// When to ask
// ---------------------------------------------------------------------------

export function pollDue(
  seg: FlightSegment, watch: FlightWatch | undefined, now: number,
  o: { monthlyCalls: number; monthCalls: number; perFlightCalls?: number },
): boolean {
  const statuses = watch?.status ? new Map([[segmentKey(seg), watch.status]]) : undefined
  const dep = departureAt(seg, statuses), arr = arrivalAt(seg, statuses)
  if (dep === undefined || now < dep - WATCH_FROM_MS) return false
  if (watch?.status?.state === 'landed' || watch?.status?.state === 'cancelled') return false
  if (arr !== undefined && now > arr + 30 * MIN) return false
  if (o.monthCalls >= o.monthlyCalls || (watch?.calls ?? 0) >= (o.perFlightCalls ?? PER_FLIGHT_CALLS)) return false
  const interval = dep - now > 2 * HOUR ? HOUR
    : now < dep + 30 * MIN || (arr !== undefined && arr - now <= 30 * MIN) ? 15 * MIN
    : 45 * MIN
  return !watch || now - Date.parse(watch.polledAt) >= interval
}

// ---------------------------------------------------------------------------
// What to say
// ---------------------------------------------------------------------------

export type FlightNotice = { key: string; text: string; urgent: boolean }

/**
 * What changed worth a message, each at most once (`told` holds the keys).
 * Delays are told when they reach the tolerance and again only when they move
 * by another tolerance; falling back under it is said once. Arrival-side slips
 * mid-flight are not messaged: the brief's trip line already shows them.
 */
export function flightNotices(seg: FlightSegment, prev: FlightStatus | undefined, next: FlightStatus, told: string[], o: { delayMinutes: number }): FlightNotice[] {
  const id = seg.from && seg.to ? `${seg.flight} ${seg.from}→${seg.to}` : seg.flight
  const out: FlightNotice[] = []
  // Polling only runs on flight day, so a change before departure breaks through quiet hours: held, it arrives after boarding.
  const add = (key: string, text: string, urgent = true) => { if (!told.includes(key)) out.push({ key, text: `${id}: ${text}`, urgent }) }

  if (next.state === 'cancelled') { add('cancelled', 'cancelled', true); return out }
  if (next.state === 'diverted') { add(`diverted:${next.divertedTo ?? '?'}`, `diverted${next.divertedTo ? ` to ${next.divertedTo}` : ''}`, false); return out }
  if (next.state === 'departed' || next.state === 'landed') return out

  if (prev?.gate && next.gate && prev.gate !== next.gate) {
    add(`gate:${next.terminal ?? ''}/${next.gate}`, `gate is now ${next.terminal ? `${next.terminal} ` : ''}${next.gate} (was ${prev.gate})`)
  }

  const sched = departureAt(seg), est = next.estimatedDepartUtc ? Date.parse(next.estimatedDepartUtc) : NaN
  if (sched !== undefined && !Number.isNaN(est)) {
    const mins = Math.round((est - sched) / MIN)
    // Only delays told since the last "back on time" count as the baseline.
    const since = told.slice(told.lastIndexOf('ontime') + 1)
    const last = Math.max(0, ...since.map(k => Number(/^delay:(\d+)$/.exec(k)?.[1] ?? 0)))
    if (mins >= o.delayMinutes && Math.abs(mins - last) >= o.delayMinutes) {
      const when = seg.depart.zone ? wallClock(est, seg.depart.zone) : undefined
      add(`delay:${mins}`, when
        ? `now departs ${when.slice(11)} ${seg.depart.zone} (+${mins}m)${next.gate ? `, gate ${next.gate}` : ''}`
        : `delayed (+${mins}m)`)
    } else if (mins < o.delayMinutes && last > 0) {
      add('ontime', 'back on time', false)
    }
  }
  return out
}

/**
 * Record a poll: store the status, work out the notices and mark them told.
 * A miss (no answer, an error) is charged and timed like a hit, so a flight the
 * provider does not know waits its interval instead of being asked every tick.
 */
export function applyPoll(state: FlightsState, seg: FlightSegment, status: FlightStatus | undefined, now: number, cfg: { delayMinutes: number }): FlightNotice[] {
  const key = segmentKey(seg)
  const watch: FlightWatch = state.flights[key] ?? { polledAt: '', calls: 0, told: [] }
  const notices = status ? flightNotices(seg, watch.status, status, watch.told, cfg) : []
  watch.told.push(...notices.map(n => n.key))
  if (status) watch.status = status
  watch.polledAt = new Date(now).toISOString()
  watch.calls++
  state.flights[key] = watch
  return notices
}
