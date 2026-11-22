/**
 * The flight-day card the phone keeps for when it has no signal: the next
 * flight leaving within `windowHours`, with the live gate and times when
 * flight status has them and the booked ones otherwise.
 *
 * Read-only. /app/gate serves it to app tokens only: it carries the seat and
 * the booking reference, which the dashboard API never hands out.
 */
import type { Trip, FlightSegment, AirportTable } from './trips.ts'
import type { Doc } from './documents.ts'
import { passportProblems } from './documents.ts'
import { type FlightStatus, segmentKey, flightsOf, departureAt, arrivalAt, wallClock } from './triplife.ts'

const MIN = 60_000
const HOUR = 60 * MIN

export type GateCard = {
  key: string
  flight: string
  carrier: string
  from?: string
  to?: string
  fromCity?: string
  toCity?: string
  /** YYYY-MM-DD, local at the departure airport. */
  date: string
  /** "HH:MM" wall clock at each airport as booked. */
  departs: string
  arrives?: string
  /** The same, re-estimated by flight status; absent when on schedule or unknown. */
  departsEst?: string
  arrivesEst?: string
  /** UTC instant of departure (estimated when known), so the phone can retire the card on its own. */
  departsAt?: string
  durationMinutes?: number
  state?: FlightStatus['state']
  delayMinutes?: number
  gate?: string
  terminal?: string
  seat?: string
  cabin?: string
  booking?: string
  statusAsOf?: string
  /** Passport warnings for the trip this flight belongs to. */
  notes: string[]
}

/** A card stays up until an hour after the flight leaves; it appears `windowHours` before. */
export function gateCard(
  trips: Trip[], statuses: Map<string, FlightStatus>, airports: AirportTable, docs: Doc[],
  now: number, windowHours = 36,
): GateCard | null {
  let best: { seg: FlightSegment; trip: Trip; at: number } | undefined
  for (const trip of trips) for (const seg of flightsOf(trip)) {
    const at = departureAt(seg, statuses)
    if (at === undefined || at < now - HOUR || at - now > windowHours * HOUR) continue
    if (!best || at < best.at) best = { seg, trip, at }
  }
  if (!best) return null
  const { seg, trip, at } = best
  const st = statuses.get(segmentKey(seg))
  const booked = departureAt(seg), bookedArr = arrivalAt(seg), arr = arrivalAt(seg, statuses)
  const hhmm = (ms: number | undefined, zone?: string) => ms !== undefined && zone ? wallClock(ms, zone)?.slice(11, 16) : undefined
  const delay = booked !== undefined && at !== booked ? Math.round((at - booked) / MIN) : undefined
  const departsEst = delay ? hhmm(at, seg.depart.zone) : undefined
  const arrivesEst = arr !== undefined && arr !== bookedArr ? hhmm(arr, seg.arrive?.zone) : undefined
  return {
    key: segmentKey(seg),
    flight: seg.flight,
    carrier: seg.carrier,
    ...(seg.from ? { from: seg.from, fromCity: airports[seg.from]?.city } : {}),
    ...(seg.to ? { to: seg.to, toCity: airports[seg.to]?.city } : {}),
    date: seg.depart.local.slice(0, 10),
    departs: seg.depart.local.slice(11, 16),
    ...(seg.arrive ? { arrives: seg.arrive.local.slice(11, 16) } : {}),
    ...(departsEst ? { departsEst } : {}),
    ...(arrivesEst ? { arrivesEst } : {}),
    departsAt: new Date(at).toISOString(),
    ...(booked !== undefined && bookedArr !== undefined ? { durationMinutes: Math.round((bookedArr - booked) / MIN) } : {}),
    ...(st ? { state: st.state, statusAsOf: st.asOf } : {}),
    ...(delay ? { delayMinutes: delay } : {}),
    ...(st?.gate ? { gate: st.gate } : {}),
    ...(st?.terminal ? { terminal: st.terminal } : {}),
    ...(seg.seat ? { seat: seg.seat } : {}),
    ...(seg.cabin ? { cabin: seg.cabin } : {}),
    ...(seg.pnr ? { booking: seg.pnr } : {}),
    notes: passportProblems(trip.end, docs),
  }
}
