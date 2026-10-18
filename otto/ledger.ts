/**
 * Did any of this land?
 *
 * Otto sends proactive messages on a schedule and has never once known whether
 * they were worth sending. CLAUDE.md sets a high bar for interrupting, but the
 * bar was enforced by vibes: nothing measured which pings got a response and
 * which went into the void four weeks running.
 *
 * history.jsonl already holds both directions with timestamps. The only missing
 * piece was attribution — which send came from which trigger — and the server
 * now stamps that on the way out (`src`). This turns the log into a report:
 * per source, how many sends, how many drew a reply, and how long the current
 * silent streak is.
 *
 * Engagement is "the user replied within the window". Reactions would be a better
 * signal but the Bot API only delivers them if the poller subscribes to
 * message_reaction updates, which this channel does not.
 *
 * The report is evidence, not a verdict. Deciding to retire a trigger stays a
 * conversation with the user.
 */

export type LedgerEntry = {
  ts: string
  dir: 'in' | 'out'
  chat_id: string
  text: string
  kind?: string
  /** "trigger:<id>", "email-scan", "webhook", "chat", "queue-flush". */
  src?: string
}

export type SourceStats = {
  src: string
  sent: number
  engaged: number
  /** Sends since the last one that drew a reply. */
  silentStreak: number
  lastSent?: string
  lastEngaged?: string
}

export const ENGAGE_WINDOW_MS = 2 * 60 * 60 * 1000

/**
 * A send counts as engaged if the user sent anything at all within the window after
 * it. Crude — a reply to something else lands in the same bucket — but it is
 * directionally right and it cannot be gamed by Otto itself.
 */
export function proactivityReport(
  entries: LedgerEntry[],
  opts: { windowMs?: number; since?: number } = {},
): SourceStats[] {
  const windowMs = opts.windowMs ?? ENGAGE_WINDOW_MS
  const sorted = [...entries].sort((a, b) => a.ts.localeCompare(b.ts))
  const inboundTimes = sorted
    // A prompt typed into the terminal isn't an answer to anything Otto sent on a chat.
    .filter(e => e.dir === 'in' && e.kind !== 'terminal')
    .map(e => Date.parse(e.ts))
    .filter(t => !Number.isNaN(t))
    .sort((a, b) => a - b)

  const engagedAfter = (t: number): number | undefined => {
    // First inbound strictly after the send and inside the window.
    let lo = 0, hi = inboundTimes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (inboundTimes[mid] <= t) lo = mid + 1
      else hi = mid
    }
    const next = inboundTimes[lo]
    return next !== undefined && next - t <= windowMs ? next : undefined
  }

  const bySrc = new Map<string, SourceStats>()
  for (const e of sorted) {
    if (e.dir !== 'out') continue
    const at = Date.parse(e.ts)
    if (Number.isNaN(at)) continue
    if (opts.since && at < opts.since) continue
    // Unattributed sends are conversation, which is not proactivity.
    const src = e.src && e.src !== 'chat' ? e.src : null
    if (!src) continue

    const stats = bySrc.get(src) ?? { src, sent: 0, engaged: 0, silentStreak: 0 }
    stats.sent++
    stats.lastSent = e.ts
    const hit = engagedAfter(at)
    if (hit !== undefined) {
      stats.engaged++
      stats.silentStreak = 0
      stats.lastEngaged = new Date(hit).toISOString()
    } else {
      stats.silentStreak++
    }
    bySrc.set(src, stats)
  }

  return [...bySrc.values()].sort((a, b) => b.silentStreak - a.silentStreak || b.sent - a.sent)
}

export function formatReport(stats: SourceStats[]): string {
  if (!stats.length) return '(no attributed proactive sends in the window)'
  const lines = stats.map(s => {
    const rate = s.sent ? Math.round((s.engaged / s.sent) * 100) : 0
    const streak = s.silentStreak >= 3 ? `  <- ${s.silentStreak} in a row ignored` : ''
    return `${s.src}: ${s.sent} sent, ${s.engaged} drew a reply (${rate}%)${streak}`
  })
  const dead = stats.filter(s => s.sent >= 3 && s.engaged === 0)
  if (dead.length) {
    lines.push('', `Never once answered: ${dead.map(d => d.src).join(', ')}. Worth asking the user whether to retire them.`)
  }
  return lines.join('\n')
}
