/**
 * How much of the window is left, before the user finds out the hard way.
 *
 * The user runs several Claude Code sessions at once, all day, and discovers the
 * usage limit by hitting it — usually mid-task, which is the worst possible
 * moment because the work in flight is the work that gets abandoned. Otto is
 * itself one of the heaviest consumers, so it is in a position to notice.
 *
 * The number that matters is not spend. It is "at this rate, when do I run
 * out", expressed as a share of the window rather than in dollars: the user cannot
 * act on $4.10, and the user can act on "62% used with two days to go".
 *
 * Two rules keep this from becoming its own noise source. It speaks only when
 * the projection *first* crosses a threshold, not every time it is above one,
 * so a slow afternoon does not produce four warnings. And it says nothing at
 * all when the projection lands inside the window, which is most days.
 */

export type UsageEvent = {
  /** epoch ms */
  at: number
  /** output tokens, or whatever unit the caller counts in */
  tokens: number
}

export type Window = {
  /** epoch ms the current limit window opened. */
  startedAt: number
  /** how long the window runs. */
  lengthMs: number
  /** the cap for this window, in the same unit as UsageEvent.tokens. */
  limit: number
}

export type Projection = {
  used: number
  /** 0..1 of the limit consumed so far. */
  usedFraction: number
  /** 0..1 of the window elapsed. */
  elapsedFraction: number
  /** Projected consumption by window end, in tokens. */
  projected: number
  /** Projected share of the limit, where >1 means running out early. */
  projectedFraction: number
  /** epoch ms the limit is projected to be hit, when it is projected at all. */
  exhaustedAt?: number
  remainingMs: number
}

/** Warn at these projected fractions, once each per window. */
export const THRESHOLDS = [0.8, 1.0, 1.25]

export function project(events: UsageEvent[], w: Window, now: number): Projection {
  const from = w.startedAt
  const to = w.startedAt + w.lengthMs
  const used = events.filter(e => e.at >= from && e.at <= now).reduce((s, e) => s + e.tokens, 0)
  const elapsedMs = Math.max(1, now - from)
  const elapsedFraction = Math.min(1, elapsedMs / w.lengthMs)
  const rate = used / elapsedMs // tokens per ms
  const projected = w.limit > 0 ? used + rate * Math.max(0, to - now) : 0
  const usedFraction = w.limit > 0 ? used / w.limit : 0
  const projectedFraction = w.limit > 0 ? projected / w.limit : 0

  let exhaustedAt: number | undefined
  if (rate > 0 && w.limit > used) {
    const at = now + (w.limit - used) / rate
    if (at <= to) exhaustedAt = at
  } else if (w.limit > 0 && used >= w.limit) {
    exhaustedAt = now
  }

  return {
    used,
    usedFraction,
    elapsedFraction,
    projected,
    projectedFraction,
    ...(exhaustedAt !== undefined ? { exhaustedAt } : {}),
    remainingMs: Math.max(0, to - now),
  }
}

export type BurnState = {
  /** Window start this state belongs to, so a new window resets it. */
  windowStartedAt: number
  /** Thresholds already reported in this window. */
  told: number[]
}

export type BurnVerdict =
  | { speak: false; reason: 'inside-budget' | 'already-told' | 'too-early' }
  | { speak: true; threshold: number; text: string }

/**
 * Below this much of the window elapsed, the rate is noise: ten minutes of
 * heavy use at the start of a week projects to an absurd number.
 */
export const MIN_ELAPSED = 0.1

export function assess(p: Projection, state: BurnState, w: Window, now: number): BurnVerdict {
  if (p.elapsedFraction < MIN_ELAPSED) return { speak: false, reason: 'too-early' }

  const crossed = THRESHOLDS.filter(t => p.projectedFraction >= t)
  if (!crossed.length) return { speak: false, reason: 'inside-budget' }

  const highest = crossed[crossed.length - 1]
  const fresh = state.windowStartedAt === w.startedAt ? state.told : []
  if (fresh.includes(highest)) return { speak: false, reason: 'already-told' }

  return { speak: true, threshold: highest, text: formatProjection(p, now) }
}

export function recordTold(state: BurnState, w: Window, threshold: number): BurnState {
  const told = state.windowStartedAt === w.startedAt ? [...state.told] : []
  if (!told.includes(threshold)) told.push(threshold)
  return { windowStartedAt: w.startedAt, told }
}

const pct = (f: number) => `${Math.round(f * 100)}%`

export function formatProjection(p: Projection, now: number): string {
  const used = pct(p.usedFraction)
  const left = humanDuration(p.remainingMs)
  if (p.exhaustedAt !== undefined) {
    const untilOut = humanDuration(Math.max(0, p.exhaustedAt - now))
    return `${used} of the window used with ${left} to go. At this rate it runs out in about ${untilOut}.`
  }
  return `${used} of the window used with ${left} to go, projecting ${pct(p.projectedFraction)} by the end.`
}

export function humanDuration(ms: number): string {
  const h = ms / 3_600_000
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (h < 48) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}

/**
 * Read usage events out of Claude Code's local JSONL logs. Shapes have changed
 * before and will again, so anything unparseable is skipped rather than
 * throwing: a burn-rate warning is worth less than the session it would break.
 */
export function parseUsageLines(lines: string[]): UsageEvent[] {
  const out: UsageEvent[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line) as Record<string, unknown>
      const ts = j.timestamp ?? j.ts ?? j.time
      const at = typeof ts === 'string' ? Date.parse(ts) : typeof ts === 'number' ? ts : NaN
      if (Number.isNaN(at)) continue
      const usage = (j.usage ?? (j.message as Record<string, unknown>)?.usage) as
        | Record<string, number>
        | undefined
      if (!usage) continue
      const tokens =
        (usage.output_tokens ?? 0) +
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
      if (tokens > 0) out.push({ at, tokens })
    } catch {}
  }
  return out
}
