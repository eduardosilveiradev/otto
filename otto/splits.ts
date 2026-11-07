/**
 * Money between the user and their friends.
 *
 * A tally of IOUs between the user and each friend, kept per currency. It never
 * moves money and never converts: a euro owed and a real owed stay two numbers.
 * Only pairs that include the user become entries. What a friend owes another
 * friend is never recorded; at most it comes back as a redirect suggestion
 * ("Sara can pay Luca directly"), because that saves the user a transfer.
 *
 * Arithmetic runs in minor units (money.ts minorDigits), for the same reason
 * money.ts does: three people sharing 10.00 must add back up to 10.00.
 *
 * Friend names and the user's own payment handle live only in
 * ~/.otto/state/splits.json and access.json, never in this file.
 */

import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { loadState, saveState } from './statefile.ts'
import { minorDigits, formatMoney, toDateKey } from './money.ts'
import { matchPeople, displayName, slugName, type Person } from './people.ts'

export type SplitEntry = {
  id: string
  /** people.json id when the name resolved to exactly one person, else slugName(name). */
  friend: string
  /** Display name. */
  name: string
  /** Major units. Positive: they owe the user. Negative: the user owes them. */
  amount: number
  /** ISO 4217, uppercase. */
  currency: string
  /** "Weekend dinner", "payment". */
  what: string
  /** YYYY-MM-DD. */
  date: string
  /** Outing slug, "weekend-oct". What `splits(group)` nets across. */
  group?: string
  /** "telegram:<message_id>", "email:<id>". Dedupe key together with friend. */
  source?: string
  settledAt?: string
  createdAt: string
}
export type SplitsState = { entries: SplitEntry[] }

export const SPLITS_FILE = join(process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'), 'splits.json')

export function loadSplits(file = SPLITS_FILE, o: { peek?: boolean } = {}): SplitsState {
  return loadState<SplitsState>(file, () => ({ entries: [] }), x => Array.isArray((x as SplitsState)?.entries), o)
}
export function saveSplits(file: string, s: SplitsState): void {
  saveState(file, s)
}

export const ME = /^(me|i|myself|io|eu)$/i

export type Friend = { id: string; name: string }

/** One match → that person; several → ask which; none → a slug of the name as said. */
export function resolveFriend(people: Person[], name: string): Friend {
  if (!name.trim()) throw new Error('a name is missing — say who')
  const hits = matchPeople(people, name)
  if (hits.length > 1) throw new Error(`more than one ${name}: ${hits.map(displayName).join(', ')} — say which`)
  if (hits.length === 1) return { id: hits[0]!.id, name: displayName(hits[0]!) }
  return { id: slugName(name), name: name.trim() }
}

/** Equal shares in minor units that sum exactly to total; the first (total mod n) get one extra minor unit. */
export function splitEqual(totalMinor: number, n: number): number[] {
  const base = Math.floor(totalMinor / n)
  const extra = totalMinor - base * n
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0))
}

export type SplitInput = {
  paidBy: string            // "me" or a friend's name
  total: number             // major units, > 0
  currency: string
  /** Everyone who shared, "me" included when the user did. Payment: just the recipient. */
  people: string[]
  /** Equal-split denominator when not everyone is named ("84 for four of us"). Default people.length; must be >= people.length. */
  count?: number
  /** Uneven split: name → major units. Must sum to total (to the minor unit), else throw. Its keys are the sharers. */
  shares?: Record<string, number>
  what: string
  date: string
  group?: string
  source?: string
}

const toMajor = (minor: number, cur: string) => Number((minor / 10 ** minorDigits(cur)).toFixed(minorDigits(cur)))

/**
 * Only pairs that include the user become entries:
 *   paid by me   → each friend in people gets +share
 *   paid by F    → if me ∈ people: F gets −myShare; else throw 'not your split — nothing between you and them'
 * A payment is the same call: paidBy me, people [Luca], total 5 → Luca +5 (cancels a −5).
 * Dedupe: an existing entry with the same source and friend is skipped (returned in `already`).
 */
export function addSplit(state: SplitsState, input: SplitInput, people: Person[], now = new Date()): { added: SplitEntry[]; already: SplitEntry[] } {
  if (!Number.isFinite(input.total) || input.total <= 0) throw new Error('total must be a positive amount')
  const currency = input.currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`currency "${input.currency}" is not an ISO code — never guess it, ask`)
  const date = toDateKey(input.date)
  if (!date) throw new Error(`bad date "${input.date}"`)
  const scale = 10 ** minorDigits(currency)
  const totalMinor = Math.round(input.total * scale)

  // name → minor, in the order said; "me" is keyed 'me'.
  const sharers: [string, number][] = []
  if (input.shares && Object.keys(input.shares).length) {
    for (const [k, v] of Object.entries(input.shares)) {
      if (!Number.isFinite(v) || v < 0) throw new Error(`bad share for ${k}`)
      sharers.push([ME.test(k.trim()) ? 'me' : k, Math.round(v * scale)])
    }
    if (sharers.reduce((s, [, m]) => s + m, 0) !== totalMinor) throw new Error('shares do not add up to the total')
  } else {
    const named = input.people.map(p => (ME.test(p.trim()) ? 'me' : p))
    if (!named.length) throw new Error('say who shared it')
    const n = input.count ?? named.length
    if (!Number.isInteger(n) || n < named.length) throw new Error('count is smaller than the people named')
    const eq = splitEqual(totalMinor, n)
    named.forEach((p, i) => sharers.push([p, eq[i]!]))
  }

  const payerIsMe = ME.test(input.paidBy.trim())
  const payer = payerIsMe ? undefined : resolveFriend(people, input.paidBy)
  const out: { f: Friend; minor: number }[] = []
  if (payerIsMe) {
    for (const [p, minor] of sharers) if (p !== 'me') out.push({ f: resolveFriend(people, p), minor })
    if (!out.length) throw new Error('nothing owed: only you shared it')
  } else {
    const mine = sharers.find(([p]) => p === 'me')
    if (!mine) throw new Error('not your split — nothing between you and them')
    out.push({ f: payer!, minor: -mine[1] })
  }

  const added: SplitEntry[] = []
  const already: SplitEntry[] = []
  for (const { f, minor } of out) {
    const dupe = input.source ? state.entries.find(e => e.source === input.source && e.friend === f.id) : undefined
    if (dupe) { already.push(dupe); continue }
    const e: SplitEntry = {
      id: randomBytes(3).toString('hex'), friend: f.id, name: f.name, amount: toMajor(minor, currency), currency,
      what: input.what, date, ...(input.group ? { group: input.group } : {}),
      ...(input.source ? { source: input.source } : {}), createdAt: now.toISOString(),
    }
    state.entries.push(e)
    added.push(e)
  }
  return { added, already }
}

/** Marks unsettled entries matching friend (resolved) and/or group (and currency if given) settled. Returns how many. */
export function settle(state: SplitsState, o: { friend?: string; group?: string; currency?: string }, people: Person[], now = new Date()): number {
  if (!o.friend && !o.group) throw new Error('settle needs a friend or a group')
  const id = o.friend ? resolveFriend(people, o.friend).id : undefined
  let n = 0
  for (const e of state.entries) {
    if (e.settledAt || (id && e.friend !== id) || (o.group && e.group !== o.group) || (o.currency && e.currency !== o.currency)) continue
    e.settledAt = now.toISOString()
    n++
  }
  return n
}

export function removeSplit(state: SplitsState, id: string): SplitEntry | undefined {
  const i = state.entries.findIndex(e => e.id === id)
  return i < 0 ? undefined : state.entries.splice(i, 1)[0]
}

export type Balance = { friend: string; name: string; currency: string; minor: number }   // + they owe the user

/** Unsettled entries summed per friend per currency, zeros dropped, largest |minor| first. */
export function balances(entries: SplitEntry[], o: { friend?: string; group?: string } = {}): Balance[] {
  const needle = o.friend?.trim().toLowerCase()
  const by = new Map<string, Balance>()
  for (const e of entries) {
    if (e.settledAt || (o.group && e.group !== o.group) || (needle && !e.name.toLowerCase().includes(needle))) continue
    const k = `${e.friend}|${e.currency}`
    const b = by.get(k) ?? { friend: e.friend, name: e.name, currency: e.currency, minor: 0 }
    b.minor += Math.round(e.amount * 10 ** minorDigits(e.currency))
    by.set(k, b)
  }
  return [...by.values()].filter(b => b.minor !== 0).sort((a, b) => Math.abs(b.minor) - Math.abs(a.minor))
}

export type Plan = {
  currency: string
  /** Every balance as it stands, before redirects. */
  gross: Balance[]
  owed: Balance[]               // they owe the user, after redirects
  owe: Balance[]                // the user owes them, after redirects (minor negative)
  netMinor: number              // sum of all balances in this currency
  redirects: { from: string; to: string; minor: number }[]   // a debtor of the user pays the user's creditor directly
}

/**
 * Per currency: greedy-match the user's debtors (largest first) against the user's creditors (largest first);
 * each match is a redirect and reduces both. What remains is what the user sends or receives. Never across currencies.
 */
// ponytail: redirects are a suggestion over the user's own pairs only; friend-to-friend debts aren't tracked, so a full group min-cash-flow is out of reach. Track every participant if they ask for that.
export function netPlan(bs: Balance[]): Plan[] {
  const currencies = [...new Set(bs.map(b => b.currency))]
  return currencies.map(currency => {
    const gross = bs.filter(b => b.currency === currency)
    const debt = gross.filter(b => b.minor > 0).map(b => ({ ...b })).sort((a, b) => b.minor - a.minor)
    const cred = gross.filter(b => b.minor < 0).map(b => ({ ...b })).sort((a, b) => a.minor - b.minor)
    const redirects: Plan['redirects'] = []
    let i = 0, j = 0
    while (i < debt.length && j < cred.length) {
      const amt = Math.min(debt[i]!.minor, -cred[j]!.minor)
      redirects.push({ from: debt[i]!.name, to: cred[j]!.name, minor: amt })
      debt[i]!.minor -= amt
      cred[j]!.minor += amt
      if (!debt[i]!.minor) i++
      if (!cred[j]!.minor) j++
    }
    return {
      currency, gross, redirects,
      owed: debt.filter(b => b.minor > 0), owe: cred.filter(b => b.minor < 0),
      netMinor: gross.reduce((s, b) => s + b.minor, 0),
    }
  })
}

export const DEFAULT_APPS: Record<string, string> = { USD: 'Venmo' }
export type SplitsConfig = { apps?: Record<string, string>; handles?: Record<string, string> }

/** apps[currency] ?? DEFAULT_APPS[currency] ?? 'bank transfer'. */
export function payApp(currency: string, cfg?: SplitsConfig): string {
  return cfg?.apps?.[currency] ?? DEFAULT_APPS[currency] ?? 'bank transfer'
}

const COPY_MAX = 256

/** The message the user pastes to a friend who owes them. handle = the user's own payment handle (Venmo @, IBAN, phone number). Always ≤ 256 chars (cut `what` first). */
export function requestText(b: Balance, what: string | undefined, cfg?: SplitsConfig): string {
  const app = payApp(b.currency, cfg)
  const handle = cfg?.handles?.[app]
  const tail = `${formatMoney(Math.abs(b.minor) / 10 ** minorDigits(b.currency), b.currency)} via ${app}${handle ? ` (${handle})` : ''}`
  const room = COPY_MAX - tail.length - 3
  const head = what && room > 1 ? `${what.length > room ? `${what.slice(0, room - 1)}…` : what} — ` : ''
  return (head + tail).slice(0, COPY_MAX)
}

/** What the `splits` tool prints. `what` is an outing slug or label; it heads the request lines. */
export function formatPlans(plans: Plan[], what: string | undefined, cfg?: SplitsConfig): string {
  if (!plans.length) return '(all square)'
  const label = what ? what.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase()) : undefined
  return plans.map(p => {
    const cur = p.currency
    const fmt = (minor: number) => formatMoney(Math.abs(minor) / 10 ** minorDigits(cur), cur)
    const app = payApp(cur, cfg)
    const lines = [`${cur} — ${p.gross.map(b => (b.minor < 0 ? `you owe ${b.name} ${fmt(b.minor)}` : `${b.name} owes you ${fmt(b.minor)}`)).join(' · ')}`]
    const via = p.redirects.map(r => `${r.from} can pay ${r.to} ${fmt(r.minor)} directly`)
    const sends = p.owe.map(b => `${b.name} ${fmt(b.minor)}`)
    if (via.length) {
      const sent = p.owe.reduce((s, b) => s - b.minor, 0)
      const got = p.owed.reduce((s, b) => s + b.minor, 0)
      const tail = sent ? `send ${fmt(sent)}` : got ? `receive ${fmt(got)}` : 'even'
      const rest = sent ? `; you send ${sends.join(', ')} on ${app}` : got ? `; ${p.owed.map(b => `${b.name} sends you ${fmt(b.minor)}`).join(', ')}` : ''
      lines.push(`net: ${tail} (${via.join('; ')}${rest})`)
    } else {
      for (const b of p.owe) lines.push(`net: send ${fmt(b.minor)} to ${b.name} on ${app}`)
      for (const b of p.owed) lines.push(`net: ${b.name} sends you ${fmt(b.minor)}`)
    }
    for (const b of p.owed) lines.push(`request ${b.name}: ${requestText(b, label, cfg)}`)
    // A debtor whose money was redirected may still need asking if the redirect falls through.
    if (via.length) for (const b of p.gross) if (b.minor > 0 && !(p.owed.find(o => o.friend === b.friend)?.minor === b.minor)) lines.push(`request ${b.name} (if not redirecting): ${requestText(b, label, cfg)}`)
    return lines.join('\n')
  }).join('\n\n')
}
