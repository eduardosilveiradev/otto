import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseBunLock, parseDistInfo, collectInstalled, classify, osvQueries, runDepwatch, formatDepAlerts,
  depwatchStatus, loadDepwatch, saveDepwatch, OSV_BATCH, OSV_VULN, type Dep, type Finding, type DepwatchState,
} from '../depwatch.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-depwatch-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const DAY = 24 * 60 * 60_000
const T0 = Date.parse('2026-10-13T06:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const FIXTURE = readFileSync(join(import.meta.dir, 'fixtures', 'depwatch', 'bun.lock'), 'utf8')

const lockDeps = () => parseBunLock(FIXTURE)
const numpy: Dep = { ecosystem: 'PyPI', name: 'numpy', version: '2.4.6', source: 'voice venv' }

/** OSV stub: querybatch answers by package name; detail GETs are recorded. */
function osv(flags: Record<string, string>, details: Record<string, object>) {
  const urls: string[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    urls.push(url)
    if (url === OSV_BATCH) {
      const { queries } = JSON.parse(String(init!.body))
      return new Response(JSON.stringify({
        results: queries.map((q: any) => ({ vulns: flags[`${q.package.name}@${q.version}`] ? [{ id: flags[`${q.package.name}@${q.version}`] }] : [] })),
      }))
    }
    return new Response(JSON.stringify(details[decodeURIComponent(url.slice(OSV_VULN.length))]))
  }
  return { urls, fetch }
}

const FLAGS = { 'croner@9.1.0': 'MAL-2026-1', 'content-type@1.0.5': 'GHSA-high', 'numpy@2.4.6': 'GHSA-low' }
const DETAILS = {
  'MAL-2026-1': { id: 'MAL-2026-1', summary: 'Malicious code in croner' },
  'GHSA-high': { id: 'GHSA-high', summary: 'ReDoS', database_specific: { severity: 'HIGH' }, aliases: ['CVE-2026-1'] },
  'GHSA-low': { id: 'GHSA-low', summary: 'meh', database_specific: { severity: 'MODERATE' } },
}
const empty = (): DepwatchState => ({ told: {}, open: [] })

test('parseBunLock reads exact versions, scoped names and nested aliases once', () => {
  const deps = lockDeps()
  expect(deps.map(d => `${d.name}@${d.version}`).sort()).toEqual(
    ['@grammyjs/types@4.0.0', 'content-type@1.0.5', 'content-type@2.0.0', 'croner@9.1.0'])
  expect(deps.every(d => d.ecosystem === 'npm' && d.source === 'otto/bun.lock')).toBe(true)
})

test('parseBunLock tolerates trailing commas and rejects garbage', () => {
  expect(parseBunLock('{"packages": {"a": ["a@1.0.0", "", {},],},}')).toHaveLength(1)
  expect(() => parseBunLock('not json')).toThrow()
})

test('parseDistInfo keeps only dist-info dirs, names normalised', () => {
  const deps = parseDistInfo(['mlx_whisper-0.4.3.dist-info', 'numpy-2.4.6.dist-info', '__pycache__', 'distutils-precedence.pth', 'numpy'], 'voice venv')
  expect(deps).toEqual([
    { ecosystem: 'PyPI', name: 'mlx-whisper', version: '0.4.3', source: 'voice venv' },
    { ecosystem: 'PyPI', name: 'numpy', version: '2.4.6', source: 'voice venv' },
  ])
})

test('collectInstalled joins the lockfile and venvs; empty dirs give nothing', () => {
  const otto = mkdtempSync(join(tmp, 'otto-'))
  const state = mkdtempSync(join(tmp, 'state-'))
  copyFileSync(join(import.meta.dir, 'fixtures', 'depwatch', 'bun.lock'), join(otto, 'bun.lock'))
  const sp = join(state, 'voice', '.venv', 'lib', 'python3.12', 'site-packages')
  mkdirSync(join(sp, 'numpy-2.4.6.dist-info'), { recursive: true })
  expect(collectInstalled(otto, state)).toHaveLength(5)
  expect(collectInstalled(mkdtempSync(join(tmp, 'e1-')), mkdtempSync(join(tmp, 'e2-')))).toEqual([])
})

test('classify: malicious by id or alias, high only HIGH/CRITICAL', () => {
  expect(classify({ id: 'MAL-2026-9' })).toBe('malicious')
  expect(classify({ id: 'GHSA-x', aliases: ['MAL-1'] })).toBe('malicious')
  expect(classify({ id: 'GHSA-x', database_specific: { severity: 'CRITICAL' } })).toBe('high')
  expect(classify({ id: 'GHSA-x', database_specific: { severity: 'MODERATE' } })).toBe('low')
  expect(classify({ id: 'PYSEC-1' })).toBe('low')
  expect(classify({ id: 'X', affected: [{ ecosystem_specific: { severity: 'HIGH' } }] })).toBe('high')
})

test('osvQueries chunks by 1000', () => {
  const many = Array.from({ length: 1001 }, (_, i) => ({ ...numpy, name: `p${i}` }))
  const q = osvQueries([{ ecosystem: 'npm', name: 'croner', version: '9.1.0', source: 'otto/bun.lock' }, ...many.slice(1)])
  expect(q.map(c => c.queries.length)).toEqual([1000, 1])
  expect(q[0]!.queries[0]).toEqual({ version: '9.1.0', package: { name: 'croner', ecosystem: 'npm' } })
})

test('runDepwatch tells malicious and high once, low only stays open', async () => {
  const deps = [...lockDeps(), numpy]
  const a = osv(FLAGS, DETAILS)
  const seed = await runDepwatch(deps, empty(), { fetch: osv(FLAGS, DETAILS).fetch, now: T0 })
  expect(seed.alerts.map(f => f.id)).toEqual(['MAL-2026-1']) // first run: only malicious speaks, the rest is status
  const first = await runDepwatch(deps, { ...empty(), lastRunAt: iso(T0 - 86_400_000) }, { fetch: a.fetch, now: T0 })
  expect(first.alerts.map(f => f.id).sort()).toEqual(['GHSA-high', 'MAL-2026-1'])
  expect(first.state.open).toHaveLength(3)
  expect(Object.values(first.state.told)).toEqual([iso(T0), iso(T0), iso(T0)])
  expect(a.urls.filter(u => u.startsWith(OSV_VULN))).toHaveLength(3)

  const b = osv(FLAGS, DETAILS)
  const second = await runDepwatch(deps, first.state, { fetch: b.fetch, now: T0 + DAY })
  expect(second.alerts).toEqual([])
  expect(b.urls.filter(u => u.startsWith(OSV_VULN))).toHaveLength(0)
  expect(second.state.told).toEqual(first.state.told)
})

test('a bumped version starts fresh', async () => {
  const deps = [...lockDeps(), numpy]
  const first = await runDepwatch(deps, empty(), { fetch: osv(FLAGS, DETAILS).fetch, now: T0 })
  const bumped = deps.map(d => d.name === 'croner' ? { ...d, version: '9.2.0' } : d)
  const next = await runDepwatch(bumped, first.state, { fetch: osv({ ...FLAGS, 'croner@9.2.0': 'MAL-2026-1' }, DETAILS).fetch, now: T0 + DAY })
  expect(next.alerts.map(f => f.key)).toEqual(['npm:croner@9.2.0:MAL-2026-1'])
  expect(next.state.told['npm:croner@9.2.0:MAL-2026-1']).toBeDefined()
  expect(next.state.told['npm:croner@9.1.0:MAL-2026-1']).toBeUndefined()
})

test('a failed lookup alerts nothing and leaves told and open alone', async () => {
  const deps = [...lockDeps(), numpy]
  const first = await runDepwatch(deps, empty(), { fetch: osv(FLAGS, DETAILS).fetch, now: T0 })
  const down = await runDepwatch(deps, first.state, { fetch: async () => { throw new Error('offline') }, now: T0 + DAY })
  expect(down.alerts).toEqual([])
  expect(down.state.lastError).toContain('offline')
  expect(down.state.told).toEqual(first.state.told)
  expect(down.state.open).toEqual(first.state.open)
  expect(down.state.lastRunAt).toBe(iso(T0 + DAY))
  // A lockfile that went missing is a failure too, not "no known advisories" with the told set wiped.
  const none = await runDepwatch([], first.state, { fetch: osv(FLAGS, DETAILS).fetch, now: T0 + DAY })
  expect(none.state.lastError).toContain('no installed packages')
  expect(none.state.told).toEqual(first.state.told)
})

test('formatDepAlerts: one urgent malicious message, one normal high one', () => {
  const dep = (name: string, version: string): Dep => ({ ecosystem: 'npm', name, version, source: 'otto/bun.lock' })
  const f = (d: Dep, id: string, severity: Finding['severity']): Finding => ({ key: `${d.name}:${id}`, dep: d, id, severity, summary: 'x'.repeat(200), aliases: [] })
  const msgs = formatDepAlerts([f(dep('croner', '9.1.0'), 'MAL-2026-1', 'malicious'), f(dep('zod', '3.0.0'), 'MAL-2026-2', 'malicious'), f(dep('hono', '4.0.0'), 'GHSA-h', 'high')])
  expect(msgs).toHaveLength(2)
  expect(msgs[0]!.urgent).toBe(true)
  for (const s of ['croner@9.1.0', '(otto/bun.lock)', 'MAL-2026-1', 'osv.dev/vulnerability/MAL-2026-1']) expect(msgs[0]!.text).toContain(s)
  expect(msgs[1]!.urgent).toBe(false)
  expect(msgs[1]!.text).not.toContain('x'.repeat(81))
  expect(msgs.every(m => m.text.length < 1500)).toBe(true)
  expect(formatDepAlerts([])).toEqual([])
  // One plain Telegram message, never over its 4096-char cap, one line per finding.
  const many = Array.from({ length: 40 }, (_, i) => ({ ...f(dep(`@scope/package-${i}`, '10.20.30'), `GHSA-aaaa-bbbb-${i}`, 'high'), summary: 'a\nb '.repeat(60) }))
  const [big] = formatDepAlerts(many)
  expect(big!.text.length).toBeLessThan(4096)
  expect(big!.text.split('\n')).toHaveLength(1 + 15 + 1)
  expect(big!.text).toContain('and 25 more')
})

test('depwatchStatus verdicts', async () => {
  const deps = [...lockDeps(), numpy]
  const { state } = await runDepwatch(deps, empty(), { fetch: osv(FLAGS, DETAILS).fetch, now: T0 })
  expect(depwatchStatus(null, T0)).toMatchObject({ verdict: 'unknown', detail: expect.stringContaining('has not run yet') })
  const mal = depwatchStatus(state, T0)
  expect(mal.verdict).toBe('down')
  expect(mal.detail).toContain('croner@9.1.0')
  expect(depwatchStatus({ ...state, lastError: 'boom' }, T0).detail).toContain('retried tomorrow')
  const clean: DepwatchState = { lastRunAt: iso(T0), told: {}, open: [], deps: 10 }
  expect(depwatchStatus(clean, T0 + 3 * DAY)).toMatchObject({ verdict: 'degraded', detail: expect.stringContaining('over 2 days') })
  expect(depwatchStatus(clean, T0)).toMatchObject({ verdict: 'up', detail: expect.stringContaining('no known advisories') })
})

test('loadDepwatch moves a corrupt file aside; save round-trips', () => {
  const dir = mkdtempSync(join(tmp, 'st-'))
  const file = join(dir, 'depwatch.json')
  writeFileSync(file, '{nope')
  expect(loadDepwatch(file)).toEqual(empty())
  expect(readdirSync(dir).some(n => n.includes('corrupt'))).toBe(true)
  const s: DepwatchState = { lastRunAt: iso(T0), told: { a: 'b' }, open: [], deps: 3 }
  saveDepwatch(file, s)
  expect(loadDepwatch(file)).toEqual(s)
})
