/**
 * Has the user already heard this?
 *
 * CLAUDE.md says "never two proactive messages about the same underlying thing",
 * and until now that rule was enforced entirely by whichever session happened to
 * be composing the message. That works inside one turn and fails everywhere
 * else, because the parts of Otto that speak cannot see each other: the morning
 * brief, the hourly scan, the loops sweep and a bill trigger can each notice the
 * same unpaid invoice and each independently decide it is worth mentioning.
 *
 * The failure the user actually reported is the restart burst. Start a session after
 * Otto has been down a while and every trigger that came due fires at once, so
 * five sends land in the same second, mostly about the same thing. No single
 * send is wrong; the set is.
 *
 * So the check moves out of the session and into the send path, where it can see
 * every outbound message regardless of which trigger produced it. Each send
 * carries a topic key, and a second send under a key used recently is dropped
 * unless its content materially changed.
 *
 * "Materially changed" is doing real work here. A bill reminder whose amount
 * moved from €84.30 to €112.00 is news; the same reminder reworded is not. So
 * similarity is measured over tokens with the digits left in — a changed number
 * changes the token set and the message goes out.
 *
 * Urgent never suppresses. The escape hatch stays exactly where queue.ts put it:
 * reminders they set, replies to them, OTPs and security alerts are not subject to
 * anybody's opinion about whether the user has heard this before.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'

export type TopicRecord = {
  key: string
  /** ISO time of the last send that actually went out under this key. */
  lastSentAt: string
  /** The text that went out, kept so the next send can be compared against it. */
  lastText: string
  /** Telegram message_id of that send, when known — lets a change edit in place. */
  lastMessageId?: number
  /** Sends allowed through under this key, ever. Feeds the proactivity report. */
  sends: number
  /** Sends dropped under this key, ever. The number worth showing the user. */
  suppressed: number
}

export type TopicState = Record<string, TopicRecord>

export type SendCandidate = {
  text: string
  /** Explicit topic. Falls back to the send's `src` attribution. */
  key?: string
  /** "trigger:<id>", "email-scan", "webhook", "queue-flush" — as in ledger.ts. */
  src?: string
  priority?: 'urgent' | 'normal'
}

export type TopicDecision =
  | { action: 'send'; key: string; why: 'new-topic' | 'stale-topic' | 'changed' | 'urgent' }
  | { action: 'suppress'; key: string; why: 'burst' | 'unchanged'; previousAt: string; agoMs: number }
  | { action: 'replace'; key: string; why: 'changed-recently'; messageId: number; previousAt: string }

/** Two sends this close together are one event arriving twice (the restart burst). */
export const BURST_MS = 2 * 60 * 1000
/** How long a topic stays "recently said". */
export const TOPIC_WINDOW_MS = 6 * 60 * 60 * 1000
/** Jaccard overlap at or above which two texts are the same news. */
export const SAME_NEWS = 0.82
/** Below this, a burst-window send is a genuinely different thing that happened to land together. */
export const BURST_SAME_NEWS = 0.5

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'is',
  'are', 'was', 'it', 'this', 'that', 'you', 'your', 'i', 'be', 'has', 'have',
])

/**
 * Digits survive tokenisation on purpose: amounts, dates and counts are usually
 * the only part of a recurring message that carries new information.
 */
export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter(t => t.length > 1 && !STOP.has(t)),
  )
}

/** Jaccard overlap. 1 means the same words, 0 means nothing shared. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.size && !tb.size) return 1
  if (!ta.size || !tb.size) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return shared / (ta.size + tb.size - shared)
}

export function resolveKey(c: SendCandidate): string {
  const key = c.key?.trim() || c.src?.trim() || 'unattributed'
  return key.toLowerCase()
}

/**
 * The whole policy, as one pure function so it can be tested without a socket.
 *
 * `replace` is offered only when the previous message is still the newest thing
 * Otto said on the subject and its id is known — editing a message the user has
 * already scrolled past is worse than saying nothing, because the user never sees it.
 */
export function decideSend(
  state: TopicState,
  candidate: SendCandidate,
  opts: { now?: number; windowMs?: number; burstMs?: number; canReplace?: boolean } = {},
): TopicDecision {
  const now = opts.now ?? Date.now()
  const windowMs = opts.windowMs ?? TOPIC_WINDOW_MS
  const burstMs = opts.burstMs ?? BURST_MS
  const key = resolveKey(candidate)

  if (candidate.priority === 'urgent') return { action: 'send', key, why: 'urgent' }

  const prior = state[key]
  if (!prior) return { action: 'send', key, why: 'new-topic' }

  const prevAt = Date.parse(prior.lastSentAt)
  if (Number.isNaN(prevAt)) return { action: 'send', key, why: 'new-topic' }

  const agoMs = now - prevAt
  if (agoMs > windowMs) return { action: 'send', key, why: 'stale-topic' }

  const sim = similarity(prior.lastText, candidate.text)

  // The restart burst: near-simultaneous sends on one topic are one event.
  if (agoMs <= burstMs && sim >= BURST_SAME_NEWS) {
    return { action: 'suppress', key, why: 'burst', previousAt: prior.lastSentAt, agoMs }
  }

  if (sim >= SAME_NEWS) {
    return { action: 'suppress', key, why: 'unchanged', previousAt: prior.lastSentAt, agoMs }
  }

  if (opts.canReplace && prior.lastMessageId !== undefined) {
    return {
      action: 'replace',
      key,
      why: 'changed-recently',
      messageId: prior.lastMessageId,
      previousAt: prior.lastSentAt,
    }
  }

  return { action: 'send', key, why: 'changed' }
}

/** Called after a send actually goes out (or is edited in place). */
export function recordSend(
  state: TopicState,
  key: string,
  text: string,
  opts: { now?: number; messageId?: number } = {},
): TopicState {
  const now = new Date(opts.now ?? Date.now()).toISOString()
  const prior = state[key]
  state[key] = {
    key,
    lastSentAt: now,
    lastText: text,
    ...(opts.messageId !== undefined
      ? { lastMessageId: opts.messageId }
      : prior?.lastMessageId !== undefined
        ? { lastMessageId: prior.lastMessageId }
        : {}),
    sends: (prior?.sends ?? 0) + 1,
    suppressed: prior?.suppressed ?? 0,
  }
  return state
}

/** Called when a send was dropped, so the count is visible in the report. */
export function recordSuppressed(state: TopicState, key: string): TopicState {
  const prior = state[key]
  if (!prior) return state
  prior.suppressed++
  return state
}

/** Topics nobody has touched in a fortnight are not topics any more. */
export function pruneTopics(state: TopicState, now = Date.now(), maxAgeMs = 14 * 24 * 60 * 60 * 1000): TopicState {
  for (const [key, rec] of Object.entries(state)) {
    const at = Date.parse(rec.lastSentAt)
    if (Number.isNaN(at) || now - at > maxAgeMs) delete state[key]
  }
  return state
}

export function loadTopics(file: string): TopicState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as TopicState) : {}
  } catch {
    return {}
  }
}

export function saveTopics(file: string, state: TopicState): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

/** One line for the log, so a dropped send is never invisible to the user. */
export function explain(d: TopicDecision): string {
  if (d.action === 'send') return `topic ${d.key}: sending (${d.why})`
  if (d.action === 'replace') return `topic ${d.key}: editing message ${d.messageId} (${d.why})`
  const mins = Math.round(d.agoMs / 60000)
  return `topic ${d.key}: suppressed (${d.why}, said ${mins}m ago)`
}
