import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from 'bun:test'
import { createHash } from 'crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAppToken, findAppToken, listAppTokens } from '../apptokens.ts'
import { pairingButton, pairingCommand, pollPairing } from '../pairing.ts'
import { clientIp, FORBIDDEN_KEYS, handleDash, pick, readJson, type DashDeps, type DashTrigger } from '../dash.ts'
import type { LedgerEntry } from '../ledger.ts'
import { ChatFeed, type ChatEntry } from '../chatfeed.ts'

const ORIGIN = 'https://app.example.com'
const OTHER = 'http://localhost:3001'          // allowlisted too, so a token replayed from it gets past CORS
const STALE = 'https://old-preview.vercel.app'  // allowlisted once, entry expired
const HOST = 'machine.tailnet.ts.net'
const NOW = Date.parse('2026-03-15T12:00:00Z')
const FIXTURES = join(import.meta.dir, 'fixtures', 'dash')
/** What the browser gets for a durable memory's id. */
const ALEX = 'm' + createHash('sha256').update('alex-in-lisbon').digest('hex').slice(0, 12)

const TRIGGERS: DashTrigger[] = [
  { id: 'trg1', type: 'cron', schedule: '57 8 * * *', action: 'Send the user (Telegram chat_id: 1234567890) the morning brief: calendar, inbox and loops, in under fifteen hundred characters, plain text, empty sections left out.', repeating: true, enabled: true, nextRun: NOW + 3600_000 },
  { id: 'trg2', type: 'email', action: 'tell the user when the landlord replies', repeating: true, enabled: false },
]

let dir: string
let stderr: string[]
let calls: { name: string; method: string; body: unknown }[]
let feed: ChatFeed
let ipSeq = 0

/** Stand-ins for server.ts's /app handlers: they record what they were handed and answer with extra fields a pick must drop. */
function stubHandler(name: string, answer: (body: any) => unknown) {
  return async (req: Request) => {
    const body = req.method === 'GET' ? undefined : await req.json()
    calls.push({ name, method: req.method, body })
    return Response.json(answer(body))
  }
}

function deps(over: Partial<DashDeps> = {}): DashDeps {
  return {
    stateDir: dir,
    brief: () => ({
      asOf: '2026-03-15T11:55:00Z',
      events: [{ title: 'standup', start: '2026-03-15T13:00:00Z', minutes: 15 }],
      inbox: [{ from: 'Sam', subject: 'slides' }],
      bulk: 4,
      loops: [{ id: 'n1', title: 'send the signed lease back', due: '2026-03-20' }],
      triggers: [{ title: 'morning brief', next: '2026-03-16T08:57:00Z' }],
    }),
    statusDeps: () => ({
      stateDir: dir, now: NOW, http: async () => ({ error: 'refused' }), run: async () => false,
      pidAlive: () => false, account: '', launchAgentsDir: join(dir, 'agents'), relayPort: 1,
    }),
    appSettings: stubHandler('settings', () => ({ speakReplies: true, toggles: [{ id: 'setting:voice', label: 'Voice replies', on: true, section: 'otto', hash: 'x' }], note: 'done', secret: 'x' })),
    appSnooze: stubHandler('snooze', () => ({ until: null, since: null, held: [{ text: 'held one', at: '2026-03-15T11:00:00Z', source: 'x' }] })),
    appLoop: stubHandler('loop', b => ({ id: b.id, done: b.done, extra: 1 })),
    loadTriggers: () => TRIGGERS,
    readHistory: () => readFileSync(join(FIXTURES, 'history.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as LedgerEntry),
    chat: feed,
    sendApp: async (text, id) => { calls.push({ name: 'send', method: 'POST', body: { text, id } }) },
    search: async q => (q === 'broken' ? { error: 'no embedder' } : { results: [[0, 0.9]] }),
    relay: fakeRelay,
    ...over,
  }
}

/** callbot's relay: one live call, carrying the fields only the relay may see. */
const CALL = {
  id: 'call-0001', to: '+440000000000', task: 'book a table', status: 'in-progress', seq: 3, createdAt: NOW, startedAt: NOW,
  lines: [{ role: 'assistant', text: 'Buongiorno', extra: 1 }], partial: { user: 'sì', other: 'x' }, takeover: true,
  key: 'pagekey', listenUrl: 'wss://vapi/listen', controlUrl: 'https://vapi/control',
}
async function fakeRelay(path: string, init: RequestInit = {}): Promise<Response> {
  calls.push({ name: 'relay', method: init.method ?? 'GET', body: path + (init.body ? ` ${init.body}` : '') })
  if (path === '/calls') return Response.json({ calls: [CALL] })
  if (!path.startsWith('/calls/call-0001')) return Response.json({ error: 'not_found' }, { status: 404 })
  if (path.endsWith('/control')) return JSON.parse(String(init.body)).action === 'end'
    ? Response.json({ ok: false, error: 'the call has ended' }, { status: 409 })
    : Response.json({ ok: true })
  if (path.endsWith('/ticket')) return Response.json({ url: 'wss://relay/listen/abc' })
  return Response.json(CALL)
}

type Opts = { method?: string; origin?: string | null; token?: string; host?: string; body?: unknown; ip?: string; sock?: string; headers?: Record<string, string> }

/** One request through handleDash, from Funnel by default: loopback socket, a fresh client IP, the ts.net Host. */
async function call(path: string, o: Opts = {}, d = deps()): Promise<Response> {
  const headers: Record<string, string> = { host: o.host ?? HOST, 'x-forwarded-for': o.ip ?? `203.0.113.${++ipSeq % 250}`, ...o.headers }
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN
  if (o.token) headers.authorization = `Bearer ${o.token}`
  const req = new Request(`http://127.0.0.1:4589/app/dash/${path}`, {
    method: o.method ?? 'GET', headers,
    ...(o.body !== undefined ? { body: typeof o.body === 'string' ? o.body : JSON.stringify(o.body) } : {}),
  })
  const res = handleDash(req, { requestIP: () => ({ address: o.sock ?? '127.0.0.1' }) }, d)
  expect(res).toBeDefined()
  return (await res)!
}

const dashToken = (scope: 'read' | 'write' = 'read', origin = ORIGIN, ttlHours?: number) => createAppToken('dashboard test', { scope, origin, ...(ttlHours ? { ttlHours } : {}) })

beforeAll(() => setSystemTime(new Date(NOW)))
afterAll(() => {
  // Pairing state is module-wide and other files run in this process: a poll far
  // in the future sweeps what these tests left pending, against a throwaway dir.
  const scratch = mkdtempSync(join(tmpdir(), 'otto-dash-'))
  process.env.OTTO_STATE_DIR = scratch
  setSystemTime(new Date(NOW + 86_400_000))
  pollPairing({ device_code: 'sweep' }, { origin: ORIGIN })
  setSystemTime()
  rmSync(scratch, { recursive: true, force: true })
  delete process.env.OTTO_STATE_DIR
})
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'otto-dash-'))
  cpSync(FIXTURES, dir, { recursive: true })
  process.env.OTTO_STATE_DIR = dir
  writeFileSync(join(dir, 'dash.json'), JSON.stringify({
    origins: { [ORIGIN]: {}, [OTHER]: { until: '2026-03-16T00:00:00Z' }, [STALE]: { until: '2026-03-14T00:00:00Z' } },
  }))
  calls = []
  feed = new ChatFeed()
  stderr = []
  spyOn(process.stderr, 'write').mockImplementation((s: any) => { stderr.push(String(s)); return true })
})
afterEach(() => {
  ;(process.stderr.write as any).mockRestore()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.OTTO_STATE_DIR
})

const SECURITY_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', vary: 'Origin' }
const expectSecure = (r: Response) => { for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers.get(k)).toBe(v) }

/** Every key at any depth of a JSON value. */
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach(x => keysDeep(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out) }
  return out
}

// ---------------------------------------------------------------------------
// Order of checks
// ---------------------------------------------------------------------------

test('anything outside /app/dash/ is left to handleApp', () => {
  const req = new Request('http://127.0.0.1:4589/app/brief', { headers: { host: HOST } })
  expect(handleDash(req, { requestIP: () => null }, deps())).toBeUndefined()
  expect(handleDash(new Request('http://127.0.0.1:4589/app/dash'), { requestIP: () => null }, deps())).toBeUndefined()
})

test('a foreign Host is refused before anything else, ping and preflight included', async () => {
  for (const [path, method] of [['ping', 'GET'], ['me', 'OPTIONS'], ['pair/start', 'POST']]) {
    const r = await call(path, { method, host: 'rebind.attacker.example' })
    expect(r.status).toBe(421)
    expect(await r.json()).toEqual({ error: 'host' })
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
  }
  // Loopback and the configured host pass.
  expect((await call('ping', { host: '127.0.0.1:4589' })).status).toBe(200)
  writeFileSync(join(dir, 'dash.json'), JSON.stringify({ origins: {}, host: 'otto.lan' }))
  expect((await call('ping', { host: 'otto.lan:4589' })).status).toBe(200)
  // Once a host is known, another ts.net name is just another name.
  expect((await call('ping')).status).toBe(421)
  expect((await call('ping', { host: '127.0.0.1:4589' })).status).toBe(200)
})

test('a bare private-network IP passes, a public one does not', async () => {
  for (const host of ['192.168.1.21:4589', '10.0.0.5:4589', '172.20.3.4:4589']) expect((await call('ping', { host })).status).toBe(200)
  for (const host of ['8.8.8.8:4589', '172.32.0.1:4589', '192.168.1.21.attacker.example']) expect((await call('ping', { host })).status).toBe(421)
})

test('with no host in dash.json, the Funnel base the server learnt is the only ts.net name let in', async () => {
  expect((await call('ping', { host: 'someone-else.other.ts.net' })).status).toBe(200) // nothing known yet
  writeFileSync(join(dir, 'public-base'), `https://${HOST}:10000\n`)
  expect((await call('ping')).status).toBe(200)
  expect((await call('ping', { host: 'someone-else.other.ts.net' })).status).toBe(421)
})

test('ping answers any origin with ACAO *, and says whether this one is allowlisted', async () => {
  const blocked = await call('ping', { origin: 'https://elsewhere.example' })
  expect(blocked.status).toBe(200)
  expect(blocked.headers.get('access-control-allow-origin')).toBe('*')
  expect(await blocked.json()).toEqual({ ok: true, origin: 'blocked' })
  expect(await (await call('ping')).json()).toEqual({ ok: true, origin: 'allowed' })
  expect(await (await call('ping', { origin: STALE })).json()).toEqual({ ok: true, origin: 'blocked' })
  expectSecure(blocked)
})

test('preflight: 204 with CORS headers when allowlisted, 403 without them when not, plain 204 with no Origin', async () => {
  const ok = await call('settings', { method: 'OPTIONS' })
  expect(ok.status).toBe(204)
  expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  expect(ok.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE, OPTIONS')
  expect(ok.headers.get('access-control-allow-headers')).toBe('authorization, content-type')
  expect(ok.headers.get('access-control-max-age')).toBe('600')
  expectSecure(ok)

  const no = await call('settings', { method: 'OPTIONS', origin: 'https://elsewhere.example' })
  expect(no.status).toBe(403)
  expect(await no.json()).toEqual({ error: 'origin' })
  expect(no.headers.get('access-control-allow-origin')).toBeNull()

  const bare = await call('settings', { method: 'OPTIONS', origin: null })
  expect(bare.status).toBe(204)
  expect(bare.headers.get('access-control-allow-origin')).toBeNull()
})

test('an allowlist entry past its until is refused like any stranger', async () => {
  const { token } = dashToken('read', STALE)
  const r = await call('me', { origin: STALE, token })
  expect(r.status).toBe(403)
  expect(await r.json()).toEqual({ error: 'origin' })
  // A corrupt dash.json allows nobody.
  writeFileSync(join(dir, 'dash.json'), '{nope')
  expect((await call('me', { token: dashToken().token })).status).toBe(403)
})

test('auth: 401 without a token, 401 expired, 403 on the wrong origin, 403 on scope', async () => {
  const none = await call('me')
  expect(none.status).toBe(401)
  expect(await none.json()).toEqual({ error: 'unauthorized' })
  expect(none.headers.get('access-control-allow-origin')).toBe(ORIGIN) // so the browser can read why
  expect((await call('me', { token: 'not-a-token' })).status).toBe(401)

  const short = dashToken('read', ORIGIN, 1)
  setSystemTime(new Date(NOW + 2 * 3600_000))
  const exp = await call('me', { token: short.token })
  setSystemTime(new Date(NOW))
  expect(exp.status).toBe(401)
  expect(await exp.json()).toEqual({ error: 'expired' })

  // A dashboard token replayed from another (allowlisted) origin, or from no browser at all.
  const { token } = dashToken('write')
  expect(await (await call('me', { token, origin: OTHER })).json()).toEqual({ error: 'origin' })
  expect((await call('me', { token, origin: null })).status).toBe(403)

  // A native token works only outside a browser.
  const native = createAppToken('phone').token
  expect((await call('me', { token: native })).status).toBe(403)
  const me = await call('me', { token: native, origin: null })
  expect(me.status).toBe(200)
  expect(me.headers.get('access-control-allow-origin')).toBeNull()

  const read = dashToken('read').token
  for (const [path, method] of [['settings', 'POST'], ['snooze', 'POST'], ['loop', 'POST'], ['memory/rebuild', 'POST'], ['chat', 'POST'], ['packages/done', 'POST'], ['calls/control', 'POST']]) {
    const r = await call(path, { method, token: read, body: {} })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'scope' })
  }
  expect(calls).toEqual([]) // nothing was delegated
  expect(stderr.some(l => l.startsWith('[dash] deny-403-scope origin=https://app.example.com ip=203.0.113.x via=funnel id='))).toBe(true)
  expect(stderr.join('')).not.toContain(read)
})

test('unknown route 404, wrong method 405, both after auth', async () => {
  const { token } = dashToken()
  expect((await call('nope', { token })).status).toBe(404)
  expect((await call('nope')).status).toBe(401)
  const r = await call('status', { method: 'POST', token })
  expect(r.status).toBe(405)
  expect(await r.json()).toEqual({ error: 'method' })
})

// ---------------------------------------------------------------------------
// Read routes
// ---------------------------------------------------------------------------

const GETS = ['me', 'devices', 'status', 'brief', 'memory', `memory/item?id=${ALEX}`, 'memory/search?q=lisbon', 'people', 'places', 'places?city=lisbon&status=loved',
  'settings', 'snooze', 'loops', 'money', 'money?month=2026-03&currency=eur', 'proactivity?days=30', 'trips', 'packages', 'capabilities?days=30', 'jobs', 'triggers', 'chat?thread=app', 'chat?thread=telegram', 'calls', 'calls?id=call-0001&after=2']

test('every GET answers 200 with security headers, and no response carries a key that must stay on the Mac', async () => {
  const { token } = dashToken('read')
  createAppToken('phone') // a native device in the list, hash and all
  for (const path of GETS) {
    const r = await call(path, { token })
    expect([path, r.status]).toEqual([path, 200])
    expectSecure(r)
    expect(r.headers.get('content-type')).toBe('application/json')
    const keys = keysDeep(await r.json())
    const leaked = [...keys].filter(k => FORBIDDEN_KEYS.has(k) || (k === 'body' && !path.startsWith('memory/item')))
    expect([path, leaked]).toEqual([path, []])
  }
})

test('shapes: me, devices, status, brief', async () => {
  const { token, id } = dashToken('read')
  expect(await (await call('me', { token })).json()).toEqual({
    id, name: 'dashboard test', scope: 'read', origin: ORIGIN, created: new Date(NOW).toISOString(), expires: new Date(NOW + 90 * 86_400_000).toISOString(),
  })
  const devices = (await (await call('devices', { token })).json()).devices
  expect(devices.map((d: any) => Object.keys(d).sort())).toEqual([['created', 'expires', 'id', 'lastUsed', 'name', 'origin', 'scope']])

  const status = await (await call('status', { token })).json()
  expect(status.now).toBe(NOW)
  expect(status.rows.find((r: any) => r.id === 'mcp-server')).toMatchObject({ verdict: 'unknown', label: 'MCP server' })
  expect(status.repairs).toEqual(['2026-03-12T03:00:00Z restarted the phone relay'])

  expect(await (await call('brief', { token })).json()).toMatchObject({ bulk: 4, inbox: [{ from: 'Sam', subject: 'slides' }] })
  const none = await call('brief', { token }, deps({ brief: () => null }))
  expect(none.status).toBe(503)
  expect(await none.json()).toEqual({ error: 'no_brief' })
})

test('memory: list without bodies, one item with its body, 404 without the viewer file', async () => {
  const { token } = dashToken('read')
  const m = await (await call('memory', { token })).json()
  expect(Object.keys(m).sort()).toEqual(['generatedAt', 'graph', 'items', 'scopes', 'summary'])
  expect(m.items).toHaveLength(2)
  expect(m.items[1]).toEqual({ id: 'note:n1', store: 'notes', kind: 'loop', scope: 'notes', name: 'send the signed lease back', description: 'due 2026-03-20', updated: '2026-03-01', status: 'open', due: '2026-03-20', tags: ['home'], hits: 0, badge: 'never' })
  expect(m.graph.clusters[0]).toEqual({ id: 0, size: 2, label: 'Lisbon', terms: ['lisbon', 'lease'], x: 0.1, y: -0.2 })

  expect(m.items[0].id).toBe(ALEX)
  expect((await call('memory/item?id=alex-in-lisbon', { token })).status).toBe(404) // the raw key is not an id
  const item = await (await call(`memory/item?id=${ALEX}`, { token })).json()
  expect(item.body).toBe('Alex moved to Lisbon in January.')
  expect(item.source).toBeUndefined()
  expect((await call('memory/item?id=nope', { token })).status).toBe(404)

  // A project scope is a cwd slug with the username in it: the browser sees only its label.
  const v = JSON.parse(readFileSync(join(dir, 'memory-viewer.json'), 'utf8'))
  const slug = '-Users-you--otto-repo'
  v.items[0] = { ...v.items[0], id: `${slug}/alex-in-lisbon`, scope: slug }
  v.scopes = { [slug]: '~/.otto-repo', notes: 'notes' }
  writeFileSync(join(dir, 'memory-viewer.json'), JSON.stringify(v))
  const raw = await (await call('memory', { token })).text()
  expect(raw).not.toContain('Users')
  const pm = JSON.parse(raw)
  expect(pm.items[0].scope).toBe('~/.otto-repo')
  expect(pm.scopes).toEqual({ '~/.otto-repo': '~/.otto-repo', notes: 'notes' })
  const pi = await (await call(`memory/item?id=${pm.items[0].id}`, { token })).text()
  expect(pi).toContain('Alex moved to Lisbon')
  expect(pi).not.toContain('Users')

  unlinkSync(join(dir, 'memory-viewer.json'))
  const gone = await call('memory', { token })
  expect(gone.status).toBe(404)
  expect(await gone.json()).toEqual({ error: 'no_viewer' })
})

test('memory/search: results, 503 with the error when there is no embedder, 10 a minute per token', async () => {
  const { token } = dashToken('read')
  expect(await (await call('memory/search?q=lisbon', { token })).json()).toEqual({ results: [[0, 0.9]] })
  const broken = await call('memory/search?q=broken', { token })
  expect(broken.status).toBe(503)
  expect(await broken.json()).toEqual({ error: 'no embedder' })
  for (let i = 0; i < 8; i++) expect((await call('memory/search?q=x', { token })).status).toBe(200)
  expect((await call('memory/search?q=x', { token })).status).toBe(429)
  expect((await call('memory/search?q=x', { token: dashToken('read').token })).status).toBe(200) // per token
})

test('memory/rebuild: 202, then 409 while one is running', async () => {
  const { token } = dashToken('write')
  let finish!: () => void
  let started = 0
  const d = deps({ rebuild: () => { started++; return { exited: new Promise<void>(r => { finish = r }) } } })
  const r = await call('memory/rebuild', { method: 'POST', token }, d)
  expect(r.status).toBe(202)
  expect(await r.json()).toEqual({ started: true })
  expect((await call('memory/rebuild', { method: 'POST', token }, d)).status).toBe(409)
  finish()
  await Bun.sleep(0)
  expect((await call('memory/rebuild', { method: 'POST', token }, d)).status).toBe(202)
  finish()
  expect(started).toBe(2)
})

test('people: the user\'s words and mentions, never addresses, phones or handles', async () => {
  const { token } = dashToken('read')
  const { cards } = await (await call('people', { token })).json()
  expect(cards).toEqual([{
    name: 'Alex', relationship: 'friend from school', city: 'Lisbon', timezone: 'Europe/Lisbon', org: 'Example Co',
    notes: [{ at: '2026-02-01T10:00:00Z', text: 'moved to Lisbon in January' }], inbound: 3, outbound: 2,
    lastContact: '2026-03-01T10:00:00.000Z', mentions: [0],
  }])
})

test('places: filtered rows and the city list, the recommender by name only; bad params 400', async () => {
  const { token } = dashToken('read')
  const all = await (await call('places', { token })).json()
  expect(all.places.map((p: any) => p.name)).toEqual(['Lume', 'Taberna Azul', 'Nightjar'])
  expect(all.places[0]).toEqual({
    id: 'lume|lisbon', name: 'Lume', city: 'Lisbon', kind: 'cafe', status: 'loved', recommendedBy: 'Alex', tags: ['brunch'],
    notes: [{ at: '2026-02-01T10:00:00Z', text: 'Alex says the pastel is the best in town' }, { at: '2026-03-01T10:00:00Z', text: 'status was want' }],
    createdAt: '2026-02-01T10:00:00Z', updatedAt: '2026-03-01T10:00:00Z',
  })
  expect(all.places.some((p: any) => 'recommenderId' in p)).toBe(false)
  expect(all.cities).toEqual([{ city: 'lisboa', count: 1 }, { city: 'Lisbon', count: 1 }, { city: 'London', count: 1 }])
  const loved = await (await call('places?city=LISBON&status=loved', { token })).json()
  expect(loved.places.map((p: any) => p.name)).toEqual(['Lume'])
  expect(loved.cities.length).toBe(3) // the list to pick from stays whole
  const cocktails = await (await call('places?q=cocktails', { token })).json()
  expect(cocktails.places.map((p: any) => p.name)).toEqual(['Nightjar'])
  expect((await call('places?kind=club', { token })).status).toBe(400)
  expect((await call('places?status=maybe', { token })).status).toBe(400)
  expect((await call('places?city=%3Cscript%3E', { token })).status).toBe(400)
})

test('places: no file yet is an empty list, not an error', async () => {
  const { token } = dashToken('read')
  unlinkSync(join(dir, 'places.json'))
  expect(await (await call('places', { token })).json()).toEqual({ places: [], cities: [] })
})

test('loops: open loops, the dry-run hygiene plan, and what the pass closed lately', async () => {
  const { token } = dashToken('read')
  const before = readFileSync(join(dir, 'notes.json'), 'utf8')
  const l = await (await call('loops', { token })).json()
  expect(l.open.map((n: any) => n.id)).toEqual(['n1', 'n2'])
  expect(l.recent.map((n: any) => [n.id, n.closedReason])).toEqual([['n3', 'exact duplicate of another loop']])
  expect(l.plan.propose.map((p: any) => p.id)).toEqual(['n2'])
  expect(readFileSync(join(dir, 'notes.json'), 'utf8')).toBe(before) // a dry run
  expect(() => readFileSync(join(dir, 'hygiene.json'))).toThrow()
})

test('money: filtered records, per-currency totals, never a grand total; bad params 400', async () => {
  const { token } = dashToken('read')
  const all = await (await call('money', { token })).json()
  expect(all.records.map((r: any) => r.id)).toEqual(['r3', 'r1', 'r2'])
  expect(all.byCurrency).toEqual([{ currency: 'EUR', total: 24.5, count: 2 }, { currency: 'USD', total: 30, count: 1 }])
  expect(all.byCategory.map((c: any) => c.category).sort()).toEqual(['books', 'food'])
  const march = await (await call('money?month=2026-03&currency=usd', { token })).json()
  expect(march.records.map((r: any) => r.id)).toEqual(['r3'])
  expect(march.byCategory).toEqual([{ category: 'travel', total: 30, count: 1 }])
  expect(march.byMonth.map((m: any) => m.month).sort()).toEqual(['2026-02', '2026-03'])
  expect((await call('money?month=March', { token })).status).toBe(400)
  expect((await call('money?currency=euro', { token })).status).toBe(400)
  // A category narrows the charges and the months, but the category list stays whole to pick from.
  const food = await (await call('money?category=food', { token })).json()
  expect(food.records.every((r: any) => r.category === 'food')).toBe(true)
  expect(food.records.length).toBeGreaterThan(0)
  expect(food.byCategory.map((c: any) => c.category).sort()).toEqual(['books', 'food'])
  expect(food.byMonth.every((m: any) => m.totals.every((t: any) => t.currency !== 'USD'))).toBe(true)
  expect((await call('money?category=%3Cscript%3E', { token })).status).toBe(400)
})

test('trips: flight and stay basics only, the current trip, problems by trip id', async () => {
  const { token } = dashToken('read')
  const t = await (await call('trips', { token })).json()
  expect(t.trips[0].segments).toEqual([
    { kind: 'flight', flight: 'XX123', carrier: 'XX', from: 'LIS', to: 'BCN',
      depart: { local: '2026-03-16T10:00', zone: 'Europe/Lisbon', utc: '2026-03-16T10:00:00Z' },
      arrive: { local: '2026-03-16T13:00', zone: 'Europe/Madrid', utc: '2026-03-16T12:00:00Z' } },
    { kind: 'stay', name: 'Hotel Example', city: 'Barcelona', checkIn: '2026-03-16', checkOut: '2026-03-20' },
  ])
  expect(t.current).toEqual({ id: 't1', mode: 'current' })
  expect(Object.keys(t.problems)).toEqual(['t2'])
})

test('packages: coming first, then recently delivered; events newest first without their source; done marks it delivered', async () => {
  const { token } = dashToken('read')
  const { packages } = await (await call('packages', { token })).json()
  expect(packages.map((p: any) => p.id)).toEqual(['p1', 'p2']) // p3 was delivered too long ago to list
  expect(packages[0]).toEqual({
    id: 'p1', carrier: 'dhl', carrierName: 'DHL', tracking: 'JD000000000000000000',
    trackingUrl: 'https://www.dhl.com/global-en/home/tracking.html?tracking-id=JD000000000000000000&submit=1',
    merchant: 'Example Shop', item: 'Desk lamp', status: 'in_transit', eta: '2026-03-17', etaLatest: '2026-03-18', updatedAt: '2026-03-14T09:00:00.000Z',
    events: [
      { at: '2026-03-14T09:00:00.000Z', status: 'in_transit', text: 'Left the hub' },
      { at: '2026-03-12T09:00:00.000Z', status: 'shipped', text: 'Shipped' },
    ],
  })
  expect(packages[1]).toMatchObject({ id: 'p2', carrierName: 'Amazon', status: 'delivered', deliveredAt: '2026-03-10T15:00:00.000Z' })
  expect(packages[1].trackingUrl).toBeUndefined()

  const writer = dashToken('write').token
  const done = await (await call('packages/done', { method: 'POST', token: writer, body: { id: 'p1' } })).json()
  expect(done).toMatchObject({ id: 'p1', status: 'delivered', deliveredAt: new Date(NOW).toISOString() })
  expect(done.events[0]).toEqual({ at: new Date(NOW).toISOString(), status: 'delivered', text: 'Marked delivered' })
  expect(JSON.parse(readFileSync(join(dir, 'packages.json'), 'utf8'))[0].status).toBe('delivered')
  expect((await call('packages/done', { method: 'POST', token: writer, body: { id: 'nope' } })).status).toBe(404)
  expect((await call('packages/done', { method: 'POST', token: writer, body: { id: '../x' } })).status).toBe(400)
})

test('activity: proactivity from history, capabilities within the window and without revert, jobs without pid or scratch dir', async () => {
  const { token } = dashToken('read')
  const p = await (await call('proactivity?days=30', { token })).json()
  expect(p.stats.map((s: any) => [s.src, s.sent, s.engaged])).toEqual([['email-scan', 1, 0], ['trigger:trg1', 1, 1]])
  const c = await (await call('capabilities?days=30', { token })).json()
  expect(c.entries.map((e: any) => e.id)).toEqual(['c2', 'c1'])
  const j = await (await call('jobs', { token })).json()
  expect(Object.keys(j.jobs[0]).sort()).toEqual(['costUsd', 'createdAt', 'endedAt', 'id', 'result', 'startedAt', 'state', 'tags', 'task', 'tokenBudget', 'tokensUsed', 'tools', 'wallClockMs'])
})

test('triggers: a one-line gist with the chat id stripped, never the whole action', async () => {
  const { token } = dashToken('read')
  const { triggers } = await (await call('triggers', { token })).json()
  expect(triggers[0]).toMatchObject({ id: 'trg1', type: 'cron', schedule: '57 8 * * *', repeating: true, enabled: true, nextRun: NOW + 3600_000 })
  expect(triggers[0].gist.length).toBeLessThanOrEqual(80)
  expect(triggers[0].gist).not.toContain('1234567890')
  expect(triggers[0].gist.startsWith('the morning brief')).toBe(true)
  expect(triggers[1]).toEqual({ id: 'trg2', type: 'email', repeating: true, enabled: false, gist: 'tell the user when the landlord replies' })
})

// ---------------------------------------------------------------------------
// Writes and bodies
// ---------------------------------------------------------------------------

test('delegated writes get the parsed body in a fresh request, and answer through a pick', async () => {
  const { token } = dashToken('write')
  const s = await call('settings', { method: 'POST', token, body: { id: 'setting:voice' } })
  expect(s.status).toBe(200)
  const sj = await s.json()
  expect(sj).toEqual({ speakReplies: true, toggles: [{ id: 'setting:voice', label: 'Voice replies', on: true, section: 'otto' }], triggers: expect.any(Array), note: 'done' })
  expect(await (await call('loop', { method: 'POST', token, body: { id: 'n1', done: true } })).json()).toEqual({ id: 'n1', done: true })
  expect(await (await call('snooze', { method: 'POST', token, body: { minutes: 60 } })).json()).toEqual({ until: null, since: null, held: [{ text: 'held one', at: '2026-03-15T11:00:00Z' }] })
  expect(calls).toEqual([
    { name: 'settings', method: 'POST', body: { id: 'setting:voice' } },
    { name: 'loop', method: 'POST', body: { id: 'n1', done: true } },
    { name: 'snooze', method: 'POST', body: { minutes: 60 } },
  ])
  // A handler's bare error status comes back as a JSON error.
  const stub = deps({ appLoop: async () => new Response(null, { status: 501 }) })
  const r = await call('loop', { method: 'POST', token, body: { id: 'n1', done: true } }, stub)
  expect(r.status).toBe(501)
  expect(await r.json()).toEqual({ error: 'not_implemented' })
})

test('bodies: over 64 KiB streamed without Content-Length is 413; bad JSON and non-objects are 400', async () => {
  const { token } = dashToken('write')
  const chunk = new Uint8Array(16 * 1024).fill(0x20)
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({ pull(c) { if (sent++ < 10) c.enqueue(chunk); else c.close() } })
  const req = new Request(`http://127.0.0.1:4589/app/dash/settings`, {
    method: 'POST', body: stream, duplex: 'half',
    headers: { host: HOST, origin: ORIGIN, authorization: `Bearer ${token}` },
  } as RequestInit)
  expect(req.headers.get('content-length')).toBeNull()
  const r = (await handleDash(req, { requestIP: () => ({ address: '127.0.0.1' }) }, deps()))!
  expect(r.status).toBe(413)
  expect(await r.json()).toEqual({ error: 'too_large' })
  expect(sent).toBeLessThan(10) // stopped reading at the cap

  for (const body of ['{nope', '[1,2]', 'null', '"x"']) {
    const bad = await call('settings', { method: 'POST', token, body })
    expect([body, bad.status, await bad.json()]).toEqual([body, 400, { error: 'bad_json' }])
  }
  expect(calls).toEqual([])
  expect(await readJson(new Request('http://x/', { method: 'POST' }))).toEqual({ body: {} })
})

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

test('devices: a write token revokes dashboard tokens, never a native one; a read token only itself', async () => {
  const native = createAppToken('phone')
  const reader = dashToken('read')
  const writer = dashToken('write')
  const other = dashToken('read')
  expect((await call(`devices/${native.id}`, { method: 'DELETE', token: writer.token })).status).toBe(403)
  expect(findAppToken(`Bearer ${native.token}`)).not.toBeNull()
  expect(await (await call(`devices/${other.id}`, { method: 'DELETE', token: reader.token })).json()).toEqual({ error: 'scope' })
  expect(await (await call(`devices/${other.id}`, { method: 'DELETE', token: writer.token })).json()).toEqual({ revoked: true })
  expect((await call(`devices/${other.id}`, { method: 'DELETE', token: writer.token })).status).toBe(404)
  expect(await (await call(`devices/${reader.id}`, { method: 'DELETE', token: reader.token })).json()).toEqual({ revoked: true })
  expect(await (await call('signout', { method: 'POST', token: writer.token })).json()).toEqual({ revoked: true })
  expect((await call('me', { token: writer.token })).status).toBe(401)
  expect(listAppTokens().map(t => t.id)).toEqual([native.id])
  expect(stderr.filter(l => l.startsWith('[dash] revoke '))).toHaveLength(3)
})

// ---------------------------------------------------------------------------
// Pairing over HTTP, client IP, rate limits
// ---------------------------------------------------------------------------

test('pair over HTTP: start, claim, tap, collect once; the token then works from its origin only', async () => {
  const start = await call('pair/start', { method: 'POST', body: { scope: 'write', label: 'Chrome on macOS' }, ip: '198.51.100.7' })
  expect(start.status).toBe(200)
  expect(start.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  const { device_code, user_code } = await start.json()

  const shown: { text: string; buttons: { label: string; data: string }[] }[] = []
  expect(await pairingCommand(`pair ${user_code}`, (text, buttons) => { shown.push({ text, buttons }) })).toBe(true)
  expect(shown[0].text).toContain('via tailscale serve from 198.51.100.x')
  expect(pairingButton(shown[0].buttons[1].data)).toContain('read + control')

  setSystemTime(new Date(NOW + 3000))
  const got = await (await call('pair/poll', { method: 'POST', body: { device_code } })).json()
  setSystemTime(new Date(NOW + 6000))
  expect(await (await call('pair/poll', { method: 'POST', body: { device_code } })).json()).toEqual({ status: 'expired' })
  setSystemTime(new Date(NOW))
  expect(got).toMatchObject({ status: 'approved', scope: 'write' })
  expect((await call('me', { token: got.token })).status).toBe(200)
  expect((await call('me', { token: got.token, origin: OTHER })).status).toBe(403)

  // Pairing needs an allowlisted browser origin.
  expect((await call('pair/start', { method: 'POST', body: { scope: 'read' }, origin: null })).status).toBe(403)
  expect((await call('pair/start', { method: 'POST', body: { scope: 'read' }, origin: 'https://elsewhere.example' })).status).toBe(403)
  expect((await call('pair/start', { body: { scope: 'read' } })).status).toBe(405)
})

test('pair/start: an IPv6 client is limited by its /64, not by each address in it', async () => {
  for (let i = 1; i <= 5; i++) expect((await call('pair/start', { method: 'POST', body: {}, ip: `2001:db8:1:2::${i}` })).status).toBe(200)
  expect((await call('pair/start', { method: 'POST', body: {}, ip: '2001:db8:1:2:aaaa::9' })).status).toBe(429)
  expect((await call('pair/start', { method: 'POST', body: {}, ip: '2001:db8:1:3::1' })).status).toBe(200)
})

test('pair/start: five an hour per client IP', async () => {
  for (let i = 0; i < 5; i++) expect((await call('pair/start', { method: 'POST', body: {}, ip: '198.51.100.20' })).status).toBe(200)
  const r = await call('pair/start', { method: 'POST', body: {}, ip: '198.51.100.20' })
  expect(r.status).toBe(429)
  expect(await r.json()).toEqual({ error: 'rate_limited' })
  expect((await call('pair/start', { method: 'POST', body: {}, ip: '198.51.100.21' })).status).toBe(200)
})

test('401s and 403s: twenty a minute per IP, then 429', async () => {
  for (let i = 0; i < 20; i++) expect((await call('me', { ip: '198.51.100.30' })).status).toBe(401)
  expect((await call('me', { ip: '198.51.100.30' })).status).toBe(429)
  expect((await call('me', { ip: '198.51.100.30', origin: 'https://elsewhere.example' })).status).toBe(429)
  // The limit counts refusals only: a good token from the same IP still works.
  expect((await call('me', { ip: '198.51.100.30', token: dashToken().token })).status).toBe(200)
  setSystemTime(new Date(NOW + 61_000))
  expect((await call('me', { ip: '198.51.100.30' })).status).toBe(401)
  setSystemTime(new Date(NOW))
})

test('clientIp trusts X-Forwarded-For only behind a loopback socket, and only its rightmost entry', () => {
  const req = (xff?: string) => new Request('http://x/', { headers: xff ? { 'x-forwarded-for': xff } : {} })
  const sock = (address: string) => ({ requestIP: () => ({ address }) })
  expect(clientIp(req('10.0.0.9, 203.0.113.5'), sock('127.0.0.1'))).toEqual({ ip: '203.0.113.5', via: 'funnel' })
  expect(clientIp(req('203.0.113.5'), sock('::1'))).toEqual({ ip: '203.0.113.5', via: 'funnel' })
  expect(clientIp(req('203.0.113.5'), sock('192.168.1.20'))).toEqual({ ip: '192.168.1.20', via: 'direct' })
  expect(clientIp(req(), sock('127.0.0.1'))).toEqual({ ip: '127.0.0.1', via: 'direct' })
})

test('pick refuses a forbidden key, so a DTO cannot be written to carry one', () => {
  expect(() => pick({ id: 'a', undo: 'x' }, ['id', 'undo'])).toThrow('forbidden key')
  expect(Object.keys(pick({ id: 'a', b: undefined, c: 1 }, ['id', 'b']))).toEqual(['id'])
})

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI: allow defaults dev and preview origins to 24 h, production to no expiry; deny; list; expired entries pruned', () => {
  setSystemTime() // the CLI runs on the real clock
  const file = join(dir, 'cli-dash.json')
  writeFileSync(file, JSON.stringify({ origins: { 'https://gone.vercel.app': { until: '2020-01-01T00:00:00Z' } } }))
  const cli = (...args: string[]) => {
    const p = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'dash.ts'), ...args], { env: { ...process.env, OTTO_DASH_CONFIG: file }, stdout: 'pipe', stderr: 'pipe' })
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
  }
  expect(cli('allow', 'https://app.example.com').code).toBe(0)
  expect(cli('allow', 'http://localhost:3001').code).toBe(0)
  expect(cli('allow', 'https://pr-1.vercel.app', '--hours', '2').code).toBe(0)
  expect(cli('allow', 'https://app.example.com/path').code).toBe(2)
  expect(cli('allow', '*').code).toBe(2)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  expect(Object.keys(saved.origins).sort()).toEqual(['http://localhost:3001', 'https://app.example.com', 'https://pr-1.vercel.app'])
  expect(saved.origins['https://app.example.com']).toEqual({})
  const hours = (o: string) => (Date.parse(saved.origins[o].until) - Date.now()) / 3600_000
  expect(Math.round(hours('http://localhost:3001'))).toBe(24)
  expect(Math.round(hours('https://pr-1.vercel.app'))).toBe(2)
  expect(cli('list').out).toContain('https://app.example.com  no expiry')
  expect(cli('deny', 'http://localhost:3001').out).toContain('denied')
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).origins)).not.toContain('http://localhost:3001')
  setSystemTime(new Date(NOW))
})

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const UUID = (n: number) => `2f1e4c1a-0000-4000-8000-0000-000${n}`
const CHAT_HISTORY: ChatEntry[] = [
  { ts: '2026-03-14T09:00:00.000Z', dir: 'in', chat_id: '1234567890', message_id: '41', kind: 'text', text: 'hi from telegram' },
  { ts: '2026-03-14T09:00:05.000Z', dir: 'out', chat_id: '1234567890', message_id: '42', kind: 'text', text: 'hello', src: 'chat' },
  { ts: '2026-03-14T09:01:00.000Z', dir: 'in', chat_id: 'app', message_id: UUID(1), kind: 'text', text: 'hi from the app' },
  { ts: '2026-03-14T09:01:03.000Z', dir: 'in', chat_id: 'app', kind: 'reaction', text: '\u{1F44D}' },
  { ts: '2026-03-14T09:01:04.000Z', dir: 'in', chat_id: 'app', kind: 'terminal', text: 'fix the build please', src: 'terminal' },
  { ts: '2026-03-14T09:01:05.000Z', dir: 'out', chat_id: 'app', message_id: 'a1b2c3d4', kind: 'text', text: 'hey', src: 'chat' },
  { ts: '2026-03-14T09:02:00.000Z', dir: 'out', chat_id: '1234567890', kind: 'text', text: 'flushed, no id', src: 'queue-flush' },
]
const chatDeps = (over: Partial<DashDeps> = {}) => deps({ readHistory: (id, n) => CHAT_HISTORY.filter(e => !id || e.chat_id === id).slice(-n), ...over })
const withOwner = () => writeFileSync(join(dir, 'access.json'), JSON.stringify({ allowFrom: ['1234567890'] }))
const chatGet = async (q: string, d = chatDeps()) => (await call(`chat?${q}`, { token: dashToken('read').token }, d)).json() as Promise<any>
const chatPost = (body: unknown, token = dashToken('write').token, d = chatDeps()) => call('chat', { method: 'POST', token, body }, d)
const entry = (chat_id: string, text = 'x'): ChatEntry => ({ ts: '2026-03-15T11:00:00.000Z', dir: 'out', chat_id, kind: 'text', text })

test('chat: each thread shows only its own bubbles, and no chat id leaves', async () => {
  withOwner()
  const app = await chatGet('thread=app')
  expect(app.messages.map((m: any) => m.text)).toEqual(['hi from the app', 'hey'])
  expect(app.messages[0]).toEqual({ id: UUID(1), dir: 'in', kind: 'text', text: 'hi from the app', ts: '2026-03-14T09:01:00.000Z' })
  const tg = await chatGet('thread=telegram')
  expect(tg.messages.map((m: any) => m.text)).toEqual(['hi from telegram', 'hello', 'flushed, no id'])
  expect(tg.messages[2].id).toBe('2026-03-14T09:02:00.000Z|out')
  for (const body of [app, tg]) {
    const s = JSON.stringify(body)
    expect(s).not.toContain('1234567890')
    expect(s).not.toContain('chat_id')
    const keys = keysDeep(body)
    expect(keys.has('src') || keys.has('from')).toBe(false)
  }
})

test('chat: no allowlisted Telegram chat means an empty telegram thread', async () => {
  expect((await chatGet('thread=telegram')).messages).toEqual([])
})

test('chat: thread and cursor are validated; a cursor from before a restart resets', async () => {
  const { token } = dashToken('read')
  expect((await call('chat?thread=x', { token }, chatDeps())).status).toBe(400)
  expect((await call('chat', { token }, chatDeps())).status).toBe(400)
  expect((await call('chat?thread=app&after=-1', { token }, chatDeps())).status).toBe(400)
  expect((await call('chat?thread=app&after=abc', { token }, chatDeps())).status).toBe(400)
  expect(await chatGet('thread=app&after=5')).toMatchObject({ reset: true, messages: [], cursor: 0 })
})

test('chat: a poll answers at once with what arrived, otherwise waits for a push or typing', async () => {
  feed.push(entry('app', 'first'))
  expect(await chatGet('thread=app&after=0')).toMatchObject({ messages: [{ text: 'first' }], cursor: 1, typing: false })
  const waiting = chatGet('thread=app&after=1')
  await Bun.sleep(20)
  feed.push(entry('app', 'second'))
  expect(await waiting).toMatchObject({ messages: [{ text: 'second' }], cursor: 2 })
  const typed = chatGet('thread=app&after=2')
  await Bun.sleep(20)
  feed.setTyping(true)
  expect(await typed).toMatchObject({ messages: [], cursor: 2, typing: true })
  // A push to the other thread wakes a telegram poll, which comes back empty with a newer cursor.
  withOwner()
  feed.push(entry('app', 'third'))
  const tg = chatGet('thread=telegram&after=3')
  await Bun.sleep(20)
  feed.push(entry('app', 'fourth'))
  expect(await tg).toEqual({ thread: 'telegram', messages: [], cursor: 4, typing: false })
})

test('chat send: needs control, delivers once per id, refuses what it should', async () => {
  const id = UUID(2)
  expect((await chatPost({ thread: 'app', id, text: 'hello' }, dashToken('read').token)).status).toBe(403)
  const ok = await chatPost({ thread: 'app', id, text: '  hello  ' })
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({ id })
  expect(calls).toEqual([{ name: 'send', method: 'POST', body: { text: 'hello', id } }])
  expect(await (await chatPost({ thread: 'app', id, text: 'hello' })).json()).toEqual({ id, duplicate: true })
  expect(calls.length).toBe(1)
  for (const body of [
    { thread: 'telegram', id: UUID(3), text: 'hi' }, { thread: 'app', id: 'short', text: 'hi' }, { thread: 'app', id: UUID(4), text: '  ' },
    { thread: 'app', id: UUID(5), text: 'x'.repeat(4001) }, { thread: 'app', id: UUID(6), text: 'pair ABCD-EFGH' },
  ]) expect([body.text.slice(0, 8), (await chatPost(body)).status]).toEqual([body.text.slice(0, 8), 400])
  expect(calls.length).toBe(1)
})

test('chat send: without a sender it answers 501 and does not claim the id', async () => {
  const id = UUID(7)
  const d = chatDeps({ sendApp: undefined })
  expect((await chatPost({ thread: 'app', id, text: 'hi' }, undefined, d)).status).toBe(501)
  expect(d.chat.claim(id)).toBe(true)
})

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

test('calls: the relay\'s call comes back picked, with no page key or Vapi URL', async () => {
  const { token } = dashToken('read')
  const list = await (await call('calls', { token })).json()
  expect(list.calls).toEqual([{
    id: 'call-0001', to: '+440000000000', task: 'book a table', status: 'in-progress', seq: 3, createdAt: NOW, startedAt: NOW,
    lines: [{ role: 'assistant', text: 'Buongiorno' }], partial: { user: 'sì' }, takeover: true,
  }])
  expect(JSON.stringify(list)).not.toMatch(/pagekey|vapi\//)
  await call('calls?id=call-0001&after=2', { token })
  expect(calls.at(-1)!.body).toBe('/calls/call-0001?after=2')
  for (const bad of ['calls?id=../x', 'calls?id=call-0001&after=-1', 'calls?id=call-0001&after=x']) expect((await call(bad, { token })).status).toBe(400)
  expect((await call('calls?id=call-0002', { token })).status).toBe(404)
})

test('calls: controls need control and a known action; the relay\'s refusal reads as ok:false', async () => {
  const write = dashToken('write').token
  const post = (body: unknown) => call('calls/control', { method: 'POST', token: write, body })
  expect(await (await post({ id: 'call-0001', action: 'say', text: 'ciao' })).json()).toEqual({ ok: true })
  expect(await (await post({ id: 'call-0001', action: 'end' })).json()).toEqual({ ok: false, error: 'the call has ended' })
  for (const body of [{ id: 'call-0001', action: 'dial' }, { id: 'x', action: 'end' }, { id: 'call-0001', action: 'say', text: 'x'.repeat(501) }]) {
    expect((await post(body)).status).toBe(400)
  }
  expect(calls.filter(c => c.name === 'relay').length).toBe(2)
})

test('calls: listening takes only a read token and hands back the relay\'s one-time URL', async () => {
  const r = await call('calls/listen', { method: 'POST', token: dashToken('read').token, body: { id: 'call-0001' } })
  expect(await r.json()).toEqual({ url: 'wss://relay/listen/abc' })
})

test('calls: no relay configured answers 501, an unreachable one 503', async () => {
  const { token } = dashToken('read')
  delete process.env.VAPI_SERVER_SECRET
  expect((await call('calls', { token }, deps({ relay: undefined }))).status).toBe(501)
  expect((await call('calls', { token }, deps({ relay: async () => { throw new Error('refused') } }))).status).toBe(503)
})
