import { expect, test } from 'bun:test'
import { validateCard } from '../cards.ts'
import type { MoneyRecord } from '../money.ts'
import { addInterval, detectRenewals, domainRenewals, normaliseMerchant, renewalNotice, renewalsReport } from '../subscriptions.ts'

let n = 0
const rec = (merchant: string, amount: number, date: string, currency = 'EUR'): MoneyRecord =>
  ({ id: `m${++n}`, merchant, amount, currency, date, createdAt: `${date}T10:00:00Z` })
const rates = { date: '2026-11-13', rates: { EUR: 1, BRL: 6 } }

test('monthly with a few days of jitter is detected, next is last plus a month', () => {
  const r = detectRenewals([
    rec('Streamflix', 12.99, '2026-08-03'), rec('PAYPAL *Streamflix.com', 12.99, '2026-09-06'),
    rec('Streamflix', 12.99, '2026-10-02'), rec('Corner Bakery', 4.5, '2026-10-05'),
  ], '2026-11-01')
  expect(r).toHaveLength(1)
  expect(r[0]).toMatchObject({ amount: 12.99, interval: 'month', last: '2026-10-02', next: '2026-11-02' })
})

test('yearly is detected within fifteen days', () => {
  const r = detectRenewals([rec('Cloudbox', 99, '2025-03-10'), rec('Cloudbox', 99, '2026-03-21')], '2026-11-01')
  expect(r).toMatchObject([{ interval: 'year', next: '2027-03-21' }])
})

test('a one-off, an irregular pair and a lapsed plan are not renewals', () => {
  expect(detectRenewals([rec('Gadget Shop', 250, '2026-10-01')], '2026-11-01')).toEqual([])
  expect(detectRenewals([rec('Gym Day Pass', 10, '2026-09-01'), rec('Gym Day Pass', 10, '2026-09-20')], '2026-11-01')).toEqual([])
  // Last charged in May: two monthly cycles missed means cancelled.
  expect(detectRenewals([rec('Musicly', 9.99, '2026-04-01'), rec('Musicly', 9.99, '2026-05-01')], '2026-11-01')).toEqual([])
})

test('amount drift beyond 15% is not merged', () => {
  expect(detectRenewals([rec('Newsdaily', 10, '2026-09-01'), rec('Newsdaily', 12, '2026-10-01')], '2026-11-01')).toEqual([])
  expect(detectRenewals([rec('Newsdaily', 10, '2026-09-01'), rec('Newsdaily', 11, '2026-10-01')], '2026-11-01')).toHaveLength(1)
})

test('a price rise keeps one row; two overlapping plans at one merchant keep two', () => {
  const rise = detectRenewals([
    rec('Streamflix', 10, '2026-07-01'), rec('Streamflix', 10, '2026-08-01'),
    rec('Streamflix', 14, '2026-09-01'), rec('Streamflix', 14, '2026-10-01'),
  ], '2026-10-15')
  expect(rise).toMatchObject([{ amount: 14, next: '2026-11-01' }])
  const two = detectRenewals([
    rec('App Store', 2.99, '2026-09-04'), rec('App Store', 9.99, '2026-09-10'),
    rec('App Store', 2.99, '2026-10-04'), rec('App Store', 9.99, '2026-10-10'),
  ], '2026-10-15')
  expect(two.map(r => r.amount)).toEqual([2.99, 9.99])
})

test('next-date math clamps to the end of the month', () => {
  expect(addInterval('2026-01-31', 'month')).toBe('2026-02-28')
  expect(addInterval('2028-02-29', 'year')).toBe('2029-02-28')
  expect(addInterval('2026-12-15', 'month')).toBe('2027-01-15')
  expect(normaliseMerchant('SQ *Corner Bakery Ltd.')).toBe('corner bakery')
})

test('the new-renewal notice seeds silently, fires once, and never repeats on a price change', () => {
  const a = detectRenewals([rec('Streamflix', 10, '2026-09-01'), rec('Streamflix', 10, '2026-10-01')], '2026-10-15')
  const first = renewalNotice(a, undefined)
  expect(first.line).toBeUndefined()
  const b = detectRenewals([
    rec('Streamflix', 10, '2026-09-01'), rec('Streamflix', 10, '2026-10-01'),
    rec('Cloudbox', 3, '2026-09-20'), rec('Cloudbox', 3, '2026-10-20'),
  ], '2026-10-25')
  const second = renewalNotice(b, first.seen)
  expect(second.line).toBe('new renewal: Cloudbox €3.00/month')
  expect(renewalNotice(b, second.seen).line).toBeUndefined()
  const pricier = detectRenewals([rec('Cloudbox', 6, '2026-11-20'), rec('Cloudbox', 6, '2026-12-20')], '2026-12-25')
  expect(renewalNotice(pricier, second.seen).line).toBeUndefined()
})

test('the yearly total converts per currency, and domains add a date with no price', () => {
  const subs = [
    ...detectRenewals([
      rec('Streamflix', 10, '2026-09-01'), rec('Streamflix', 10, '2026-10-01'),
      rec('Grocer Plus', 60, '2025-10-10', 'BRL'), rec('Grocer Plus', 60, '2026-10-12', 'BRL'),
      rec('Yen Tool', 1200, '2026-09-05', 'JPY'), rec('Yen Tool', 1200, '2026-10-05', 'JPY'),
    ], '2026-10-15'),
    ...domainRenewals(['Example.com', 'bad host'], { domains: { 'example.com': { alerted: [], registration: { expiresAt: '2027-02-01T00:00:00Z', checkedAt: '' } } } }),
  ]
  const { text, card } = renewalsReport(subs, 'EUR', rates)
  expect(card!.blocks[0]).toMatchObject({ type: 'stat', value: '€130.00' }) // 120 + 60 BRL / 6
  expect(text).toContain('no rate for JPY')
  expect(text).toContain('example.com · price not recorded · next 2027-02-01')
  expect(validateCard(card).ok).toBe(true)
})

test('the card validates against cards.ts at its limits, and is absent when empty', () => {
  const many = Array.from({ length: 25 }, (_, i) => detectRenewals([
    rec(`${'Very long merchant name '.repeat(6)}${i}`, 5 + i, '2026-09-01'), rec(`${'Very long merchant name '.repeat(6)}${i}`, 5 + i, '2026-10-01'),
  ], '2026-10-15')).flat()
  expect(many).toHaveLength(25)
  const { card } = renewalsReport(many, 'EUR', rates)
  const checked = validateCard(card)
  expect(checked.ok ? [] : checked.errors).toEqual([])
  expect(card!.blocks.some(b => b.type === 'text' && b.text === '+5 more')).toBe(true)
  expect(renewalsReport([], 'EUR', rates).card).toBeUndefined()
})
