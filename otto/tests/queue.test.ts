import { test, expect } from 'bun:test'
import { holdReason, holdUntil, coalesce, isRich, type HoldState, type QueuedMessage } from '../queue.ts'

const NOW = Date.parse('2026-08-11T20:00:00Z')
const later = (mins: number) => new Date(NOW + mins * 60_000).toISOString()

function msg(text: string, over: Partial<QueuedMessage> = {}): QueuedMessage {
  return { id: text.slice(0, 3), chat_id: '1', text, queuedAt: later(-10), reason: 'snooze', ...over }
}

test('urgent always goes through', () => {
  const state: HoldState = { snoozeUntil: later(60), busyUntil: later(60), inQuietHours: true }
  expect(holdReason(state, { priority: 'urgent', conversational: false, now: NOW })).toBeNull()
})

test('answering something the user just said always goes through', () => {
  const state: HoldState = { snoozeUntil: later(60), inQuietHours: true }
  expect(holdReason(state, { priority: 'normal', conversational: true, now: NOW })).toBeNull()
})

test('holds are ordered snooze, busy, quiet', () => {
  const all: HoldState = { snoozeUntil: later(60), busyUntil: later(30), inQuietHours: true }
  expect(holdReason(all, { priority: 'normal', conversational: false, now: NOW })).toBe('snooze')

  const noSnooze: HoldState = { busyUntil: later(30), inQuietHours: true }
  expect(holdReason(noSnooze, { priority: 'normal', conversational: false, now: NOW })).toBe('busy')

  expect(holdReason({ inQuietHours: true }, { priority: 'normal', conversational: false, now: NOW })).toBe('quiet')
})

test('an expired snooze stops holding', () => {
  const state: HoldState = { snoozeUntil: later(-1) }
  expect(holdReason(state, { priority: 'normal', conversational: false, now: NOW })).toBeNull()
})

test('a malformed timestamp does not hold anything hostage', () => {
  const state: HoldState = { snoozeUntil: 'not a date', busyUntil: '' }
  expect(holdReason(state, { priority: 'normal', conversational: false, now: NOW })).toBeNull()
})

test('nothing set means send now', () => {
  expect(holdReason({}, { priority: 'normal', conversational: false, now: NOW })).toBeNull()
})

test('holdUntil reports the lift time, and nothing for quiet hours', () => {
  const state: HoldState = { snoozeUntil: later(60), busyUntil: later(30) }
  expect(holdUntil(state, 'snooze')).toBe(later(60))
  expect(holdUntil(state, 'busy')).toBe(later(30))
  expect(holdUntil(state, 'quiet')).toBeUndefined()
})

test('coalescing folds messages into one send with a count', () => {
  const out = coalesce([msg('bill due friday'), msg('flight on time'), msg('marco replied')])
  expect(out).toHaveLength(1)
  expect(out[0]).toStartWith('held while you were away (3):')
  expect(out[0]).toContain('bill due friday')
  expect(out[0]).toContain('marco replied')
})

test('a single held message does not get a count', () => {
  expect(coalesce([msg('only one')])[0]).toStartWith('held while you were away:')
})

test('coalescing splits rather than exceeding the Telegram limit', () => {
  const big = Array.from({ length: 12 }, (_, i) => msg('x'.repeat(400) + i))
  const out = coalesce(big)
  expect(out.length).toBeGreaterThan(1)
  for (const part of out) expect(part.length).toBeLessThanOrEqual(4096)
  // Nothing is dropped on the way through.
  for (let i = 0; i < 12; i++) expect(out.join('')).toContain('x'.repeat(400) + i)
})

test('an empty queue coalesces to nothing', () => {
  expect(coalesce([])).toEqual([])
})

test('messages carrying buttons or files are not digest material', () => {
  expect(isRich(msg('plain'))).toBe(false)
  expect(isRich(msg('with buttons', { buttons: [{ label: 'ok', data: 'ok' }] }))).toBe(true)
  expect(isRich(msg('with files', { files: ['/tmp/a.png'] }))).toBe(true)
})

test('a flight in the air holds normal messages until it lands', () => {
  const air: HoldState = { airborneUntil: later(90), busyUntil: later(30), inQuietHours: true }
  expect(holdReason(air, { priority: 'normal', conversational: false, now: NOW })).toBe('inflight')
  expect(holdUntil(air, 'inflight')).toBe(later(90))
  // Snooze still outranks it; urgent and live conversation still go through.
  expect(holdReason({ ...air, snoozeUntil: later(10) }, { priority: 'normal', conversational: false, now: NOW })).toBe('snooze')
  expect(holdReason(air, { priority: 'urgent', conversational: false, now: NOW })).toBeNull()
  expect(holdReason(air, { priority: 'normal', conversational: true, now: NOW })).toBeNull()
  // Landed: the hold is gone.
  expect(holdReason({ airborneUntil: later(-1) }, { priority: 'normal', conversational: false, now: NOW })).toBeNull()
})

test('a flush that includes in-flight holds is a landing digest', () => {
  const [digest] = coalesce([msg('one', { reason: 'inflight' }), msg('two', { reason: 'quiet' })])
  expect(digest.startsWith('held while you were in the air (2):')).toBe(true)
  expect(coalesce([msg('one', { reason: 'quiet' })])[0].startsWith('held while you were away:')).toBe(true)
})
