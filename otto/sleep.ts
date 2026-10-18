/**
 * Quiet hours inferred from when the user actually sleeps.
 *
 * The configured window is a guess the user made once, usually on setup, and a
 * guess about bedtime ages badly: a new job, a new country, a baby. The truth is
 * already on disk. Nobody texts their assistant while asleep, so the long gap in
 * their inbound messages each night is the night itself — the last message
 * before it is bedtime and the first after it is waking up.
 *
 * Everything here is pure except the store at the bottom. It never changes the
 * window: it proposes one, once, with buttons, and a tap goes through the same
 * `setting:quiet` door as the /settings page.
 *
 * Clocks are wall-clock local in the zone the user was in when they sent the
 * message, because quiet hours are wall-clock local and shift with the machine.
 * Someone who sleeps 01:30–09:30 in one country and then flies six hours east
 * still sleeps 01:30–09:30 a few nights later; reading both weeks in today's
 * zone would smear them into nonsense. The night that spans the zone change
 * itself is dropped — a flight is not a night's sleep.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { parseQuietHours, type QuietWindow } from './jobs.ts'

/** One inbound message. `tz` is the machine zone when it arrived; absent on
 * history written before the stamp existed, which then reads in `fallbackTz`. */
export type Inbound = { ts: string; tz?: string }

export type Night = {
  /** Local date of waking, YYYY-MM-DD — the night "belongs" to that morning. */
  key: string
  /** Minutes after local midnight of the last message before the gap. */
  bed: number
  /** Minutes after local midnight of the first message after it. */
  wake: number
  tz: string
}

export type SleepConfig = {
  /** How far back to look. */
  days: number
  /** A gap shorter than this is a quiet evening, not a night. */
  minGapHours: number
  /** Longer than this, a day went missing — bedtime and waking were not seen. */
  maxGapHours: number
  /** Messages needed in the hours either side of the gap for it to count. */
  minSide: number
  sideHours: number
  /** Nights needed before a median means anything. */
  minNights: number
  /** How far a night may sit from the configured window and still agree with it. */
  toleranceMin: number
  /** "At least `recentHits` of the last `recentNights` nights." */
  recentNights: number
  recentHits: number
  /** Proposals are rounded so a window does not creep by five minutes a week. */
  roundMin: number
  /** A [keep] tap, or an unanswered proposal, quiets the next one for this long. */
  muteDays: number
}

export const DEFAULTS: SleepConfig = {
  days: 14,
  minGapHours: 5,
  maxGapHours: 16,
  minSide: 2,
  sideHours: 8,
  minNights: 4,
  toleranceMin: 90,
  recentNights: 4,
  recentHits: 3,
  roundMin: 30,
  muteDays: 14,
}

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
/** Clock positions are compared measured from 18:00, so a bedtime either side
 * of midnight and a mid-morning wake are both ordinary numbers. */
const EVENING = 18 * 60

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    fmtCache.set(tz, f)
  }
  return f
}

/** Local date and minutes-after-midnight of an instant in a zone. */
export function localClock(ms: number, tz: string): { date: string; min: number } {
  const p: Record<string, string> = {}
  for (const part of fmt(tz).formatToParts(new Date(ms))) p[part.type] = part.value
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) }
}

function sinceEvening(min: number): number {
  return (min - EVENING + 1440) % 1440
}

/** Distance between two clock positions, the short way round. */
export function clockDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 1440
  return Math.min(d, 1440 - d)
}

export function formatClock(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** The access.json spelling, "HH:MM-HH:MM". */
export function formatWindow(w: QuietWindow): string {
  return `${formatClock(w.startMin)}-${formatClock(w.endMin)}`
}

/** The spelling a person reads, with an en dash. */
export function labelWindow(w: QuietWindow): string {
  return `${formatClock(w.startMin)}–${formatClock(w.endMin)}`
}

/**
 * Every night in the lookback the messages actually show.
 *
 * A night is the longest gap of at least `minGapHours` that starts in the
 * evening-to-early-morning half of the clock (18:00–06:00) and ends in the
 * morning-to-afternoon half (03:00–15:00). It is dropped when there is too
 * little either side of it to say when the user went quiet or came back, when
 * it is so long a whole day is missing, and when the zone changed across it.
 */
export function findNights(msgs: Inbound[], now: number, fallbackTz: string, cfg: SleepConfig = DEFAULTS): Night[] {
  const since = now - cfg.days * DAY_MS
  const pts = msgs
    .map(m => ({ at: Date.parse(m.ts), tz: m.tz || fallbackTz }))
    .filter(p => Number.isFinite(p.at) && p.at >= since && p.at <= now)
    .sort((a, b) => a.at - b.at)

  const countIn = (from: number, to: number) => {
    let n = 0
    for (const p of pts) if (p.at >= from && p.at <= to) n++
    return n
  }

  const best = new Map<string, Night & { gap: number }>()
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const gap = b.at - a.at
    if (gap < cfg.minGapHours * HOUR_MS || gap > cfg.maxGapHours * HOUR_MS) continue
    // A flight, or a laptop that jumped zones: not a night anyone slept normally.
    if (a.tz !== b.tz) continue
    const bed = localClock(a.at, a.tz)
    const wake = localClock(b.at, b.tz)
    if (sinceEvening(bed.min) >= 12 * 60) continue                       // went quiet after 06:00
    const w = sinceEvening(wake.min)
    if (w < 9 * 60 || w >= 21 * 60) continue                             // came back outside 03:00–15:00
    const side = cfg.sideHours * HOUR_MS
    if (countIn(a.at - side, a.at) < cfg.minSide) continue
    if (countIn(b.at, b.at + side) < cfg.minSide) continue
    const prev = best.get(wake.date)
    if (prev && prev.gap >= gap) continue
    best.set(wake.date, { key: wake.date, bed: bed.min, wake: wake.min, tz: b.tz, gap })
  }
  return [...best.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ gap: _gap, ...n }) => n)
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** The median night, rounded. Null when there are too few nights to say. */
export function inferWindow(nights: Night[], cfg: SleepConfig = DEFAULTS): QuietWindow | null {
  if (nights.length < cfg.minNights) return null
  const round = (m: number) => Math.round(m / cfg.roundMin) * cfg.roundMin
  const bed = round(median(nights.map(n => sinceEvening(n.bed)))) + EVENING
  const wake = round(median(nights.map(n => sinceEvening(n.wake)))) + EVENING
  const w = { startMin: bed % 1440, endMin: wake % 1440 }
  return w.startMin === w.endMin ? null : w
}

export function differs(n: { bed: number; wake: number }, q: QuietWindow, tol: number): boolean {
  return clockDiff(n.bed, q.startMin) > tol || clockDiff(n.wake, q.endMin) > tol
}

export type SleepState = {
  /** Every window ever offered, in access.json spelling. Never offered twice. */
  proposed: { window: string; at: string }[]
  /** The offer the buttons on the user's phone point at. A tap must match it. */
  pending?: { window: string; keep: string; at: string }
  /** A [keep] tap. No offer until then. */
  mutedUntil?: string
  /** What the user chose, for "why did my quiet hours change". */
  decisions?: { choice: 'use' | 'keep'; window: string; at: string }[]
}

export type Proposal = { window: QuietWindow; keep: QuietWindow; nights: number; recentDiffering: number }

export type PlanInput = {
  nights: Night[]
  /** access.json quietHours. Absent or switched off means there is nothing to correct. */
  quietHours?: string
  state: SleepState
  now: number
  cfg?: SleepConfig
}

/**
 * Whether to offer a new window, and which. Each null is a deliberate silence:
 * nothing configured, muted, too soon after the last offer, too little data,
 * the recent nights mostly agree, the median is close enough, or this exact
 * window was offered before.
 */
export function planProposal(input: PlanInput): Proposal | null {
  const cfg = input.cfg ?? DEFAULTS
  const q = parseQuietHours(input.quietHours)
  if (!q) return null
  const st = input.state
  if (st.mutedUntil && Date.parse(st.mutedUntil) > input.now) return null
  const last = st.proposed.length ? Date.parse(st.proposed[st.proposed.length - 1].at) : NaN
  if (Number.isFinite(last) && input.now - last < cfg.muteDays * DAY_MS) return null

  const recent = input.nights.slice(-cfg.recentNights)
  const recentDiffering = recent.filter(n => differs(n, q, cfg.toleranceMin)).length
  if (recentDiffering < cfg.recentHits) return null

  const w = inferWindow(input.nights, cfg)
  if (!w) return null
  if (clockDiff(w.startMin, q.startMin) <= cfg.toleranceMin && clockDiff(w.endMin, q.endMin) <= cfg.toleranceMin) return null
  if (st.proposed.some(p => p.window === formatWindow(w))) return null
  return { window: w, keep: q, nights: input.nights.length, recentDiffering }
}

/** Record the offer before it is sent, so a tap days later finds it. */
export function markProposed(st: SleepState, p: Proposal, now: number): SleepState {
  const at = new Date(now).toISOString()
  return {
    ...st,
    proposed: [...st.proposed, { window: formatWindow(p.window), at }],
    pending: { window: formatWindow(p.window), keep: formatWindow(p.keep), at },
  }
}

export type OfferButton = { label: string; data: string }

export function formatOffer(p: Proposal, tz: string): { text: string; buttons: OfferButton[] } {
  return {
    text: `Your nights lately run about ${labelWindow(p.window)} (${tz}), not the ${labelWindow(p.keep)} quiet hours. Move them?`,
    buttons: [
      { label: `use ${labelWindow(p.window)}`, data: `sleep use ${formatWindow(p.window)}` },
      { label: `keep ${labelWindow(p.keep)}`, data: `sleep keep ${formatWindow(p.keep)}` },
    ],
  }
}

export const TAP_RE = /^sleep (use|keep) (\d{2}:\d{2}-\d{2}:\d{2})$/

export type TapResult =
  | { ok: true; choice: 'use' | 'keep'; state: SleepState; quietHours?: string; line: string }
  | { ok: false; line: string }

/**
 * A tap on an offer. It only ever carries out the offer the server itself made
 * and still has pending: a `sleep use …` button minted anywhere else, or one
 * left over from an offer already answered, changes nothing.
 */
export function applyTap(st: SleepState, instruction: string, now: number, cfg: SleepConfig = DEFAULTS): TapResult {
  const m = TAP_RE.exec(instruction.trim())
  if (!m) return { ok: false, line: 'not a quiet-hours button' }
  const [, choice, window] = m as unknown as [string, 'use' | 'keep', string]
  const p = st.pending
  if (!p || (choice === 'use' ? p.window : p.keep) !== window) return { ok: false, line: 'that offer has already been answered' }
  const at = new Date(now).toISOString()
  const { pending: _pending, ...rest } = st
  const state: SleepState = { ...rest, decisions: [...(st.decisions ?? []), { choice, window, at }] }
  const label = labelWindow(parseQuietHours(window)!)
  if (choice === 'keep') {
    state.mutedUntil = new Date(now + cfg.muteDays * DAY_MS).toISOString()
    return { ok: true, choice, state, line: `kept ${label}` }
  }
  return { ok: true, choice, state, quietHours: window, line: `quiet hours now ${label}` }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function loadSleep(file: string): SleepState {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as SleepState
    if (!s || !Array.isArray(s.proposed)) throw new Error('not a sleep state')
    return s
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: sleep.json corrupt, moved aside.\n')
    }
    return { proposed: [] }
  }
}

export function saveSleep(file: string, s: SleepState): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
