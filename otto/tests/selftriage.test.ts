import { test, expect } from 'bun:test'
import {
  parseCrashes,
  parseLaunchdState,
  detectCrashLoop,
  blameSelfInstall,
  triage,
  reproTest,
  bugNote,
  formatIncident,
  signatureOf,
  type Crash,
} from '../selftriage.ts'
import type { CapEntry } from '../changelog.ts'

const NOW = Date.parse('2026-08-12T09:00:00Z')
const ago = (min: number) => NOW - min * 60_000

const TRACE = [
  '2026-08-12T08:40:00.000Z TypeError: undefined is not an object (evaluating \'access.allowFrom.length\')',
  '    at loadAccess (/home/x/otto/server.ts:257:14)',
  '    at gate (/home/x/otto/server.ts:289:3)',
  'otto channel: firing trigger a1b2c3',
]

test('a stack becomes one crash with its frames', () => {
  const [c] = parseCrashes(TRACE)
  expect(c.kind).toBe('TypeError')
  expect(c.message).toContain('access.allowFrom.length')
  expect(c.frames).toHaveLength(2)
  expect(c.at).toBe(Date.parse('2026-08-12T08:40:00.000Z'))
})

test('an unstamped python-style trace still parses', () => {
  const [c] = parseCrashes([
    'PermissionError: [Errno 1] Operation not permitted: \'/home/x/.venv/pyvenv.cfg\'',
    '  File "<frozen site>", line 722, in <module>',
  ])
  expect(c.kind).toBe('PermissionError')
  expect(c.at).toBeUndefined()
  expect(c.frames[0]).toContain('frozen site')
})

test('ordinary log chatter is not a crash', () => {
  expect(parseCrashes(['otto channel: firing trigger a1b2c3', 'otto channel: channel host (env)'])).toEqual([])
})

// Without this the same bug looks like eight different bugs and never groups.
test('the same crash from different lines shares a signature', () => {
  const a = signatureOf('TypeError', "cannot read x of undefined at /home/a/otto/server.ts:257:14")
  const b = signatureOf('TypeError', "cannot read x of undefined at /home/b/otto/server.ts:611:2")
  expect(a).toBe(b)
  expect(signatureOf('TypeError', 'something else')).not.toBe(a)
})

test('launchd state is read by key, not by layout', () => {
  const s = parseLaunchdState(`
  state = running
  pid = 4823
  runs = 17
  last exit code = 1
`)
  expect(s).toEqual({ pid: 4823, runs: 17, lastExitStatus: 1 })
  expect(parseLaunchdState('nothing useful here')).toEqual({})
})

// The noisy-direction failure: a message every time the user shuts the lid.
test('one restart is not a loop', () => {
  expect(detectCrashLoop([ago(3)], NOW)).toBeNull()
  expect(detectCrashLoop([ago(3), ago(2)], NOW)).toBeNull()
})

test('three restarts in ten minutes is a loop', () => {
  const loop = detectCrashLoop([ago(8), ago(5), ago(2)], NOW)!
  expect(loop.restarts).toBe(3)
  expect(loop.firstAt).toBe(ago(8))
})

test('restarts spread across the day are not a loop', () => {
  expect(detectCrashLoop([ago(600), ago(300), ago(2)], NOW)).toBeNull()
})

function install(over: Partial<CapEntry> = {}): CapEntry {
  return {
    id: 'aa11',
    at: new Date(ago(30)).toISOString(),
    what: 'a nocturne CI watch',
    paths: ['otto/skills/recipes/SKILL.md'],
    tier: 'confirmed',
    origin: 'user-typed',
    by: 'forge',
    revert: { kind: 'delete-trigger', triggerId: 'a1b2c3' },
    ...over,
  }
}

test('a self-install inside the hour before the first failure is blamed', () => {
  expect(blameSelfInstall(ago(10), [install()])!.id).toBe('aa11')
})

test('an install from yesterday is not blamed', () => {
  expect(blameSelfInstall(ago(10), [install({ at: new Date(ago(60 * 26)).toISOString() })])).toBeNull()
})

test('an install after the first failure cannot have caused it', () => {
  expect(blameSelfInstall(ago(40), [install({ at: new Date(ago(30)).toISOString() })])).toBeNull()
})

test('the newest install in the window is blamed when several land together', () => {
  const blamed = blameSelfInstall(ago(5), [
    install({ id: 'old', at: new Date(ago(50)).toISOString() }),
    install({ id: 'new', at: new Date(ago(12)).toISOString() }),
  ])
  expect(blamed!.id).toBe('new')
})

test('an already-reverted install is not blamed twice', () => {
  expect(blameSelfInstall(ago(10), [install({ revertedAt: new Date(ago(5)).toISOString() })])).toBeNull()
})

test('a blamed install means revert first, diagnose second', () => {
  const loop = detectCrashLoop([ago(8), ago(5), ago(2)], NOW)!
  const i = triage(loop, parseCrashes(TRACE), [install()])
  expect(i.action).toBe('revert')
  expect(i.blamed!.id).toBe('aa11')
})

test('with nothing to blame, it files a bug instead', () => {
  const loop = detectCrashLoop([ago(8), ago(5), ago(2)], NOW)!
  const i = triage(loop, parseCrashes(TRACE), [])
  expect(i.action).toBe('file-bug')
  expect(i.crash!.kind).toBe('TypeError')
})

// A generated test that passes would certify a live bug as fixed.
test('the generated repro fails on purpose and carries the stack', () => {
  const crash = parseCrashes(TRACE)[0]
  const loop = detectCrashLoop([ago(8), ago(5), ago(2)], NOW)!
  const { path, source } = reproTest(crash, loop)
  expect(path).toStartWith('otto/tests/regressions/')
  expect(path).toEndWith('.test.ts')
  expect(source).toContain('FAILS ON PURPOSE')
  expect(source).toContain('server.ts')
  expect(source).toContain("expect('this crash has no reproduction yet').toBe('reproduced and fixed')")
})

test('the repro survives an apostrophe in the crash message', () => {
  const crash: Crash = { kind: 'Error', message: "it's broken", frames: [], signature: 'x' }
  const loop = detectCrashLoop([ago(8), ago(5), ago(2)], NOW)!
  expect(reproTest(crash, loop).source).toContain("it\\'s broken")
})

test('the note records the cause so the next session need not re-read logs', () => {
  const loop = detectCrashLoop([ago(8), ago(5), ago(2)], NOW)!
  const n = bugNote(triage(loop, parseCrashes(TRACE), [install()]))
  expect(n.kind).toBe('loop')
  expect(n.text).toContain('self-install aa11')
  expect(n.tags).toContain('revert')
})

test('the user gets down, back and cause — and no stack', () => {
  const loop = detectCrashLoop([ago(8), ago(5), ago(2)], NOW)!
  const text = formatIncident(triage(loop, parseCrashes(TRACE), [install()], { recoveredAt: ago(1) }), NOW)
  expect(text).toContain('was down ~7 min')
  expect(text).toContain('3 restarts')
  expect(text).toContain('back up')
  expect(text).toContain('reverted it')
  expect(text).not.toContain('at loadAccess')
})

test('still-down reads differently from recovered', () => {
  const loop = detectCrashLoop([ago(8), ago(5), ago(2)], NOW)!
  const text = formatIncident(triage(loop, parseCrashes(TRACE), []), NOW)
  expect(text).toContain('still restarting')
  expect(text).toContain('TypeError')
})
