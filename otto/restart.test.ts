import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { consumeRestart, failRestart, markRestart, readRestart, RESTART_WINDOW_MS } from './restart.ts'
import { detectCrashLoop, parseCrashes, triage, bugNote } from './selftriage.ts'
import { runDeadman } from './deadman.ts'
import { writeHeartbeat } from './heartbeat.ts'

const dirs: string[] = []
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'otto-restart-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

test('reloads do not reach crash-loop filing; intent is consumed once', () => {
  const d = dir(), starts: number[] = []
  for (const now of [1000, 2000, 3000]) {
    markRestart(d, 'reload tool', now)
    if (!consumeRestart(d, now + 100)) starts.push(now + 100)
  }
  expect(detectCrashLoop(starts, 3100)).toBeNull()
  expect(consumeRestart(d, 3200)).toBe(false)
  expect(readRestart(d)?.reason).toBe('reload tool')
})

test('real crashes still reach crash-loop filing', () => {
  const d = dir(), starts: number[] = []
  for (const now of [1000, 2000, 3000]) {
    if (!consumeRestart(d, now)) starts.push(now)
  }
  expect(detectCrashLoop(starts, 3000)?.restarts).toBe(3)
})

test('an error exit overrides even a fresh reload marker', () => {
  const d = dir()
  markRestart(d, 'reload tool', 1000)
  failRestart(d)
  expect(consumeRestart(d, 1100)).toBe(false)
})

test('a crash after reload intent expires still reaches filing', () => {
  const d = dir()
  markRestart(d, 'reload tool', 1000)
  const now = 1000 + RESTART_WINDOW_MS
  expect(consumeRestart(d, now)).toBe(false)
  const loop = detectCrashLoop([now - 2000, now - 1000, now], now)!
  const note = bugNote(triage(loop, parseCrashes(['PermissionError: permission denied']), []))
  expect(note.kind).toBe('loop')
  expect(note.text).toStartWith('crash loop:')
  expect(note.text).toContain('PermissionError')
})

test('deadman stays silent for deliberate stop, but files if it fails to return', async () => {
  const d = dir(), sent: string[] = []
  writeHeartbeat(join(d, 'heartbeat.json'), { v: 1, pid: 123, at: 1000 })
  markRestart(d, 'run.sh stop', 2000)
  const run = (now: number) => runDeadman({ stateDir: d, now, pidAlive: () => false, quiet: () => false, notify: async s => { sent.push(s) } })
  expect((await run(3000)).why).toBe('deliberate restart')
  expect(sent).toHaveLength(0)
  await run(400_000)
  expect((await run(700_000)).did).toBe('raised')
  expect(sent).toHaveLength(1)
})

test('deadman still files an outage when an error cancels deliberate intent', async () => {
  const d = dir()
  writeHeartbeat(join(d, 'heartbeat.json'), { v: 1, pid: 123, at: 1000 })
  markRestart(d, 'reload tool', 400_000)
  failRestart(d)
  let alerts = 0
  const run = (now: number) => runDeadman({ stateDir: d, now, pidAlive: () => false, quiet: () => false, notify: async () => { alerts++ } })
  await run(401_000)
  expect((await run(402_000)).did).toBe('raised')
  expect(alerts).toBe(1)
})
