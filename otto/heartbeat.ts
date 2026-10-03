/**
 * Is the channel host still beating?
 *
 * Everything else that watches Otto — the watchdog, the crash-loop triage, the
 * brief — runs inside the process it is watching. When that process is wedged or
 * gone, all of them go quiet together, and quiet looks exactly like a good day.
 * So the one check that matters most has to live outside: the server writes a
 * small heartbeat file, and `deadman.ts` (run by its own launchd job, sharing no
 * code path with the server beyond this file) notices when it stops changing.
 *
 * Three rules keep it from becoming noise:
 *
 *   once per outage   an outage is identified by the last beat it followed, so a
 *                     checker that runs every five minutes for six hours raises
 *                     exactly one alert. A new beat closes the outage; the next
 *                     silence is a new one.
 *   sleep is not an   a laptop lid closed for the night stops the server and the
 *   outage            checker alike, and the first thing the checker sees on wake
 *                     is a stale beat. A gap between checker runs that is much
 *                     longer than its interval means the machine slept, so that
 *                     run gives the server a chance to beat before judging it.
 *   never a new       a file that has never been written is a fresh install, not
 *   install           an outage.
 *
 * Pure decisions live here; the I/O (files, the alert itself) is in deadman.ts.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'

export type Heartbeat = {
  v: 1
  pid: number
  /** Epoch ms of this beat. */
  at: number
  /** Epoch ms the scheduler (triggers, escalations, scans) last ran. */
  schedulerAt?: number
  /** Epoch ms of the last Telegram long-poll round trip. */
  pollAt?: number
}

/** How often the server beats. */
export const BEAT_MS = 30_000
/** Stale after this many missed beats. */
export const STALE_BEATS = 10
export const STALE_MS = BEAT_MS * STALE_BEATS
/** How often the checker is meant to run. */
export const CHECK_MS = 5 * 60_000

export function readHeartbeat(file: string): Heartbeat | null {
  try {
    const hb = JSON.parse(readFileSync(file, 'utf8')) as Heartbeat
    return hb && hb.v === 1 && typeof hb.at === 'number' && typeof hb.pid === 'number' ? hb : null
  } catch {
    return null
  }
}

export function writeHeartbeat(file: string, hb: Heartbeat): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(hb) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

// ---------------------------------------------------------------------------
// The checker's own memory
// ---------------------------------------------------------------------------

export type Outage = {
  /** `at` of the last beat before the silence. Identifies the outage. */
  since: number
  /** Epoch ms the silence was first seen. An alert needs a second, later run. */
  seenAt?: number
  /** Epoch ms the alert went out. Absent until it actually did. */
  raisedAt?: number
  /** The loop note that carries it in the brief. */
  noteId?: string
}

export type DeadmanState = {
  /** Epoch ms of the checker's previous run. */
  lastCheckAt?: number
  outage?: Outage
}

export type DeadmanAction =
  /** Nothing to do. */
  | { kind: 'none'; why: string }
  /** Tell the user, once. `pidAlive` says whether it is wedged or gone. */
  | { kind: 'raise'; since: number; silentMs: number; pidAlive: boolean }
  /** The outage is over. Close its loop; say nothing. */
  | { kind: 'recover'; outage: Outage }

export type DeadmanVerdict = { action: DeadmanAction; state: DeadmanState }

/**
 * One checker run. `held` is true while an alert would be unwelcome (quiet
 * hours): the outage is still recorded, so the alert goes out the moment it
 * lifts, and still only once.
 */
export function evaluate(
  hb: Heartbeat | null,
  state: DeadmanState,
  now: number,
  ctx: { pidAlive: (pid: number) => boolean; held?: boolean; staleMs?: number; checkMs?: number },
): DeadmanVerdict {
  const staleMs = ctx.staleMs ?? STALE_MS
  const checkMs = ctx.checkMs ?? CHECK_MS
  const next: DeadmanState = { ...state, lastCheckAt: now }

  if (!hb) return { action: { kind: 'none', why: 'no heartbeat has ever been written' }, state: next }

  const silentMs = now - hb.at
  const fresh = silentMs <= staleMs

  if (fresh) {
    if (state.outage && hb.at > state.outage.since) {
      delete next.outage
      // Never alerted, so there is nothing to close: the blip cleared itself.
      if (!state.outage.raisedAt) return { action: { kind: 'none', why: 'stale reading cleared on its own' }, state: next }
      return { action: { kind: 'recover', outage: state.outage }, state: next }
    }
    return { action: { kind: 'none', why: 'beating' }, state: next }
  }

  // Stale. Was the checker itself asleep? Then the server was too.
  const gap = state.lastCheckAt === undefined ? 0 : now - state.lastCheckAt
  if (!state.outage && gap > checkMs * 3) {
    return { action: { kind: 'none', why: 'machine was asleep; giving the server one run to beat' }, state: next }
  }

  const prior = state.outage && state.outage.since === hb.at ? state.outage : undefined
  const outage: Outage = prior ?? { since: hb.at, seenAt: now }
  next.outage = outage
  if (outage.raisedAt) return { action: { kind: 'none', why: 'already raised for this outage' }, state: next }
  // One stale reading is not an outage: after a short sleep the checker can run
  // before the server's first beat. Only a second run that still finds the same
  // silence raises.
  if (!prior) return { action: { kind: 'none', why: 'first stale run; confirming on the next' }, state: next }
  if (ctx.held) return { action: { kind: 'none', why: 'held until quiet hours lift' }, state: next }
  return { action: { kind: 'raise', since: hb.at, silentMs, pidAlive: ctx.pidAlive(hb.pid) }, state: next }
}

export function describeOutage(a: Extract<DeadmanAction, { kind: 'raise' }>): string {
  const mins = Math.max(1, Math.round(a.silentMs / 60_000))
  return a.pidAlive
    ? `I've been unresponsive for ${mins} min — the process is up but not doing anything.`
    : `I've been down for ${mins} min — the process is gone.`
}

export function loadDeadmanState(file: string): DeadmanState {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as DeadmanState
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

export function saveDeadmanState(file: string, s: DeadmanState): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
