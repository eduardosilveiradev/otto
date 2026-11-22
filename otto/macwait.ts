/**
 * Trigger runs that gave up only because the Mac couldn't be reached. When Otto's server runs
 * elsewhere (a VPS reaching the Mac over ssh, OTTO_T3_HOST), the session says so with
 * `mac_unreachable`, and the run goes on a small list here. A chore asks the Mac every couple of
 * minutes, only while something is waiting, and once it answers re-fires each run once, as a
 * normal trigger event that says it is a catch-up. This module never messages the user: the
 * re-fired trigger decides what to say.
 *
 * An entry goes 24h after the run it replaces, or once that trigger has run again on its own
 * (its lastFired moved, or a repeating one is due this tick). A re-fired entry stays until the
 * 24h prune, so a catch-up that can't reach the Mac either is not queued a second time.
 */
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { sshCmd, t3Host } from './t3.ts'

export const WAIT_MS = 24 * 3600_000
export const MAC_WAIT_FILE = join(process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'), 'mac-wait.json')

export type MacWait = { id: string; firedAt: string; action: string; refiredAt?: string }
type Fired = { id: string; action: string; lastFired?: string; repeating: boolean; nextRun?: number }

export function loadWaits(file: string): MacWait[] {
  try { return JSON.parse(readFileSync(file, 'utf8')) as MacWait[] } catch { return [] }
}

export function saveWaits(file: string, ws: MacWait[]): void {
  writeFileSync(file + '.tmp', JSON.stringify(ws, null, 2) + '\n', { mode: 0o600 })
  renameSync(file + '.tmp', file)
}

/** Queues the trigger's last run. A reason string when it can't be: no run on record, too old, or already queued once. */
export function recordWait(file: string, t: Fired, now: number): string | undefined {
  if (!t.lastFired) return 'it has never fired'
  if (now - Date.parse(t.lastFired) > WAIT_MS) return 'its last run is more than 24h old'
  const ws = loadWaits(file)
  if (ws.some(w => w.id === t.id && w.firedAt === t.lastFired)) return 'that run was already queued once'
  saveWaits(file, [...ws, { id: t.id, firedAt: t.lastFired, action: t.action }])
}

/** The entries still worth keeping. A trigger that's gone keeps its entry: a fired one-shot may be pruned, its action is stored here. */
export function liveWaits(ws: MacWait[], triggers: Fired[], now: number): MacWait[] {
  return ws.filter(w => {
    if (now - Date.parse(w.firedAt) > WAIT_MS) return false
    const t = triggers.find(x => x.id === w.id)
    if (w.refiredAt || !t) return true
    return t.lastFired === w.firedAt && !(t.repeating && t.nextRun !== undefined && t.nextRun <= now)
  })
}

export const catchUpText = (w: MacWait) => `Catch-up of the run at ${w.firedAt}, which couldn't reach the Mac (it answers again now): ${w.action}`
export const catchUpId = (w: MacWait) => `trigger-${w.id}-catchup-${Date.parse(w.firedAt)}`

/**
 * One check. Probes only when something waits; once the Mac answers, `fire` (journaled before it
 * returns, so a crash replays rather than repeats) runs for each pending entry and its mark is saved
 * in the same synchronous block. Returns how many were re-fired.
 */
export async function catchUp(file: string, triggers: () => Fired[], now: number, reachable: () => Promise<boolean>, fire: (w: MacWait) => boolean): Promise<number> {
  const before = loadWaits(file), live = liveWaits(before, triggers(), now)
  if (!live.some(w => !w.refiredAt)) {
    if (live.length !== before.length) saveWaits(file, live)
    return 0
  }
  if (!await reachable()) return 0
  // Reloaded after the probe: a mac_unreachable call may have landed meanwhile.
  const ws = liveWaits(loadWaits(file), triggers(), now)
  let n = 0
  for (const w of ws) if (!w.refiredAt && fire(w)) { w.refiredAt = new Date(now).toISOString(); n++ }
  saveWaits(file, ws)
  return n
}

/** `ssh <host> true` against OTTO_T3_HOST. With no host the server is on the Mac, which is then always reachable. */
export async function macReachable(host = t3Host()): Promise<boolean> {
  if (!host) return true
  const p = Bun.spawn(sshCmd(host, ['true']), { stdout: 'ignore', stderr: 'ignore', timeout: 15_000 })
  return (await p.exited) === 0
}
