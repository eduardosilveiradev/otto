// App tokens — one bearer token per device for the /app transport.
//
// Only a SHA-256 of each token is stored (app-tokens.json, 0600), so the file
// leaking does not leak a working token; the token itself is shown once, at
// creation. The file is re-read on every check, so a token created or revoked
// from the CLI applies to the running server without a restart.
//
// Two kinds share the file. A native token (the iOS app) has neither `scope`
// nor `origin` and works on every /app route. A dashboard token has both: it is
// bound to one browser origin, works only under /app/dash/*, and expires —
// checkAppToken and isLiveAppToken refuse it, so it never reaches the native
// routes or the WebSocket. Expiry applies to both kinds; legacy tokens have none.
//
//   bun otto/apptokens.ts new <name> [--scope read|write --origin https://… ] [--hours N]
//   bun otto/apptokens.ts list           id, name, kind, created, last used, expiry
//   bun otto/apptokens.ts revoke <id>    the device is cut off within seconds
//
// The single-token predecessor (app-token) is imported as "first device" and
// removed the first time the file is read.

import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parseArgs } from 'util'

export type Scope = 'read' | 'write'
export type AppToken = {
  id: string; name: string; hash: string; created: string; lastUsed?: string
  scope?: Scope     // set only on dashboard tokens
  origin?: string   // exact origin; set on every dashboard token
  expires?: string  // ISO; absent = never (legacy native)
  ua?: string
}

/** How long a dashboard token lives when the caller doesn't say. */
export const DEFAULT_TTL_HOURS: Record<Scope, number> = { read: 90 * 24, write: 12 }

const stateDir = () => process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
const file = () => join(stateDir(), 'app-tokens.json')
const legacyFile = () => join(stateDir(), 'app-token')
const lockFile = () => file() + '.lock'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function read(): AppToken[] | null {
  try { return JSON.parse(readFileSync(file(), 'utf8')).tokens ?? [] } catch { return null }
}

/**
 * The tokens, carrying the single legacy token over on first read so a paired
 * phone keeps working. Unlocked: callers already inside withLock use this, since
 * the lock is not re-entrant.
 */
function readOrMigrate(): AppToken[] {
  const tokens = read()
  if (tokens) return tokens // also: another process imported it while we waited
  let t = ''
  try { t = readFileSync(legacyFile(), 'utf8').trim() } catch {}
  if (!t) return []
  const fresh = [{ id: randomBytes(3).toString('hex'), name: 'first device', hash: sha(t), created: new Date().toISOString() }]
  save(fresh)
  unlinkSync(legacyFile())
  return fresh
}

/** Takes the lock only on the one read that migrates. */
export function loadAppTokens(): AppToken[] {
  const tokens = read()
  if (tokens || !existsSync(legacyFile())) return tokens ?? []
  try { return withLock(readOrMigrate) } catch { return [] }
}

function save(tokens: AppToken[]): void {
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify({ tokens }, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file())
}

const lockHolder = () => { try { return readFileSync(lockFile(), 'utf8') } catch { return null } }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' } }

/**
 * Run a read-modify-write of app-tokens.json under an O_EXCL lockfile holding
 * the owner's pid, so the server stamping lastUsed can't write back a token the
 * CLI just revoked. Not re-entrant: inside fn, use readOrMigrate, never
 * loadAppTokens. A lock still held after 20 × 50 ms is taken over only when its
 * pid is gone (an empty one counts as gone); a live holder is an error.
 */
// ponytail: file lock, not a single writer; fine until a third writer appears.
// The steal re-reads the holder just before unlinking, which narrows but does not close two stealers racing.
export function withLock<T>(fn: () => T): T {
  let fd: number | undefined
  for (let i = 0; i < 21 && fd === undefined; i++) {
    try { fd = openSync(lockFile(), 'wx', 0o600) } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e
      if (i < 20) { Bun.sleepSync(50); continue }
      const holder = lockHolder()
      if (holder === null) { i--; continue } // released just now: try again
      if (Number(holder) > 0 && alive(Number(holder))) throw new Error(`app-tokens.json is locked by pid ${holder}`)
      if (lockHolder() === holder) try { unlinkSync(lockFile()) } catch {}
      i--
    }
  }
  const mine = String(process.pid)
  writeSync(fd!, mine)
  try { return fn() } finally {
    closeSync(fd!)
    if (lockHolder() === mine) try { unlinkSync(lockFile()) } catch {}
  }
}

/**
 * Mint a token. Passing `scope` or `origin` makes it a dashboard token: both
 * are then required (scope defaults to read), origin must be an exact
 * `scheme://host[:port]`, and it expires — after `ttlHours`, or the scope's default.
 */
export function createAppToken(name: string, opts: { scope?: Scope; origin?: string; ua?: string; ttlHours?: number } = {}): { id: string; token: string } {
  const dash = !!(opts.scope || opts.origin)
  if (dash && !opts.origin) throw new Error('a scoped token needs an origin')
  if (opts.origin && !isExactOrigin(opts.origin)) throw new Error(`not an exact origin: ${opts.origin}`)
  if (opts.scope && opts.scope !== 'read' && opts.scope !== 'write') throw new Error(`unknown scope: ${opts.scope}`)
  const scope = dash ? opts.scope ?? 'read' : undefined
  const hours = opts.ttlHours ?? (scope ? DEFAULT_TTL_HOURS[scope] : undefined)
  if (hours !== undefined && !(hours > 0)) throw new Error(`bad ttl: ${hours}`)
  const token = randomBytes(32).toString('base64url')
  const id = randomBytes(3).toString('hex')
  const now = Date.now()
  const t: AppToken = {
    id, name, hash: sha(token), created: new Date(now).toISOString(),
    ...(scope ? { scope, origin: opts.origin } : {}),
    ...(hours !== undefined ? { expires: new Date(now + hours * 3600_000).toISOString() } : {}),
    ...(opts.ua ? { ua: opts.ua.slice(0, 200) } : {}),
  }
  withLock(() => save([...readOrMigrate(), t]))
  return { id, token }
}

function isExactOrigin(o: string): boolean {
  try {
    const u = new URL(o)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === o
  } catch { return false }
}

export function revokeAppToken(id: string): boolean {
  return withLock(() => {
    const tokens = readOrMigrate()
    const kept = tokens.filter(t => t.id !== id)
    if (kept.length === tokens.length) return false
    save(kept)
    return true
  })
}

/** The token record an `Authorization` header belongs to, or null. Constant-time per entry; no expiry logic. */
export function findAppToken(header: string): AppToken | null {
  const m = /^Bearer (\S+)$/.exec(header)
  if (!m) return null
  const got = Buffer.from(sha(m[1]), 'hex')
  let hit: AppToken | null = null
  for (const t of loadAppTokens()) {
    if (timingSafeEqual(got, Buffer.from(t.hash, 'hex'))) hit = t
  }
  return hit
}

export const isExpired = (t: Pick<AppToken, 'expires'>) => !!t.expires && Date.parse(t.expires) < Date.now()
export const isDashToken = (t: AppToken) => !!t.origin || !!t.scope
/** Native tokens carry no scope and count as write. */
export const hasScope = (t: AppToken, need: Scope) => need === 'read' || (t.scope ?? 'write') === 'write'

/** Native routes only: the token id, or null for unknown, expired and dashboard tokens. */
export function checkAppToken(header: string): string | null {
  const t = findAppToken(header)
  return t && !isDashToken(t) && !isExpired(t) ? t.id : null
}

/** Same rule as checkAppToken, by id — the WebSocket sweep uses it. */
export const isLiveAppToken = (id: string) => loadAppTokens().some(t => t.id === id && !isDashToken(t) && !isExpired(t))

/** Every token without its hash, for a devices list. */
export const listAppTokens = (): Omit<AppToken, 'hash'>[] => loadAppTokens().map(({ hash, ...t }) => t)

/** Stamp lastUsed, at most once an hour per token so a chatty phone doesn't churn the file. */
export function touchAppToken(id: string): void {
  const stale = (t?: AppToken) => !!t && (!t.lastUsed || Date.now() - Date.parse(t.lastUsed) >= 3600_000)
  if (!stale(loadAppTokens().find(t => t.id === id))) return // the common case takes no lock
  withLock(() => {
    const tokens = readOrMigrate()
    const t = tokens.find(t => t.id === id)
    if (!stale(t)) return
    t!.lastUsed = new Date().toISOString()
    save(tokens)
  })
}

if (import.meta.main) {
  const { values: flags, positionals: [cmd, arg] } = parseArgs({
    args: process.argv.slice(2), allowPositionals: true, strict: false,
    options: { scope: { type: 'string' }, origin: { type: 'string' }, hours: { type: 'string' } },
  })
  if (cmd === 'new' && arg) {
    const scope = flags.scope as Scope | undefined, origin = flags.origin as string | undefined
    const hours = flags.hours === undefined ? undefined : Number(flags.hours)
    try {
      if (scope && !origin) throw new Error('--scope needs --origin: a dashboard token is bound to one origin')
      const { id, token } = createAppToken(arg, { scope, origin, ttlHours: hours })
      const t = loadAppTokens().find(t => t.id === id)!
      const kind = t.scope ? `${t.scope} for ${t.origin}` : 'native'
      console.log(`${id}  ${arg}  ${kind}${t.expires ? `  expires ${t.expires.slice(0, 16).replace('T', ' ')}` : ''}\n\n${token}\n\nShown once. Paste it into the app; revoke with: bun otto/apptokens.ts revoke ${id}`)
    } catch (e) {
      console.error(String((e as Error).message ?? e))
      process.exitCode = 2
    }
  } else if (cmd === 'list') {
    const tokens = listAppTokens()
    if (!tokens.length) console.log('no app tokens')
    for (const t of tokens) {
      const kind = t.scope ? `${t.scope} ${t.origin}` : 'native'
      const exp = t.expires ? `  expires ${t.expires.slice(0, 16).replace('T', ' ')}${isExpired(t) ? ' (expired)' : ''}` : ''
      console.log(`${t.id}  ${t.name.padEnd(20)}  ${kind}  created ${t.created.slice(0, 10)}  last used ${t.lastUsed?.slice(0, 16).replace('T', ' ') ?? 'never'}${exp}`)
    }
  } else if (cmd === 'revoke' && arg) {
    const ok = revokeAppToken(arg)
    console.log(ok ? `revoked ${arg}` : `no token ${arg}`)
    if (!ok) process.exitCode = 1
  } else {
    console.log('usage: bun otto/apptokens.ts new <name> [--scope read|write --origin https://…] [--hours N] | list | revoke <id>')
    process.exitCode = 2
  }
}
