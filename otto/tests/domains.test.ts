import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  checkDomains, normalizeDomain, stageFor, rdapExpiration, lookupRegistration, formatAlert, groupAlerts,
  domainStatus, loadDomains, saveDomains, peekDomains, type DomainsState, type DomainDeps,
} from '../domains.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-domains-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const DAY = 24 * 60 * 60_000
const T0 = Date.parse('2026-10-13T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

const rdap = (expiry: string | undefined, status = 200) =>
  new Response(JSON.stringify({
    objectClassName: 'domain',
    events: [
      { eventAction: 'registration', eventDate: '2015-01-01T00:00:00Z' },
      ...(expiry ? [{ eventAction: 'expiration', eventDate: expiry }] : []),
    ],
  }), { status })

/** Deps with fixed expiries; either side can be swapped for a failure. */
function deps(now: number, o: { tls?: number | Error; reg?: number | Error } = {}): DomainDeps & { urls: string[] } {
  const urls: string[] = []
  return {
    now,
    urls,
    tls: async () => {
      const v = o.tls ?? now + 300 * DAY
      if (v instanceof Error) throw v
      return iso(v)
    },
    fetch: async url => {
      urls.push(url)
      const v = o.reg ?? now + 300 * DAY
      if (v instanceof Error) throw v
      return rdap(iso(v))
    },
  }
}

const fresh = (): DomainsState => ({ domains: {} })

test('normalizeDomain accepts hostnames however they are written, and nothing else', () => {
  expect(normalizeDomain('Example.COM')).toBe('example.com')
  expect(normalizeDomain('https://www.example.com/path?q=1')).toBe('www.example.com')
  expect(normalizeDomain('example.com.')).toBe('example.com')
  expect(normalizeDomain('  example.co.uk ')).toBe('example.co.uk')
  expect(normalizeDomain('localhost')).toBeUndefined()
  expect(normalizeDomain('10.0.0.1')).toBeUndefined()
  expect(normalizeDomain('not a domain')).toBeUndefined()
  expect(normalizeDomain('')).toBeUndefined()
})

test('stageFor draws the three lines', () => {
  expect(stageFor(T0 + 31 * DAY, T0)).toBeUndefined()
  expect(stageFor(T0 + 30 * DAY, T0)).toBe('30d')
  expect(stageFor(T0 + 8 * DAY, T0)).toBe('30d')
  expect(stageFor(T0 + 7 * DAY, T0)).toBe('7d')
  expect(stageFor(T0 + 1, T0)).toBe('7d')
  expect(stageFor(T0, T0)).toBe('expired')
  expect(stageFor(T0 - DAY, T0)).toBe('expired')
})

test('rdapExpiration reads the expiration event and ignores the others', () => {
  expect(rdapExpiration({ events: [{ eventAction: 'expiration', eventDate: '2027-03-01T12:00:00Z' }] })).toBe('2027-03-01T12:00:00.000Z')
  expect(rdapExpiration({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }] })).toBeUndefined()
  expect(rdapExpiration({})).toBeUndefined()
  expect(rdapExpiration(null)).toBeUndefined()
})

test('nothing near expiry is silent, and both lookups are recorded', async () => {
  const s = fresh()
  const { alerts } = await checkDomains(['example.com'], s, deps(T0))
  expect(alerts).toEqual([])
  expect(s.domains['example.com'].tls?.expiresAt).toBe(iso(T0 + 300 * DAY))
  expect(s.domains['example.com'].registration?.expiresAt).toBe(iso(T0 + 300 * DAY))
  expect(s.lastRunAt).toBe(iso(T0))
})

test('30 days, 7 days and expired each fire once, at the right priority', async () => {
  const expiry = T0 + 30 * DAY
  const s = fresh()
  const run = async (now: number) => (await checkDomains(['example.com'], s, deps(now, { tls: expiry }))).alerts

  const a30 = await run(T0)
  expect(a30).toHaveLength(1)
  expect(a30[0]).toMatchObject({ domain: 'example.com', kind: 'tls', stage: '30d', priority: 'normal', days: 30 })

  // Every day after, until the next line, says nothing.
  for (let d = 1; d < 23; d++) expect(await run(T0 + d * DAY)).toEqual([])

  const a7 = await run(T0 + 23 * DAY)
  expect(a7).toHaveLength(1)
  expect(a7[0]).toMatchObject({ stage: '7d', priority: 'urgent', days: 7 })
  for (let d = 24; d < 30; d++) expect(await run(T0 + d * DAY)).toEqual([])

  const ax = await run(T0 + 30 * DAY)
  expect(ax).toHaveLength(1)
  expect(ax[0]).toMatchObject({ stage: 'expired', priority: 'urgent' })
  for (let d = 31; d < 40; d++) expect(await run(T0 + d * DAY)).toEqual([])
})

test('first seen inside a line: only the deepest warning, not a backlog', async () => {
  const s = fresh()
  const { alerts } = await checkDomains(['example.com'], s, deps(T0, { reg: T0 + 5 * DAY }))
  expect(alerts.map(a => [a.kind, a.stage])).toEqual([['registration', '7d']])
})

test('a renewal resets the warnings: the new expiry date gets its own three', async () => {
  const s = fresh()
  const first = T0 + 20 * DAY
  expect((await checkDomains(['example.com'], s, deps(T0, { tls: first }))).alerts).toHaveLength(1)

  // Renewed a year out: silent now…
  const renewed = first + 365 * DAY
  expect((await checkDomains(['example.com'], s, deps(T0 + DAY, { tls: renewed }))).alerts).toEqual([])
  expect(s.domains['example.com'].tls?.expiresAt).toBe(iso(renewed))

  // …and warns again, once, when the renewed date comes round.
  const later = renewed - 30 * DAY
  const again = (await checkDomains(['example.com'], s, deps(later, { tls: renewed }))).alerts
  expect(again).toHaveLength(1)
  expect(again[0]).toMatchObject({ stage: '30d', expiresAt: iso(renewed) })
  expect((await checkDomains(['example.com'], s, deps(later + DAY, { tls: renewed }))).alerts).toEqual([])

  // The old date's keys are long gone by then.
  expect(s.domains['example.com'].alerted.every(k => k.includes(iso(renewed).slice(0, 10)))).toBe(true)
})

test('two certificates flapping between edges cannot repeat a warning', async () => {
  const s = fresh()
  const a = T0 + 20 * DAY
  const b = T0 + 25 * DAY
  const seen: number[] = []
  for (let d = 0; d < 6; d++) {
    const r = await checkDomains(['example.com'], s, deps(T0 + d * DAY, { tls: d % 2 ? b : a }))
    seen.push(r.alerts.length)
  }
  // One 30-day warning per expiry date, and then quiet.
  expect(seen).toEqual([1, 1, 0, 0, 0, 0])
})

test('a failed lookup is recorded, never alerted, and retried next run', async () => {
  const s = fresh()
  // Day one: both work; registration is 40 days out, outside every line.
  await checkDomains(['example.com'], s, deps(T0, { reg: T0 + 40 * DAY }))
  const before = s.domains['example.com'].registration!

  // Ten days later the registry is unreachable. The last-known date has crossed
  // the 30-day line, but a stale date is not evidence — no warning.
  const failed = await checkDomains(['example.com'], s, deps(T0 + 10 * DAY, { reg: new Error('fetch failed') }))
  expect(failed.alerts).toEqual([])
  const reg = s.domains['example.com'].registration!
  expect(reg.error).toContain('fetch failed')
  expect(reg.expiresAt).toBe(before.expiresAt)
  expect(reg.okAt).toBe(before.okAt)
  expect(reg.checkedAt).toBe(iso(T0 + 10 * DAY))

  // The TLS side of the same domain is unaffected by the registry failing.
  expect(s.domains['example.com'].tls?.error).toBeUndefined()

  // Next day it answers: the error clears and the warning goes out then.
  const ok = await checkDomains(['example.com'], s, deps(T0 + 11 * DAY, { reg: T0 + 40 * DAY }))
  expect(ok.alerts.map(a => a.stage)).toEqual(['30d'])
  expect(s.domains['example.com'].registration?.error).toBeUndefined()
})

test('a TLS failure with nothing ever known records only the error', async () => {
  const s = fresh()
  const r = await checkDomains(['example.com'], s, deps(T0, { tls: new Error('tls example.com: connect ECONNREFUSED') }))
  expect(r.alerts).toEqual([])
  expect(s.domains['example.com'].tls).toEqual({ checkedAt: iso(T0), error: 'tls example.com: connect ECONNREFUSED' })
})

test('RDAP: a subdomain walks up to its registered name; HTTP errors and missing dates are failures', async () => {
  const urls: string[] = []
  const f: DomainDeps['fetch'] = async url => {
    urls.push(url)
    return url.endsWith('/example.com') ? rdap('2027-01-01T00:00:00Z') : new Response('{}', { status: 404 })
  }
  expect(await lookupRegistration('www.shop.example.com', f)).toBe('2027-01-01T00:00:00.000Z')
  expect(urls).toEqual([
    'https://rdap.org/domain/www.shop.example.com',
    'https://rdap.org/domain/shop.example.com',
    'https://rdap.org/domain/example.com',
  ])

  await expect(lookupRegistration('missing.com', async () => new Response('{}', { status: 404 }))).rejects.toThrow('HTTP 404')
  await expect(lookupRegistration('example.com', async () => new Response('', { status: 503 }))).rejects.toThrow('HTTP 503')
  await expect(lookupRegistration('example.de', async () => rdap(undefined))).rejects.toThrow('no expiration date')
})

test('invalid entries are reported, duplicates collapse, removed domains drop their state', async () => {
  const s = fresh()
  const d = deps(T0)
  const r = await checkDomains(['example.com', 'EXAMPLE.com', 'https://example.org/', 'nope'], s, d)
  expect(r.invalid).toEqual(['nope'])
  expect(Object.keys(s.domains).sort()).toEqual(['example.com', 'example.org'])
  expect(d.urls).toHaveLength(2)

  await checkDomains(['example.org'], s, deps(T0 + DAY))
  expect(Object.keys(s.domains)).toEqual(['example.org'])
})

test('messages carry the date with its zone, and split by priority', () => {
  const base = { domain: 'example.com', expiresAt: '2026-11-12T08:00:00.000Z' }
  expect(formatAlert({ ...base, kind: 'tls', stage: '30d', days: 30, priority: 'normal' }))
    .toBe('example.com: TLS certificate expires in 30 days (2026-11-12 UTC).')
  expect(formatAlert({ ...base, kind: 'registration', stage: '7d', days: 1, priority: 'urgent' }))
    .toBe('example.com: domain registration expires in 1 day (2026-11-12 UTC). Renew at the registrar.')
  expect(formatAlert({ ...base, kind: 'tls', stage: '7d', days: 0, priority: 'urgent' })).toContain('expires today')
  expect(formatAlert({ ...base, kind: 'tls', stage: 'expired', days: -2, priority: 'urgent' }))
    .toBe('example.com: TLS certificate expired 2026-11-12 UTC.')

  const groups = groupAlerts([
    { ...base, kind: 'tls', stage: '30d', days: 30, priority: 'normal' },
    { ...base, domain: 'example.org', kind: 'tls', stage: '7d', days: 6, priority: 'urgent' },
    { ...base, domain: 'example.net', kind: 'registration', stage: '30d', days: 20, priority: 'normal' },
  ])
  expect(groups.map(g => g.urgent)).toEqual([true, false])
  expect(groups[1].text.split('\n')).toHaveLength(2)
  expect(groupAlerts([])).toEqual([])
})

test('status: off, unknown, up with the soonest expiry, degraded on failure or staleness', async () => {
  expect(domainStatus(undefined, fresh(), T0).verdict).toBe('off')
  expect(domainStatus([], fresh(), T0).verdict).toBe('off')
  expect(domainStatus(['example.com'], fresh(), T0).verdict).toBe('unknown')

  const s = fresh()
  await checkDomains(['example.com', 'example.org'], s, deps(T0, { tls: T0 + 45 * DAY }))
  const up = domainStatus(['example.com', 'example.org'], s, T0)
  expect(up.verdict).toBe('up')
  expect(up.at).toBe(T0)
  expect(up.detail).toContain('2 domain(s)')
  expect(up.detail).toContain(`tls ${iso(T0 + 45 * DAY).slice(0, 10)} UTC (45 d)`)

  await checkDomains(['example.com', 'example.org'], s, deps(T0 + DAY, { reg: new Error('rdap example.com: HTTP 503') }))
  const bad = domainStatus(['example.com', 'example.org'], s, T0 + DAY)
  expect(bad.verdict).toBe('degraded')
  expect(bad.detail).toContain('retried tomorrow')
  expect(bad.detail).toContain('example.com registration: rdap example.com: HTTP 503')

  const s2 = fresh()
  await checkDomains(['example.com'], s2, deps(T0))
  expect(domainStatus(['example.com'], s2, T0 + 3 * DAY).verdict).toBe('degraded')
})

test('store: round-trips 0600, a corrupt file is moved aside, peek leaves it alone', () => {
  const dir = mkdtempSync(join(tmp, 'store-'))
  const file = join(dir, 'domains.json')
  expect(loadDomains(file)).toEqual({ domains: {} })

  const s: DomainsState = { lastRunAt: iso(T0), domains: { 'example.com': { alerted: ['tls:2026-11-12:30d'] } } }
  saveDomains(file, s)
  expect(loadDomains(file)).toEqual(s)
  expect(existsSync(file + '.tmp')).toBe(false)

  writeFileSync(file, '{not json')
  expect(peekDomains(file)).toEqual({ domains: {} })
  expect(existsSync(file)).toBe(true)
  expect(loadDomains(file)).toEqual({ domains: {} })
  expect(existsSync(file)).toBe(false)
  expect(readdirSync(dir).some(f => f.startsWith('domains.json.corrupt-'))).toBe(true)
})
