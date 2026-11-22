/** Shared intent for deliberate restarts. Failed exits always cancel intent. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const RESTART_WINDOW_MS = 60_000
export const restartStateDir = () => process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
export type RestartIntent = { reason: string; at: number; consumedAt?: number; failed?: boolean }

export function readRestart(dir: string): RestartIntent | null {
  try {
    const s = JSON.parse(readFileSync(join(dir, 'restart.json'), 'utf8'))
    return typeof s.reason === 'string' && Number.isFinite(s.at) ? s : null
  } catch { return null }
}
function save(dir: string, s: RestartIntent): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'restart.json')
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(s) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
export function markRestart(dir: string, reason: string, now = Date.now()): void {
  save(dir, { reason, at: now })
}
export function failRestart(dir: string): void {
  const s = readRestart(dir)
  if (s) save(dir, { ...s, failed: true })
}
export function plannedRestart(s: RestartIntent | null, now: number): s is RestartIntent {
  return !!s && !s.failed && now >= s.at && now - s.at < RESTART_WINDOW_MS
}
/** Consume once: a later crash must not borrow an earlier reload's intent. */
export function consumeRestart(dir: string, now = Date.now()): boolean {
  const s = readRestart(dir)
  if (!plannedRestart(s, now) || s.consumedAt !== undefined) return false
  save(dir, { ...s, consumedAt: now })
  return true
}

if (import.meta.main) {
  if (process.argv[2] === 'failed') failRestart(restartStateDir())
  else markRestart(restartStateDir(), process.argv[2] ?? 'run.sh stop')
}
