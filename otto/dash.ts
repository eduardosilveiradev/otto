// Dashboard API — /app/dash/*, for the otto-dash web app.
//
// A browser on another origin reads Otto's state through here, over the same
// tailscale serve address as the iOS app (tailnet only, never Funnel). Everything is JSON, and every response is an explicit
// pick of the store record behind it (dash-types.ts is the wire contract), so a
// field added to a store never reaches a browser by accident.
//
// The order inside handleDash is the security model, and it is fixed:
//   Host (421, against DNS rebinding) → ping (any origin) → Origin allowlist
//   (403, no CORS headers) → OPTIONS → pair/* (unauthenticated) → bearer token
//   (401) → expiry (401) → token bound to this Origin (403) → scope (403) → route.
//
// The allowlist is dash.json in the state dir (OTTO_DASH_CONFIG overrides the
// path, which the dev harness uses so it never writes the real one):
//   bun otto/dash.ts allow <origin> [--hours N]   localhost and *.vercel.app default to 24 h
//   bun otto/dash.ts deny <origin>
//   bun otto/dash.ts list

import { createHash } from 'crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { parseArgs } from 'util'
import type * as D from './dash-types.ts'
import { findAppToken, hasScope, isDashToken, isExpired, listAppTokens, revokeAppToken, touchAppToken, type AppToken, type Scope } from './apptokens.ts'
import { coarseIp, pollPairing, startPairing } from './pairing.ts'
import { collectStatus, recentRepairLines, type StatusDeps } from './status.ts'
import { gistOf, type BriefData } from './brief.ts'
import { VIEWER_JSON, peopleCards, readNotes, readPeople, scopeLabel, searchMemory, type Graph, type Item } from './memviewer.ts'
import { loadMoney, queryMoney, totalsByCategory, totalsByCurrency, totalsByMonth } from './money.ts'
import { PLACE_KINDS, PLACE_STATUSES, fold, queryPlaces, readPlaces } from './places.ts'
import { proactivityReport } from './ledger.ts'
import { type ChatEntry, type ChatFeed, CHAT_WAIT_MS } from './chatfeed.ts'
import { loadTrips, tripProblems, type ZonedTime } from './trips.ts'
import { activePackages, carrierName, loadPackages, markDelivered, trackingUrl, type PackageRecord } from './packages.ts'
import { currentOrNextTrip } from './triplife.ts'
import { loadLog } from './changelog.ts'
import { loadJobs } from './jobs.ts'
import { recentClosures, resolveConfig, runHygiene } from './hygiene.ts'
import type { Note } from './store.ts'

/** The server's Trigger, as far as this file reads it. */
export type DashTrigger = {
  id: string; type: 'cron' | 'email'; schedule?: string; action: string
  repeating: boolean; enabled: boolean; nextRun?: number; lastFired?: string
}

/** What server.ts hands in. Writes go through its existing /app handlers, untouched. */
export type DashDeps = {
  stateDir: string
  brief: () => BriefData | null
  statusDeps: () => StatusDeps
  appSettings: (req: Request) => Promise<Response>
  appSnooze: (req: Request) => Promise<Response>
  appLoop: (req: Request) => Promise<Response>
  loadTriggers: () => DashTrigger[]
  readHistory: (chat_id: string | undefined, limit: number) => ChatEntry[]
  /** Defaults to memviewer's searchMemory; tests stub it. */
  search?: (q: string) => Promise<{ results: [number, number][] } | { error: string }>
  /** Defaults to a detached `bun memviewer.ts --refresh`; tests and dash-dev stub it. */
  rebuild?: () => { exited: Promise<unknown> }
  /** The live feed recordHistory fills; dash-dev tails history.jsonl into one. */
  chat: ChatFeed
  /** Delivers a dashboard-typed message into the app thread. Absent (dash-dev), POST chat answers 501 preview. */
  sendApp?: (text: string, id: string) => Promise<void>
  /** callbot's relay, which owns live calls. Defaults to it on loopback; tests stub it. */
  relay?: (path: string, init?: RequestInit) => Promise<Response>
}

/** Bun.Server, as far as clientIp needs it. */
export type DashServer = { requestIP(req: Request): { address: string } | null }

export const BODY_MAX = 64 * 1024

/** Keys that must never leave the Mac. pick() refuses them; the tests sweep every response for them. */
export const FORBIDDEN_KEYS = new Set([
  'undo', 'source', 'sources', 'pnr', 'pnrs', 'confirmation', 'seat', 'address', 'revert',
  'scratchDir', 'pid', 'hash', 'addresses', 'phones', 'handles', 'chatId', 'chat_id',
  'recommenderId',
])

// ---------------------------------------------------------------------------
// Allowlist (dash.json)
// ---------------------------------------------------------------------------

export type DashConfig = { origins: Record<string, { until?: string }>; host?: string }

const defaultStateDir = () => process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
export const configPath = (stateDir = defaultStateDir()) => process.env.OTTO_DASH_CONFIG ?? join(stateDir, 'dash.json')

/** A missing or corrupt file allows nothing: the gate fails closed. */
export function loadDashConfig(file = configPath()): DashConfig {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'))
    return { origins: c?.origins && typeof c.origins === 'object' ? c.origins : {}, ...(typeof c?.host === 'string' ? { host: c.host } : {}) }
  } catch { return { origins: {} } }
}

/** Expired entries are pruned on every write. */
export function saveDashConfig(cfg: DashConfig, file = configPath(), now = Date.now()): void {
  const origins = Object.fromEntries(Object.entries(cfg.origins).filter(([, e]) => !expired(e, now)))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file + '.tmp', JSON.stringify({ ...cfg, origins }, null, 2) + '\n', { mode: 0o600 })
  renameSync(file + '.tmp', file)
}

const expired = (e: { until?: string }, now: number) => !!e.until && !(Date.parse(e.until) > now)

/** Exact match only: no wildcard, no reflection. An entry past its `until` is ignored. */
export function originAllowed(cfg: DashConfig, origin: string, now = Date.now()): boolean {
  const e = Object.hasOwn(cfg.origins, origin) ? cfg.origins[origin] : undefined
  return !!e && !expired(e, now)
}

/** The production dashboard is https on a real hostname; anything else is a dev or preview origin. */
export function isPreviewOrigin(origin: string): boolean {
  const u = new URL(origin)
  return u.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.vercel.app')
}

const isExactOrigin = (o: string) => { try { const u = new URL(o); return /^https?:$/.test(u.protocol) && u.origin === o } catch { return false } }

/**
 * tailscale serve keeps this machine's ts.net name in Host; a rebinding attack arrives
 * with its own name instead. The name is dash.json's `host`, else the one the
 * server learnt from the app (public-base). Only with neither is any *.ts.net
 * name let through, so a fresh install still answers before its first app call.
 */
export function hostAllowed(host: string | null, cfg: DashConfig, known = cfg.host): boolean {
  const bare = (h: string) => h.toLowerCase().replace(/^https?:\/\//, '').replace(/:\d+$/, '').replace(/\/.*$/, '')
  const h = bare(host ?? '')
  if (['localhost', '127.0.0.1', '[::1]'].includes(h)) return true
  // A literal private address, so a browser on the home network can reach the Mac by IP. A rebinding
  // attack arrives under the attacker's hostname, never as a bare IP, so these stay safe to let in.
  if (/^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/.test(h)) return true
  return known ? h === bare(known) : h.endsWith('.ts.net')
}

/** The ts.net base server.ts records from authenticated app calls, if any. */
function learntHost(stateDir: string): string | undefined {
  try { return readFileSync(join(stateDir, 'public-base'), 'utf8').trim() || undefined } catch { return undefined }
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

const BASE_HEADERS = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', vary: 'Origin',
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
  }
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'content-type': 'application/json', ...extra } })

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * tailscale serve connects from loopback and appends the real client to X-Forwarded-For,
 * so behind a loopback socket the rightmost entry is the one to trust. From any
 * other socket the header is the client's own word and is ignored.
 */
export function clientIp(req: Request, server: DashServer): { ip: string; via: 'funnel' | 'direct' } {
  const sock = server.requestIP(req)?.address ?? ''
  const last = req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()
  return LOOPBACK.has(sock) && last ? { ip: last, via: 'funnel' } : { ip: sock, via: 'direct' }
}

const hits = new Map<string, number[]>()

/** True while `key` has had fewer than `n` hits in the last `windowMs`; counts this one if so. */
// ponytail: in-memory, resets on restart
export function rateLimit(key: string, n: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter(t => now - t < windowMs)
  const ok = recent.length < n
  if (ok) recent.push(now)
  hits.set(key, recent)
  // The longest window is an hour; anything quiet that long has nothing left to count.
  if (hits.size > 10_000) for (const [k, ts] of hits) if (!ts.length || now - ts.at(-1)! > 3600_000) hits.delete(k)
  return ok
}

/**
 * The body as parsed JSON, read with a running cap so a chunked upload without
 * Content-Length can't stream past it. Empty is `{}`; anything but an object is 400.
 */
export async function readJson(req: Request, max = BODY_MAX): Promise<{ body: Record<string, unknown> } | { status: 400 | 413; error: string }> {
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = req.body?.getReader()
  for (;;) {
    const r = await reader?.read()
    if (!r || r.done) break
    size += r.value.byteLength
    if (size > max) { void reader!.cancel().catch(() => {}); return { status: 413, error: 'too_large' } }
    chunks.push(r.value)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return { body: {} }
  try {
    const body = JSON.parse(text)
    return body && typeof body === 'object' && !Array.isArray(body) ? { body } : { status: 400, error: 'bad_json' }
  } catch { return { status: 400, error: 'bad_json' } }
}

/** An explicit field pick, never a spread: the only way a store record becomes a response. Undefined fields are dropped. */
export function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const k of keys) {
    if (FORBIDDEN_KEYS.has(k as string)) throw new Error(`forbidden key in a DTO: ${String(k)}`)
    if (obj[k] !== undefined) out[k] = obj[k]
  }
  return out
}

function readJsonFile<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return null }
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

const DEVICE_KEYS = ['id', 'name', 'created', 'lastUsed', 'scope', 'origin', 'expires', 'ua'] as const
const ITEM_KEYS = ['id', 'store', 'kind', 'scope', 'name', 'description', 'updated', 'status', 'due', 'tags', 'closedReason', 'hits', 'lastHitDays', 'badge'] as const
const LOOP_KEYS = ['id', 'text', 'tags', 'createdAt', 'updatedAt', 'due', 'status', 'closedReason', 'closedBy', 'closedAt', 'reopenedAt', 'deferrals'] as const
const JOB_KEYS = ['id', 'task', 'state', 'createdAt', 'startedAt', 'endedAt', 'tools', 'wallClockMs', 'tokenBudget', 'tokensUsed', 'costUsd', 'tags', 'result', 'partial', 'error', 'notBefore'] as const
const ZONED_KEYS = ['local', 'zone', 'offsetMinutes', 'utc'] as const
const PACKAGE_KEYS = ['id', 'carrier', 'tracking', 'merchant', 'item', 'status', 'eta', 'etaLatest', 'updatedAt', 'deliveredAt'] as const

const CHAT_LIMIT = 100
const CHAT_ID_RE = /^[A-Za-z0-9-]{8,64}$/
const CHAT_TEXT_MAX = 4000
/** The owner's Telegram chat, read when asked from access.json; it names the thread server-side and never reaches the browser. */
const ownerChat = (stateDir: string) => readJsonFile<{ allowFrom?: string[] }>(join(stateDir, 'access.json'))?.allowFrom?.[0]
const threadChat = (thread: D.ChatThread, stateDir: string): string | undefined => (thread === 'app' ? 'app' : ownerChat(stateDir))
/** A history line as a bubble. Reactions are not bubbles; a line with no message id gets a stable one from its timestamp.
 * Serves both the history read and the live feed. */
const chatRows = (es: ChatEntry[]): D.ChatMessage[] =>
  es.filter(e => e.kind !== 'reaction' && e.kind !== 'terminal' /* until the dashboard renders it */).map(e => ({ ...pick(e, ['dir', 'kind', 'text', 'ts']), id: e.message_id ?? `${e.ts}|${e.dir}` }))

/**
 * A durable memory's id is `<scope>/<name>`, and a project scope is a cwd slug
 * with the macOS username in it. The browser puts ids in URLs, so it gets a
 * short hash for the id and the readable label for the scope.
 */
const publicId = (it: Item) => (it.store === 'durable' ? 'm' + createHash('sha256').update(it.id).digest('hex').slice(0, 12) : it.id)
const listItem = (it: Item, scopes: Record<string, string>): D.MemoryItem =>
  ({ ...pick(it, ITEM_KEYS), id: publicId(it), scope: scopes[it.scope] ?? scopeLabel(it.scope) })
const loopRow = (n: Note): D.LoopRow => pick(n, LOOP_KEYS)
const zoned = (t: ZonedTime): D.ZonedTime => pick(t, ZONED_KEYS)

/** One line of the action, never the whole of it: actions carry context meant for a cold agent. */
function triggerRows(ts: DashTrigger[]): D.TriggerRow[] {
  return ts.map(t => {
    const g = gistOf(t.action)
    return { ...pick(t, ['id', 'type', 'schedule', 'repeating', 'enabled', 'nextRun', 'lastFired']), gist: g.length > 80 ? g.slice(0, 79).trimEnd() + '…' : g }
  })
}

type Viewer = { items: Item[]; summary: { text: string; note: string }; generatedAt: string; graph: Graph; scopes: Record<string, string> }
let viewerCache: { file: string; stamp: number; data: Viewer } | null = null

/** memory-viewer.json (written by memviewer.ts), re-parsed only when its mtime moves. */
function readViewer(stateDir: string): Viewer | null {
  const file = join(stateDir, VIEWER_JSON)
  let stamp: number
  try { stamp = statSync(file).mtimeMs } catch { return null }
  if (viewerCache?.file !== file || viewerCache.stamp !== stamp) viewerCache = { file, stamp, data: JSON.parse(readFileSync(file, 'utf8')) }
  return viewerCache.data
}

const graphDto = (g: Graph): D.MemoryGraph => ({
  ...pick(g, ['links', 'similar', 'floor', 'c', 'noise', 'note']),
  ...(g.clusters ? { clusters: g.clusters.map(c => pick(c, ['id', 'size', 'label', 'terms', 'x', 'y'])) } : {}),
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type Ctx = {
  req: Request; url: URL; deps: DashDeps
  origin?: string; ip: string; via: 'funnel' | 'direct'
  cors: Record<string, string>
  token: AppToken
}

const REASON: Record<number, string> = { 400: 'bad_request', 404: 'not_found', 405: 'method', 409: 'conflict', 501: 'not_implemented' }

const reply = (c: Pick<Ctx, 'cors'>, body: unknown, status = 200) => json(body, status, c.cors)

/** The parsed body, re-wrapped for an existing /app handler: the original stream is already consumed. */
async function delegate(c: Ctx, fn: (req: Request) => Promise<Response>, shape: (j: any) => unknown): Promise<Response> {
  let inner = c.req
  if (c.req.method !== 'GET') {
    const r = await readJson(c.req)
    if (!('body' in r)) return reply(c, { error: r.error }, r.status)
    inner = new Request(c.req.url, { method: c.req.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(r.body) })
  }
  const res = await fn(inner)
  if (!res.ok) return reply(c, { error: REASON[res.status] ?? 'failed' }, res.status)
  return reply(c, shape(await res.json()))
}

function log(event: string, c: Pick<Ctx, 'origin' | 'ip' | 'via'>, id?: string): void {
  process.stderr.write(`[dash] ${event} origin=${c.origin ?? '-'} ip=${coarseIp(c.ip)} via=${c.via}${id ? ` id=${id}` : ''}\n`)
}

/** An IPv4 address as it is; an IPv6 one as its /64, the block one subscriber holds. */
export function rateKey(ip: string): string {
  if (!ip.includes(':') || /^::ffff:\d/i.test(ip)) return ip
  const [head, tail] = ip.split('%')[0].split('::')
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : []
  const full = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
  return full.slice(0, 4).map(g => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64'
}

const days = (v: string | null, dflt: number) => Math.min(Math.max(1, Number(v) || dflt), 365)

let rebuilding = false

type Route = { scope: Scope; run: (c: Ctx) => unknown | Promise<unknown> }

const routes: Record<string, Route> = {
  'GET me': { scope: 'read', run: c => pick(c.token, ['id', 'name', 'scope', 'origin', 'created', 'expires', 'lastUsed']) satisfies D.Me },

  'GET devices': { scope: 'read', run: () => ({ devices: listAppTokens().map(t => pick(t, DEVICE_KEYS)) }) satisfies D.Devices },

  'POST signout': {
    scope: 'read', run: c => {
      revokeAppToken(c.token.id)
      log('revoke', c, c.token.id)
      return { revoked: true } satisfies D.Revoked
    },
  },

  'GET status': {
    scope: 'read', run: async c => {
      const sd = c.deps.statusDeps()
      const rows = await collectStatus(sd)
      return { now: sd.now, rows: rows.map(r => pick(r, ['id', 'label', 'verdict', 'at', 'detail'])), repairs: recentRepairLines(c.deps.stateDir).reverse() } satisfies D.DashStatus
    },
  },

  'GET brief': {
    scope: 'read', run: c => {
      const b = c.deps.brief()
      if (!b) return reply(c, { error: 'no_brief' }, 503)
      return {
        asOf: b.asOf,
        events: b.events?.map(e => pick(e, ['title', 'start', 'minutes'])) ?? null,
        inbox: b.inbox?.map(m => pick(m, ['from', 'subject'])) ?? null,
        bulk: b.bulk,
        loops: b.loops.map(l => pick(l, ['id', 'title', 'due'])),
        triggers: b.triggers.map(t => pick(t, ['title', 'next'])),
      } satisfies D.DashBrief
    },
  },

  'GET memory': {
    scope: 'read', run: c => {
      const v = readViewer(c.deps.stateDir)
      if (!v) return reply(c, { error: 'no_viewer' }, 404)
      const items = v.items.map(it => listItem(it, v.scopes))
      const scopes = Object.fromEntries(items.map(i => [i.scope, i.scope]))
      return { items, summary: pick(v.summary, ['text', 'note']), generatedAt: v.generatedAt, graph: graphDto(v.graph), scopes } satisfies D.DashMemory
    },
  },

  'GET memory/item': {
    scope: 'read', run: c => {
      const v = readViewer(c.deps.stateDir)
      const it = v?.items.find(i => publicId(i) === c.url.searchParams.get('id'))
      if (!it) return reply(c, { error: 'not_found' }, 404)
      return { ...listItem(it, v!.scopes), body: it.body } satisfies D.MemoryItemDetail
    },
  },

  'GET memory/search': {
    scope: 'read', run: async c => {
      if (!rateLimit(`search:${c.token.id}`, 10, 60_000)) return reply(c, { error: 'rate_limited' }, 429)
      const q = c.url.searchParams.get('q') ?? ''
      const r = await (c.deps.search ?? (q => searchMemory(q, { dir: c.deps.stateDir })))(q)
      if ('error' in r) return reply(c, { error: r.error }, 503)
      return { results: r.results } satisfies D.MemorySearch
    },
  },

  'POST memory/rebuild': {
    scope: 'write', run: c => {
      if (rebuilding) return reply(c, { error: 'running' }, 409)
      const proc = (c.deps.rebuild ?? (() => Bun.spawn(['bun', join(import.meta.dir, 'memviewer.ts'), '--refresh'], {
        env: { ...process.env, OTTO_STATE_DIR: c.deps.stateDir }, stdio: ['ignore', 'ignore', 'ignore'],
      })))()
      rebuilding = true
      void proc.exited.catch(() => {}).finally(() => { rebuilding = false })
      return reply(c, { started: true } satisfies D.MemoryRebuild, 202)
    },
  },

  'GET people': {
    scope: 'read', run: c => {
      // Mentions index into memory-viewer.json's items, so they come from the same file.
      const items = readViewer(c.deps.stateDir)?.items ?? []
      const cards = peopleCards(readPeople(join(c.deps.stateDir, 'people.json')), items).map(p => ({
        ...pick(p, ['name', 'relationship', 'city', 'timezone', 'org', 'inbound', 'outbound', 'lastContact', 'mentions']),
        notes: p.notes.map(n => pick(n, ['at', 'text'])),
      }))
      return { cards } satisfies D.People
    },
  },

  'GET places': {
    scope: 'read', run: c => {
      const q = (k: string) => c.url.searchParams.get(k)?.trim() || undefined
      const city = q('city'), kind = q('kind')?.toLowerCase(), status = q('status')?.toLowerCase(), text = q('q')
      if (city && !/^[\p{L}\p{N} .'’-]{1,60}$/u.test(city)) return reply(c, { error: 'city' }, 400)
      if (kind && !(PLACE_KINDS as readonly string[]).includes(kind)) return reply(c, { error: 'kind' }, 400)
      if (status && !(PLACE_STATUSES as readonly string[]).includes(status)) return reply(c, { error: 'status' }, 400)
      if (text && text.length > 80) return reply(c, { error: 'q' }, 400)
      const all = readPlaces(join(c.deps.stateDir, 'places.json'))
      // Cities fold together the way records do: "Lisboa" and "lisboa" are one entry, first spelling kept.
      const cities = new Map<string, { city: string; count: number }>()
      for (const p of all) {
        const e = cities.get(fold(p.city)) ?? { city: p.city, count: 0 }
        e.count++
        cities.set(fold(p.city), e)
      }
      return {
        places: queryPlaces(all, { city, kind, status, text }).map(p => ({
          ...pick(p, ['id', 'name', 'city', 'kind', 'status', 'recommendedBy', 'tags', 'createdAt', 'updatedAt']),
          notes: p.notes.map(n => pick(n, ['at', 'text'])),
        })),
        cities: [...cities.values()].sort((a, b) => b.count - a.count || a.city.localeCompare(b.city)),
      } satisfies D.DashPlaces
    },
  },

  'GET settings': { scope: 'read', run: c => delegate(c, c.deps.appSettings, j => settingsDto(c, j)) },
  'POST settings': { scope: 'write', run: c => delegate(c, c.deps.appSettings, j => settingsDto(c, j)) },
  'GET snooze': { scope: 'read', run: c => delegate(c, c.deps.appSnooze, snoozeDto) },
  'POST snooze': { scope: 'write', run: c => delegate(c, c.deps.appSnooze, snoozeDto) },
  'POST loop': { scope: 'write', run: c => delegate(c, c.deps.appLoop, j => ({ id: String(j.id), done: !!j.done }) satisfies D.LoopResult) },

  'GET loops': {
    scope: 'read', run: c => {
      const notesFile = join(c.deps.stateDir, 'notes.json')
      // memviewer's reader throws on a corrupt file rather than moving it aside, so a read never rearranges the store.
      const notes = readNotes(notesFile)
      const access = readJsonFile<{ hygiene?: Record<string, unknown> }>(join(c.deps.stateDir, 'access.json'))
      const { plan } = runHygiene({ notesFile, stateFile: join(c.deps.stateDir, 'hygiene.json'), config: resolveConfig(access?.hygiene), dryRun: true })
      return {
        open: notes.filter(n => n.kind === 'loop' && (n.status ?? 'open') === 'open').map(loopRow),
        plan: {
          close: plan.close.map(x => pick(x, ['id', 'status', 'reason'])),
          propose: plan.propose.map(x => pick(x, ['id', 'text', 'reason'])),
          avoidance: plan.avoidance.map(x => pick(x, ['id', 'text', 'deferrals', 'dues'])),
        },
        recent: recentClosures(notes, Date.now() - 30 * 86_400_000).map(loopRow),
      } satisfies D.DashLoops
    },
  },

  'GET money': {
    scope: 'read', run: c => {
      const month = c.url.searchParams.get('month') ?? undefined
      const currency = c.url.searchParams.get('currency')?.toUpperCase() || undefined
      const category = c.url.searchParams.get('category')?.toLowerCase() || undefined
      if (month && !/^\d{4}-\d{2}$/.test(month)) return reply(c, { error: 'month' }, 400)
      if (currency && !/^[A-Z]{3}$/.test(currency)) return reply(c, { error: 'currency' }, 400)
      if (category && !/^[\p{L}\p{N} _-]{1,40}$/u.test(category)) return reply(c, { error: 'category' }, 400)
      const all = loadMoney(join(c.deps.stateDir, 'money.json'))
      const inMonth = queryMoney(all, { month })
      const byCurrency = totalsByCurrency(inMonth)
      // byCategory needs one currency; without a request, the most used one.
      const cur = currency ?? byCurrency[0]?.currency
      // A category narrows the charges and the monthly series. byCategory and byCurrency stay
      // whole, because they are what the user picks a category or a currency from.
      return {
        records: queryMoney(inMonth, { currency, category }).map(r => pick(r, ['id', 'merchant', 'amount', 'currency', 'date', 'category', 'method', 'note', 'createdAt'])),
        byCurrency,
        byMonth: totalsByMonth(category ? queryMoney(all, { category }) : all),
        byCategory: cur ? totalsByCategory(inMonth, cur) : [],
      } satisfies D.DashMoney
    },
  },

  'GET chat': {
    scope: 'read', run: async c => {
      const thread = c.url.searchParams.get('thread')
      if (thread !== 'app' && thread !== 'telegram') return reply(c, { error: 'thread' }, 400)
      const chat_id = threadChat(thread, c.deps.stateDir)
      const feed = c.deps.chat
      const typing = () => thread === 'app' && feed.typing
      const after = c.url.searchParams.get('after')
      if (after === null) {
        return { thread, messages: chat_id ? chatRows(c.deps.readHistory(chat_id, CHAT_LIMIT)) : [], cursor: feed.seq, typing: typing() } satisfies D.DashChat
      }
      const n = Number(after)
      if (!/^\d+$/.test(after) || !Number.isSafeInteger(n)) return reply(c, { error: 'after' }, 400)
      // A cursor ahead of ours is from before a restart: the client reloads history.
      if (n > feed.seq) return { thread, messages: [], cursor: feed.seq, typing: typing(), reset: true } satisfies D.DashChat
      let rows = chat_id ? chatRows(feed.since(n, chat_id)) : []
      if (!rows.length) {
        await feed.wait(CHAT_WAIT_MS, c.req.signal)
        rows = chat_id ? chatRows(feed.since(n, chat_id)) : []
      }
      return { thread, messages: rows, cursor: feed.seq, typing: typing() } satisfies D.DashChat
    },
  },

  'POST chat': {
    scope: 'write', run: async c => {
      const r = await readJson(c.req)
      if (!('body' in r)) return reply(c, { error: r.error }, r.status)
      const { thread, id, text } = r.body
      // Telegram is read-only here: the bot can only post as itself, so a line typed here could never be the user's on their phone.
      if (thread !== 'app') return reply(c, { error: 'thread' }, 400)
      if (typeof id !== 'string' || !CHAT_ID_RE.test(id)) return reply(c, { error: 'id' }, 400)
      if (typeof text !== 'string' || !text.trim() || text.length > CHAT_TEXT_MAX) return reply(c, { error: 'text' }, 400)
      // A pairing code is claimed from the phone, where the approve buttons land.
      if (/^pair\s/i.test(text.trim())) return reply(c, { error: 'pairing' }, 400)
      if (!c.deps.sendApp) return reply(c, { error: 'preview' }, 501)
      if (!c.deps.chat.claim(id)) return { id, duplicate: true } satisfies D.ChatSent
      await c.deps.sendApp(text.trim(), id)
      log('chat-send', c, c.token.id)
      return { id } satisfies D.ChatSent
    },
  },

  'GET calls': {
    scope: 'read', run: async c => {
      const id = c.url.searchParams.get('id'), after = c.url.searchParams.get('after')
      if (id !== null && !CALL_ID_RE.test(id)) return reply(c, { error: 'id' }, 400)
      if (after !== null && !/^\d{1,9}$/.test(after)) return reply(c, { error: 'after' }, 400)
      const r = await toRelay(c, id ? `/calls/${id}${after !== null ? `?after=${after}` : ''}` : '/calls', { signal: c.req.signal })
      if (r instanceof Response) return r
      return id ? callDto(r) : { calls: (r.calls ?? []).map(callDto) } satisfies D.DashCalls
    },
  },

  'POST calls/control': {
    scope: 'write', run: async c => {
      const b = await readJson(c.req)
      if (!('body' in b)) return reply(c, { error: b.error }, b.status)
      const { id, action, text } = b.body
      if (typeof id !== 'string' || !CALL_ID_RE.test(id)) return reply(c, { error: 'id' }, 400)
      if (!['say', 'tell', 'end', 'takeover'].includes(action as string)) return reply(c, { error: 'action' }, 400)
      if (text !== undefined && (typeof text !== 'string' || text.length > 500)) return reply(c, { error: 'text' }, 400)
      const r = await toRelay(c, `/calls/${id}/control`, { method: 'POST', body: JSON.stringify({ action, text }) }, true)
      if (r instanceof Response) return r
      log(`call-${action}`, c, c.token.id)
      return { ok: !!r.ok, ...(r.error ? { error: String(r.error) } : {}) } satisfies D.CallControlResult
    },
  },

  'POST calls/listen': {
    scope: 'read', run: async c => {
      const b = await readJson(c.req)
      if (!('body' in b)) return reply(c, { error: b.error }, b.status)
      if (typeof b.body.id !== 'string' || !CALL_ID_RE.test(b.body.id)) return reply(c, { error: 'id' }, 400)
      const r = await toRelay(c, `/calls/${b.body.id}/ticket`, { method: 'POST' })
      if (r instanceof Response) return r
      return { url: String(r.url) } satisfies D.CallListen
    },
  },

  'GET proactivity': {
    scope: 'read', run: c => {
      const since = Date.now() - days(c.url.searchParams.get('days'), 30) * 86_400_000
      return { stats: proactivityReport(c.deps.readHistory(undefined, 2000), { since }).map(s => pick(s, ['src', 'sent', 'engaged', 'silentStreak', 'lastSent', 'lastEngaged'])) } satisfies D.Proactivity
    },
  },

  'GET trips': {
    scope: 'read', run: c => {
      const trips = loadTrips(join(c.deps.stateDir, 'trips.json'))
      const cur = currentOrNextTrip(trips, Date.now())
      return {
        trips: trips.map(t => ({
          ...pick(t, ['id', 'start', 'end', 'updatedAt']),
          segments: t.segments.map((s): D.FlightRow | D.StayRow => s.kind === 'flight'
            ? { ...pick(s, ['kind', 'flight', 'carrier', 'from', 'to']), depart: zoned(s.depart), ...(s.arrive ? { arrive: zoned(s.arrive) } : {}) }
            : pick(s, ['kind', 'name', 'city', 'checkIn', 'checkOut'])),
        })),
        current: cur ? { id: cur.trip.id, mode: cur.mode } : null,
        problems: Object.fromEntries(trips.map(t => [t.id, tripProblems(t)] as const).filter(([, p]) => p.length)),
      } satisfies D.DashTrips
    },
  },

  'GET packages': {
    scope: 'read', run: c => ({ packages: activePackages(loadPackages(join(c.deps.stateDir, 'packages.json'))).map(packageRow) }) satisfies D.DashPackages,
  },

  'POST packages/done': {
    scope: 'write', run: async c => {
      const r = await readJson(c.req)
      if (!('body' in r)) return reply(c, { error: r.error }, r.status)
      const { id } = r.body
      if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) return reply(c, { error: 'id' }, 400)
      const p = markDelivered(join(c.deps.stateDir, 'packages.json'), id)
      return p ? packageRow(p) satisfies D.PackageRow : reply(c, { error: 'not_found' }, 404)
    },
  },

  'GET capabilities': {
    scope: 'read', run: c => {
      const since = Date.now() - days(c.url.searchParams.get('days'), 30) * 86_400_000
      const entries = loadLog(join(c.deps.stateDir, 'capability-log.json'))
        .filter(e => Date.parse(e.at) >= since)
        .sort((a, b) => b.at.localeCompare(a.at))
        .map(e => pick(e, ['id', 'at', 'what', 'sha', 'paths', 'tier', 'origin', 'by', 'revertedAt']))
      return { entries } satisfies D.Capabilities
    },
  },

  'GET jobs': { scope: 'read', run: c => ({ jobs: loadJobs(join(c.deps.stateDir, 'jobs.json')).map(j => pick(j, JOB_KEYS)) }) satisfies D.Jobs },

  'GET triggers': { scope: 'read', run: c => ({ triggers: triggerRows(c.deps.loadTriggers()) }) satisfies D.Triggers },
}

/** Events newest first and without their source: a source can carry a mail id. */
function packageRow(p: PackageRecord): D.PackageRow {
  const url = trackingUrl(p.carrier, p.tracking)
  return {
    ...pick(p, PACKAGE_KEYS),
    carrierName: carrierName(p.carrier),
    ...(url ? { trackingUrl: url } : {}),
    events: [...p.events].reverse().map(e => pick(e, ['at', 'status', 'text'])),
  }
}

function settingsDto(c: Ctx, j: any): D.DashSettings {
  return {
    speakReplies: !!j.speakReplies,
    toggles: (j.toggles ?? []).map((t: D.Toggle) => pick(t, ['id', 'label', 'on', 'section'])),
    triggers: triggerRows(c.deps.loadTriggers()),
    ...(typeof j.note === 'string' ? { note: j.note } : {}),
  }
}

const snoozeDto = (j: any): D.Snooze => ({
  until: j.until ?? null, since: j.since ?? null,
  held: (j.held ?? []).map((h: D.Snooze['held'][number]) => pick(h, ['text', 'at'])),
})

/** DELETE devices/:id — a write token, or the device itself. Never a native token: those are revoked from the Mac. */
function revokeDevice(c: Ctx, id: string): Response {
  const target = listAppTokens().find(t => t.id === id)
  if (!target) return reply(c, { error: 'not_found' }, 404)
  if (!isDashToken(target as AppToken)) return reply(c, { error: 'native_only' }, 403)
  revokeAppToken(id)
  log('revoke', c, id)
  return reply(c, { revoked: true } satisfies D.Revoked)
}

// ---------------------------------------------------------------------------
// Calls: proxied to callbot's relay
// ---------------------------------------------------------------------------

const CALL_ID_RE = /^[\w-]{8,64}$/

const defaultRelay = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${process.env.RELAY_PORT ?? 4590}${path}`, {
  ...init, headers: { 'x-vapi-secret': process.env.VAPI_SERVER_SECRET ?? '', 'content-type': 'application/json' },
})

/**
 * The relay's JSON, or the Response to send instead. `passError` lets a
 * control's own refusal ("the call has ended") through as a 200 with ok:false.
 */
async function toRelay(c: Ctx, path: string, init?: RequestInit, passError = false): Promise<any | Response> {
  if (!c.deps.relay && !process.env.VAPI_SERVER_SECRET) return reply(c, { error: 'calls' }, 501)
  let r: Response
  try {
    r = await (c.deps.relay ?? defaultRelay)(path, init)
  } catch {
    if (c.req.signal.aborted) return reply(c, { error: 'aborted' }, 499)
    return reply(c, { error: 'relay' }, 503)
  }
  const j = await r.json().catch(() => null)
  if (r.ok || (passError && j && 'ok' in j)) return j ?? {}
  return reply(c, { error: r.status === 404 ? 'not_found' : 'relay' }, r.status === 404 ? 404 : 503)
}

function callDto(j: any): D.DashCall {
  return {
    ...pick(j, ['id', 'to', 'task', 'status', 'seq', 'createdAt', 'startedAt', 'endedAt', 'endedReason', 'takeover']),
    lines: (j.lines ?? []).map((l: D.CallLine) => pick(l, ['role', 'text'])),
    partial: pick(j.partial ?? {}, ['assistant', 'user']),
  } as D.DashCall
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/** Anything under /app/dash/, answered; anything else, undefined, for handleApp to carry on with. */
export function handleDash(req: Request, server: DashServer, deps: DashDeps): Promise<Response> | undefined {
  const url = new URL(req.url)
  if (!url.pathname.startsWith('/app/dash/')) return undefined
  return dispatch(req, url, server, deps)
}

async function dispatch(req: Request, url: URL, server: DashServer, deps: DashDeps): Promise<Response> {
  const cfg = loadDashConfig(configPath(deps.stateDir))
  if (!hostAllowed(req.headers.get('host'), cfg, cfg.host ?? learntHost(deps.stateDir))) return json({ error: 'host' }, 421)
  const path = url.pathname.slice('/app/dash/'.length)
  const origin = req.headers.get('origin') ?? undefined
  const allowed = !!origin && originAllowed(cfg, origin)
  // Answers any origin, so the setup screen can tell "unreachable" from "not allowlisted yet".
  if (path === 'ping') return json({ ok: true, origin: allowed ? 'allowed' : 'blocked' } satisfies D.Ping, 200, { 'access-control-allow-origin': '*' })

  const c = { req, url, deps, origin, ...clientIp(req, server), cors: allowed ? corsHeaders(origin!) : {} }
  /** 401s and 403s are logged and limited per IP: past 20 a minute they turn into 429s. */
  const deny = (status: 401 | 403, error: string, id?: string) => {
    log(`deny-${status}-${error}`, c, id)
    return rateLimit(`deny:${c.ip}`, 20, 60_000) ? reply(c, { error }, status) : reply(c, { error: 'rate_limited' }, 429)
  }
  if (origin && !allowed) return deny(403, 'origin')
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...BASE_HEADERS, ...c.cors } })

  try {
    if (path === 'pair/start' || path === 'pair/poll') {
      if (req.method !== 'POST') return reply(c, { error: 'method' }, 405)
      // Only an allowlisted browser origin may pair: the token is bound to it.
      if (!origin) return deny(403, 'origin')
      const r = await readJson(req)
      if (!('body' in r)) return reply(c, { error: r.error }, r.status)
      if (path === 'pair/start' && !rateLimit(`pair:${rateKey(c.ip)}`, 5, 3600_000)) return reply(c, { error: 'rate_limited' }, 429)
      const out = path === 'pair/start' ? startPairing(r.body, { origin, ip: c.ip, via: c.via }) : pollPairing(r.body, { origin })
      return reply(c, out.body, out.status)
    }

    const token = findAppToken(req.headers.get('authorization') ?? '')
    if (!token) return deny(401, 'unauthorized')
    if (isExpired(token)) return deny(401, 'expired', token.id)
    // A dashboard token works only from its own origin; a native one only outside a browser.
    if (isDashToken(token) ? token.origin !== origin : origin !== undefined) return deny(403, 'origin', token.id)

    const ctx: Ctx = { ...c, token }
    const dev = /^devices\/([\w-]{1,64})$/.exec(path)
    if (dev) {
      if (req.method !== 'DELETE') return reply(c, { error: 'method' }, 405)
      if (dev[1] !== token.id && !hasScope(token, 'write')) return deny(403, 'scope', token.id)
      touchAppToken(token.id)
      return revokeDevice(ctx, dev[1])
    }
    const route = routes[`${req.method} ${path}`]
    if (!route) {
      const known = Object.keys(routes).some(k => k.slice(k.indexOf(' ') + 1) === path)
      return reply(c, { error: known ? 'method' : 'not_found' }, known ? 405 : 404)
    }
    if (!hasScope(token, route.scope)) return deny(403, 'scope', token.id)
    touchAppToken(token.id)
    const out = await route.run(ctx)
    return out instanceof Response ? out : reply(c, out)
  } catch (err) {
    process.stderr.write(`[dash] ${req.method} ${path} failed: ${err}\n`)
    return reply(c, { error: 'internal' }, 500)
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { values: flags, positionals: [cmd, arg] } = parseArgs({
    args: process.argv.slice(2), allowPositionals: true, strict: false, options: { hours: { type: 'string' } },
  })
  const file = configPath()
  const cfg = loadDashConfig(file)
  const now = Date.now()
  if (cmd === 'allow' && arg) {
    const hours = flags.hours === undefined ? (isExactOrigin(arg) && isPreviewOrigin(arg) ? 24 : undefined) : Number(flags.hours)
    if (!isExactOrigin(arg)) { console.error(`not an exact origin (scheme://host[:port], no path): ${arg}`); process.exit(2) }
    if (hours !== undefined && !(hours > 0)) { console.error(`bad --hours: ${flags.hours}`); process.exit(2) }
    cfg.origins[arg] = hours === undefined ? {} : { until: new Date(now + hours * 3600_000).toISOString() }
    saveDashConfig(cfg, file, now)
    console.log(`allowed ${arg}${hours === undefined ? '' : ` until ${cfg.origins[arg].until!.slice(0, 16).replace('T', ' ')}Z`}`)
  } else if (cmd === 'deny' && arg) {
    const had = Object.hasOwn(cfg.origins, arg)
    delete cfg.origins[arg]
    saveDashConfig(cfg, file, now)
    console.log(had ? `denied ${arg}` : `${arg} was not allowed`)
  } else if (cmd === 'list') {
    const rows = Object.entries(cfg.origins)
    if (!rows.length) console.log('no allowed origins')
    for (const [o, e] of rows) console.log(`${o}  ${e.until ? `until ${e.until.slice(0, 16).replace('T', ' ')}Z${expired(e, now) ? ' (expired)' : ''}` : 'no expiry'}`)
    if (cfg.host) console.log(`host ${cfg.host}`)
  } else {
    console.log('usage: bun otto/dash.ts allow <origin> [--hours N] | deny <origin> | list')
    process.exitCode = 2
  }
}
