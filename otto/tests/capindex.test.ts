import { test, expect } from 'bun:test'
import {
  surface,
  lastUsed,
  neverUsed,
  matchLine,
  recordMention,
  recordDecline,
  CAPABILITIES,
  WEEK_MS,
  type SurfaceState,
} from '../capindex.ts'
import type { HistoryLine } from '../repetition.ts'

const NOW = Date.parse('2026-08-12T09:00:00Z')
const NONE = new Map<string, number>()

function inb(text: string): HistoryLine {
  return { ts: new Date(NOW).toISOString(), dir: 'in', text, kind: 'text' }
}

test('a message about a price matches the price watch', () => {
  expect(matchLine(CAPABILITIES, 'is that jacket price down yet').map(c => c.id)).toEqual(['price-watch'])
})

test('a message about nothing in particular matches nothing', () => {
  expect(matchLine(CAPABILITIES, 'play something by caetano')).toEqual([])
})

test('doing it by hand surfaces the capability once, in that moment', () => {
  const m = surface(inb('can you check that jacket price again'), NONE, {}, NOW)!
  expect(m.capability.id).toBe('price-watch')
  expect(m.text).toContain('watch that page daily')
  expect(m.buttons).toHaveLength(2)
  for (const b of m.buttons) expect(Buffer.byteLength(b.data, 'utf8')).toBeLessThanOrEqual(60)
})

test('a capability already in use is never pitched', () => {
  const usage = lastUsed(CAPABILITIES, [{ at: NOW - 1000, text: 'Watch the price of X daily and report changes' }])
  expect(usage.has('price-watch')).toBe(true)
  expect(surface(inb('check that jacket price again'), usage, {}, NOW)).toBeNull()
})

test('never-used is derived from the same evidence', () => {
  const usage = lastUsed(CAPABILITIES, [{ at: NOW, text: 'daily price watch on the shop page' }])
  expect(neverUsed(CAPABILITIES, usage).map(c => c.id)).not.toContain('price-watch')
  expect(neverUsed(CAPABILITIES, usage).map(c => c.id)).toContain('bill-reminder')
})

// The cost of one unwanted suggestion is not one unwanted suggestion.
test('at most one mention a week, across every capability', () => {
  const state: SurfaceState = { lastAt: NOW - WEEK_MS + 60_000 }
  expect(surface(inb('check that jacket price again'), NONE, state, NOW)).toBeNull()
  expect(surface(inb('check that jacket price again'), NONE, { lastAt: NOW - WEEK_MS - 1 }, NOW)).not.toBeNull()
})

test('a capability mentioned once is never mentioned again', () => {
  const after = recordMention({}, 'price-watch', NOW)
  expect(after.mentioned!['price-watch']).toBe(NOW)
  // Even a week later, when the weekly cap has lifted.
  expect(surface(inb('check that price again'), NONE, after, NOW + WEEK_MS + 1)).toBeNull()
})

test('a declined capability stays declined', () => {
  const after = recordDecline({}, 'bill-reminder')
  expect(surface(inb('remind me the rent bill is due friday'), NONE, after, NOW)).toBeNull()
})

test('an ambiguous message pitches nothing rather than guessing', () => {
  // "due" is a bill-reminder word and "week" a weekly-review one.
  const m = surface(inb('is the invoice due this week'), NONE, {}, NOW)
  expect(m).toBeNull()
  expect(matchLine(CAPABILITIES, 'is the invoice due this week').length).toBeGreaterThan(1)
})

test('an acknowledgement is not a moment to pitch anything', () => {
  expect(surface(inb('ok'), NONE, {}, NOW)).toBeNull()
  expect(surface(inb('👍'), NONE, {}, NOW)).toBeNull()
})

test("Otto's own outbound message never triggers a pitch", () => {
  const out: HistoryLine = { ts: new Date(NOW).toISOString(), dir: 'out', text: 'the price dropped', kind: 'text' }
  expect(surface(out, NONE, {}, NOW)).toBeNull()
})

test('the mention rides along as a side note, not as a message of its own', () => {
  const m = surface(inb('any reply from marco yet'), NONE, {}, NOW)!
  expect(m.capability.id).toBe('follow-up')
  expect(m.text).toStartWith('(side note')
  expect(m.text).toEndWith("if that's useful.)")
})

test('state after a mention blocks both the id and the week', () => {
  const m = surface(inb('check that jacket price again'), NONE, {}, NOW)!
  const state = recordMention({}, m.capability.id, NOW)
  expect(state.lastAt).toBe(NOW)
  expect(surface(inb('any reply from marco yet'), NONE, state, NOW + 60_000)).toBeNull()
})
