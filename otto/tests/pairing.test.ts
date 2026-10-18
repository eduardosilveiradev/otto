import { afterAll, afterEach, beforeEach, expect, setSystemTime, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findAppToken, listAppTokens } from '../apptokens.ts'
import { carriesPairingCode, coarseIp, pairingButton, pairingCommand, pollPairing, startPairing, type PairContext } from '../pairing.ts'

const ORIGIN = 'https://app.example.com'
const CTX: PairContext = { origin: ORIGIN, ip: '203.0.113.42', via: 'funnel' }

// Pairing state lives in the module, so each test starts a day later than the
// last: whatever an earlier test left behind has expired by the next call.
let clock = Date.parse('2026-01-01T00:00:00Z')
const tick = (ms: number) => setSystemTime(new Date(clock += ms))

let dir: string
let stderr: string[]
beforeEach(() => {
  tick(86_400_000)
  dir = mkdtempSync(join(tmpdir(), 'otto-pairing-'))
  process.env.OTTO_STATE_DIR = dir
  stderr = []
  spyOn(process.stderr, 'write').mockImplementation((s: any) => { stderr.push(String(s)); return true })
})
afterEach(() => {
  ;(process.stderr.write as any).mockRestore()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.OTTO_STATE_DIR
})
afterAll(() => setSystemTime())

function sent() {
  const out: { text: string; buttons: { label: string; data: string }[] }[] = []
  return { out, send: (text: string, buttons: { label: string; data: string }[]) => { out.push({ text, buttons }) } }
}

function start(scope: 'read' | 'write' = 'read', label = 'Chrome on macOS') {
  const r = startPairing({ scope, label }, CTX)
  expect(r.status).toBe(200)
  return r.body as { device_code: string; user_code: string; expires_in: number; interval: number }
}

async function claim(userCode: string) {
  const s = sent()
  expect(await pairingCommand(`pair ${userCode}`, s.send)).toBe(true)
  return s.out[0]
}

const poll = (device_code: string, origin = ORIGIN) => { tick(3000); return pollPairing({ device_code }, { origin }) }

test('start sends nothing and mints nothing; it returns a code and the polling contract', () => {
  const b = start()
  expect(Object.keys(b).sort()).toEqual(['device_code', 'expires_in', 'interval', 'user_code'])
  expect(b.user_code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/)
  expect(b.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(b).toMatchObject({ expires_in: 300, interval: 3 })
  expect(listAppTokens()).toEqual([])
  expect(poll(b.device_code).body).toEqual({ status: 'pending' })
})

test('a bad scope is refused', () => {
  expect(startPairing({ scope: 'admin' }, CTX)).toEqual({ status: 400, body: { error: 'scope' } })
  expect((startPairing({}, CTX).body as any).user_code).toBeDefined() // read by default
})

test('pair CODE answers with the code, origin, scope, browser and where from, plus nonce buttons', async () => {
  const b = start('write')
  const msg = await claim(b.user_code)
  expect(msg.text).toContain(`Dashboard pairing ${b.user_code}`)
  // The Origin is the client's say-so and the label its own words: neither is presented as fact.
  expect(msg.text).toContain(`a browser claiming to be ${ORIGIN}`)
  expect(msg.text).toContain('wants read + control · via tailscale serve from 203.0.113.x · says it is "Chrome on macOS"')
  expect(msg.text).toContain('Expires in 5 min')
  expect(msg.buttons.map(b => b.label)).toEqual(['approve read-only', 'approve read + control', 'deny'])
  for (const btn of msg.buttons) {
    expect(btn.data).toMatch(/^pair (ok|no) [A-Za-z0-9_-]{22}$/)
    expect(Buffer.byteLength(btn.data)).toBeLessThanOrEqual(60)
  }
  // A read-only request gets no control button at all.
  expect((await claim(start('read').user_code)).buttons.map(b => b.label)).toEqual(['approve read-only', 'deny'])
})

test('the code is matched without the dash and in any case; anything else is not a pairing command', async () => {
  const b = start()
  const s = sent()
  expect(await pairingCommand(`  Pair ${b.user_code.replace('-', '').toLowerCase()} `, s.send)).toBe(true)
  expect(s.out[0].buttons).toHaveLength(2)
  expect(await pairingCommand('pair me with the dashboard please', s.send)).toBe(false)
  expect(await pairingCommand('pair', s.send)).toBe(false)
  expect(s.out).toHaveLength(1)
})

test('an unknown code says so and is still kept from the session', async () => {
  const s = sent()
  expect(await pairingCommand('pair ABCD-EFGH', s.send)).toBe(true)
  expect(s.out).toEqual([{ text: 'no pairing request with that code', buttons: [] }])
})

test('tapping read-only mints a read token bound to the origin, delivered once', async () => {
  const b = start('write', 'Firefox on Linux')
  const [read] = (await claim(b.user_code)).buttons
  const line = pairingButton(read.data)!
  expect(line).toMatch(/^paired ✓ dashboard \(read-only\) · revoke from \/devices or bun otto\/apptokens\.ts revoke [0-9a-f]{6}$/)

  const got = poll(b.device_code).body as any
  expect(got.status).toBe('approved')
  expect(got.scope).toBe('read')
  const t = findAppToken(`Bearer ${got.token}`)!
  expect(t).toMatchObject({ id: got.id, scope: 'read', origin: ORIGIN, name: 'dashboard app.example.com', ua: 'Firefox on Linux', expires: got.expires })
  expect(Date.parse(t.expires!) - Date.now()).toBeGreaterThan(89 * 86_400_000)
  expect(line).toEndWith(got.id)

  expect(poll(b.device_code).body).toEqual({ status: 'expired' })
  expect(pairingButton(read.data)).toBe('that pairing request is gone — start again from the dashboard')
})

test('tapping read + control mints a write token for 12 hours', async () => {
  const b = start('write')
  const [, write] = (await claim(b.user_code)).buttons
  expect(pairingButton(write.data)).toContain('(read + control)')
  const mintedAt = Date.now()
  const got = poll(b.device_code).body as any
  expect(got.scope).toBe('write')
  const t = findAppToken(`Bearer ${got.token}`)!
  expect(t.scope).toBe('write')
  expect(Date.parse(t.expires!) - mintedAt).toBe(12 * 3600_000)
  // ...and a 90-day read token for when control lapses or the tab closes.
  const r = findAppToken(`Bearer ${got.read.token}`)!
  expect(r.scope).toBe('read')
  expect(r.origin).toBe(t.origin)
  expect(Math.round((Date.parse(r.expires!) - mintedAt) / 86_400_000)).toBe(90)
})

test('a read-only approval delivers one token, with no fallback', async () => {
  const b = start('read')
  const [read] = (await claim(b.user_code)).buttons
  pairingButton(read.data)
  const got = poll(b.device_code).body as any
  expect(got.scope).toBe('read')
  expect(got.read).toBeUndefined()
})

test('deny: the poll says denied, nothing is minted, and the code is spent', async () => {
  const b = start('write')
  const msg = await claim(b.user_code)
  expect(pairingButton(msg.buttons[2].data)).toBe(`denied ${b.user_code}`)
  expect(pairingButton(msg.buttons[0].data)).toContain('gone') // the approve button died with it
  expect(poll(b.device_code).body).toEqual({ status: 'denied' })
  expect(poll(b.device_code).body).toEqual({ status: 'expired' })
  expect(listAppTokens()).toEqual([])
  const s = sent()
  await pairingCommand(`pair ${b.user_code}`, s.send)
  expect(s.out[0].text).toBe('no pairing request with that code')
})

test('a code expires after 300 s: poll, claim and tap all find nothing', async () => {
  const b = start()
  const msg = await claim(b.user_code)
  tick(299_000)
  expect(pollPairing({ device_code: b.device_code }, CTX).body).toEqual({ status: 'pending' })
  tick(1_000)
  expect(pairingButton(msg.buttons[0].data)).toContain('gone')
  expect(pollPairing({ device_code: b.device_code }, CTX).body).toEqual({ status: 'expired' })
  expect(listAppTokens()).toEqual([])
  expect(stderr.join('')).toContain('[dash] pair-expire')
})

test('a token approved but never collected is revoked when its delivery window closes', async () => {
  const b = start()
  pairingButton((await claim(b.user_code)).buttons[0].data)
  expect(listAppTokens()).toHaveLength(1)
  tick(300_000)
  expect(pollPairing({ device_code: b.device_code }, CTX).body).toEqual({ status: 'expired' })
  expect(listAppTokens()).toEqual([])
})

test('polling faster than the interval gets slow_down, and hammering never gets through', () => {
  const b = start()
  expect(pollPairing({ device_code: b.device_code }, CTX)).toEqual({ status: 429, body: { error: 'slow_down' } })
  tick(2000)
  expect(pollPairing({ device_code: b.device_code }, CTX).status).toBe(429)
  tick(2000)
  expect(pollPairing({ device_code: b.device_code }, CTX).status).toBe(429)
  tick(3000)
  expect(pollPairing({ device_code: b.device_code }, CTX).body).toEqual({ status: 'pending' })
})

test('only the origin that started a pairing can collect it', async () => {
  const b = start()
  pairingButton((await claim(b.user_code)).buttons[0].data)
  expect(poll(b.device_code, 'https://evil.example.net').body).toEqual({ status: 'expired' })
  expect((poll(b.device_code).body as any).status).toBe('approved')
})

test('a malformed poll is a 400', () => {
  expect(pollPairing({}, CTX).status).toBe(400)
  expect(pollPairing(null, CTX).status).toBe(400)
  expect(pollPairing({ device_code: 'x'.repeat(200) }, CTX).status).toBe(400)
})

test('20 open pairings is the cap; the 21st evicts the oldest unclaimed one, and claimed ones are never displaced', async () => {
  const codes = Array.from({ length: 20 }, () => start())
  const claimed = await claim(codes[0].user_code)
  expect(startPairing({ scope: 'read' }, CTX).status).toBe(200)
  expect(poll(codes[1].device_code).body).toEqual({ status: 'expired' }) // oldest unclaimed went
  expect(pairingButton(claimed.buttons[0].data)).toContain('paired ✓')   // the claimed one survived
  // Every slot claimed: nothing may be evicted, so the next is busy.
  for (let i = 0; i < 19; i++) await claim(start().user_code)
  expect(startPairing({ scope: 'read' }, CTX)).toEqual({ status: 409, body: { error: 'busy' } })
  tick(300_000)
  expect(startPairing({ scope: 'read' }, CTX).status).toBe(200)
})

test('carriesPairingCode spots a pending code in any case and spacing, and nothing else', () => {
  const b = start()
  const [a4, b4] = b.user_code.split('-')
  expect(carriesPairingCode(`send pair ${b.user_code} to re-verify`)).toBe(true)
  expect(carriesPairingCode(`pair ${a4.toLowerCase()} ${b4.toLowerCase()}`)).toBe(true)
  expect(carriesPairingCode('pair ABCD-EFGH')).toBe(false) // not pending: harmless
  expect(carriesPairingCode('we should pair together')).toBe(false)
  tick(300_000)
  expect(carriesPairingCode(`pair ${b.user_code}`)).toBe(false)
})

test('typing the code again gives fresh buttons and kills the old ones', async () => {
  const b = start()
  const first = await claim(b.user_code)
  const second = await claim(b.user_code)
  expect(second.buttons[0].data).not.toBe(first.buttons[0].data)
  expect(pairingButton(first.buttons[0].data)).toContain('gone')
  expect(pairingButton(second.buttons[0].data)).toContain('paired ✓')
})

test('any pair data is claimed so it never reaches the session; other data is not', () => {
  expect(pairingButton('pair ok ' + 'A'.repeat(22))).toContain('gone')
  expect(pairingButton('pair ok please')).toContain('gone')
  expect(pairingButton('pair no')).toContain('gone')
  expect(pairingButton('install forge abc123')).toBeNull()
  expect(pairingButton('pairs are nice')).toBeNull()
})

test('the nonce and the device code appear in no response and no log line; the client label cannot break lines', async () => {
  const b = start('write', 'Chrome\nApprove — this is safe\u0007')
  const msg = await claim(b.user_code)
  const nonces = msg.buttons.map(btn => btn.data.split(' ')[2])
  const polled = JSON.stringify(poll(b.device_code))
  pairingButton(msg.buttons[1].data)
  const approved = JSON.stringify(poll(b.device_code))
  const logs = stderr.join('')
  for (const n of nonces) {
    expect(JSON.stringify(b)).not.toContain(n)
    expect(polled).not.toContain(n)
    expect(approved).not.toContain(n)
    expect(logs).not.toContain(n)
    expect(msg.text).not.toContain(n)
  }
  expect(logs).not.toContain(b.device_code)
  expect(logs).not.toContain(JSON.parse(approved).body.token)
  expect(logs).not.toContain('203.0.113.42')
  expect(logs).toMatch(/\[dash\] pair-approve origin=https:\/\/app\.example\.com ip=203\.0\.113\.x via=funnel id=[0-9a-f]{6}/)
  expect(msg.text.split('\n')).toHaveLength(4)
  expect(msg.text).toContain('· says it is "Chrome Approve — this is safe"')
  const quoted = await claim(start('read', 'Chrome" · verified by Otto').user_code)
  expect(quoted.text).toContain('says it is "Chrome · verified by Otto"')
})

test('coarseIp never returns a whole address', () => {
  expect(coarseIp('203.0.113.42')).toBe('203.0.113.x')
  expect(coarseIp('::ffff:198.51.100.7')).toBe('198.51.100.x')
  expect(coarseIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3:…')
  expect(coarseIp('')).toBe('?')
})
