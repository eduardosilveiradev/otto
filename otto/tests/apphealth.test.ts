import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseAppHealth, peekAppHealth, recordAppHealth, tokenNames, appHealthVerdict, appHealthStatus, type AppHealth } from '../apphealth.ts'
import { ago } from '../status.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-apphealth-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const NOW = Date.parse('2026-08-12T09:00:00Z')
const h = (n: number) => n * 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()
const body = (over: Record<string, unknown> = {}) => ({
  notifications: 'authorized', backgroundRefresh: 'available', keepAwake: true, shareConfigured: true,
  build: '142', version: '0.9', ios: '26.0.1', reason: 'connect', ...over,
})
const report = (over: Partial<AppHealth> = {}): AppHealth => ({ ...(parseAppHealth(body(), NOW) as AppHealth), ...over })
const verdict = (over: Partial<AppHealth> = {}) => appHealthVerdict(report(over), NOW, ago)

test('parseAppHealth rejects anything that is not a full report', () => {
  for (const bad of [null, [], {}, body({ ios: undefined }), body({ keepAwake: 'yes' }), 'x'])
    expect(parseAppHealth(bad, NOW)).toBeNull()
  const ok = parseAppHealth(body({ build: 'x'.repeat(500) }), NOW)!
  expect(ok.at).toBe(iso(NOW))
  expect(ok.build.length).toBe(40)
})

test('parseAppHealth keeps lastRefresh only when it parses', () => {
  expect(parseAppHealth(body({ lastRefresh: 'yesterday-ish' }), NOW)!.lastRefresh).toBeUndefined()
  expect(parseAppHealth(body({ lastRefresh: iso(NOW - h(2)) }), NOW)!.lastRefresh).toBe(iso(NOW - h(2)))
})

test('record then peek round-trips per token, privately', () => {
  const f = join(tmp, 'app-health.json')
  expect(peekAppHealth(f)).toEqual({})
  recordAppHealth(f, 'abc', report())
  recordAppHealth(f, 'def', report({ build: '7' }))
  recordAppHealth(f, 'abc', report({ build: '9' }))
  const s = peekAppHealth(f)
  expect(s.abc.build).toBe('9')
  expect(s.def.build).toBe('7')
  expect(statSync(f).mode & 0o777).toBe(0o600)
})

test('verdicts: first hit wins', () => {
  expect(verdict({ notifications: 'denied' })).toMatchObject({ verdict: 'down' })
  expect(verdict({ notifications: 'denied' }).detail).toContain('notifications denied')
  const nd = verdict({ notifications: 'notDetermined' })
  expect(nd.verdict).toBe('degraded')
  expect(nd.detail).toContain('never allowed')
  const bg = verdict({ backgroundRefresh: 'denied' })
  expect(bg.verdict).toBe('degraded')
  expect(bg.detail).toContain('background app refresh off')
  const sh = verdict({ shareConfigured: false })
  expect(sh.verdict).toBe('degraded')
  expect(sh.detail).toContain('share sheet')
})

test('a silent phone and a stale refresh both degrade', () => {
  const silent = verdict({ at: iso(NOW - h(48)), notifications: 'notDetermined' })
  expect(silent.verdict).toBe('degraded')
  expect(silent.detail.startsWith('nothing from the phone for 2 d')).toBe(true)
  const stale = verdict({ lastRefresh: iso(NOW - h(72)) })
  expect(stale.verdict).toBe('degraded')
  expect(stale.detail).toContain('background refresh has not run')
})

test('healthy is up; keep-awake off is a choice', () => {
  const ok = verdict({ lastRefresh: iso(NOW - h(2)) })
  expect(ok.verdict).toBe('up')
  for (const s of ['iOS 26.0.1', 'build 142', 'last background refresh']) expect(ok.detail).toContain(s)
  const off = verdict({ keepAwake: false })
  expect(off.verdict).toBe('up')
  expect(off.detail).toContain('keep-awake off')
})

test('rows: none until a device reports, named when the token is known', () => {
  expect(appHealthStatus({}, {}, NOW, ago)).toEqual([])
  const r = report()
  expect(appHealthStatus({ abc: r }, { abc: 'phone' }, NOW, ago)[0]).toMatchObject({ id: 'phone:abc', label: 'Phone (phone)', at: Date.parse(r.at) })
  expect(appHealthStatus({ abc: r }, { abc: '' }, NOW, ago)[0].label).toBe('Phone')
  // A revoked token's last report is not a phone gone silent.
  expect(appHealthStatus({ abc: r, old: r }, { abc: 'phone' }, NOW, ago).map(x => x.id)).toEqual(['phone:abc'])
})

test('tokenNames reads app-tokens.json', () => {
  const dir = mkdtempSync(join(tmp, 't-'))
  expect(tokenNames(dir)).toEqual({})
  writeFileSync(join(dir, 'app-tokens.json'), JSON.stringify({ tokens: [{ id: 'abc', name: 'phone', hash: 'x', created: '2026-01-01' }] }))
  expect(tokenNames(dir)).toEqual({ abc: 'phone' })
})

test('announce is kept and shown when the phone reports it', () => {
  const h = parseAppHealth(body({ announce: 'enabled' }), NOW)!
  expect(h.announce).toBe('enabled')
  expect(appHealthVerdict(h, NOW, () => '1m').detail).toContain('announce notifications enabled')
  expect(parseAppHealth(body({}), NOW)!.announce).toBeUndefined()
})
