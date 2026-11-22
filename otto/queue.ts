/**
 * When a proactive message is allowed to land.
 *
 * Otto had exactly one interrupt control: a static quiet-hours window that
 * suppressed email scans. Everything else — every trigger, every scan result —
 * went straight to Telegram the moment it was ready, however many of them there
 * were and whatever the user was doing.
 *
 * Four holds, in order of authority:
 *   snooze   the user asked for silence until a specific time
 *   inflight a booked flight is in the air (trips.json; see triplife.ts)
 *   busy     the calendar says the user is in something right now
 *   quiet    the configured quiet-hours window
 *
 * A held message is not dropped. It goes to queue.json and is flushed when the
 * hold lifts, coalesced into one send so that four held triggers arrive as one
 * message and not as a burst of four.
 *
 * `urgent` bypasses all three — that is the escape hatch for the explicit
 * reminders CLAUDE.md promises will always fire. The policy lives here, apart
 * from the Telegram plumbing, because it is the part worth testing.
 */

import type { Message } from './pips.ts'
import type { Card } from './cards.ts'
import { loadState } from './statefile.ts'
import { writeFileSync, renameSync } from 'fs'

export type Priority = 'urgent' | 'normal'

export type QueuedMessage = {
  conversation?: Message
  id: string
  chat_id: string
  text: string
  queuedAt: string
  reason: HoldReason
  /** Held messages carrying buttons, files or a card are delivered on their own rather
   * than folded into the digest — coalescing would strip the very thing that
   * makes them actionable. */
  buttons?: { label: string; data?: string; url?: string; copy?: string }[]
  files?: string[]
  card?: Card
  /** Attribution at enqueue time, so the flushed message can still answer "Why this?" (why.ts). */
  src?: string
  why?: string
}

export function isRich(m: QueuedMessage): boolean {
  return Boolean(m.conversation || m.buttons?.length || m.files?.length || m.card)
}

export type HoldReason = 'snooze' | 'inflight' | 'busy' | 'quiet'

export type HoldState = {
  /** ISO time silence was asked for, if any. */
  snoozeUntil?: string
  /** ISO end of the calendar event the user is currently inside, if any. */
  busyUntil?: string
  /** Whether the configured quiet-hours window is active right now. */
  inQuietHours?: boolean
  /** ISO time a flight the user is on lands (plus taxi-in), if airborne now. */
  airborneUntil?: string
}

/**
 * Returns the reason to hold, or null to send now.
 *
 * Quiet hours deliberately do NOT hold conversation. If the user is awake and texting
 * at 01:00 the window is wrong about the user, and answering is obviously right —
 * so the caller passes `conversational` when there is a live exchange.
 */
export function holdReason(
  state: HoldState,
  opts: { priority: Priority; conversational: boolean; now?: number },
): HoldReason | null {
  if (opts.priority === 'urgent') return null
  if (opts.conversational) return null
  const now = opts.now ?? Date.now()

  const snooze = Date.parse(state.snoozeUntil ?? '')
  if (!Number.isNaN(snooze) && snooze > now) return 'snooze'

  // Ahead of busy: the calendar often carries the flight as an event too, and
  // the landing digest is the better name for what the user gets afterwards.
  const air = Date.parse(state.airborneUntil ?? '')
  if (!Number.isNaN(air) && air > now) return 'inflight'

  const busy = Date.parse(state.busyUntil ?? '')
  if (!Number.isNaN(busy) && busy > now) return 'busy'

  if (state.inQuietHours) return 'quiet'
  return null
}

/** The moment a hold is expected to lift, for telling the user when it will land. */
export function holdUntil(state: HoldState, reason: HoldReason): string | undefined {
  if (reason === 'snooze') return state.snoozeUntil
  if (reason === 'busy') return state.busyUntil
  if (reason === 'inflight') return state.airborneUntil
  return undefined
}

/** An unreadable file is moved aside (statefile.ts), not read as empty: the next save would
 * otherwise overwrite every held message without a word. */
export function loadQueue(file: string): QueuedMessage[] {
  return loadState<QueuedMessage[]>(file, () => [], Array.isArray)
}

export function saveQueue(file: string, q: QueuedMessage[]): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(q, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

const COALESCE_LIMIT = 3500

/**
 * Fold a chat's held messages into as few sends as possible.
 *
 * Held messages were written minutes or hours apart and each one opens with its
 * own context, so they are joined with a rule rather than run together. The
 * first message leads, because the lock screen shows only the opening line and
 * "held while you were away (4):" tells the user nothing worth unlocking for.
 * The delay is still named, in a footer: arriving silently late reads like Otto
 * sat on something, and saying so costs one line.
 */
export function coalesce(messages: QueuedMessage[]): string[] {
  return coalesceChunks(messages).map(c => c.text)
}

/** coalesce, with the messages each send carries: a flush that fails on the second send puts back
 * only those, not the first send's too (which already went). */
export function coalesceChunks(messages: QueuedMessage[]): { text: string; messages: QueuedMessage[] }[] {
  if (!messages.length) return []
  // Anything held for a flight makes the whole flush a landing digest — it is
  // one send either way, and "while you were in the air" says why it waited.
  const place = messages.some(m => m.reason === 'inflight') ? 'in the air' : 'away'
  const footer =
    messages.length === 1
      ? `\n\n(held while you were ${place})`
      : `\n\n(${messages.length} held while you were ${place})`
  const out: { text: string; messages: QueuedMessage[] }[] = []
  let current = '', carried: QueuedMessage[] = []

  for (const m of messages) {
    const piece = messages.length === 1 ? m.text : `— ${m.text}`
    if (current && current.length + piece.length + 2 + footer.length > COALESCE_LIMIT) {
      out.push({ text: current, messages: carried })
      current = piece
      carried = [m]
    } else {
      current = current ? `${current}\n\n${piece}` : piece
      carried.push(m)
    }
  }
  out.push({ text: current + footer, messages: carried })
  return out
}

/**
 * The queue after a flush: what it couldn't send, then anything queued while it was sending.
 * A flush works from a snapshot and awaits the network, so saving only its leftovers would
 * erase a message enqueued in between.
 */
export function afterFlush(latest: QueuedMessage[], taken: QueuedMessage[], failed: QueuedMessage[]): QueuedMessage[] {
  const took = new Set(taken.map(m => m.id)), retry = new Set(failed.map(m => m.id))
  // The latest copy of each: one burned or deleted while the flush was sending stays that way.
  return [...latest.filter(m => retry.has(m.id)), ...latest.filter(m => !took.has(m.id))]
}
