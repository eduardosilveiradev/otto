import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkAppToken, createAppToken, isLiveAppToken, loadAppTokens, revokeAppToken } from '../apptokens.ts'

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
