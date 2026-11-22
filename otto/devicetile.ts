import { randomBytes } from 'crypto'
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { SENSITIVE_TEXT } from './browsertile.ts'
import { shrinkScreenshot } from './livesteps.ts'

/**
 * The app's live tile for an iOS Simulator or Android emulator being driven, in the browser
 * tile's frame (browsertile.ts) so the app needs no change:
 *
 *   { type: "browser", image, caption: "iPhone 18 Pro · tapping", url: "", ts, source: "device" }
 *   { type: "browser", done: true }
 *
 * Who drives: Otto through Bash (agent-device or `xcrun simctl`/`adb`), and T3 Code threads through
 * T3's device tools, which Otto's hooks never see. So activity comes from agent-device's own session
 * logs (events.ndjson and requests/*.ndjson under each session dir, for the CLI's state dir and
 * T3's), polled once a second, with Otto's PostToolUse Bash hook as the fast path. While a session
 * is active, the booted device it drives is screenshotted from outside (simctl io / adb screencap),
 * never through the session itself. At most one frame a second; done after `idle` ms with no new
 * activity, or when Otto's turn ends if the driving was its own.
 *
 * Privacy: the logs hold no screen text. Only Otto's own Bash output (an agent-device snapshot)
 * can show a password or card screen; that hides the picture until a later snapshot reads clean
 * or the tile ends. A T3 thread on such a screen still gets mirrored, as the browser tile does
 * with a page it never read.
 */

export type Device = { id: string; name: string; os: 'ios' | 'android' }
export type Activity = { at: number; session: string; dir: string }

const MAX_BYTES = 80_000
const SAME_CALL = 2000  // a log write this close to Otto's Bash call is that call's own
const VERBS: Record<string, string> = {
  press: 'tapping', click: 'tapping', tap: 'tapping', longpress: 'long-pressing', fill: 'typing', type: 'typing',
  scroll: 'scrolling', swipe: 'swiping', gesture: 'swiping', fling: 'swiping', pan: 'swiping', snapshot: 'looking',
  screenshot: 'looking', io: 'looking', get: 'looking', find: 'looking', wait: 'waiting', open: 'opening an app',
  launch: 'opening an app', openurl: 'opening a link', close: 'closing an app', terminate: 'closing an app',
  home: 'going home', back: 'going back', settings: 'changing settings', boot: 'starting up', install: 'installing an app',
}
// An invocation, not a mention: `ls ~/.agent-device` or `grep agent-device` don't open a tile.
const DRIVE = /(?:^|[;&|\n(]|\$\()\s*(?:\w+=\S*\s+)*(?:(?:node|bun)\s+)?(?:\S*\/)?(agent-device(?:\.mjs)?|xcrun\s+simctl|adb)\s([^;&|\n)]*)/
const READ_ONLY = new Set(['list', 'devices', 'help', 'version', 'h'])

export const roots = (home = homedir()) => [
  join(home, '.agent-device', 'sessions'),
  join(home, '.t3', 'userdata', 'device', 'agent-device', 'sessions'),
]

/** What a Bash command does to a device: the verb and the platform it names, or null when it drives none. */
export function driving(command: string): { verb: string; os?: Device['os'] } | null {
  const m = command.match(DRIVE)
  if (!m) return null
  // The subcommand is the first known word: flags and their values come before it.
  const word = m[2].split(/\s+/).map(w => w.replace(/^-+/, '')).find(w => READ_ONLY.has(w) || w in VERBS)
  if (word && READ_ONLY.has(word)) return null
  const os = m[1].startsWith('xcrun') ? 'ios' : m[1] === 'adb' ? 'android' : undefined
  return { verb: (word && VERBS[word]) || 'driving', os }
}

function mtime(p: string): number {
  try { return statSync(p).mtimeMs } catch { return 0 }
}

/**
 * The newest agent-device activity under these session roots. Per session, the newer of
 * events.ndjson (a line per request start and finish) and requests/*.ndjson (sparse, but it
 * keeps growing during a long request, when events go quiet).
 */
export function latestActivity(dirs: string[]): Activity | null {
  let best: Activity | null = null
  for (const root of dirs) {
    let names: string[]
    try { names = readdirSync(root) } catch { continue }
    for (const session of names) {
      const dir = join(root, session)
      let at = mtime(join(dir, 'events.ndjson'))
      // ponytail: stats every request log of every old session each second; prune by dir mtime if they pile up.
      try { for (const f of readdirSync(join(dir, 'requests'))) at = Math.max(at, mtime(join(dir, 'requests', f))) } catch {}
      if (at && (!best || at > best.at)) best = { at, session, dir }
    }
  }
  return best
}

function tail(path: string, bytes = 4096): string {
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const buf = Buffer.alloc(Math.min(bytes, size))
      readSync(fd, buf, 0, buf.length, size - buf.length)
      return buf.toString('utf8')
    } finally { closeSync(fd) }
  } catch { return '' }
}

/** The session's id, last command and whether its recent log names a password or card, from its events tail. */
export function sessionInfo(dir: string): { id: string; verb: string; sensitive: boolean } {
  const text = tail(join(dir, 'events.ndjson'))
  let id = '', verb = 'driving'
  for (const line of text.split('\n').reverse()) {
    try {
      const e = JSON.parse(line) as { session?: string; command?: string }
      id ||= e.session ?? ''
      if (e.command) { verb = VERBS[e.command] ?? 'driving'; break }
    } catch {}
  }
  return { id, verb, sensitive: SENSITIVE_TEXT.test(text) }
}

/** The device a session holds: its claim in agent-device's claims dir, else the deviceId its request log names. */
export function sessionDevice(dir: string, session: string, claims = join(homedir(), '.agent-device', 'device-claims')): string | null {
  try {
    for (const f of readdirSync(claims)) {
      try {
        const c = JSON.parse(readFileSync(join(claims, f), 'utf8')) as { session?: string; device?: { id?: string } }
        if (session && c.session === session && c.device?.id) return c.device.id
      } catch {}
    }
  } catch {}
  let newest = '', at = 0
  try {
    for (const f of readdirSync(join(dir, 'requests'))) {
      const m = mtime(join(dir, 'requests', f))
      if (m > at) { at = m; newest = f }
    }
  } catch {}
  if (!newest) return null
  return [...tail(join(dir, 'requests', newest), 64_000).matchAll(/"deviceId":"([^"]+)"/g)].pop()?.[1] ?? null
}

/** Which booted device to show: the named one, else the only booted one (of the hinted platform). Null when it can't be told. */
export function pick(booted: Device[], id: string | null, os?: Device['os']): Device | null {
  if (id) return booted.find(d => d.id === id) ?? null
  const pool = os ? booted.filter(d => d.os === os) : booted
  return pool.length === 1 ? pool[0] : null
}

async function run(cmd: string[]): Promise<Buffer | null> {
  try {
    const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', timeout: 5000 })
    const out = Buffer.from(await new Response(p.stdout).arrayBuffer())
    return (await p.exited) === 0 ? out : null
  } catch { return null }
}

/** Booted simulators and emulators. adb is optional. */
export async function bootedDevices(): Promise<Device[]> {
  const out: Device[] = []
  try {
    const j = JSON.parse(String(await run(['xcrun', 'simctl', 'list', 'devices', 'booted', '-j']) ?? '{}')) as { devices?: Record<string, { udid: string; name: string; state: string }[]> }
    for (const list of Object.values(j.devices ?? {})) for (const d of list) if (d.state === 'Booted') out.push({ id: d.udid, name: d.name, os: 'ios' })
  } catch {}
  if (!Bun.which('adb')) return out
  for (const line of String(await run(['adb', 'devices']) ?? '').split('\n')) {
    const [serial, state] = line.trim().split(/\s+/)
    if (state !== 'device') continue
    const avd = String(await run(['adb', '-s', serial, 'emu', 'avd', 'name']) ?? '').split('\n')[0].trim()
    out.push({ id: serial, name: avd ? avd.replace(/_/g, ' ') : 'Android', os: 'android' })
  }
  return out
}

/** A JPEG of the device's screen, base64, at most 600 px tall; null when it can't be had. */
export async function captureDevice(d: Device): Promise<string | null> {
  let png: Buffer | null
  if (d.os === 'android') png = await run(['adb', '-s', d.id, 'exec-out', 'screencap', '-p'])
  else {
    const tmp = join(tmpdir(), `otto-device-${randomBytes(4).toString('hex')}.png`)
    try { png = (await run(['xcrun', 'simctl', 'io', d.id, 'screenshot', tmp])) ? readFileSync(tmp) : null } catch { png = null } finally { rmSync(tmp, { force: true }) }
  }
  return png?.length ? shrinkScreenshot(png.toString('base64'), 600) : null
}

type Tile = { image: string | null; caption: string; url: string; ts: number; source: 'device' }

export class DeviceTile {
  private seen = 0            // newest activity ever seen: old activity never re-arms the tile
  private fileAt = 0          // latest activity from the session logs, this tile
  private hookAt = 0          // latest driving seen in Otto's own Bash, this tile
  private session: { dir: string; id: string; verb: string; sensitive: boolean } | null = null
  private hook: { verb: string; os?: Device['os'] } | null = null
  private hookSensitive = false
  private tile: Tile | null = null
  private booted: { at: number; list: Device[] } | null = null
  private lastSent = -Infinity
  private busy = false
  private gen = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private send: (frame: string) => void,
    private opts: {
      gap?: number; idle?: number; now?: () => number
      scan?: () => Activity | null
      info?: (dir: string) => { id: string; verb: string; sensitive: boolean }
      deviceOf?: (dir: string, session: string) => string | null
      devices?: () => Promise<Device[]>
      capture?: (d: Device) => Promise<string | null>
    } = {},
  ) {}

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), this.opts.gap ?? 1000)
    this.timer.unref?.()
  }

  /** Otto's own Bash call, from PostToolUse: the fast path, and the only place a sensitive screen can show. */
  bash(command: string, response: unknown): void {
    const d = driving(command)
    if (!d) return
    const out = typeof response === 'string' ? response : JSON.stringify(response ?? '')
    if (SENSITIVE_TEXT.test(out)) this.hookSensitive = true
    else if (/\bsnapshot\b/.test(command)) this.hookSensitive = false
    this.hook = d
    this.hookAt = this.now()
    void this.tick()
  }

  /** Otto's turn ended: the tile ends too, unless a session Otto didn't drive moved since. */
  turnEnded(): void {
    if (this.tile && this.hookAt >= this.fileAt - SAME_CALL) this.finish()
  }

  async tick(): Promise<void> {
    const now = this.now(), idle = this.opts.idle ?? 20_000
    const a = (this.opts.scan ?? (() => latestActivity(roots())))()
    if (a && a.at > this.seen) {
      this.seen = a.at
      if (now - a.at < idle) {
        this.fileAt = a.at
        this.session = { dir: a.dir, ...(this.opts.info ?? sessionInfo)(a.dir) }
      }
    }
    const last = Math.max(this.fileAt, this.hookAt)
    if (!last) return
    if (now - last >= idle) return this.finish()
    if (this.busy || now - this.lastSent < (this.opts.gap ?? 1000) - 50) return
    this.busy = true
    const gen = this.gen
    try {
      // Otto's own call wins when it is the newer; the session log still names the device when it moved with it.
      const own = !!this.hook && this.hookAt >= this.fileAt
      const s = this.session && this.fileAt >= this.hookAt - SAME_CALL ? this.session : null
      const id = s ? (this.opts.deviceOf ?? sessionDevice)(s.dir, s.id) : null
      const os = own ? this.hook!.os : s && (/android/i.test(s.id) ? 'android' : /ios/i.test(s.id) ? 'ios' : undefined)
      const device = pick(await this.devices(), id, os || undefined)
      if (!device || gen !== this.gen) return
      const verb = (own ? this.hook?.verb : this.session?.verb) ?? 'driving'
      const caption = `${device.name} · ${verb}`.slice(0, 100)
      const hidden = () => this.hookSensitive || !!this.session?.sensitive
      let image: string | null = null
      if (!hidden()) {
        const jpeg = await (this.opts.capture ?? captureDevice)(device)
        // Skipped silently: a failed or oversized capture, the tile ended, or the screen turned sensitive meanwhile.
        if (!jpeg || jpeg.length * 0.75 > MAX_BYTES || gen !== this.gen || hidden()) return
        image = `data:image/jpeg;base64,${jpeg}`
      } else if (this.tile && !this.tile.image && this.tile.caption === caption) return
      this.tile = { image, caption, url: '', ts: this.now(), source: 'device' }
      this.lastSent = this.now()
      this.send(JSON.stringify({ type: 'browser', ...this.tile }))
    } finally { this.busy = false }
  }

  finish(): void {
    const had = !!this.tile
    this.gen++
    this.tile = this.session = this.hook = null
    this.fileAt = this.hookAt = 0
    this.hookSensitive = false
    if (had) this.send(JSON.stringify({ type: 'browser', done: true }))
  }

  /** The live tile, for a socket that just connected; null when there is none. */
  snapshot(): string | null {
    return this.tile ? JSON.stringify({ type: 'browser', ...this.tile }) : null
  }

  private now(): number { return (this.opts.now ?? Date.now)() }

  /** Re-listed every 10 s while a tile is live: booting and shutting down are rare. */
  private async devices(): Promise<Device[]> {
    if (!this.booted || this.now() - this.booted.at > 10_000) this.booted = { at: this.now(), list: await (this.opts.devices ?? bootedDevices)() }
    return this.booted.list
  }
}
