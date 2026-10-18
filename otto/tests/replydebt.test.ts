import { test, expect } from 'bun:test'
import {
  findReplyDebt, isAsk, isBulkSender, ownText, summarizeThread, threadIds,
  type ThreadSummary, type ThreadMessage,
} from '../replydebt.ts'
import { formatBrief, sectionLabels, type BriefParts } from '../brief.ts'

const NOW = Date.parse('2026-08-20T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString()

const ME = 'you@example.com'
const MARCO = 'Marco Rossi <marco@example.com>'

function msg(from: string, days: number, snippet: string, over: Partial<ThreadMessage> = {}): ThreadMessage {
  return { from, date: daysAgo(days), snippet, fromUser: from === ME, ...over }
}

function thread(id: string, messages: ThreadMessage[]): ThreadSummary {
  return { id, participants: [...new Set(messages.map(m => m.from))], messages }
}

const debts = (threads: ThreadSummary[], minDays?: number) =>
  findReplyDebt(threads, { now: NOW, ...(minDays !== undefined ? { minDays } : {}) })

test('a person asking a question, unanswered for days, is a debt', () => {
  const out = debts([thread('t1', [msg(MARCO, 5, 'Hi, did the contract arrive?')])])
  expect(out).toEqual([{
    threadId: 't1', from: MARCO, askedAt: daysAgo(5), daysWaiting: 5, snippet: 'Hi, did the contract arrive?',
  }])
})

test('a message that asks nothing is not a debt', () => {
  expect(debts([thread('t1', [msg(MARCO, 5, 'Thanks, all good. Talk soon.')])])).toEqual([])
})

test('the user replying last clears it', () => {
  expect(debts([thread('t1', [
    msg(MARCO, 6, 'Can you send me the invoice?'),
    msg(ME, 4, 'Sent, it is attached.', { fromUser: true }),
  ])])).toEqual([])
})

test('the SENT flag counts as the user even under another alias', () => {
  expect(debts([thread('t1', [
    msg(MARCO, 6, 'Can you send me the invoice?'),
    msg('Alias <alias@example.com>', 4, 'Done', { fromUser: true }),
  ])])).toEqual([])
})

test('too recent is not yet a debt, and minDays moves the line', () => {
  const t = [thread('t1', [msg(MARCO, 2, 'Are we still on for Friday?')])]
  expect(debts(t)).toEqual([])
  expect(debts(t, 1)).toHaveLength(1)
})

test('bulk senders are not people', () => {
  const t = [
    thread('a', [msg('Shop <no-reply@shop.example>', 5, 'Can you rate your order?')]),
    thread('b', [msg('Weekly <newsletter@news.example>', 5, 'What do you think of our new look?')]),
    thread('c', [msg('GitHub <notifications@github.example>', 5, 'Could you review this?')]),
    thread('d', [msg('Info <info@company.example>', 5, 'Any questions?')]),
    thread('e', [msg(MARCO, 5, 'Can you join?', { listUnsubscribe: true })]),
    thread('f', [msg(MARCO, 5, 'Can you join?', { automated: true })]),
  ]
  expect(debts(t)).toEqual([])
})

test('an Italian request with no question mark is an ask', () => {
  const out = debts([thread('it', [msg('Giulia <giulia@example.com>', 4, 'Ciao! Fammi sapere quando sei libera per la cena.')])])
  expect(out).toHaveLength(1)
  expect(isAsk('Potresti mandarmi il file entro venerdì')).toBe(true)
  expect(isAsk('puoi passare domani')).toBe(true)
})

test('a Portuguese request with no question mark is an ask', () => {
  const out = debts([thread('pt', [msg('Ana <ana@example.com>', 7, 'Oi! Me avisa quando chegar em casa.')])])
  expect(out).toHaveLength(1)
  expect(isAsk('Você pode revisar o documento hoje')).toBe(true)
})

test('request phrases do not match inside other words', () => {
  expect(isAsk('Ci vediamo dopo, consegna fatta')).toBe(false)
  expect(isAsk('Remember to scan your receipts')).toBe(false)
})

test('the wait runs from the first ask, so a nudge does not reset it', () => {
  const out = debts([thread('t1', [
    msg(ME, 10, 'Here is the draft.', { fromUser: true }),
    msg(MARCO, 6, 'Can you check section 3?'),
    msg(MARCO, 1, 'Just bumping this.'),
  ])])
  expect(out).toHaveLength(1)
  expect(out[0].daysWaiting).toBe(6)
  expect(out[0].snippet).toBe('Can you check section 3?')
})

test('a question that only appears in the quoted reply does not count', () => {
  expect(isAsk('Sounds good. On Mon, 10 Aug 2026 at 10:00, Someone <you@example.com> wrote: can you come?')).toBe(false)
  expect(isAsk('Ok! Em seg., 10 de ago. de 2026, Alguém escreveu: você pode vir?')).toBe(false)
})

test('a question mark inside a link is not a question', () => {
  expect(isAsk('Here are the photos https://photos.example/a?id=3')).toBe(false)
})

test('snippet entities are decoded', () => {
  expect(ownText('Don&#39;t forget &amp; can you call?')).toBe("Don't forget & can you call?")
})

test('sorted by days waiting, longest first', () => {
  const out = debts([
    thread('short', [msg('Bea <bea@example.com>', 3, 'Lunch?')]),
    thread('long', [msg('Carl <carl@example.com>', 12, 'Can you sign?')]),
    thread('mid', [msg('Dina <dina@example.com>', 6, 'Any update?')]),
  ])
  expect(out.map(d => d.threadId)).toEqual(['long', 'mid', 'short'])
})

test('isBulkSender leaves ordinary people alone', () => {
  expect(isBulkSender(MARCO)).toBe(false)
  expect(isBulkSender('Informatica Bianchi <luca@example.com>')).toBe(false)
  expect(isBulkSender('noreply@example.com')).toBe(true)
})

// ---------------------------------------------------------------------------
// gog JSON
// ---------------------------------------------------------------------------

test('summarizeThread reads the Gmail API shape', () => {
  const raw = {
    thread: {
      id: 'abc',
      messages: [
        {
          labelIds: ['INBOX'], snippet: 'Can you call me?', internalDate: String(Date.parse(daysAgo(5))),
          payload: { headers: [{ name: 'From', value: MARCO }] },
        },
        {
          labelIds: ['INBOX'], snippet: 'Your weekly digest', internalDate: String(Date.parse(daysAgo(4))),
          payload: { headers: [{ name: 'From', value: 'Digest <digest@example.com>' }, { name: 'List-Unsubscribe', value: '<mailto:x>' }] },
        },
        {
          labelIds: ['SENT'], snippet: 'Sure', internalDate: String(Date.parse(daysAgo(3))),
          payload: { headers: [{ name: 'From', value: `Me <${ME}>` }] },
        },
      ],
    },
  }
  const t = summarizeThread(raw, ME)!
  expect(t.id).toBe('abc')
  expect(t.messages.map(m => m.fromUser)).toEqual([false, false, true])
  expect(t.messages[1].listUnsubscribe).toBe(true)
  expect(t.participants).toEqual([MARCO, 'Digest <digest@example.com>'])
})

test('summarizeThread recognises the user by address and flags automated mail', () => {
  const t = summarizeThread({
    messages: [
      { from: `Me <${ME.toUpperCase()}>`, date: daysAgo(3), snippet: 'hi' },
      { snippet: 'auto', date: daysAgo(2), headers: { From: 'Bot <bot@example.com>', 'Auto-Submitted': 'auto-replied' } },
    ],
  }, ME, 'fallback')!
  expect(t.id).toBe('fallback')
  expect(t.messages[0].fromUser).toBe(true)
  expect(t.messages[1].automated).toBe(true)
})

test('an unreadable thread is skipped, not guessed', () => {
  expect(summarizeThread(null, ME)).toBeNull()
  expect(summarizeThread({ thread: { messages: [] } }, ME)).toBeNull()
})

test('threadIds reads the search result', () => {
  expect(threadIds({ threads: [{ id: 'a' }, { id: '' }, {}, { id: 'b' }] })).toEqual(['a', 'b'])
  expect(threadIds({})).toEqual([])
})

// ---------------------------------------------------------------------------
// The brief section
// ---------------------------------------------------------------------------

function parts(over: Partial<BriefParts> = {}): BriefParts {
  return {
    now: new Date(NOW), tz: 'UTC',
    events: [], mail: [], loops: [], facts: [], triggers: [], history: [],
    ...over,
  }
}

test('the brief lists at most three people with days waiting', () => {
  const list = debts([
    thread('t1', [msg(MARCO, 9, 'Can you sign?')]),
    thread('t2', [msg('Giulia <giulia@example.com>', 6, 'Fammi sapere')]),
    thread('t3', [msg('Ana <ana@example.com>', 5, 'Me avisa')]),
    thread('t4', [msg('Bea <bea@example.com>', 4, 'Lunch?')]),
  ])
  const text = formatBrief(parts({ debts: list }))
  expect(text).toContain('Waiting on you (as of 12:00): Marco Rossi 9d — Can you sign? [thread t1]')
  expect(text).toContain('Ana 5d')
  expect(text).not.toContain('Bea')
  expect(text).toContain('(+1 more)')
  expect(sectionLabels(text)).toContain('Waiting on you')
})

test('nobody waiting is said, a failed source is omitted', () => {
  expect(formatBrief(parts({ debts: [] }))).toContain('Waiting on you (as of 12:00): nobody.')
  expect(formatBrief(parts({ debts: null }))).not.toContain('Waiting on you')
  expect(formatBrief(parts())).not.toContain('Waiting on you')
})

test('an out-of-range numeric entity decodes to U+FFFD instead of throwing', () => {
  expect(ownText('Can you call &#99999999; tomorrow?')).toBe('Can you call � tomorrow?')
  expect(ownText('ok &#x110000; &#x1F600;')).toBe('ok � 😀')
  expect(isAsk('&#99999999; can you check?')).toBe(true)
})
