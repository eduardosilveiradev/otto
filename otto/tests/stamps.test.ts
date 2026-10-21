import { test, expect } from 'bun:test'
import { resolveZoned, type Trip, type FlightSegment, type StaySegment } from '../trips.ts'
import type { Place } from '../places.ts'
import { stamps } from '../stamps.ts'

const fl = (from: string, to: string, day: string): FlightSegment => ({
  kind: 'flight', flight: 'TA1', carrier: 'TA', from, to,
  depart: resolveZoned({ local: `${day}T09:00` }), arrive: resolveZoned({ local: `${day}T15:00` }),
})
const trip = (segments: (FlightSegment | StaySegment)[]): Trip =>
  ({ id: 't', start: '2026-01-01', end: '2026-01-09', segments, pnrs: [], sources: [], updatedAt: '2026-01-01T00:00:00Z' })
const AIRPORTS = { JFK: { city: 'New York', country: 'us' }, LGA: { city: 'New York', country: 'US' }, SFO: { city: 'San Francisco', country: 'US' }, XXX: { country: 'FR' } }
const place = (over: Partial<Place>): Place => ({
  id: 'x', name: 'Café Lume', city: 'New York', kind: 'cafe', status: 'loved', tags: [],
  notes: [{ at: '2026-02-01T10:00:00Z', text: 'the cortado' }], createdAt: '2026-02-01T10:00:00Z', updatedAt: '2026-02-01T10:00:00Z', ...over,
})

test('one stamp per city, two airports in it counting as two visits, first and last kept', () => {
  const s = stamps([trip([fl('SFO', 'JFK', '2026-03-02')]), trip([fl('SFO', 'LGA', '2026-01-10')])], AIRPORTS, [])
  expect(s).toHaveLength(1)
  expect(s[0]).toMatchObject({ city: 'New York', country: 'US', first: '2026-01-10', last: '2026-03-02', visits: 2 })
  // Two legs landing the same day are one visit.
  expect(stamps([trip([fl('SFO', 'JFK', '2026-03-02'), fl('SFO', 'JFK', '2026-03-02')])], AIRPORTS, [])[0].visits).toBe(1)
})

test('an airport with no city stands alone under its code; stays stamp their city', () => {
  const stay: StaySegment = { kind: 'stay', name: 'Hotel', city: 'Lisboa', country: 'pt', checkIn: '2026-05-01', checkOut: '2026-05-03' }
  const s = stamps([trip([fl('SFO', 'XXX', '2026-04-01'), stay])], AIRPORTS, [])
  expect(s.map(x => [x.id, x.code, x.city, x.country])).toEqual([['XXX', 'XXX', undefined, 'FR'], ['lisboa', undefined, 'Lisboa', 'PT']])
})

test("places hang off their city's stamp with the latest note; been/loved elsewhere earn their own", () => {
  const s = stamps([trip([fl('SFO', 'JFK', '2026-03-02')])], AIRPORTS, [
    place({}),
    place({ name: 'Bar', city: 'Porto', status: 'been', notes: [], createdAt: '2025-12-24T00:00:00Z' }),
    place({ name: 'Wishlist', city: 'Tokyo', status: 'want' }),
  ])
  expect(s.map(x => x.city)).toEqual(['Porto', 'New York'])
  expect(s[1].places).toEqual([{ name: 'Café Lume', kind: 'cafe', status: 'loved', note: 'the cortado' }])
  expect(s[0]).toMatchObject({ first: '2025-12-24', places: [{ name: 'Bar', status: 'been' }] })
})
