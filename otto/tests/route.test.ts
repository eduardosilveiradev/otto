import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { route, offerRouteReminder, routeReminderTap, routesKey } from '../travelroute.ts'

const now = Date.parse('2026-11-10T12:00:00Z')
const input = { from: '10 Example Lane, Testville', to: '20 Fiction Square, Testville', arrive_by: '2026-11-10T17:00:00+01:00' }
const fixture = { routes: [{ duration: '1800s', legs: [{ steps: [
  { travelMode: 'WALK', staticDuration: '300s', navigationInstruction: { instructions: 'Walk to Example Stop' } },
  { travelMode: 'TRANSIT', staticDuration: '1200s', transitDetails: { transitLine: { name: 'Example Metro', nameShort: 'M7' }, stopCount: 4, stopDetails: { departureTime: '2026-11-10T15:30:00Z', arrivalTime: '2026-11-10T15:50:00Z', departureStop: { name: 'Example Stop' }, arrivalStop: { name: 'Fiction Stop' } } } },
  { travelMode: 'WALK', staticDuration: '300s' },
] }] }] }
const stub = (value: unknown, status = 200) => (async () => Response.json(value, { status })) as typeof fetch

describe('routing', () => {
  test('missing setup never calls provider or guesses', async () => {
    const r = await route(input, { key: '', fetch: (() => { throw Error('must not fetch') }) as typeof fetch })
    expect(r.options).toEqual([])
    expect(r.summary).toContain("isn't set up")
  })
  test('sends transit deadline and maps walking access, line, stops and UTC times', async () => {
    let body: any, headers: any
    const r = await route(input, { key: 'fixture-key', now, fetch: (async (_url, init) => {
      body = JSON.parse(String(init?.body)); headers = init?.headers
      return Response.json(fixture)
    }) as typeof fetch })
    expect(body).toMatchObject({ travelMode: 'TRANSIT', arrivalTime: '2026-11-10T16:00:00.000Z', computeAlternativeRoutes: true, origin: { address: input.from } })
    expect(body.departureTime).toBeUndefined()
    expect(headers['X-Goog-Api-Key']).toBe('fixture-key')
    expect(r.options[0]).toMatchObject({ depart: '2026-11-10T15:25:00.000Z', arrive: '2026-11-10T15:55:00.000Z', duration_minutes: 30, reminder: { at: '2026-11-10T15:20:00.000Z' } })
    expect(r.options[0].legs[1]).toMatchObject({ line: 'M7', from_stop: 'Example Stop', to_stop: 'Fiction Stop', stops: 4 })
    expect(r.options[0].summary).toContain('UTC')
    expect(r.options[0].summary).toContain('Arrives by the deadline')
  })
  test('uses boarding and arrival timestamps across midnight rather than assuming a clock date', async () => {
    const overnight = structuredClone(fixture)
    overnight.routes[0].legs[0].steps[1].transitDetails!.stopDetails.departureTime = '2026-11-10T23:58:00+01:00'
    overnight.routes[0].legs[0].steps[1].transitDetails!.stopDetails.arrivalTime = '2026-11-11T00:08:00+01:00'
    const r = await route({ ...input, arrive_by: '2026-11-11T00:30:00+01:00' }, { key: 'fixture', now, fetch: stub(overnight) })
    expect(r.options[0]).toMatchObject({ depart: '2026-11-10T22:53:00.000Z', arrive: '2026-11-10T23:13:00.000Z', duration_minutes: 20 })
  })
  test('rejects ambiguous times, conflicting times and unsupported arrival modes', async () => {
    for (const value of [{ ...input, depart_at: '2026-11-10T12:00:00Z' }, { ...input, arrive_by: '17:00' }, { ...input, mode: 'drive' as const }]) {
      await expect(route(value, { key: 'fixture', fetch: stub(fixture) })).rejects.toThrow()
    }
  })
  test('walk and drive estimates use requested departure', async () => {
    for (const mode of ['walk', 'drive'] as const) {
      const r = await route({ from: input.from, to: input.to, mode, depart_at: '2026-11-10T16:00:00+01:00' }, { key: 'fixture', now, fetch: stub({ routes: [{ duration: '600s', legs: [{ steps: [{ travelMode: mode.toUpperCase(), staticDuration: '600s' }] }] }] }) })
      expect(r.options[0].depart).toBe('2026-11-10T15:00:00.000Z')
      expect(r.options[0].arrive).toBe('2026-11-10T15:10:00.000Z')
    }
  })
  test('no routes, malformed routes, HTTP failure and network errors never guess', async () => {
    for (const fetch of [stub({}), stub({ routes: [{ duration: 'nonsense' }] }), stub({}, 403), (async () => { throw Error('offline fixture-key') }) as typeof fetch]) {
      const r = await route(input, { key: 'fixture-key', now, fetch })
      expect(r.options).toEqual([])
      expect(r.summary).not.toContain('fixture-key')
    }
  })
  test('limits alternatives and omits already due reminder', async () => {
    const r = await route(input, { key: 'fixture', now: Date.parse('2026-11-10T15:21:00Z'), fetch: stub({ routes: Array(4).fill(fixture.routes[0]) }) })
    expect(r.options).toHaveLength(3)
    expect(r.options[0].reminder).toBeUndefined()
  })
  test('states missed deadlines and departures that have already passed', async () => {
    const missed = await route({ ...input, arrive_by: '2026-11-10T15:40:00Z' }, { key: 'fixture', now, fetch: stub(fixture) })
    expect(missed.options[0].summary).toContain('Misses the deadline')
    const past = await route(input, { key: 'fixture', now: Date.parse('2026-11-10T15:26:00Z'), fetch: stub(fixture) })
    expect(past.options[0].summary).toContain('Departure has passed')
    expect(past.options[0].reminder).toBeUndefined()
  })
  test('persistent button arms an exact one-shot, survives reread and expires', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-test-')), file = join(dir, 'offers.json')
    try {
      const r = await route(input, { key: 'fixture', now, fetch: stub(fixture) })
      const button = offerRouteReminder(r.options[0], file, now)!
      expect(Buffer.byteLength(button.data)).toBeLessThanOrEqual(60)
      expect(button.label).toBe('remind me 15:20 UTC')
      const t = routeReminderTap(button.data, file, now)!
      expect(t).toMatchObject({ type: 'cron', repeating: false, enabled: true, schedule: '2026-11-10T15:20:00.000Z' })
      expect(t.action).toContain(r.options[0].summary)
      expect(routeReminderTap(button.data, file, now)).toEqual(t)
      expect(routeReminderTap(button.data, file, Date.parse(t.schedule))).toBeNull()
      expect(routeReminderTap('ordinary button', file, now)).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test('reads key from machine-local env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-env-'))
    const oldDir = process.env.OTTO_STATE_DIR, oldKey = process.env.ROUTES_API_KEY
    try {
      process.env.OTTO_STATE_DIR = dir; delete process.env.ROUTES_API_KEY
      writeFileSync(join(dir, '.env'), 'ROUTES_API_KEY="test-key"\n')
      expect(routesKey()).toBe('test-key')
    } finally {
      if (oldDir === undefined) delete process.env.OTTO_STATE_DIR; else process.env.OTTO_STATE_DIR = oldDir
      if (oldKey === undefined) delete process.env.ROUTES_API_KEY; else process.env.ROUTES_API_KEY = oldKey
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
