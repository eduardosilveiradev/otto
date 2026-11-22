import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runInSlot, drainNotices, resolveSlotsConfig, type SlotDeps } from '../slots.ts'

const deps = (o: Partial<SlotDeps> = {}): SlotDeps => ({
  dir: mkdtempSync(join(tmpdir(), 'slots-')), max: 1,
  start: async pid => (pid === process.pid ? 1000 : undefined),
  busy: async () => undefined, sleep: ms => Bun.sleep(ms), now: Date.now, pollMs: 10, ...o,
})

test('two runs serialise in one lane', async () => {
  const d = deps()
  const log = join(d.dir, 'order.log')
  const job = (tag: string) => ['sh', '-c', `echo ${tag}-start >> ${log}; sleep 0.2; echo ${tag}-end >> ${log}`]
  await Promise.all([runInSlot('a', job('a'), d), runInSlot('b', job('b'), d)])
  const lines = readFileSync(log, 'utf8').trim().split('\n')
  expect(lines).toHaveLength(4)
  expect(lines[0]!.slice(0, 1)).toBe(lines[1]!.slice(0, 1)) // first job ran start→end before the second began
  expect(lines[1]).toEndWith('-end')
  expect(existsSync(join(d.dir, 'slot-0.json'))).toBe(false)
})

test('max 2 lets two run side by side', async () => {
  const d = deps({ max: 2 })
  const log = join(d.dir, 'order.log')
  const job = (tag: string) => ['sh', '-c', `echo ${tag}-start >> ${log}; sleep 0.3; echo ${tag}-end >> ${log}`]
  await Promise.all([runInSlot('a', job('a'), d), runInSlot('b', job('b'), d)])
  expect(readFileSync(log, 'utf8').trim().split('\n').slice(0, 2).every(l => l.endsWith('-start'))).toBe(true)
})

test('a dead holder\'s lane is reclaimed; a live one is not', async () => {
  const d = deps()
  mkdirSync(d.dir, { recursive: true })
  writeFileSync(join(d.dir, 'slot-0.json'), JSON.stringify({ pid: 999999, start: 5, name: 'crashed', at: 0, token: 'x' }))
  expect(await runInSlot('next', ['true'], d)).toBe(0)

  // Same pid, but a different start time: the pid was reused, the holder is gone.
  writeFileSync(join(d.dir, 'slot-0.json'), JSON.stringify({ pid: process.pid, start: 999, name: 'old', at: 0, token: 'y' }))
  expect(await runInSlot('next', ['true'], d)).toBe(0)

  // A live holder keeps it: the run is still waiting when we give up on it.
  writeFileSync(join(d.dir, 'slot-0.json'), JSON.stringify({ pid: process.pid, start: 1000, name: 'live', at: 0, token: 'z' }))
  const r = await Promise.race([runInSlot('blocked', ['true'], d).then(() => 'ran'), Bun.sleep(150).then(() => 'waiting')])
  expect(r).toBe('waiting')
  writeFileSync(join(d.dir, 'slot-0.json'), '') // unblock the pending run so the test exits clean
})

test('high load delays the start', async () => {
  let calls = 0
  const d = deps({ busy: async () => (++calls < 3 ? 'swap at 25.0 GB' : undefined) })
  const out = join(d.dir, 'ran')
  await runInSlot('build', ['sh', '-c', `echo $(date) > ${out}`], d)
  expect(calls).toBe(3)
  expect(existsSync(out)).toBe(true)
})

test('exit code passes through', async () => {
  expect(await runInSlot('x', ['sh', '-c', 'exit 7'], deps())).toBe(7)
  expect(await runInSlot('x', ['sh', '-c', 'kill -TERM $$'], deps())).toBe(143)
})

test('one notice only for a --notify run that waited over 5 minutes', async () => {
  let t = 0
  const clock = { now: () => t, sleep: async () => { t += 60_000 } }
  let calls = 0
  const d = deps({ ...clock, busy: async () => (++calls <= 6 ? 'load average 14.2' : undefined) })
  await runInSlot('the release build', ['true'], d, { notify: true })
  expect(drainNotices(d.dir)).toEqual(["load's down. starting the release build now (waited 6 min)."])
  expect(drainNotices(d.dir)).toEqual([])

  calls = 0; t = 0
  await runInSlot('cron build', ['true'], d) // waited just as long, but nobody asked for it
  calls = 3; t = 0
  await runInSlot('short wait', ['true'], d, { notify: true }) // 3 min
  expect(drainNotices(d.dir)).toEqual([])
})

test('config falls back on bad values', () => {
  expect(resolveSlotsConfig({ slots: { max: 2, load: 12 }, runaway: { swapGb: 10 } })).toEqual({ max: 2, load: 12, swapGb: 10 })
  const c = resolveSlotsConfig({ slots: { max: 'x', load: -1 } })
  expect(c.max).toBe(1)
  expect(c.load).toBeGreaterThan(0)
  expect(c.swapGb).toBe(20)
})
