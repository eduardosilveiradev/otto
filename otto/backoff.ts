/**
 * A cadence is a guess made once. The evidence it is wrong is six wakes in a
 * row with nothing to say, so the channel offers once to slow the trigger down:
 * [every 2h] / [daily] / [keep it]. This module only decides and rewrites a
 * copy; it never changes a trigger itself — the tap does (server.ts).
 */
import { Cron } from 'croner'
import { gistOf } from './brief.ts'

export type Choice = '2h' | 'daily' | 'keep'

export type BackoffFields = {
  /** Consecutive runs with no send attributed to this trigger. Bumped when a run starts, zeroed by the first reply that carries its src. */
  silentRuns?: number
  /** The one offer per schedule. `offeredFor` is the schedule it was made about: a different schedule means a fresh count and a fresh offer. */
  backoff?: { offeredFor: string; at: string; pending: boolean; decision?: Choice }
}

export type BackoffTrigger = BackoffFields & {
  id: string
  action: string
  schedule?: string
  repeating: boolean
  enabled: boolean
  tz?: string
}

export const THRESHOLD = 6

/** A 5-field cron whose minute or hour field is not a single number fires more than once a day. ISO one-shots and daily crons are false. */
export function subDaily(schedule?: string): boolean {
  const f = schedule?.trim().split(/\s+/)
  if (!f || f.length !== 5) return false
  return !/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1])
}

/** +1 for an enabled repeating sub-daily trigger, untouched otherwise. Returns a new object. */
export function startRun<T extends BackoffTrigger>(t: T): T {
  if (!t.enabled || !t.repeating || !subDaily(t.schedule)) return { ...t }
  return { ...t, silentRuns: (t.silentRuns ?? 0) + 1 }
}

/** Fires in one day for a minute/hour pair, counted up to `cap`. The day fields are left open: dom/month/dow are kept as they are, so they cancel out. */
function perDay(min: string, hour: string, cap = 24): number {
  const c = new Cron(`${min} ${hour} * * *`, { timezone: 'UTC' })
  const start = Date.UTC(2026, 0, 5)
  let n = 0
  for (let d = c.nextRun(new Date(start - 1)); d && d.getTime() < start + 86_400_000 && n < cap; d = c.nextRun(d)) n++
  return n
}

/**
 * The schedule slowed to the choice, or null when the result would not fire less often than the
 * original (2h for a single hour, every 3h, or 8,18). Keeps dom/month/dow.
 *  2h:    minute -> m if single int else '0'; hour -> 'a-b/2' for a range, otherwise '*\/2'
 *  daily: minute -> m if single int else '0'; hour -> h if single int, else the range start, else '9'
 */
export function slowed(schedule: string, choice: '2h' | 'daily'): string | null {
  const f = schedule.trim().split(/\s+/)
  if (f.length !== 5) return null
  const [min, hour, ...rest] = f
  const m = /^\d+$/.test(min) ? min : '0'
  const range = /^(\d+)-(\d+)$/.exec(hour)
  const h = choice === '2h'
    ? (range ? `${range[1]}-${range[2]}/2` : '*/2')
    : (/^\d+$/.test(hour) ? hour : range ? range[1] : '9')
  try {
    const after = perDay(m, h)   // at most 12: one minute, one hour or every other hour
    return after < perDay(min, hour, after + 1) ? [m, h, ...rest].join(' ') : null
  } catch {
    return null   // a schedule croner can't read is never slowed, and never throws into the scheduler tick
  }
}

export type Offer<T> = { trigger: T; text: string; buttons: { label: string; data: string }[] }

const short = (action: string) => {
  const g = gistOf(action)
  return g.length > 48 ? g.slice(0, 48) + '…' : g
}

/**
 * Null unless the trigger is enabled, repeating, sub-daily, silent for `threshold` runs, has
 * not already been offered for this schedule, and daily would actually be slower. The returned trigger carries the pending offer:
 * persist it before sending.
 */
export function planOffer<T extends BackoffTrigger>(t: T, now: number, threshold = THRESHOLD): Offer<T> | null {
  if (!t.enabled || !t.repeating || !t.schedule || !subDaily(t.schedule)) return null
  const n = t.silentRuns ?? 0
  if (n < threshold || t.backoff?.offeredFor === t.schedule || !slowed(t.schedule, 'daily')) return null
  const buttons: Offer<T>['buttons'] = []
  if (slowed(t.schedule, '2h')) buttons.push({ label: 'every 2h', data: `backoff ${t.id} 2h` })
  buttons.push({ label: 'daily', data: `backoff ${t.id} daily` }, { label: 'keep it', data: `backoff ${t.id} keep` })
  return {
    trigger: { ...t, backoff: { offeredFor: t.schedule, at: new Date(now).toISOString(), pending: true } },
    text: `\`${short(t.action)}\`: ${n} checks in a row with nothing to say. check less often?`,
    buttons,
  }
}

export const TAP_RE = /^backoff ([a-z0-9-]+) (2h|daily|keep)$/

export type TapResult<T> =
  | { ok: true; triggers: T[]; trigger: T; schedule?: string; line: string }
  | { ok: false; line: string }

const STALE = { ok: false, line: 'that offer is out of date' } as const

/**
 * Only the offer the server made and still has pending, about the schedule the trigger still has.
 * New array, no mutation of the input.
 */
export function applyTap<T extends BackoffTrigger>(triggers: T[], instruction: string, now: number): TapResult<T> {
  const m = TAP_RE.exec(instruction.trim())
  if (!m) return { ok: false, line: 'not a backoff tap' }
  const [, id, choice] = m as unknown as [string, string, Choice]
  const t = triggers.find(x => x.id === id)
  if (!t?.backoff?.pending || !t.schedule || t.backoff.offeredFor !== t.schedule) return STALE
  const at = new Date(now).toISOString()
  let next: T
  let schedule: string | undefined
  let line: string
  if (choice === 'keep') {
    next = { ...t, backoff: { ...t.backoff, pending: false, decision: 'keep' } }
    line = `kept ${short(t.action)} as is`
  } else {
    const s = slowed(t.schedule, choice)
    if (!s) return STALE
    schedule = s
    next = { ...t, schedule: s, silentRuns: 0, backoff: { offeredFor: s, at, pending: false, decision: choice } }
    line = `${short(t.action)} now runs ${s}; it was ${t.schedule}`
  }
  return { ok: true, triggers: triggers.map(x => (x === t ? next : x)), trigger: next, schedule, line }
}
