/**
 * "Why this?" — where an unprompted message came from, in words the server can
 * state from its own data. Never from the model: the app shows this under a
 * long-press, and an explanation the model invented would be worse than none.
 *
 * Pure: the caller looks the trigger up and passes the clock.
 */

import { gistOf } from './brief.ts'
import type { HoldReason } from './queue.ts'

export type TriggerLike = {
  id: string
  type: 'cron' | 'email'
  schedule?: string
  tz?: string
  condition?: string
  action: string
  repeating: boolean
}

export type WhyContext = {
  now: number
  tz: string
  /** injectEvent extraMeta (last_scan, webhook_source, …). */
  meta?: Record<string, string>
  /** Looked up by the caller for src `trigger:<id>`; null = since removed. */
  trigger?: TriggerLike | null
  /** access.emailScanMinutes ?? 60. */
  scanMinutes?: number
  /** Queue flush only. */
  hold?: { reason: HoldReason; count: number; inner?: string }
}

/** The channel's own 'trigger' injections, told apart by the meta key each one carries. */
const NUDGES: [string, string][] = [
  ['escalation', 'nudge:loops'],
  ['cancel_guard', 'nudge:cancel'],
  ['trip_event', 'nudge:trip'],
  ['receipt', 'nudge:receipt'],
  ['change_count', 'nudge:calendar'],
  ['tz_to', 'nudge:timezone'],
  ['backup_failures', 'nudge:backup'],
  ['stayLimits', 'nudge:stay'],
  ['loop_housekeeping', 'nudge:housekeeping'],
]

/** The src stamped on a turn. A user trigger keeps `trigger:<id>` (the trigger engine keys on it). */
export function srcOf(event: string, meta: Record<string, string>): string {
  if (meta.trigger_id) return `trigger:${meta.trigger_id}`
  if (event !== 'trigger') return event
  return NUDGES.find(([key]) => key in meta)?.[1] ?? 'nudge'
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** 5-field cron in words for the common shapes; else the expression. */
export function cronWords(expr: string, tz?: string): string {
  const f = expr.trim().split(/\s+/)
  const at = (m: string, h: string) => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
  let words = `on the schedule \`${expr}\``
  if (f.length === 5) {
    const [m, h, dom, mon, dow] = f
    const num = /^\d+$/
    if (num.test(m) && num.test(h) && dom === '*' && mon === '*') {
      if (dow === '*') words = `every day at ${at(m, h)}`
      else if (dow === '1-5') words = `weekdays at ${at(m, h)}`
      else if (/^[0-7]$/.test(dow)) words = `every ${DAYS[+dow % 7]} at ${at(m, h)}`
    } else if (/^\*\/\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') {
      words = `every ${m.slice(2)} minutes`
    } else if (m === '0' && /^\*\/\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') {
      words = `every ${h.slice(2)} hours`
    }
  }
  return tz ? `${words} (${tz})` : words
}

/** ISO one-shot in words: "Wed 21 Oct, 14:00 (Europe/Berlin)". */
export function whenWords(iso: string, tz: string): string {
  const d = new Date(iso)
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz }).format(d)
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(d)
  return `${day}, ${time} (${tz})`
}

const NUDGE_WORDS: Record<string, string> = {
  'nudge:loops': 'A reminder about an open loop or deadline you recorded — the channel sends two per due date, no more',
  'nudge:cancel': 'A free-cancellation deadline on a booking',
  'nudge:trip': 'A trip event (check-in window, arrival)',
  'nudge:receipt': 'An email you sent was opened',
  'nudge:calendar': 'Something changed on your calendar',
  'nudge:timezone': "This machine's timezone changed",
  'nudge:backup': 'The nightly backup failed',
  'nudge:stay': 'A days-in-country limit',
  'nudge:housekeeping': 'Nightly loop hygiene proposals',
  nudge: 'Something the channel noticed on its own',
}

const PLACE: Record<HoldReason, string> = {
  inflight: 'in the air', quiet: 'asleep', busy: 'in a calendar event', snooze: 'snoozed',
}

function triggerWhy(id: string, t: TriggerLike | null | undefined, tz: string): string {
  if (!t) return `A trigger that has since been removed (${id})`
  const g = gistOf(t.action)
  const gist = g.length > 60 ? `${g.slice(0, 60)}…` : g
  if (t.type === 'email') return `Your email trigger "${gist}" — fires when ${t.condition ?? 'its condition holds'}`
  const sched = t.schedule ?? ''
  if (/\d{4}-\d{2}-\d{2}/.test(sched)) return `A reminder you set for ${whenWords(sched, t.tz ?? tz)}: "${gist}"`
  return `Your trigger "${gist}", ${cronWords(sched, t.tz)}`
}

/** null for anything that was a reply (chat, button, terminal, ''), and for anything it
 *  cannot word: an explanation must never be the reason a send fails. */
export function whyFor(src: string, ctx: WhyContext): string | null {
  try { return words(src, ctx) } catch { return null }
}

function words(src: string, ctx: WhyContext): string | null {
  if (src.startsWith('trigger:')) return triggerWhy(src.slice('trigger:'.length), ctx.trigger, ctx.tz)
  if (src === 'email-scan') {
    const last = ctx.meta?.last_scan
    const t = last && last !== 'never' ? new Date(last) : null
    const clause = t && !isNaN(+t)
      ? `, last run ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: ctx.tz }).format(t)}`
      : ''
    return `The email scan, every ${ctx.scanMinutes ?? 60} min${clause}`
  }
  if (src === 'webhook') {
    const s = ctx.meta?.webhook_source
    return s ? `A webhook from ${s}` : 'An external webhook'
  }
  if (src === 'queue-flush' && ctx.hold) {
    const { reason, count, inner } = ctx.hold
    if (count > 1) return `${count} messages held while you were ${PLACE[reason]}, delivered together`
    return `Held while you were ${PLACE[reason]}${inner ? ` — originally: ${inner}` : ''}`
  }
  return NUDGE_WORDS[src] ?? null
}
