import { test, expect } from 'bun:test'
import { resolveZoned, type Trip, type FlightSegment } from '../trips.ts'
import { segmentKey, type FlightStatus } from '../triplife.ts'
import type { Doc } from '../documents.ts'
import { gateCard } from '../gate.ts'

const H = 3_600_000
// TA482 SFO→JFK: departs 08:45 Los Angeles time = 15:45Z, lands 17:05 New York = 21:05Z.
const seg = (over: Partial<FlightSegment> = {}): FlightSegment => ({
  kind: 'flight', flight: 'TA482', carrier: 'TA', from: 'SFO', to: 'JFK', seat: '14A', cabin: 'Economy', pnr: 'ABC123',
  depart: resolveZoned({ local: '2026-06-12T08:45', zone: 'America/Los_Angeles' }),
  arrive: resolveZoned({ local: '2026-06-12T17:05', zone: 'America/New_York' }),
  ...over,
})
const DEP = Date.parse('2026-06-12T15:45:00Z')
const trip = (segments: FlightSegment[], end = '2026-06-20'): Trip =>
  ({ id: 't1', start: '2026-06-12', end, segments, pnrs: [], sources: [], updatedAt: '2026-06-01T00:00:00Z' })
const AIRPORTS = { SFO: { city: 'San Francisco' }, JFK: { city: 'New York' } }
const none = new Map<string, FlightStatus>()

test('the booked flight shows inside the window, with cities, seat and duration', () => {
  const c = gateCard([trip([seg()])], none, AIRPORTS, [], DEP - 5 * H)!
  expect(c).toMatchObject({
    flight: 'TA482', from: 'SFO', to: 'JFK', fromCity: 'San Francisco', toCity: 'New York',
    date: '2026-06-12', departs: '08:45', arrives: '17:05', durationMinutes: 320,
    seat: '14A', cabin: 'Economy', booking: 'ABC123', notes: [],
  })
  expect(c.departsAt).toBe('2026-06-12T15:45:00.000Z')
  expect(c.state).toBeUndefined()
  expect(c.departsEst).toBeUndefined()
})

test('nothing outside the window: too early, or more than an hour gone', () => {
  expect(gateCard([trip([seg()])], none, AIRPORTS, [], DEP - 37 * H)).toBeNull()
  expect(gateCard([trip([seg()])], none, AIRPORTS, [], DEP + 61 * 60_000)).toBeNull()
  expect(gateCard([trip([seg()])], none, AIRPORTS, [], DEP + 30 * 60_000)).not.toBeNull()
})

test('the soonest flight wins across trips', () => {
  const later = seg({ flight: 'TA900', depart: resolveZoned({ local: '2026-06-12T20:00', zone: 'America/Los_Angeles' }) })
  expect(gateCard([trip([later]), trip([seg()])], none, AIRPORTS, [], DEP - H)!.flight).toBe('TA482')
})

test('live status re-times it, names the gate and keeps the booked times beside the new ones', () => {
  const st: FlightStatus = {
    state: 'scheduled', gate: 'B12', terminal: '2', asOf: '2026-06-12T13:00:00Z',
    estimatedDepartUtc: '2026-06-12T16:25:00Z', estimatedArriveUtc: '2026-06-12T21:45:00Z',
  }
  const c = gateCard([trip([seg()])], new Map([[segmentKey(seg()), st]]), AIRPORTS, [], DEP - 2 * H)!
  expect(c).toMatchObject({ departs: '08:45', departsEst: '09:25', arrives: '17:05', arrivesEst: '17:45', delayMinutes: 40, gate: 'B12', terminal: '2', state: 'scheduled' })
  expect(c.durationMinutes).toBe(320) // the booked block time, not the re-estimated one
})

test('passport warnings for the trip come along', () => {
  const doc: Doc = { id: 'd1', kind: 'passport', country: 'US', holder: 'me', expires: '2026-09-01' }
  expect(gateCard([trip([seg()])], none, AIRPORTS, [doc], DEP - H)!.notes).toEqual(['passport expires 2026-09-01, under 6 months after return'])
})

test('a flight with no known zone has no instant and never shows', () => {
  const s = seg({ depart: { local: '2026-06-12T08:45' } })
  expect(gateCard([trip([s])], none, AIRPORTS, [], DEP - H)).toBeNull()
})
