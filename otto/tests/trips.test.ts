import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  zoneOffsetAt, zonedToUtc, resolveZoned, formatZoned, offsetOfAbbreviation,
  parseZonedTime, parsePnr, parseFlightLine, parseFreeCancellation, parseBookingEmail,
  makeStay, mergeFragment, daysInCountry, cancellationDeadlines, tripProblems,
  parseDatePart, parseBoardingPass, parseCheckInHours,
  formatTrip, loadTrips, saveTrips, loadAirports,
  type Trip, type AirportTable, type FlightSegment,
} from '../trips.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-trips-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const AIRPORTS: AirportTable = {
  EZE: { zone: 'America/Argentina/Buenos_Aires', country: 'AR', city: 'Buenos Aires' },
  BER: { zone: 'Europe/Berlin', country: 'DE', city: 'Berlin' },
  LIS: { zone: 'Europe/Lisbon', country: 'PT', city: 'Lisbon' },
}

test('a zone resolves to its offset at a given instant, DST included', () => {
  expect(zoneOffsetAt('Europe/Berlin', Date.parse('2026-08-12T12:00:00Z'))).toBe(120)
  expect(zoneOffsetAt('Europe/Berlin', Date.parse('2026-01-12T12:00:00Z'))).toBe(60)
  expect(zoneOffsetAt('America/Argentina/Buenos_Aires', Date.parse('2026-08-12T12:00:00Z'))).toBe(-180)
  expect(zoneOffsetAt('Not/AZone', Date.now())).toBeUndefined()
})

test('a local wall clock plus a zone is an instant', () => {
  expect(zonedToUtc('2026-08-12T14:35', 'Europe/Berlin')).toBe('2026-08-12T12:35:00.000Z')
  expect(zonedToUtc('2026-01-12T14:35', 'Europe/Berlin')).toBe('2026-01-12T13:35:00.000Z')
  expect(zonedToUtc('2026-08-12T14:35', 'America/Argentina/Buenos_Aires')).toBe('2026-08-12T17:35:00.000Z')
})

// The bug the whole file exists to prevent.
test('a time with no zone gets no instant, ever', () => {
  const t = resolveZoned({ local: '2026-08-12T14:35' })
  expect(t.utc).toBeUndefined()
  expect(formatZoned(t)).toContain('zone unknown')
})

test('an explicit offset is enough on its own', () => {
  const t = resolveZoned({ local: '2026-08-12T14:35', offsetMinutes: -180 })
  expect(t.utc).toBe('2026-08-12T17:35:00.000Z')
})

test('only unambiguous zone abbreviations are honoured', () => {
  expect(offsetOfAbbreviation('ART')).toBe(-180)
  expect(offsetOfAbbreviation('cest')).toBe(120)
  // CST is Central US, China and Cuba; BST is Britain and Brazil.
  expect(offsetOfAbbreviation('CST')).toBeUndefined()
  expect(offsetOfAbbreviation('BST')).toBeUndefined()
  expect(offsetOfAbbreviation('IST')).toBeUndefined()
})

test('times parse out of the shapes booking mail uses', () => {
  expect(parseZonedTime('Departure: 12 Aug 2026 14:35')!.local).toBe('2026-08-12T14:35')
  expect(parseZonedTime('Aug 12, 2026 at 2:35 pm')!.local).toBe('2026-08-12T14:35')
  expect(parseZonedTime('2026-08-12 14:35')!.local).toBe('2026-08-12T14:35')
  expect(parseZonedTime('12 Aug 2026 14:35 (ART)')!.utc).toBe('2026-08-12T17:35:00.000Z')
  expect(parseZonedTime('2026-08-12 14:35 -03:00')!.utc).toBe('2026-08-12T17:35:00.000Z')
})

// One in two chance of moving a flight by months.
test('an ambiguous numeric date is refused unless the caller states the order', () => {
  expect(parseZonedTime('05/08/2026 14:35')).toBeUndefined()
  expect(parseZonedTime('05/08/2026 14:35', { dateOrder: 'dmy' })!.local).toBe('2026-08-05T14:35')
  expect(parseZonedTime('05/08/2026 14:35', { dateOrder: 'mdy' })!.local).toBe('2026-05-08T14:35')
  // 13 can only be a day, so no instruction is needed.
  expect(parseZonedTime('13/08/2026 14:35')!.local).toBe('2026-08-13T14:35')
})

test('a PNR is only read when the mail says it is one', () => {
  expect(parsePnr('Your booking reference: X4K9PQ')).toBe('X4K9PQ')
  expect(parsePnr('Codice di prenotazione JH8T2M for your trip')).toBe('JH8T2M')
  expect(parsePnr('Order ABC123XYZ shipped, colour #F4A2B1, invoice 998877')).toBeUndefined()
  expect(parsePnr('Confirmation number: 483920')).toBeUndefined()
})

test('a flight line becomes a segment with both airports and zoned times', () => {
  const seg = parseFlightLine('Flight LH 510  EZE → BER  12 Aug 2026  14:35  06:10', { airports: AIRPORTS })!
  expect(seg.flight).toBe('LH510')
  expect(seg.from).toBe('EZE')
  expect(seg.to).toBe('BER')
  expect(seg.depart.zone).toBe('America/Argentina/Buenos_Aires')
  expect(seg.depart.utc).toBe('2026-08-12T17:35:00.000Z')
  // 06:10 is before 14:35, so it lands the next morning, in Berlin time.
  expect(seg.arrive!.local).toBe('2026-08-13T06:10')
  expect(seg.arrive!.utc).toBe('2026-08-13T04:10:00.000Z')
})

// Without the table there is no zone, and pretending otherwise is the bug.
test('an unknown airport leaves the time zoneless rather than assuming the user’s own', () => {
  const seg = parseFlightLine('Flight LH510 XXX → YYY 12 Aug 2026 14:35', {})!
  expect(seg.depart.local).toBe('2026-08-12T14:35')
  expect(seg.depart.utc).toBeUndefined()
  expect(seg.depart.zone).toBeUndefined()
})

test('a line that merely contains a code pair is not a flight', () => {
  expect(parseFlightLine('Invoice A4 2024 paid on 12 Aug 2026 14:35', {})).toBeUndefined()
  expect(parseFlightLine('Flight LH510 with no date at all', {})).toBeUndefined()
})

test('a seat is picked up when the line carries one', () => {
  const seg = parseFlightLine('Flight LH 1234 BER → LIS 12 Aug 2026 09:00 11:20 seat: 14C', { airports: AIRPORTS })!
  expect(seg.seat).toBe('14C')
  expect(seg.carrier).toBe('LH')
})

test('a whole booking email yields its flights, each stamped with the PNR', () => {
  const mail = [
    'Your booking is confirmed.',
    'Booking reference: X4K9PQ',
    '',
    'Flight LH 510  EZE → BER  12 Aug 2026  14:35  06:10',
    'Flight LH 511  BER → EZE  28 Aug 2026  10:15  17:40',
    'Thank you for flying with us.',
  ].join('\n')
  const frag = parseBookingEmail(mail, { airports: AIRPORTS, source: 'email:abc' })
  expect(frag.segments).toHaveLength(2)
  expect(frag.pnrs).toEqual(['X4K9PQ'])
  expect((frag.segments[0] as FlightSegment).pnr).toBe('X4K9PQ')
})

test('free cancellation deadlines are read with the hotel\'s own zone', () => {
  const t = parseFreeCancellation('Free cancellation until 10 Aug 2026 23:59', { zone: 'Europe/Berlin' })!
  expect(t.local).toBe('2026-08-10T23:59')
  expect(t.utc).toBe('2026-08-10T21:59:00.000Z')
  expect(parseFreeCancellation('This rate is non-refundable.')).toBeUndefined()
})

test('a stay with an impossible date range is refused', () => {
  expect(makeStay({ name: 'H', checkIn: '2026-08-20', checkOut: '2026-08-12' })).toBeUndefined()
  expect(makeStay({ name: 'H', checkIn: 'sometime', checkOut: '2026-08-12' })).toBeUndefined()
})

// The four-emails-one-trip problem this whole file exists for.
test('fragments arriving separately merge into one trip by date range', () => {
  const trips: Trip[] = []
  mergeFragment(trips, parseBookingEmail(
    'Booking reference: X4K9PQ\nFlight LH 510 EZE → BER 12 Aug 2026 14:35 06:10',
    { airports: AIRPORTS, source: 'email:1' },
  ))
  mergeFragment(trips, {
    segments: [makeStay({
      name: 'Hotel Berlin', checkIn: '2026-08-13', checkOut: '2026-08-27',
      address: 'Torstrasse 12, Berlin', confirmation: 'BK-991',
    })!],
    source: 'email:2',
  })
  mergeFragment(trips, parseBookingEmail(
    'Booking reference: X4K9PQ\nFlight LH 511 BER → EZE 28 Aug 2026 10:15 17:40',
    { airports: AIRPORTS, source: 'email:3' },
  ))

  expect(trips).toHaveLength(1)
  expect(trips[0].segments).toHaveLength(3)
  expect(trips[0].start).toBe('2026-08-12')
  expect(trips[0].end).toBe('2026-08-28')
  expect(trips[0].sources).toEqual(['email:1', 'email:2', 'email:3'])
})

test('a trip months later is a different trip', () => {
  const trips: Trip[] = []
  mergeFragment(trips, parseBookingEmail('Flight LH 510 EZE → BER 12 Aug 2026 14:35', { airports: AIRPORTS }))
  mergeFragment(trips, parseBookingEmail('Flight LH 510 EZE → BER 12 Dec 2026 14:35', { airports: AIRPORTS }))
  expect(trips).toHaveLength(2)
})

test('the same flight arriving twice does not duplicate, and the later mail fills gaps', () => {
  const trips: Trip[] = []
  mergeFragment(trips, parseBookingEmail('Flight LH 510 EZE → BER 12 Aug 2026 14:35 06:10', { airports: AIRPORTS }))
  mergeFragment(trips, parseBookingEmail('Flight LH 510 EZE → BER 12 Aug 2026 14:35 06:10 seat: 22A', { airports: AIRPORTS }))
  expect(trips[0].segments).toHaveLength(1)
  expect((trips[0].segments[0] as FlightSegment).seat).toBe('22A')
})

// A zoned time is strictly better than an unzoned one and must win.
test('a fragment that knows the zone upgrades one that did not', () => {
  const trips: Trip[] = []
  mergeFragment(trips, parseBookingEmail('Flight LH 510 EZE → BER 12 Aug 2026 14:35', {}))
  expect((trips[0].segments[0] as FlightSegment).depart.utc).toBeUndefined()
  mergeFragment(trips, parseBookingEmail('Flight LH 510 EZE → BER 12 Aug 2026 14:35', { airports: AIRPORTS }))
  expect((trips[0].segments[0] as FlightSegment).depart.utc).toBe('2026-08-12T17:35:00.000Z')
})

test('days in country are counted inclusively at both ends', () => {
  const trips: Trip[] = []
  mergeFragment(trips, parseBookingEmail(
    ['Flight LH 510 EZE → BER 12 Aug 2026 14:35 06:10',
      'Flight TP 999 BER → LIS 20 Aug 2026 09:00 11:20',
      'Flight TP 998 LIS → EZE 28 Aug 2026 10:15 17:40'].join('\n'),
    { airports: AIRPORTS },
  ))
  const days = daysInCountry(trips[0], AIRPORTS)
  const byCountry = Object.fromEntries(days.map(d => [d.country, d.days]))
  // Lands in Germany on the 13th, leaves on the 20th: eight days by the
  // entry-and-exit-both-count convention.
  expect(byCountry.DE).toBe(8)
  expect(byCountry.PT).toBe(9)
  expect(byCountry.AR).toBe(1)
})

test('a leg into an airport the table does not know contributes nothing', () => {
  const trips: Trip[] = []
  mergeFragment(trips, parseBookingEmail('Flight LH 510 EZE → ZZZ 12 Aug 2026 14:35 18:10', { airports: AIRPORTS }))
  expect(daysInCountry(trips[0], AIRPORTS)).toEqual([])
})

test('cancellation deadlines already past are not surfaced', () => {
  const trips: Trip[] = []
  mergeFragment(trips, {
    segments: [
      makeStay({
        name: 'Hotel Berlin', checkIn: '2026-08-13', checkOut: '2026-08-27',
        freeCancelUntil: parseFreeCancellation('free cancellation until 10 Aug 2026 23:59', { zone: 'Europe/Berlin' })!,
      })!,
      makeStay({
        name: 'Pousada', checkIn: '2026-08-14', checkOut: '2026-08-16',
        freeCancelUntil: parseFreeCancellation('free cancellation until 1 Aug 2026 12:00', { zone: 'Europe/Berlin' })!,
      })!,
    ],
  })
  const due = cancellationDeadlines(trips[0], Date.parse('2026-08-05T00:00:00Z'))
  expect(due.map(d => d.stay.name)).toEqual(['Hotel Berlin'])
})

test('everything unknowable is named rather than filled in', () => {
  const trips: Trip[] = []
  mergeFragment(trips, parseBookingEmail('Flight LH510 with departure 12 Aug 2026 14:35', {}))
  const problems = tripProblems(trips[0])
  expect(problems.join('\n')).toContain('no timezone')
  expect(problems.join('\n')).toContain('route incomplete')
  expect(problems.join('\n')).toContain('no arrival time')
})

test('a fully known trip has no problems', () => {
  const trips: Trip[] = []
  mergeFragment(trips, parseBookingEmail('Flight LH 510 EZE → BER 12 Aug 2026 14:35 06:10', { airports: AIRPORTS }))
  expect(tripProblems(trips[0])).toEqual([])
})

test('formatting always shows the zone next to the time', () => {
  const trips: Trip[] = []
  mergeFragment(trips, parseBookingEmail('Booking reference: X4K9PQ\nFlight LH 510 EZE → BER 12 Aug 2026 14:35 06:10', { airports: AIRPORTS }))
  const text = formatTrip(trips[0])
  expect(text).toContain('X4K9PQ')
  expect(text).toContain('EZE→BER')
  expect(text).toContain('America/Argentina/Buenos_Aires')
  expect(text).toContain('Europe/Berlin')
})

test('trips round-trip through disk and the airport table defaults to empty', () => {
  const file = join(tmp, 'trips.json')
  const trips: Trip[] = []
  mergeFragment(trips, parseBookingEmail('Flight LH 510 EZE → BER 12 Aug 2026 14:35', { airports: AIRPORTS }))
  saveTrips(file, trips)
  expect(loadTrips(file)).toEqual(trips)
  expect(loadAirports(join(tmp, 'no-airports.json'))).toEqual({})
})

// --- boarding passes ---------------------------------------------------------
//
// A pass lays its itinerary out as a column rather than a line, and writes the
// date closed up. Both defeated the line-by-line parser, so a real mail came
// back "nothing parsed" and the flight went unrecorded.

const PASS = [
  "Carta d'imbarco per il vostro volo",
  '',
  'Premium Economy',
  'Gate',
  '....',
  'Boarding Group',
  '3',
  'Seat',
  '22J',
  '',
  '15AUG26',
  'LH 510',
  'EZE',
  'BER',
  'Buenos Aires',
  'Berlin/Brandenburg',
  '14:25',
  '06:40+1',
  'Terminal',
  '2',
  'Imbarco',
  '13:25',
  '',
  'Codice di prenotazione',
  'X4K9PQ',
].join('\n')

test('a compact boarding-pass date parses', () => {
  expect(parseDatePart('15AUG26', {})).toBe('2026-08-15')
  expect(parseDatePart('05OCT2026', {})).toBe('2026-10-05')
  expect(parseDatePart('LH510', {})).toBeUndefined()
})

test('a vertical boarding pass yields the flight the line parser cannot see', () => {
  expect(parseFlightLine('LH 510', { airports: AIRPORTS })).toBeUndefined()

  const seg = parseBoardingPass(PASS, { airports: AIRPORTS })!
  expect(seg.flight).toBe('LH510')
  expect(seg.from).toBe('EZE')
  expect(seg.to).toBe('BER')
  expect(seg.seat).toBe('22J')
  expect(seg.depart.local).toBe('2026-08-15T14:25')
  expect(seg.depart.zone).toBe('America/Argentina/Buenos_Aires')
  // "+1" is stated outright on the pass, so arrival lands on the 16th in Berlin.
  expect(seg.arrive?.local).toBe('2026-08-16T06:40')
  expect(seg.arrive?.zone).toBe('Europe/Berlin')
})

test('the whole pass parses end to end, locator included', () => {
  const frag = parseBookingEmail(PASS, { airports: AIRPORTS })
  expect(frag.segments).toHaveLength(1)
  const seg = frag.segments[0] as FlightSegment
  expect(seg.flight).toBe('LH510')
  expect(seg.pnr).toBe('X4K9PQ')
})

test('the pass parser stays a fallback and never doubles a normal itinerary', () => {
  const frag = parseBookingEmail('Booking reference: X4K9PQ\nFlight LH 510 EZE → BER 12 Aug 2026 14:35 06:10', { airports: AIRPORTS })
  expect(frag.segments).toHaveLength(1)
})

test('compact boarding-pass dates are calendar dates and preserve four-digit years', () => {
  expect(parseDatePart('31APR26', {})).toBeUndefined()
  expect(parseDatePart('29FEB26', {})).toBeUndefined()
  expect(parseDatePart('29FEB2100', {})).toBeUndefined()
  expect(parseDatePart('15AUG0026', {})).toBe('0026-08-15')
  expect(parseBoardingPass(BOARDING_BASE.replace('15AUG26', '15AUG0026'))?.arrive?.local).toBe('0026-08-16T06:40')
  expect(parseDatePart('00ABC26 15AUG26', {})).toBe('2026-08-15')
  expect(parseDatePart('00AUG26 15AUG26', {})).toBe('2026-08-15')
  expect(parseDatePart('15AUG', { assumeYear: 2026 })).toBe('2026-08-15')
})

const BOARDING_BASE = '15AUG26\nLH510\nEZE\nBER\n14:25\n06:40+1'

test('a boarding pass selects the designator attached to its itinerary', () => {
  const referenceBeforeFlight = [
    'Booking reference', 'AB1234', '15AUG26', 'Flight', 'LH510', 'EZE', 'BER', '14:25', '06:40+1',
  ].join('\n')
  expect(parseBoardingPass(referenceBeforeFlight)!.flight).toBe('LH510')

  const distantDate = [
    'Booking reference', 'AB1234', 'Passenger', 'EXAMPLE/PERSON', 'Ticket', '1234567890123', 'Cabin', 'Economy',
    '15AUG26', 'LH510', 'EZE', 'BER', '14:25', '06:40+1',
  ].join('\n')
  expect(parseBoardingPass(distantDate)?.flight).toBe('LH510')
  const incomplete = parseBoardingPass('15AUG26\nLH510\n14:25')!
  expect(incomplete.depart.local).toBe('2026-08-15T14:25')
  expect(incomplete.from).toBeUndefined()
  expect(incomplete.to).toBeUndefined()
})

test('a boarding pass reads its departure date and its complete itinerary beyond old search windows', () => {
  const issuedDate = 'Departure date: 15AUG26\nIssued: 14AUG26\nLH510\nEZE\nBER\n14:25\n06:40+1'
  expect(parseBoardingPass(issuedDate)!.depart.local).toBe('2026-08-15T14:25')

  const dateSevenLinesEarlier = [
    '15AUG26', 'Passenger', 'EXAMPLE/PERSON', 'Cabin', 'Economy', 'Flight', 'Number', 'LH510', 'EZE', 'BER', '14:25', '06:40+1',
  ].join('\n')
  expect(parseBoardingPass(dateSevenLinesEarlier)?.flight).toBe('LH510')

  const timesAfterMetadata = [
    '15AUG26', 'LH510', 'EZE', 'BER', 'Passenger', 'EXAMPLE/PERSON', 'Cabin', 'Economy', 'Seat', '22J', 'Gate', '12',
    'Terminal', '2', 'Group', '3', 'Departure', '14:25', '06:40+1',
  ].join('\n')
  const seg = parseBoardingPass(timesAfterMetadata)!
  expect(seg.depart.local).toBe('2026-08-15T14:25')
  expect(seg.arrive?.local).toBe('2026-08-16T06:40')
  expect(seg.seat).toBe('22J')
})

test('boarding-pass fields do not become route or itinerary times', () => {
  const pnrBeforeRoute = '15AUG26\nLH510\nPNR\nX4K9PQ\nEZE\nBER\n14:25\n06:40+1'
  const route = parseBoardingPass(pnrBeforeRoute)!
  expect(route.from).toBe('EZE')
  expect(route.to).toBe('BER')

  const pnrAirport = '15AUG26\nLH510\nFrom\nPNR\nTo\nCDG\n14:25\n20:40'
  const pnrRoute = parseBoardingPass(pnrAirport)!
  expect(pnrRoute.from).toBe('PNR')
  expect(pnrRoute.to).toBe('CDG')

  const labelledTimes = '15AUG26\nLH510\nEZE\nBER\nBoarding\n13:25\nDeparture\n14:25\nArrival\n06:40+1'
  const times = parseBoardingPass(labelledTimes)!
  expect(times.depart.local).toBe('2026-08-15T14:25')
  expect(times.arrive?.local).toBe('2026-08-16T06:40')

  const twoFlights = '15AUG26\nLH510\nEZE\nBER\nDeparture\n14:25\n16AUG26\nLH511\nBER\nEZE\nDeparture\n10:00'
  expect(parseBoardingPass(twoFlights)?.arrive).toBeUndefined()
})

test('boarding-pass dates and stated day offsets bind to their own times', () => {
  const explicitArrival = '15AUG26\nLH510\nEZE\nBER\nDeparture\n14:25\nArrival\n17AUG26\n06:40'
  expect(parseBoardingPass(explicitArrival)?.arrive?.local).toBe('2026-08-17T06:40')

  const dateBeforeArrivalField = '15AUG26\nLH510\nEZE\nBER\nDeparture\n14:25\n17AUG26\nArrival\n06:40'
  expect(parseBoardingPass(dateBeforeArrivalField)?.arrive?.local).toBe('2026-08-16T06:40')

  const offsets = '15AUG26\nLH510\nEZE\nBER\n14:25+1\n06:40+2'
  const offsetSeg = parseBoardingPass(offsets)!
  expect(offsetSeg.depart.local).toBe('2026-08-16T14:25')
  expect(offsetSeg.arrive?.local).toBe('2026-08-17T06:40')

  expect(parseBoardingPass('15AUG26\nLH510\nEZE\nBER\n14:25+1\n06:40')?.arrive?.local).toBe('2026-08-17T06:40')

  const negativeArrival = '15AUG26\nNZ10\nAKL\nHNL\n00:30\n10:30-1'
  expect(parseBoardingPass(negativeArrival)?.arrive?.local).toBe('2026-08-14T10:30')
})

test('boarding-pass midnight inference compares known-zone instants', () => {
  const seg = parseBoardingPass('15AUG26\nAF123\nCDG\nLHR\n10:00\n09:50', {
    airports: { CDG: { zone: 'Europe/Paris' }, LHR: { zone: 'Europe/London' } },
  })!
  expect(seg.arrive?.local).toBe('2026-08-15T09:50')
  expect(seg.arrive?.utc).toBe('2026-08-15T08:50:00.000Z')
})

test('a boarding-pass seat belongs to its labelled seat field', () => {
  const currentSeat = 'Previous flight\nSeat\n12A\nCurrent flight\n15AUG26\nLH510\nEZE\nBER\n14:25\n06:40+1\nSeat\n22J'
  expect(parseBoardingPass(currentSeat)?.seat).toBe('22J')
  expect(parseBoardingPass(`Previous flight\nSeat\n12A\nCurrent flight\n${BOARDING_BASE}`)?.seat).toBeUndefined()

  const noSeat = `${BOARDING_BASE}\nSeat\nNot assigned\nGate\n12A`
  expect(parseBoardingPass(noSeat)?.seat).toBeUndefined()
  expect(parseBoardingPass(`${BOARDING_BASE}\nSeat\n22L`)?.seat).toBe('22L')
  expect(parseBoardingPass(`${BOARDING_BASE}\nSeat:\n22J`)?.seat).toBe('22J')
})

test('a stated check-in window is read; an unstated one stays unstated', () => {
  expect(parseCheckInHours('Online check-in opens 48 hours before departure.')).toBe(48)
  expect(parseCheckInHours('Check-in is available 30h before your flight')).toBe(30)
  expect(parseCheckInHours('Check in at the airport.')).toBeUndefined()
  const frag = parseBookingEmail(
    'Booking reference: ABC12D\nFlight LH510 EZE → BER 2026-10-02 14:35 06:10\nOnline check-in opens 36 hours before departure.',
    { airports: AIRPORTS },
  )
  expect((frag.segments[0] as FlightSegment).checkInOpensHours).toBe(36)
})

test('a free-cancellation date with no time of day means the end of that day', () => {
  const t = parseFreeCancellation('Free cancellation until 3 Oct 2026', { zone: 'Europe/Berlin' })
  expect(t?.local).toBe('2026-10-03T23:59')
  expect(t?.utc).toBe('2026-10-03T21:59:00.000Z')
})

test('the airport counter’s hours are not the online check-in window', () => {
  expect(parseCheckInHours('Airport check-in opens 3 hours before departure.')).toBeUndefined()
  expect(parseCheckInHours('Check-in at the counter is available 2 hours before.')).toBeUndefined()
  expect(parseCheckInHours('Airport check-in closes early. Web check-in opens 30 hours before departure.')).toBe(30)
  expect(parseCheckInHours('Online check-in opens 48 hours before; airport desks open 3 hours before.')).toBe(48)
})
