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

import { readFileSync, writeFileSync, renameSync } from 'fs'

export type Priority = 'urgent' | 'normal'

export type QueuedMessage = {
  id: string
  chat_id: string
  text: string
  queuedAt: string
  reason: HoldReason
  /** Held messages carrying buttons or files are delivered on their own rather
   * than folded into the digest — coalescing would strip the very thing that
   * makes them actionable. */
  buttons?: { label: string; data: string }[]
  files?: string[]
}

export function isRich(m: QueuedMessage): boolean {
  return Boolean(m.buttons?.length || m.files?.length)
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

export function loadQueue(file: string): QueuedMessage[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as QueuedMessage[]) : []
  } catch {
    return []
  }
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
 * header names the delay: arriving silently late reads like Otto sat on
 * something, and saying so costs one line.
 */
export function coalesce(messages: QueuedMessage[]): string[] {
  if (!messages.length) return []
  // Anything held for a flight makes the whole flush a landing digest — it is
  // one send either way, and "while you were in the air" says why it waited.
  const place = messages.some(m => m.reason === 'inflight') ? 'in the air' : 'away'
  const header =
    messages.length === 1
      ? `held while you were ${place}:`
      : `held while you were ${place} (${messages.length}):`
  const out: string[] = []
  let current = header

  for (const m of messages) {
    const piece = `\n\n— ${m.text}`
    if (current.length + piece.length > COALESCE_LIMIT) {
      out.push(current)
      current = piece.trimStart()
    } else {
      current += piece
    }
  }
  if (current.trim()) out.push(current)
  return out
}
