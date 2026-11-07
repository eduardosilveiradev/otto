import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseCpuTime, parsePs, procLabel, parseSwap, parseTopMem, resolveRunawayConfig, DEFAULT_RUNAWAY, assessLoad, quitProcess, loadStatus,
  loadLoadState, saveLoadState, peekLoadState, QUIT_RE, type ProcSample, type LoadState, type SystemSample,
} from '../runaway.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-runaway-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const T0 = Date.parse('2026-10-19T19:00:00Z')
const MIN = 60_000
const START = 1792600000
const SIM = '/Applications/Simulator.app/Contents/MacOS/Simulator'
const cfg = DEFAULT_RUNAWAY
const me = { uid: 501, protect: [] as number[] }
const proc = (pid: number, cpuSec: number, o: Partial<ProcSample> = {}): ProcSample => ({ pid, uid: 501, rssKb: 1000, cpuSec, start: START, comm: SIM, ...o })
const fresh = (): LoadState => ({ procs: {}, offered: [] })
const calm: SystemSample = { swapUsedBytes: 7e9, pressure: 2, thermal: 0 }

test('config: unusable values fall back, ignore is trimmed strings', () => {
  expect(resolveRunawayConfig()).toEqual(cfg)
  expect(resolveRunawayConfig({ cpuPercent: 'x', hours: -1, swapGb: 0, ignore: 'nope' })).toEqual(cfg)
  expect(resolveRunawayConfig({ cpuPercent: 50, hours: '3', ignore: [' Foo ', '', 7] })).toEqual({ cpuPercent: 50, hours: 3, swapGb: 20, ignore: ['Foo', '7'] })
})

test('parseCpuTime reads ps time formats', () => {
  expect(parseCpuTime('655:44.54')).toBeCloseTo(39344.54)
  expect(parseCpuTime('02:03:04')).toBe(7384)
  expect(parseCpuTime('1-00:00:01')).toBe(86401)
  expect(parseCpuTime('garbage')).toBeUndefined()
})

test('parsePs keeps padded days and comm spaces, skips junk', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/Frameworks/Helper/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)'
  const out = [
    '    1     0  16384 355:39.46 Sun Oct  4 09:38:37 2026     /sbin/launchd',
    `  900   501 400000  12:00.10 Wed Oct 21 22:52:53 2026     ${chrome}`,
    'not a process line',
  ].join('\n')
  const got = parsePs(out)
  expect(got).toHaveLength(2)
  expect(got[0]!.start).toBe(Math.floor(Date.parse('Sun Oct  4 09:38:37 2026') / 1000))
  expect(got[1]!.comm).toBe(chrome)
  expect(got[1]).toMatchObject({ pid: 900, uid: 501, rssKb: 400000, cpuSec: 720.1 })
})

test('procLabel names the helper and its app', () => {
  expect(procLabel(SIM)).toBe('Simulator')
  expect(procLabel('/Applications/Google Chrome.app/x/Google Chrome Helper (Renderer)')).toBe('Google Chrome Helper (Renderer) (Google Chrome)')
  expect(procLabel('/usr/bin/yes')).toBe('yes')
})

test('parseSwap reads used in 1024 units', () => {
  expect(parseSwap('total = 8192.00M  used = 7290.25M  free = 901.75M  (encrypted)')).toBe(7290.25 * 1048576)
  expect(parseSwap('used = 1.50G')).toBe(1.5 * 1073741824)
  expect(parseSwap('nothing')).toBeUndefined()
})

/** Samples every 10 minutes, `rate` CPU-seconds gained per interval. */
function run(st: LoadState, from: number, to: number, rate: number, o: Partial<ProcSample> = {}, c = cfg) {
  const alerts: { at: number; text: string; buttons: { label: string; data: string }[] }[] = []
  for (let m = from; m <= to; m += 10) {
    for (const a of assessLoad([proc(10, 100 + (m / 10) * rate, o)], calm, st, c, T0 + m * MIN, me)) alerts.push({ at: m, ...a })
  }
  return alerts
}

test('a process hot for two hours gets one line with a quit button, then never again', () => {
  const st = fresh()
  expect(run(st, 0, 110, 1800)).toEqual([])
  const got = run(st, 120, 180, 1800)
  expect(got).toHaveLength(1)
  expect(got[0]!.at).toBe(120)
  expect(got[0]!.text).toBe('Simulator at 300% CPU for 2h.')
  expect(got[0]!.buttons[0]!.data).toBe(`quit pid 10 ${START}`)
  expect(QUIT_RE.test(got[0]!.buttons[0]!.data)).toBe(true)
  expect(Buffer.byteLength(got[0]!.buttons[0]!.data)).toBeLessThanOrEqual(60)
  expect(st.offered).toContain(`10:${START}`)
})

test('streaks break on a cool interval or a long gap; the first sample alerts nothing', () => {
  // hot to 100 min, one cold interval at 110, hot again: the two hours start over at 110
  const st = fresh()
  let cpu = 100
  const at: number[] = []
  for (let m = 0; m <= 240; m += 10) {
    cpu += m === 110 ? 60 : 1800
    if (assessLoad([proc(10, cpu)], calm, st, cfg, T0 + m * MIN, me).length) at.push(m)
  }
  expect(at).toEqual([230])
  // a 40-minute gap drops the streak entirely
  const st2 = fresh()
  run(st2, 0, 100, 1800)
  expect(assessLoad([proc(10, 100 + 14 * 1800)], calm, st2, cfg, T0 + 140 * MIN, me)).toEqual([])
  expect(st2.procs[`10:${START}`]!.hotSince).toBeUndefined()
  expect(assessLoad([proc(11, 999999)], calm, fresh(), cfg, T0, me)).toEqual([])
})

test('a new start on the same pid is a fresh process', () => {
  const st = fresh()
  run(st, 0, 110, 1800)
  const a = assessLoad([proc(10, 1e6, { start: START + 5 })], calm, st, cfg, T0 + 120 * MIN, me)
  expect(a).toEqual([])
})

test('other users, protected pids and ignored names are never flagged', () => {
  for (const [o, p, c] of [
    [{ uid: 0 }, me, cfg],
    [{}, { uid: 501, protect: [10] }, cfg],
    [{}, me, { ...cfg, ignore: ['simulator'] }],
  ] as [Partial<ProcSample>, typeof me, typeof cfg][]) {
    const st = fresh()
    let n = 0
    for (let m = 0; m <= 180; m += 10) n += assessLoad([proc(10, 100 + (m / 10) * 1800, o)], calm, st, c, T0 + m * MIN, p).length
    expect(n).toBe(0)
  }
})

test('swap: critical pressure for 20 min names the biggest process, then waits a day', () => {
  const st = fresh()
  const procs = [proc(1, 0, { rssKb: 2_000_000, comm: '/usr/bin/small' }), proc(2, 0, { rssKb: 8_000_000 }), proc(3, 0, { uid: 0, rssKb: 99_000_000 })]
  const hot: SystemSample = { swapUsedBytes: 9e9, pressure: 4, thermal: 0 }
  expect(assessLoad(procs, hot, st, cfg, T0, me)).toEqual([])
  expect(assessLoad(procs, hot, st, cfg, T0 + 10 * MIN, me)).toEqual([])
  const a = assessLoad(procs, hot, st, cfg, T0 + 20 * MIN, me)
  expect(a).toHaveLength(1)
  expect(a[0]!.text).toBe("memory's tight: 9.0 GB in swap, pressure critical, for 20 min. biggest: Simulator at 8.2 GB.")
  expect(a[0]!.buttons[0]!.data).toBe(`quit pid 2 ${START}`)
  expect(st.offered).toContain(`2:${START}`)
  // still hot six hours on: cooldown
  for (let m = 30; m <= 360; m += 10) expect(assessLoad(procs, hot, st, cfg, T0 + m * MIN, me)).toEqual([])
  // cleared, then hot again 25 h after the first alert
  assessLoad(procs, calm, st, cfg, T0 + 370 * MIN, me)
  const day = T0 + 25 * 60 * MIN
  expect(assessLoad(procs, hot, st, cfg, day - 10 * MIN, me)).toEqual([])
  assessLoad(procs, hot, st, cfg, day, me)
  expect(assessLoad(procs, hot, st, cfg, day + 20 * MIN, me)).toHaveLength(1)
})

test('swap: the biggest is by footprint, so a paged-out leak is still named', () => {
  const st = fresh()
  const leak = '/Applications/Leaky Notes.app/Contents/MacOS/LeakyNotes'
  // RSS says the leak is tiny (it's in swap); top's footprint says 20 GB.
  const procs = [proc(1, 0, { rssKb: 600_000, comm: '/usr/bin/claude' }), proc(2, 0, { rssKb: 50_000, comm: leak })]
  const hot: SystemSample = { swapUsedBytes: 21e9, pressure: 2, footprintKb: { 1: 650_000, 2: 20 * 1024 ** 2 } }
  assessLoad(procs, hot, st, cfg, T0, me)
  const a = assessLoad(procs, hot, st, cfg, T0 + 20 * MIN, me)
  expect(a[0]!.text).toContain('biggest: LeakyNotes (Leaky Notes) at 21.5 GB')
  expect(a[0]!.buttons[0]!.data).toBe(`quit pid 2 ${START}`)
})

test('top rows parse to KB', () => {
  expect(parseTopMem('PID    MEM\n96302  20G\n4719   1483M+\n12 512K-\n')).toEqual({ 96302: 20 * 1024 ** 2, 4719: 1483 * 1024, 12: 512 })
})

test('swap still tight two days on is not raised again until it clears', () => {
  const st = fresh()
  const big: SystemSample = { swapUsedBytes: 21e9, pressure: 2 }
  let n = 0
  for (let m = 0; m <= 48 * 60; m += 10) n += assessLoad([], big, st, cfg, T0 + m * MIN, me).length
  expect(n).toBe(1)
})

test('swap over the line alone fires; warn pressure with normal swap never does', () => {
  const st = fresh()
  const big: SystemSample = { swapUsedBytes: 21e9, pressure: 2 }
  assessLoad([], big, st, cfg, T0, me)
  const a = assessLoad([], big, st, cfg, T0 + 20 * MIN, me)
  expect(a).toHaveLength(1)
  expect(a[0]!.buttons).toEqual([])
  expect(a[0]!.text).toBe("memory's tight: 21.0 GB in swap, for 20 min.")
  const st2 = fresh()
  let n = 0
  for (let m = 0; m <= 600; m += 10) n += assessLoad([], { swapUsedBytes: 7e9, pressure: 2 }, st2, cfg, T0 + m * MIN, me).length
  expect(n).toBe(0)
})

test('thermal: serious for 20 min, hottest named only when it is really busy', () => {
  const hot: SystemSample = { thermal: 2 }
  const st = fresh()
  const busy = (m: number) => [proc(10, 100 + (m / 10) * 3000)]
  for (const m of [0, 10]) assessLoad(busy(m), hot, st, cfg, T0 + m * MIN, me)
  const a = assessLoad(busy(20), hot, st, cfg, T0 + 20 * MIN, me)
  expect(a).toHaveLength(1)
  expect(a[0]!.text).toBe('the Mac is throttling (thermal serious) for 20 min. hottest: Simulator at 500% CPU.')
  expect(a[0]!.buttons).toHaveLength(1)
  const st2 = fresh()
  const idle = (m: number) => [proc(10, 100 + (m / 10) * 60)]
  for (const m of [0, 10]) assessLoad(idle(m), { thermal: 3 }, st2, cfg, T0 + m * MIN, me)
  const b = assessLoad(idle(20), { thermal: 3 }, st2, cfg, T0 + 20 * MIN, me)
  expect(b[0]!.text).toBe('the Mac is throttling (thermal critical) for 20 min.')
  expect(b[0]!.buttons).toEqual([])
})

function fakes(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  return {
    calls,
    o: {
      uid: 501, protect: [5], offered: [`10:${START}`],
      read: async () => ({ uid: 501, start: START, comm: SIM }),
      kill: (pid: number, sig: string) => { calls.push(`${sig} ${pid}`) },
      alive: () => false,
      wait: async () => {},
      ...over,
    },
  }
}

test('quitProcess refuses everything it did not offer or cannot vouch for', async () => {
  let f = fakes({ offered: [] })
  expect(await quitProcess(10, START, f.o as never)).toContain("wasn't one i made")
  f = fakes()
  expect(await quitProcess(5, START, { ...f.o, offered: [`5:${START}`] } as never)).toContain('part of me')
  expect(await quitProcess(1, START, { ...f.o, offered: [`1:${START}`] } as never)).toContain('part of me')
  f = fakes({ read: async () => undefined })
  expect(await quitProcess(10, START, f.o as never)).toBe('10 already gone.')
  f = fakes({ read: async () => ({ uid: 501, start: START + 1, comm: SIM }) })
  expect(await quitProcess(10, START, f.o as never)).toContain('something else now')
  f = fakes({ read: async () => ({ uid: 0, start: START, comm: SIM }) })
  expect(await quitProcess(10, START, f.o as never)).toContain('not yours')
  expect(f.calls).toEqual([])
})

test('quitProcess: TERM when it leaves, KILL when it ignores', async () => {
  let f = fakes()
  expect(await quitProcess(10, START, f.o as never)).toBe('quit Simulator.')
  expect(f.calls).toEqual(['SIGTERM 10'])
  f = fakes({ alive: () => true })
  expect(await quitProcess(10, START, f.o as never)).toBe('Simulator ignored quit — force-killed it.')
  expect(f.calls).toEqual(['SIGTERM 10', 'SIGKILL 10'])
  // The pid was reused while it waited: no SIGKILL for the newcomer.
  let reads = 0
  f = fakes({ alive: () => true, read: async () => ({ uid: 501, start: reads++ ? START + 9 : START, comm: SIM }) })
  expect(await quitProcess(10, START, f.o as never)).toBe('quit Simulator.')
  expect(f.calls).toEqual(['SIGTERM 10'])
})

test('loadStatus', () => {
  expect(loadStatus(fresh(), T0).verdict).toBe('unknown')
  const ok: LoadState = { ...fresh(), at: T0, sys: { swapUsedBytes: 7.3e9, pressure: 2, thermal: 0 } }
  const up = loadStatus(ok, T0 + MIN)
  expect(up.verdict).toBe('up')
  expect(up.detail).toBe('swap 7.3 GB, pressure warn, thermal nominal')
  expect(loadStatus({ ...ok, swapHotSince: T0 }, T0 + MIN).verdict).toBe('degraded')
  expect(loadStatus(ok, T0 + 31 * MIN).verdict).toBe('degraded')
  const hot = loadStatus({ ...ok, procs: { a: { name: 'x', cpuSec: 1, rssKb: 1, at: T0, hotSince: T0 } } }, T0)
  expect(hot.detail).toContain('1 process over the CPU line')
})

test('state round-trips, and a corrupt file reads as empty', () => {
  const f = join(tmp, 'runaway.json')
  const st: LoadState = { ...fresh(), at: T0, offered: ['1:2'] }
  saveLoadState(f, st)
  expect(loadLoadState(f)).toEqual(st)
  writeFileSync(f, '{nope')
  expect(peekLoadState(f)).toEqual(fresh())
  expect(loadLoadState(f)).toEqual(fresh())
})
