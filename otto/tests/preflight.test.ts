import { test, expect } from 'bun:test'
import { preflight, inQuiet, sameGist, formatReport, type ArmedTrigger } from '../preflight'

const T0 = Date.parse('2026-08-12T09:00:00Z')
const HOUR = 60 * 60 * 1000
const daily = (hourUtc: number, n = 5) =>
  Array.from({ length: n }, (_, i) => Date.parse(`2026-08-1${2 + i}T${String(hourUtc).padStart(2, '0')}:00:00Z`))

const base = {
  type: 'cron' as const,
  schedule: '0 9 * * *',
  action: 'send the user the morning brief for today',
  repeating: true,
}
const ctx = (over: Partial<Parameters<typeof preflight>[2]> = {}) => ({
  fires: daily(9),
  quiet: { start: 23, end: 7 },
  tz: 'UTC',
  now: T0,
  ...over,
})

test('a well-formed trigger passes with its fire times shown', () => {
  const r = preflight(base, [], ctx())
  expect(r.errors).toEqual([])
  expect(r.warnings).toEqual([])
  expect(r.fires).toHaveLength(5)
  expect(formatReport(r)).toContain('next:')
})

test('a cron with no computable fire time is an error', () => {
  const r = preflight({ ...base, schedule: 'nonsense' }, [], ctx({ fires: [] }))
  expect(r.errors.map(e => e.code)).toContain('no-fire')
})

test('firing inside quiet hours is blocked', () => {
  const r = preflight({ ...base, schedule: '0 3 * * *' }, [], ctx({ fires: daily(3) }))
  expect(r.errors.map(e => e.code)).toContain('quiet-hours')
  expect(r.errors[0].message).toContain('23:00')
})

test('the quiet-hours block can be overridden explicitly', () => {
  const r = preflight({ ...base, schedule: '0 3 * * *' }, [], ctx({ fires: daily(3), allowQuiet: true }))
  expect(r.errors).toEqual([])
})

test('quiet hours are evaluated in the trigger timezone, not UTC', () => {
  // 09:00 in Buenos Aires is 12:00 UTC, which is outside quiet hours either way;
  // 02:00 Buenos Aires is 05:00 UTC, which is inside the user’s 23-07 window.
  const fires = [Date.parse('2026-08-12T05:00:00Z')]
  const inZone = preflight({ ...base, tz: 'America/Argentina/Buenos_Aires' }, [], ctx({ fires, tz: 'America/Argentina/Buenos_Aires' }))
  expect(inZone.errors.map(e => e.code)).toContain('quiet-hours')
})

test('a wrapping quiet window is handled', () => {
  expect(inQuiet(2, { start: 23, end: 7 })).toBe(true)
  expect(inQuiet(23, { start: 23, end: 7 })).toBe(true)
  expect(inQuiet(12, { start: 23, end: 7 })).toBe(false)
  expect(inQuiet(7, { start: 23, end: 7 })).toBe(false)
  expect(inQuiet(3, null)).toBe(false)
})

test('context-dependent action text is flagged', () => {
  for (const action of [
    'remind the user about that',
    'follow up on the above',
    'send it to Marco as discussed',
  ]) {
    const r = preflight({ ...base, action }, [], ctx())
    expect(r.warnings.map(w => w.code)).toContain('vague-action')
  }
})

test('an action naming real things is not flagged as vague', () => {
  const r = preflight(
    { ...base, action: 'ask the user whether the Enel bill for August was paid' },
    [],
    ctx(),
  )
  expect(r.warnings.map(w => w.code)).not.toContain('vague-action')
})

test('"this morning" is a time, not a dangling reference', () => {
  const r = preflight({ ...base, action: 'send the digest of everything that arrived this morning' }, [], ctx())
  expect(r.warnings.map(w => w.code)).not.toContain('vague-action')
})

test('a two-word action is flagged as too thin', () => {
  const r = preflight({ ...base, action: 'remind the user' }, [], ctx())
  expect(r.warnings.map(w => w.code)).toContain('thin-action')
})

test('an identical armed trigger is surfaced as a duplicate', () => {
  const armed: ArmedTrigger[] = [
    { id: 'abc123', type: 'cron', schedule: '0 9 * * *', action: 'send the morning brief to the user today', enabled: true },
  ]
  const r = preflight(base, armed, ctx())
  expect(r.warnings.map(w => w.code)).toContain('duplicate')
  expect(r.warnings.find(w => w.code === 'duplicate')!.message).toContain('abc123')
})

test('a disabled trigger, or the trigger being edited, is not its own duplicate', () => {
  const armed: ArmedTrigger[] = [
    { id: 'off', type: 'cron', schedule: '0 9 * * *', action: 'send the morning brief to the user today', enabled: false },
    { id: 'self', type: 'cron', schedule: '0 9 * * *', action: 'send the morning brief to the user today', enabled: true },
  ]
  const r = preflight({ ...base, id: 'self' }, armed, ctx())
  expect(r.warnings.map(w => w.code)).not.toContain('duplicate')
})

test('a different action on the same schedule is not a duplicate', () => {
  const armed: ArmedTrigger[] = [
    { id: 'x', type: 'cron', schedule: '0 9 * * *', action: 'check whether the permesso appointment page has slots', enabled: true },
  ]
  expect(preflight(base, armed, ctx()).warnings.map(w => w.code)).not.toContain('duplicate')
})

test('sub-hourly schedules are flagged as a stream', () => {
  const fires = [0, 1, 2, 3].map(i => T0 + i * 15 * 60 * 1000)
  const r = preflight({ ...base, schedule: '*/15 * * * *' }, [], ctx({ fires }))
  expect(r.warnings.map(w => w.code)).toContain('frequent')
})

test('hourly is not flagged', () => {
  const fires = [0, 1, 2, 3].map(i => T0 + i * HOUR)
  expect(preflight(base, [], ctx({ fires })).warnings.map(w => w.code)).not.toContain('frequent')
})

test('email triggers skip the schedule checks entirely', () => {
  const r = preflight(
    { type: 'email', condition: 'an invoice from Enel arrives', action: 'tell the user the amount and due date', repeating: true },
    [],
    ctx({ fires: [] }),
  )
  expect(r.errors).toEqual([])
})

test('gist matching catches reordered wording but not different subjects', () => {
  expect(sameGist('send the morning brief to the user', 'send the user the morning brief')).toBe(true)
  expect(sameGist('check the Enel bill', 'book a dentist appointment')).toBe(false)
})
