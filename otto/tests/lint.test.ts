import { test, expect } from 'bun:test'
import { lintOutbound, blocking, warnings, formatFindings, medianLength } from '../lint'

const codes = (t: string, ctx = {}) => lintOutbound(t, ctx).map(f => f.code)

test('a clean terse message produces nothing', () => {
  expect(lintOutbound('Enel bill €84.30, due Friday.')).toEqual([])
})

test('filler openers and closers are blocked', () => {
  expect(codes('Done. Let me know if you want anything else!')).toContain('filler')
  expect(codes('Happy to help!')).toContain('filler')
  expect(codes('Certainly! Here is the summary.')).toContain('filler')
  expect(codes("You're absolutely right, I'll fix it.")).toContain('filler')
})

test('only one filler finding is reported even when several match', () => {
  const f = lintOutbound('Certainly! I hope this helps. Let me know if you need more.')
  expect(f.filter(x => x.code === 'filler')).toHaveLength(1)
})

test('self-referential machinery is blocked', () => {
  expect(codes('My trigger fired at 9 and found two bills.')).toContain('machinery')
  expect(codes('The email scan picked this up.')).toContain('machinery')
  expect(codes('I spun up an agent to look into it.')).toContain('machinery')
  expect(codes('In this session I lost the thread.')).toContain('machinery')
  expect(codes('I ran recall and found nothing.')).toContain('machinery')
})

test('ordinary English that happens to contain a machinery word is not blocked', () => {
  // "trigger a rebuild" and a medical scan must survive.
  const a = lintOutbound('That will trigger a rebuild of the site.')
  expect(blocking(a)).toEqual([])
  const b = lintOutbound('Your CT scan is booked for Tuesday at 14:00 ART.')
  expect(blocking(b)).toEqual([])
  // ...but it is still surfaced as a warning worth a glance.
  expect(b.map(f => f.code)).toContain('machinery-maybe')
})

test('voice sends warn about links, code, lists and length', () => {
  expect(codes('Have a look at https://enel.it/pay', { voice: true })).toContain('voice-url')
  expect(codes('Run `bun test` when you get in', { voice: true })).toContain('voice-code')
  expect(codes('Three things:\n- one\n- two\n- three', { voice: true })).toContain('voice-list')
  expect(codes('x'.repeat(900), { voice: true })).toContain('voice-long')
})

test('voice rules do not fire on text sends', () => {
  expect(codes('Have a look at https://enel.it/pay', { voice: false })).not.toContain('voice-url')
})

test('voice findings are warnings, never blocks', () => {
  const f = lintOutbound('See https://enel.it/pay\n- pay it\n- then file it', { voice: true })
  expect(blocking(f)).toEqual([])
  expect(warnings(f).length).toBeGreaterThan(0)
})

test('an unprompted message far above the user’s median is flagged', () => {
  const long = 'word '.repeat(200)
  expect(codes(long, { medianLength: 120 })).toContain('long')
  expect(codes('short one', { medianLength: 120 })).not.toContain('long')
})

test('conversation is exempt from the length rule', () => {
  const long = 'word '.repeat(200)
  expect(codes(long, { medianLength: 120, conversational: true })).not.toContain('long')
})

test('claiming mail was sent is flagged for the draft rule', () => {
  expect(codes('Sent the email to Marco.')).toContain('mail-claim')
  expect(codes("I've replied to the landlord thread.")).toContain('mail-claim')
  expect(codes('Drafted a reply to Marco — send it?')).not.toContain('mail-claim')
})

test('findings format as one readable line', () => {
  const f = lintOutbound('My trigger fired.')
  expect(formatFindings(f)).toContain('machinery')
  expect(formatFindings(f)).toContain('My trigger')
})

test('median length handles empty, odd and even sets', () => {
  expect(medianLength([])).toBe(0)
  expect(medianLength(['abc', 'a', 'abcde'])).toBe(3)
  expect(medianLength(['ab', 'abcd'])).toBe(3)
  expect(medianLength(['   ', 'abcd'])).toBe(4)
})
