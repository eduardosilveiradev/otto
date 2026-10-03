/**
 * The receipt ledger.
 *
 * the user's spending arrives as email: a bank notification in one currency, an
 * invoice in another, an App Store receipt in whichever currency the store decided.
 * Otto already reads all of it every hour and then throws the numbers away, so
 * "what did I spend on food in July" is a question it can only answer by
 * re-reading a month of mail — which is why it never gets asked.
 *
 * A money record is deliberately dumb: merchant, amount as charged, currency,
 * date, category, and the message it came from. The last field is what makes it
 * safe to run automatically — every number traces back to an email, so a wrong
 * total is diagnosable instead of merely embarrassing.
 *
 * Two rules that spending in more than one currency forces:
 *
 *   Currencies never mix. Every total is per currency and stays that way. A
 *   caller who wants one number supplies the rate; nothing in this file knows
 *   what a real is worth, and a hardcoded rate would silently rot into a lie
 *   that gets quoted back to the user months later.
 *
 *   Amounts are parsed with the separator convention resolved, not assumed.
 *   "R$ 1.234,56" and "$1,234.56" are the same amount written by two
 *   continents, and reading either one wrong is a factor-of-1000 error.
 *
 * Arithmetic runs in minor units. Adding 0.1 and 0.2 in floating point is the
 * classic way to produce a total that is off by a hundredth and impossible to
 * defend.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'

export type MoneyRecord = {
  id: string
  merchant: string
  /** As charged, in major units. Never converted. */
  amount: number
  /** ISO 4217, uppercase. */
  currency: string
  /** YYYY-MM-DD, the date on the receipt — not the date it was read. */
  date: string
  category?: string
  /** "email:<messageId>", "telegram:<messageId>", "manual". The audit trail. */
  source?: string
  /** Card, account, "pix", "cash" — free text, whatever the receipt said. */
  method?: string
  note?: string
  createdAt: string
}

/** Currencies whose minor unit is not 1/100. Everything else is assumed 2. */
const MINOR_DIGITS: Record<string, number> = { JPY: 0, KRW: 0, CLP: 0, ISK: 0, VND: 0, HUF: 0 }

export function minorDigits(currency: string): number {
  return MINOR_DIGITS[currency.toUpperCase()] ?? 2
}

export function moneyId(): string {
  return randomBytes(4).toString('hex')
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const SYMBOLS: [RegExp, string][] = [
  [/R\$/i, 'BRL'],
  [/US\$/i, 'USD'],
  [/€|EUR\b/i, 'EUR'],
  [/£|GBP\b/i, 'GBP'],
  [/\bBRL\b/i, 'BRL'],
  [/\bUSD\b/i, 'USD'],
  [/\bCHF\b/i, 'CHF'],
  // Bare "$" last: R$ and US$ must win, and a lone dollar sign is genuinely
  // ambiguous — it is read as USD only because nothing better matched.
  [/\$/, 'USD'],
]

export function detectCurrency(text: string): string | undefined {
  for (const [re, code] of SYMBOLS) if (re.test(text)) return code
  return undefined
}

/**
 * Turn a written number into a value, resolving the separator convention.
 *
 * Both separators present: the rightmost is the decimal point, which is true in
 * every convention. Only one, followed by exactly two digits: decimal. Only
 * one, followed by three: a thousands group — "1.234" is one thousand two
 * hundred and thirty four on a Brazilian receipt and, on the rare US receipt
 * that means 1.234 of something, not a price anyway.
 */
export function parseDecimal(raw: string): number | undefined {
  const s = raw.replace(/[\s ']/g, '')
  if (!/^\d[\d.,]*$/.test(s)) return undefined
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')

  let decimalAt = -1
  if (lastDot >= 0 && lastComma >= 0) {
    decimalAt = Math.max(lastDot, lastComma)
  } else if (lastDot >= 0 || lastComma >= 0) {
    const at = Math.max(lastDot, lastComma)
    const after = s.length - at - 1
    // A single separator with anything other than 2 trailing digits is a group
    // separator; 3 is the classic case, 0 and 1 are typos worth reading
    // charitably as grouping too.
    if (after === 2) decimalAt = at
  }

  const intPart = (decimalAt >= 0 ? s.slice(0, decimalAt) : s).replace(/[.,]/g, '')
  const fracPart = decimalAt >= 0 ? s.slice(decimalAt + 1) : ''
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) return undefined
  const n = Number(`${intPart || '0'}.${fracPart || '0'}`)
  return Number.isFinite(n) ? n : undefined
}

// Three shapes: symbol first ("R$ 24,50"), symbol last ("45,00 €"), code first
// ("EUR 45.00"). The word boundary hangs off the letter codes only — a € at the
// end of a line has no word boundary after it to find.
const AMOUNT_RE = /(?:R\$|US\$|[€£$])\s*(\d[\d.,\s ']*)|(\d[\d.,\s ']*)\s*(?:R\$|US\$|[€£$]|(?:EUR|BRL|USD|GBP|CHF)\b)|\b(?:EUR|BRL|USD|GBP|CHF)\s*(\d[\d.,\s ']*)/i

/**
 * Pull the amount out of a line of receipt text.
 *
 * Currency is returned only when the text actually said so. A record with a
 * guessed currency is worse than no record: it lands in a total that looks
 * right and is wrong by a factor of six.
 */
export function parseAmount(text: string): { amount: number; currency?: string } | undefined {
  const m = AMOUNT_RE.exec(text)
  if (!m) return undefined
  const digits = (m[1] ?? m[2] ?? m[3] ?? '').trim().replace(/[.,]$/, '')
  const amount = parseDecimal(digits)
  if (amount === undefined) return undefined
  const currency = detectCurrency(m[0])
  return { amount, ...(currency ? { currency } : {}) }
}

/**
 * Normalize to a plain calendar date.
 *
 * Receipts are dated in the merchant's local day, and that is the day the user means
 * when they ask what they spent. Reprojecting a timestamp into some other zone
 * moves late-night purchases into the wrong month, so a timestamp is converted
 * once, in the zone the caller names, and stored as a bare date thereafter.
 */
export function toDateKey(input: string, tz?: string): string | undefined {
  const bare = /^(\d{4})-(\d{2})-(\d{2})/.exec(input.trim())
  if (bare && !/[T ]\d{2}:/.test(input)) return bare[0]
  const t = Date.parse(input)
  if (Number.isNaN(t)) return bare ? bare[0] : undefined
  if (!tz) return new Date(t).toISOString().slice(0, 10)
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz,
  }).format(new Date(t))
  return parts
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function loadMoney(file: string): MoneyRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as MoneyRecord[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: money.json corrupt, moved aside.\n')
    }
    return []
  }
}

export function saveMoney(file: string, records: MoneyRecord[]): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export type MoneyInput = {
  merchant: string
  amount: number
  currency: string
  date: string
  category?: string
  source?: string
  method?: string
  note?: string
  /** Timezone for interpreting a timestamped date. */
  tz?: string
}

/**
 * Add a receipt, or recognise one already recorded.
 *
 * Hourly scans re-read the same inbox, so the same confirmation email is
 * offered to this function again and again. Dedupe is by source message when
 * there is one, and otherwise by the tuple that identifies a charge — two
 * genuinely separate €4.00 coffees at the same bar on the same day do exist,
 * which is why the caller can force one through with a note.
 */
export function recordMoney(
  records: MoneyRecord[],
  input: MoneyInput,
): { records: MoneyRecord[]; record: MoneyRecord; created: boolean } {
  const merchant = input.merchant?.trim()
  if (!merchant) throw new Error('merchant is required')
  if (!Number.isFinite(input.amount)) throw new Error('amount must be a number')
  const currency = input.currency?.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency ?? '')) throw new Error('currency must be a 3-letter ISO code — never guess it')
  const date = toDateKey(input.date ?? '', input.tz)
  if (!date) throw new Error('date must be a calendar date or a timestamp')

  const existing = records.find(r =>
    input.source
      ? r.source === input.source
      : r.merchant.toLowerCase() === merchant.toLowerCase() &&
        r.amount === input.amount && r.currency === currency && r.date === date &&
        (r.note ?? '') === (input.note ?? ''),
  )
  if (existing) return { records, record: existing, created: false }

  const record: MoneyRecord = {
    id: moneyId(),
    merchant,
    amount: input.amount,
    currency: currency!,
    date,
    ...(input.category ? { category: input.category.trim().toLowerCase() } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.method ? { method: input.method } : {}),
    ...(input.note ? { note: input.note } : {}),
    createdAt: new Date().toISOString(),
  }
  records.push(record)
  return { records, record, created: true }
}

export type MoneyQuery = {
  /** Inclusive YYYY-MM-DD bounds. */
  from?: string
  to?: string
  /** "2026-07" — shorthand for a whole month. */
  month?: string
  currency?: string
  merchant?: string
  category?: string
  limit?: number
}

export function queryMoney(records: MoneyRecord[], q: MoneyQuery = {}): MoneyRecord[] {
  const from = q.month ? `${q.month}-01` : q.from
  const to = q.month ? `${q.month}-31` : q.to
  const merchant = q.merchant?.toLowerCase()
  const hits = records.filter(r => {
    if (from && r.date < from) return false
    if (to && r.date > to) return false
    if (q.currency && r.currency !== q.currency.toUpperCase()) return false
    if (q.category && (r.category ?? '') !== q.category.toLowerCase()) return false
    if (merchant && !r.merchant.toLowerCase().includes(merchant)) return false
    return true
  })
  hits.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
  return q.limit ? hits.slice(0, q.limit) : hits
}

export type CurrencyTotal = { currency: string; total: number; count: number }

function sumMinor(records: MoneyRecord[], currency: string): number {
  const scale = 10 ** minorDigits(currency)
  return records.reduce((acc, r) => acc + Math.round(r.amount * scale), 0)
}

/** One total per currency. There is deliberately no grand total. */
export function totalsByCurrency(records: MoneyRecord[]): CurrencyTotal[] {
  const byCur = new Map<string, MoneyRecord[]>()
  for (const r of records) {
    const list = byCur.get(r.currency) ?? []
    list.push(r)
    byCur.set(r.currency, list)
  }
  return [...byCur.entries()]
    .map(([currency, list]) => ({
      currency,
      total: sumMinor(list, currency) / 10 ** minorDigits(currency),
      count: list.length,
    }))
    .sort((a, b) => b.count - a.count || a.currency.localeCompare(b.currency))
}

export type MonthTotals = { month: string; totals: CurrencyTotal[] }

export function totalsByMonth(records: MoneyRecord[]): MonthTotals[] {
  const byMonth = new Map<string, MoneyRecord[]>()
  for (const r of records) {
    const month = r.date.slice(0, 7)
    const list = byMonth.get(month) ?? []
    list.push(r)
    byMonth.set(month, list)
  }
  return [...byMonth.entries()]
    .map(([month, list]) => ({ month, totals: totalsByCurrency(list) }))
    .sort((a, b) => b.month.localeCompare(a.month))
}

export function totalsByCategory(records: MoneyRecord[], currency: string): { category: string; total: number; count: number }[] {
  const cur = currency.toUpperCase()
  const byCat = new Map<string, MoneyRecord[]>()
  for (const r of records) {
    if (r.currency !== cur) continue
    const key = r.category ?? 'uncategorised'
    const list = byCat.get(key) ?? []
    list.push(r)
    byCat.set(key, list)
  }
  const scale = 10 ** minorDigits(cur)
  return [...byCat.entries()]
    .map(([category, list]) => ({ category, total: sumMinor(list, cur) / scale, count: list.length }))
    .sort((a, b) => b.total - a.total)
}

/**
 * Collapse several currencies into one, using rates the caller supplies.
 *
 * Anything without a rate is reported as missing rather than dropped or
 * guessed. A converted total that quietly omits the BRL half of the user’s spending
 * is the specific wrong answer this shape exists to prevent.
 */
export function convertTotals(
  totals: CurrencyTotal[],
  rates: Record<string, number>,
  target: string,
): { target: string; total: number; missing: string[] } {
  const to = target.toUpperCase()
  const scale = 10 ** minorDigits(to)
  let minor = 0
  const missing: string[] = []
  for (const t of totals) {
    if (t.currency === to) { minor += Math.round(t.total * scale); continue }
    const rate = rates[t.currency] ?? rates[`${t.currency}${to}`] ?? rates[`${t.currency}/${to}`]
    if (typeof rate !== 'number' || !Number.isFinite(rate)) { missing.push(t.currency); continue }
    minor += Math.round(t.total * rate * scale)
  }
  return { target: to, total: minor / scale, missing }
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency, minimumFractionDigits: minorDigits(currency),
    }).format(amount)
  } catch {
    return `${amount.toFixed(minorDigits(currency))} ${currency}`
  }
}

export function formatTotals(totals: CurrencyTotal[]): string {
  if (!totals.length) return '(nothing recorded)'
  return totals.map(t => `${formatMoney(t.total, t.currency)} (${t.count})`).join(' · ')
}

export function formatRecord(r: MoneyRecord): string {
  const bits = [r.date, formatMoney(r.amount, r.currency), r.merchant]
  if (r.category) bits.push(`#${r.category}`)
  return bits.join(' · ')
}

export const MONEY_FILE = join(
  process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'),
  'money.json',
)
