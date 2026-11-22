import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { activityLine, jobWaiters, currentSlotWait, jobSpans } from '../job-overview.ts'
import { acquire, readSlotWaiters, release, type SlotWaiter } from '../slots.ts'

const at = (hour: number) => { const d = new Date(); d.setHours(hour, 0, 0, 0); return d.toISOString() }
const waiter = (over: Partial<SlotWaiter> = {}): SlotWaiter => ({ pid: 10, start: 1, token: 'a', cwd: '/work/tree/otto', since: at(10), to: null, ...over })
const mac = { load: 12, limit: 8, waiting: 1 }

test('slot waiters match only the worktree itself and its children', () => {
  const rows = [waiter(), waiter({ cwd: '/work/tree' }), waiter({ cwd: '/work/tree-other' }), waiter({ cwd: '/elsewhere' })]
  expect(jobWaiters(rows, '/work/tree')).toEqual(rows.slice(0, 2))
  expect(jobWaiters(rows)).toEqual([])
  expect(currentSlotWait([rows[0]!], rows, mac)).toMatchObject({ since: at(10), position: 1, load: 12, limit: 8 })
})

test('dead and reused pids are not current waiters; completed history remains', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-slots-'))
  writeFileSync(join(dir, 'wait-a.json'), JSON.stringify(waiter()))
  const now = Date.parse(at(11))
  for (const start of [undefined, 2]) {
    writeFileSync(join(dir, 'wait-a.json'), JSON.stringify(waiter()))
    const rows = await readSlotWaiters(dir, async () => start, now)
    expect(rows[0]!.to).toBe(at(11))
    expect(currentSlotWait(jobWaiters(rows, '/work/tree'), rows, mac)).toBeNull()
  }
})

test('slot wait is written before sleeping and retained with its exact end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-slots-'))
  let clock = Date.parse(at(10)), busy = true
  const d = { dir, max: 1, start: async () => 1, now: () => clock, busy: async () => busy ? 'loaded' : undefined,
    sleep: async () => {
      const rows = await readSlotWaiters(dir, async () => 1, clock)
      expect(rows[0]).toMatchObject({ cwd: process.cwd(), pid: process.pid, to: null })
      clock += 1000; busy = false
    } }
  const lane = await acquire('test', d)
  release(lane.lane, lane.token)
  const rows = await readSlotWaiters(dir, async () => 1, clock)
  expect(Date.parse(rows[0]!.to!) - Date.parse(rows[0]!.since)).toBe(1000)
})

test('activity is the first plain sentence, capped at 140 Unicode characters', () => {
  expect(activityLine(' **Reading** [the tests](https://example.com).\nThen fixing them.')).toBe('Reading the tests.')
  expect(activityLine('x'.repeat(200))).toHaveLength(140)
  expect(activityLine('😀'.repeat(200))?.length).toBe(280)
  expect(activityLine('  ')).toBeNull()
  expect(activityLine()).toBeNull()
})

test('running spans remain open, including a current wait', () => {
  expect(jobSpans({ startedAt: at(9) }, 'running', Date.parse(at(12)))).toEqual([{ state: 'run', from: at(9), to: null }])
  expect(jobSpans({ startedAt: at(9), slotWaits: [waiter()] }, 'running', Date.parse(at(12)))).toEqual([
    { state: 'run', from: at(9), to: at(10) }, { state: 'wait', from: at(10), to: null },
  ])
})

test('completed waits split run spans and merging ends review with a point', () => {
  const base = { startedAt: at(9), slotWaits: [waiter({ to: at(11) })] }
  expect(jobSpans(base, 'running', Date.parse(at(12)))).toEqual([
    { state: 'run', from: at(9), to: at(10) }, { state: 'wait', from: at(10), to: at(11) }, { state: 'run', from: at(11), to: null },
  ])
  expect(jobSpans({ ...base, reviewAt: at(12), mergedAt: at(13) }, 'merged', Date.parse(at(14))).slice(-3)).toEqual([
    { state: 'run', from: at(11), to: at(12) }, { state: 'review', from: at(12), to: at(13) }, { state: 'merged', from: at(13), to: at(13) },
  ])
})

test('spans clip to machine-local midnight and omit yesterday', () => {
  const midnight = at(0), yesterday = new Date(Date.parse(midnight) - 3600_000).toISOString()
  expect(jobSpans({ startedAt: yesterday }, 'running', Date.parse(at(12)))).toEqual([{ state: 'run', from: midnight, to: null }])
  expect(jobSpans({ startedAt: yesterday, mergedAt: yesterday }, 'merged', Date.parse(at(12)))).toEqual([])
})

test('a build waiting after PR open interrupts the review span', () => {
  expect(jobSpans({ startedAt: at(9), reviewAt: at(10), slotWaits: [waiter({ since: at(11), to: at(12) })] }, 'review', Date.parse(at(14)))).toEqual([
    { state: 'run', from: at(9), to: at(10) },
    { state: 'review', from: at(10), to: at(11) },
    { state: 'wait', from: at(11), to: at(12) },
    { state: 'review', from: at(12), to: null },
  ])
})

test('failed and stopped jobs end with timestamped points', () => {
  for (const state of ['failed', 'stopped']) expect(jobSpans({ startedAt: at(9), endedAt: at(10) }, state, Date.parse(at(14))).at(-1)).toEqual({ state, from: at(10), to: at(10) })
})
