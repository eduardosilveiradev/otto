import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { recordMoney, loadMoney, saveMoney, type MoneyRecord, type MoneyInput } from '../money.ts'
import {
  addDays, addMonths, coverageOf, deliveryOf, matchShipment, aboveMin, returnsConfig,
  purchases, closingSoon, formatReturnsLine, findPurchases, formatCoverage,
  loadRatesLoose, jurisdictionOf, type ShipmentLike,
} from '../returns.ts'
import { recordPackage, loadPackages } from '../packages.ts'
import { formatBrief, sectionLabels, type BriefParts } from '../brief.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-returns-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

function buy(input: Partial<MoneyInput> & { purchase?: MoneyInput['purchase'] }): MoneyRecord {
  const rs: MoneyRecord[] = []
  return recordMoney(rs, {
    merchant: 'Some Shop', amount: 120, currency: 'EUR', date: '2026-10-01',
    purchase: { item: 'headphones' }, ...input,
  } as MoneyInput).record
}

const cfg = returnsConfig(null)

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

test('day and month arithmetic stays on the calendar', () => {
  expect(addDays('2026-10-01', 14)).toBe('2026-10-15')
  expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
  expect(addMonths('2026-10-04', 24)).toBe('2028-10-04')
  // Clamped to the end of a short month rather than spilling into the next.
  expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
  expect(addMonths('2028-02-29', 12)).toBe('2029-02-28')
})

// ---------------------------------------------------------------------------
// Policy table
// ---------------------------------------------------------------------------

test('EU online purchase: 14 days to return and 2 years of guarantee, both from delivery', () => {
  const c = coverageOf(buy({}))!
  expect(c.delivery).toEqual({ date: '2026-10-04', basis: 'estimated' })
  expect(c.returnBy).toEqual({ until: '2026-10-18', basis: 'EU 14-day withdrawal' })
  expect(c.warranty).toEqual({ until: '2028-10-04', basis: 'EU 2-year legal guarantee' })
})

test('Brazil online purchase: CDC art. 49 gives 7 days, art. 26 gives 90 for durable goods', () => {
  const c = coverageOf(buy({ currency: 'BRL', amount: 900 }))!
  expect(c.returnBy?.until).toBe('2026-10-11')
  expect(c.returnBy?.basis).toContain('art. 49')
  expect(c.warranty?.until).toBe('2027-01-02')
  expect(c.warranty?.basis).toContain('90 days')
})

test('Brazil non-durable goods get the 30-day art. 26 period', () => {
  const c = coverageOf(buy({ currency: 'BRL', purchase: { item: 'printer ink', durable: false } }))!
  expect(c.warranty?.until).toBe('2026-11-03')
})

test('a shop purchase has no statutory return, but still has the guarantee', () => {
  const c = coverageOf(buy({ purchase: { item: 'kettle', channel: 'store' } }))!
  expect(c.delivery).toEqual({ date: '2026-10-01', basis: 'in store' })
  expect(c.returnBy).toBeUndefined()
  expect(c.warranty?.until).toBe('2028-10-01')
})

test('Amazon in the EU extends the window to 30 days; outside the EU it does not apply', () => {
  const eu = coverageOf(buy({ merchant: 'Amazon.it' }))!
  expect(eu.returnBy).toEqual({ until: '2026-11-03', basis: 'Amazon 30-day returns' })
  const br = coverageOf(buy({ merchant: 'Amazon.com.br', currency: 'BRL' }))!
  expect(br.returnBy?.basis).toContain('art. 49')
})

test('Apple gives 14 days even when bought in a shop', () => {
  const c = coverageOf(buy({ merchant: 'Apple Store', purchase: { item: 'iPad', channel: 'store' } }))!
  expect(c.returnBy).toEqual({ until: '2026-10-15', basis: 'Apple 14-day returns' })
})

test('a deadline the receipt states wins only when it is later than the law', () => {
  const later = coverageOf(buy({ purchase: { item: 'coat', returnBy: '2027-01-15' } }))!
  expect(later.returnBy).toEqual({ until: '2027-01-15', basis: 'as stated on the receipt' })
  const earlier = coverageOf(buy({ purchase: { item: 'coat', returnBy: '2026-10-05' } }))!
  expect(earlier.returnBy?.basis).toBe('EU 14-day withdrawal')
  const longWarranty = coverageOf(buy({ purchase: { item: 'laptop', warrantyUntil: '2029-10-01' } }))!
  expect(longWarranty.warranty?.until).toBe('2029-10-01')
})

test('jurisdiction comes from the record, else from the currency, else nothing', () => {
  expect(jurisdictionOf(buy({ currency: 'EUR' }))).toBe('EU')
  expect(jurisdictionOf(buy({ currency: 'BRL' }))).toBe('BR')
  expect(jurisdictionOf(buy({ currency: 'USD' }))).toBeUndefined()
  expect(jurisdictionOf(buy({ currency: 'USD', purchase: { jurisdiction: 'EU' } }))).toBe('EU')
  // A dollar purchase with no known law gets no statutory rows at all.
  const c = coverageOf(buy({ currency: 'USD' }))!
  expect(c.returnBy).toBeUndefined()
  expect(c.warranty).toBeUndefined()
})

test('a record without purchase facts has no coverage', () => {
  const rs: MoneyRecord[] = []
  const { record } = recordMoney(rs, { merchant: 'Bar', amount: 4, currency: 'EUR', date: '2026-10-01' })
  expect(coverageOf(record)).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

test('a shipment carrying the same email is the delivery date', () => {
  const r = buy({ source: 'email:abc' })
  const ships: ShipmentLike[] = [{ sources: ['email:abc'], status: 'delivered', deliveredAt: '2026-10-09T10:00:00Z' }]
  expect(deliveryOf(r, ships)).toEqual({ date: '2026-10-09', basis: 'shipment' })
  expect(coverageOf(r, ships)!.returnBy?.until).toBe('2026-10-23')
})

test('the order number links a purchase to its parcel', () => {
  const r = buy({ purchase: { item: 'lamp', orderRef: '402-1234567-1234567' } })
  const ships: ShipmentLike[] = [{ orderRef: '4021234567 1234567', deliveredAt: '2026-10-06T08:00:00Z' }]
  expect(deliveryOf(r, ships).date).toBe('2026-10-06')
})

test('a merchant match counts only when exactly one parcel fits', () => {
  const r = buy({ merchant: 'Amazon' })
  const one: ShipmentLike[] = [{ merchant: 'amazon.it', deliveredAt: '2026-10-05T12:00:00Z' }]
  expect(matchShipment(r, one)).toBe(one[0])
  const two: ShipmentLike[] = [...one, { merchant: 'Amazon', deliveredAt: '2026-10-07T12:00:00Z' }]
  expect(matchShipment(r, two)).toBeUndefined()
  expect(deliveryOf(r, two).basis).toBe('estimated')
  // A parcel delivered before the purchase is someone else's order.
  expect(matchShipment(r, [{ merchant: 'Amazon', deliveredAt: '2026-09-20T12:00:00Z' }])).toBeUndefined()
})

test('a matched parcel still in transit gives its ETA as an estimate', () => {
  const r = buy({ source: 'email:x' })
  const ships: ShipmentLike[] = [{ sources: ['email:x'], status: 'in_transit', eta: '2026-10-08' }]
  expect(deliveryOf(r, ships)).toEqual({ date: '2026-10-08', basis: 'estimated' })
})

test('delivery day is read in the zone given', () => {
  const r = buy({ source: 'email:tz' })
  const ships: ShipmentLike[] = [{ sources: ['email:tz'], deliveredAt: '2026-10-05T01:30:00Z' }]
  expect(deliveryOf(r, ships, 'America/Sao_Paulo').date).toBe('2026-10-04')
})

test('a real packages.json record supplies the delivery date and order link', () => {
  const file = join(tmp, 'packages.json')
  const at = '2026-10-07T09:00:00Z'
  recordPackage(file, { carrier: 'brt', tracking: 'BRT0001', merchant: 'Some Shop', orderRef: '402-7654321-7654321', status: 'shipped', eta: '2026-10-08', source: 'email:p1' }, new Date('2026-10-02T09:00:00Z'))
  const r = buy({ purchase: { item: 'lamp', orderRef: '402-7654321-7654321' } })
  expect(deliveryOf(r, loadPackages(file))).toEqual({ date: '2026-10-08', basis: 'estimated' })
  recordPackage(file, { tracking: 'BRT0001', status: 'delivered', at, source: 'email:p2' }, new Date(at))
  expect(deliveryOf(r, loadPackages(file))).toEqual({ date: '2026-10-07', basis: 'shipment' })
})

// ---------------------------------------------------------------------------
// Threshold
// ---------------------------------------------------------------------------

test('config defaults to 30 in EUR and ignores unusable values', () => {
  expect(returnsConfig(null)).toEqual({ minAmount: 30, home: 'EUR' })
  expect(returnsConfig({ returns: { minAmount: 'lots' }, money: { home: 'euro' } })).toEqual({ minAmount: 30, home: 'EUR' })
  expect(returnsConfig({ returns: { minAmount: 100 }, money: { home: 'brl' } })).toEqual({ minAmount: 100, home: 'BRL' })
})

test('the threshold is compared in the home currency', () => {
  expect(aboveMin(buy({ amount: 29.99 }), cfg)).toBe(false)
  expect(aboveMin(buy({ amount: 30 }), cfg)).toBe(true)
  const rates = { BRL: 6, USD: 1.1 }
  // R$ 150 is €25 at 6 to the euro: below. R$ 200 is €33.33: above.
  expect(aboveMin(buy({ amount: 150, currency: 'BRL' }), cfg, rates)).toBe(false)
  expect(aboveMin(buy({ amount: 200, currency: 'BRL' }), cfg, rates)).toBe(true)
  // Home in BRL, a €10 purchase is R$ 60.
  const brl = returnsConfig({ returns: { minAmount: 50 }, money: { home: 'BRL' } })
  expect(aboveMin(buy({ amount: 10, currency: 'EUR' }), brl, rates)).toBe(true)
  expect(aboveMin(buy({ amount: 5, currency: 'EUR' }), brl, rates)).toBe(false)
})

test('a foreign amount with no rate counts rather than being dropped', () => {
  expect(aboveMin(buy({ amount: 1, currency: 'BRL' }), cfg)).toBe(true)
  expect(aboveMin(buy({ amount: 1, currency: 'CHF' }), cfg, { BRL: 6 })).toBe(true)
})

test('the rate cache is optional', () => {
  expect(loadRatesLoose(join(tmp, 'no-fx.json'))).toBeUndefined()
  const fx = join(tmp, 'fx.json')
  writeFileSync(fx, JSON.stringify({ date: '2026-10-12', rates: { BRL: 6.2 }, fetchedAt: '2026-10-12T16:00:00Z' }))
  expect(loadRatesLoose(fx)).toEqual({ BRL: 6.2 })
})

// ---------------------------------------------------------------------------
// Brief line and warranty answers
// ---------------------------------------------------------------------------

function ledger(): MoneyRecord[] {
  const rs: MoneyRecord[] = []
  recordMoney(rs, { merchant: 'Amazon.it', amount: 89, currency: 'EUR', date: '2026-09-10', purchase: { item: 'headphones' } })
  recordMoney(rs, { merchant: 'Some Shop', amount: 45, currency: 'EUR', date: '2026-10-01', purchase: { item: 'desk lamp' } })
  recordMoney(rs, { merchant: 'Some Shop', amount: 12, currency: 'EUR', date: '2026-10-01', purchase: { item: 'cable' } })
  recordMoney(rs, { merchant: 'Loja', amount: 400, currency: 'BRL', date: '2026-10-08', purchase: { item: 'blender' } })
  recordMoney(rs, { merchant: 'Cafe', amount: 40, currency: 'EUR', date: '2026-10-10' })
  return rs
}

test('purchases skips small amounts and non-purchases', () => {
  const covs = purchases(ledger(), { config: cfg })
  expect(covs.map(c => c.item)).toEqual(['blender', 'desk lamp', 'headphones'])
})

test('closing soon is today through five days out, soonest first', () => {
  const covs = purchases(ledger(), { config: cfg })
  // headphones: delivered (est.) 09-13 + 30 = 10-13. blender: 10-11 + 7 = 10-18.
  // lamp: 10-04 + 14 = 10-18. A tie keeps the newer purchase first.
  const soon = closingSoon(covs, '2026-10-13')
  expect(soon.map(c => [c.item, c.returnBy!.until])).toEqual([
    ['headphones', '2026-10-13'],
    ['blender', '2026-10-18'],
    ['desk lamp', '2026-10-18'],
  ])
  expect(closingSoon(covs, '2026-10-14').map(c => c.item)).not.toContain('headphones')
  expect(closingSoon(covs, '2026-10-01')).toEqual([])
})

test('the brief line names item, shop, amount, date and how soon, and is a labelled section', () => {
  const covs = purchases(ledger(), { config: cfg })
  const line = formatReturnsLine(covs, '2026-10-13', '09:00')!
  expect(line.startsWith('Returns closing (as of 09:00): headphones (Amazon.it, €89.00) by 2026-10-13 today')).toBe(true)
  expect(line).toContain('delivery estimated')
  expect(formatReturnsLine(covs, '2026-12-01', '09:00')).toBeUndefined()

  const parts: BriefParts = {
    now: new Date('2026-10-13T07:00:00Z'), tz: 'UTC', events: null, mail: null,
    loops: [], facts: [], triggers: [], history: [], returns: line,
  }
  const text = formatBrief(parts)
  expect(text).toContain('Returns closing (as of 09:00):')
  expect(sectionLabels(text)).toContain('Returns closing')
  expect(formatBrief({ ...parts, returns: undefined })).not.toContain('Returns closing')
})

test('warranty lookup by item words, with both deadlines and their status', () => {
  const covs = purchases(ledger(), { config: cfg })
  const hits = findPurchases(covs, 'Headphones')
  expect(hits.map(c => c.item)).toEqual(['headphones'])
  expect(findPurchases(covs, 'amazon').length).toBe(1)
  expect(findPurchases(covs, 'toaster')).toEqual([])
  expect(findPurchases(covs, '').length).toBe(3)

  const text = formatCoverage(hits[0]!, '2026-10-20')
  expect(text).toContain('warranty: covered until 2028-09-13 (EU 2-year legal guarantee)')
  expect(text).toContain('return: closed 2026-10-13 (Amazon 30-day returns)')
  expect(text).toContain('delivery estimated 2026-09-13')

  const brl = formatCoverage(findPurchases(covs, 'blender')[0]!, '2027-02-01')
  expect(brl).toContain('warranty: expired 2027-01-09 (CDC art. 26, 90 days)')
})

// ---------------------------------------------------------------------------
// money.ts: the purchase field
// ---------------------------------------------------------------------------

test('recordMoney keeps clean purchase facts and drops malformed ones', () => {
  const rs: MoneyRecord[] = []
  const { record } = recordMoney(rs, {
    merchant: 'Shop', amount: 50, currency: 'EUR', date: '2026-10-01',
    purchase: { item: '  kettle ', channel: 'store', returnBy: 'next week', warrantyUntil: '2029-01-01', jurisdiction: 'XX' as 'EU' },
  })
  expect(record.purchase).toEqual({ item: 'kettle', channel: 'store', warrantyUntil: '2029-01-01' })
})

test('a re-read receipt gains purchase facts it lacked, once', () => {
  const rs: MoneyRecord[] = []
  recordMoney(rs, { merchant: 'Shop', amount: 50, currency: 'EUR', date: '2026-10-01', source: 'email:m1' })
  const second = recordMoney(rs, { merchant: 'Shop', amount: 50, currency: 'EUR', date: '2026-10-01', source: 'email:m1', purchase: { item: 'kettle' } })
  expect(second).toMatchObject({ created: false, updated: true })
  expect(rs.length).toBe(1)
  expect(rs[0]!.purchase).toEqual({ item: 'kettle' })
  const third = recordMoney(rs, { merchant: 'Shop', amount: 50, currency: 'EUR', date: '2026-10-01', source: 'email:m1', purchase: { item: 'toaster' } })
  expect(third.updated).toBeUndefined()
  expect(rs[0]!.purchase).toEqual({ item: 'kettle' })
})

test('purchase facts survive a save and load', () => {
  const file = join(tmp, 'money.json')
  saveMoney(file, ledger())
  const back = loadMoney(file)
  expect(purchases(back, { config: cfg }).length).toBe(3)
  expect(readdirSync(tmp).some(f => f.endsWith('.tmp'))).toBe(false)
})
