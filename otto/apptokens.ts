// App tokens — one bearer token per device for the /app transport.
//
// Only a SHA-256 of each token is stored (app-tokens.json, 0600), so the file
// leaking does not leak a working token; the token itself is shown once, at
// creation. The file is re-read on every check, so a token created or revoked
// from the CLI applies to the running server without a restart.
//
//   bun otto/apptokens.ts new <name>     print a fresh token for a device, once
//   bun otto/apptokens.ts list           id, name, created, last used
//   bun otto/apptokens.ts revoke <id>    the device is cut off within seconds
//
// The single-token predecessor (app-token) is imported as "first device" and
// removed the first time the file is read.

import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type AppToken = { id: string; name: string; hash: string; created: string; lastUsed?: string }

const stateDir = () => process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
const file = () => join(stateDir(), 'app-tokens.json')
const legacyFile = () => join(stateDir(), 'app-token')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export function loadAppTokens(): AppToken[] {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')).tokens ?? []
  } catch {}
  // First read: carry the single legacy token over so a paired phone keeps working.
  try {
    const t = readFileSync(legacyFile(), 'utf8').trim()
    if (t) {
      const tokens = [{ id: randomBytes(3).toString('hex'), name: 'first device', hash: sha(t), created: new Date().toISOString() }]
      save(tokens)
      unlinkSync(legacyFile())
      return tokens
    }
  } catch {}
  return []
}

function save(tokens: AppToken[]): void {
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify({ tokens }, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file())
}

export function createAppToken(name: string): { id: string; token: string } {
  const tokens = loadAppTokens()
  const token = randomBytes(32).toString('base64url')
  const id = randomBytes(3).toString('hex')
  save([...tokens, { id, name, hash: sha(token), created: new Date().toISOString() }])
  return { id, token }
}

export function revokeAppToken(id: string): boolean {
  const tokens = loadAppTokens()
  const kept = tokens.filter(t => t.id !== id)
  if (kept.length === tokens.length) return false
  save(kept)
  return true
}

/** The token id an `Authorization` header belongs to, or null. Constant-time per entry. */
export function checkAppToken(header: string): string | null {
  const m = /^Bearer (\S+)$/.exec(header)
  if (!m) return null
  const got = Buffer.from(sha(m[1]), 'hex')
  let hit: AppToken | undefined
  for (const t of loadAppTokens()) {
    if (timingSafeEqual(got, Buffer.from(t.hash, 'hex'))) hit = t
  }
  return hit?.id ?? null
}

/** Stamp lastUsed, at most once an hour per token so a chatty phone doesn't churn the file. */
export function touchAppToken(id: string): void {
  const tokens = loadAppTokens()
  const t = tokens.find(t => t.id === id)
  if (!t || (t.lastUsed && Date.now() - Date.parse(t.lastUsed) < 3600_000)) return
  t.lastUsed = new Date().toISOString()
  save(tokens)
}

export const isLiveAppToken = (id: string) => loadAppTokens().some(t => t.id === id)

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'new' && arg) {
    const { id, token } = createAppToken(arg)
    console.log(`${id}  ${arg}\n\n${token}\n\nShown once. Paste it into the app; revoke with: bun otto/apptokens.ts revoke ${id}`)
  } else if (cmd === 'list') {
    const tokens = loadAppTokens()
    if (!tokens.length) console.log('no app tokens')
    for (const t of tokens) console.log(`${t.id}  ${t.name.padEnd(20)}  created ${t.created.slice(0, 10)}  last used ${t.lastUsed?.slice(0, 16).replace('T', ' ') ?? 'never'}`)
  } else if (cmd === 'revoke' && arg) {
    const ok = revokeAppToken(arg)
    console.log(ok ? `revoked ${arg}` : `no token ${arg}`)
    if (!ok) process.exitCode = 1
  } else {
    console.log('usage: bun otto/apptokens.ts new <name> | list | revoke <id>')
    process.exitCode = 2
  }
}
