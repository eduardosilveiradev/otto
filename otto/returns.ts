/**
 * Return windows and warranties on things the user bought.
 *
 * Every receipt already lands in money.json. What it does not say is the date
 * that actually costs money: the last day the thing can go back, and the last
 * day a fault is the seller's problem rather than theirs. Both are a fixed
 * number of days from a known date, so they are worked out here instead of
 * being remembered — or, more usually, not remembered until the box is in the
 * recycling.
 *
 * Deadlines are computed on read, never stored. The clock runs from delivery,
 * and delivery is usually news that arrives after the receipt: the package
 * record when there is one (packages.json, via packages.ts), otherwise the
 * purchase date plus three days,
 * marked as an estimate so nobody quotes it as fact.
 *
 * The policy table is small on purpose and every row names its source. The
 * retailer rows are a shop's own terms, which change without notice, so they
 * are marked unverified until someone has checked them against the live page.
 * Statutory rows are the floor; a retailer row only ever extends it.
 *
 * Nothing here sends anything. The brief carries a line for windows closing in
 * the next few days, and the `warranty` tool answers when asked.
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { PackageRecord } from './packages.ts'
import { minorDigits, formatMoney, type MoneyRecord, type PurchaseFacts } from './money.ts'

export type Jurisdiction = 'EU' | 'BR'

/** Purchases below this, in the home currency, are not worth a line. */
export const DEFAULT_MIN_AMOUNT = 30
/** Same default as access.json `money.home` on the fx side. */
export const DEFAULT_HOME = 'EUR'
/** No shipment record: assume it turned up this many days after purchase. */
export const ASSUMED_DELIVERY_DAYS = 3
/** How far ahead the brief looks for a closing window. */
export const CLOSING_DAYS = 5

// ---------------------------------------------------------------------------
// Dates — bare YYYY-MM-DD, arithmetic in UTC so no zone can move a day
// ---------------------------------------------------------------------------

const DAY_MS = 864e5

function parseDay(d: string): number {
  return Date.parse(`${d.slice(0, 10)}T00:00:00Z`)
}

function fmtDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10)
}

export function addDays(d: string, n: number): string {
  return fmtDay(parseDay(d) + n * DAY_MS)
}

/** Calendar months, clamped: 31 Jan + 1 month is 28/29 Feb, never 3 Mar. */
export function addMonths(d: string, n: number): string {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number) as [number, number, number]
  const target = new Date(Date.UTC(y, m - 1 + n, 1))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, last))
  return fmtDay(target.getTime())
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to) - parseDay(from)) / DAY_MS)
}

// ---------------------------------------------------------------------------
// Policy table
// ---------------------------------------------------------------------------

type Ctx = { jurisdiction?: Jurisdiction; channel: 'online' | 'store'; durable: boolean; merchant: string }

export type Rule = {
  id: string
  /** How the line reads to the user: "EU 14-day withdrawal". */
  label: string
  days?: number
  months?: number
  applies: (c: Ctx) => boolean
}

/**
 * The right to change your mind. Statutory rows apply only to purchases made
 * away from the shop, which is the whole point of them; a shop purchase has
 * no statutory return at all, only whatever the retailer offers.
 */
export const RETURN_RULES: Rule[] = [
  // Directive 2011/83/EU art. 9 — 14 days from the day the goods are received.
  // https://eur-lex.europa.eu/eli/dir/2011/83/oj
  { id: 'eu-withdrawal', label: 'EU 14-day withdrawal', days: 14, applies: c => c.jurisdiction === 'EU' && c.channel === 'online' },
  // CDC (Lei 8.078/1990) art. 49 — 7 days from signing or receipt, purchases
  // made outside a commercial establishment.
  // https://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm
  { id: 'br-cdc-49', label: 'CDC art. 49, 7 days', days: 7, applies: c => c.jurisdiction === 'BR' && c.channel === 'online' },
  // Amazon's EU stores: 30 days from delivery for most items.
  // UNVERIFIED — retailer terms, not checked against the live page:
  // https://www.amazon.de/gp/help/customer/display.html?nodeId=GKM69DUUYKQWKWX7
  { id: 'amazon-eu', label: 'Amazon 30-day returns', days: 30, applies: c => c.jurisdiction === 'EU' && /\bamazon\b/i.test(c.merchant) },
  // Apple Store: 14 days from receipt, online or in a shop.
  // UNVERIFIED — retailer terms, not checked against the live page:
  // https://www.apple.com/shop/help/returns_refund
  { id: 'apple', label: 'Apple 14-day returns', days: 14, applies: c => /^apple\b/i.test(c.merchant.trim()) },
]

/** What the seller owes when the thing turns out faulty. Runs from delivery in both places. */
export const WARRANTY_RULES: Rule[] = [
  // Directive (EU) 2019/771 art. 10 — liability for lack of conformity
  // appearing within two years of delivery.
  // https://eur-lex.europa.eu/eli/dir/2019/771/oj
  { id: 'eu-guarantee', label: 'EU 2-year legal guarantee', months: 24, applies: c => c.jurisdiction === 'EU' },
  // CDC art. 26 II, §1 — 90 days for durable goods from effective delivery;
  // art. 26 I — 30 days for non-durable ones.
  // https://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm
  { id: 'br-cdc-26-durable', label: 'CDC art. 26, 90 days', days: 90, applies: c => c.jurisdiction === 'BR' && c.durable },
  { id: 'br-cdc-26', label: 'CDC art. 26, 30 days', days: 30, applies: c => c.jurisdiction === 'BR' && !c.durable },
]

function endOf(rule: Rule, from: string): string {
  return rule.months ? addMonths(from, rule.months) : addDays(from, rule.days ?? 0)
}

export function jurisdictionOf(r: MoneyRecord): Jurisdiction | undefined {
  if (r.purchase?.jurisdiction) return r.purchase.jurisdiction
  if (r.currency === 'EUR') return 'EU'
  if (r.currency === 'BRL') return 'BR'
  return undefined
}

// ---------------------------------------------------------------------------
// Delivery — from a shipment record when one exists
// ---------------------------------------------------------------------------

/** The parts of a packages.json record (packages.ts, loadPackages) this file reads. */
export type ShipmentLike = Partial<Pick<PackageRecord, 'merchant' | 'orderRef' | 'sources' | 'status' | 'deliveredAt' | 'eta'>>

export type Delivery = { date: string; basis: 'shipment' | 'in store' | 'estimated' }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

function shipDay(s: ShipmentLike, tz?: string): string | undefined {
  if (!s.deliveredAt) return undefined
  const t = Date.parse(s.deliveredAt)
  if (Number.isNaN(t)) return /^\d{4}-\d{2}-\d{2}/.test(s.deliveredAt) ? s.deliveredAt.slice(0, 10) : undefined
  if (!tz) return fmtDay(t)
  try {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).format(new Date(t))
  } catch {
    return fmtDay(t)
  }
}

/**
 * Which parcel was this purchase. Strong links first — the same email, then
 * the order number. Failing both, a merchant match is accepted only when
 * exactly one parcel from that merchant was delivered in the six weeks after
 * the purchase; two Amazon parcels that week means guessing, and a guessed
 * delivery is worse than an honest estimate.
 */
export function matchShipment(r: MoneyRecord, shipments: ShipmentLike[], tz?: string): ShipmentLike | undefined {
  if (r.source) {
    const hit = shipments.find(s => Array.isArray(s.sources) && s.sources.includes(r.source!))
    if (hit) return hit
  }
  const ref = r.purchase?.orderRef
  if (ref) {
    const hit = shipments.find(s => typeof s.orderRef === 'string' && norm(s.orderRef) === norm(ref))
    if (hit) return hit
  }
  const merchant = norm(r.merchant)
  if (!merchant) return undefined
  const candidates = shipments.filter(s => {
    if (typeof s.merchant !== 'string') return false
    const m = norm(s.merchant)
    if (!m || !(m.includes(merchant) || merchant.includes(m))) return false
    const day = shipDay(s, tz)
    if (!day) return false
    const gap = daysBetween(r.date, day)
    return gap >= 0 && gap <= 42
  })
  return candidates.length === 1 ? candidates[0] : undefined
}

export function deliveryOf(r: MoneyRecord, shipments: ShipmentLike[], tz?: string): Delivery {
  if (r.purchase?.channel === 'store') return { date: r.date, basis: 'in store' }
  const ship = matchShipment(r, shipments, tz)
  const day = ship && shipDay(ship, tz)
  if (day && day >= r.date) return { date: day, basis: 'shipment' }
  // Matched but not delivered yet: the ETA is the better estimate, but still
  // an estimate — and never earlier than the purchase.
  const eta = ship?.eta
  if (eta && /^\d{4}-\d{2}-\d{2}$/.test(eta) && eta >= r.date) return { date: eta, basis: 'estimated' }
  return { date: addDays(r.date, ASSUMED_DELIVERY_DAYS), basis: 'estimated' }
}

// ---------------------------------------------------------------------------
// Threshold — which purchases count
// ---------------------------------------------------------------------------

export type ReturnsConfig = { minAmount: number; home: string }

/** access.json `returns.minAmount` and `money.home`; anything unusable falls back to its default. */
export function returnsConfig(access?: { returns?: { minAmount?: unknown }; money?: { home?: unknown } } | null): ReturnsConfig {
  const raw = access?.returns?.minAmount
  const minAmount = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_AMOUNT
  const h = typeof access?.money?.home === 'string' ? access.money.home.trim().toUpperCase() : ''
  return { minAmount, home: /^[A-Z]{3}$/.test(h) ? h : DEFAULT_HOME }
}

/** Units of each currency per 1 EUR — the shape of fx.json's `rates`. */
export type Rates = Record<string, number>

export const FX_FILE = join(
  process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'),
  'fx.json',
)

/** The cached ECB rates if a rate cache exists on this install; undefined otherwise. */
export function loadRatesLoose(file: string = FX_FILE): Rates | undefined {
  try {
    const rates = (JSON.parse(readFileSync(file, 'utf8')) as { rates?: unknown }).rates
    return rates && typeof rates === 'object' ? (rates as Rates) : undefined
  } catch {
    return undefined
  }
}

/**
 * Worth tracking? Compared in the home currency. A purchase in another
 * currency with no rate to convert it counts: one extra line in the brief is
 * cheap, and a missed window on a television is not.
 */
export function aboveMin(r: MoneyRecord, cfg: ReturnsConfig, rates?: Rates): boolean {
  const cur = r.currency.toUpperCase()
  if (cur === cfg.home) return r.amount >= cfg.minAmount
  const rf = cur === 'EUR' ? 1 : rates?.[cur]
  const rt = cfg.home === 'EUR' ? 1 : rates?.[cfg.home]
  if (!rf || !rt) return true
  const scale = 10 ** minorDigits(cfg.home)
  return Math.round((r.amount / rf) * rt * scale) >= Math.round(cfg.minAmount * scale)
}

// ---------------------------------------------------------------------------
// Coverage — the two deadlines for one purchase
// ---------------------------------------------------------------------------

export type Deadline = { until: string; basis: string }

export type Coverage = {
  record: MoneyRecord
  item: string
  delivery: Delivery
  /** Latest applicable return deadline; absent when no rule gives one. */
  returnBy?: Deadline
  warranty?: Deadline
}

/**
 * The later of every deadline that applies. Rights stack rather than replace:
 * a 30-day shop policy does not shorten a 14-day statutory window, and a
 * receipt that promises less than the law is simply outranked by it.
 */
function latest(rules: Rule[], ctx: Ctx, from: string, stated?: string): Deadline | undefined {
  let best: Deadline | undefined
  for (const rule of rules) {
    if (!rule.applies(ctx)) continue
    const until = endOf(rule, from)
    if (!best || until > best.until) best = { until, basis: rule.label }
  }
  if (stated && (!best || stated > best.until)) best = { until: stated, basis: 'as stated on the receipt' }
  return best
}

export function coverageOf(r: MoneyRecord, shipments: ShipmentLike[] = [], tz?: string): Coverage | undefined {
  const p: PurchaseFacts | undefined = r.purchase
  if (!p) return undefined
  const ctx: Ctx = {
    jurisdiction: jurisdictionOf(r),
    channel: p.channel ?? 'online',
    durable: p.durable ?? true,
    merchant: r.merchant,
  }
  const delivery = deliveryOf(r, shipments, tz)
  const returnBy = latest(RETURN_RULES, ctx, delivery.date, p.returnBy)
  const warranty = latest(WARRANTY_RULES, ctx, delivery.date, p.warrantyUntil)
  return {
    record: r,
    item: p.item ?? r.merchant,
    delivery,
    ...(returnBy ? { returnBy } : {}),
    ...(warranty ? { warranty } : {}),
  }
}

export type CoverageOpts = { config: ReturnsConfig; rates?: Rates; shipments?: ShipmentLike[]; tz?: string }

/** Every tracked purchase in the ledger, newest first. */
export function purchases(records: MoneyRecord[], o: CoverageOpts): Coverage[] {
  return records
    .filter(r => r.purchase && aboveMin(r, o.config, o.rates))
    .map(r => coverageOf(r, o.shipments ?? [], o.tz))
    .filter((c): c is Coverage => !!c)
    .sort((a, b) => b.record.date.localeCompare(a.record.date))
}

/** Return windows still open and closing within `days`, soonest first. Today counts. */
export function closingSoon(covs: Coverage[], today: string, days = CLOSING_DAYS): Coverage[] {
  const horizon = addDays(today, days)
  return covs
    .filter(c => c.returnBy && c.returnBy.until >= today && c.returnBy.until <= horizon)
    .sort((a, b) => a.returnBy!.until.localeCompare(b.returnBy!.until))
}

function inDays(today: string, until: string): string {
  const n = daysBetween(today, until)
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n}d`
}

/**
 * The brief's line, or undefined when nothing closes soon. It is a section
 * only when it has something to say, the same as trip mode and usage.
 */
export function formatReturnsLine(covs: Coverage[], today: string, stamp: string, days = CLOSING_DAYS): string | undefined {
  const soon = closingSoon(covs, today, days)
  if (!soon.length) return undefined
  const bits = soon.slice(0, 4).map(c => {
    const est = c.delivery.basis === 'estimated' ? ', delivery estimated' : ''
    return `${c.item} (${c.record.merchant}, ${formatMoney(c.record.amount, c.record.currency)}) by ${c.returnBy!.until} ${inDays(today, c.returnBy!.until)}${est}`
  })
  const more = soon.length > 4 ? ` (+${soon.length - 4} more)` : ''
  return `Returns closing (as of ${stamp}): ${bits.join('; ')}${more}`
}

/** Purchases whose item, merchant or note mentions every word of the query. */
export function findPurchases(covs: Coverage[], query: string): Coverage[] {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1)
  if (!words.length) return covs
  return covs.filter(c => {
    const hay = [c.item, c.record.merchant, c.record.note ?? ''].join(' ').toLowerCase()
    return words.every(w => hay.includes(w))
  })
}

/** One purchase as the `warranty` tool reports it: both deadlines, and whether each is still open. */
export function formatCoverage(c: Coverage, today: string): string {
  const r = c.record
  const head = `${c.item} — ${r.merchant}, ${formatMoney(r.amount, r.currency)}, bought ${r.date}`
  const deliv = c.delivery.basis === 'shipment'
    ? `delivered ${c.delivery.date}`
    : c.delivery.basis === 'in store'
      ? 'bought in store'
      : `delivery estimated ${c.delivery.date} (no delivery record)`
  const status = (d: Deadline | undefined, open: string, shut: string, none: string) =>
    !d ? none : d.until >= today ? `${open} until ${d.until} (${d.basis})` : `${shut} ${d.until} (${d.basis})`
  return [
    head,
    `  ${deliv}`,
    `  warranty: ${status(c.warranty, 'covered', 'expired', 'no statutory warranty known — check the receipt')}`,
    `  return: ${status(c.returnBy, 'open', 'closed', 'no return window known')}`,
  ].join('\n')
}
