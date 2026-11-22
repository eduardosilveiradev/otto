import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { test, expect } from 'bun:test'
import { DeskQuiet, DESK_QUIET_LOG_LIMIT, PRESENCE_TTL_MS, DESKTOP_IDLE_MS, desktopActive, type DeskSocket } from '../deskquiet.ts'
import { TALK_SILENCE_MS } from '../talk.ts'

/** Fake sockets and a hand-turned clock. */
function rig(o: { off?: string[]; logFile?: string } = {}) {
  let now = 1_000_000
  const sockets = new Set<DeskSocket>()
  const q = new DeskQuiet({
    sockets: () => sockets,
    enabled: id => !(o.off ?? []).includes(id),
    now: () => now,
    logFile: o.logFile,
  })
  const open = (tokenId: string) => { const ws: DeskSocket = { data: { tokenId } }; sockets.add(ws); return ws }
  const close = (ws: DeskSocket) => { sockets.delete(ws); q.check() }
  const focus = (ws: DeskSocket, focused: boolean) => expect(q.frame(ws, JSON.stringify({ type: 'presence', focused }))).toBe(true)
  const active = (ws: DeskSocket) => expect(q.frame(ws, '{"type":"activity"}')).toBe(true)
  /** A desktop socket the way server.ts opens one for a known desktop. */
  const reopen = (tokenId: string) => { const ws: DeskSocket = { data: { tokenId, desk: { focused: false, at: 0, activeAt: 0 } } }; sockets.add(ws); return ws }
  return {
    q, sockets, open, reopen, close, focus, active,
    tick: (ms: number) => { now += ms },
  }
}

test('talk quiet lasts across sockets, expires when idle, and gives a closing talk two seconds', () => {
  const { q, open, tick } = rig()
  const first = open('first'), second = open('second')
  q.talkActivity(first)
  q.talkActivity(second)
  q.endTalk(first)
  tick(TALK_SILENCE_MS)
  expect(q.suppressesPhone()).toBe(true)
  q.endTalk(second)
  tick(TALK_SILENCE_MS - 1)
  expect(q.suppressesPhone()).toBe(true)
  tick(1)
  expect(q.suppressesPhone()).toBe(false)

  q.talkActivity(first)
  tick(DESKTOP_IDLE_MS)
  expect(q.suppressesPhone()).toBe(false)
  q.endTalk(first)
  expect(q.suppressesPhone()).toBe(false)
})

test('a focused desktop is present; unfocused, closed or never reporting is not', () => {
  const r = rig()
  const phone = r.open('phone1')
  expect(r.q.present()).toBe(false)
  const mac = r.open('mac1')
  expect(r.q.present()).toBe(false)   // open but silent: an old desktop build
  r.focus(mac, true)
  expect(r.q.present()).toBe(false)   // connecting focused isn't activity
  r.active(mac)
  expect(r.q.present()).toBe(true)
  expect(DeskQuiet.isDesk(mac)).toBe(true)
  expect(DeskQuiet.isDesk(phone)).toBe(false)
  r.focus(mac, false)
  expect(r.q.present()).toBe(false)
  expect(DeskQuiet.isDesk(mac)).toBe(true)   // still a desktop for Bark's "is the phone open"
  r.focus(mac, true)
  r.close(mac)
  expect(r.q.present()).toBe(false)
})

test('the heartbeat keeps it present; a lapsed one (sleep, lid shut) ends it', () => {
  const r = rig()
  const mac = r.open('mac1')
  r.focus(mac, true)
  r.active(mac)
  r.tick(PRESENCE_TTL_MS - 1000)
  r.focus(mac, true)   // the heartbeat
  r.tick(PRESENCE_TTL_MS - 1000)
  expect(r.q.present()).toBe(true)
  r.tick(2000)
  expect(r.q.present()).toBe(false)
})

test('the lapse is noticed on its own without replaying alerts', async () => {
  const sockets = new Set<DeskSocket>()
  const logs: string[] = []
  const q = new DeskQuiet({ sockets: () => sockets, enabled: () => true, log: l => logs.push(l), ttlMs: 60 })
  const mac: DeskSocket = { data: { tokenId: 'mac1' } }
  sockets.add(mac)
  q.frame(mac, JSON.stringify({ type: 'presence', focused: true }))
  q.frame(mac, '{"type":"activity"}')
  expect(q.present()).toBe(true)
  await Bun.sleep(200)
  expect(q.present()).toBe(false)
  expect(logs.at(-1)).toBe('desktop focus off: phone alerts back')
})

test('the device switch: a desktop switched off never quiets the phone', () => {
  const r = rig({ off: ['mac1'] })
  const mac = r.open('mac1')
  r.focus(mac, true)
  r.active(mac)
  expect(r.q.present()).toBe(false)
  const other = r.open('mac2')
  r.focus(other, true)
  r.active(other)
  expect(r.q.present()).toBe(true)
  expect([...r.q.seen].sort()).toEqual(['mac1', 'mac2'])
})

test('blur, disconnect, expiry and disabling a desktop affect only new notifications', () => {
  for (const end of ['blur', 'disconnect', 'expiry', 'disabled']) {
    const off: string[] = []
    const r = rig({ off })
    const mac = r.open('mac1')
    const pushes: string[] = []
    const send = (text: string) => { if (!r.q.present()) pushes.push(text) }
    r.focus(mac, true)
    r.active(mac)
    for (const text of ['one', 'two', 'three']) send(text)
    if (end === 'blur') r.focus(mac, false)
    if (end === 'disconnect') r.close(mac)
    if (end === 'expiry') { r.tick(PRESENCE_TTL_MS + 1); r.q.check() }
    if (end === 'disabled') { off.push('mac1'); r.q.check() }
    expect(pushes).toEqual([])
    send('after focus')
    expect(pushes).toEqual(['after focus'])
  }
})

test('anything that is not a well-formed presence frame is left alone', () => {
  const r = rig()
  const ws = r.open('mac1')
  expect(r.q.frame(ws, JSON.stringify({ type: 'message', id: 'x', text: 'hi' }))).toBe(false)
  expect(r.q.frame(ws, 'not json')).toBe(false)
  expect(r.q.frame(ws, JSON.stringify({ type: 'presence', focused: 'yes' }))).toBe(true)   // swallowed, not a message
  expect(r.q.present()).toBe(false)
  expect(DeskQuiet.isDesk(ws)).toBe(false)
})

test('ten idle minutes restore phone alerts despite uninterrupted focus heartbeats', () => {
  const r = rig()
  const mac = r.open('mac1')
  const pushes: string[] = []
  const send = (text: string) => { if (!r.q.present()) pushes.push(text) }
  r.focus(mac, true)
  r.active(mac)
  send('active')
  for (let i = 0; i < 9; i++) { r.tick(60_000); r.focus(mac, true) }
  r.tick(60_000 - 1)
  r.focus(mac, true)
  send('just under')
  expect(pushes).toEqual([])
  r.tick(1)
  send('idle')
  expect(pushes).toEqual(['idle'])
  expect(DeskQuiet.isDesk(mac)).toBe(true) // idle desktops still are not phones
  expect(r.q.frame(mac, '{"type":"activity"}')).toBe(true)
  send('active again')
  expect(pushes).toEqual(['idle'])
  r.close(mac)
  send('disconnected')
  expect(pushes).toEqual(['idle', 'disconnected'])
})

test('legacy desktop messages and focus changes reset activity; heartbeats do not', () => {
  const r = rig()
  const mac = r.open('mac1')
  r.focus(mac, true)
  r.tick(DESKTOP_IDLE_MS)
  r.focus(mac, true)
  expect(r.q.present()).toBe(false)
  r.q.input(mac.data.tokenId, 'message', mac)
  expect(r.q.present()).toBe(true)
  r.tick(DESKTOP_IDLE_MS)
  r.focus(mac, false)
  r.focus(mac, true)
  expect(r.q.present()).toBe(true)
})

test('activity does not turn a phone into a desktop or override focus and heartbeat expiry', () => {
  const r = rig()
  const phone = r.open('phone1')
  r.q.frame(phone, '{"type":"activity"}')
  expect(DeskQuiet.isDesk(phone)).toBe(false)
  expect(r.q.present()).toBe(false)
  expect(desktopActive(undefined, 0)).toBe(false)
  expect(desktopActive({ focused: false, at: 0, activeAt: 0 }, 0)).toBe(false)
  expect(desktopActive({ focused: true, at: 0, activeAt: PRESENCE_TTL_MS }, PRESENCE_TTL_MS)).toBe(false)
})

test('a reconnect or app launch reporting focus is not activity', () => {
  const r = rig()
  const mac = r.open('mac1')
  r.focus(mac, true)
  r.active(mac)
  expect(r.q.present()).toBe(true)
  r.tick(DESKTOP_IDLE_MS + 60_000)
  r.close(mac)
  // The server reloads or the network blips: the new socket opens focused, nobody touched the Mac.
  const again = r.reopen('mac1')
  r.focus(again, true)
  expect(r.q.present()).toBe(false)
  r.tick(60_000)
  r.focus(again, true)   // heartbeats still don't count
  expect(r.q.present()).toBe(false)
  // A device never seen since boot (a reload wipes memory) starts idle too.
  const fresh = r.reopen('mac2')
  r.focus(fresh, true)
  expect(r.q.present()).toBe(false)
})

test('a reconnect resumes recent activity instead of resetting it', () => {
  const r = rig()
  const mac = r.open('mac1')
  r.focus(mac, true)
  r.active(mac)
  r.tick(60_000)
  r.close(mac)
  const again = r.reopen('mac1')
  r.focus(again, true)
  expect(r.q.present()).toBe(true)
  r.tick(DESKTOP_IDLE_MS - 60_000)   // ten minutes since the real activity, not since the reconnect
  r.focus(again, true)
  expect(r.q.present()).toBe(false)
})

test('after a reconnect, a real activity frame or a focus change on the live socket counts', () => {
  const r = rig()
  const a = r.reopen('mac1')
  r.focus(a, true)
  expect(r.q.present()).toBe(false)
  r.active(a)
  expect(r.q.present()).toBe(true)
  r.close(a)
  r.tick(DESKTOP_IDLE_MS + 1)
  const b = r.reopen('mac1')
  r.focus(b, true)
  expect(r.q.present()).toBe(false)
  r.focus(b, false)
  r.focus(b, true)   // a genuine refocus on a socket already reporting
  expect(r.q.present()).toBe(true)
})

test('a message from the phone ends desktop quiet at once', () => {
  const r = rig()
  const mac = r.open('mac1')
  const phone = r.open('phone1')
  r.focus(mac, true)
  r.active(mac)
  expect(r.q.present()).toBe(true)
  r.q.input(phone.data.tokenId, 'message', phone)
  expect(r.q.present()).toBe(false)
  r.focus(mac, true)   // a heartbeat from the still-focused Mac doesn't bring it back
  expect(r.q.present()).toBe(false)
  r.active(mac)        // touching the Mac again does
  expect(r.q.present()).toBe(true)
})

test('phone input clears desktop activity even if the desktop disconnected first', () => {
  const r = rig()
  const mac = r.open('mac1')
  r.focus(mac, true)
  r.active(mac)
  r.close(mac)
  r.q.input('phone1', 'http.voice')
  const again = r.reopen('mac1')
  r.focus(again, true)
  expect(r.q.suppressesPhone()).toBe(false)
})

test('focus flips cannot steal the handoff, but desktop activity and messages can', () => {
  const r = rig()
  const mac = r.open('mac1')
  r.focus(mac, true)
  r.active(mac)
  r.q.input('phone1', 'tap')
  r.tick(10_000)
  r.focus(mac, false)
  r.focus(mac, true)
  expect(r.q.suppressesPhone()).toBe(false)
  r.q.input(mac.data.tokenId, 'message', mac)
  expect(r.q.suppressesPhone()).toBe(true)
  r.q.input('phone1', 'react')
  r.tick(PRESENCE_TTL_MS)
  r.focus(mac, false)
  r.focus(mac, true)
  expect(r.q.suppressesPhone()).toBe(true)
})

test('audio cannot start talk quiet or restore it after phone input, stop or reconnect', () => {
  const r = rig()
  const mac = r.open('mac1')
  r.focus(mac, true)
  r.q.talkActivity(mac, 'talk.audio')
  expect(r.q.suppressesPhone()).toBe(false)
  r.q.talkActivity(mac)
  expect(r.q.suppressesPhone()).toBe(true)
  r.q.input('phone1', 'share')
  r.q.talkActivity(mac, 'talk.audio')
  r.q.endTalk(mac)
  r.q.talkActivity(mac)
  expect(r.q.suppressesPhone()).toBe(false)
  r.q.endTalk(mac, 'socket.close')
  r.close(mac)
  const again = r.reopen('mac1')
  r.q.talkActivity(again)
  expect(r.q.suppressesPhone()).toBe(false)
  r.tick(PRESENCE_TTL_MS)
  r.q.talkActivity(again)
  expect(r.q.suppressesPhone()).toBe(true)
  r.q.endTalk(again)
  expect(r.q.suppressesPhone()).toBe(true)
  r.q.input('phone1', 'http.ask')
  expect(r.q.suppressesPhone()).toBe(false)
})

test('quiet decisions and transitions persist in a bounded ring with short device IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-desk-quiet-'))
  const logFile = join(dir, 'desk-quiet.json')
  try {
    const r = rig({ logFile })
    const mac = r.open('abcdef-rest')
    const read = () => JSON.parse(readFileSync(logFile, 'utf8'))
    r.focus(mac, true)
    r.tick(30)
    r.active(mac)
    r.tick(70)
    expect(r.q.recordSuppression()).toBe('desktop')
    expect(read()).toMatchObject([
      { event: 'desktop.start', device: 'abcdef', frame: 'activity' },
      { reason: 'desktop', device: 'abcdef', activityAgeMs: 70, presenceAgeMs: 100, activitySource: 'activity' },
    ])
    r.close(mac)
    const again = r.reopen(mac.data.tokenId)
    r.focus(again, true)
    expect(r.q.recordSuppression()).toBe('desktop')
    expect(read().at(-1)).toMatchObject({ activitySource: 'reconnect', activityAgeMs: 70, presenceAgeMs: 0 })
    r.q.talkActivity(again)
    expect(r.q.recordSuppression()).toBe('talk')
    expect(read().at(-1)).toMatchObject({ reason: 'talk', device: 'abcdef' })
    r.q.endTalk(again)
    expect(r.q.recordSuppression()).toBe('talk-grace')
    expect(read().slice(-3)).toMatchObject([
      { event: 'talk.end', device: 'abcdef', frame: 'talk.stop' },
      { event: 'talk-grace.start', device: 'abcdef', frame: 'talk.stop' },
      { reason: 'talk-grace', device: 'abcdef' },
    ])
    r.q.input('phone1-rest', 'http.photo')
    expect(read().at(-1)).toMatchObject({ event: 'desktop.end', device: 'abcdef', frame: 'http.photo', fromDevice: 'phone1' })
    expect(r.q.recordSuppression()).toBeUndefined()

    const restarted = rig({ logFile })
    restarted.q.talkActivity(restarted.open('123456-rest'))
    expect(read().at(0)).toMatchObject({ event: 'desktop.start' })
    for (let i = 0; i < DESK_QUIET_LOG_LIMIT; i++) restarted.q.recordSuppression()
    expect(read()).toHaveLength(DESK_QUIET_LOG_LIMIT)
    expect(read().every((row: { reason: string; device: string }) => row.reason === 'talk' && row.device === '123456')).toBe(true)
    expect(readFileSync(logFile, 'utf8')).not.toContain('-rest')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
