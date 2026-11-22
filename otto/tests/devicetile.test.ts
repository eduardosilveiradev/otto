import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DeviceTile, driving, latestActivity, pick, sessionDevice, sessionInfo, type Activity, type Device } from '../devicetile.ts'

const tmp = mkdtempSync(join(tmpdir(), 'devicetile-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const IPHONE: Device = { id: 'SIM-1', name: 'iPhone 18 Pro', os: 'ios' }
const PIXEL: Device = { id: 'emulator-5554', name: 'Pixel 9', os: 'android' }
const ev = (session: string, command: string, extra = {}) =>
  JSON.stringify({ version: 1, ts: '2026-11-13T10:00:00.000Z', session, kind: 'request.started', command, summary: `Started ${command}`, ...extra }) + '\n'

test('which Bash commands drive a device', () => {
  expect(driving('agent-device press @e3')).toEqual({ verb: 'tapping', os: undefined })
  expect(driving('cd x && bun __HOME__/.t3/tools/agent-device/1.0/node_modules/agent-device/bin/agent-device.mjs --session s snapshot -i')).toEqual({ verb: 'looking', os: undefined })
  expect(driving('xcrun simctl openurl booted https://example.com')).toEqual({ verb: 'opening a link', os: 'ios' })
  expect(driving('adb -s emulator-5554 shell input tap 1 2')).toEqual({ verb: 'tapping', os: 'android' })
  expect(driving('X=1 agent-device fill @e2 hello')?.verb).toBe('typing')
  // Mentions and read-only listings don't open a tile.
  for (const c of ['ls ~/.agent-device/sessions', 'grep -r agent-device .', 'xcrun simctl list devices booted', 'adb devices', 'agent-device --help', 'echo "agent-device press"']) expect(driving(c)).toBeNull()
})

test('activity is the newest log under either root; the session tail gives id, verb and privacy', () => {
  const cli = join(tmp, 'cli'), t3 = join(tmp, 't3')
  const a = join(cli, 'cwd_abc_ios'), b = join(t3, 't3-123')
  mkdirSync(join(a, 'requests'), { recursive: true })
  mkdirSync(join(b, 'requests'), { recursive: true })
  writeFileSync(join(a, 'events.ndjson'), ev('cwd:abc:ios', 'snapshot') + ev('cwd:abc:ios', 'press'))
  writeFileSync(join(b, 'events.ndjson'), ev('t3-123', 'open'))
  writeFileSync(join(b, 'requests', 'r1.ndjson'), '{"phase":"ios_runner_session_reuse","data":{"deviceId":"SIM-OLD"}}\n{"data":{"deviceId":"SIM-2"}}\n')
  utimesSync(join(a, 'events.ndjson'), 1000, 1000)
  utimesSync(join(b, 'events.ndjson'), 2000, 2000)
  utimesSync(join(b, 'requests', 'r1.ndjson'), 1500, 1500)
  expect(latestActivity([cli, t3, join(tmp, 'missing')])).toMatchObject({ at: 2_000_000, session: 't3-123', dir: b })
  // A request log still growing during a long call counts too.
  utimesSync(join(a, 'events.ndjson'), 1000, 1000)
  writeFileSync(join(a, 'requests', 'long.ndjson'), '{}\n')
  utimesSync(join(a, 'requests', 'long.ndjson'), 3000, 3000)
  expect(latestActivity([cli, t3])?.dir).toBe(a)
  expect(latestActivity([join(tmp, 'missing')])).toBeNull()

  expect(sessionInfo(a)).toEqual({ id: 'cwd:abc:ios', verb: 'tapping', sensitive: false })
  writeFileSync(join(a, 'events.ndjson'), ev('cwd:abc:ios', 'press', { summary: 'Tapped label="Password"' }))
  expect(sessionInfo(a).sensitive).toBe(true)
  expect(sessionInfo(join(tmp, 'nope'))).toEqual({ id: '', verb: 'driving', sensitive: false })

  // The device: the claim for the session first, else the request log's last deviceId.
  const claims = join(tmp, 'claims')
  mkdirSync(claims, { recursive: true })
  writeFileSync(join(claims, 'x.json'), JSON.stringify({ session: 'cwd:abc:ios', device: { id: 'SIM-1', name: 'iPhone 18 Pro' } }))
  writeFileSync(join(claims, 'bad.json'), '{')
  expect(sessionDevice(a, 'cwd:abc:ios', claims)).toBe('SIM-1')
  expect(sessionDevice(b, 't3-123', claims)).toBe('SIM-2')
  expect(sessionDevice(join(tmp, 'nope'), 'z', claims)).toBeNull()
})

test('only a booted device is shown, and never a guess between two', () => {
  expect(pick([IPHONE, PIXEL], 'SIM-1')).toBe(IPHONE)
  expect(pick([IPHONE], 'SIM-GONE')).toBeNull()
  expect(pick([IPHONE], null)).toBe(IPHONE)
  expect(pick([IPHONE, PIXEL], null)).toBeNull()
  expect(pick([IPHONE, PIXEL], null, 'android')).toBe(PIXEL)
  expect(pick([], null)).toBeNull()
})

function rig(o: { capture?: (d: Device) => Promise<string | null>; info?: { id: string; verb: string; sensitive: boolean } } = {}) {
  let clock = 100_000
  let activity: Activity | null = null
  const frames: Record<string, unknown>[] = []
  const captured: string[] = []
  const tile = new DeviceTile(f => frames.push(JSON.parse(f)), {
    now: () => clock,
    scan: () => activity,
    info: () => o.info ?? { id: 't3-1', verb: 'tapping', sensitive: false },
    deviceOf: () => 'SIM-1',
    devices: async () => [IPHONE],
    capture: o.capture ?? (async d => { captured.push(d.id); return Buffer.from('jpeg').toString('base64') }),
  })
  return {
    tile, frames, captured,
    at: (ms: number) => { clock = ms },
    act: (at = clock) => { activity = { at, session: 't3-1', dir: '/x' } },
  }
}

test('frames pace at one a second while the logs move, then done after 20 s quiet', async () => {
  const r = rig()
  await r.tile.tick()
  expect(r.frames).toEqual([])                       // nothing driven, nothing sent
  r.act(); await r.tile.tick()
  expect(r.frames[0]).toMatchObject({ type: 'browser', caption: 'iPhone 18 Pro · tapping', url: '', source: 'device', ts: 100_000 })
  expect(String(r.frames[0].image)).toStartWith('data:image/jpeg;base64,')
  await r.tile.tick()                                 // same instant: paced out
  r.at(100_400); r.act(); await r.tile.tick()
  expect(r.frames.length).toBe(1)
  r.at(101_000); await r.tile.tick()
  expect(r.frames.length).toBe(2)
  expect(r.captured).toEqual(['SIM-1', 'SIM-1'])
  expect(JSON.parse(r.tile.snapshot()!)).toMatchObject({ caption: 'iPhone 18 Pro · tapping' })

  // Keeps mirroring through quiet seconds, ends 20 s after the last activity.
  r.at(120_300); await r.tile.tick()
  expect(r.frames.at(-1)?.image).toBeTruthy()
  r.at(120_400); await r.tile.tick()
  expect(r.frames.at(-1)).toEqual({ type: 'browser', done: true })
  expect(r.tile.snapshot()).toBeNull()
  // The same old activity doesn't bring it back; new activity does.
  r.at(121_500); await r.tile.tick()
  expect(r.frames.at(-1)).toEqual({ type: 'browser', done: true })
  r.act(); await r.tile.tick()
  expect(r.frames.at(-1)?.caption).toBe('iPhone 18 Pro · tapping')
})

test('activity older than the idle window never opens a tile', async () => {
  const r = rig()
  r.act(50_000); await r.tile.tick()
  expect(r.frames).toEqual([])
})

test('a failed capture is skipped silently and a slow one never overlaps', async () => {
  let release!: (v: string | null) => void
  let calls = 0
  const r = rig({ capture: () => { calls++; return new Promise(res => { release = res }) } })
  r.act()
  const first = r.tile.tick(); await Bun.sleep(1)
  r.at(101_100); await r.tile.tick()                  // still capturing: no second capture
  expect(calls).toBe(1)
  release(null); await first
  expect(r.frames).toEqual([])
  r.at(102_200); const second = r.tile.tick(); await Bun.sleep(1)
  release('a'.repeat(120_000)); await second           // over 80 KB: dropped too
  expect(r.frames).toEqual([])
})

test('a capture that lands after the tile ended is dropped', async () => {
  let release!: (v: string | null) => void
  const r = rig({ capture: () => new Promise(res => { release = res }) })
  r.act()
  const p = r.tile.tick(); await Bun.sleep(1)
  r.tile.finish()
  release('abcd'); await p
  expect(r.frames).toEqual([])                        // no done either: nothing was ever shown
})

test("Otto's own Bash call: fast path, hides a password screen until a clean snapshot, ends with the turn", async () => {
  const r = rig()
  r.tile.bash('ls ~/.agent-device', { stdout: 'sessions' })
  await Bun.sleep(1)
  expect(r.frames).toEqual([])
  r.tile.bash('agent-device snapshot -i', { stdout: '@e1 [textbox] "Email"\n@e2 [securetextfield] "Password"' })
  await Bun.sleep(1)
  expect(r.frames[0]).toMatchObject({ image: null, caption: 'iPhone 18 Pro · looking' })
  expect(r.captured).toEqual([])
  r.at(101_000); r.tile.bash('agent-device press @e2', { stdout: 'Tapped @e2' })
  await Bun.sleep(1)
  expect(r.frames.at(-1)).toMatchObject({ image: null, caption: 'iPhone 18 Pro · tapping' })
  r.at(102_000); r.tile.bash('agent-device snapshot -i', { stdout: '@e1 [button] "Continue"' })
  await Bun.sleep(1)
  expect(r.frames.at(-1)?.image).toBeTruthy()
  r.tile.turnEnded()
  expect(r.frames.at(-1)).toEqual({ type: 'browser', done: true })
})

test("the turn ending leaves a T3 thread's driving on screen", async () => {
  const r = rig()
  r.tile.bash('agent-device press @e1', '')
  await Bun.sleep(1)
  r.at(105_000); r.act(); await r.tile.tick()
  r.tile.turnEnded()
  expect(r.frames.at(-1)?.caption).toBe('iPhone 18 Pro · tapping')
})

test('a session log naming a password hides the picture', async () => {
  const r = rig({ info: { id: 't3-1', verb: 'typing', sensitive: true } })
  r.act(); await r.tile.tick()
  expect(r.frames[0]).toMatchObject({ image: null, caption: 'iPhone 18 Pro · typing' })
  r.at(101_000); await r.tile.tick()
  expect(r.frames.length).toBe(1)                      // an unchanged caption-only frame isn't resent
  expect(r.captured).toEqual([])
})
