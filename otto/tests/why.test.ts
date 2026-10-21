import { test, expect } from 'bun:test'
import { srcOf, cronWords, whenWords, whyFor, type TriggerLike } from '../why.ts'

const NOW = Date.parse('2026-10-21T10:00:00Z')
const TZ = 'Europe/Berlin'
const ctx = { now: NOW, tz: TZ }

const cron = (over: Partial<TriggerLike> = {}): TriggerLike => ({
  id: 'ab12', type: 'cron', schedule: '57 8 * * *', action: 'Send the user a morning brief (Telegram chat_id: 1234567890)', repeating: true, ...over,
})

test('srcOf keeps trigger ids and plain events', () => {
  expect(srcOf('trigger', { trigger_id: 'ab12' })).toBe('trigger:ab12')
  expect(srcOf('email-scan', {})).toBe('email-scan')
  expect(srcOf('webhook', {})).toBe('webhook')
  expect(srcOf('button', {})).toBe('button')
})

test('srcOf splits channel nudges by meta key', () => {
  const keys: [string, string][] = [
    ['escalation', 'nudge:loops'], ['cancel_guard', 'nudge:cancel'], ['trip_event', 'nudge:trip'],
    ['receipt', 'nudge:receipt'], ['change_count', 'nudge:calendar'], ['tz_to', 'nudge:timezone'],
    ['backup_failures', 'nudge:backup'], ['stayLimits', 'nudge:stay'], ['loop_housekeeping', 'nudge:housekeeping'],
  ]
  for (const [k, want] of keys) expect(srcOf('trigger', { [k]: '1' })).toBe(want)
  expect(srcOf('trigger', {})).toBe('nudge')
})

test('cronWords handles the common shapes', () => {
  expect(cronWords('57 8 * * *')).toBe('every day at 08:57')
  expect(cronWords('0 9 * * 1-5')).toBe('weekdays at 09:00')
  expect(cronWords('0 18 * * 1')).toBe('every Monday at 18:00')
  expect(cronWords('*/15 * * * *')).toBe('every 15 minutes')
  expect(cronWords('0 */3 * * *')).toBe('every 3 hours')
  expect(cronWords('57 8 * * *', TZ)).toBe('every day at 08:57 (Europe/Berlin)')
  expect(cronWords('5 4 1 * *')).toContain('5 4 1 * *')
})

test('whyFor is null for replies', () => {
  for (const s of ['chat', 'button', 'terminal', '']) expect(whyFor(s, ctx)).toBeNull()
})

test('a recurring trigger is described by its gist and schedule', () => {
  const w = whyFor('trigger:ab12', { ...ctx, trigger: cron() })!
  expect(w.startsWith('Your trigger "morning brief')).toBe(true)
  expect(w).toContain('every day at 08:57')
  expect(w).not.toContain('1234567890')
})

test('a long action is cut to 60 chars', () => {
  const w = whyFor('trigger:ab12', { ...ctx, trigger: cron({ action: 'x'.repeat(200) }) })!
  const quoted = w.match(/"(.*)"/)![1]
  expect(quoted.length).toBe(61)
  expect(quoted.endsWith('…')).toBe(true)
})

test('a one-shot reads as a reminder', () => {
  const w = whyFor('trigger:ab12', { ...ctx, trigger: cron({ schedule: '2026-10-21T14:00:00+02:00', repeating: false }) })!
  expect(w).toContain('A reminder you set for')
  expect(w).toContain('Wed 21 Oct')
  expect(w).toContain('14:00')
  expect(w).toContain('(Europe/Berlin)')
  expect(whenWords('2026-10-21T14:00:00+02:00', TZ)).toBe('Wed 21 Oct, 14:00 (Europe/Berlin)')
})

test('an email trigger names its condition; a gone trigger says so', () => {
  const t = cron({ type: 'email', schedule: undefined, condition: 'an email from the landlord arrives' })
  expect(whyFor('trigger:ab12', { ...ctx, trigger: t })).toContain('fires when an email from the landlord arrives')
  expect(whyFor('trigger:ab12', { ...ctx, trigger: null })).toBe('A trigger that has since been removed (ab12)')
})

test('a trigger it cannot word gives no explanation rather than a throw', () => {
  expect(whyFor('trigger:ab12', { ...ctx, trigger: cron({ schedule: '2026-10-21T14:00:00', tz: 'Not/AZone' }) })).toBeNull()
  expect(whyFor('trigger:ab12', { ...ctx, trigger: cron({ schedule: 'due 2026-10-21 whenever' }) })).toBeNull()
})

test('email scan and webhook', () => {
  const scan = whyFor('email-scan', { ...ctx, scanMinutes: 60, meta: { last_scan: '2026-10-21T09:30:00Z' } })!
  expect(scan).toContain('every 60 min')
  expect(scan).toContain('last run 11:30')
  expect(whyFor('email-scan', { ...ctx, scanMinutes: 60, meta: { last_scan: 'never' } })).not.toContain('last run')
  expect(whyFor('webhook', { ...ctx, meta: { webhook_source: 'gmail' } })).toBe('A webhook from gmail')
  expect(whyFor('webhook', ctx)).toBe('An external webhook')
})

test('every nudge has its own words', () => {
  const srcs = ['loops', 'cancel', 'trip', 'receipt', 'calendar', 'timezone', 'backup', 'stay', 'housekeeping'].map(k => `nudge:${k}`)
  const words = [...srcs, 'nudge'].map(s => whyFor(s, ctx)!)
  for (const w of words) expect(w.length).toBeGreaterThan(0)
  expect(new Set(words).size).toBe(words.length)
  expect(whyFor('nudge:loops', ctx)).toContain('two per due date')
})

test('held batches say where the user was', () => {
  expect(whyFor('queue-flush', { ...ctx, hold: { reason: 'quiet', count: 3 } })).toBe('3 messages held while you were asleep, delivered together')
  expect(whyFor('queue-flush', { ...ctx, hold: { reason: 'inflight', count: 1, inner: 'The email scan' } })).toBe('Held while you were in the air — originally: The email scan')
  expect(whyFor('queue-flush', { ...ctx, hold: { reason: 'quiet', count: 1 } })).toBe('Held while you were asleep')
  expect(whyFor('queue-flush', { ...ctx, hold: { reason: 'snooze', count: 2 } })).toContain('snoozed')
  expect(whyFor('queue-flush', { ...ctx, hold: { reason: 'busy', count: 2 } })).toContain('in a calendar event')
})
