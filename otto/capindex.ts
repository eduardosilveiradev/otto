/**
 * The recipes nobody knows exist.
 *
 * `/otto:recipes` ships seven automations. Six of them have never been armed,
 * not because they are bad but because discovering them requires the user to read a
 * skill file the user has no reason to open. Meanwhile the user does the thing by hand —
 * asks about a price for the third time, sets a reminder about a bill — while
 * the automation for exactly that sits one tap away, unmentioned.
 *
 * The obvious fix is a feature tour, and it is the wrong one: a list of seven
 * capabilities the user did not ask about is a proactive message about nothing, which
 * is precisely what CLAUDE.md's high interrupt bar exists to prevent. The
 * discovery mechanism cannot become its own noise source, or it will be muted
 * and take the useful messages with it.
 *
 * So: mention a capability only in the moment its subject comes up, only if it
 * has never been used, only once ever, and at most one per week across all of
 * them. In practice that is a handful of one-line mentions a year, each landing
 * on a turn where the user was already thinking about that exact thing — which is the
 * only moment a suggestion is cheap to read and easy to judge.
 *
 * The mention rides along on the reply the user was getting anyway. It is never a
 * message of its own.
 */

import { isRequest, tokenize, type HistoryLine } from './repetition.ts'

export type Capability = {
  id: string
  /** How the user would refer to it. */
  name: string
  /** Stems that mean this capability applies. Matched against the user’s tokens. */
  covers: string[]
  /** One clause, in the user’s register, describing what arming it would do. */
  blurb: string
}

/**
 * Seeded from `/otto:recipes` plus the two channel features that are equally
 * invisible. Kept as data rather than read from the skill file: the skill is
 * prose written for an agent to instantiate, and parsing it to find trigger
 * words would be a parser that breaks every time the prose improves.
 */
export const CAPABILITIES: Capability[] = [
  {
    id: 'price-watch',
    name: 'price watch',
    covers: ['price', 'cheaper', 'discount', 'stock', 'availabl', 'sold'],
    blurb: 'watch that page daily and only ping you when the price moves',
  },
  {
    id: 'follow-up',
    name: 'follow-up nudge',
    covers: ['reply', 'replied', 'waiting', 'chase', 'heard', 'follow'],
    blurb: 'nudge you in a few days if they still have not replied',
  },
  {
    id: 'bill-reminder',
    name: 'bill reminder',
    covers: ['bill', 'invoice', 'due', 'pay', 'payment', 'rent'],
    blurb: 'remind you a couple of days before it is due',
  },
  {
    id: 'news-digest',
    name: 'news digest',
    covers: ['news', 'happen', 'update', 'digest', 'roundup'],
    blurb: 'send you a short daily digest on those topics',
  },
  {
    id: 'weekly-review',
    name: 'weekly review',
    covers: ['week', 'recap', 'review', 'summar'],
    blurb: 'put together a Sunday recap of the week',
  },
  {
    id: 'open-loops',
    name: 'open-loop sweep',
    covers: ['loop', 'outstand', 'pend', 'hang', 'forgot', 'owe'],
    blurb: 'sweep what is still hanging every Monday morning',
  },
  {
    id: 'snooze',
    name: 'snooze',
    covers: ['busy', 'focus', 'head-down', 'concentrat', 'interrupt', 'quiet'],
    blurb: 'hold everything non-urgent until you say otherwise',
  },
  {
    id: 'proactivity-report',
    name: 'proactivity audit',
    covers: ['annoy', 'noisy', 'nois', 'spam', 'too', 'ping'],
    blurb: 'check which of my pings you actually answer, and retire the rest',
  },
]

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Evidence a capability has been used at all. Deliberately loose in what it
 * accepts — armed trigger gists, capability-log lines, past mentions — because
 * a false "used" costs one missed suggestion and a false "never used" costs a
 * suggestion for something the user already has, which is the more embarrassing of
 * the two by a wide margin.
 */
export type UsageSignal = { at: number; text: string }

export function lastUsed(caps: Capability[], signals: UsageSignal[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of signals) {
    const toks = new Set(tokenize(s.text))
    for (const c of caps) {
      if (!c.covers.some(v => toks.has(v))) continue
      const prev = out.get(c.id)
      if (prev === undefined || s.at > prev) out.set(c.id, s.at)
    }
  }
  return out
}

export function neverUsed(caps: Capability[], usage: Map<string, number>): Capability[] {
  return caps.filter(c => !usage.has(c.id))
}

/** Which capabilities this message is about. Two hits means neither is obvious. */
export function matchLine(caps: Capability[], text: string): Capability[] {
  const toks = new Set(tokenize(text))
  return caps.filter(c => c.covers.some(v => toks.has(v)))
}

// ---------------------------------------------------------------------------
// Surfacing
// ---------------------------------------------------------------------------

/** What has been said, and when. Persisted in runtime.json by the caller. */
export type SurfaceState = {
  /** Epoch ms of the last mention of anything. The weekly cap. */
  lastAt?: number
  /** capability id → when it was mentioned. Mentioned once means never again. */
  mentioned?: Record<string, number>
  /** Capabilities the user declined. Stronger than mentioned: never bring it back. */
  declined?: string[]
}

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export type Mention = {
  capability: Capability
  text: string
  buttons: { label: string; data: string }[]
}

/**
 * Should this turn carry a mention?
 *
 * Every guard here is a way of saying no, and that ratio is intentional: the
 * default for a discovery mechanism has to be silence, because the cost of one
 * unwanted suggestion is not one unwanted suggestion — it is the user learning that
 * Otto pitches things, which taxes every message after it.
 */
export function surface(
  line: HistoryLine,
  usage: Map<string, number>,
  state: SurfaceState,
  now: number,
  caps: Capability[] = CAPABILITIES,
  weekMs = WEEK_MS,
): Mention | null {
  if (!isRequest(line)) return null
  if (state.lastAt !== undefined && now - state.lastAt < weekMs) return null

  const declined = new Set(state.declined ?? [])
  const mentioned = state.mentioned ?? {}

  const hits = matchLine(caps, line.text)
    .filter(c => !usage.has(c.id))
    .filter(c => !declined.has(c.id) && mentioned[c.id] === undefined)

  // Exactly one, or none. Two matches means the message was about neither
  // clearly enough to pick, and guessing is how a helpful line becomes a pitch.
  if (hits.length !== 1) return null

  const c = hits[0]
  return {
    capability: c,
    text: `(side note — I can ${c.blurb}, if that's useful.)`,
    buttons: [
      { label: `arm ${c.name}`, data: `arm capability ${c.id}` },
      { label: 'no thanks', data: `decline capability ${c.id}` },
    ],
  }
}

/** The state after a mention goes out. Recorded before sending, not after. */
export function recordMention(state: SurfaceState, id: string, now: number): SurfaceState {
  return { ...state, lastAt: now, mentioned: { ...(state.mentioned ?? {}), [id]: now } }
}

export function recordDecline(state: SurfaceState, id: string): SurfaceState {
  return { ...state, declined: [...new Set([...(state.declined ?? []), id])] }
}
