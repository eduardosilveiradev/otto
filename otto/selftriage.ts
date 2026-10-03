/**
 * When Otto falls over, Otto works out why.
 *
 * The supervisor already restarts the session (launchd `KeepAlive`, systemd
 * `Restart=always`, both throttled to one start per 30s), so
 * a crash is invisible: the process dies, comes back thirty seconds later, and
 * the only trace is a stack in logs/session.err that nobody reads. A crash loop
 * is *worse* than invisible — it looks like Otto is up, because a fresh process
 * is always there when you check, while every trigger due in that window has
 * quietly gone unfired.
 *
 * The first question after a restart is not "what is the stack" — it is "did I
 * do this to myself". Wave 3 installs code. A crash whose first occurrence
 * lands within an hour of a self-install is that install until proven
 * otherwise, and reverting first and diagnosing second is the right order when
 * the diagnosis happens inside the thing that is crashing.
 *
 * Everything here is pure over log lines, restart timestamps and the capability
 * log. The tailing, the supervisor query and the revert are plumbing at the
 * edges — the part worth testing is which of the three stories a given pile of
 * evidence tells.
 *
 * The user gets one message, and it has three facts in it: down, back, cause.
 */

import type { CapEntry } from './changelog.ts'

// ---------------------------------------------------------------------------
// Reading the wreckage
// ---------------------------------------------------------------------------

export type Crash = {
  /** Epoch ms, when the line carried a timestamp. */
  at?: number
  /** "TypeError", "PermissionError", "Error", "uncaught". */
  kind: string
  message: string
  /** Up to a handful of frames — enough to place it, not enough to bury the user. */
  frames: string[]
  /** Stable across repeats of the same crash: kind + shape of message + top frame. */
  signature: string
}

const MAX_FRAMES = 6
/** A leading ISO stamp, which bun and node both emit when anything wraps them. */
const STAMPED = /^\[?(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]?\s+(.*)$/
const ERROR_HEAD = /(^|\s)([A-Z][A-Za-z]*(?:Error|Exception))\s*:\s*(.+)$/
const FRAME = /^\s+(at\s+.+|File\s+".+|\s*\^)/

/**
 * Normalise away the parts that differ between two occurrences of the same bug
 * — line numbers, pids, temp paths, hex ids — so a loop of the same crash
 * groups instead of looking like eight different failures.
 */
export function signatureOf(kind: string, message: string, topFrame?: string): string {
  const shape = message
    .replace(/0x[0-9a-f]+/gi, '0xX')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\/[^\s:]+/g, '/P')
    .slice(0, 120)
    .trim()
  const frame = (topFrame ?? '').replace(/:\d+:\d+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return [kind, shape, frame].filter(Boolean).join(' | ')
}

/**
 * Pull crashes out of a session.err tail. Tolerant on purpose: this parses a
 * file three different runtimes append to, and a parser that throws on an
 * unfamiliar line is a parser that goes blind exactly when something new breaks.
 */
export function parseCrashes(lines: string[]): Crash[] {
  const out: Crash[] = []
  for (let i = 0; i < lines.length; i++) {
    const stamped = STAMPED.exec(lines[i])
    const at = stamped ? Date.parse(stamped[1]) : NaN
    const body = stamped ? stamped[2] : lines[i]

    const head = ERROR_HEAD.exec(body)
    if (!head) continue

    const frames: string[] = []
    for (let j = i + 1; j < lines.length && frames.length < MAX_FRAMES; j++) {
      if (!FRAME.test(lines[j])) break
      const f = lines[j].trim()
      if (f !== '^') frames.push(f)
    }

    out.push({
      ...(Number.isNaN(at) ? {} : { at }),
      kind: head[2],
      message: head[3].trim(),
      frames,
      signature: signatureOf(head[2], head[3], frames[0]),
    })
  }
  return out
}

/**
 * `launchctl print gui/<uid>/com.otto.agent` (macOS only). Only three fields matter and
 * the format around them changes between macOS releases, so match on the keys
 * rather than the layout.
 */
export function parseLaunchdState(text: string): { pid?: number; runs?: number; lastExitStatus?: number } {
  const num = (re: RegExp): number | undefined => {
    const m = re.exec(text)
    return m ? Number(m[1]) : undefined
  }
  const out: { pid?: number; runs?: number; lastExitStatus?: number } = {}
  const pid = num(/^\s*pid\s*=\s*(\d+)/m)
  const runs = num(/^\s*runs\s*=\s*(\d+)/m)
  const exit = num(/^\s*last exit (?:code|status)\s*=\s*(-?\d+)/m)
  if (pid !== undefined) out.pid = pid
  if (runs !== undefined) out.runs = runs
  if (exit !== undefined) out.lastExitStatus = exit
  return out
}

// ---------------------------------------------------------------------------
// Is this a loop?
// ---------------------------------------------------------------------------

export type CrashLoop = {
  restarts: number
  firstAt: number
  lastAt: number
  windowMs: number
}

/** launchd throttles to one start per 30s, so three inside ten minutes is real. */
export const LOOP_RESTARTS = 3
export const LOOP_WINDOW_MS = 10 * 60_000

/**
 * A single restart is a fact of life on a laptop that sleeps. Three in ten
 * minutes is a bug, and the difference is the entire trigger for this module —
 * getting it wrong in the noisy direction means a message every time the user closes
 * the lid.
 */
export function detectCrashLoop(
  restarts: number[],
  now: number,
  opts: { minRestarts?: number; windowMs?: number } = {},
): CrashLoop | null {
  const windowMs = opts.windowMs ?? LOOP_WINDOW_MS
  const min = opts.minRestarts ?? LOOP_RESTARTS
  const recent = restarts.filter(t => t <= now && now - t <= windowMs).sort((a, b) => a - b)
  if (recent.length < min) return null
  return { restarts: recent.length, firstAt: recent[0], lastAt: recent[recent.length - 1], windowMs }
}

// ---------------------------------------------------------------------------
// Did I do this to myself?
// ---------------------------------------------------------------------------

/** Anything installed inside this window before the first failure is suspect. */
export const BLAME_WINDOW_MS = 60 * 60_000

/**
 * The first question, and the first action. Correlation, not proof — but the
 * asymmetry is stark: reverting a self-install that was innocent costs one
 * capability for an hour, and not reverting one that was guilty costs the whole
 * channel until a human notices.
 *
 * Ordered newest-first so the most recent install is blamed when several land
 * in the same hour, which is also the one most likely to be at fault.
 */
export function blameSelfInstall(
  firstFailureAt: number,
  installs: CapEntry[],
  windowMs = BLAME_WINDOW_MS,
): CapEntry | null {
  const candidates = installs
    .filter(e => !e.revertedAt)
    // The watchdog logs its own restarts here, and a restart is a record, not a
    // change: it cannot be reverted, so blaming one leaves the real install in
    // place and the loop running. Entries with no inverse are never suspects.
    .filter(e => e.by !== 'watchdog' && e.revert.kind !== 'none')
    .map(e => ({ e, at: Date.parse(e.at) }))
    .filter(x => !Number.isNaN(x.at) && x.at <= firstFailureAt && firstFailureAt - x.at <= windowMs)
    .sort((a, b) => b.at - a.at)
  return candidates[0]?.e ?? null
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type Incident = {
  loop: CrashLoop
  crash?: Crash
  /** Set when a self-install landed inside the blame window. */
  blamed?: CapEntry
  /** What to do: revert the install, or file a bug and a failing test. */
  action: 'revert' | 'file-bug'
  /** When the channel came back, if it has. */
  recoveredAt?: number
}

export function triage(
  loop: CrashLoop,
  crashes: Crash[],
  installs: CapEntry[],
  opts: { recoveredAt?: number; blameWindowMs?: number } = {},
): Incident {
  // The crash that matches the loop's start explains it; a later one is a
  // symptom of the same thing restarting.
  const crash = crashes.find(c => c.at === undefined || c.at >= loop.firstAt - 60_000) ?? crashes[0]
  const blamed = blameSelfInstall(loop.firstAt, installs, opts.blameWindowMs)
  return {
    loop,
    ...(crash ? { crash } : {}),
    ...(blamed ? { blamed } : {}),
    ...(opts.recoveredAt ? { recoveredAt: opts.recoveredAt } : {}),
    action: blamed ? 'revert' : 'file-bug',
  }
}

/** Filename stem of the failing test filed for a crash signature. */
export function regressionSlug(signature: string): string {
  return signature
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'crash'
}

/** Repo-relative path of the failing test filed for a crash signature. */
export const regressionPath = (signature: string) => `otto/tests/regressions/${regressionSlug(signature)}.test.ts`

/**
 * A failing test that reproduces it.
 *
 * Be honest about what this can be: a stack trace does not contain enough to
 * synthesise a real reproduction, and a generated test that *passes* is worse
 * than none — it certifies a bug as fixed. So the generated test fails
 * deliberately, carries the whole stack in its failure message, and turns the
 * suite red until a human replaces the body with a real assertion. Red is the
 * correct state: the bug is still there.
 */
export function reproTest(crash: Crash, loop: CrashLoop): { path: string; source: string } {
  const stack = [`${crash.kind}: ${crash.message}`, ...crash.frames].map(l => `  ${l}`).join('\n')
  const source = `import { test, expect } from 'bun:test'

// Filed automatically after ${loop.restarts} restarts in ${Math.round(loop.windowMs / 60_000)} minutes,
// first at ${new Date(loop.firstAt).toISOString()}.
//
// This test FAILS ON PURPOSE. A generated test cannot know how to reproduce a
// crash from its stack alone, and a generated test that passes would certify a
// live bug as fixed. Replace the body with a real reproduction, then fix it.
//
// The stack, as logged:
//
${stack.split('\n').map(l => `//${l}`).join('\n')}

test('regression: ${crash.kind} — ${crash.message.replace(/'/g, "\\'").slice(0, 80)}', () => {
  expect('this crash has no reproduction yet').toBe('reproduced and fixed')
})
`
  return { path: regressionPath(crash.signature), source }
}

/** The durable note, so the next session knows this happened without re-reading logs. */
export function bugNote(i: Incident): { kind: 'loop'; text: string; tags: string[] } {
  const cause = i.blamed
    ? `self-install ${i.blamed.id} (${i.blamed.what})`
    : i.crash
      ? i.crash.signature
      : 'unknown'
  return {
    kind: 'loop',
    text:
      `crash loop: ${i.loop.restarts} restarts from ${new Date(i.loop.firstAt).toISOString()}. ` +
      `Cause: ${cause}. ${i.action === 'revert' ? 'Reverted the install.' : 'Bug filed with a failing test.'}`,
    tags: ['crash', i.action],
  }
}

// ---------------------------------------------------------------------------
// The one message
// ---------------------------------------------------------------------------

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m === 1 ? '1 min' : `${m} min`
}

/**
 * Down, back, cause — in that order, because that is the order the user cares about.
 * No stack. The user is not going to debug it from Telegram, and the stack is in the
 * note and the failing test if the user wants it.
 */
export function formatIncident(i: Incident, now: number): string {
  const down = minutes((i.recoveredAt ?? now) - i.loop.firstAt)
  const back = i.recoveredAt ? 'back up' : 'still restarting'
  const cause = i.blamed
    ? `caused by something I installed ${i.blamed.what.toLowerCase()} — reverted it`
    : i.crash
      ? `${i.crash.kind}: ${i.crash.message.slice(0, 90)} — logged it with a failing test`
      : 'cause unclear — logged what there was'
  return `was down ~${down} (${i.loop.restarts} restarts), ${back}. ${cause}.`
}
