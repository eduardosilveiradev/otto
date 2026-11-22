/**
 * Everything that renews, from what Otto already recorded.
 *
 * The money log (money.ts) already holds every charge with its merchant, amount,
 * currency and date, so a subscription is just a merchant that keeps coming back
 * at the same price on a schedule. Nothing is scraped to find more: a charge that
 * was never recorded is a charge this file cannot see.
 *
 * A renewal is the same merchant (normalised: "PAYPAL *Netflix.com" is
 * "netflix") in the same currency, at an amount within 15% of the previous one,
 * whose last two or more charges are a month apart (±5 days) or a year apart
 * (±15 days). The next charge is the last one plus that interval. Domains in
 * access.json join the list with their registration expiry from domains.json,
 * but no price: none is recorded, so none is invented.
 *
 * The yearly total is the one place amounts in different currencies are added:
 * each currency is summed on its own, converted once with fx.ts's ECB rates, and
 * the stat says it is approximate and which currencies had no rate.
 *
 * Once a week the channel diffs the detected list against the keys it has seen
 * and sends one line for anything new. The key is merchant, currency and
 * interval, never the amount, so a price change is never news twice. The first
 * run only learns what is already there.
 */

import type { Card } from './cards.ts'
import { normalizeDomain, type DomainsState } from './domains.ts'
import { convert, rateDateLabel, type FxRates } from './fx.ts'
import { formatMoney, minorDigits, type MoneyRecord } from './money.ts'

export type Interval = 'month' | 'year'

export type Renewal = {
  /** merchant|currency|interval, or domain:<name>. What the weekly notice remembers. */
  key: string
  merchant: string
  /** Undefined for a domain: its price was never recorded. */
  amount?: number
  currency?: string
  interval: Interval
  last?: string
  /** YYYY-MM-DD. */
  next: string
}

const DAY_MS = 86_400_000
const TOLERANCE: Record<Interval, number> = { month: 5, year: 15 }
const DRIFT = 0.15
const MAX_ROWS = 20

const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS)

/** One month or year on from a YYYY-MM-DD, clamped to the month's end: Jan 31 → Feb 28. */
export function addInterval(date: string, interval: Interval): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const months = y * 12 + m - 1 + (interval === 'month' ? 1 : 12)
  const yy = Math.floor(months / 12), mm = months % 12
  const end = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate()
  return new Date(Date.UTC(yy, mm, Math.min(d, end))).toISOString().slice(0, 10)
}

function intervalBetween(a: string, b: string): Interval | undefined {
  return (['month', 'year'] as const).find(i => Math.abs(days(addInterval(a, i), b)) <= TOLERANCE[i])
}

/** "PAYPAL *Netflix.com" and "Netflix" are one merchant. */
export function normaliseMerchant(name: string): string {
  return name.toLowerCase()
    .replace(/^[^*]*\*\s*/, '') // processor prefix: "paypal *", "sq *", "google *"
    .replace(/\.(com|net|io|it|co\.uk)\b/g, '')
    .replace(/\b(inc|ltd|llc|srl|spa|gmbh|bv)\b\.?/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Recurring charges in the money log, soonest next charge first. */
export function detectRenewals(records: MoneyRecord[], today: string): Renewal[] {
  const groups = new Map<string, MoneyRecord[]>()
  for (const r of records) {
    if (!(r.amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue
    const name = normaliseMerchant(r.merchant)
    if (!name) continue
    const k = `${name}|${r.currency}`
    groups.set(k, [...groups.get(k) ?? [], r])
  }
  const found = new Map<string, (Renewal & { first: string })[]>()
  for (const [k, list] of groups) {
    list.sort((a, b) => a.date.localeCompare(b.date))
    // Amount clusters in date order: a charge joins the first cluster whose latest amount is within 15%.
    const clusters: MoneyRecord[][] = []
    for (const r of list) {
      const c = clusters.find(c => Math.abs(r.amount - c.at(-1)!.amount) <= DRIFT * c.at(-1)!.amount)
      c ? c.push(r) : clusters.push([r])
    }
    for (const c of clusters) {
      if (c.length < 2) continue
      const interval = intervalBetween(c.at(-2)!.date, c.at(-1)!.date)
      if (!interval) continue
      const last = c.at(-1)!
      const next = addInterval(last.date, interval)
      // ponytail: two missed cycles reads as cancelled; a receipt that never got recorded looks the same.
      if (addInterval(next, interval) < today) continue
      const key = `${k}|${interval}`
      found.set(key, [...found.get(key) ?? [], { key, merchant: last.merchant, amount: last.amount, currency: last.currency, interval, last: last.date, next, first: c[0]!.date }])
    }
  }
  const out: Renewal[] = []
  for (const list of found.values()) {
    // A price change over 15% starts a second cluster: the older one, ended before the newer began, is the same plan.
    // Clusters that overlap are two plans at the same merchant, and both stay.
    for (const r of list) {
      if (list.some(o => o !== r && o.first > r.last!)) continue
      const { first: _, ...rest } = r
      out.push(rest)
    }
  }
  return out.sort((a, b) => a.next.localeCompare(b.next))
}

/** Configured domains with a known registration expiry. Price is never recorded, so none is shown. */
export function domainRenewals(configured: unknown, state: DomainsState): Renewal[] {
  const names = [...new Set((Array.isArray(configured) ? configured : []).map(d => normalizeDomain(String(d))).filter(Boolean) as string[])]
  return names.flatMap(d => {
    const at = state.domains[d]?.registration?.expiresAt
    return at && !Number.isNaN(Date.parse(at)) ? [{ key: `domain:${d}`, merchant: d, interval: 'year' as const, next: at.slice(0, 10) }] : []
  })
}

const per = (r: Renewal) => r.amount === undefined ? 'price not recorded' : `${formatMoney(r.amount, r.currency!)}/${r.interval}`

/** Text for the session and the app card. No card when there is nothing to show. */
export function renewalsReport(renewals: Renewal[], home: string, rates: FxRates | undefined): { text: string; card?: Card } {
  if (!renewals.length) return { text: 'no recurring charges in the money log, and no domain expiries known' }
  const rows = [...renewals].sort((a, b) => a.next.localeCompare(b.next))
  // Each currency summed in its own minor units, then converted once.
  const minor = new Map<string, number>()
  for (const r of rows) if (r.amount !== undefined) {
    minor.set(r.currency!, (minor.get(r.currency!) ?? 0) + Math.round(r.amount * 10 ** minorDigits(r.currency!)) * (r.interval === 'month' ? 12 : 1))
  }
  let total = 0
  const missing: string[] = []
  for (const [cur, m] of minor) {
    const c = convert(m, cur, home, rates)
    c === undefined ? missing.push(cur) : total += c
  }
  const yearly = formatMoney(total / 10 ** minorDigits(home), home)
  const foreign = [...minor.keys()].some(c => c !== home.toUpperCase() && !missing.includes(c))
  const approx = foreign && rates ? `≈ ECB ${rateDateLabel(rates.date)}` : ''
  const noRate = missing.length ? `no rate for ${missing.join(', ')}, not counted` : ''
  const domainsOnly = rows.filter(r => r.amount === undefined).length
  const lines = rows.map(r => `${r.merchant} · ${per(r)} · next ${r.next}`)
  lines.push(`per year: ${yearly}${approx ? ` (${approx})` : ''}${noRate ? `; ${noRate}` : ''}${domainsOnly ? `; ${domainsOnly} domain(s) without a recorded price are not in it` : ''}`)
  const clip = (s: string) => Array.from(s).length > 60 ? Array.from(s).slice(0, 59).join('') + '…' : s
  const captions = [
    rows.length > MAX_ROWS ? `+${rows.length - MAX_ROWS} more` : '',
    noRate,
    domainsOnly ? 'domains show their expiry; their price was never recorded' : '',
  ].filter(Boolean)
  return {
    text: lines.join('\n'),
    card: {
      title: 'Renewals',
      blocks: [
        { type: 'stat', value: yearly, label: ['a year', approx].filter(Boolean).join(', ') },
        { type: 'table', columns: ['what renews', 'cost', 'next'], rows: rows.slice(0, MAX_ROWS).map(r => [clip(r.merchant), per(r), r.next]) },
        ...captions.map(text => ({ type: 'text' as const, style: 'caption' as const, text })),
      ],
    },
  }
}

/**
 * The weekly notice: one line naming renewals whose key was never seen. With no
 * seen-set yet, everything is learned silently. The returned set only grows.
 */
export function renewalNotice(renewals: Renewal[], seen: string[] | undefined): { line?: string; seen: string[] } {
  const charges = renewals.filter(r => r.amount !== undefined)
  if (!seen) return { seen: [...new Set(charges.map(r => r.key))] }
  const fresh = charges.filter((r, i) => !seen.includes(r.key) && charges.findIndex(o => o.key === r.key) === i)
  if (!fresh.length) return { seen }
  return {
    line: `new renewal${fresh.length > 1 ? 's' : ''}: ${fresh.map(r => `${r.merchant} ${per(r)}`).join(', ')}`,
    seen: [...seen, ...fresh.map(r => r.key)],
  }
}
