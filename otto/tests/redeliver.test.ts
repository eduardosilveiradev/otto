import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readdirSync, mkdirSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  recordInbound, markAnswered, markRead, recoverRead, TranscriptReceipts, takeRedeliveries, pruneJournal, loadJournal, saveJournal,
  KEEP_MS, MAX_ATTEMPTS, unreadOwed, takeAbandoned, type JournalEntry,
} from '../redeliver.ts'

const NOW = Date.parse('2026-08-11T20:00:00Z')
const H = 3_600_000
const CHAT = '1234567890'

function add(j: JournalEntry[], id: string, at: number, chat = CHAT): JournalEntry[] {
  return recordInbound(j, { chat_id: chat, message_id: id, text: `msg ${id}`, meta: { chat_id: chat, message_id: id } }, at)
}

test('records once per chat and message id', () => {
  let j = add([], '1', NOW - H)
  j = add(j, '1', NOW - H)
  j = add(j, '1', NOW - H, '999')
  expect(j.length).toBe(2)
  expect(j[0].ts).toBe(new Date(NOW - H).toISOString())
})

test('long text is capped', () => {
  const j = recordInbound([], { chat_id: CHAT, message_id: '1', text: 'x'.repeat(70_000), meta: {} }, NOW)
  expect(j[0].text.length).toBe(64_001)
})

test('entries past 48h are pruned, on record and on demand', () => {
  let j = add([], 'old', NOW - KEEP_MS - 1)
  j = add(j, 'new', NOW)
  expect(j.map(e => e.message_id)).toEqual(['new'])
  expect(pruneJournal(add([], 'a', NOW - 47 * H), NOW).length).toBe(1)
})

test('a reply to the chat answers everything that arrived before it, and nothing elsewhere', () => {
  let j = add([], '1', NOW - 2 * H)
  j = add(j, '2', NOW - H)
  j = add(j, '3', NOW - H, '999')
  markAnswered(j, [CHAT], NOW - 90 * 60_000)
  expect(j.map(e => !!e.answered)).toEqual([true, false, false])
})

test('a reply threaded under a message answers it whatever the clock says', () => {
  const j = add([], '7', NOW + H)
  markAnswered(j, [CHAT], NOW, '7')
  expect(j[0].answered).toBe(true)
})

test('redelivers unanswered, pre-boot, in-window messages oldest first, once', () => {
  let j: JournalEntry[] = []
  j = add(j, 'stale', NOW - 7 * H)
  j = add(j, 'b', NOW - 2 * H)
  j = add(j, 'a', NOW - 3 * H)
  j = add(j, 'done', NOW - H)
  j = add(j, 'live', NOW - 1000)
  markAnswered(j.filter(e => e.message_id === 'done'), [CHAT], NOW)
  const opts = { now: NOW, windowMs: 6 * H, bootAt: NOW - 5000 }
  expect(takeRedeliveries(j, opts).map(e => e.message_id)).toEqual(['a', 'b'])
  expect(takeRedeliveries(j, opts)).toEqual([])
})

test('caps per start; the rest wait for the next one', () => {
  let j: JournalEntry[] = []
  for (let i = 0; i < 15; i++) j = add(j, String(i), NOW - H + i)
  const opts = { now: NOW, windowMs: 6 * H, bootAt: NOW }
  expect(takeRedeliveries(j, opts).length).toBe(10)
  expect(takeRedeliveries(j, opts).map(e => e.message_id)).toEqual(['10', '11', '12', '13', '14'])
})

test('round-trips through disk and moves a corrupt file aside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-journal-'))
  const f = join(dir, 'inbound-journal.json')
  expect(loadJournal(f)).toEqual([])
  const j = add([], '1', NOW)
  saveJournal(f, j)
  expect(loadJournal(f)).toEqual(j)
  writeFileSync(f, '{nope')
  expect(loadJournal(f)).toEqual([])
  expect(readdirSync(dir).some(n => n.includes('.corrupt-'))).toBe(true)
})

test('a reply does not answer a message Otto has not read yet (held behind a long turn)', () => {
  let j = add([], 'a', NOW - 2 * H, 'app')
  j = add(j, 'held', NOW - H, 'app')
  j = markAnswered(j, ['app'], NOW, undefined, new Set(['held']))
  expect(j.find(e => e.message_id === 'a')!.answered).toBe(true)
  expect(j.find(e => e.message_id === 'held')!.answered).toBeUndefined()
  expect(takeRedeliveries(j, { now: NOW, windowMs: 6 * H, bootAt: NOW + 1 }).map(e => e.message_id)).toEqual(['held'])
})

test('recording the same message again keeps its place but takes the fuller meta', () => {
  let j = recordInbound([], { chat_id: 'app', message_id: 'm', text: 'hi', meta: { chat_id: 'app' } }, NOW - H)
  j = recordInbound(j, { chat_id: 'app', message_id: 'm', text: 'hi', meta: { chat_id: 'app', mem: 'x' } }, NOW)
  expect(j.length).toBe(1)
  expect(j[0].ts).toBe(new Date(NOW - H).toISOString())
  expect(j[0].meta.mem).toBe('x')
})

test('an app message replayed but still unread is replayed again on the next start, up to three times', () => {
  let j = recordInbound([], { chat_id: 'app', message_id: 'u', text: 'held', meta: {}, read: false }, NOW - H)
  const boot = (n: number) => takeRedeliveries(j, { now: NOW + n, windowMs: 6 * H, bootAt: NOW + n }).map(e => e.message_id)
  expect(boot(1)).toEqual(['u'])
  expect(boot(2)).toEqual(['u'])
  expect(boot(3)).toEqual(['u'])
  expect(boot(4)).toEqual([])
  j = recordInbound([], { chat_id: 'app', message_id: 'r', text: 'seen', meta: {}, read: false }, NOW - H)
  expect(takeRedeliveries(j, { now: NOW, windowMs: 6 * H, bootAt: NOW + 1 }).length).toBe(1)
  j = markRead(j, ['r'])
  expect(takeRedeliveries(j, { now: NOW, windowMs: 6 * H, bootAt: NOW + 1 }).length).toBe(0)
})

test('a message with no read tracking (Telegram) is still replayed at most once', () => {
  const j = add([], 't', NOW - H)
  expect(takeRedeliveries(j, { now: NOW, windowMs: 6 * H, bootAt: NOW + 1 }).length).toBe(1)
  expect(takeRedeliveries(j, { now: NOW, windowMs: 6 * H, bootAt: NOW + 2 }).length).toBe(0)
})

test('after a restart, app messages still owed a reading count as unread; spent or answered ones do not', () => {
  let j = recordInbound([], { chat_id: 'app', message_id: 'owed', text: 'a', meta: {}, read: false }, NOW - H)
  j = recordInbound(j, { chat_id: 'app', message_id: 'read', text: 'b', meta: {}, read: false }, NOW - H)
  j = recordInbound(j, { chat_id: 'app', message_id: 'old', text: 'c', meta: {}, read: false }, NOW - 7 * H)
  j = markRead(j, ['read'])
  j = recordInbound(j, { chat_id: 'app', message_id: 'spent', text: 'd', meta: {}, read: false }, NOW - H)
  j.find(e => e.message_id === 'spent')!.attempts = MAX_ATTEMPTS
  expect(unreadOwed(j, { now: NOW })).toEqual(['owed', 'old'])
})

test('a later batch in the same process takes only what the first left behind', () => {
  let j: JournalEntry[] = []
  for (let i = 0; i < 12; i++) j = recordInbound(j, { chat_id: 'app', message_id: `m${i}`, text: 'x', meta: {}, read: false }, NOW - H + i)
  const boot = NOW
  expect(takeRedeliveries(j, { now: NOW, windowMs: 6 * H, bootAt: boot }).length).toBe(10)
  expect(takeRedeliveries(j, { now: NOW + 1000, windowMs: 6 * H, bootAt: boot }).map(e => e.message_id)).toEqual(['m10', 'm11'])
  expect(takeRedeliveries(j, { now: NOW + 2000, windowMs: 6 * H, bootAt: boot }).length).toBe(0)
  expect(takeRedeliveries(j, { now: NOW + H, windowMs: 6 * H, bootAt: NOW + H - 1 }).length).toBe(10)   // the next start
})

test('an unread app message is replayed past the redelivery window, up to the journal’s 48h', () => {
  const j = recordInbound([], { chat_id: 'app', message_id: 'night', text: 'sent before an overnight outage', meta: {}, read: false }, NOW - 10 * H)
  expect(takeRedeliveries(j, { now: NOW, windowMs: 6 * H, bootAt: NOW }).map(e => e.message_id)).toEqual(['night'])
  const t = add([], 'tg', NOW - 10 * H)   // no read tracking: the window still applies
  expect(takeRedeliveries(t, { now: NOW, windowMs: 6 * H, bootAt: NOW }).length).toBe(0)
})

test('an unread message that ran out of replays, or is about to age out, is given up on once, by name', () => {
  let j = recordInbound([], { chat_id: 'app', message_id: 'spent', text: 'a', meta: {}, read: false }, NOW - H)
  j[0].attempts = MAX_ATTEMPTS
  j = recordInbound(j, { chat_id: 'app', message_id: 'old', text: 'b', meta: {}, read: false }, NOW - KEEP_MS + H / 2)
  j = recordInbound(j, { chat_id: 'app', message_id: 'fine', text: 'c', meta: {}, read: false }, NOW - H)
  expect(takeAbandoned(j, NOW, { bootAt: NOW, windowMs: 6 * H }).map(e => e.message_id)).toEqual(['spent', 'old'])
  expect(takeAbandoned(j, NOW, { bootAt: NOW, windowMs: 6 * H })).toEqual([])   // once
})

test('an injected event keeps a short replay window: a tap or an approval never goes in hours late', () => {
  const tap = recordInbound([], { chat_id: 'app', message_id: 'tap', text: 'Pay it now', meta: { event: 'button' }, read: false }, NOW - 20 * 60_000)
  expect(takeRedeliveries(tap, { now: NOW, windowMs: 6 * H, bootAt: NOW }).length).toBe(0)
  const fresh = recordInbound([], { chat_id: 'app', message_id: 'tap2', text: 'send it', meta: { event: 'button' }, read: false }, NOW - 5 * 60_000)
  expect(takeRedeliveries(fresh, { now: NOW, windowMs: 6 * H, bootAt: NOW }).length).toBe(1)
  const reminder = recordInbound([], { chat_id: 'trigger', message_id: 'r', text: 'dentist', meta: { event: 'trigger' }, read: false }, NOW - 2 * H)
  expect(takeRedeliveries(reminder, { now: NOW, windowMs: 6 * H, bootAt: NOW }).length).toBe(1)
  const old = recordInbound([], { chat_id: 'trigger', message_id: 'r2', text: 'dentist', meta: { event: 'trigger' }, read: false }, NOW - 7 * H)
  expect(takeRedeliveries(old, { now: NOW, windowMs: 6 * H, bootAt: NOW }).length).toBe(0)
})

test('one named as given up is not replayed after all', () => {
  const j = recordInbound([], { chat_id: 'app', message_id: 'g', text: 'x', meta: {}, read: false }, NOW - KEEP_MS + H / 2)
  expect(takeAbandoned(j, NOW, { bootAt: NOW, windowMs: 6 * H }).length).toBe(1)
  expect(takeRedeliveries(j, { now: NOW, windowMs: 6 * H, bootAt: NOW }).length).toBe(0)
})

test('give-up skips what this process handed over and is still queued behind a turn, unless it is about to age out', () => {
  const boot = NOW - 2 * H
  let j = recordInbound([], { chat_id: 'app', message_id: 'queued', text: 'send it', meta: { event: 'button' }, read: false }, NOW - 30 * 60_000)
  j = recordInbound(j, { chat_id: 'app', message_id: 'before', text: 'send it', meta: { event: 'button' }, read: false }, boot - 30 * 60_000)
  expect(takeAbandoned(j, NOW, { bootAt: boot, windowMs: 6 * H }).map(e => e.message_id)).toEqual(['before'])
  const r = recordInbound([], { chat_id: 'trigger', message_id: 'rem', text: 'x', meta: { event: 'trigger' }, read: false }, boot - 7 * H)
  expect(takeAbandoned(r, NOW, { bootAt: boot, windowMs: 12 * H }).length).toBe(0)   // still inside its configured window
})

test('pruning keeps an unread message past 48 h until it has been given up on (and named)', () => {
  let j = recordInbound([], { chat_id: 'app', message_id: 'old-unread', text: 'never read', meta: {}, read: false }, NOW - KEEP_MS - H)
  j = recordInbound(j, { chat_id: 'app', message_id: 'old-read', text: 'read', meta: {}, read: true }, NOW - KEEP_MS - H)
  expect(pruneJournal(j, NOW).map(e => e.message_id)).toEqual(['old-unread'])
  j[0].abandoned = true
  expect(pruneJournal(j, NOW).length).toBe(0)
  const stale = recordInbound([], { chat_id: 'app', message_id: 'x', text: 'x', meta: {}, read: false }, NOW - 15 * 24 * H)
  expect(pruneJournal(stale, NOW).length).toBe(0)   // a hard limit, whatever happens
})

test('an entry handed to the session by this process is not replayed by its boot pass, whatever its arrival time', () => {
  const boot = NOW
  const j = recordInbound([], { chat_id: 'app', message_id: 'reopened', text: 'run me', meta: { event: 'button' }, read: false }, boot - 60_000)
  j[0].attemptedAt = new Date(boot + 100).toISOString()   // reopened and delivered live after boot
  expect(takeRedeliveries(j, { now: boot + 400, windowMs: 6 * H, bootAt: boot }).length).toBe(0)
})

const envelope = (id: string) => `<channel source="plugin:otto:otto" chat_id="app" message_id="${id}">hello</channel>`
const midTurn = (id: string) => JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: envelope(id), origin: { kind: 'channel', server: 'otto' } } }) + '\n'
const tracked = (id: string, event?: string) => recordInbound([], {
  chat_id: 'app', message_id: id, text: 'hello', meta: event ? { event } : {}, read: false,
}, NOW - H)
const restart = (j: JournalEntry[]) => takeRedeliveries(j, { now: NOW, windowMs: 6 * H, bootAt: NOW })

test('mid-turn delivery before a long tail survives restart without a hook receipt', () => {
  const projects = mkdtempSync(join(tmpdir(), 'otto-transcripts-'))
  const project = join(projects, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'session.jsonl'), midTurn('mid') + JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(600_000) } }) + '\n')
  const j = recoverRead(tracked('mid'), projects)
  expect(j[0].read).toBe(true)
  expect(restart(j)).toEqual([])
})

test('a read message never replays, even before its first replay or a reply', () => {
  expect(restart(markRead(tracked('read'), ['read']))).toEqual([])
})

test('a reaction explicitly handles its target even while it is marked unread', () => {
  const j = tracked('reacted')
  markAnswered(j, ['app'], NOW, 'reacted', new Set(['reacted']))
  expect(j[0].answered).toBe(true)
  expect(restart(j)).toEqual([])

})

test('a pr-merged event delivered mid-turn needs no reply to stop replaying', () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-receipts-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, midTurn('merge'))
  const j = markRead(tracked('merge', 'pr-merged'), [...new TranscriptReceipts().read(file)])
  expect(j[0].answered).toBe(true)
  expect(restart(j)).toEqual([])
})

test('a message only enqueued before a crash is still owed; quoted ids are not receipts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-lost-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, [
    { type: 'queue-operation', operation: 'enqueue', content: envelope('lost') },
    { type: 'assistant', message: { content: envelope('lost') } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: envelope('lost') }] } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  const j = markRead(tracked('lost'), [...new TranscriptReceipts().read(file)])
  expect(j[0].read).toBe(false)
  expect(restart(j).map(e => e.message_id)).toEqual(['lost'])
})

test('receipt scanning is incremental and waits for complete records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-incremental-'))
  const file = join(dir, 'session.jsonl')
  const scanner = new TranscriptReceipts()
  const line = midTurn('later')
  writeFileSync(file, line.slice(0, -1))
  expect([...scanner.read(file)]).toEqual([])
  appendFileSync(file, '\n')
  expect([...scanner.read(file)]).toEqual(['later'])
  appendFileSync(file, JSON.stringify({ type: 'user', message: { content: envelope('next') } }) + '\n')
  expect([...scanner.read(file)]).toEqual(['later', 'next'])
  writeFileSync(file, midTurn('replacement'))
  expect([...scanner.read(file)]).toEqual(['replacement'])
})
