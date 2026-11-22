import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spendWeekOffer, queueBacklog, TAP, MODEL, type Idea } from '../spendweek.ts'
import { validateCard } from '../cards.ts'

const NOW = Date.parse('2026-11-15T20:00:00Z')
const H = 3_600_000
const plan = (used: number, resetIn = 20 * H) => ({ at: NOW, seven_day: { used_percentage: used, resets_at: (NOW + resetIn) / 1000 } })
const idea = (title: string, size: 'S' | 'M'): Idea => ({ title, project: 'demo', brief: `Build ${title}. More detail.`, size })
let dir: string
const backlog = (ideas: unknown) => writeFileSync(join(dir, 'backlog.json'), JSON.stringify(ideas))
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'spendweek-')) })

// 45% left − 15 margin = 30 points: S ≈ 2.9, M ≈ 8.6 → two S + two M = 22.9; a third M (31.4) overruns.
const ideas = [idea('m1', 'M'), idea('s1', 'S'), idea('m2', 'M'), idea('s2', 'S'), idea('m3', 'M')]

test('over 40% left a day before reset: one card, smallest first, only what fits', () => {
  backlog(ideas)
  const o = spendWeekOffer(dir, plan(55), NOW)!
  expect(validateCard(o.card).ok).toBe(true)
  const list = o.card.blocks.find(b => b.type === 'list') as { items: { title: string; detail: string }[] }
  expect(list.items.map(i => i.title)).toEqual(['s1', 's2', 'm1', 'm2'])
  expect(list.items[0]!.detail).toBe('Build s1.')
  expect(o.buttons).toEqual([{ label: 'queue them tonight', data: TAP }])
  expect(Buffer.byteLength(TAP)).toBeLessThanOrEqual(60)
})

test('silent at or under 40% left, and before the last day', () => {
  backlog(ideas)
  expect(spendWeekOffer(dir, plan(60), NOW)).toBeNull()
  expect(spendWeekOffer(dir, plan(70), NOW)).toBeNull()
  expect(spendWeekOffer(dir, plan(10, 30 * H), NOW)).toBeNull()
})

test('one card per window, even as readings drift', () => {
  backlog(ideas)
  expect(spendWeekOffer(dir, plan(45), NOW)).not.toBeNull()
  expect(spendWeekOffer(dir, { ...plan(46, 19 * H + 60_000), at: NOW + H }, NOW + H)).toBeNull()
})

test('missing, empty or malformed backlog stays silent', () => {
  expect(spendWeekOffer(dir, plan(45), NOW)).toBeNull()
  backlog([])
  expect(spendWeekOffer(dir, plan(45), NOW)).toBeNull()
  backlog([{ title: 'x', project: 'demo', brief: 'b', size: 'L' }, { title: '', project: 'demo', brief: 'b', size: 'S' }])
  expect(spendWeekOffer(dir, plan(45), NOW)).toBeNull()
  writeFileSync(join(dir, 'backlog.json'), '{not json')
  expect(spendWeekOffer(dir, plan(45), NOW)).toBeNull()
})

test('the tap queues the shown picks as one chain, once; next week skips them', async () => {
  backlog([idea('a', 'S'), idea('b', 'M')])
  spendWeekOffer(dir, plan(45), NOW)
  const calls: any[] = []
  const start = async (i: any) => { calls.push(i); return { id: `j${calls.length}` } }
  expect(await queueBacklog(dir, start, NOW)).toMatch(/^queued 2/)
  expect(calls.map(c => [c.title, c.after, c.model, c.origin])).toEqual([['a', undefined, MODEL, 'user-typed'], ['b', 'j1', MODEL, 'user-typed']])
  expect(await queueBacklog(dir, start, NOW)).toBe('already queued')
  expect(calls).toHaveLength(2)
  // Next week the queued ideas are no longer candidates.
  const next = { at: NOW + 7 * 24 * H, seven_day: { used_percentage: 10, resets_at: (NOW + 7 * 24 * H + 20 * H) / 1000 } }
  expect(spendWeekOffer(dir, next, NOW + 7 * 24 * H)).toBeNull()
})

test('a failed start stops the chain; the next tap resumes after the last started job', async () => {
  backlog([idea('a', 'S'), idea('b', 'S'), idea('c', 'S')])
  spendWeekOffer(dir, plan(45), NOW)
  const calls: any[] = []
  let fail = true
  const start = async (i: any) => {
    if (i.title === 'b' && fail) { fail = false; throw new Error('T3 is down') }
    calls.push(i); return { id: `j${calls.length}` }
  }
  expect(await queueBacklog(dir, start, NOW)).toBe('queued 1; stopped at "b": T3 is down')
  expect(await queueBacklog(dir, start, NOW)).toMatch(/^queued 3/)
  expect(calls.map(c => [c.title, c.after])).toEqual([['a', undefined], ['b', 'j1'], ['c', 'j2']])
  expect(await queueBacklog(dir, start, NOW + 21 * H)).toBe('that week already reset')
})
