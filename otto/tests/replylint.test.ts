import { test, expect } from 'bun:test'
import { lintReply, VOICE_MAX } from '../replylint'

const reason = (t: string, opts = {}) => {
  const r = lintReply(t, opts)
  return r.ok ? '' : r.reason
}
const passes = (t: string, opts = {}) => expect(lintReply(t, opts)).toEqual({ ok: true })

// --- passing ---------------------------------------------------------------

test('a clean terse reply passes, written or spoken', () => {
  passes('Enel bill €84.30, due Friday.')
  passes('Enel bill is 84 euros, due Friday.', { voice: true })
})

test('an empty reply (files only) passes', () => {
  passes('')
  passes('   ', { voice: true })
})

test('links, code and lists are fine in a written reply', () => {
  passes('Pay it here: https://example.com/pay', { voice: false })
  passes('Run `bun test` when you get in.')
  passes('Three things:\n- one\n- two\n- three')
})

test('words that merely contain a machinery word pass', () => {
  passes('I can rescan the receipt if the photo was blurry.')
  passes('The webhooksmith conference is in March.')
  passes('Your flight has a long layover in Lisbon.')
})

test('"Session" as a title or in a music context passes', () => {
  passes('Now playing Session by Linkin Park.')
  passes('The jam session moved to Thursday, 20:00 BRT.')
  passes('He was a session musician on that album.')
})

test('"trigger warning" in a quote, and trigger as an ordinary verb, pass', () => {
  passes('The syllabus opens with "trigger warning: violence".')
  passes('That will trigger a rebuild of the site.')
  passes('Coffee triggers your migraines, by your own account.')
  passes('A trigger warning on the second chapter, apparently.')
})

test('the user’s own scans and sessions pass', () => {
  passes('Your CT scan is booked for Tuesday at 14:00 BRT.')
  passes('Scan the QR code at the gate.')
  passes('Your therapy session is at 17:00 BRT.')
})

test('a short hex string or a year next to loop is not an id', () => {
  passes('Closed the loop on the 2026 tax return.')
  passes('Close the loop with the landlord today.')
})

// --- failing: voice --------------------------------------------------------

test('voice reply with a link is blocked with the fix', () => {
  expect(reason('Pay it at https://example.com/pay', { voice: true })).toContain('voice reply has a link — send links as text (voice:false)')
  expect(reason('It is on www.example.com', { voice: true })).toContain('has a link')
})

test('voice reply with code fences or inline code is blocked', () => {
  expect(reason('Run `bun test` later.', { voice: true })).toContain('voice reply has code')
  expect(reason('```\nls\n```', { voice: true })).toContain('voice reply has code')
})

test('voice reply with a markdown table or bullet list is blocked', () => {
  expect(reason('| item | € |\n| --- | --- |\n| rent | 900 |', { voice: true })).toContain('voice reply has a table')
  expect(reason('Today:\n- dentist\n- gym', { voice: true })).toContain('voice reply has a bullet list')
  expect(reason('Today:\n1. dentist\n2. gym', { voice: true })).toContain('bullet list')
})

test('voice reply over the length limit is blocked; at the limit it passes', () => {
  passes('a'.repeat(VOICE_MAX), { voice: true })
  expect(reason('a'.repeat(VOICE_MAX + 1), { voice: true })).toContain(`max ${VOICE_MAX}`)
  // ...and the same text written passes.
  passes('a'.repeat(VOICE_MAX + 1), { voice: false })
})

test('every failing voice rule is named at once', () => {
  const r = reason('See https://example.com\n- one\n- two ' + 'x'.repeat(400), { voice: true })
  expect(r).toContain('link')
  expect(r).toContain('bullet list')
  expect(r).toContain('chars')
})

// --- failing: machinery ----------------------------------------------------

test('bare machinery words are blocked, case-insensitive', () => {
  expect(reason('Your trigger is armed for 9am.')).toContain('"trigger"')
  expect(reason('Found it in the hourly scan.')).toContain('"scan"')
  expect(reason('A WEBHOOK from the bank came in.')).toContain('"WEBHOOK"')
  expect(reason('I handed that to a subagent.')).toContain('"subagent"')
  expect(reason('The voice daemon is down, so text for now.')).toContain('"voice daemon"')
  expect(reason('Transcription garbled your last note.')).toContain('"Transcription"')
  expect(reason('Lost that when the session restarted.')).toContain('"session"')
})

test('machinery words are blocked even when they look like a verb after an article', () => {
  expect(reason('The trigger the bank set up is gone.')).toContain('trigger')
  expect(reason('Session restarted, picking up where we were.')).toContain('Session')
})

test('machinery refusals use the existing "never see the machinery" wording', () => {
  expect(reason('The scan picked it up.')).toContain('they should never see the machinery')
})

// --- failing: ids ----------------------------------------------------------

test('a hex id next to loop or trigger is blocked', () => {
  expect(reason('Closed loop 3f9e2a1b.')).toContain('raw id ("loop 3f9e2a1b")')
  expect(reason('Done — a1b2c3d4e5 loop closed.')).toContain('raw id')
  expect(reason('Armed trigger: 9c0ffee1.')).toContain('raw id')
})

test('a chat_id= style key is blocked', () => {
  expect(reason('Sent to chat_id=1234567890.')).toContain('raw id')
  expect(reason('message_id: 42 was edited')).toContain('raw id')
})

// --- inside a conversation -------------------------------------------------

test('in a conversation, machinery words and ids warn instead of blocking', () => {
  const r = lintReply('The webhook session restarted, trigger 9c0ffee1 is fine.', { conversational: true })
  expect(r.ok).toBe(true)
  expect(r.ok && r.warning).toContain("they should never see the machinery")
  expect(r.ok && r.warning).toContain('raw id')
  // Unprompted, the same text is still refused.
  expect(reason('The webhook session restarted, trigger 9c0ffee1 is fine.')).toContain("never see the machinery")
})

test('in a conversation, the voice rules still block', () => {
  expect(reason('See https://example.com', { voice: true, conversational: true })).toContain('voice reply has a link')
  expect(lintReply('All clear for tonight.', { conversational: true })).toEqual({ ok: true })
})
