import { test, expect } from 'bun:test'
import { proactivityReport, formatReport, type LedgerEntry } from '../ledger.ts'

const T0 = Date.parse('2026-08-01T09:00:00Z')
const at = (mins: number) => new Date(T0 + mins * 60_000).toISOString()

function out(mins: number, src?: string): LedgerEntry {
  return { ts: at(mins), dir: 'out', chat_id: '1', text: 'ping', ...(src ? { src } : {}) }
}
function inb(mins: number): LedgerEntry {
  return { ts: at(mins), dir: 'in', chat_id: '1', text: 'ok' }
}

test('a reply inside the window counts as engagement', () => {
  const [s] = proactivityReport([out(0, 'trigger:abc'), inb(30)])
  expect(s.sent).toBe(1)
  expect(s.engaged).toBe(1)
  expect(s.silentStreak).toBe(0)
})

test('a reply outside the window does not', () => {
  const [s] = proactivityReport([out(0, 'trigger:abc'), inb(60 * 5)])
  expect(s.engaged).toBe(0)
  expect(s.silentStreak).toBe(1)
})

test('a reply before the send cannot count for it', () => {
  const [s] = proactivityReport([inb(0), out(10, 'trigger:abc')])
  expect(s.engaged).toBe(0)
})

test('conversation and unattributed sends are excluded', () => {
  expect(proactivityReport([out(0, 'chat'), out(5), inb(6)])).toEqual([])
})

test('sources are tracked separately', () => {
  const stats = proactivityReport([
    out(0, 'trigger:aaa'), inb(10),
    out(100, 'trigger:bbb'),
    out(200, 'trigger:bbb'),
  ])
  const byId = Object.fromEntries(stats.map(s => [s.src, s]))
  expect(byId['trigger:aaa'].engaged).toBe(1)
  expect(byId['trigger:bbb'].sent).toBe(2)
  expect(byId['trigger:bbb'].engaged).toBe(0)
})

test('the silent streak resets on the next engaged send', () => {
  const [s] = proactivityReport([
    out(0, 'trigger:x'),
    out(200, 'trigger:x'),
    out(400, 'trigger:x'), inb(410),
  ])
  expect(s.sent).toBe(3)
  expect(s.silentStreak).toBe(0)
})

test('the streak counts only sends since the last engagement', () => {
  const [s] = proactivityReport([
    out(0, 'trigger:x'), inb(10),
    out(200, 'trigger:x'),
    out(400, 'trigger:x'),
  ])
  expect(s.silentStreak).toBe(2)
})

test('entries out of order are handled', () => {
  const [s] = proactivityReport([inb(30), out(0, 'trigger:abc')])
  expect(s.engaged).toBe(1)
})

test('the since window excludes older sends', () => {
  const stats = proactivityReport([out(0, 'trigger:x'), out(1000, 'trigger:x')], {
    since: T0 + 500 * 60_000,
  })
  expect(stats[0].sent).toBe(1)
})

test('never-answered sources are called out once there are enough of them', () => {
  const text = formatReport(proactivityReport([
    out(0, 'trigger:dead'), out(200, 'trigger:dead'), out(400, 'trigger:dead'),
  ]))
  expect(text).toContain('3 in a row ignored')
  expect(text).toContain('Never once answered: trigger:dead')
})

test('an empty report says so rather than inventing a number', () => {
  expect(formatReport([])).toContain('no attributed proactive sends')
})
