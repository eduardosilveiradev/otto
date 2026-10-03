import { test, expect } from 'bun:test'
import { numToWords, spellNumbers, speakable } from '../speech-text.ts'

test('numbers read the way a person would say them', () => {
  expect(numToWords(0)).toBe('zero')
  expect(numToWords(19)).toBe('nineteen')
  expect(numToWords(40)).toBe('forty')
  expect(numToWords(42)).toBe('forty-two')
  expect(numToWords(700)).toBe('seven hundred')
  expect(numToWords(2026)).toBe('twenty twenty-six')
  expect(numToWords(2000)).toBe('two thousand')
  expect(numToWords(1500)).toBe('one thousand five hundred')
})

test('times are spelled, not left as digits', () => {
  expect(spellNumbers('lands 6:40am')).toBe('lands six forty in the morning')
  expect(spellNumbers('at 18:05')).toBe('at eighteen oh five')
  expect(spellNumbers('at 9:00')).toBe("at nine o'clock")
  expect(spellNumbers('dinner at 8pm')).toBe("dinner at eight o'clock in the evening")
})

test('ordinals, percents and thousands separators', () => {
  expect(spellNumbers('the 1st')).toBe('the first')
  expect(spellNumbers('the 21st')).toBe('the twenty-first')
  expect(spellNumbers('the 20th')).toBe('the twentieth')
  expect(spellNumbers('30% off')).toBe('thirty percent off')
  expect(spellNumbers('1,500 euros')).toBe('one thousand five hundred euros')
})

test('markdown and links are stripped, meaning is kept', () => {
  expect(speakable('**flight** lands at _dawn_', 900)).toBe('flight lands at dawn')
  expect(speakable('see https://example.com/x?y=1 for it', 900)).toBe('see link for it')
  expect(speakable('[the invoice](https://x.com) is due', 900)).toBe('the invoice is due')
  expect(speakable('mail jony@example.com back', 900)).toBe('mail that address back')
  expect(speakable('- eggs\n- milk', 900)).toBe('eggs\nmilk')
})

test('code blocks go away entirely', () => {
  expect(speakable('run this:\n```\nrm -rf /\n```\nthen tell me', 900)).toBe('run this:\nthen tell me')
})

test('nothing to say returns empty, so the caller falls back to text', () => {
  expect(speakable('👍', 900)).toBe('')
  expect(speakable('...', 900)).toBe('')
  expect(speakable('', 900)).toBe('')
})

test('long text is cut at a sentence, not mid-word', () => {
  const long = 'First sentence here. Second sentence here. ' + 'x'.repeat(200)
  const out = speakable(long, 60)
  expect(out).toBe('First sentence here. Second sentence here.')
})

test('a transcript-shaped reply survives intact', () => {
  expect(speakable('Flight lands 6:40am Berlin time — dentist moved to Thursday.', 900))
    .toBe('Flight lands six forty in the morning Berlin time — dentist moved to Thursday.')
})
