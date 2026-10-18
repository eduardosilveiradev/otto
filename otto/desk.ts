/**
 * Whether the user is at their desk, from a local presence watcher that writes
 * `<present|away|paused> <since epoch seconds>` to ~/.config/desk-presence/state
 * and rewrites it at least once a minute. No file, or one gone stale, is no
 * signal at all — never "away".
 */
import assert from 'assert'
import { readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const STATE = join(homedir(), '.config', 'desk-presence', 'state')
const STALE_MS = 5 * 60_000

function ago(ms: number): string {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

/** "at desk 12m", "away 1h05", "watcher paused", or undefined when unknown. */
export function deskLine(text: string, mtimeMs: number, now = Date.now()): string | undefined {
  if (now - mtimeMs > STALE_MS) return undefined
  const [word, since] = text.trim().split(/\s+/)
  const dur = ago(Math.max(0, now - Number(since) * 1000))
  if (word === 'present') return `at desk ${dur}`
  if (word === 'away') return `away ${dur}`
  if (word === 'paused') return 'watcher paused'
  return undefined
}

export function deskNow(path = STATE): string | undefined {
  try {
    return deskLine(readFileSync(path, 'utf8'), statSync(path).mtimeMs)
  } catch {
    return undefined
  }
}

if (import.meta.main) {
  const now = 1_000_000_000_000
  const s = now / 1000
  assert.ok(deskLine(`present ${s - 720}`, now, now) === 'at desk 12m')
  assert.ok(deskLine(`away ${s - 3900}`, now, now) === 'away 1h05')
  assert.ok(deskLine(`paused ${s}`, now, now) === 'watcher paused')
  assert.ok(deskLine(`away ${s}`, now - STALE_MS - 1, now) === undefined, 'stale is unknown')
  assert.ok(deskLine('garbage', now, now) === undefined)
  console.log(deskNow() ?? '(no signal)')
}
