import { test, expect } from 'bun:test'
import {
  canaryVerdict,
  handshakeSeen,
  errorCount,
  errorSpike,
  formatOutcome,
  canaryPlan,
  HANDSHAKE,
  HANDSHAKE_DEADLINE_MS,
  type LogLine,
} from '../canary.ts'
import { readFileSync } from 'fs'

const DEPLOYED = Date.parse('2026-08-12T09:00:00Z')
const at = (s: number) => DEPLOYED + s * 1000
const line = (text: string, s?: number): LogLine => (s === undefined ? { text } : { at: at(s), text })

const HANDSHAKE_LINE = 'otto channel: channel host (env) — taking the Telegram token'

test('the handshake is the boot line only a working channel prints', () => {
  expect(handshakeSeen([line(HANDSHAKE_LINE, 4)], DEPLOYED)).toBe(true)
  // Merely starting is not a handshake — the token claim is.
  expect(handshakeSeen([line('otto channel: not a channel host — serving tools only', 4)], DEPLOYED)).toBe(false)
})

test('a handshake inside the window is healthy', () => {
  const v = canaryVerdict({ deployedAt: DEPLOYED, now: at(6), lines: [line(HANDSHAKE_LINE, 5)] })
  expect(v).toEqual({ state: 'healthy', handshakeMs: 6000 })
})

test('no handshake yet, inside the window, is waiting — not a revert', () => {
  const v = canaryVerdict({ deployedAt: DEPLOYED, now: at(30), lines: [] })
  expect(v.state).toBe('waiting')
  expect((v as { remainingMs: number }).remainingMs).toBe(HANDSHAKE_DEADLINE_MS - 30_000)
})

test('no handshake by the deadline reverts', () => {
  const v = canaryVerdict({ deployedAt: DEPLOYED, now: at(91), lines: [] })
  expect(v.state).toBe('revert')
  expect((v as { why: string }).why).toContain('no channel handshake in 90s')
})

// Waiting out the rest of the window only extends the outage.
test('an early error spike reverts before the deadline', () => {
  const lines = [
    line('TypeError: undefined is not an object (evaluating \'a.b\')', 2),
    line('RangeError: invalid array length', 3),
    line('otto channel: history append failed: EACCES', 4),
  ]
  const v = canaryVerdict({ deployedAt: DEPLOYED, now: at(10), lines })
  expect(v.state).toBe('revert')
  expect((v as { why: string }).why).toContain('3 distinct errors')
})

// One crash looping is one thing wrong. Counting lines would revert a build
// whose only problem was a single bad minute.
test('the same crash repeated is counted once', () => {
  const one = 'TypeError: undefined is not an object (evaluating \'access.allowFrom\')'
  const lines = Array.from({ length: 8 }, (_, i) => line(one, i))
  expect(errorCount(lines, DEPLOYED)).toBe(1)
  expect(errorSpike(lines, DEPLOYED)).toBe(false)
})

test('a spike still wins over a handshake that arrived alongside it', () => {
  const lines = [
    line('TypeError: a', 1),
    line('RangeError: b', 2),
    line('SyntaxError: c', 3),
    line(HANDSHAKE_LINE, 4),
  ]
  expect(canaryVerdict({ deployedAt: DEPLOYED, now: at(5), lines }).state).toBe('revert')
})

test('ordinary chatter is not an error', () => {
  const lines = [line('otto channel: firing trigger a1b2c3', 1), line(HANDSHAKE_LINE, 2)]
  expect(errorCount(lines, DEPLOYED)).toBe(0)
  expect(canaryVerdict({ deployedAt: DEPLOYED, now: at(3), lines }).state).toBe('healthy')
})

test('unstamped lines are kept — the log is truncated at deploy time instead', () => {
  expect(handshakeSeen([line(HANDSHAKE_LINE)], DEPLOYED)).toBe(true)
})

test('lines from before the deploy are ignored', () => {
  expect(handshakeSeen([{ at: DEPLOYED - 60_000, text: HANDSHAKE_LINE }], DEPLOYED)).toBe(false)
})

// The user did not ask for a deploy report.
test('a successful deploy says nothing at all', () => {
  expect(formatOutcome({ verdict: { state: 'healthy', handshakeMs: 4000 }, what: 'the reply tool', downMs: 4000 })).toBeNull()
  expect(formatOutcome({ verdict: { state: 'waiting', remainingMs: 1000 }, what: 'x', downMs: 1000 })).toBeNull()
})

test('a failed deploy says what broke, that it rolled back, and how long it was down', () => {
  const text = formatOutcome({
    verdict: { state: 'revert', why: 'no channel handshake in 90s' },
    revertedTo: 'otto-known-good/20260812T090000Z',
    what: 'the reply tool',
    downMs: 128_000,
  })!
  expect(text).toContain('the reply tool')
  expect(text).toContain('no channel handshake')
  expect(text).toContain('Rolled back')
  expect(text).toContain('down about 128s')
})

test('the plan typechecks before it tests, and restarts through otto-ctl.sh', () => {
  const p = canaryPlan({ now: DEPLOYED, home: '/home/x/.otto', label: 'x' })
  expect(p.checks[0]).toContain('tsc')
  expect(p.checks[1]).toEqual(['bun', 'test', 'otto/'])
  expect(p.kickstart).toEqual(['bash', '/home/x/.otto/scripts/otto-ctl.sh', 'restart'])
  expect(p.tag).toBe('otto-known-good/x')
  expect(p.deadlineMs).toBe(HANDSHAKE_DEADLINE_MS)
})

// HANDSHAKE is coupled to a string literal in another file. If someone reworded
// that line, every deploy would revert itself ninety seconds later and the
// symptom would look like a broken deploy script rather than a broken regex.
test('HANDSHAKE still matches the line server.ts actually prints', () => {
  const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  const line = /process\.stderr\.write\(`(otto channel: channel host[^`]*)`\)/.exec(src)?.[1]
  expect(line).toBeDefined()
  // Substitute the template hole the way the running server would.
  const printed = line!.replace('${reason}', 'OTTO_CHANNEL_HOST').replace(/\\n$/, '')
  expect(HANDSHAKE.test(printed)).toBe(true)
})
