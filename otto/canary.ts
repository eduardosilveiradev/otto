/**
 * Deploying server.ts restarts the one process the user talks through.
 *
 * Every other file in this repo can be got wrong and fixed at leisure. server.ts
 * cannot: it *is* the channel, so a bad edit does not produce an error message
 * — it produces silence, on the only surface the user would use to tell Otto that
 * something is wrong. And the silence is indistinguishable from a quiet
 * afternoon, so it can last until the user happens to text.
 *
 * So the deploy is a canary: tag what is known to work, prove the change
 * compiles and passes, restart, and then wait for the process to say something
 * only a working channel can say — it has taken the Telegram token and started
 * polling. No handshake inside ninety seconds, or a burst of errors before it,
 * and the tag goes back in. Hard reset, not a revert commit: the failing code
 * must not be what is running while anyone decides what to do about it.
 *
 * The user hears about it once, after it is over, with what broke — because a message
 * saying "deploying, back shortly" is a message sent through the thing being
 * restarted, and arrives either uselessly early or not at all.
 *
 * The shell half is scripts/canary-deploy.sh. What lives here is the reading of
 * the evidence, which is the part that is wrong in interesting ways.
 */

import { parseCrashes } from './selftriage.ts'
import { restartArgv } from './watchdog.ts'

/**
 * The line server.ts prints from becomeChannelHost. It is emitted *after* the
 * pid claim and the poller start, which is what makes it a handshake rather
 * than a liveness check: a process that printed this has the token.
 */
export const HANDSHAKE = /otto channel: channel host \(.*\) — taking the Telegram token/
/** Channel-level failures that are not stack traces. */
export const CHANNEL_ERROR = /otto channel: .*(failed|corrupt|could not)/i

/** Ninety seconds. Long enough for a cold MCP connect, short enough to notice. */
export const HANDSHAKE_DEADLINE_MS = 90_000
/** More than this many errors before the handshake and the build is not healthy. */
export const ERROR_SPIKE = 3

export type LogLine = { at?: number; text: string }

/**
 * Lines carry a timestamp only when something upstream stamped them, and
 * session.err mostly does not. So `since` filters what it can and keeps the
 * rest: the caller truncates the file at deploy time, which makes "everything
 * in this tail" mean "since the deploy" without needing per-line stamps.
 */
function sinceLines(lines: LogLine[], since: number): LogLine[] {
  return lines.filter(l => l.at === undefined || l.at >= since)
}

export function handshakeSeen(lines: LogLine[], since: number): boolean {
  return sinceLines(lines, since).some(l => HANDSHAKE.test(l.text))
}

/**
 * Errors since the deploy. Counts stack traces and channel-level failures
 * alike, and counts distinct signatures rather than lines — one crash looping
 * eight times is one thing wrong, and a threshold that cannot tell those apart
 * reverts on the first bad minute of an otherwise fine build.
 */
export function errorCount(lines: LogLine[], since: number): number {
  const tail = sinceLines(lines, since)
  const sigs = new Set(parseCrashes(tail.map(l => l.text)).map(c => c.signature))
  for (const l of tail) if (CHANNEL_ERROR.test(l.text)) sigs.add(l.text.slice(0, 80))
  return sigs.size
}

export function errorSpike(lines: LogLine[], since: number, threshold = ERROR_SPIKE): boolean {
  return errorCount(lines, since) >= threshold
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type Observation = {
  /** Epoch ms the kickstart was issued. */
  deployedAt: number
  now: number
  lines: LogLine[]
}

export type Verdict =
  | { state: 'healthy'; handshakeMs: number }
  | { state: 'waiting'; remainingMs: number }
  | { state: 'revert'; why: string }

export function canaryVerdict(
  o: Observation,
  opts: { deadlineMs?: number; spike?: number } = {},
): Verdict {
  const deadlineMs = opts.deadlineMs ?? HANDSHAKE_DEADLINE_MS
  const elapsed = o.now - o.deployedAt
  const errors = errorCount(o.lines, o.deployedAt)

  // An error spike is decisive even inside the window: a process that has
  // already thrown three distinct things is not going to hand shake its way
  // out of it, and waiting the rest of the ninety seconds only extends the
  // outage.
  if (errors >= (opts.spike ?? ERROR_SPIKE)) {
    return { state: 'revert', why: `${errors} distinct errors in the first ${Math.round(elapsed / 1000)}s` }
  }
  if (handshakeSeen(o.lines, o.deployedAt)) return { state: 'healthy', handshakeMs: elapsed }
  if (elapsed < deadlineMs) return { state: 'waiting', remainingMs: deadlineMs - elapsed }
  return { state: 'revert', why: `no channel handshake in ${Math.round(deadlineMs / 1000)}s` }
}

// ---------------------------------------------------------------------------
// What the user hears
// ---------------------------------------------------------------------------

export type Outcome = {
  verdict: Verdict
  /** The tag reset to, when it reverted. */
  revertedTo?: string
  /** Human description of what was being deployed. */
  what: string
  /** Total time the channel was not answering. */
  downMs: number
}

/**
 * One message, after the fact. A successful deploy says nothing at all — the user did
 * not ask for a deploy report, and "everything is fine" is the purest form of
 * the noise this whole channel is supposed to avoid.
 */
export function formatOutcome(o: Outcome): string | null {
  if (o.verdict.state === 'healthy') return null
  if (o.verdict.state === 'waiting') return null
  const down = Math.max(1, Math.round(o.downMs / 1000))
  const tag = o.revertedTo ? ` back on ${o.revertedTo}` : ''
  return `tried to change ${o.what} and it didn't come up — ${o.verdict.why}. Rolled back${tag}; down about ${down}s.`
}

/** Everything the deploy needs to know, as data the shell script can consume. */
export type CanaryPlan = {
  tag: string
  checks: string[][]
  kickstart: string[]
  deadlineMs: number
}

export function canaryPlan(opts: { home?: string; now: number; label?: string } = { now: Date.now() }): CanaryPlan {
  return {
    tag: `otto-known-good/${opts.label ?? new Date(opts.now).toISOString().replace(/[:.]/g, '-')}`,
    // Typecheck before test: a type error is cheaper to find and its message is
    // better than whatever the test run turns it into.
    checks: [
      ['bun', 'x', 'tsc', '--noEmit', '-p', 'otto'],
      ['bun', 'test', 'otto/'],
    ],
    kickstart: restartArgv(opts.home),
    deadlineMs: HANDSHAKE_DEADLINE_MS,
  }
}
