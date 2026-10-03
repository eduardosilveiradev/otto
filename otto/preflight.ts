/**
 * Checking a trigger before it is armed, not after it misfires.
 *
 * A trigger is a promise to wake a future agent that has none of this
 * conversation. Three things go wrong at arming time and are only discovered
 * later, in the worst way:
 *
 *   The schedule is not what the user meant. `0 3 * * *` reads fine and fires at
 *   03:00. The user finds out when it wakes the user. Nothing in the current create path
 *   shows the user a single actual fire time, so a cron typo is invisible until it
 *   costs a night — and a timezone shift moves every armed trigger without
 *   anybody re-reading it.
 *
 *   The action cannot understand itself. "Remind the user about that" is perfectly
 *   clear while writing it and completely opaque at 09:00 on Thursday to an
 *   agent with no memory of what "that" was. The trigger fires, and the message
 *   it produces is either nonsense or a fabrication.
 *
 *   It already exists. Arming a second trigger that does the same thing on the
 *   same schedule is how one bill quietly starts generating two reminders.
 *
 * Everything here is a pure function over the proposed trigger, the already
 * armed ones, and the fire times the caller computed. It reports rather than
 * decides: `errors` should block arming, `warnings` should be shown to the user and
 * armed anyway, because the false-positive cost of blocking a legitimate
 * trigger is higher than the cost of one extra line.
 */

export type PreflightInput = {
  id?: string
  type: 'cron' | 'email'
  schedule?: string
  tz?: string
  condition?: string
  action: string
  repeating: boolean
}

export type ArmedTrigger = {
  id: string
  type: 'cron' | 'email'
  schedule?: string
  condition?: string
  action: string
  enabled: boolean
}

export type Finding = { code: string; message: string }

export type PreflightReport = {
  errors: Finding[]
  warnings: Finding[]
  /** The next few fire times, already formatted in the user’s zone. */
  fires: string[]
}

export type QuietWindow = { start: number; end: number } | null

/**
 * Context-dependent phrasing a cold agent cannot resolve.
 *
 * These match *dangling* pronouns only, never pronouns doing ordinary work.
 * "everything that arrived this morning" is a relative clause and perfectly
 * resolvable; "remind the user about that" is not. The difference is whether the
 * pronoun ends the clause, so the patterns require a terminator rather than
 * matching the word anywhere.
 */
const VAGUE = [
  /\b(?:about|on|with|to|for|of|re)\s+(?:that|this|it|those|these)\s*(?:[.!?,;]|$)/i,
  /\b(?:remind|tell|ask|send|forward|do|handle|check|chase)\s+(?:the user|her|them)?\s*(?:it|that|this|those)\s*(?:[.!?,;]|$)/i,
  /\bthe (?:above|previous|last one|same(?:\s+one)?)\b/i,
  /\bas (?:discussed|agreed|mentioned|above)\b/i,
  /^\s*(?:remind|tell|ask|nudge)\s+(?:the user|her|me|them)\s*[.!?]?\s*$/i,
]

/** An action that names nothing concrete is not actionable at 3am. */
const MIN_ACTION_WORDS = 4

export function localHourOf(ts: number, tz?: string): number {
  try {
    const s = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', hour12: false, timeZone: tz || undefined,
    }).format(new Date(ts))
    return Number(s)
  } catch {
    return new Date(ts).getHours()
  }
}

/** True when the hour falls inside a possibly-wrapping quiet window. */
export function inQuiet(hour: number, quiet: QuietWindow): boolean {
  if (!quiet) return false
  const { start, end } = quiet
  if (start === end) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

/** Same words, ignoring order and filler — enough to catch a re-armed duplicate. */
export function sameGist(a: string, b: string): boolean {
  const norm = (s: string) =>
    new Set(
      s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ')
        .filter(w => w.length > 2 && !['the', 'and', 'for', 'him', 'his', 'her'].includes(w)),
    )
  const x = norm(a), y = norm(b)
  if (!x.size || !y.size) return false
  let shared = 0
  for (const t of x) if (y.has(t)) shared++
  return shared / Math.max(x.size, y.size) >= 0.7
}

export function preflight(
  input: PreflightInput,
  armed: ArmedTrigger[],
  ctx: { fires: number[]; quiet: QuietWindow; tz?: string; allowQuiet?: boolean; now?: number },
): PreflightReport {
  const errors: Finding[] = []
  const warnings: Finding[] = []
  const zone = input.tz || ctx.tz

  const fires = ctx.fires.map(t => formatFire(t, zone))

  // A cron trigger with no computable next run is already broken.
  if (input.type === 'cron' && !ctx.fires.length) {
    errors.push({
      code: 'no-fire',
      message: `"${input.schedule}" produces no next fire time. Check the expression, or use an ISO datetime for a one-shot.`,
    })
  }

  // Quiet hours. The user set them; a trigger that ignores them is a trigger that
  // wakes the user, so this blocks unless it is asked for explicitly.
  if (input.type === 'cron' && ctx.quiet && !ctx.allowQuiet) {
    const offenders = ctx.fires.filter(t => inQuiet(localHourOf(t, zone), ctx.quiet))
    if (offenders.length) {
      errors.push({
        code: 'quiet-hours',
        message:
          `fires inside quiet hours (${pad(ctx.quiet.start)}:00–${pad(ctx.quiet.end)}:00): ` +
          `${offenders.slice(0, 2).map(t => formatFire(t, zone)).join(', ')}. ` +
          `Move it, or arm it with the quiet-hours override if it genuinely has to wake the user.`,
      })
    }
  }

  // Can the action understand itself with no other context?
  const words = input.action.trim().split(/\s+/).filter(Boolean)
  if (words.length < MIN_ACTION_WORDS) {
    warnings.push({
      code: 'thin-action',
      message: `the action is ${words.length} words. A cold agent needs the whole instruction, including who and what.`,
    })
  }
  for (const re of VAGUE) {
    const m = input.action.match(re)
    if (m) {
      warnings.push({
        code: 'vague-action',
        message: `"${m[0]}" refers to something only this conversation knows. Name it in the action text.`,
      })
      break
    }
  }

  // Already armed?
  for (const t of armed) {
    if (!t.enabled || t.id === input.id) continue
    if (t.type !== input.type) continue
    const sameWhen =
      input.type === 'cron' ? t.schedule === input.schedule : sameGist(t.condition ?? '', input.condition ?? '')
    if (sameWhen && sameGist(t.action, input.action)) {
      warnings.push({
        code: 'duplicate',
        message: `trigger ${t.id} already does this on the same schedule. Arming both means two messages about one thing.`,
      })
      break
    }
  }

  // Frequency. Anything firing more often than hourly is a stream, not a nudge.
  if (input.type === 'cron' && ctx.fires.length >= 2) {
    const gaps: number[] = []
    for (let i = 1; i < ctx.fires.length; i++) gaps.push(ctx.fires[i] - ctx.fires[i - 1])
    const min = Math.min(...gaps)
    if (min > 0 && min < 55 * 60 * 1000) {
      warnings.push({
        code: 'frequent',
        message: `fires every ${Math.round(min / 60000)} minutes. That is a stream; the interruption budget is per message.`,
      })
    }
  }

  return { errors, warnings, fires }
}

const pad = (n: number) => String(n).padStart(2, '0')

export function formatFire(ts: number, tz?: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: tz || undefined, timeZoneName: 'short',
    }).format(new Date(ts))
  } catch {
    return new Date(ts).toISOString()
  }
}

/** What the session shows the user before arming. */
export function formatReport(r: PreflightReport): string {
  const lines: string[] = []
  if (r.fires.length) lines.push(`next: ${r.fires.slice(0, 5).join(' · ')}`)
  for (const e of r.errors) lines.push(`blocked — ${e.message}`)
  for (const w of r.warnings) lines.push(`check — ${w.message}`)
  return lines.join('\n')
}
