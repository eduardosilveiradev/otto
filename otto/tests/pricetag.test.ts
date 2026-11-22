import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { wireJob, type CodeJob } from '../codejobs.ts'
import { priceTag, weekShare, jobRollup, readJobCosts, appendJobCost, type JobCost } from '../usage.ts'

const job = (over: Partial<CodeJob> = {}): CodeJob => ({
  id: 'j1', title: 'Fix the thing', brief: 'fix it', project: 'demo', repo: 'example/demo', branch: 'fix/thing',
  threadId: 't1', agent: 'T3 Code', where: 'local', model: 'Opus 5.5', createdAt: '2026-11-05T10:00:00.000Z',
  tokenBudget: 400_000, steps: [], ...over,
})

test('a finished job card carries its token line', () => {
  const merged = job({ mergedAt: '2026-11-05T12:00:00Z', tokensUsed: 2_100_000, weekShare: 3 })
  expect(wireJob(merged, undefined, undefined).cost).toBe('2.1M Claude tokens · ~3% of the week')
  expect(wireJob(job({ stoppedAt: '2026-11-05T12:00:00Z', tokensUsed: 40_000 }), undefined, undefined).cost).toBe('40K Claude tokens')
  // Still running: no tag yet.
  expect(wireJob(job({ tokensUsed: 40_000 }), { id: 't1', status: 'running' }, undefined).cost).toBeUndefined()
})

test('Claude and GPT are counted apart; GPT never takes a share of the Claude week', () => {
  expect(priceTag(900_000, 'GPT 6.1 Sol · high', 5)).toBe('900K GPT tokens')
  expect(priceTag(900_000, 'gpt-6.1-sol')).toBe('900K GPT tokens')
  expect(priceTag(900_000, 'gpt-6.2-sol')).toBe('900K GPT tokens')
  expect(priceTag(900_000, 'claude-fable-5-2', 2)).toBe('900K Claude tokens · ~2% of the week')
  expect(priceTag(900_000, undefined, 2)).toBe('900K tokens')
})

test('a job with no token data shows nothing, not "0 tokens"', () => {
  expect(priceTag(0, 'Opus 5.5', 3)).toBeUndefined()
  expect(priceTag(undefined, 'Opus 5.5')).toBeUndefined()
  const card = wireJob(job({ mergedAt: '2026-11-05T12:00:00Z' }), undefined, undefined)
  expect(card.cost).toBeUndefined()
  expect('cost' in card).toBe(false)
})

test('the week share is the window delta, and only within one window', () => {
  const r = 1_800_000_000
  expect(weekShare({ pct: 40, resetsAt: r }, { pct: 43.4, resetsAt: r })).toBe(3)
  expect(weekShare({ pct: 40, resetsAt: r }, { pct: 40.3, resetsAt: r })).toBeUndefined()
  expect(weekShare({ pct: 90, resetsAt: r }, { pct: 2, resetsAt: r + 7 * 86_400 })).toBeUndefined()
  expect(weekShare(undefined, { pct: 43, resetsAt: r })).toBeUndefined()
})

test('the monthly rollup sums by model and names the three priciest jobs', () => {
  const now = new Date(2026, 10, 20, 12).getTime()
  const at = (day: number) => new Date(2026, 10, day, 9).toISOString()
  const costs: JobCost[] = [
    { id: 'a', at: at(2), title: 'Big refactor', model: 'Opus 5.5 · xhigh', tokens: 2_000_000 },
    { id: 'b', at: at(3), title: 'Small fix', model: 'Opus 5.5', tokens: 100_000 },
    { id: 'c', at: at(4), title: 'Backend port', model: 'GPT 6.1 Sol', tokens: 1_500_000 },
    { id: 'd', at: at(5), title: 'Docs', model: 'GPT 6.1 Sol', tokens: 50_000 },
    { id: 'old', at: new Date(2026, 9, 30).toISOString(), title: 'Last month', model: 'Opus 5.5', tokens: 9_000_000 },
  ]
  expect(jobRollup(costs, now)).toBe('jobs this month: Opus 5.5 2.1M, GPT 6.1 Sol 1.6M · priciest: "Big refactor" 2M, "Backend port" 1.5M, "Small fix" 100K')
  expect(jobRollup([], now)).toBeUndefined()
})

test('the cost log keeps the latest row per job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-pricetag-'))
  appendJobCost(dir, { id: 'a', at: '2026-11-02T09:00:00Z', title: 'A', tokens: 100 })
  appendJobCost(dir, { id: 'a', at: '2026-11-03T09:00:00Z', title: 'A', tokens: 300 })
  writeFileSync(join(dir, 'job-costs.jsonl'), 'not json\n', { flag: 'a' })
  expect(readJobCosts(dir)).toEqual([{ id: 'a', at: '2026-11-03T09:00:00Z', title: 'A', tokens: 300 }])
})
