/**
 * The runaway-process whisper.
 *
 * A build that never exits, a simulator left spinning, a browser tab in a loop:
 * the Mac gets hot and slow for hours and nobody notices until the fan does.
 * Every ten minutes the channel samples the user's own processes (`ps`), swap
 * and kernel memory pressure (`sysctl`) and the thermal state (NSProcessInfo),
 * and writes only when a line is crossed. The text is final: no model.
 *
 * Three lines:
 *  - a process averaging over `cpuPercent` for `hours` straight: once per
 *    process, ever (keyed by pid + start time, so a reused pid is a new one);
 *  - swap past `swapGb`, or critical memory pressure, for 20 minutes;
 *  - the Mac throttling (thermal serious or critical) for 20 minutes.
 * The last two once per streak, and at most once a day. Pressure level 2 (warn) with a few GB of
 * swap is this machine's normal, so only level 4 counts: anything lower would
 * fire daily.
 *
 * A sample gap longer than 30 minutes (sleep, Otto down) breaks every streak:
 * nothing can be vouched for across it.
 *
 * [quit it] kills by saved pid and start time, and only for a process this
 * module offered a button for: macOS pkill once took out the user's apps, so
 * nothing here ever kills by name, pattern or process group.
 *
 * On Linux only the per-process CPU line runs (procps `ps -eo`); swap, memory
 * pressure and thermal state are macOS probes and stay unread there.
 *
 * ps, sysctl, kill and the clock are parameters, so the tests never touch the machine.
 */

import { run } from './workspace.ts'
import { loadState, saveState } from './statefile.ts'

export type RunawayConfig = { cpuPercent: number; hours: number; swapGb: number; ignore: string[] }

export const DEFAULT_RUNAWAY: RunawayConfig = { cpuPercent: 80, hours: 2, swapGb: 20, ignore: [] }

/** Config comes from a hand-edited JSON file: anything unusable falls back to the default. */
export function resolveRunawayConfig(raw?: { cpuPercent?: unknown; hours?: unknown; swapGb?: unknown; ignore?: unknown } | null): RunawayConfig {
  const pick = (k: 'cpuPercent' | 'hours' | 'swapGb'): number => {
    const v = Number(raw?.[k])
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_RUNAWAY[k]
  }
  const ignore = Array.isArray(raw?.ignore) ? raw.ignore.map(s => String(s).trim()).filter(Boolean) : []
  return { cpuPercent: pick('cpuPercent'), hours: pick('hours'), swapGb: pick('swapGb'), ignore }
}

export type ProcSample = { pid: number; uid: number; rssKb: number; cpuSec: number; start: number; comm: string }

export const PS_ARGS = ['ps', process.platform === 'darwin' ? '-axo' : '-eo', 'pid=,uid=,rss=,time=,lstart=,comm=']

const LSTART = String.raw`(\w{3} \w{3}\s+\d{1,2} \d\d:\d\d:\d\d \d{4})`
const PS_LINE = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+${LSTART}\s+(.+)$`)
const PS_ONE = new RegExp(String.raw`^\s*(\d+)\s+${LSTART}\s+(.+)$`)

/** `[dd-][hh:]mm:ss[.xx]` to seconds; macOS prints `655:44.54`, minutes past 59 included. */
export function parseCpuTime(s: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s)
  if (!m) return undefined
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

const epoch = (lstart: string): number => Math.floor(Date.parse(lstart) / 1000)

export function parsePs(out: string): ProcSample[] {
  const procs: ProcSample[] = []
  for (const line of out.split('\n')) {
    const m = PS_LINE.exec(line)
    if (!m) continue
    const cpuSec = parseCpuTime(m[4]!)
    const start = epoch(m[5]!)
    if (cpuSec === undefined || !Number.isFinite(start)) continue
    procs.push({ pid: Number(m[1]), uid: Number(m[2]), rssKb: Number(m[3]), cpuSec, start, comm: m[6]!.trimEnd() })
  }
  return procs
}

/** LC_ALL=C keeps lstart English whatever locale the session runs in. */
export async function readProcs(): Promise<ProcSample[]> {
  return parsePs(await run(PS_ARGS, undefined, 5000, { LC_ALL: 'C' }) ?? '')
}

/** Basename, plus the outer app's name when it differs (a browser's helper process). */
export function procLabel(comm: string): string {
  const base = comm.split('/').pop() || comm
  const app = /\/([^/]+)\.app\//.exec(comm)?.[1]
  return app && app !== base ? `${base} (${app})` : base
}

/** footprintKb: the biggest processes by footprint (resident + compressed + swapped), pid → KB. */
export type SystemSample = { swapUsedBytes?: number; pressure?: number; thermal?: number; footprintKb?: Record<number, number> }

/** `top -l 1 -o mem -stats pid,mem` rows ("96302  20G", "4719 1483M+") as pid → KB. */
export function parseTopMem(s: string): Record<number, number> {
  const out: Record<number, number> = {}
  for (const line of s.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)([KMGB])\b/.exec(line)
    if (m) out[Number(m[1])] = Number(m[2]) * ({ B: 1 / 1024, K: 1, M: 1024, G: 1024 ** 2 } as Record<string, number>)[m[3]!]!
  }
  return out
}

const UNIT: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }

/** `used = 7290.25M` out of `sysctl vm.swapusage`, in bytes. */
export function parseSwap(s: string): number | undefined {
  const m = /used\s*=\s*([\d.]+)([KMG])/.exec(s)
  return m ? Number(m[1]) * UNIT[m[2]!]! : undefined
}

/** Any probe that fails leaves its field undefined; never throws. */
export async function readSystem(): Promise<SystemSample> {
  if (process.platform !== 'darwin') return {}
  // sysctl's absolute path: it is not on PATH in the session's shell.
  const [sysctl, thermal, top] = await Promise.all([
    run(['/usr/sbin/sysctl', '-n', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level'], undefined, 5000),
    run(['osascript', '-l', 'JavaScript', '-e', "ObjC.import('Foundation'); $.NSProcessInfo.processInfo.thermalState"], undefined, 5000),
    // ps's RSS misses whatever is swapped out, so a leaking app that has been paged out looks tiny.
    run(['/usr/bin/top', '-l', '1', '-o', 'mem', '-n', '10', '-stats', 'pid,mem'], undefined, 8000),
  ])
  const footprint = top ? parseTopMem(top) : {}
  const [swap, pressure] = (sysctl ?? '').split('\n')
  const num = (s?: string): number | undefined => (s?.trim() ? (Number.isFinite(Number(s)) ? Number(s) : undefined) : undefined)
  return {
    ...(swap && parseSwap(swap) !== undefined ? { swapUsedBytes: parseSwap(swap)! } : {}),
    ...(num(pressure) !== undefined ? { pressure: num(pressure)! } : {}),
    ...(num(thermal) !== undefined ? { thermal: num(thermal)! } : {}),
    ...(Object.keys(footprint).length ? { footprintKb: footprint } : {}),
  }
}

export type ProcEntry = { name: string; cpuSec: number; rssKb: number; at: number; pct?: number; hotSince?: number; cpuAtHot?: number; told?: boolean }
export type LoadState = {
  at?: number
  /** `${pid}:${start}` to its last sample. */
  procs: Record<string, ProcEntry>
  sys?: SystemSample
  swapHotSince?: number
  swapToldAt?: number
  thermalHotSince?: number
  thermalToldAt?: number
  /** Keys a [quit it] button was made for. */
  offered: string[]
}

const emptyLoad = (): LoadState => ({ procs: {}, offered: [] })
const validLoad = (x: unknown): boolean => !!x && typeof x === 'object' && !!(x as LoadState).procs && typeof (x as LoadState).procs === 'object' && Array.isArray((x as LoadState).offered)
export const loadLoadState = (file: string): LoadState => loadState(file, emptyLoad, validLoad)
export const peekLoadState = (file: string): LoadState => loadState(file, emptyLoad, validLoad, { peek: true })
export const saveLoadState = (file: string, s: LoadState): void => saveState(file, s)

export const GAP_MS = 30 * 60_000
export const SYS_HOT_MS = 20 * 60_000
export const SYS_COOLDOWN_MS = 24 * 3_600_000
export const OFFERED_MAX = 50

export type LoadAlert = { kind: 'cpu' | 'swap' | 'thermal'; text: string; buttons: { label: string; data: string }[] }

export const quitButton = (pid: number, start: number) => ({ label: 'quit it', data: `quit pid ${pid} ${start}` })
export const QUIT_RE = /^quit pid (\d+) (\d+)$/

const gb = (b: number): string => (b / 1e9).toFixed(1)

/** Mutates `state`; the caller saves it. */
export function assessLoad(procs: ProcSample[], sys: SystemSample, state: LoadState, cfg: RunawayConfig, now: number, o: { uid: number; protect: number[] }): LoadAlert[] {
  const alerts: LoadAlert[] = []
  const broken = !state.at || now - state.at > GAP_MS
  const ignore = cfg.ignore.map(s => s.toLowerCase())
  const next: Record<string, ProcEntry> = {}
  const eligible: { key: string; p: ProcSample; e: ProcEntry }[] = []

  for (const p of procs) {
    if (p.uid !== o.uid || o.protect.includes(p.pid)) continue
    const name = procLabel(p.comm)
    if (ignore.some(i => name.toLowerCase().includes(i))) continue
    const key = `${p.pid}:${p.start}`
    const prev = state.procs[key]
    const dt = prev ? (now - prev.at) / 1000 : 0
    const pct = prev && !broken && dt > 0 ? (p.cpuSec - prev.cpuSec) / dt * 100 : undefined
    const hot = pct !== undefined && pct >= cfg.cpuPercent
    const e: ProcEntry = { name, cpuSec: p.cpuSec, rssKb: p.rssKb, at: now, ...(pct !== undefined ? { pct } : {}) }
    if (hot) { e.hotSince = prev!.hotSince ?? prev!.at; e.cpuAtHot = prev!.cpuAtHot ?? prev!.cpuSec }
    if (prev?.told) e.told = true
    if (hot && !e.told && now - e.hotSince! >= cfg.hours * 3_600_000) {
      const avg = (p.cpuSec - e.cpuAtHot!) / ((now - e.hotSince!) / 1000) * 100
      alerts.push({
        kind: 'cpu',
        text: `${name} at ${Math.round(avg / 10) * 10}% CPU for ${Math.floor((now - e.hotSince!) / 3_600_000)}h.`,
        buttons: [quitButton(p.pid, p.start)],
      })
      e.told = true
      state.offered.push(key)
    }
    next[key] = e
    eligible.push({ key, p, e })
  }

  // A streak that starts on a broken sample starts at that sample.
  const streak = (hot: boolean, since?: number): number | undefined => (hot ? (broken ? now : since ?? now) : undefined)
  // Once per streak (a told streak waits until it clears), and a flapping one still at most once a day.
  const sysAlert = (since: number | undefined, toldAt: number | undefined): boolean =>
    since !== undefined && now - since >= SYS_HOT_MS && (!toldAt || (toldAt < since && now - toldAt >= SYS_COOLDOWN_MS))
  const mins = (since: number) => Math.floor((now - since) / 60_000)

  const swapHot = (sys.pressure ?? 0) >= 4 || (sys.swapUsedBytes ?? 0) >= cfg.swapGb * 1e9
  state.swapHotSince = streak(swapHot, state.swapHotSince)
  if (sysAlert(state.swapHotSince, state.swapToldAt)) {
    // By footprint where top gave one: it counts the swapped-out pages that RSS leaves out.
    const size = (x: typeof eligible[number]) => sys.footprintKb?.[x.p.pid] ?? x.p.rssKb
    const big = eligible.reduce<typeof eligible[number] | undefined>((a, b) => (!a || size(b) > size(a) ? b : a), undefined)
    alerts.push({
      kind: 'swap',
      text: `memory's tight: ${gb(sys.swapUsedBytes ?? 0)} GB in swap${sys.pressure === 4 ? ', pressure critical' : ''}, for ${mins(state.swapHotSince!)} min.`
        + (big ? ` biggest: ${big.e.name} at ${gb(size(big) * 1024)} GB.` : ''),
      buttons: big ? [quitButton(big.p.pid, big.p.start)] : [],
    })
    if (big) state.offered.push(big.key)
    state.swapToldAt = now
  }

  const thermalHot = (sys.thermal ?? 0) >= 2
  state.thermalHotSince = streak(thermalHot, state.thermalHotSince)
  if (sysAlert(state.thermalHotSince, state.thermalToldAt)) {
    const hottest = eligible.reduce<typeof eligible[number] | undefined>((a, b) => (!a || (b.e.pct ?? 0) > (a.e.pct ?? 0) ? b : a), undefined)
    const named = hottest && (hottest.e.pct ?? 0) >= 50 ? hottest : undefined
    alerts.push({
      kind: 'thermal',
      text: `the Mac is throttling (thermal ${sys.thermal! >= 3 ? 'critical' : 'serious'}) for ${mins(state.thermalHotSince!)} min.`
        + (named ? ` hottest: ${named.e.name} at ${Math.round(named.e.pct!)}% CPU.` : ''),
      buttons: named ? [quitButton(named.p.pid, named.p.start)] : [],
    })
    if (named) state.offered.push(named.key)
    state.thermalToldAt = now
  }

  state.procs = next
  state.at = now
  state.sys = sys
  state.offered = state.offered.slice(-OFFERED_MAX)
  return alerts
}

type Probe = { uid: number; start: number; comm: string }

async function readOne(pid: number): Promise<Probe | undefined> {
  const m = PS_ONE.exec(await run(['ps', '-o', 'uid=,lstart=,comm=', '-p', String(pid)], undefined, 3000, { LC_ALL: 'C' }) ?? '')
  return m ? { uid: Number(m[1]), start: epoch(m[2]!), comm: m[3]!.trimEnd() } : undefined
}

const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

/** SIGTERM, then SIGKILL if it is still there 5 s later. Only a process this module offered, checked by pid and start. */
export async function quitProcess(pid: number, start: number, o: {
  uid: number
  protect: number[]
  offered: string[]
  read?: (pid: number) => Promise<Probe | undefined>
  kill?: (pid: number, sig: NodeJS.Signals) => void
  alive?: (pid: number) => boolean
  wait?: (ms: number) => Promise<void>
}): Promise<string> {
  const { read = readOne, kill = (p, s) => process.kill(p, s), alive = isAlive, wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms)) } = o
  if (!o.offered.includes(`${pid}:${start}`)) return "that button wasn't one i made — left it alone."
  if (pid <= 1 || o.protect.includes(pid)) return "that's part of me — left it alone."
  const now = await read(pid)
  if (!now) return `${pid} already gone.`
  if (now.start !== start) return "that pid is something else now — left it alone."
  if (now.uid !== o.uid) return 'not yours to quit — left it alone.'
  const name = procLabel(now.comm)
  try { kill(pid, 'SIGTERM') } catch { return `${pid} already gone.` }
  for (let i = 0; i < 20; i++) {
    await wait(250)
    if (!alive(pid)) return `quit ${name}.`
  }
  // Same pid and start again before the hard kill: never SIGKILL a pid that was reused meanwhile.
  if ((await read(pid))?.start !== start) return `quit ${name}.`
  try { kill(pid, 'SIGKILL') } catch { return `quit ${name}.` }
  return `${name} ignored quit — force-killed it.`
}

const PRESSURE: Record<number, string> = { 1: 'normal', 2: 'warn', 4: 'critical' }
const THERMAL = ['nominal', 'fair', 'serious', 'critical']

export function loadStatus(state: LoadState, now: number): { verdict: 'up' | 'degraded' | 'unknown'; at?: number; detail: string } {
  if (!state.at) return { verdict: 'unknown', detail: 'not sampled yet (every 10 min)' }
  const hotProcs = Object.values(state.procs).filter(e => e.hotSince).length
  const sys = state.sys ?? {}
  const detail = `swap ${sys.swapUsedBytes === undefined ? '?' : gb(sys.swapUsedBytes)} GB, pressure ${PRESSURE[sys.pressure ?? 0] ?? '?'}, thermal ${THERMAL[sys.thermal ?? -1] ?? '?'}`
    + (hotProcs ? `; ${hotProcs} process${hotProcs === 1 ? '' : 'es'} over the CPU line` : '')
  const stale = now - state.at > GAP_MS
  return { verdict: stale || state.swapHotSince || state.thermalHotSince ? 'degraded' : 'up', at: state.at, detail }
}
