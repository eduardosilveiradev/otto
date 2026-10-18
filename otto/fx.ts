/**
 * Reference rates, for annotation only.
 *
 * money.ts keeps every amount in the currency it was charged in and every total
 * per currency, and that rule stands. This file adds one thing beside it: when
 * Otto shows an amount in something other than the user's home currency, an
 * approximate home-currency figure next to it — "R$ 120,00 (≈ €19.40, ECB 10 Oct)"
 * — so a number in a currency they think less in still means something at a
 * glance. The figure is a label, never an input: nothing here is summed, and a
 * converted amount is never added to another one.
 *
 * The source is the ECB's daily reference rates: free, keyless, EUR-based, one
 * update per working day. They are cached in the state dir with the date the
 * ECB stamped on them, fetched at most once a day, and when the network is gone
 * the last cache keeps working — labelled with its own date, so a three-week-old
 * rate says so instead of passing for today's.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { minorDigits, formatMoney } from './money.ts'

export const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'

export const FX_FILE = join(
  process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'),
  'fx.json',
)

/** access.json `money.home` when unset or unusable. */
export const DEFAULT_HOME = 'EUR'

export type FxRates = {
  /** YYYY-MM-DD — the date the ECB published these for, not when they were fetched. */
  date: string
  /** Units of each currency per 1 EUR. EUR itself is always 1. */
  rates: Record<string, number>
}

export type FxCache = FxRates & {
  /** ISO time of the last successful fetch. */
  fetchedAt: string
  /** ISO time of the last attempt, successful or not — the retry throttle. */
  attemptedAt?: string
}

/** The home currency from access.json's `money.home`; anything that is not a 3-letter code is ignored. */
export function homeCurrency(money?: { home?: unknown } | null): string {
  const raw = typeof money?.home === 'string' ? money.home.trim().toUpperCase() : ''
  return /^[A-Z]{3}$/.test(raw) ? raw : DEFAULT_HOME
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Read the ECB daily XML. The shape is a dated `<Cube time="…">` holding one
 * `<Cube currency="USD" rate="1.0897"/>` per currency. Anything without a date
 * or without a single usable rate is undefined, so a captive-portal page or a
 * truncated body can never overwrite a good cache.
 */
export function parseEcbXml(xml: string): FxRates | undefined {
  const date = /<Cube\s+time\s*=\s*['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1]
  if (!date) return undefined
  const rates: Record<string, number> = { EUR: 1 }
  const re = /<Cube\s+currency\s*=\s*['"]([A-Za-z]{3})['"]\s+rate\s*=\s*['"]([\d.]+)['"]/g
  let found = 0
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const rate = Number(m[2])
    if (!Number.isFinite(rate) || rate <= 0) continue
    rates[m[1].toUpperCase()] = rate
    found++
  }
  return found ? { date, rates } : undefined
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export function loadFx(file: string = FX_FILE): FxCache | undefined {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as FxCache
    if (typeof j?.date !== 'string' || !j.rates || typeof j.rates !== 'object') return undefined
    return j
  } catch {
    return undefined
  }
}

export function saveFx(file: string, cache: FxCache): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

/** A failed fetch is retried after this long, so an offline day is not a fetch per tool call. */
const RETRY_MS = 60 * 60 * 1000

export type RefreshResult = {
  rates?: FxRates
  /** True when the rates are a cache kept because today's fetch failed. */
  stale: boolean
  /** Why the fetch failed, when it did. */
  error?: string
}

/**
 * The rates to annotate with, fetching at most once per UTC day.
 *
 * A cache fetched today is used as is. Otherwise one fetch is tried; on any
 * failure — network, HTTP status, an unparseable body — the old cache is kept
 * and returned with `stale: true`, its date unchanged, and the next attempt
 * waits an hour. `fetch` and `now` are injectable so tests never touch the
 * network.
 */
export async function refreshFx(opts: {
  file?: string
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  now?: number
  timeoutMs?: number
} = {}): Promise<RefreshResult> {
  const file = opts.file ?? FX_FILE
  const now = opts.now ?? Date.now()
  const doFetch = opts.fetch ?? fetch
  const cache = loadFx(file)
  const today = new Date(now).toISOString().slice(0, 10)

  if (cache?.fetchedAt?.slice(0, 10) === today) return { rates: pick(cache), stale: false }
  if (cache?.attemptedAt && now - Date.parse(cache.attemptedAt) < RETRY_MS) {
    return { rates: pick(cache), stale: true }
  }

  let error: string
  try {
    const res = await doFetch(ECB_URL, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const parsed = parseEcbXml(await res.text())
    if (!parsed) throw new Error('no rates in the response')
    const at = new Date(now).toISOString()
    saveFx(file, { ...parsed, fetchedAt: at, attemptedAt: at })
    return { rates: parsed, stale: false }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  if (cache) {
    try { saveFx(file, { ...cache, attemptedAt: new Date(now).toISOString() }) } catch {}
    return { rates: pick(cache), stale: true, error }
  }
  return { stale: true, error }
}

function pick(c: FxCache): FxRates {
  return { date: c.date, rates: c.rates }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Convert an amount in `from`'s minor units into `to`'s minor units, crossing
 * through EUR. Undefined when either side has no rate — never a guess.
 *
 * Minor units are each currency's own: 12000 BRL centavos is R$ 120,00, and
 * 1500 JPY is ¥1,500 because the yen has no minor unit.
 */
export function convert(
  amountMinor: number,
  from: string,
  to: string,
  rates: FxRates | undefined,
): number | undefined {
  const f = from.toUpperCase()
  const t = to.toUpperCase()
  if (!Number.isFinite(amountMinor)) return undefined
  if (f === t) return Math.round(amountMinor)
  const rf = f === 'EUR' ? 1 : rates?.rates[f]
  const rt = t === 'EUR' ? 1 : rates?.rates[t]
  if (!rf || !rt) return undefined
  const major = amountMinor / 10 ** minorDigits(f)
  return Math.round((major / rf) * rt * 10 ** minorDigits(t))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-10-10" → "10 Oct". Read off the string, so no timezone can shift the day. */
export function rateDateLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`
}

/**
 * The suffix that goes beside a foreign amount: "(≈ €19.40, ECB 10 Oct)".
 * Empty when the amount is already in the home currency or there is no rate
 * for it — an amount with no annotation is still correct, one with a made-up
 * annotation is not.
 */
export function annotate(
  amountMinor: number,
  currency: string,
  home: string,
  rates: FxRates | undefined,
): string {
  if (currency.toUpperCase() === home.toUpperCase() || !rates) return ''
  const converted = convert(amountMinor, currency, home, rates)
  if (converted === undefined) return ''
  const h = home.toUpperCase()
  return `(≈ ${formatMoney(converted / 10 ** minorDigits(h), h)}, ECB ${rateDateLabel(rates.date)})`
}

/**
 * The same, for an amount in major units as money.ts stores it — the shape the
 * formatters in money.ts accept as their annotator.
 */
export function annotator(home: string, rates: FxRates | undefined): (amount: number, currency: string) => string {
  return (amount, currency) =>
    annotate(Math.round(amount * 10 ** minorDigits(currency)), currency, home, rates)
}
