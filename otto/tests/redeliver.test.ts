import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  recordInbound, markAnswered, takeRedeliveries, pruneJournal, loadJournal, saveJournal,
  KEEP_MS, type JournalEntry,
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
  const j = recordInbound([], { chat_id: CHAT, message_id: '1', text: 'x'.repeat(5000), meta: {} }, NOW)
  expect(j[0].text.length).toBe(1501)
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
