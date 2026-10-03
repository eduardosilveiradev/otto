import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createJob, applyEvent, scheduleJobs, tallyStream, EMPTY_TALLY, parseQuietHours,
  inQuietHours, nextQuietStart, budgetExceeded, overWallClock, pruneJobs, formatJob,
  resultPayload, loadJobs, saveJobs, updateJob, isTerminal,
  type Job,
} from '../jobs.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-jobs-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const NOW = Date.parse('2026-08-11T20:00:00Z')
const at = (mins: number) => NOW + mins * 60_000

function job(over: Partial<Job> = {}): Job {
  return {
    ...createJob({ task: 'read the threads', tools: ['Read', 'Grep'] }, { now: NOW, scratchRoot: tmp, id: 'j1' }),
    ...over,
  }
}

test('a job without a tool allowlist is refused', () => {
  expect(() => createJob({ task: 'x', tools: [] }, { scratchRoot: tmp })).toThrow(/allowlist is required/)
  expect(() => createJob({ task: '  ', tools: ['Read'] }, { scratchRoot: tmp })).toThrow(/task is required/)
})

test('a new job queues with its own scratch dir and a budget', () => {
  const j = createJob({ task: 'summarise', tools: ['Read'] }, { now: NOW, scratchRoot: tmp, id: 'abc' })
  expect(j.state).toBe('queued')
  expect(j.scratchDir).toBe(join(tmp, 'abc'))
  expect(j.tokenBudget).toBeGreaterThan(0)
  expect(j.tokensUsed).toBe(0)
})

test('absurd caps are clamped rather than honoured', () => {
  const j = createJob(
    { task: 'x', tools: ['Read'], wallClockMs: 99 * 60 * 60_000, tokenBudget: 1e12 },
    { now: NOW, scratchRoot: tmp },
  )
  expect(j.wallClockMs).toBeLessThanOrEqual(2 * 60 * 60_000)
  expect(j.tokenBudget).toBeLessThanOrEqual(2_000_000)
})

test('an overnight job is parked until quiet hours open', () => {
  const j = createJob(
    { task: 'x', tools: ['Read'], tags: ['overnight'], quietHours: '23:00-08:00' },
    { now: Date.parse('2026-08-11T14:00:00'), scratchRoot: tmp },
  )
  expect(j.state).toBe('parked')
  expect(new Date(j.notBefore!).getHours()).toBe(23)
})

test('overnight with no quiet hours configured just queues', () => {
  const j = createJob({ task: 'x', tools: ['Read'], tags: ['overnight'] }, { now: NOW, scratchRoot: tmp })
  expect(j.state).toBe('parked')
  expect(j.notBefore).toBeUndefined()
})

test('quiet hours parse, wrap past midnight, and reject nonsense', () => {
  const w = parseQuietHours('23:00-08:00')!
  expect(inQuietHours(w, new Date('2026-08-11T23:30:00'))).toBe(true)
  expect(inQuietHours(w, new Date('2026-08-11T03:00:00'))).toBe(true)
  expect(inQuietHours(w, new Date('2026-08-11T12:00:00'))).toBe(false)
  expect(parseQuietHours('nonsense')).toBeNull()
  expect(parseQuietHours('08:00-08:00')).toBeNull()
  expect(inQuietHours(null, new Date())).toBe(false)
})

test('already inside the window means now, not tomorrow', () => {
  const w = parseQuietHours('23:00-08:00')
  const inside = new Date('2026-08-12T02:00:00')
  expect(nextQuietStart(w, inside)).toBe(inside.getTime())
})

test('the state machine refuses to resurrect a killed job', () => {
  const killed = applyEvent(job({ state: 'running', startedAt: new Date(NOW).toISOString() }), {
    type: 'kill', at: at(10), reason: 'wall-clock',
  })
  expect(killed.state).toBe('killed')
  expect(() => applyEvent(killed, { type: 'start', at: at(11) })).toThrow(/illegal killed -> running/)
})

test('a killed job keeps whatever it had produced, marked partial', () => {
  let j = applyEvent(job(), { type: 'start', at: NOW })
  j = applyEvent(j, { type: 'progress', tokens: 500, text: 'found three unpaid invoices so far' })
  j = applyEvent(j, { type: 'kill', at: at(10), reason: 'wall-clock' })
  expect(j.result).toContain('three unpaid invoices')
  expect(j.partial).toBe(true)
  expect(j.error).toContain('wall-clock')
})

test('a finished job is not partial', () => {
  let j = applyEvent(job(), { type: 'start', at: NOW })
  j = applyEvent(j, { type: 'finish', at: at(2), result: 'done thinking' })
  expect(j.partial).toBe(false)
  expect(j.result).toBe('done thinking')
  expect(isTerminal(j.state)).toBe(true)
})

test('progress accumulates tokens', () => {
  let j = applyEvent(job(), { type: 'start', at: NOW })
  j = applyEvent(j, { type: 'progress', tokens: 400 })
  j = applyEvent(j, { type: 'progress', tokens: 600, costUsd: 0.12 })
  expect(j.tokensUsed).toBe(1000)
  expect(j.costUsd).toBe(0.12)
})

test('waking a parked job clears its notBefore', () => {
  const parked = applyEvent(job(), { type: 'park', until: new Date(at(60)).toISOString() })
  expect(parked.state).toBe('parked')
  const woken = applyEvent(parked, { type: 'wake' })
  expect(woken.state).toBe('queued')
  expect(woken.notBefore).toBeUndefined()
})

test('budget and wall clock are separate ceilings', () => {
  expect(budgetExceeded(job({ tokensUsed: 10, tokenBudget: 100 }))).toBe(false)
  expect(budgetExceeded(job({ tokensUsed: 101, tokenBudget: 100 }))).toBe(true)
  const running = job({ state: 'running', startedAt: new Date(NOW).toISOString(), wallClockMs: 60_000 })
  expect(overWallClock(running, at(0.5))).toBe(false)
  expect(overWallClock(running, at(5))).toBe(true)
  // A queued job has no clock to be over.
  expect(overWallClock(job({ wallClockMs: 1 }), at(500))).toBe(false)
})

test('the scheduler starts queued work up to the concurrency limit', () => {
  const jobs = [
    job({ id: 'a', createdAt: new Date(at(-3)).toISOString() }),
    job({ id: 'b', createdAt: new Date(at(-2)).toISOString() }),
    job({ id: 'c', createdAt: new Date(at(-1)).toISOString() }),
  ]
  const d = scheduleJobs(jobs, { now: NOW, maxRunning: 2 })
  expect(d.start.map(j => j.id)).toEqual(['a', 'b'])
})

test('a running job occupies a slot', () => {
  const jobs = [
    job({ id: 'r', state: 'running', startedAt: new Date(at(-1)).toISOString() }),
    job({ id: 'q' }),
    job({ id: 'q2' }),
  ]
  expect(scheduleJobs(jobs, { now: NOW, maxRunning: 2 }).start.map(j => j.id)).toEqual(['q'])
})

test('a job being killed this tick frees its slot', () => {
  const jobs = [
    job({ id: 'stuck', state: 'running', startedAt: new Date(at(-60)).toISOString(), wallClockMs: 60_000 }),
    job({ id: 'waiting' }),
  ]
  const d = scheduleJobs(jobs, { now: NOW, maxRunning: 1 })
  expect(d.kill.map(k => k.job.id)).toEqual(['stuck'])
  expect(d.kill[0].reason).toBe('wall-clock')
  expect(d.start.map(j => j.id)).toEqual(['waiting'])
})

test('an over-budget job is killed for budget, not the clock', () => {
  const jobs = [job({ id: 'greedy', state: 'running', startedAt: new Date(NOW).toISOString(), tokensUsed: 999, tokenBudget: 100 })]
  expect(scheduleJobs(jobs, { now: at(1), maxRunning: 2 }).kill[0].reason).toBe('budget')
})

// The failure this guards: the Mac slept through the whole window, and the
// night's batch tries to run at breakfast because notBefore is technically past.
test('an overnight job wakes only while quiet hours are actually running', () => {
  const w = parseQuietHours('23:00-08:00')
  const parked = job({ id: 'o', state: 'parked', tags: ['overnight'], notBefore: '2026-08-11T23:00:00' })
  const morning = Date.parse('2026-08-12T09:30:00')
  expect(scheduleJobs([parked], { now: morning, quiet: w }).wake).toHaveLength(0)
  const night = Date.parse('2026-08-12T23:30:00')
  expect(scheduleJobs([parked], { now: night, quiet: w }).wake.map(j => j.id)).toEqual(['o'])
})

test('a plainly parked job wakes on its time regardless of the hour', () => {
  const parked = job({ id: 'p', state: 'parked', notBefore: new Date(at(-1)).toISOString() })
  expect(scheduleJobs([parked], { now: NOW, quiet: parseQuietHours('23:00-08:00') }).wake).toHaveLength(1)
})

test('tallying counts tokens off the stream as it arrives', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'looking' }], usage: { input_tokens: 100, output_tokens: 20 } } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }], usage: { output_tokens: 30, cache_read_input_tokens: 5 } } }),
  ]
  const t = lines.reduce(tallyStream, EMPTY_TALLY)
  expect(t.tokens).toBe(155)
  expect(t.text).toBe('looking')
})

test('the result block replaces the running count and carries the answer', () => {
  const t = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }], usage: { output_tokens: 10 } } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'three invoices', total_cost_usd: 0.4, usage: { input_tokens: 900, output_tokens: 100 } }),
  ].reduce(tallyStream, EMPTY_TALLY)
  expect(t.tokens).toBe(1000)
  expect(t.result).toBe('three invoices')
  expect(t.costUsd).toBe(0.4)
  expect(t.ok).toBe(true)
})

test('garbage on the stream does not disturb the tally', () => {
  const t = ['', 'not json', '{"broken":', JSON.stringify({ type: 'assistant', message: { content: [], usage: { output_tokens: 7 } } })]
    .reduce(tallyStream, EMPTY_TALLY)
  expect(t.tokens).toBe(7)
})

test('the result payload frames a partial return as partial', () => {
  const killed = applyEvent(
    applyEvent(job(), { type: 'start', at: NOW }),
    { type: 'kill', at: at(10), reason: 'wall-clock', partial: 'got halfway' },
  )
  const p = resultPayload({ ...killed, chatId: '42' })
  expect(p.source).toBe('otto-job')
  expect(p.text).toContain('stopped early')
  expect(p.text).toContain('output below is partial')
  expect(p.text).toContain('got halfway')
  expect(p.text).toContain('chat_id 42')
})

test('a finished job with no output says so instead of an empty message', () => {
  const done = applyEvent(applyEvent(job(), { type: 'start', at: NOW }), { type: 'finish', at: at(1), result: '' })
  expect(resultPayload(done).text).toContain('(no output)')
})

test('pruning keeps live jobs and drops old finished ones', () => {
  const jobs = [
    job({ id: 'live', state: 'running' }),
    job({ id: 'old', state: 'done', endedAt: new Date(NOW - 30 * 24 * 60 * 60_000).toISOString() }),
    job({ id: 'recent', state: 'done', endedAt: new Date(NOW - 60_000).toISOString() }),
  ]
  expect(pruneJobs(jobs, NOW).map(j => j.id)).toEqual(['live', 'recent'])
})

test('jobs round-trip through disk and a corrupt file is moved aside', () => {
  const file = join(tmp, 'jobs.json')
  saveJobs(file, [job({ id: 'x' })])
  expect(loadJobs(file).map(j => j.id)).toEqual(['x'])
  expect(readFileSync(file, 'utf8')).toContain('"id": "x"')

  writeFileSync(file, '{ not json')
  expect(loadJobs(file)).toEqual([])
  expect(loadJobs(file)).toEqual([])
})

test('updateJob patches one record in place', () => {
  const file = join(tmp, 'jobs2.json')
  saveJobs(file, [job({ id: 'a' }), job({ id: 'b' })])
  const updated = updateJob(file, 'b', j => applyEvent(j, { type: 'start', at: NOW }))
  expect(updated!.state).toBe('running')
  expect(loadJobs(file).find(j => j.id === 'a')!.state).toBe('queued')
  expect(updateJob(file, 'nope', j => j)).toBeNull()
})

test('formatJob shows the budget burn and the partial flag', () => {
  const j = job({ state: 'killed', tokensUsed: 12_000, tokenBudget: 150_000, partial: true })
  const line = formatJob(j, NOW)
  expect(line).toContain('killed')
  expect(line).toContain('12k/150k tok')
  expect(line).toContain('partial')
})
