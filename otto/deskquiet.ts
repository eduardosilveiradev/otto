/**
 * A focused desktop app or an open live talk quiets the phone.
 *
 * The Mac app talks to /app like the phone does, with its own device token, and
 * reports focus over that socket:
 *
 *   app -> otto  { "type": "presence", "focused": true | false }
 *
 * on every focus change, and again every minute while focused (the heartbeat).
 * Send { "type": "activity" } on real keyboard, pointer or touch activity in the
 * desktop app (may throttle while active; send immediately on resuming). No ack.
 * Focus gains and outgoing messages also count as activity;
 * repeated same-focus heartbeats never extend the activity clock.
 * A socket's first presence report is not activity: a reconnect, a server reload
 * or an app launch reports focused:true without anyone touching the Mac. That
 * first report carries over the device's last activity from an earlier socket
 * (kept in memory per device token), or none after a server boot, so the desktop
 * stays idle until an activity frame, a sent message or a focus gain.
 * The server counts a desktop as present only while all of these hold: its
 * socket is open, its last report said focused, that report is under
 * PRESENCE_TTL_MS old, its last activity is under DESKTOP_IDLE_MS old, and its
 * device's switch on the settings page is on. A crash closes the socket. Sleep
 * or a shut lid stops the heartbeat, which expires after two minutes.
 *
 * While a desktop is present, ordinary phone-bound alerts are suppressed: the message
 * frame and its history row carry `quiet: true`, so the phone app posts no
 * banner from either its live socket (the silent-audio keepalive) or its
 * background refresh, and no Bark push goes out. The message itself still lands
 * in the thread on every device.
 *
 * Phone messages and foreground actions clear desktop activity, open talk quiet and talk
 * grace. For two minutes afterward, focus changes alone cannot restore quiet. Explicit
 * desktop input still counts. A talk that was overridden stays quiet-disabled on its
 * socket until stopped, and a quick reconnect cannot restore it by replaying talk.start.
 * desk-quiet.json keeps the last 128 decisions and transitions without message content.
 *
 * Goes through anyway (never quiet): OTP codes (the fast lane), reply with
 * `critical: true`, and reply with `bark: true` — Otto's "must not be missed"
 * mark, for reminders the user set and security alerts.
 *
 * Suppression is final for those messages: focus ending never replays alerts.
 * The durable quiet marker keeps reconnects and history catch-up silent too.
 * Only messages arriving after presence ends notify the phone.
 */

import { basename } from 'path'
import { loadState, saveState } from './statefile.ts'
import { TALK_SILENCE_MS } from './talk.ts'

export const PRESENCE_TTL_MS = 2 * 60_000

export const DESKTOP_IDLE_MS = 10 * 60_000

const PHONE_HOLD_MS = 2 * 60_000
export const DESK_QUIET_LOG_LIMIT = 128

export type DeskInput = 'activity' | 'message' | 'share' | 'tap' | 'react' | 'approval' | 'stop' | 'pip_button'
  | 'http.ask' | 'http.photo' | 'http.voice' | 'http.file' | 'http.dictate' | 'http.message' | 'http.pip_button'

type ActivitySource = 'activity' | 'message' | 'focus' | 'reconnect'
type QuietReason =
  | { reason: 'desktop'; device: string; activityAgeMs: number; presenceAgeMs: number; activitySource?: ActivitySource }
  | { reason: 'talk' | 'talk-grace'; device: string }
type QuietEvent = QuietReason | { event: string; device: string; frame: string; fromDevice?: string }

export type Presence = { focused: boolean; at: number; activeAt: number; source?: ActivitySource }

const shortDevice = (tokenId: string) => tokenId.slice(0, 6)

/** Heartbeats prove connectivity, not user activity. */
export function desktopActive(d: Presence | undefined, now: number, ttl = PRESENCE_TTL_MS): boolean {
  return !!d?.focused && d.activeAt > 0 && now - d.at < ttl && now - d.activeAt < DESKTOP_IDLE_MS
}
/** The slice of a Bun websocket this needs; tests pass plain objects. */
export type DeskSocket = { data: { tokenId: string; desk?: Presence } }

export class DeskQuiet {
  private activeDesks = new Set<DeskSocket>()
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Device tokens that have reported presence since boot: the settings page lists them. */
  readonly seen = new Set<string>()
  /** Last real activity per device token, so a reconnect resumes it instead of resetting it. */
  private lastActive = new Map<string, number>()
  /** Talk lasts across turns. Zero marks a talk the phone user has overridden. */
  private talks = new Map<DeskSocket, number>()
  private talkGrace?: { token: string; until: number }
  private phoneAt = -Infinity
  private overriddenTalks = new Set<string>()
  private recent?: Array<QuietEvent & { at: string }>
  private now: () => number
  private ttl: number

  constructor(private o: {
    sockets: () => Iterable<DeskSocket>
    /** The device's switch on the settings page. */
    enabled: (tokenId: string) => boolean
    log?: (line: string) => void
    logFile?: string
    now?: () => number
    /** Tests only. */
    ttlMs?: number
  }) {
    this.now = o.now ?? Date.now
    this.ttl = o.ttlMs ?? PRESENCE_TTL_MS
  }

  present(): boolean {
    const now = this.now()
    for (const ws of this.o.sockets()) {
      const d = ws.data.desk
      if (desktopActive(d, now, this.ttl) && this.o.enabled(ws.data.tokenId)) return true
    }
    return false
  }

  private record(event: QuietEvent): void {
    const file = this.o.logFile
    if (!file) return
    const recent = this.recent ??= loadState<NonNullable<DeskQuiet['recent']>>(file, () => [], Array.isArray)
    recent.push({ at: new Date(this.now()).toISOString(), ...event })
    if (recent.length > DESK_QUIET_LOG_LIMIT) recent.splice(0, recent.length - DESK_QUIET_LOG_LIMIT)
    try { saveState(file, recent) } catch { this.o.log?.(`could not write ${basename(file)}`) }
  }

  talkActivity(socket: DeskSocket, frame: 'talk.ready' | 'talk.audio' = 'talk.ready'): void {
    const now = this.now()
    const until = this.talks.get(socket)
    if (until === 0 || (frame === 'talk.audio' && !(until && until > now))) return
    const token = socket.data.tokenId
    if (now - this.phoneAt < PHONE_HOLD_MS &&
        (this.overriddenTalks.has(token) || (this.seen.has(token) && (this.lastActive.get(token) ?? 0) < this.phoneAt))) return
    this.talks.set(socket, now + DESKTOP_IDLE_MS)
    if (!until || until <= now) {
      if (until) this.record({ event: 'talk.end', device: shortDevice(token), frame: 'expiry' })
      this.record({ event: 'talk.start', device: shortDevice(token), frame })
      this.check(frame)
    }
  }

  endTalk(socket: DeskSocket, frame: 'talk.stop' | 'socket.close' | 'token.revoked' = 'talk.stop'): void {
    const until = this.talks.get(socket) ?? 0
    this.talks.delete(socket)
    const now = this.now()
    if (until > 0) this.record({ event: 'talk.end', device: shortDevice(socket.data.tokenId), frame: until > now ? frame : 'expiry' })
    if (until > now) {
      const device = shortDevice(socket.data.tokenId)
      this.endGrace(frame)
      this.talkGrace = { token: socket.data.tokenId, until: now + TALK_SILENCE_MS }
      this.record({ event: 'talk-grace.start', device, frame })
    }
    this.check(frame)
  }

  private endGrace(frame: string): void {
    if (!this.talkGrace) return
    this.record({ event: 'talk-grace.end', device: shortDevice(this.talkGrace.token), frame })
    this.talkGrace = undefined
  }

  private reason(): QuietReason | undefined {
    const now = this.now()
    if (this.talkGrace && this.talkGrace.until > now) return { reason: 'talk-grace', device: shortDevice(this.talkGrace.token) }
    for (const [socket, until] of this.talks) {
      if (until > now) return { reason: 'talk', device: shortDevice(socket.data.tokenId) }
    }
    for (const { data } of this.o.sockets()) {
      const d = data.desk
      if (d && desktopActive(d, now, this.ttl) && this.o.enabled(data.tokenId)) {
        return { reason: 'desktop', device: shortDevice(data.tokenId), activityAgeMs: now - d.activeAt,
          presenceAgeMs: now - d.at, activitySource: d.source }
      }
    }
  }

  suppressesPhone(): boolean { return !!this.reason() }

  recordSuppression(): QuietReason['reason'] | undefined {
    const reason = this.reason()
    if (reason) this.record(reason)
    return reason?.reason
  }

  /** Only fresh user actions call this. Background reads, retries and Wallet reports do not. */
  input(token: string, frame: DeskInput, ws?: DeskSocket): void {
    if (ws?.data.desk || this.seen.has(token)) {
      if (frame === 'activity' || frame === 'message' || frame === 'http.message') {
        const now = this.now()
        this.lastActive.set(token, now)
        for (const socket of ws ? [ws] : this.o.sockets()) {
          if (socket.data.tokenId === token && socket.data.desk) {
            Object.assign(socket.data.desk, { activeAt: now, source: frame === 'activity' ? 'activity' : 'message' })
          }
        }
        this.check(frame)
      }
      return
    }
    const now = this.now()
    if (now - this.phoneAt >= PHONE_HOLD_MS) this.overriddenTalks.clear()
    this.phoneAt = now
    this.lastActive.clear()  // Includes desktops whose sockets are closed.
    for (const d of this.o.sockets()) if (d.data.desk) Object.assign(d.data.desk, { activeAt: 0, source: undefined })
    for (const [socket, until] of this.talks) {
      if (until <= now) continue
      this.overriddenTalks.add(socket.data.tokenId)
      this.talks.set(socket, 0)
      this.record({ event: 'talk.end', device: shortDevice(socket.data.tokenId), frame, fromDevice: shortDevice(token) })
    }
    if (this.talkGrace && this.talkGrace.until > now) this.overriddenTalks.add(this.talkGrace.token)
    this.endGrace(frame)
    this.check(frame, token)
  }

  /** A desktop socket is not the phone: Bark and "is the phone live" skip it. */
  static isDesk(ws: DeskSocket): boolean { return !!ws.data.desk }

  /** Handles presence and activity. User ops are observed after deduplication in appFrame. */
  frame(ws: DeskSocket, raw: string): boolean {
    let f: { type?: unknown; focused?: unknown }
    try { f = JSON.parse(raw) } catch { return false }
    if (f?.type === 'activity') {
      this.input(ws.data.tokenId, 'activity', ws)
      return true
    }
    if (f?.type !== 'presence') return false
    if (typeof f.focused !== 'boolean') return true
    const now = this.now()
    const previous = ws.data.desk
    // at:0 seeds a known desktop that hasn't sent its first presence report.
    const first = !previous || previous.at === 0
    let activeAt = first ? this.lastActive.get(ws.data.tokenId) ?? 0 : previous.activeAt
    let source = first ? (previous?.source ?? (activeAt ? 'reconnect' : undefined)) : previous.source
    if (!first && f.focused && !previous.focused && now - this.phoneAt >= PHONE_HOLD_MS) {
      activeAt = now
      source = 'focus'
      this.lastActive.set(ws.data.tokenId, now)
    }
    ws.data.desk = { focused: f.focused, at: now, activeAt, source }
    this.seen.add(ws.data.tokenId)
    this.check('presence')
    return true
  }

  /** Re-evaluate after frames, disconnects, settings changes and elapsed deadlines. */
  check(frame = 'expiry', fromDevice?: string): void {
    const now = this.now()
    let next = Infinity
    const active = new Set<DeskSocket>()
    for (const ws of this.o.sockets()) {
      const d = ws.data.desk
      if (!d || !desktopActive(d, now, this.ttl) || !this.o.enabled(ws.data.tokenId)) continue
      active.add(ws)
      next = Math.min(next, d.at + this.ttl, d.activeAt + DESKTOP_IDLE_MS)
      if (!this.activeDesks.has(ws)) this.record({ event: 'desktop.start', device: shortDevice(ws.data.tokenId), frame })
    }
    for (const ws of this.activeDesks) {
      if (!active.has(ws)) this.record({ event: 'desktop.end', device: shortDevice(ws.data.tokenId), frame,
        ...(fromDevice ? { fromDevice: shortDevice(fromDevice) } : {}) })
    }
    if (!!active.size !== !!this.activeDesks.size) this.o.log?.(`desktop focus ${active.size ? 'on: phone alerts suppressed' : 'off: phone alerts back'}`)
    this.activeDesks = active
    for (const [ws, until] of this.talks) {
      if (!until) continue
      if (until <= now) {
        this.talks.delete(ws)
        this.record({ event: 'talk.end', device: shortDevice(ws.data.tokenId), frame: 'expiry' })
      } else next = Math.min(next, until)
    }
    if (this.talkGrace) {
      if (this.talkGrace.until <= now) this.endGrace('expiry')
      else next = Math.min(next, this.talkGrace.until)
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (next === Infinity) return
    this.timer = setTimeout(() => this.check(), next - now + 50)
    this.timer.unref?.()
  }
}
