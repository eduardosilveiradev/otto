import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  emptyStats, recordRecall, missKey, memoryKey, auditMemories, formatAudit, loadStats, saveStats, MAX_MISSES,
  MAX_HITS, pruneHits, countsQuery,
} from '../recallstats.ts'
import type { Memory } from '../memory.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-rs-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const DAY = 86_400_000
const T0 = Date.parse('2026-01-01T00:00:00Z')
const NOW = T0 + 200 * DAY

function mem(name: string, ageDays: number, over: Partial<Memory> = {}): Memory {
  return {
    name, description: `about ${name}`, type: 'user', body: 'body', scope: 'global',
    path: `__HOME__/${name}.md`, mtimeMs: NOW - ageDays * DAY, links: [], ...over,
  }
}
const call = (query: string, memories: string[] = [], noteIds: string[] = [], now = NOW) =>
  ({ query, memories, noteIds, now })

test('a query that finds nothing is logged; the same gap in other words is folded in', () => {
  const s = emptyStats(T0)
  recordRecall(s, call('landlord deposit'))
  recordRecall(s, call('Deposit landlords'))
  expect(Object.keys(s.misses)).toHaveLength(1)
  expect(Object.values(s.misses)[0]).toMatchObject({ query: 'landlord deposit', count: 2 })
})

test('an empty query is browsing, not asking: no miss, no hits', () => {
  const s = emptyStats(T0)
  recordRecall(s, call('  ', ['global/a']))
  recordRecall(s, call(''))
  expect(s.misses).toEqual({})
  expect(s.hits).toEqual({})
})

test('returned memories and notes are counted, each call once', () => {
  const s = emptyStats(T0)
  recordRecall(s, call('tax', ['global/a', 'global/b'], ['n1']))
  recordRecall(s, call('tax return', ['global/a']))
  expect(s.hits['global/a'].count).toBe(2)
  expect(s.hits['global/b'].count).toBe(1)
  expect(s.hits['note:n1'].count).toBe(1)
})

test('a later successful query resolves the miss; asking again with nothing reopens it', () => {
  const s = emptyStats(T0)
  recordRecall(s, call('passport'))
  recordRecall(s, call('passport', ['global/a']))
  expect(Object.values(s.misses)[0].resolvedAt).toBeDefined()
  expect(auditMemories([mem('a', 1)], s, { now: NOW }).misses).toEqual([])
  recordRecall(s, call('passport'))
  expect(auditMemories([mem('a', 1)], s, { now: NOW }).misses).toHaveLength(1)
})

test('the miss log is bounded and drops the least recently asked', () => {
  const s = emptyStats(T0)
  for (let i = 0; i < MAX_MISSES + 5; i++) recordRecall(s, call(`gap${i}x`, [], [], T0 + i * 1000))
  expect(Object.keys(s.misses)).toHaveLength(MAX_MISSES)
  expect(s.misses[missKey('gap0x')]).toBeUndefined()
  expect(s.misses[missKey(`gap${MAX_MISSES + 4}x`)]).toBeDefined()
})

test('never-hit needs grace: a young memory, or young counting, is not condemned', () => {
  const s = emptyStats(NOW - 5 * DAY)      // counting began five days ago
  const a = auditMemories([mem('old', 400), mem('young', 3)], s, { now: NOW })
  expect(a.neverHit).toEqual([])            // nothing has had 30 days of exposure
  expect(formatAudit(a)).toContain('provisional')

  const long = emptyStats(NOW - 90 * DAY)
  const b = auditMemories([mem('old', 400), mem('young', 3), mem('mid', 60)], long, { now: NOW })
  expect(b.neverHit.map(r => r.key)).toEqual(['global/old', 'global/mid'])   // oldest first
})

test('stale means used once and not lately; a never-hit memory is not double-listed', () => {
  const s = emptyStats(NOW - 300 * DAY)
  recordRecall(s, call('x', ['global/used-long-ago'], [], NOW - 250 * DAY))
  recordRecall(s, call('x', ['global/used-lately'], [], NOW - 3 * DAY))
  const a = auditMemories(
    [mem('used-long-ago', 280), mem('used-lately', 280), mem('never', 280), mem('rewritten', 10)],
    s, { now: NOW },
  )
  expect(a.stale.map(r => r.key)).toEqual(['global/used-long-ago'])
  expect(a.neverHit.map(r => r.key)).toEqual(['global/never'])
  expect(a.topHit[0].key).toBeDefined()
})

test('derived memories are skippable and the same name in two scopes is two keys', () => {
  const s = emptyStats(NOW - 90 * DAY)
  const a = auditMemories([mem('house-rules', 100), mem('shared', 100), mem('shared', 100, { scope: '-proj' })], s, {
    now: NOW, skipNames: ['house-rules'],
  })
  expect(a.neverHit.map(r => r.key).sort()).toEqual(['-proj/shared', 'global/shared'])
  expect(memoryKey({ scope: 'global', name: 'a' })).toBe('global/a')
})

test('stats round-trip through disk, and a corrupt file starts fresh instead of throwing', () => {
  const file = join(tmp, 'stats.json')
  const s = emptyStats(T0)
  recordRecall(s, call('tax', ['global/a']))
  saveStats(file, s)
  expect(loadStats(file).hits['global/a'].count).toBe(1)
  writeFileSync(file, 'nope')
  expect(loadStats(file, T0).hits).toEqual({})
  expect(loadStats(join(tmp, 'missing.json'), T0).since).toBe(new Date(T0).toISOString())
})

test('an empty audit says so', () => {
  expect(formatAudit(auditMemories([], emptyStats(NOW), { now: NOW }))).toContain('Nothing to report')
})

test('the hit table is bounded, evicting the least recently returned', () => {
  const s = emptyStats(T0)
  for (let i = 0; i < MAX_HITS + 3; i++) recordRecall(s, call('q', [`global/m${i}`], [], T0 + i * 1000))
  expect(Object.keys(s.hits)).toHaveLength(MAX_HITS)
  expect(s.hits['global/m0']).toBeUndefined()
  expect(s.hits[`global/m${MAX_HITS + 2}`]).toBeDefined()
})

test('pruning drops counters for memories and notes that no longer exist, keeping the rest', () => {
  const s = emptyStats(T0)
  recordRecall(s, call('q', ['global/kept', 'global/deleted'], ['n1', 'n2']))
  const dropped = pruneHits(s, new Set(['global/kept', 'note:n1']))
  expect(dropped).toBe(2)
  expect(Object.keys(s.hits).sort()).toEqual(['global/kept', 'note:n1'])
})

test('only queries with words are worth a disk round-trip', () => {
  expect(countsQuery('')).toBe(false)
  expect(countsQuery('   ')).toBe(false)
  expect(countsQuery('tax')).toBe(true)
})
