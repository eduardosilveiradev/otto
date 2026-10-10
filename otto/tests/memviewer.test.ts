import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseMemory } from '../memory.ts'
import { collect, readNotes, scopeLabel, summaryPrompt, buildHtml, explicitEdges, centre, neighbours, similarEdges, kmeans, chooseClusters, clusterKey, memberKey, embedPlan, embedKey, embedText, reuseLabel, clusterTerms, rankQuery, type Item } from '../memviewer.ts'
import { emptyStats } from '../recallstats.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-memviewer-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const DAY = 86_400_000
const now = Date.parse('2026-06-01T00:00:00Z')

const raw = `---
name: likes-short-replies
description: Replies stay short
metadata:
  type: feedback
---

Keep it to a line. See [[who-they-are]].`

test('frontmatter, notes and recall stats come together as items', () => {
  const fb = parseMemory('/x/likes-short-replies.md', raw, 'global', now - 90 * DAY)!
  const user = parseMemory('/x/who-they-are.md', '---\nname: who-they-are\ndescription: The user\nmetadata:\n  type: user\n---\nA person.', 'global', now - 90 * DAY)!
  expect(fb.type).toBe('feedback')
  expect(fb.links).toEqual(['who-they-are'])

  const file = join(tmp, 'notes.json')
  writeFileSync(file, JSON.stringify([
    { id: 'a1', kind: 'loop', text: 'Pay the plumber\nby Friday', tags: [], createdAt: '2026-05-01T00:00:00Z', due: '2026-05-30' },
    { id: 'b2', kind: 'loop', text: 'Old thing', tags: [], createdAt: '2026-05-01T00:00:00Z', status: 'done' },
    { id: 'c3', kind: 'fact', text: 'Lives somewhere', tags: ['home'], createdAt: '2026-05-01T00:00:00Z' },
  ]))
  const notes = readNotes(file)

  const stats = emptyStats(now - 60 * DAY)
  stats.hits['global/who-they-are'] = { count: 3, firstAt: '2026-05-01T00:00:00Z', lastAt: '2026-05-31T00:00:00Z' }
  const items = collect([fb, user], notes, stats, { now })

  expect(items.filter(i => i.store === 'durable')).toHaveLength(2)
  expect(items.find(i => i.name === 'likes-short-replies')!.badge).toBe('never')
  const who = items.find(i => i.name === 'who-they-are')!
  expect(who.badge).toBeUndefined()
  expect(who.hits).toBe(3)
  const loop = items.find(i => i.id === 'a1')!
  expect(loop.status).toBe('open')              // a loop with no status is open
  expect(loop.name).toBe('Pay the plumber')     // first line only
  expect(items.find(i => i.id === 'c3')!.status).toBeUndefined()

  const prompt = summaryPrompt(items, '2026-06-01')
  expect(prompt).toContain('Keep it to a line.')   // global feedback bodies go in whole
  expect(prompt).toContain('due 2026-05-30')
  expect(prompt).not.toContain('Old thing')         // closed loops stay out

  const html = buildHtml(items, { text: '## Who they are\n</script>', note: '' }, new Date(now).toISOString())
  expect(html).not.toContain('/*DATA*/')
  expect(html.match(/<\/script>/g)!.length).toBe(2)  // embedded data cannot close the tag
})

test('notes are read without touching the file', () => {
  expect(readNotes(join(tmp, 'missing.json'))).toEqual([])
  const bad = join(tmp, 'bad.json')
  writeFileSync(bad, '{not json')
  expect(() => readNotes(bad)).toThrow()
  expect(existsSync(bad)).toBe(true)
  expect(readdirSync(tmp).some(f => f.includes('corrupt'))).toBe(false)
})

test('project scopes are labelled relative to home', () => {
  expect(scopeLabel('-home-someone--otto-repo', '/home/someone')).toBe('~/.otto-repo')
  expect(scopeLabel('global', '/home/someone')).toBe('global')
})

// --- graph -----------------------------------------------------------------

const item = (name: string, body = '', scope = 'global', description = ''): Item =>
  ({ id: scope + '/' + name, store: 'durable', kind: 'project', scope, name, description, body, updated: '2026-06-01', hits: 0 })
const v = (...x: number[]) => Float32Array.from(x)

test('explicit links resolve by scope, then global, and count the dead', () => {
  const items = [item('a', 'see [[b]] and [[nope]] and [c](c.md)', '-proj'), item('b', '', 'global'), item('b', '', '-proj'), item('c', 'back to [[a]]')]
  const { edges, dead } = explicitEdges(items)
  expect(dead).toBe(1)
  expect(edges).toContainEqual([0, 2])        // the same-scope b wins over the global one
  expect(edges).toContainEqual([0, 3])        // a markdown link to c.md counts
  expect(edges.filter(e => e[0] === 0 && e[1] === 3)).toHaveLength(1)   // a <-> c both ways is one edge
})

test('centring removes the shared direction before cosine', () => {
  const { unit, mean } = centre([v(1, 1, 0), v(1, -1, 0), null])
  expect(Array.from(mean)).toEqual([1, 0, 0])
  expect(unit[2]).toBeNull()
  expect(Array.from(unit[0]!)).toEqual([0, 1, 0])
  expect(Array.from(unit[1]!)).toEqual([0, -1, 0])
})

test('kNN keeps the top k above the floor; mutual marks pairs in each other\'s top k', () => {
  // 0,1,2 are close together; 3 is near 2 only; 4 points away from everything.
  const unit = [v(1, 0), v(0.99, 0.14), v(0.95, 0.31), v(0.8, 0.6), v(-1, 0)].map(x => { const n = Math.hypot(...x); return x.map(y => y / n) })
  const nb = neighbours(unit, 2, 0.5)
  expect(nb[0].map(([j]) => j)).toEqual([1, 2])
  expect(nb[4]).toEqual([])                        // nothing clears the floor
  expect(nb[0][0][1]).toBeGreaterThan(nb[0][1][1]) // best first
  const edges = similarEdges(nb, 1)
  const e = (a: number, b: number) => edges.find(x => x[0] === a && x[1] === b)
  expect(e(0, 1)![3]).toBe(1)    // 0 and 1 are each other's nearest
  expect(e(2, 3)![3]).toBe(0)    // 3's nearest is 2, but 2's nearest is 1: one-sided
  expect(e(0, 2)![3]).toBe(0)    // 2 is in 0's top 2 but 0 is not 2's nearest
  expect(edges.every(([a, b]) => a < b)).toBe(true)
  expect(new Set(edges.map(([a, b]) => a + ',' + b)).size).toBe(edges.length)
})

test('k-means separates obvious groups, deterministically, and keeps ids on a warm start', () => {
  const g = (x: number, y: number) => Array.from({ length: 6 }, (_, i) => { const a = Math.atan2(y, x) + (i - 2.5) * 0.02; return v(Math.cos(a), Math.sin(a)) })
  const unit = [...g(1, 0), ...g(0, 1), ...g(-1, -1)]
  const a = kmeans(unit, 3)
  expect(new Set(a.slice(0, 6)).size).toBe(1)
  expect(new Set([a[0], a[6], a[12]]).size).toBe(3)
  expect(Array.from(kmeans(unit, 3))).toEqual(Array.from(a))
  const warm = kmeans(unit, 3, 7, 60, [unit[12], unit[0], unit[6]])
  expect([warm[12], warm[0], warm[6]]).toEqual([0, 1, 2])
  expect(chooseClusters(unit, [2, 3, 4]).k).toBe(3)
})

test('cluster and embedding caches are keyed by content, not order', () => {
  expect(clusterKey(['a', 'b', 'c'])).toBe(clusterKey(['c', 'a', 'b']))
  expect(clusterKey(['a', 'b'])).not.toBe(clusterKey(['a', 'b', 'c']))
  expect(clusterKey(['a', 'b'], [8])).not.toBe(clusterKey(['a', 'b'], [9]))
  expect(memberKey(['x', 'y'])).toBe(memberKey(['y', 'x']))

  const texts = [embedText(item('one', 'body')), embedText(item('two', 'body'))]
  expect(texts[0]).toBe('one\n\nbody'.replace(/\s+/g, ' '))
  const cache = { model: 'm', dim: 2, vectors: { [embedKey(texts[0])]: 'AAAA' } }
  expect(embedPlan(texts, cache).todo).toEqual([1])          // only the uncached text is embedded
  expect(embedPlan(texts, null).todo).toEqual([0, 1])
  expect(embedPlan(texts, cache, 'other-model').todo).toEqual([0, 1])   // a new model re-embeds everything
  expect(embedKey('x')).not.toBe(embedKey('x '))
})

test('a cluster keeps its old label when it is mostly the same members', () => {
  const named = [{ members: ['a', 'b', 'c', 'd'], label: 'Old' }, { members: ['x', 'y'], label: 'Other' }]
  expect(reuseLabel(['a', 'b', 'c', 'd', 'e'], named)).toBe('Old')
  expect(reuseLabel(['a', 'q', 'r', 's'], named)).toBeUndefined()
})

test('c-TF-IDF names a cluster by what sets it apart', () => {
  const t = clusterTerms([
    [item('sidestore-pairing', '', 'global', 'sidestore pairing port'), item('sidestore-refresh', '', 'global', 'sidestore refresh apps')],
    [item('telegram-replies', '', 'global', 'telegram replies short'), item('telegram-buttons', '', 'global', 'telegram buttons')],
  ])
  expect(t[0][0]).toBe('sidestore')
  expect(t[1][0]).toBe('telegram')
})

test('a query ranks memories by centred cosine', () => {
  const { unit, mean } = centre([v(1, 0, 0), v(0, 1, 0), v(0, 0, 1)])
  const r = rankQuery(v(0, 1, 0.1), mean, unit, 2)
  expect(r[0][0]).toBe(1)
  expect(r).toHaveLength(2)
})
