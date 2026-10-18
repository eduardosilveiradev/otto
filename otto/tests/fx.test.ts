import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseEcbXml, convert, annotate, annotator, rateDateLabel, homeCurrency,
  refreshFx, loadFx, ECB_URL, DEFAULT_HOME, type FxRates,
} from '../fx.ts'
import { recordMoney, totalsByCurrency, formatTotals, formatRecord, type MoneyRecord } from '../money.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-fx-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const XML = readFileSync(join(import.meta.dir, 'fixtures', 'fx', 'eurofxref-daily.xml'), 'utf8')
const RATES = parseEcbXml(XML)!

let n = 0
const cacheFile = () => join(tmp, `fx-${++n}.json`)

/** A fetch that never touches the network and counts its calls. */
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: string[] = []
  const fn = async (url: string) => { calls.push(url); return respond() }
  return { fn, calls }
}
const ok = () => new Response(XML, { status: 200 })
const offline = () => { throw new TypeError('fetch failed') }

const DAY1 = Date.parse('2026-10-09T17:00:00Z')
const DAY2 = Date.parse('2026-10-12T09:00:00Z')

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('the ECB daily file parses into a dated EUR-based table', () => {
  expect(RATES.date).toBe('2026-10-09')
  expect(RATES.rates).toEqual({ EUR: 1, USD: 1.09, JPY: 162.5, GBP: 0.845, CHF: 0.94, BRL: 6.1856 })
})

test('double quotes parse the same as single quotes', () => {
  const r = parseEcbXml(`<Cube><Cube time="2026-10-09"><Cube currency="USD" rate="1.09"/></Cube></Cube>`)
  expect(r).toEqual({ date: '2026-10-09', rates: { EUR: 1, USD: 1.09 } })
})

test('a page with no date or no rates is undefined, not an empty table', () => {
  expect(parseEcbXml('<html><body>Sign in to the Wi-Fi</body></html>')).toBeUndefined()
  expect(parseEcbXml(`<Cube time='2026-10-09'></Cube>`)).toBeUndefined()
  expect(parseEcbXml(`<Cube currency='USD' rate='1.09'/>`)).toBeUndefined()
  expect(parseEcbXml('')).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

test('into EUR and back out of it', () => {
  // R$ 120,00 is 12000 centavos → €19.40.
  expect(convert(12000, 'BRL', 'EUR', RATES)).toBe(1940)
  expect(convert(1940, 'EUR', 'BRL', RATES)).toBe(12000)
  expect(convert(10000, 'EUR', 'USD', RATES)).toBe(10900)
  expect(convert(10900, 'USD', 'EUR', RATES)).toBe(10000)
})

test('cross rates go through EUR', () => {
  // $100 → €91.7431… → R$567.486… = 56749 centavos.
  expect(convert(10000, 'USD', 'BRL', RATES)).toBe(56749)
  expect(convert(56749, 'BRL', 'USD', RATES)).toBe(10000)
  // £84.50 is €100 is $109.
  expect(convert(8450, 'GBP', 'USD', RATES)).toBe(10900)
})

test('minor units are each currency\'s own: the yen has none', () => {
  // ¥1,500 is 1500 minor units, not 15.00.
  expect(convert(1500, 'JPY', 'EUR', RATES)).toBe(923)
  expect(convert(1000, 'EUR', 'JPY', RATES)).toBe(1625)
  expect(convert(1500, 'JPY', 'USD', RATES)).toBe(1006)
  expect(convert(10900, 'USD', 'JPY', RATES)).toBe(16250)
})

test('the same currency is the identity, and a missing rate is undefined', () => {
  expect(convert(12345, 'brl', 'BRL', RATES)).toBe(12345)
  expect(convert(12345, 'BRL', 'BRL', undefined)).toBe(12345)
  expect(convert(1000, 'ARS', 'EUR', RATES)).toBeUndefined()
  expect(convert(1000, 'EUR', 'ARS', RATES)).toBeUndefined()
  expect(convert(1000, 'BRL', 'EUR', undefined)).toBeUndefined()
  expect(convert(Number.NaN, 'BRL', 'EUR', RATES)).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Annotation
// ---------------------------------------------------------------------------

test('a foreign amount gets its approximate home figure and the rate date', () => {
  expect(annotate(12000, 'BRL', 'EUR', RATES)).toBe('(≈ €19.40, ECB 9 Oct)')
  expect(annotate(1500, 'JPY', 'EUR', RATES)).toBe('(≈ €9.23, ECB 9 Oct)')
  expect(annotate(1000, 'EUR', 'JPY', RATES)).toBe('(≈ JP¥1,625, ECB 9 Oct)')
  expect(annotate(10000, 'USD', 'BRL', RATES)).toBe('(≈ R$567.49, ECB 9 Oct)')
})

test('no annotation in the home currency, with no rates, or for an unknown currency', () => {
  expect(annotate(1940, 'EUR', 'EUR', RATES)).toBe('')
  expect(annotate(1940, 'eur', 'EUR', RATES)).toBe('')
  expect(annotate(12000, 'BRL', 'EUR', undefined)).toBe('')
  expect(annotate(12000, 'ARS', 'EUR', RATES)).toBe('')
})

test('the major-unit annotator matches the minor-unit one', () => {
  const fx = annotator('EUR', RATES)
  expect(fx(120, 'BRL')).toBe(annotate(12000, 'BRL', 'EUR', RATES))
  expect(fx(1500, 'JPY')).toBe(annotate(1500, 'JPY', 'EUR', RATES))
  expect(fx(19.4, 'EUR')).toBe('')
})

test('the rate date reads off the string', () => {
  expect(rateDateLabel('2026-10-09')).toBe('9 Oct')
  expect(rateDateLabel('2026-01-31')).toBe('31 Jan')
  expect(rateDateLabel('garbage')).toBe('garbage')
})

test('home currency comes from money.home, falling back to EUR', () => {
  expect(DEFAULT_HOME).toBe('EUR')
  expect(homeCurrency(undefined)).toBe('EUR')
  expect(homeCurrency({})).toBe('EUR')
  expect(homeCurrency({ home: 'brl' })).toBe('BRL')
  expect(homeCurrency({ home: ' USD ' })).toBe('USD')
  expect(homeCurrency({ home: 'euros' })).toBe('EUR')
  expect(homeCurrency({ home: 42 })).toBe('EUR')
})

// ---------------------------------------------------------------------------
// Totals stay per currency
// ---------------------------------------------------------------------------

function seed(): MoneyRecord[] {
  const rs: MoneyRecord[] = []
  recordMoney(rs, { merchant: 'Padaria', amount: 100, currency: 'BRL', date: '2026-10-03' })
  recordMoney(rs, { merchant: 'Mercado', amount: 20, currency: 'BRL', date: '2026-10-04' })
  recordMoney(rs, { merchant: 'Coop', amount: 15.1, currency: 'EUR', date: '2026-10-05' })
  recordMoney(rs, { merchant: 'Konbini', amount: 1500, currency: 'JPY', date: '2026-10-06' })
  return rs
}

test('each currency total carries its own annotation and nothing is added together', () => {
  const text = formatTotals(totalsByCurrency(seed()), annotator('EUR', RATES))
  expect(text).toBe('R$120.00 (≈ €19.40, ECB 9 Oct) (2) · €15.10 (1) · JP¥1,500 (≈ €9.23, ECB 9 Oct) (1)')
  // No grand total: €19.40 + €15.10 + €9.23 = €43.73 must not appear anywhere.
  expect(text).not.toContain('43.73')
})

test('a record shows its annotation beside the amount as charged', () => {
  const r = seed()[0]
  expect(formatRecord(r, annotator('EUR', RATES))).toBe('2026-10-03 · R$100.00 (≈ €16.17, ECB 9 Oct) · Padaria')
  expect(formatRecord(r)).toBe('2026-10-03 · R$100.00 · Padaria')
  expect(formatRecord(r, annotator('BRL', RATES))).toBe('2026-10-03 · R$100.00 · Padaria')
})

// ---------------------------------------------------------------------------
// Cache and refresh — no network anywhere
// ---------------------------------------------------------------------------

test('a first fetch caches the rates with their date', async () => {
  const file = cacheFile()
  const f = fakeFetch(ok)
  const r = await refreshFx({ file, fetch: f.fn, now: DAY1 })
  expect(f.calls).toEqual([ECB_URL])
  expect(r).toEqual({ rates: RATES, stale: false })
  expect(loadFx(file)).toMatchObject({ date: '2026-10-09', rates: RATES.rates, fetchedAt: new Date(DAY1).toISOString() })
})

test('at most one fetch a day', async () => {
  const file = cacheFile()
  const f = fakeFetch(ok)
  await refreshFx({ file, fetch: f.fn, now: DAY1 })
  const again = await refreshFx({ file, fetch: f.fn, now: DAY1 + 3 * 3600_000 })
  expect(f.calls).toHaveLength(1)
  expect(again).toEqual({ rates: RATES, stale: false })
  await refreshFx({ file, fetch: f.fn, now: DAY2 })
  expect(f.calls).toHaveLength(2)
})

test('offline, the last cache is kept, flagged stale and labelled with its own date', async () => {
  const file = cacheFile()
  await refreshFx({ file, fetch: fakeFetch(ok).fn, now: DAY1 })
  const r = await refreshFx({ file, fetch: fakeFetch(offline).fn, now: DAY2 })
  expect(r.stale).toBe(true)
  expect(r.error).toBe('fetch failed')
  expect(r.rates?.date).toBe('2026-10-09')
  // Three days on, the label still says the 9th — not today.
  expect(annotate(12000, 'BRL', 'EUR', r.rates)).toBe('(≈ €19.40, ECB 9 Oct)')
  expect(loadFx(file)?.fetchedAt).toBe(new Date(DAY1).toISOString())
})

test('a failed fetch waits an hour before the next try', async () => {
  const file = cacheFile()
  await refreshFx({ file, fetch: fakeFetch(ok).fn, now: DAY1 })
  const down = fakeFetch(offline)
  await refreshFx({ file, fetch: down.fn, now: DAY2 })
  const held = await refreshFx({ file, fetch: down.fn, now: DAY2 + 30 * 60_000 })
  expect(down.calls).toHaveLength(1)
  expect(held).toEqual({ rates: RATES, stale: true })
  await refreshFx({ file, fetch: down.fn, now: DAY2 + 61 * 60_000 })
  expect(down.calls).toHaveLength(2)
})

test('an HTTP error or a body with no rates never overwrites a good cache', async () => {
  const file = cacheFile()
  await refreshFx({ file, fetch: fakeFetch(ok).fn, now: DAY1 })
  const e503 = await refreshFx({ file, fetch: fakeFetch(() => new Response('down', { status: 503 })).fn, now: DAY2 })
  expect(e503).toMatchObject({ rates: RATES, stale: true, error: 'HTTP 503' })
  const portal = await refreshFx({
    file, fetch: fakeFetch(() => new Response('<html>log in</html>')).fn, now: DAY2 + 2 * 3600_000,
  })
  expect(portal).toMatchObject({ rates: RATES, stale: true, error: 'no rates in the response' })
  expect(loadFx(file)?.date).toBe('2026-10-09')
})

test('offline with no cache at all: no rates, so no annotation', async () => {
  const r = await refreshFx({ file: cacheFile(), fetch: fakeFetch(offline).fn, now: DAY1 })
  expect(r.rates).toBeUndefined()
  expect(r.stale).toBe(true)
  expect(annotate(12000, 'BRL', 'EUR', r.rates)).toBe('')
})

test('a corrupt cache reads as no cache and is replaced by the next good fetch', async () => {
  const file = cacheFile()
  writeFileSync(file, '{not json')
  expect(loadFx(file)).toBeUndefined()
  const r = await refreshFx({ file, fetch: fakeFetch(ok).fn, now: DAY1 })
  expect(r).toEqual({ rates: RATES, stale: false })
  expect(loadFx(file)?.date).toBe('2026-10-09')
})

test('the rates type round-trips through the cache unchanged', async () => {
  const file = cacheFile()
  await refreshFx({ file, fetch: fakeFetch(ok).fn, now: DAY1 })
  const cached = loadFx(file)!
  const back: FxRates = { date: cached.date, rates: cached.rates }
  expect(convert(12000, 'BRL', 'EUR', back)).toBe(1940)
})
