import { expect, test } from 'bun:test'
import { frontActive, frontShouldAnswer, frontMode, frontReply, frontPrompt, askFront } from '../front.ts'

const now = Date.parse('2026-11-01T12:00:00Z')

test('off unless enabled, and only until its end date', () => {
  expect(frontActive(undefined, now)).toBe(false)
  expect(frontActive({ enabled: true }, now)).toBe(true)
  expect(frontActive({ enabled: true, until: '2026-11-02T12:00:00Z' }, now)).toBe(true)
  expect(frontActive({ enabled: true, until: '2026-11-01T11:00:00Z' }, now)).toBe(false)
})

test('answers only when a turn has been running a while', () => {
  const cfg = { enabled: true, busySeconds: 20 }
  expect(frontShouldAnswer(cfg, false, now - 60_000, now)).toBe(false)
  expect(frontShouldAnswer(cfg, true, now - 5_000, now)).toBe(false)
  expect(frontShouldAnswer(cfg, true, now - 30_000, now)).toBe(true)
})

test('DONE settles it, ACK passes it on, PASS and junk send nothing', () => {
  expect(frontReply('PASS')).toBeNull()
  expect(frontReply('hello there')).toBeNull()
  expect(frontReply('ACK: ' + 'x'.repeat(300))).toBeNull()
  expect(frontReply('ACK: "on it after the build"')).toEqual({ done: false, text: 'on it after the build' })
  expect(frontReply('done: tuesday at 9')).toEqual({ done: true, text: 'tuesday at 9' })
  expect(frontReply('checking reminders\nDONE: 17:10')).toEqual({ done: true, text: '17:10' })
})

test('the prompt carries the thread, memory and the new message', () => {
  const { system, user } = frontPrompt([{ dir: 'in', text: 'hey', ts: '' }, { dir: 'out', text: 'yo', ts: '' }], 'you there?', new Date(), 'loop: dentist tuesday')
  expect(system).toContain('DONE')
  expect(user).toContain('them: hey')
  expect(user).toContain('dentist tuesday')
  expect(user).toContain('you there?')
})

test('a failed or odd run is a silent pass', async () => {
  expect(await askFront(async () => { throw new Error('no claude') }, [], 'hi')).toBeNull()
  expect(await askFront(async () => '', [], 'hi')).toBeNull()
  expect(await askFront(async () => 'ACK: mid-build, give me a sec\n', [], 'hi')).toEqual({ done: false, text: 'mid-build, give me a sec' })
})

test('triage when free, cover when busy a while, nothing when off or turned down', () => {
  const now = Date.parse('2026-11-01T12:00:00Z')
  const cfg = { enabled: true }
  expect(frontMode(cfg, false, 0, now)).toBe('triage')
  expect(frontMode(cfg, true, now - 5_000, now)).toBe('triage')
  expect(frontMode(cfg, true, now - 30_000, now)).toBe('cover')
  expect(frontMode({ enabled: true, triage: false }, false, 0, now)).toBeNull()
  expect(frontMode({ enabled: false }, false, 0, now)).toBeNull()
})

test('triage settles with DONE and passes everything else, an ACK included', async () => {
  expect(await askFront(async () => 'DONE: lol fair', [], 'haha', '', 'triage')).toEqual({ done: true, text: 'lol fair' })
  expect(await askFront(async () => 'ACK: on it', [], 'book me a table', '', 'triage')).toBeNull()
  expect(await askFront(async () => 'PASS', [], 'book me a table', '', 'triage')).toBeNull()
  const { user } = frontPrompt([], 'hi', new Date(), '', 'triage')
  expect(user).toContain('You decide who answers')
  expect(user).not.toContain('ACK:')
})
