import { test, expect } from 'bun:test'

process.env.TZ = 'UTC'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveZoned, type Trip, type FlightSegment } from '../trips.ts'
import { airborne, dueLifecycleEvents, segmentKey, type FlightStatus } from '../triplife.ts'
import {
  fromAeroDataBox, aeroDataBox, pollDue, flightNotices, applyPoll, rollMonth, pruneFlights, flightsConfig,
  loadFlightsState, saveFlightsState, AERODATABOX_HOST, type FlightWatch, type FlightsState,
} from '../flightstatus.ts'

const H = 3_600_000
const M = 60_000
const at = (iso: string) => Date.parse(iso)
const CFG = { delayMinutes: 15 }

// LH510 EZE→BER: departs 14:35 Buenos Aires = 17:35Z, lands 06:10 Berlin = 04:10Z.
const seg: FlightSegment = {
  kind: 'flight', flight: 'LH510', carrier: 'LH', from: 'EZE', to: 'BER',
  depart: resolveZoned({ local: '2026-10-02T14:35', zone: 'America/Argentina/Buenos_Aires' }),
  arrive: resolveZoned({ local: '2026-10-03T06:10', zone: 'Europe/Berlin' }),
}
const DEP = at('2026-10-02T17:35:00Z')
const ARR = at('2026-10-03T04:10:00Z')

function makeTrip(): Trip {
  return { id: 't1', start: '2026-10-02', end: '2026-10-07', segments: [seg], pnrs: [], sources: [], updatedAt: '2026-09-01T00:00:00Z' }
}

const ITEMS = [
  { // a codeshare listed under another departure airport
    status: 'Expected',
    departure: { airport: { iata: 'LIS' }, quality: ['Basic'] },
    arrival: { airport: { iata: 'BER' } },
  },
  {
    status: 'Delayed', lastUpdatedUtc: '2026-10-02 15:00Z',
    departure: {
      airport: { iata: 'EZE' }, gate: 'B4', terminal: '3', quality: ['Basic', 'Live'],
      scheduledTime: { utc: '2026-10-02 17:35Z' }, revisedTime: { utc: '2026-10-02 18:20Z' },
    },
    arrival: { airport: { iata: 'BER' }, revisedTime: { utc: '2026-10-03 04:55Z' } },
  },
]
const withStatus = (status: string, extra: object = {}) => [{ ...ITEMS[1], status, ...extra }]

const st = (over: Partial<FlightStatus> = {}): FlightStatus => ({ state: 'scheduled', asOf: '2026-10-02T12:00:00Z', ...over })
const delayed = (min: number, over: Partial<FlightStatus> = {}) => st({ estimatedDepartUtc: new Date(DEP + min * M).toISOString(), ...over })

// ---------------------------------------------------------------------------

test('the matching leg is picked and its times normalized', () => {
  const s = fromAeroDataBox(ITEMS, seg)!
  expect(s.state).toBe('scheduled')
  expect(s.estimatedDepartUtc).toBe('2026-10-02T18:20Z')
  expect(s.estimatedArriveUtc).toBe('2026-10-03T04:55Z')
  expect(s.gate).toBe('B4')
  expect(s.terminal).toBe('3')
  expect(s.asOf).toBe('2026-10-02T15:00Z')
})

test('provider states map onto ours; a diversion names where it landed', () => {
  expect(fromAeroDataBox(withStatus('Canceled'), seg)!.state).toBe('cancelled')
  expect(fromAeroDataBox(withStatus('Arrived'), seg)!.state).toBe('landed')
  expect(fromAeroDataBox(withStatus('EnRoute'), seg)!.state).toBe('departed')
  expect(fromAeroDataBox(withStatus('GateClosed'), seg)!.state).toBe('boarding')
  const d = fromAeroDataBox(withStatus('Diverted', { arrival: { airport: { iata: 'LEJ' } } }), seg)!
  expect(d.state).toBe('diverted')
  expect(d.divertedTo).toBe('LEJ')
})

test('nothing usable is undefined, and an unparsable time is dropped', () => {
  expect(fromAeroDataBox([], seg)).toBeUndefined()
  expect(fromAeroDataBox({ not: 'an array' }, seg)).toBeUndefined()
  expect(fromAeroDataBox([ITEMS[0]], seg)).toBeUndefined()
  const bad = fromAeroDataBox([{ ...ITEMS[1], departure: { ...ITEMS[1].departure, revisedTime: { utc: 'soon' } } }], seg)!
  expect(bad.estimatedDepartUtc).toBeUndefined()
})

test('no key, no provider; with one the call carries both headers and the departure date', async () => {
  expect(aeroDataBox(undefined)).toBeUndefined()
  const calls: { url: string; headers: Record<string, string> }[] = []
  let status = 200
  const fake = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers })
    return new Response(JSON.stringify(ITEMS), { status })
  }) as unknown as typeof fetch
  const p = aeroDataBox('k', fake)!
  expect((await p.status(seg))?.gate).toBe('B4')
  expect(calls[0].url).toBe(`https://${AERODATABOX_HOST}/flights/Number/LH510/2026-10-02?dateLocalRole=Departure&withLocation=false`)
  expect(calls[0].headers['X-RapidAPI-Key']).toBe('k')
  expect(calls[0].headers['X-RapidAPI-Host']).toBe(AERODATABOX_HOST)
  status = 404
  expect(await p.status(seg)).toBeUndefined()
  status = 500
  await expect(p.status(seg)).rejects.toThrow()
})

// ---------------------------------------------------------------------------

const opts = { monthlyCalls: 150, monthCalls: 0 }
const watch = (polledMsBeforeDep: number, over: Partial<FlightWatch> = {}): FlightWatch =>
  ({ status: st(), polledAt: new Date(DEP - polledMsBeforeDep).toISOString(), calls: 1, told: [], ...over })

test('polling opens six hours out and is hourly until two hours out', () => {
  expect(pollDue(seg, undefined, DEP - 7 * H, opts)).toBe(false)
  expect(pollDue(seg, undefined, DEP - 5 * H, opts)).toBe(true)
  expect(pollDue(seg, watch(5 * H), DEP - 5 * H + 30 * M, opts)).toBe(false)
  expect(pollDue(seg, watch(5 * H), DEP - 4 * H, opts)).toBe(true)
})

test('polling tightens around departure and eases off in the air', () => {
  expect(pollDue(seg, watch(90 * M), DEP - 80 * M, opts)).toBe(false)
  expect(pollDue(seg, watch(100 * M), DEP - 80 * M, opts)).toBe(true) // inside 2 h the interval is 15 min
  expect(pollDue(seg, watch(90 * M), DEP - 70 * M, opts)).toBe(true)
  expect(pollDue(seg, watch(0), DEP + 20 * M, opts)).toBe(true)
  const up = { status: st({ state: 'departed' }) }
  expect(pollDue(seg, watch(-H, up), DEP + H + 30 * M, opts)).toBe(false)
  expect(pollDue(seg, watch(-H, up), DEP + H + 50 * M, opts)).toBe(true)
})

test('polling stops after landing, cancelling, the grace period, or a spent budget', () => {
  expect(pollDue(seg, watch(0, { status: st({ state: 'landed' }) }), DEP + 3 * H, opts)).toBe(false)
  expect(pollDue(seg, watch(0, { status: st({ state: 'cancelled' }) }), DEP - H, opts)).toBe(false)
  expect(pollDue(seg, undefined, ARR + 31 * M, opts)).toBe(false)
  expect(pollDue(seg, undefined, DEP - H, { ...opts, monthCalls: 150 })).toBe(false)
  expect(pollDue(seg, watch(H, { calls: 30 }), DEP, opts)).toBe(false)
  const noUtc: FlightSegment = { ...seg, depart: { local: '2026-10-02T14:35' } }
  expect(pollDue(noUtc, undefined, DEP, opts)).toBe(false)
})

// ---------------------------------------------------------------------------

test('a delay is told once, again only when it moves by another tolerance', () => {
  const told: string[] = []
  const n1 = flightNotices(seg, st(), delayed(45), told, CFG)
  expect(n1).toHaveLength(1)
  expect(n1[0].key).toBe('delay:45')
  expect(n1[0].urgent).toBe(true)
  expect(n1[0].text).toContain('+45m')
  expect(n1[0].text).toContain('America/Argentina/Buenos_Aires')
  expect(n1[0].text).toContain('15:20')
  told.push(n1[0].key)
  expect(flightNotices(seg, delayed(45), delayed(45), told, CFG)).toEqual([])
  expect(flightNotices(seg, delayed(45), delayed(50), told, CFG)).toEqual([])
  const n2 = flightNotices(seg, delayed(50), delayed(65), told, CFG)
  expect(n2.map(n => n.key)).toEqual(['delay:65'])
})

test('back under the tolerance is said once, then silence', () => {
  const told = ['delay:45']
  const n = flightNotices(seg, delayed(45), delayed(3), told, CFG)
  expect(n.map(x => x.key)).toEqual(['ontime'])
  told.push('ontime')
  expect(flightNotices(seg, delayed(3), delayed(2), told, CFG)).toEqual([])
  // A fresh slip after recovering counts from zero again.
  expect(flightNotices(seg, delayed(2), delayed(20), told, CFG).map(x => x.key)).toEqual(['delay:20'])
})

test('a gate change is told; a first assignment, or one after departure, is not', () => {
  const n = flightNotices(seg, st({ gate: 'B4' }), st({ gate: 'B12' }), [], CFG)
  expect(n.map(x => x.key)).toEqual(['gate:/B12'])
  expect(n[0].text).toContain('B12')
  expect(flightNotices(seg, st(), st({ gate: 'B4' }), [], CFG)).toEqual([])
  expect(flightNotices(seg, st({ gate: 'B4' }), st({ state: 'departed', gate: 'B12' }), [], CFG)).toEqual([])
})

test('cancelling is urgent, a diversion is not, each once', () => {
  const c = flightNotices(seg, st(), st({ state: 'cancelled' }), [], CFG)
  expect(c).toHaveLength(1)
  expect(c[0].urgent).toBe(true)
  expect(flightNotices(seg, st(), st({ state: 'cancelled' }), ['cancelled'], CFG)).toEqual([])
  const d = flightNotices(seg, st({ state: 'departed' }), st({ state: 'diverted', divertedTo: 'LEJ' }), [], CFG)
  expect(d.map(x => [x.key, x.urgent])).toEqual([['diverted:LEJ', false]])
  expect(d[0].text).toContain('LEJ')
  expect(flightNotices(seg, st(), st(), [], CFG)).toEqual([])
})

test('an unknown departure zone says only the delay', () => {
  const noZone: FlightSegment = { ...seg, depart: { local: seg.depart.local, utc: seg.depart.utc } }
  const [n] = flightNotices(noZone, st(), delayed(45), [], CFG)
  expect(n.text).toBe('LH510 EZE→BER: delayed (+45m)')
})

// ---------------------------------------------------------------------------

test('applyPoll keeps what was told, so the same news never repeats', () => {
  const state: FlightsState = { month: '', calls: 0, flights: {} }
  const now = DEP - 3 * H
  expect(applyPoll(state, seg, delayed(45), now, CFG)).toHaveLength(1)
  expect(applyPoll(state, seg, delayed(45), now + 15 * M, CFG)).toEqual([])
  const w = state.flights[segmentKey(seg)]
  expect(w.calls).toBe(2)
  expect(w.told).toEqual(['delay:45'])
  expect(w.polledAt).toBe(new Date(now + 15 * M).toISOString())
})

test('a miss is charged and timed like a hit, so it waits its interval', () => {
  const state: FlightsState = { month: '', calls: 0, flights: {} }
  const now = DEP - 5 * H
  expect(applyPoll(state, seg, undefined, now, CFG)).toEqual([])
  const w = state.flights[segmentKey(seg)]
  expect(w).toMatchObject({ calls: 1, told: [], polledAt: new Date(now).toISOString() })
  expect(w.status).toBeUndefined()
  expect(pollDue(seg, w, now + 5 * M, opts)).toBe(false)
  expect(pollDue(seg, w, now + H, opts)).toBe(true)
})

test('the month rolls over and flights no trip has are forgotten', () => {
  const state: FlightsState = { month: '2026-09', calls: 99, flights: { a: watch(0), b: watch(0) } }
  rollMonth(state, at('2026-10-02T00:00:00Z'))
  expect(state).toMatchObject({ month: '2026-10', calls: 0 })
  rollMonth(state, at('2026-10-30T00:00:00Z'))
  state.calls = 5
  rollMonth(state, at('2026-10-31T00:00:00Z'))
  expect(state.calls).toBe(5)
  expect(pruneFlights(state, ['a'])).toBe(true)
  expect(Object.keys(state.flights)).toEqual(['a'])
  expect(pruneFlights(state, ['a'])).toBe(false)
})

test('config falls back to the defaults for anything unusable', () => {
  expect(flightsConfig()).toEqual({ delayMinutes: 15, monthlyCalls: 150 })
  expect(flightsConfig({ flights: { delayMinutes: 30, monthlyCalls: 400 } })).toEqual({ delayMinutes: 30, monthlyCalls: 400 })
  expect(flightsConfig({ flights: { delayMinutes: 0, monthlyCalls: 'lots' } })).toEqual({ delayMinutes: 15, monthlyCalls: 150 })
})

test('flights.json round-trips and a missing file is empty', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'flights-')), 'flights.json')
  expect(loadFlightsState(file)).toEqual({ month: '', calls: 0, flights: {} })
  const state: FlightsState = { month: '2026-10', calls: 3, flights: { 'LH510@2026-10-02': watch(0) } }
  saveFlightsState(file, state)
  expect(loadFlightsState(file)).toEqual(state)
  writeFileSync(file, JSON.stringify({ month: '2026-10', calls: 1, flights: null }))
  expect(loadFlightsState(file)).toEqual({ month: '', calls: 0, flights: {} })
})

test('a provider estimate moves the in-flight hold, and a diversion is named on arrival', () => {
  const s = fromAeroDataBox(ITEMS, seg)!
  const map = new Map([[segmentKey(seg), s]])
  const on = airborne([makeTrip()], at('2026-10-03T04:20:00Z'), map)
  expect(on?.until).toBeGreaterThan(at('2026-10-03T04:55:00Z'))
  expect(airborne([makeTrip()], at('2026-10-03T04:20:00Z'))).toBeUndefined()

  const div = new Map([[segmentKey(seg), st({ state: 'diverted', divertedTo: 'LEJ', estimatedArriveUtc: '2026-10-03T04:10:00Z' })]])
  const a = dueLifecycleEvents([makeTrip()], at('2026-10-03T04:30:00Z'), { statuses: div }).find(e => e.kind === 'arrival')!
  expect(a.lines.join('\n')).toContain('DIVERTED: landed at LEJ, not BER')
})
