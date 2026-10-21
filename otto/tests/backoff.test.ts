import { test, expect } from 'bun:test'
import { Cron } from 'croner'
import { subDaily, startRun, slowed, planOffer, applyTap, type BackoffTrigger } from '../backoff.ts'
import { classify } from '../selfedit.ts'

const NOW = Date.parse('2026-10-21T10:00:00Z')
const trig = (o: Partial<BackoffTrigger> = {}): BackoffTrigger => ({
  id: 'b24c8196', action: 'Check the washing machine', schedule: '*/30 8-22 * * *', repeating: true, enabled: true, ...o,
})

test('subDaily: more than once a day only', () => {
  for (const s of ['*/30 8-22 * * *', '0 8,18 * * *', '15 */3 * * *']) expect(subDaily(s)).toBe(true)
  for (const s of ['57 8 * * *', '0 18 * * 1-5', '2026-10-28T10:00:00+01:00', undefined]) expect(subDaily(s)).toBe(false)
})

test('startRun counts only enabled repeating sub-daily triggers', () => {
  const t = trig()
  expect(startRun(t).silentRuns).toBe(1)
  expect(startRun({ ...t, silentRuns: 0 }).silentRuns).toBe(1)
  expect(t.silentRuns).toBeUndefined()
  expect(startRun(trig({ schedule: '57 8 * * *' })).silentRuns).toBeUndefined()
  expect(startRun(trig({ schedule: '2026-10-28T10:00:00+01:00', repeating: false })).silentRuns).toBeUndefined()
  expect(startRun(trig({ schedule: undefined })).silentRuns).toBeUndefined()
  expect(startRun(trig({ enabled: false })).silentRuns).toBeUndefined()
})

test('slowed rewrites hour and minute, keeps the rest', () => {
  const cases: [string, '2h' | 'daily', string | null][] = [
    ['*/30 8-22 * * *', '2h', '0 8-22/2 * * *'],
    ['*/30 8-22 * * *', 'daily', '0 8 * * *'],
    ['*/10 * * * 1-5', '2h', '0 */2 * * 1-5'],
    ['*/10 * * * 1-5', 'daily', '0 9 * * 1-5'],
    ['15 */3 * * *', '2h', null],          // every 2h would be faster than every 3h
    ['0 8,18 * * *', '2h', null],
    ['0 8,18 * * *', 'daily', '0 9 * * *'],
    ['* * * * *', '2h', '0 */2 * * *'],
    ['0 8-8 * * *', 'daily', null],
    ['15 */3 * * *', 'daily', '15 9 * * *'],
    ['*/10 9 * * *', '2h', null],
    ['*/10 9 * * *', 'daily', '0 9 * * *'],
  ]
  for (const [s, c, want] of cases) {
    const got = slowed(s, c)
    expect(got).toBe(want)
    if (got) expect(new Cron(got).nextRun()).toBeInstanceOf(Date)
  }
})

test('planOffer waits for six silent runs and offers once per schedule', () => {
  expect(planOffer(trig({ silentRuns: 5 }), NOW)).toBeNull()
  const o = planOffer(trig({ silentRuns: 6 }), NOW)!
  expect(o.text).toContain('Check the washing machine')
  expect(o.buttons.map(b => b.data)).toEqual(['backoff b24c8196 2h', 'backoff b24c8196 daily', 'backoff b24c8196 keep'])
  expect(o.trigger.backoff).toMatchObject({ offeredFor: '*/30 8-22 * * *', pending: true })

  const one = planOffer(trig({ schedule: '*/10 9 * * *', silentRuns: 6 }), NOW)!
  expect(one.buttons.map(b => b.label)).toEqual(['daily', 'keep it'])
  const every3h = planOffer(trig({ schedule: '15 */3 * * *', silentRuns: 6 }), NOW)!
  expect(every3h.buttons.map(b => b.label)).toEqual(['daily', 'keep it'])
  expect(planOffer(trig({ schedule: '0 8-8 * * *', silentRuns: 6 }), NOW)).toBeNull()

  expect(planOffer(trig({ schedule: '57 8 * * *', silentRuns: 60 }), NOW)).toBeNull()
  expect(planOffer(trig({ silentRuns: 6, enabled: false }), NOW)).toBeNull()
  expect(planOffer(trig({ silentRuns: 6, repeating: false }), NOW)).toBeNull()
  const same = '*/30 8-22 * * *'
  expect(planOffer(trig({ silentRuns: 99, backoff: { offeredFor: same, at: '', pending: true } }), NOW)).toBeNull()
  expect(planOffer(trig({ silentRuns: 99, backoff: { offeredFor: same, at: '', pending: false, decision: 'keep' } }), NOW)).toBeNull()
  expect(planOffer(trig({ silentRuns: 6, backoff: { offeredFor: '0 * * * *', at: '', pending: false, decision: '2h' } }), NOW)).not.toBeNull()

  const long = planOffer(trig({ silentRuns: 6, action: 'x'.repeat(100) }), NOW)!
  expect(long.text).toContain('x'.repeat(48) + '…')
  expect(long.text).not.toContain('x'.repeat(49))
})

test('applyTap honours only the pending offer for the current schedule', () => {
  const pending = (o: Partial<BackoffTrigger> = {}) =>
    trig({ silentRuns: 6, backoff: { offeredFor: '*/30 8-22 * * *', at: '', pending: true }, ...o })
  const other = trig({ id: 'other1' })

  expect(applyTap([pending()], 'something else', NOW).ok).toBe(false)
  expect(applyTap([pending()], 'backoff nope 2h', NOW).ok).toBe(false)
  const none = applyTap([trig()], 'backoff b24c8196 2h', NOW)
  expect(none).toEqual({ ok: false, line: 'that offer is out of date' })
  expect(applyTap([pending({ schedule: '0 * * * *' })], 'backoff b24c8196 2h', NOW).ok).toBe(false)

  const input = [pending(), other]
  const frozen = JSON.stringify(input)
  const kept = applyTap(input, 'backoff b24c8196 keep', NOW)
  if (!kept.ok) throw new Error(kept.line)
  expect(kept.schedule).toBeUndefined()
  expect(kept.trigger).toMatchObject({ schedule: '*/30 8-22 * * *', backoff: { pending: false, decision: 'keep' } })
  expect(kept.triggers[1]).toBe(other)
  expect(JSON.stringify(input)).toBe(frozen)

  const slow = applyTap(input, 'backoff b24c8196 2h', NOW)
  if (!slow.ok) throw new Error(slow.line)
  expect(slow.schedule).toBe('0 8-22/2 * * *')
  expect(slow.trigger).toMatchObject({
    schedule: '0 8-22/2 * * *', silentRuns: 0,
    backoff: { offeredFor: '0 8-22/2 * * *', pending: false, decision: '2h' },
  })
  expect(slow.line).toContain('0 8-22/2 * * *')
  expect(slow.line).toContain('*/30 8-22 * * *')
  expect(JSON.stringify(input)).toBe(frozen)

  // the offer is spent
  expect(applyTap(slow.triggers, 'backoff b24c8196 2h', NOW).ok).toBe(false)
})

test('the tap may rewrite a trigger schedule, an external source may not', () => {
  const tap = { kind: 'tapped' as const, buttonData: 'backoff b24c8196 2h' }
  expect(classify(['trigger:b24c8196/schedule'], 'user-typed', tap).allowed).toBe(true)
  expect(classify(['trigger:b24c8196/schedule'], 'external-content', tap).allowed).toBe(false)
})
