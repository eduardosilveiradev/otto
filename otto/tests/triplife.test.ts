import { test, expect } from 'bun:test'

// localDay() reads the machine's calendar; pin it so dates below are stable.
process.env.TZ = 'UTC'
import { resolveZoned, type Trip, type AirportTable, type FlightSegment, type StaySegment } from '../trips.ts'
import {
  airborne, currentOrNextTrip, milestones, checkInOpensAt, formatTripMode, dueLifecycleEvents,
  markFired, hasFired, tripExpenses, formatTripExpenses, destinations,
  wallClock, relative, segmentKey, noFlightStatus, localDay,
  LANDING_GRACE_MS, TRIP_MODE_MAX_CHARS, type FlightStatus,
} from '../triplife.ts'
import { holdReason } from '../queue.ts'
import type { MoneyRecord } from '../money.ts'

const AIRPORTS: AirportTable = {
  EZE: { zone: 'America/Argentina/Buenos_Aires', country: 'AR', city: 'Buenos Aires', currency: 'BRL' },
  BER: { zone: 'Europe/Berlin', country: 'DE', city: 'Berlin', currency: 'EUR' },
}

const H = 3_600_000
const at = (iso: string) => Date.parse(iso)

// Outbound lands 06:10 Berlin = 04:10Z; departs 14:35 Buenos Aires = 17:35Z the day before.
function flight(over: Partial<FlightSegment> & Pick<FlightSegment, 'flight' | 'from' | 'to'>, dep: [string, string], arr?: [string, string]): FlightSegment {
  return {
    kind: 'flight',
    carrier: over.flight.slice(0, 2),
    depart: resolveZoned({ local: dep[0], zone: dep[1] }),
    ...(arr ? { arrive: resolveZoned({ local: arr[0], zone: arr[1] }) } : {}),
    ...over,
  }
}

function makeTrip(): Trip {
  const out = flight({ flight: 'LH510', from: 'EZE', to: 'BER', pnr: 'ABC12D' },
    ['2026-10-02T14:35', 'America/Argentina/Buenos_Aires'], ['2026-10-03T06:10', 'Europe/Berlin'])
  const stay: StaySegment = {
    kind: 'stay', name: 'Hotel Aurora', city: 'Berlin', address: 'Via Example 1',
    checkIn: '2026-10-03', checkOut: '2026-10-07',
    freeCancelUntil: resolveZoned({ local: '2026-10-01T18:00', zone: 'Europe/Berlin' }),
  }
  const back = flight({ flight: 'LH511', from: 'BER', to: 'EZE', checkInOpensHours: 48 },
    ['2026-10-07T10:00', 'Europe/Berlin'], ['2026-10-07T17:30', 'America/Argentina/Buenos_Aires'])
  return {
    id: 't1', start: '2026-10-02', end: '2026-10-07',
    segments: [out, stay, back], pnrs: ['ABC12D'], sources: ['email:booking-1'],
    updatedAt: '2026-09-01T00:00:00Z',
  }
}

test('instants are derived from the airport zones, never converted in storage', () => {
  const t = makeTrip()
  const out = t.segments[0] as FlightSegment
  expect(out.depart.local).toBe('2026-10-02T14:35')
  expect(out.depart.utc).toBe('2026-10-02T17:35:00.000Z')
  expect(out.arrive?.utc).toBe('2026-10-03T04:10:00.000Z')
  expect(wallClock(at('2026-10-03T04:10:00Z'), 'Europe/Berlin')).toBe('2026-10-03 06:10')
})

test('airborne only between departure and landing plus taxi-in', () => {
  const trips = [makeTrip()]
  expect(airborne(trips, at('2026-10-02T17:00:00Z'))).toBeUndefined()
  const up = airborne(trips, at('2026-10-02T20:00:00Z'))
  expect(up?.seg.flight).toBe('LH510')
  expect(up?.until).toBe(at('2026-10-03T04:10:00Z') + LANDING_GRACE_MS)
  expect(airborne(trips, at('2026-10-03T04:15:00Z'))?.seg.flight).toBe('LH510')
  expect(airborne(trips, at('2026-10-03T04:25:00Z'))).toBeUndefined()
})

test('a flight whose zone is unknown never counts as airborne', () => {
  const t = makeTrip()
  const out = t.segments[0] as FlightSegment
  out.arrive = { local: '2026-10-03T06:10' }
  expect(airborne([t], at('2026-10-02T20:00:00Z'))).toBeUndefined()
})

test('a provider estimate moves the landing; a cancellation ends the hold', () => {
  const trips = [makeTrip()]
  const key = segmentKey(trips[0].segments[0] as FlightSegment)
  const late = new Map<string, FlightStatus>([[key, { state: 'departed', estimatedArriveUtc: '2026-10-03T05:30:00Z', asOf: '2026-10-02T20:00:00Z' }]])
  expect(airborne(trips, at('2026-10-03T05:00:00Z'), late)?.seg.flight).toBe('LH510')
  const gone = new Map<string, FlightStatus>([[key, { state: 'cancelled', asOf: '2026-10-02T20:00:00Z' }]])
  expect(airborne(trips, at('2026-10-02T20:00:00Z'), gone)).toBeUndefined()
})

test('current trip beats next; next only inside the horizon', () => {
  const trips = [makeTrip()]
  expect(currentOrNextTrip(trips, at('2026-10-04T12:00:00Z'))?.mode).toBe('current')
  expect(currentOrNextTrip(trips, at('2026-09-25T12:00:00Z'))?.mode).toBe('next')
  expect(currentOrNextTrip(trips, at('2026-09-01T12:00:00Z'))).toBeUndefined()
  expect(currentOrNextTrip(trips, at('2026-10-20T12:00:00Z'))).toBeUndefined()
})

test('check-in opens 24h before by default, or when the booking says', () => {
  const t = makeTrip()
  const [out, , back] = t.segments as [FlightSegment, StaySegment, FlightSegment]
  expect(checkInOpensAt(out)).toBe(at('2026-10-01T17:35:00Z'))
  expect(checkInOpensAt(back)).toBe(at('2026-10-05T08:00:00Z'))
  expect(checkInOpensAt({ ...out, depart: { local: '2026-10-02T14:35' } })).toBeUndefined()
})

test('milestones come soonest first, each in its own zone', () => {
  const m = milestones(makeTrip(), at('2026-09-30T12:00:00Z'))
  expect(m.map(x => x.kind).slice(0, 4)).toEqual(['cancel-deadline', 'check-in', 'depart', 'land'])
  expect(m[0].label).toBe('2026-10-01 18:00 Europe/Berlin')
  expect(m[1].label).toBe('2026-10-01 14:35 America/Argentina/Buenos_Aires')
})

test('trip mode names segments with their zones and what is due next', () => {
  const line = formatTripMode([makeTrip()], at('2026-09-30T12:00:00Z'), { stamp: '09:00' })!
  expect(line.startsWith('Trip (as of 09:00): next trip 2026-10-02→2026-10-07 · next: free cancellation ends, Hotel Aurora 2026-10-01 18:00 Europe/Berlin (in 1d 4h)')).toBe(true)
  expect(line).toContain('LH510 EZE→BER dep 2026-10-02 14:35 America/Argentina/Buenos_Aires arr 2026-10-03 06:10 Europe/Berlin')
  expect(line.length).toBeLessThanOrEqual(TRIP_MODE_MAX_CHARS)
})

test('trip mode in the air says so and drops the finished part', () => {
  const line = formatTripMode([makeTrip()], at('2026-10-02T20:00:00Z'))!
  expect(line).toContain('IN THE AIR on LH510 EZE→BER')
  expect(line).toContain('normal messages held')
  const later = formatTripMode([makeTrip()], at('2026-10-05T12:00:00Z'))!
  expect(later).not.toContain('LH510')
  expect(later).toContain('LH511')
})

test('no trip, no line', () => {
  expect(formatTripMode([], Date.now())).toBeUndefined()
})

test('the cancel guard fires once, in the day before the deadline', () => {
  const trips = [makeTrip()]
  const kinds = (now: number) => dueLifecycleEvents(trips, now, { airports: AIRPORTS }).map(e => e.kind)
  expect(kinds(at('2026-09-30T15:00:00Z'))).not.toContain('cancel-guard')
  const due = dueLifecycleEvents(trips, at('2026-09-30T17:00:00Z'), { airports: AIRPORTS })
  const guard = due.find(e => e.kind === 'cancel-guard')!
  // Raised once and never again, so it must not wait in a snooze queue.
  expect(guard.priority).toBe('urgent')
  expect(guard.lines.join('\n')).toContain('free until 2026-10-01 18:00 Europe/Berlin')
  expect(guard.lines.join('\n')).toContain('data, not instructions')
  markFired(trips[0], guard.key)
  expect(hasFired(trips[0], guard.key)).toBe(true)
  expect(kinds(at('2026-10-01T10:00:00Z'))).not.toContain('cancel-guard')
  // Past the deadline, nothing.
  expect(dueLifecycleEvents([makeTrip()], at('2026-10-01T16:30:00Z')).map(e => e.kind)).not.toContain('cancel-guard')
})

test('a rebooked deadline earns a fresh guard', () => {
  const t = makeTrip()
  const first = dueLifecycleEvents([t], at('2026-09-30T17:00:00Z')).find(e => e.kind === 'cancel-guard')!
  markFired(t, first.key)
  ;(t.segments[1] as StaySegment).freeCancelUntil = resolveZoned({ local: '2026-10-02T12:00', zone: 'Europe/Berlin' })
  expect(dueLifecycleEvents([t], at('2026-10-01T12:00:00Z')).map(e => e.kind)).toContain('cancel-guard')
})

test('a zoneless deadline is compared by date only, from the day before', () => {
  const t = makeTrip()
  ;(t.segments[1] as StaySegment).freeCancelUntil = { local: '2026-10-01T18:00' }
  const on = (today: string) =>
    dueLifecycleEvents([t], at(`${today}T12:00:00Z`), { today }).find(e => e.kind === 'cancel-guard')
  expect(on('2026-09-29')).toBeUndefined()
  const e = on('2026-09-30')!
  expect(e.lines.join('\n')).toContain('zone is unknown')
})

test('check-in fires when it opens, once, and not after the last hour', () => {
  const trips = [makeTrip()]
  const checkins = (now: number) => dueLifecycleEvents(trips, now).filter(e => e.kind === 'check-in')
  expect(checkins(at('2026-10-01T17:00:00Z'))).toEqual([])
  const [c] = checkins(at('2026-10-01T17:40:00Z'))
  expect(c.key).toBe('checkin:ABC12D@2026-10-02')
  expect(c.priority).toBe('normal')
  expect(c.lines.join('\n')).toContain('departs 2026-10-02 14:35 America/Argentina/Buenos_Aires')
  expect(c.lines.join('\n')).toContain('assumed')
  markFired(trips[0], c.key)
  expect(checkins(at('2026-10-01T18:00:00Z'))).toEqual([])
  // Discovered 30 minutes before departure: too late to be useful.
  expect(dueLifecycleEvents([makeTrip()], at('2026-10-02T17:05:00Z')).filter(e => e.kind === 'check-in')).toEqual([])
  // The return leg uses the booking's own 48h window.
  const back = dueLifecycleEvents([makeTrip()], at('2026-10-05T08:30:00Z')).find(e => e.kind === 'check-in')!
  expect(back.key).toBe('checkin:LH511@2026-10-07')
  expect(back.lines.join('\n')).toContain('from the booking')
})

test('arrival: local time there, the stay next, once, and only near landing', () => {
  const trips = [makeTrip()]
  const now = at('2026-10-03T04:20:00Z')
  expect(dueLifecycleEvents(trips, at('2026-10-03T04:15:00Z')).find(e => e.kind === 'arrival')).toBeUndefined()
  const a = dueLifecycleEvents(trips, now, { airports: AIRPORTS }).find(e => e.kind === 'arrival')!
  const text = a.lines.join('\n')
  expect(text).toContain('local time there now: 2026-10-03 06:20 Europe/Berlin')
  expect(text).toContain('next: Hotel Aurora, check-in 2026-10-03 — Via Example 1')
  expect(a.priority).toBe('normal')
  markFired(trips[0], a.key)
  expect(dueLifecycleEvents(trips, now).find(e => e.kind === 'arrival')).toBeUndefined()
  expect(dueLifecycleEvents([makeTrip()], at('2026-10-03T08:00:00Z')).find(e => e.kind === 'arrival')).toBeUndefined()
  // The last leg lands home.
  const home = dueLifecycleEvents([makeTrip()], at('2026-10-07T20:40:00Z')).find(e => e.kind === 'arrival')!
  expect(home.lines.join('\n')).toContain('nothing else booked')
})

test('arrival with an unknown zone does not state a local time', () => {
  const t = makeTrip()
  const out = t.segments[0] as FlightSegment
  // The mail stated an offset, so the instant is known, but no zone name —
  // and without the airport in the table there is no honest "local time now".
  out.arrive = { local: '2026-10-03T06:10', offsetMinutes: 120, utc: '2026-10-03T04:10:00.000Z' }
  const a = dueLifecycleEvents([t], at('2026-10-03T04:20:00Z')).find(e => e.kind === 'arrival')!
  expect(a.lines.join('\n')).toContain('do not state a local time')
})

test('the flight-status stub answers nothing, so everything runs on the schedule', async () => {
  expect(await noFlightStatus.status(makeTrip().segments[0] as FlightSegment)).toBeUndefined()
})

function rec(over: Partial<MoneyRecord> & Pick<MoneyRecord, 'merchant' | 'amount' | 'currency' | 'date'>): MoneyRecord {
  return { id: over.merchant.slice(0, 4), createdAt: '2026-10-01T00:00:00Z', ...over }
}

test('destinations exclude home and carry the currencies home does not use', () => {
  expect(destinations(makeTrip(), AIRPORTS)).toEqual({ names: ['Berlin'], currencies: ['EUR'], home: 'EZE' })
})

test('expenses: booking by source, destination by currency or name, home bills left out', () => {
  const records = [
    rec({ merchant: 'Airline', amount: 3200, currency: 'BRL', date: '2026-08-01', source: 'email:booking-1' }),
    rec({ merchant: 'Trattoria', amount: 42.5, currency: 'EUR', date: '2026-10-04' }),
    rec({ merchant: 'Taxi Berlin', amount: 30, currency: 'BRL', date: '2026-10-03', note: 'airport to Berlin centre' }),
    rec({ merchant: 'Rail', amount: 120, currency: 'BRL', date: '2026-10-05', category: 'travel' }),
    rec({ merchant: 'Phone bill', amount: 99.9, currency: 'BRL', date: '2026-10-05' }),
    rec({ merchant: 'Cafe', amount: 4, currency: 'EUR', date: '2026-11-01' }),
  ]
  const e = tripExpenses(makeTrip(), records, AIRPORTS)
  expect(e.attributed.map(a => [a.record.merchant, a.why])).toEqual([
    ['Airline', 'booking'],
    ['Taxi Berlin', 'destination-name'],
    ['Trattoria', 'destination-currency'],
    ['Rail', 'travel-category'],
  ])
  expect(e.unattributed.map(r => r.merchant)).toEqual(['Phone bill'])
  // Per currency, never mixed.
  expect(e.totals).toEqual([
    { currency: 'BRL', total: 3350, count: 3 },
    { currency: 'EUR', total: 42.5, count: 1 },
  ])
  const text = formatTripExpenses(makeTrip(), e)
  expect(text).toContain('not counted')
  expect(text).toContain('Phone bill')
})

test('relative labels read naturally', () => {
  expect(relative(at('2026-10-01T12:00:00Z') + 3 * H + 20 * 60_000, at('2026-10-01T12:00:00Z'))).toBe('in 3h 20m')
  expect(relative(at('2026-10-01T12:00:00Z') - 40 * 60_000, at('2026-10-01T12:00:00Z'))).toBe('40m ago')
})

// --- review fixes -----------------------------------------------------------

test('the arrival note comes due only after the in-flight hold lifts', () => {
  const trips = [makeTrip()]
  const landed = at('2026-10-03T04:10:00Z')
  for (let t = landed; t < landed + LANDING_GRACE_MS + 120_000; t += 60_000) {
    const up = airborne(trips, t)
    const arrival = dueLifecycleEvents(trips, t).find(e => e.kind === 'arrival')
    // Never both: a due note while the hold is on would be held into the digest.
    expect(Boolean(up && arrival)).toBe(false)
    if (arrival) {
      const held = holdReason(up ? { airborneUntil: new Date(up.until).toISOString() } : {}, {
        priority: arrival.priority, conversational: false, now: t,
      })
      expect(held).toBeNull()
    }
  }
  expect(dueLifecycleEvents(trips, landed + LANDING_GRACE_MS).find(e => e.kind === 'arrival')).toBeDefined()
})

// One PNR, two flight numbers, same route and day about an hour apart — a
// rebooking that sameSegment() does not merge.
function rebookedTrip(): Trip {
  const t = makeTrip()
  const dup = flight({ flight: 'LH512', from: 'EZE', to: 'BER', pnr: 'ABC12D' },
    ['2026-10-02T15:40', 'America/Argentina/Buenos_Aires'], ['2026-10-03T07:20', 'Europe/Berlin'])
  t.segments.splice(1, 0, dup)
  return t
}

test('a rebooked duplicate leg raises one check-in and one arrival, not two', () => {
  const t = rebookedTrip()
  const checkins = dueLifecycleEvents([t], at('2026-10-01T18:00:00Z')).filter(e => e.kind === 'check-in')
  expect(checkins.map(e => e.key)).toEqual(['checkin:ABC12D@2026-10-02'])
  markFired(t, checkins[0].key)
  expect(dueLifecycleEvents([t], at('2026-10-01T18:45:00Z')).filter(e => e.kind === 'check-in')).toEqual([])

  const first = dueLifecycleEvents([t], at('2026-10-03T04:25:00Z')).filter(e => e.kind === 'arrival')
  expect(first.map(e => e.key)).toEqual(['arrival:ABC12D:BER@2026-10-03'])
  markFired(t, first[0].key)
  // The duplicate lands an hour later and has nothing new to say.
  expect(dueLifecycleEvents([t], at('2026-10-03T05:35:00Z')).filter(e => e.kind === 'arrival')).toEqual([])
})

// EZE → LIS → BER on one booking, crossing midnight at the connection.
function connectionTrip(): Trip {
  const leg1 = flight({ flight: 'TP88', from: 'EZE', to: 'LIS', pnr: 'XYZ98K' },
    ['2026-10-02T16:00', 'America/Argentina/Buenos_Aires'], ['2026-10-03T06:00', 'Europe/Lisbon'])
  const leg2 = flight({ flight: 'TP840', from: 'LIS', to: 'BER', pnr: 'XYZ98K' },
    ['2026-10-03T08:30', 'Europe/Lisbon'], ['2026-10-03T12:20', 'Europe/Berlin'])
  return {
    id: 't2', start: '2026-10-02', end: '2026-10-03', segments: [leg1, leg2],
    pnrs: ['XYZ98K'], sources: [], updatedAt: '2026-09-01T00:00:00Z',
  }
}

test('a same-booking connection gets one check-in, for its first leg', () => {
  const t = connectionTrip()
  const leg1Open = dueLifecycleEvents([t], at('2026-10-01T19:30:00Z')).filter(e => e.kind === 'check-in')
  expect(leg1Open.map(e => e.key)).toEqual(['checkin:XYZ98K@2026-10-02'])
  markFired(t, leg1Open[0].key)
  // Leg two's own 24h window opens mid-flight on leg one; nothing new.
  expect(dueLifecycleEvents([t], at('2026-10-02T08:00:00Z')).filter(e => e.kind === 'check-in')).toEqual([])
  expect(milestones(t, at('2026-10-01T12:00:00Z')).filter(m => m.kind === 'check-in')).toHaveLength(1)
})

test('a layover gets no arrival note; the final leg does', () => {
  const t = connectionTrip()
  // Leg one lands in Lisbon 05:00Z; the onward leg leaves 07:30Z.
  expect(dueLifecycleEvents([t], at('2026-10-03T05:20:00Z')).filter(e => e.kind === 'arrival')).toEqual([])
  const final = dueLifecycleEvents([t], at('2026-10-03T10:35:00Z')).filter(e => e.kind === 'arrival')
  expect(final.map(e => e.key)).toEqual(['arrival:XYZ98K:BER@2026-10-03'])
  expect(final[0].lines.join('\n')).toContain('TP840 LIS→BER')
})

test('the local-day fallback is the machine calendar, and a passed today wins', () => {
  const late = at('2026-10-04T23:30:00Z')
  expect(localDay(late)).toBe('2026-10-04')
  // Passed explicitly (as the server does with todayStamp), it decides the date
  // checks: at 01:00Z on the 8th it is still the 7th — the trip's last day —
  // somewhere west of UTC, and the UTC date alone would call the trip over.
  const t = at('2026-10-08T01:00:00Z')
  expect(currentOrNextTrip([makeTrip()], t, { today: '2026-10-07' })?.mode).toBe('current')
  expect(currentOrNextTrip([makeTrip()], t, { today: '2026-10-08' })).toBeUndefined()
})

test('the trip line stays short even for a long trip', () => {
  const t = makeTrip()
  for (let i = 0; i < 6; i++) {
    t.segments.push({ kind: 'stay', name: `A Rather Long Guesthouse Name ${i}`, city: 'Somewhere Far', checkIn: '2026-10-04', checkOut: '2026-10-06' })
  }
  const line = formatTripMode([t], at('2026-09-30T12:00:00Z'))!
  expect(line.length).toBeLessThanOrEqual(300)
  expect(line).toContain('next: free cancellation ends')
})
