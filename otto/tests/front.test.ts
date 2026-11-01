import { expect, test } from 'bun:test'
import { frontActive, frontShouldAnswer, frontMode, frontReply, frontPrompt, askFront, lockedTokens, keepsFacts, skipRewrite, voicePass, frontSystem } from '../front.ts'

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

test('triage settles with DONE, says it is on a job with ACK, passes the rest', async () => {
  expect(await askFront(async () => 'DONE: lol fair', [], 'haha', '', 'triage')).toEqual({ done: true, text: 'lol fair' })
  expect(await askFront(async () => 'ACK: on it', [], 'book me a table', '', 'triage')).toEqual({ done: false, text: 'on it' })
  expect(await askFront(async () => 'PASS', [], 'why is the sky blue', '', 'triage')).toBeNull()
  const { user } = frontPrompt([], 'hi', new Date(), '', 'triage')
  expect(user).toContain('You decide who answers')
})

test('locked tokens: links, codes, and anything with a digit', () => {
  const t = lockedTokens('leave at 16:20, €17 at lux, see https://ex.example/a?b=1. id `f76fa548`, mail me@ex.example, code 389633.')
  expect(t).toEqual(expect.arrayContaining(['16:20', '€17', 'https://ex.example/a?b=1', '`f76fa548`', 'me@ex.example', '389633']))
  expect(keepsFacts('leave at 16:20 for €17', 'go at 16:20, €17')).toBe(true)
  expect(keepsFacts('leave at 16:20 for €17', 'go at 4:20, €17')).toBe(false)
})

test('short text, code and lists are left alone', () => {
  expect(skipRewrite('live')).toBe(true)
  expect(skipRewrite('x'.repeat(200) + '\n```js\nx\n```')).toBe(true)
  expect(skipRewrite('x'.repeat(150) + '\n- one\n- two')).toBe(true)
  expect(skipRewrite('x'.repeat(200))).toBe(false)
})

test('the rewrite is used only when it keeps every fact and is no longer', async () => {
  const reply = 'I moved your leave reminder from 17:10 to 16:20 today, so it fires then and tells you you are meeting Sam at 5. The buttons stay the same as before.'
  expect(await voicePass(async () => 'TEXT: moved it to 16:20, meeting sam at 5', [], reply)).toBeNull()   // dropped 17:10
  expect(await voicePass(async () => 'TEXT: moved it from 17:10 to 16:20\n\nmeeting sam at 5', [], reply)).toBe('moved it from 17:10 to 16:20\n\nmeeting sam at 5')
  expect(await voicePass(async () => 'sure', [], reply)).toBeNull()
  expect(await voicePass(async () => { throw new Error('down') }, [], reply)).toBeNull()
})

test('a persona file replaces the built-in voice, the rules stay', () => {
  const { writeFileSync, mkdtempSync } = require('fs'); const { join } = require('path'); const { tmpdir } = require('os')
  const f = join(mkdtempSync(join(tmpdir(), 'front-')), 'voice.md')
  expect(frontSystem(f)).toContain('You are Otto, texting the user')
  writeFileSync(f, 'Talk like a pirate.')
  const s = frontSystem(f)
  expect(s.startsWith('Talk like a pirate.')).toBe(true)
  expect(s).not.toContain('You are Otto, texting the user')
  expect(s).toContain('Never claim you did, sent, saved or changed anything')
})
