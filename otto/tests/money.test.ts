import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseDecimal, parseAmount, detectCurrency, toDateKey, recordMoney, queryMoney,
  totalsByCurrency, totalsByMonth, totalsByCategory, convertTotals, formatMoney,
  formatTotals, formatRecord, loadMoney, saveMoney, minorDigits,
  type MoneyRecord,
} from '../money.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-money-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

function seed(): MoneyRecord[] {
  const rs: MoneyRecord[] = []
  recordMoney(rs, { merchant: 'Corner Bakery', amount: 24.5, currency: 'BRL', date: '2026-07-03', category: 'food' })
  recordMoney(rs, { merchant: 'Uber', amount: 31.9, currency: 'BRL', date: '2026-07-04', category: 'transport' })
  recordMoney(rs, { merchant: 'Enel', amount: 84.2, currency: 'EUR', date: '2026-07-15', category: 'utilities' })
  recordMoney(rs, { merchant: 'Coop', amount: 15.1, currency: 'EUR', date: '2026-08-02', category: 'food' })
  return rs
}

test('both separators present: the rightmost is the decimal point', () => {
  expect(parseDecimal('1.234,56')).toBe(1234.56)
  expect(parseDecimal('1,234.56')).toBe(1234.56)
  expect(parseDecimal('1.234.567,89')).toBe(1234567.89)
})

test('a lone separator with two digits after it is a decimal point', () => {
  expect(parseDecimal('24,50')).toBe(24.5)
  expect(parseDecimal('24.50')).toBe(24.5)
})

// The factor-of-1000 bug: "1.234" on a Brazilian receipt is one thousand.
test('a lone separator with three digits after it is a thousands group', () => {
  expect(parseDecimal('1.234')).toBe(1234)
  expect(parseDecimal('1,234')).toBe(1234)
})

test('nonsense is undefined, not zero', () => {
  expect(parseDecimal('abc')).toBeUndefined()
  expect(parseDecimal('')).toBeUndefined()
})

test('amounts are read out of either continent\'s notation', () => {
  expect(parseAmount('Total: R$ 1.234,56')).toEqual({ amount: 1234.56, currency: 'BRL' })
  expect(parseAmount('Amount: € 84,20')).toEqual({ amount: 84.2, currency: 'EUR' })
  expect(parseAmount('Charged $1,234.56 to your card')).toEqual({ amount: 1234.56, currency: 'USD' })
  expect(parseAmount('45,00 €')).toEqual({ amount: 45, currency: 'EUR' })
  expect(parseAmount('EUR 45.00 due')).toEqual({ amount: 45, currency: 'EUR' })
})

test('R$ and US$ beat the bare dollar sign', () => {
  expect(detectCurrency('R$ 10')).toBe('BRL')
  expect(detectCurrency('US$ 10')).toBe('USD')
  expect(detectCurrency('$10')).toBe('USD')
  expect(detectCurrency('10 francs')).toBeUndefined()
})

test('an amount with no currency marker comes back without one', () => {
  expect(parseAmount('the total was 45,00 for the meal')).toBeUndefined()
  expect(parseAmount('nothing numeric here')).toBeUndefined()
})

test('a bare date is kept and a timestamp is resolved in the given zone', () => {
  expect(toDateKey('2026-07-03')).toBe('2026-07-03')
  // 01:30 UTC on the 4th is still the evening of the 3rd in Buenos Aires, and the
  // 3rd is the day the user means.
  expect(toDateKey('2026-07-04T01:30:00Z', 'America/Argentina/Buenos_Aires')).toBe('2026-07-03')
  expect(toDateKey('2026-07-04T01:30:00Z', 'Europe/Berlin')).toBe('2026-07-04')
  expect(toDateKey('not a date')).toBeUndefined()
})

test('a record without a real currency code is refused', () => {
  expect(() => recordMoney([], { merchant: 'x', amount: 1, currency: 'reais', date: '2026-07-01' }))
    .toThrow(/3-letter ISO code/)
  expect(() => recordMoney([], { merchant: '', amount: 1, currency: 'BRL', date: '2026-07-01' }))
    .toThrow(/merchant is required/)
  expect(() => recordMoney([], { merchant: 'x', amount: 1, currency: 'BRL', date: 'whenever' }))
    .toThrow(/date must be/)
})

// Every hourly scan re-reads the same inbox.
test('the same email recorded twice is one record', () => {
  const rs: MoneyRecord[] = []
  const a = recordMoney(rs, { merchant: 'Bank', amount: 12, currency: 'BRL', date: '2026-07-01', source: 'email:abc' })
  const b = recordMoney(rs, { merchant: 'Bank', amount: 12, currency: 'BRL', date: '2026-07-01', source: 'email:abc' })
  expect(a.created).toBe(true)
  expect(b.created).toBe(false)
  expect(rs).toHaveLength(1)
})

test('two identical charges on the same day can still both be recorded', () => {
  const rs: MoneyRecord[] = []
  recordMoney(rs, { merchant: 'Bar', amount: 4, currency: 'EUR', date: '2026-07-01' })
  expect(recordMoney(rs, { merchant: 'Bar', amount: 4, currency: 'EUR', date: '2026-07-01' }).created).toBe(false)
  expect(recordMoney(rs, { merchant: 'Bar', amount: 4, currency: 'EUR', date: '2026-07-01', note: 'second one' }).created).toBe(true)
  expect(rs).toHaveLength(2)
})

test('queries filter by month, currency, category and merchant', () => {
  const rs = seed()
  expect(queryMoney(rs, { month: '2026-07' })).toHaveLength(3)
  expect(queryMoney(rs, { currency: 'eur' })).toHaveLength(2)
  expect(queryMoney(rs, { category: 'FOOD' })).toHaveLength(2)
  expect(queryMoney(rs, { merchant: 'uber' })).toHaveLength(1)
  expect(queryMoney(rs, { from: '2026-08-01' })).toHaveLength(1)
})

test('results come back newest first', () => {
  expect(queryMoney(seed())[0].date).toBe('2026-08-02')
})

// The whole point of the two-country shape.
test('totals are per currency and never added together', () => {
  const totals = totalsByCurrency(seed())
  const byCur = Object.fromEntries(totals.map(t => [t.currency, t]))
  expect(byCur.BRL.total).toBeCloseTo(56.4, 10)
  expect(byCur.EUR.total).toBeCloseTo(99.3, 10)
  expect(totals).toHaveLength(2)
})

test('minor-unit arithmetic does not drift', () => {
  const rs: MoneyRecord[] = []
  for (let i = 0; i < 3; i++) recordMoney(rs, { merchant: `m${i}`, amount: 0.1, currency: 'EUR', date: '2026-07-01', note: String(i) })
  expect(totalsByCurrency(rs)[0].total).toBe(0.3)
})

test('zero-decimal currencies are not forced into cents', () => {
  expect(minorDigits('JPY')).toBe(0)
  const rs: MoneyRecord[] = []
  recordMoney(rs, { merchant: 'Ramen', amount: 1200, currency: 'JPY', date: '2026-07-01' })
  expect(totalsByCurrency(rs)[0].total).toBe(1200)
})

test('monthly totals keep the currencies apart within each month', () => {
  const months = totalsByMonth(seed())
  expect(months.map(m => m.month)).toEqual(['2026-08', '2026-07'])
  const july = months.find(m => m.month === '2026-07')!
  expect(july.totals.map(t => t.currency).sort()).toEqual(['BRL', 'EUR'])
})

test('category totals are per currency, biggest first', () => {
  const cats = totalsByCategory(seed(), 'BRL')
  expect(cats[0].category).toBe('transport')
  expect(cats.map(c => c.category)).not.toContain('utilities')
})

test('uncategorised spending is named, not hidden', () => {
  const rs: MoneyRecord[] = []
  recordMoney(rs, { merchant: 'x', amount: 9, currency: 'EUR', date: '2026-07-01' })
  expect(totalsByCategory(rs, 'EUR')[0].category).toBe('uncategorised')
})

// No rate is hardcoded anywhere, so a caller who wants one number must say
// what a real is worth today.
test('conversion uses the caller\'s rate and reports what it could not convert', () => {
  const totals = totalsByCurrency(seed())
  const converted = convertTotals(totals, { BRL: 0.16 }, 'EUR')
  expect(converted.target).toBe('EUR')
  expect(converted.missing).toEqual([])
  expect(converted.total).toBeCloseTo(99.3 + 56.4 * 0.16, 2)
})

test('a missing rate is named rather than silently dropped', () => {
  const totals = totalsByCurrency(seed())
  const converted = convertTotals(totals, {}, 'EUR')
  expect(converted.missing).toEqual(['BRL'])
  expect(converted.total).toBeCloseTo(99.3, 10)
})

test('rates can be keyed as a pair', () => {
  const totals = totalsByCurrency(seed())
  expect(convertTotals(totals, { 'BRL/EUR': 0.16 }, 'EUR').missing).toEqual([])
  expect(convertTotals(totals, { BRLEUR: 0.16 }, 'EUR').missing).toEqual([])
})

test('formatting keeps the currency visible', () => {
  expect(formatMoney(24.5, 'BRL')).toContain('24.50')
  expect(formatTotals(totalsByCurrency(seed()))).toContain('(2)')
  expect(formatTotals([])).toContain('nothing recorded')
  expect(formatRecord(seed()[0])).toContain('Corner Bakery')
  expect(formatRecord(seed()[0])).toContain('#food')
})

test('records round-trip through disk', () => {
  const file = join(tmp, 'money.json')
  const rs = seed()
  saveMoney(file, rs)
  expect(loadMoney(file)).toEqual(rs)
  expect(loadMoney(join(tmp, 'nope.json'))).toEqual([])
})
