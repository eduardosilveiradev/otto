import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  burnHistory, burnJournal, burnQueue, burnedMatcher, recordBurned, loadBurned, saveBurned,
  lastInbound, isBurnRequest, sha256, rolling, BURNED_TEXT, MIN_CONTAIN,
} from '../burn.ts'
import { recordInbound, takeRedeliveries, type JournalEntry } from '../redeliver.ts'
import type { QueuedMessage } from '../queue.ts'
import { ChatFeed } from '../chatfeed.ts'
import { digestTranscript } from '../consolidate.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-burn-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const CHAT = '1234567890'
const SECRET = 'hunter2-correct-horse-battery' // gitleaks:allow — a made-up test secret
const NOW = Date.parse('2026-08-11T20:00:00Z')

function line(o: Record<string, unknown>): string { return JSON.stringify(o) }

const HISTORY = [
  line({ ts: '2026-08-11T19:00:00.000Z', dir: 'in', chat_id: CHAT, message_id: '41', kind: 'text', from: 'you', text: 'what is the wifi password field called' }),
  line({ ts: '2026-08-11T19:01:00.000Z', dir: 'out', chat_id: CHAT, message_id: '42', kind: 'text', src: 'chat', text: 'paste it and I will set it up' }),
  line({ ts: '2026-08-11T19:02:00.000Z', dir: 'in', chat_id: CHAT, message_id: '43', kind: 'text', from: 'you', text: SECRET }),
  'not json at all',
  line({ ts: '2026-08-11T19:03:00.000Z', dir: 'in', chat_id: 'app', message_id: '43', kind: 'text', text: 'same id, other chat' }),
  line({ ts: '2026-08-11T19:04:00.000Z', dir: 'in', chat_id: CHAT, message_id: '44', kind: 'text', from: 'you', text: 'burn that' }),
  '',
].join('\n')

// --- history.jsonl --------------------------------------------------------

test('history: the text is burned, the line keeps its place, id, ts and every other field', () => {
  const r = burnHistory(HISTORY, { message_id: '43', chat_id: CHAT })
  expect(r.count).toBe(1)
  expect(r.texts).toEqual([SECRET])
  expect(r.ts).toBe('2026-08-11T19:02:00.000Z')
  const before = HISTORY.split('\n')
  const after = r.raw.split('\n')
  expect(after.length).toBe(before.length)
  expect(r.raw).not.toContain(SECRET)
  const burned = JSON.parse(after[2])
  expect(burned).toEqual({ ...JSON.parse(before[2]), text: BURNED_TEXT })
  // Untouched lines are byte-identical, the unparseable one included.
  for (const i of [0, 1, 3, 4, 5, 6]) expect(after[i]).toBe(before[i])
  expect(r.raw.endsWith('\n')).toBe(true)
})

test('history: without chat_id an id matches in every chat, and the chat is inferred', () => {
  const r = burnHistory(HISTORY, { message_id: '43' })
  expect(r.count).toBe(2)
  expect(r.chat_id).toBe(CHAT)
})

test('history: an outgoing message is burned only when named by its id, edits included', () => {
  const withEdit = HISTORY + line({ ts: '2026-08-11T19:05:00.000Z', dir: 'out', chat_id: CHAT, message_id: '42', kind: 'edit', text: 'edited' }) + '\n'
  expect(burnHistory(withEdit, { message_id: '43', chat_id: CHAT }).raw).toContain('paste it and I will set it up')
  const r = burnHistory(withEdit, { message_id: '42', chat_id: CHAT })
  expect(r.count).toBe(2)
  expect(r.raw).not.toContain('paste it')
})

test('history: an unknown id changes nothing', () => {
  const r = burnHistory(HISTORY, { message_id: '999', chat_id: CHAT })
  expect(r.count).toBe(0)
  expect(r.raw).toBe(HISTORY)
})

// --- the chat feed ----------------------------------------------------------

test('chat feed: the ring entry is burned in place, seq unchanged, other chats untouched', () => {
  const feed = new ChatFeed()
  feed.push({ ts: 'a', dir: 'in', chat_id: CHAT, message_id: '43', kind: 'text', text: SECRET })
  feed.push({ ts: 'b', dir: 'in', chat_id: 'app', message_id: '43', kind: 'text', text: 'keep' })
  expect(feed.burn('43', CHAT, BURNED_TEXT)).toBe(1)
  expect(feed.seq).toBe(2)
  expect(feed.since(0, CHAT).map(e => e.text)).toEqual([BURNED_TEXT])
  expect(feed.since(0, 'app').map(e => e.text)).toEqual(['keep'])
  // A poll that already had seq 1 does not get it again.
  expect(feed.since(1, CHAT)).toEqual([])
})

// --- inbound-journal.json (redelivery state) --------------------------------

function journal(): JournalEntry[] {
  let j = recordInbound([], { chat_id: CHAT, message_id: '43', text: SECRET, meta: { chat_id: CHAT, message_id: '43' } }, NOW - 60_000)
  j = recordInbound(j, {
    chat_id: CHAT, message_id: '45', text: 'is that the right one?',
    meta: { chat_id: CHAT, message_id: '45', reply_to_id: '43', reply_to_text: SECRET },
  }, NOW - 30_000)
  return j
}

test('journal: the entry and the quote of it in a reply are burned; ids, ts and flags stay', () => {
  const before = journal()
  const r = burnJournal(before, { message_id: '43', chat_id: CHAT })
  expect(r.count).toBe(2)
  expect(r.texts).toEqual([SECRET])
  expect(JSON.stringify(r.entries)).not.toContain(SECRET)
  expect(r.entries.map(e => [e.message_id, e.ts])).toEqual(before.map(e => [e.message_id, e.ts]))
  expect(r.entries[1].text).toBe('is that the right one?')
  expect(r.entries[1].meta.reply_to_id).toBe('43')
})

test('journal: a burned entry still redelivers, as "[burned]"', () => {
  const r = burnJournal(journal(), { message_id: '43', chat_id: CHAT })
  const picked = takeRedeliveries(r.entries, { now: NOW, windowMs: 6 * 3_600_000, bootAt: NOW })
  expect(picked[0].message_id).toBe('43')
  expect(picked[0].text).toBe(BURNED_TEXT)
})

test('journal: a capped text is handed back without its ellipsis, so it is a substring of the original', () => {
  const long = 'k'.repeat(4000)
  const j = recordInbound([], { chat_id: CHAT, message_id: '9', text: long, meta: {} }, NOW)
  const r = burnJournal(j, { message_id: '9' })
  expect(r.texts[0].length).toBe(1500)
  expect(long.includes(r.texts[0])).toBe(true)
})

// --- queue.json ---------------------------------------------------------------

const QUEUE: QueuedMessage[] = [
  { id: 'a1b2c3', chat_id: CHAT, text: `your code is ${SECRET}`, queuedAt: '2026-08-11T19:00:00Z', reason: 'quiet' },
  { id: 'd4e5f6', chat_id: CHAT, text: 'digest', queuedAt: '2026-08-11T19:00:00Z', reason: 'quiet' },
]

test('queue: a held message is burned by its id and stays queued', () => {
  const r = burnQueue(QUEUE, { message_id: 'a1b2c3' })
  expect(r.count).toBe(1)
  expect(r.queue.map(m => m.id)).toEqual(['a1b2c3', 'd4e5f6'])
  expect(r.queue[0].text).toBe(BURNED_TEXT)
  expect(r.queue[1].text).toBe('digest')
})

test('queue: a Telegram id never matches a held message', () => {
  expect(burnQueue(QUEUE, { message_id: '43', chat_id: CHAT }).count).toBe(0)
})

// --- burned.json ----------------------------------------------------------------

test('burned.json: hashes only, deduped, "[burned]" never recorded, round-trips', () => {
  let rs = recordBurned([], [SECRET, ` ${SECRET}\n`, BURNED_TEXT, ''], { message_id: '43', chat_id: CHAT }, NOW)
  rs = recordBurned(rs, [SECRET], { message_id: '43', chat_id: CHAT }, NOW)
  expect(rs.length).toBe(1)
  expect(rs[0]).toEqual({ sha256: sha256(SECRET), len: SECRET.length, rk: rolling(SECRET), chat_id: CHAT, message_id: '43', at: new Date(NOW).toISOString() })
  const file = join(tmp, 'burned.json')
  saveBurned(file, rs)
  expect(readFileSync(file, 'utf8')).not.toContain(SECRET)
  expect(loadBurned(file)).toEqual(rs)
})

test('burned.json: missing is empty; corrupt is moved aside', () => {
  expect(loadBurned(join(tmp, 'nope.json'))).toEqual([])
  const dir = mkdtempSync(join(tmp, 'corrupt-'))
  const file = join(dir, 'burned.json')
  writeFileSync(file, '{not json')
  expect(loadBurned(file)).toEqual([])
  expect(readdirSync(dir).some(f => f.startsWith('burned.json.corrupt-'))).toBe(true)
})

// --- the matcher consolidation uses -------------------------------------------

test('matcher: finds the secret inside a longer entry, at any offset, and nothing else', () => {
  const is = burnedMatcher(recordBurned([], [SECRET], { message_id: '43' }, NOW))
  expect(is(SECRET)).toBe(true)
  expect(is(`<channel source="plugin:otto:otto" chat_id="${CHAT}">${SECRET}</channel>`)).toBe(true)
  expect(is(`${'x'.repeat(5000)}${SECRET}`)).toBe(true)
  expect(is(`${SECRET}${'y'.repeat(3)}`)).toBe(true)
  expect(is(SECRET.slice(1))).toBe(false)
  expect(is('nothing to see here, just a long message about horses and batteries')).toBe(false)
  expect(burnedMatcher([])('anything')).toBe(false)
})

test('matcher: a short secret matches only a whole entry', () => {
  expect('4821'.length).toBeLessThan(MIN_CONTAIN)
  const is = burnedMatcher(recordBurned([], ['4821'], { message_id: '1' }, NOW))
  expect(is(' 4821 ')).toBe(true)
  expect(is('call me on 555 4821 later')).toBe(false)
})

test('matcher: non-ASCII text is matched the same way', () => {
  const s = 'senha: pão-de-açúcar 🔑 42'
  const is = burnedMatcher(recordBurned([], [s], { message_id: '1' }, NOW))
  expect(is(`ok, ${s} — thanks`)).toBe(true)
})

// --- consolidate.ts -------------------------------------------------------------

test('consolidation: a transcript entry containing a burned text never reaches the digest', () => {
  const path = join(tmp, 'session.jsonl')
  writeFileSync(path, [
    { type: 'user', timestamp: '2026-08-11T19:02:00Z', message: { role: 'user', content: `<channel source="plugin:otto:otto" chat_id="${CHAT}" message_id="43">${SECRET}</channel>` } },
    { type: 'assistant', timestamp: '2026-08-11T19:02:10Z', message: { role: 'assistant', content: [{ type: 'text', text: `Got it: ${SECRET}` }] } },
    { type: 'user', timestamp: '2026-08-11T19:03:00Z', message: { role: 'user', content: 'set up the router tomorrow' } },
    { type: 'assistant', timestamp: '2026-08-11T19:03:10Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted for tomorrow.' }] } },
  ].map(r => JSON.stringify(r)).join('\n'))
  const is = burnedMatcher(recordBurned([], [SECRET], { message_id: '43' }, NOW))
  const d = digestTranscript(path, 'proj', is)!
  expect(d.turns.map(t => t.text)).toEqual(['set up the router tomorrow', 'Noted for tomorrow.'])
  expect(JSON.stringify(d)).not.toContain(SECRET)
  // Without the matcher it would have been there.
  expect(JSON.stringify(digestTranscript(path, 'proj'))).toContain(SECRET)
})

test('consolidation: a secret past the per-turn cut is still caught', () => {
  const path = join(tmp, 'late.jsonl')
  const text = `${'context '.repeat(200)}${SECRET}`
  writeFileSync(path, [
    { type: 'user', message: { role: 'user', content: text } },
    { type: 'user', message: { role: 'user', content: 'one' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } },
  ].map(r => JSON.stringify(r)).join('\n'))
  const d = digestTranscript(path, 'proj', burnedMatcher(recordBurned([], [SECRET], { message_id: '1' }, NOW)))!
  expect(d.turns.map(t => t.text)).toEqual(['one', 'two'])
})

// --- last: true -----------------------------------------------------------------

test('last: the newest inbound message, passing over the "burn that" asking for it', () => {
  expect(lastInbound([HISTORY], CHAT)).toEqual({ message_id: '43', chat_id: CHAT })
})

test('last: from the terminal, with no request in the chat, the newest inbound is the one', () => {
  const noRequest = HISTORY.split('\n').filter(l => !l.includes('burn that')).join('\n')
  expect(lastInbound([noRequest], CHAT)).toEqual({ message_id: '43', chat_id: CHAT })
})

test('last: reads across both history files, skips reactions and outgoing, honours chat_id', () => {
  const prev = line({ ts: '2026-08-10T10:00:00.000Z', dir: 'in', chat_id: CHAT, message_id: '1', kind: 'text', text: 'old' })
  const cur = [
    line({ ts: '2026-08-11T10:00:00.000Z', dir: 'in', chat_id: 'app', message_id: 'm-9', kind: 'text', text: 'app secret value' }),
    line({ ts: '2026-08-11T11:00:00.000Z', dir: 'in', chat_id: CHAT, message_id: '2', kind: 'reaction', text: '👍' }),
    line({ ts: '2026-08-11T12:00:00.000Z', dir: 'out', chat_id: CHAT, message_id: '3', kind: 'text', text: 'mine' }),
  ].join('\n')
  expect(lastInbound([prev, cur], CHAT)).toEqual({ message_id: '1', chat_id: CHAT })
  expect(lastInbound([prev, cur])).toEqual({ message_id: 'm-9', chat_id: 'app' })
  expect(lastInbound([''], CHAT)).toBeUndefined()
})

test('burn requests are recognised; a secret that merely starts with the word is not one', () => {
  for (const t of ['burn that', 'delete that pls', 'Burn it', "I shouldn't have sent that", 'remove that message']) {
    expect(isBurnRequest(t)).toBe(true)
  }
  for (const t of [SECRET, 'delete123!Pass', 'deleted my account yesterday and now I need to set the whole thing up again from scratch']) {
    expect(isBurnRequest(t)).toBe(false)
  }
})
