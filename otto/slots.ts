/**
 * Build slots: heavy work lines up instead of landing together.
 *
 * On 10 Nov two full test suites and a release build started at once, swap ran
 * out and the Mac froze. Every heavy command goes through this wrapper instead:
 *
 *   bun otto/slots.ts run --name <label> [--notify] -- <cmd...>
 *
 * It takes one of `slots.max` machine-wide lanes (default 1), then also waits
 * while the Mac is loaded: critical memory pressure, swap past runaway.ts's
 * `swapGb`, or a 1-minute load average past `slots.load` (default: core count).
 * Then it runs the command and exits with its exit code.
 *
 * A lane is a file in `<state>/slots/`, created with link() so exactly one
 * process wins it. It names its holder by pid and start time: a holder that died
 * without cleaning up (kill -9, a crash, a reboot) is reclaimed by the next waiter.
 *
 * `--notify` is for a build the user asked for: when it waited over 5 minutes,
 * one normal-priority line goes out as it starts, through a notice file the
 * channel drains on its 30 s tick. Nothing else is ever messaged.
 *
 * Process start times, the load sample, the clock and sleep are parameters, so
 * the tests never depend on the machine.
 */

import { linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { availableParallelism, constants, homedir, loadavg } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { run } from './workspace.ts'
import { readSystem, resolveRunawayConfig } from './runaway.ts'

const STATE_DIR = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
export const SLOTS_DIR = join(STATE_DIR, 'slots')
export const NOTIFY_AFTER_MS = 5 * 60_000

export type SlotsConfig = { max: number; load: number; swapGb: number }

/** From access.json: `slots: { max, load }`, plus runaway's swap line. Anything unusable falls back. */
export function resolveSlotsConfig(access: { slots?: { max?: unknown; load?: unknown }; runaway?: { swapGb?: unknown } } | null | undefined): SlotsConfig {
  const pos = (v: unknown, d: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
  return {
    max: Math.floor(pos(access?.slots?.max, 1)) || 1,
    load: pos(access?.slots?.load, availableParallelism()),
    swapGb: resolveRunawayConfig(access?.runaway).swapGb,
  }
}

export type SlotWaiter = { pid: number; start: number; cwd: string; since: string; to: string | null; token: string }

type Holder = { pid: number; start: number; name: string; at: number; token: string }

/** A pid's start time (epoch seconds), or undefined when no such process is running. */
export async function procStart(pid: number): Promise<number | undefined> {
  const out = (await run(['ps', '-o', 'lstart=', '-p', String(pid)], undefined, 5000, { LC_ALL: 'C' }))?.trim()
  const t = out ? Date.parse(out) : NaN
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined
}

/** Why the Mac is too loaded to start something heavy, or undefined when it isn't. */
export async function loadSample(cfg: SlotsConfig): Promise<string | undefined> {
  const sys = await readSystem()
  if ((sys.pressure ?? 0) >= 4) return 'memory pressure is critical'
  if (sys.swapUsedBytes !== undefined && sys.swapUsedBytes > cfg.swapGb * 1024 ** 3) return `swap at ${(sys.swapUsedBytes / 1024 ** 3).toFixed(1)} GB`
  const la = loadavg()[0]!
  if (la > cfg.load) return `load average ${la.toFixed(1)}`
  return undefined
}

export type SlotDeps = {
  dir: string
  max: number
  /** Start time of a running pid; undefined = gone. */
  start: (pid: number) => Promise<number | undefined>
  /** A reason the machine is too loaded, or undefined. */
  busy: () => Promise<string | undefined>
  sleep: (ms: number) => Promise<void>
  now: () => number
  pollMs?: number
  log?: (line: string) => void
}

const readHolder = (file: string): Holder | undefined => {
  try { return JSON.parse(readFileSync(file, 'utf8')) as Holder } catch { return undefined }
}

/** Try every lane once; reclaim a dead holder's. Returns the lane file held, or undefined. */
async function tryAcquire(me: Holder, d: SlotDeps): Promise<string | undefined> {
  mkdirSync(d.dir, { recursive: true })
  const tmp = join(d.dir, `.tmp-${me.token}`)
  writeFileSync(tmp, JSON.stringify(me))
  try {
    for (let i = 0; i < d.max; i++) {
      const lane = join(d.dir, `slot-${i}.json`)
      try { linkSync(tmp, lane); return lane } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
      const h = readHolder(lane)
      // ponytail: two waiters reclaiming the same dead lane in the same instant could both win; a per-lane flock would close it.
      if (!h || (await d.start(h.pid)) !== h.start) {
        d.log?.(`slots: reclaiming lane ${i} from ${h ? `${h.name} (pid ${h.pid}, gone)` : 'an unreadable lock'}`)
        try { unlinkSync(lane) } catch {}
        try { linkSync(tmp, lane); return lane } catch {}
      }
    }
    return undefined
  } finally { try { unlinkSync(tmp) } catch {} }
}

/** Unlink a lane only while it is still ours. */
export function release(lane: string, token: string): void {
  if (readHolder(lane)?.token === token) try { unlinkSync(lane) } catch {}
}

/** Waits for a lane and a calm machine. Returns the lane held and how long it waited. */
export async function acquire(name: string, d: SlotDeps, pid = process.pid): Promise<{ lane: string; token: string; waitedMs: number }> {
  const t0 = d.now()
  const start = await d.start(pid)
  const me: Holder = { pid, start: start ?? 0, name, at: t0, token: randomBytes(8).toString('hex') }
  let lane: string | undefined
  let said = ''
  const waiter: SlotWaiter = { pid, start: me.start, cwd: process.cwd(), since: new Date(t0).toISOString(), to: null, token: me.token }
  const waitingFile = join(d.dir, `wait-${me.token}.json`)
  let waited = false
  for (;;) {
    lane ??= await tryAcquire(me, d)
    // Holding the lane while load is high keeps the next heavy job queued behind this one.
    const why = lane ? await d.busy() : 'every lane is taken'
    if (lane && !why) {
      if (waited) writeFileSync(waitingFile, JSON.stringify({ ...waiter, to: new Date(d.now()).toISOString() }))
      return { lane, token: me.token, waitedMs: d.now() - t0 }
    }
    if (!waited) { writeFileSync(waitingFile, JSON.stringify(waiter)); waited = true }
    if (why !== said) d.log?.(`slots: ${name} waiting: ${why}`)
    said = why!
    await d.sleep(d.pollMs ?? 15_000)
  }
}

export const noticeText = (name: string, waitedMs: number): string =>
  `load's down. starting ${name} now (waited ${Math.round(waitedMs / 60_000)} min).`

/** The channel's side: notices left by `--notify` runs, removed as they are read (lose one, never repeat one). */
export function drainNotices(dir = SLOTS_DIR): string[] {
  let names: string[]
  try { names = readdirSync(dir).filter(n => n.startsWith('notice-')).sort() } catch { return [] }
  const out: string[] = []
  for (const n of names) {
    const f = join(dir, n)
    try { const t = readFileSync(f, 'utf8').trim(); unlinkSync(f); if (t) out.push(t) } catch {}
  }
  return out
}

/** Runs `cmd` in a lane; resolves to its exit code (128+signal when killed). */
export async function runInSlot(name: string, cmd: string[], d: SlotDeps, o: { notify?: boolean } = {}): Promise<number> {
  const { lane, token, waitedMs } = await acquire(name, d)
  const onSig = (sig: NodeJS.Signals) => () => { if (child) child.kill(sig); else { release(lane, token); process.exit(sig === 'SIGINT' ? 130 : 143) } }
  let child: ReturnType<typeof Bun.spawn> | undefined
  const handlers = { SIGINT: onSig('SIGINT'), SIGTERM: onSig('SIGTERM') }
  for (const [s, h] of Object.entries(handlers)) process.on(s, h)
  try {
    if (o.notify && waitedMs > NOTIFY_AFTER_MS) {
      writeFileSync(join(d.dir, `notice-${d.now()}-${token}.txt`), noticeText(name, waitedMs))
    }
    child = Bun.spawn(cmd, { stdio: ['inherit', 'inherit', 'inherit'] })
    const code = await child.exited
    return child.signalCode ? 128 + (constants.signals[child.signalCode as NodeJS.Signals] ?? 0) : code
  } finally {
    for (const [s, h] of Object.entries(handlers)) process.off(s, h)
    release(lane, token)
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const sep = argv.indexOf('--')
  const flags = sep < 0 ? argv : argv.slice(0, sep)
  const cmd = sep < 0 ? [] : argv.slice(sep + 1)
  const ni = flags.indexOf('--name')
  if (flags[0] !== 'run' || !cmd.length) {
    console.error('usage: bun otto/slots.ts run --name <label> [--notify] -- <cmd...>')
    process.exit(2)
  }
  let access: Parameters<typeof resolveSlotsConfig>[0]
  try { access = JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8')) } catch {}
  const cfg = resolveSlotsConfig(access)
  const code = await runInSlot(ni >= 0 && flags[ni + 1] ? flags[ni + 1]! : cmd.join(' ').slice(0, 60), cmd, {
    dir: SLOTS_DIR, max: cfg.max, start: procStart, busy: () => loadSample(cfg),
    sleep: ms => Bun.sleep(ms), now: Date.now, log: l => console.error(l),
  }, { notify: flags.includes('--notify') })
  process.exit(code)
}

/** Completed waits survive a poll gap; dead waiters stop at the time they are discovered. */
export async function readSlotWaiters(dir = SLOTS_DIR, start = procStart, now = Date.now()): Promise<SlotWaiter[]> {
  let files: string[]
  try { files = readdirSync(dir).filter(n => n.startsWith('wait-')) } catch { return [] }
  const rows = await Promise.all(files.map(async n => {
    const file = join(dir, n)
    try {
      const w = JSON.parse(readFileSync(file, 'utf8')) as SlotWaiter
      if (!w.cwd || !Number.isFinite(Date.parse(w.since)) || !w.token || !Number.isInteger(w.pid)) return undefined
      if (!w.to && await start(w.pid) !== w.start) {
        w.to = new Date(now).toISOString()
        writeFileSync(file, JSON.stringify(w))
      }
      if (w.to && now - Date.parse(w.to) > 7 * 86400_000) { unlinkSync(file); return undefined }
      return w
    } catch { return undefined }
  }))
  return rows.filter((w): w is SlotWaiter => !!w).sort((a, b) => a.since.localeCompare(b.since) || a.token.localeCompare(b.token))
}

export async function slotSnapshot(stateDir = STATE_DIR) {
  let access: Parameters<typeof resolveSlotsConfig>[0]
  try { access = JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf8')) } catch {}
  const cfg = resolveSlotsConfig(access)
  const waiters = await readSlotWaiters(join(stateDir, 'slots'))
  return { waiters, mac: { load: loadavg()[0]!, limit: cfg.load, waiting: waiters.filter(w => !w.to).length } }
}
