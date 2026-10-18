import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkAppToken, createAppToken, findAppToken, hasScope, isDashToken, isExpired, isLiveAppToken, listAppTokens, loadAppTokens, revokeAppToken } from '../apptokens.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'otto-apptokens-')); process.env.OTTO_STATE_DIR = dir })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.OTTO_STATE_DIR })

test('a created token authenticates, is stored only as a hash, and stops on revoke', () => {
  const { id, token } = createAppToken('phone')
  expect(checkAppToken(`Bearer ${token}`)).toBe(id)
  expect(checkAppToken(`Bearer ${token}x`)).toBeNull()
  expect(checkAppToken(token)).toBeNull()

  const file = join(dir, 'app-tokens.json')
  expect(readFileSync(file, 'utf8')).not.toContain(token)
  expect(statSync(file).mode & 0o777).toBe(0o600)

  expect(revokeAppToken(id)).toBe(true)
  expect(checkAppToken(`Bearer ${token}`)).toBeNull()
  expect(isLiveAppToken(id)).toBe(false)
  expect(revokeAppToken(id)).toBe(false)
})

test('devices are independent', () => {
  const a = createAppToken('phone'), b = createAppToken('ipad')
  revokeAppToken(a.id)
  expect(checkAppToken(`Bearer ${a.token}`)).toBeNull()
  expect(checkAppToken(`Bearer ${b.token}`)).toBe(b.id)
})

test('the legacy single token is imported once and its file removed', () => {
  writeFileSync(join(dir, 'app-token'), 'legacy-secret\n')
  const [t] = loadAppTokens()
  expect(t.name).toBe('first device')
  expect(existsSync(join(dir, 'app-token'))).toBe(false)
  expect(checkAppToken('Bearer legacy-secret')).toBe(t.id)
  expect(loadAppTokens()).toHaveLength(1)
})

const ORIGIN = 'https://app.example.com'
const tokensOnDisk = () => JSON.parse(readFileSync(join(dir, 'app-tokens.json'), 'utf8')).tokens

test('a legacy token is native: write, no origin, no expiry, everywhere', () => {
  const { id, token } = createAppToken('phone')
  const t = findAppToken(`Bearer ${token}`)!
  expect(t.id).toBe(id)
  expect(t.scope).toBeUndefined()
  expect(t.origin).toBeUndefined()
  expect(t.expires).toBeUndefined()
  expect(isDashToken(t)).toBe(false)
  expect(isExpired(t)).toBe(false)
  expect(hasScope(t, 'read')).toBe(true)
  expect(hasScope(t, 'write')).toBe(true)
  expect(isLiveAppToken(id)).toBe(true)
})

test('an expired token is still found, but refused by checkAppToken and the socket sweep', () => {
  const { id, token } = createAppToken('phone', { ttlHours: 1 })
  writeFileSync(join(dir, 'app-tokens.json'), JSON.stringify({ tokens: tokensOnDisk().map((t: any) => ({ ...t, expires: new Date(Date.now() - 1000).toISOString() })) }))
  const t = findAppToken(`Bearer ${token}`)!
  expect(t.id).toBe(id)
  expect(isExpired(t)).toBe(true)
  expect(checkAppToken(`Bearer ${token}`)).toBeNull()
  expect(isLiveAppToken(id)).toBe(false)
})

test('a dashboard token never passes the native checks', () => {
  for (const scope of ['read', 'write'] as const) {
    const { id, token } = createAppToken('browser', { scope, origin: ORIGIN, ua: 'Mozilla/5.0' })
    const t = findAppToken(`Bearer ${token}`)!
    expect(t).toMatchObject({ id, scope, origin: ORIGIN, ua: 'Mozilla/5.0' })
    expect(isDashToken(t)).toBe(true)
    expect(checkAppToken(`Bearer ${token}`)).toBeNull()
    expect(isLiveAppToken(id)).toBe(false)
    expect(hasScope(t, 'read')).toBe(true)
    expect(hasScope(t, 'write')).toBe(scope === 'write')
  }
})

test('dashboard tokens expire by scope default unless told otherwise', () => {
  const hoursLeft = (token: string) => (Date.parse(findAppToken(`Bearer ${token}`)!.expires!) - Date.now()) / 3600_000
  expect(hoursLeft(createAppToken('r', { scope: 'read', origin: ORIGIN }).token)).toBeCloseTo(90 * 24, 1)
  expect(hoursLeft(createAppToken('w', { scope: 'write', origin: ORIGIN }).token)).toBeCloseTo(12, 1)
  expect(hoursLeft(createAppToken('h', { scope: 'write', origin: ORIGIN, ttlHours: 2 }).token)).toBeCloseTo(2, 1)
  // An origin alone still makes a dashboard token, read by default.
  expect(findAppToken(`Bearer ${createAppToken('o', { origin: ORIGIN }).token}`)!.scope).toBe('read')
})

test('createAppToken refuses a scope without an origin, and anything but an exact origin', () => {
  expect(() => createAppToken('x', { scope: 'read' })).toThrow(/origin/)
  expect(() => createAppToken('x', { scope: 'read', origin: 'https://app.example.com/' })).toThrow(/exact origin/)
  expect(() => createAppToken('x', { scope: 'read', origin: 'javascript:alert(1)' })).toThrow(/exact origin/)
  expect(() => createAppToken('x', { scope: 'admin' as any, origin: ORIGIN })).toThrow(/scope/)
  expect(() => createAppToken('x', { scope: 'read', origin: ORIGIN, ttlHours: 0 })).toThrow(/ttl/)
  expect(loadAppTokens()).toHaveLength(0)
})

test('listAppTokens hides the hash', () => {
  createAppToken('phone')
  createAppToken('browser', { scope: 'read', origin: ORIGIN })
  const list = listAppTokens()
  expect(list).toHaveLength(2)
  for (const t of list) expect('hash' in t).toBe(false)
  expect(JSON.stringify(list)).not.toMatch(/[0-9a-f]{64}/)
})

const cli = (...args: string[]) => Bun.spawnSync(['bun', join(import.meta.dir, '..', 'apptokens.ts'), ...args], { env: { ...process.env, OTTO_STATE_DIR: dir } })

test('CLI refuses --scope without --origin and mints with flags', () => {
  const refused = cli('new', 'browser', '--scope', 'read')
  expect(refused.exitCode).toBe(2)
  expect(refused.stderr.toString()).toContain('--origin')
  expect(loadAppTokens()).toHaveLength(0)

  const ok = cli('new', 'browser', '--scope', 'write', '--origin', ORIGIN, '--hours', '3')
  expect(ok.exitCode).toBe(0)
  const [t] = loadAppTokens()
  expect(t).toMatchObject({ name: 'browser', scope: 'write', origin: ORIGIN })
  expect((Date.parse(t.expires!) - Date.now()) / 3600_000).toBeCloseTo(3, 1)
  expect(cli('list').stdout.toString()).toContain(`write ${ORIGIN}`)
  expect(cli('new', 'x', '--hours', 'soon').exitCode).toBe(2)
})

test('two concurrent writers do not lose a revoke or a create', async () => {
  const victims = Array.from({ length: 5 }, (_, i) => createAppToken('victim' + i).id)
  const mod = JSON.stringify(join(import.meta.dir, '..', 'apptokens.ts'))
  const env = { ...process.env, OTTO_STATE_DIR: dir }
  // One process creates tokens flat out for 400 ms while the other revokes, spread across that window.
  const churn = Bun.spawn(['bun', '-e', `const m = await import(${mod}); let n = 0; const end = Date.now() + 400; while (Date.now() < end) { m.createAppToken('c' + n++) } console.log(n)`], { env, stdout: 'pipe' })
  const revoke = Bun.spawn(['bun', '-e', `const m = await import(${mod}); for (const id of ${JSON.stringify(victims)}) { await Bun.sleep(40); m.revokeAppToken(id) }`], { env })
  const created = Number(await new Response(churn.stdout).text())
  expect(await churn.exited).toBe(0)
  expect(await revoke.exited).toBe(0)
  const ids = loadAppTokens().map(t => t.id)
  for (const id of victims) expect(ids).not.toContain(id)
  expect(ids).toHaveLength(created)
  expect(existsSync(join(dir, 'app-tokens.json.lock'))).toBe(false)
})

test('a lock left by a dead process is taken over', () => {
  writeFileSync(join(dir, 'app-tokens.json.lock'), '')
  const { token } = createAppToken('phone')
  expect(checkAppToken(`Bearer ${token}`)).not.toBeNull()
  expect(existsSync(join(dir, 'app-tokens.json.lock'))).toBe(false)
})

test('minting while only the legacy file exists migrates under one lock, with no stall and no self-steal', () => {
  writeFileSync(join(dir, 'app-token'), 'legacy-secret\n')
  const t0 = performance.now()
  const { id } = createAppToken('phone')
  expect(performance.now() - t0).toBeLessThan(500) // the nested lock used to spin a full second
  expect(listAppTokens().map(t => t.name).sort()).toEqual(['first device', 'phone'])
  expect(revokeAppToken(id)).toBe(true)
  expect(existsSync(join(dir, 'app-token'))).toBe(false)
  expect(existsSync(join(dir, 'app-tokens.json.lock'))).toBe(false)
})

test('a lock held by a live process is never taken over', () => {
  writeFileSync(join(dir, 'app-tokens.json.lock'), String(process.ppid))
  expect(() => createAppToken('phone')).toThrow(/locked by pid/)
  expect(readFileSync(join(dir, 'app-tokens.json.lock'), 'utf8')).toBe(String(process.ppid))
})
