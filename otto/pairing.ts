// Dashboard pairing — a device-code flow the user claims from their own Otto.
//
// The dashboard asks for a pairing (pair/start) and shows the user a code. The
// user types `pair <code>` to Otto on Telegram or in the app; Otto answers in
// process with what is asking (origin, scope, browser, where from) and
// approve/deny buttons. The tap mints a token, and the dashboard's next poll
// collects it, once.
//
// Nothing here ever notifies anyone: pair/start answers anyone who can reach /app,
// so it must not be able to make the phone buzz. The user starts the claim.
//
// Each button carries a fresh random nonce, minted when the code is claimed and
// kept only as a hash. It never appears in a pair/start or pair/poll response,
// a log line, or history, and validateButtons refuses model-sent `pair ` data,
// so the session cannot forge an approval. Nor can it relay a code: reply and
// edit_message refuse text carrying one that is pending (carriesPairingCode), so
// the only way a code reaches the user is the dashboard's own screen.
//
// The Origin a pairing names is whatever the client sent, and curl can send
// anything; the approval message says "claiming to be" for that reason, and the
// client's label is shown only as a quote.
//
// All state is one in-memory Map: a restart drops pending pairings and the
// dashboard's next poll says `expired`, which it answers with "try again".

import { createHash, randomBytes, randomInt } from 'crypto'
import { createAppToken, loadAppTokens, revokeAppToken, type Scope } from './apptokens.ts'

type Button = { label: string; data: string }
export type Send = (text: string, buttons: Button[]) => unknown
/** What the HTTP layer hands in about the request; dash.ts has already checked Host and Origin. */
export type PairContext = { origin: string; ip: string; via: 'funnel' | 'direct' }
export type PairResult = { status: number; body: Record<string, unknown> }

const EXPIRES_IN = 300            // seconds a code is good for, and an approved token waits for its poll
const INTERVAL = 3                // seconds between polls, as told to the client
const MIN_POLL_MS = 2500          // what is enforced: half a second of slack for network jitter
const MAX_PENDING = 20
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O, 1/I/L

type Entry = {
  userCode: string                // 8 chars, no dash
  codeHash: string                // sha256 of the device_code
  origin: string; scope: Scope; ua?: string; ip: string; via: PairContext['via']
  expiresAt: number
  lastPollAt: number
  nonceHash?: { read: string; write?: string } // set when the user claims the code
  status: 'pending' | 'approved' | 'denied'
  minted?: { token: string; id: string; scope: Scope; expires: string; read?: { token: string; id: string; expires: string } }
}

const pairings = new Map<string, Entry>()

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const shown = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

/** 203.0.113.x, or the first three groups of an IPv6 address. Never the whole thing. */
export function coarseIp(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+)\.\d+$/.exec(ip)
  if (v4) return `${v4[1]}.x`
  return ip.includes(':') ? `${ip.split(':').slice(0, 3).join(':')}:…` : '?'
}

function log(event: string, e: Pick<Entry, 'origin' | 'ip' | 'via'>, id?: string): void {
  process.stderr.write(`[dash] ${event} origin=${e.origin} ip=${coarseIp(e.ip)} via=${e.via}${id ? ` id=${id}` : ''}\n`)
}

/** Drop what has run out. An approved token nobody collected is revoked, so it can't linger in /devices. */
function sweep(now = Date.now()): void {
  for (const [code, e] of pairings) {
    if (e.expiresAt > now) continue
    pairings.delete(code)
    if (e.minted) revokeAppToken(e.minted.id)
    log(e.status === 'approved' ? 'pair-uncollected' : 'pair-expire', e, e.minted?.id)
  }
}

function newUserCode(): string {
  for (;;) {
    let c = ''
    for (let i = 0; i < 8; i++) c += ALPHABET[randomInt(ALPHABET.length)]
    if (!pairings.has(c)) return c
  }
}

/** The label is the client's own words about itself; it lands in the approval message as a quote, so keep it one short plain line with no quote marks of its own. */
const cleanLabel = (v: unknown) =>
  typeof v === 'string' ? v.replace(/[\p{C}"“”]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || undefined : undefined

/**
 * Whether outgoing text names a code that is waiting to be claimed, in any case
 * and with any separators. The session never relays one: a prompt-injected scan
 * telling the user to "send pair ABCD-EFGH to re-verify" is exactly this.
 */
export function carriesPairingCode(text: string): boolean {
  sweep()
  const flat = text.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return [...pairings.keys()].some(code => flat.includes(code))
}

/** POST pair/start. Per-IP rate limits are the caller's; the global cap is here. */
export function startPairing(body: unknown, ctx: PairContext): PairResult {
  sweep()
  const b = (body ?? {}) as { scope?: unknown; label?: unknown }
  const scope = b.scope ?? 'read'
  if (scope !== 'read' && scope !== 'write') return { status: 400, body: { error: 'scope' } }
  if (pairings.size >= MAX_PENDING) {
    // Full: the oldest code nobody has claimed makes room, so a flood can't lock
    // the user's own dashboard out. A claimed or approved one is never displaced.
    const victim = [...pairings.values()].find(e => e.status === 'pending' && !e.nonceHash)
    if (!victim) return { status: 409, body: { error: 'busy' } }
    pairings.delete(victim.userCode)
    log('pair-evict', victim)
  }
  const deviceCode = randomBytes(32).toString('base64url')
  const userCode = newUserCode()
  const now = Date.now()
  const e: Entry = {
    userCode, codeHash: sha(deviceCode), origin: ctx.origin, scope, ua: cleanLabel(b.label), ip: ctx.ip, via: ctx.via,
    expiresAt: now + EXPIRES_IN * 1000, lastPollAt: now, status: 'pending',
  }
  pairings.set(userCode, e)
  log('pair-start', e)
  return { status: 200, body: { device_code: deviceCode, user_code: shown(userCode), expires_in: EXPIRES_IN, interval: INTERVAL } }
}

/** POST pair/poll. Only the origin that started a pairing can collect it. */
export function pollPairing(body: unknown, ctx: Pick<PairContext, 'origin'>): PairResult {
  sweep()
  const code = (body as { device_code?: unknown } | null)?.device_code
  if (typeof code !== 'string' || !code || code.length > 100) return { status: 400, body: { error: 'device_code' } }
  const hash = sha(code)
  const e = [...pairings.values()].find(e => e.codeHash === hash && e.origin === ctx.origin)
  if (!e) return { status: 200, body: { status: 'expired' } }
  const now = Date.now()
  const early = now - e.lastPollAt < MIN_POLL_MS
  e.lastPollAt = now // every poll resets the clock, so hammering never gets through
  if (early) return { status: 429, body: { error: 'slow_down' } }
  if (e.status === 'pending') return { status: 200, body: { status: 'pending' } }
  pairings.delete(e.userCode)
  if (e.status === 'denied') return { status: 200, body: { status: 'denied' } }
  log('pair-collect', e, e.minted!.id)
  return { status: 200, body: { status: 'approved', ...e.minted! } }
}

/**
 * `pair XKQ4-7MPD`, typed by the user. Returns true when the text was a pairing
 * command — answered here, never passed to the session. Call it only after the
 * sender has been checked as the user.
 */
export async function pairingCommand(text: string, send: Send): Promise<boolean> {
  const m = /^pair ([A-Z0-9]{4}-?[A-Z0-9]{4})$/i.exec(text.trim())
  if (!m) return false
  sweep()
  const e = pairings.get(m[1].replace('-', '').toUpperCase())
  if (!e || e.status !== 'pending') {
    await send('no pairing request with that code', [])
    return true
  }
  // Fresh nonces on every claim: typing the code again kills the older buttons.
  const nonce = () => randomBytes(16).toString('base64url')
  const read = nonce(), write = e.scope === 'write' ? nonce() : undefined
  e.nonceHash = { read: sha(read), ...(write ? { write: sha(write) } : {}) }
  log('pair-claim', e)
  const mins = Math.max(1, Math.ceil((e.expiresAt - Date.now()) / 60_000))
  const wants = e.scope === 'write' ? 'read + control' : 'read-only'
  const where = `${e.via === 'funnel' ? 'via tailscale serve' : 'direct'} from ${coarseIp(e.ip)}`
  await send(
    [
      `Dashboard pairing ${shown(e.userCode)}`,
      `a browser claiming to be ${e.origin}`,
      [`wants ${wants}`, where, e.ua && `says it is "${e.ua}"`].filter(Boolean).join(' · '),
      `Approve only if this code is on your screen. Expires in ${mins} min.`,
    ].join('\n'),
    [
      { label: 'approve read-only', data: `pair ok ${read}` },
      ...(write ? [{ label: 'approve read + control', data: `pair ok ${write}` }] : []),
      { label: 'deny', data: `pair no ${read}` },
    ],
  )
  return true
}

/**
 * A tapped pairing button. Returns the line to show the user, or null when the
 * data isn't a pairing button. Anything starting `pair ` is claimed, even a
 * stale or malformed one, so pairing data never reaches the session.
 */
export function pairingButton(data: string): string | null {
  if (!data.startsWith('pair ')) return null
  sweep()
  const m = /^pair (ok|no) ([A-Za-z0-9_-]{22})$/.exec(data)
  const hash = m && sha(m[2])
  const e = hash && [...pairings.values()].find(e => e.status === 'pending' && (e.nonceHash?.read === hash || e.nonceHash?.write === hash))
  if (!m || !e) return 'that pairing request is gone — start again from the dashboard'
  // Which button was tapped decides the scope, never what the dashboard asked for.
  const scope: Scope = hash === e.nonceHash!.write ? 'write' : 'read'
  e.nonceHash = undefined // one tap per claim
  if (m[1] === 'no') {
    e.status = 'denied'
    log('pair-deny', e)
    return `denied ${shown(e.userCode)}`
  }
  const name = `dashboard ${new URL(e.origin).hostname}`
  const { id, token } = createAppToken(name, { scope, origin: e.origin, ua: e.ua })
  const expiry = (tid: string) => loadAppTokens().find(t => t.id === tid)!.expires!
  // Control lasts 12 h and dies with the tab, so it comes with a 90-day read token:
  // a new tab or a restarted browser falls back to reading instead of asking to pair again.
  const read = scope === 'write' ? createAppToken(name, { scope: 'read', origin: e.origin, ua: e.ua }) : undefined
  // The tokens wait here for the dashboard's next poll, for as long as a code would.
  e.minted = { token, id, scope, expires: expiry(id), ...(read ? { read: { token: read.token, id: read.id, expires: expiry(read.id) } } : {}) }
  e.status = 'approved'
  e.expiresAt = Date.now() + EXPIRES_IN * 1000
  log('pair-approve', e, id)
  return `paired ✓ dashboard (${scope === 'write' ? 'read + control' : 'read-only'}) · revoke from /devices or bun otto/apptokens.ts revoke ${id}`
}
