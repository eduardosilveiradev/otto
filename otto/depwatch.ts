/**
 * The dependency compromise watch.
 *
 * Otto runs other people's code with the keys to the user's mail: the npm
 * packages in otto/bun.lock and the Python packages in the voice and embed
 * venvs. A release that is later marked malicious is noticed on the registry
 * within hours and on a laptop never, unless something asks. Once a day this
 * lists the exact installed versions and asks OSV.dev about every one of them.
 *
 * Only two things are ever said: a release OSV marks malicious (MAL-*, urgent)
 * and a high or critical advisory (normal priority, so it waits out quiet hours).
 * Everything else is an otto_status line. Each finding is told once per
 * installed version: the told set is keyed by package, version and advisory id,
 * so upgrading starts the slate clean with no reset step to forget, and a
 * finding that stays open is never repeated.
 *
 * A failed lookup is recorded and retried tomorrow, never messaged; the told
 * and open sets are left exactly as they were. The network is injected so the
 * tests run offline. `bun otto/depwatch.ts` runs one real check by hand
 * without saving or messaging.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { loadState, saveState } from './statefile.ts'

export type Dep = { ecosystem: 'npm' | 'PyPI'; name: string; version: string; source: string }
export type Severity = 'malicious' | 'high' | 'low'
export type Finding = { key: string; dep: Dep; id: string; severity: Severity; summary: string; aliases: string[] }
export type DepwatchState = {
  lastRunAt?: string
  lastError?: string
  deps?: number
  /** Finding key -> ISO time it was first seen; the one-warning-per-version memory. */
  told: Record<string, string>
  open: Finding[]
}
export type DepwatchDeps = { fetch: (url: string, init?: RequestInit) => Promise<Response>; now: number }

export const STATE_FILE_NAME = 'depwatch.json'
export const OSV_BATCH = 'https://api.osv.dev/v1/querybatch'
export const OSV_VULN = 'https://api.osv.dev/v1/vulns/'

const TIMEOUT_MS = 20_000
const CHUNK = 1000
const DAY_MS = 24 * 60 * 60_000

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** bun.lock is JSONC: trailing commas are the only extension it uses. */
export function parseBunLock(text: string, source = 'otto/bun.lock'): Dep[] {
  const parsed = JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'))
  const seen = new Set<string>()
  const out: Dep[] = []
  for (const tuple of Object.values<unknown>(parsed.packages ?? {})) {
    const spec = Array.isArray(tuple) ? tuple[0] : undefined
    if (typeof spec !== 'string') continue
    const at = spec.lastIndexOf('@')   // scoped names start with '@'
    if (at <= 0) continue
    const name = spec.slice(0, at)
    const version = spec.slice(at + 1)
    // Nested keys ("body-parser/content-type") repeat a package already listed.
    if (seen.has(`${name}@${version}`)) continue
    seen.add(`${name}@${version}`)
    out.push({ ecosystem: 'npm', name, version, source })
  }
  return out
}

/** site-packages entries -> installed PyPI packages; names normalised per PEP 503. */
export function parseDistInfo(entries: string[], source: string): Dep[] {
  const out: Dep[] = []
  for (const e of entries) {
    const m = /^(.+?)-(\d[^-]*)\.dist-info$/.exec(e)
    if (m) out.push({ ecosystem: 'PyPI', name: m[1]!.toLowerCase().replace(/[-_.]+/g, '-'), version: m[2]!, source })
  }
  return out
}

// ---------------------------------------------------------------------------
// OSV shaping
// ---------------------------------------------------------------------------

/** Chunks of 1000, index-aligned with the batch results. */
export function osvQueries(deps: Dep[]): { queries: { version: string; package: { name: string; ecosystem: string } }[] }[] {
  const out = []
  for (let i = 0; i < deps.length; i += CHUNK) {
    out.push({ queries: deps.slice(i, i + CHUNK).map(d => ({ version: d.version, package: { name: d.name, ecosystem: d.ecosystem } })) })
  }
  return out
}

type Vuln = {
  id: string
  aliases?: string[]
  summary?: string
  database_specific?: { severity?: string }
  affected?: { ecosystem_specific?: { severity?: string } }[]
}

// ponytail: no CVSS vector scoring; PYSEC-only advisories rank low. Add a CVSS3 base-score parser when a status row shows one worth telling.
export function classify(v: Vuln): Severity {
  if (v.id.startsWith('MAL-') || (v.aliases ?? []).some(a => a.startsWith('MAL-'))) return 'malicious'
  const sev = (v.database_specific?.severity ?? v.affected?.[0]?.ecosystem_specific?.severity ?? '').toUpperCase()
  return sev === 'HIGH' || sev === 'CRITICAL' ? 'high' : 'low'
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

const depKey = (d: Dep) => `${d.ecosystem}:${d.name}@${d.version}`

export function diffFindings(found: Finding[], deps: Dep[], state: DepwatchState, now: number): { alerts: Finding[]; state: DepwatchState } {
  // The first run seeds the told set: what was already installed is status, not news. Malicious still speaks.
  const first = !state.lastRunAt
  const alerts = found.filter(f => !(f.key in state.told) && (first ? f.severity === 'malicious' : f.severity !== 'low'))
  const installed = new Set(deps.map(depKey))
  const told: Record<string, string> = { ...state.told }
  for (const f of found) told[f.key] ??= new Date(now).toISOString()
  // A key for a version no longer installed is history; the next release starts fresh.
  for (const k of Object.keys(told)) if (!installed.has(k.slice(0, k.lastIndexOf(':')))) delete told[k]
  const { lastError: _gone, ...rest } = state
  return { alerts, state: { ...rest, told, open: found, lastRunAt: new Date(now).toISOString(), deps: deps.length } }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const line = (f: Finding, summary = '') =>
  `• ${f.dep.name}@${f.dep.version} (${f.dep.source}) — ${f.id}${summary ? ` ${summary}` : ''} https://osv.dev/vulnerability/${f.id}`

// The channel sends these as one plain Telegram message (4096-char cap, no splitting), after the
// findings are already saved as told: a send that fails on length would lose them for good.
const MAX_LINES = 15
const lines = (fs: Finding[], fmt: (f: Finding) => string) =>
  fs.slice(0, MAX_LINES).map(fmt).join('\n') + (fs.length > MAX_LINES ? `\n…and ${fs.length - MAX_LINES} more` : '')

export function formatDepAlerts(alerts: Finding[]): { text: string; urgent: boolean }[] {
  const mal = alerts.filter(f => f.severity === 'malicious')
  const high = alerts.filter(f => f.severity === 'high')
  const out: { text: string; urgent: boolean }[] = []
  if (mal.length) {
    const n = mal.length
    out.push({
      text: `security: ${n} dependenc${n === 1 ? 'y' : 'ies'} otto runs ${n === 1 ? 'is' : 'are'} flagged malicious on osv.dev\n${lines(mal, f => line(f))}\nstop the channel and check before the next restart installs it again.`,
      urgent: true,
    })
  }
  if (high.length) {
    const n = high.length
    out.push({
      text: `heads up: ${n} high/critical advisor${n === 1 ? 'y' : 'ies'} on packages otto runs\n${lines(high, f => line(f, f.summary.replace(/\s+/g, ' ').trim().slice(0, 80)))}`,
      urgent: false,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// ponytail: ignores results[i].next_page_token; a package with over a page of advisories is already flagged.
export async function runDepwatch(deps: Dep[], state: DepwatchState, d: DepwatchDeps): Promise<{ alerts: Finding[]; state: DepwatchState }> {
  const get = async (url: string, init?: RequestInit) => {
    const res = await d.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
    return res.json() as Promise<any>
  }
  try {
    // An empty list would read as "no known advisories" and wipe the told set; treat it as a failure.
    if (!deps.length) throw new Error('no installed packages found')
    const found: Finding[] = []
    const queries = osvQueries(deps)
    for (let c = 0; c < queries.length; c++) {
      const body = await get(OSV_BATCH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(queries[c]) })
      const results: { vulns?: { id: string }[] }[] = body.results ?? []
      for (let i = 0; i < queries[c]!.queries.length; i++) {
        const dep = deps[c * CHUNK + i]!
        for (const { id } of results[i]?.vulns ?? []) {
          const key = `${depKey(dep)}:${id}`
          const known = key in state.told ? state.open.find(f => f.key === key) : undefined
          if (known) { found.push(known); continue }
          const v: Vuln = await get(OSV_VULN + encodeURIComponent(id))
          found.push({ key, dep, id, severity: classify(v), summary: v.summary ?? '', aliases: v.aliases ?? [] })
        }
      }
    }
    return diffFindings(found, deps, state, d.now)
  } catch (err) {
    return { alerts: [], state: { ...state, lastError: String(err).slice(0, 200), lastRunAt: new Date(d.now).toISOString() } }
  }
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** Everything otto runs: its own lockfile and the voice and embed venvs. Missing pieces are skipped. */
export function collectInstalled(ottoDir: string, stateDir: string): Dep[] {
  const all: Dep[] = []
  const lock = join(ottoDir, 'bun.lock')
  if (existsSync(lock)) all.push(...parseBunLock(readFileSync(lock, 'utf8')))
  for (const name of ['voice', 'embed']) {
    const lib = join(stateDir, name, '.venv', 'lib')
    if (!existsSync(lib)) continue
    for (const py of readdirSync(lib)) {
      const sp = join(lib, py, 'site-packages')
      if (py.startsWith('python') && existsSync(sp)) all.push(...parseDistInfo(readdirSync(sp), `${name} venv`))
    }
  }
  const seen = new Set<string>()
  return all.filter(d => !seen.has(depKey(d)) && !!seen.add(depKey(d)))
}

const valid = (x: unknown) => !!x && typeof x === 'object' && !!(x as DepwatchState).told && Array.isArray((x as DepwatchState).open)
const empty = (): DepwatchState => ({ told: {}, open: [] })

export const loadDepwatch = (file: string): DepwatchState => loadState(file, empty, valid)
export const saveDepwatch = (file: string, s: DepwatchState): void => saveState(file, s)

export function depwatchStatus(s: DepwatchState | null, now: number): { verdict: 'up' | 'degraded' | 'down' | 'unknown'; at?: number; detail: string } {
  if (!s?.lastRunAt) return { verdict: 'unknown', detail: 'has not run yet (daily from 06:00)' }
  const at = Date.parse(s.lastRunAt)
  if (s.lastError) return { verdict: 'degraded', at, detail: `osv lookup failed, retried tomorrow — ${s.lastError}` }
  const mal = s.open.filter(f => f.severity === 'malicious')
  if (mal.length) return { verdict: 'down', at, detail: `${mal.length} malicious: ${mal.map(f => `${f.dep.name}@${f.dep.version}`).join(', ')}` }
  if (now - at > 2 * DAY_MS) return { verdict: 'degraded', at, detail: 'last check over 2 days ago' }
  const high = s.open.filter(f => f.severity === 'high').length
  const adv = s.open.length
  return { verdict: 'up', at, detail: `${s.deps ?? 0} packages (npm + PyPI), ${adv ? `${adv} advisories: ${high} high/critical, ${adv - high} lower` : 'no known advisories'}` }
}

if (import.meta.main) {
  const stateDir = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
  const deps = collectInstalled(import.meta.dir, stateDir)
  const state = structuredClone(loadDepwatch(join(stateDir, STATE_FILE_NAME)))
  const { alerts, state: next } = await runDepwatch(deps, state, { fetch: (u, i) => fetch(u, i), now: Date.now() })
  for (const m of formatDepAlerts(alerts)) console.log(`${m.urgent ? '[urgent] ' : ''}${m.text}\n`)
  console.log(depwatchStatus(next, Date.now()).detail)
}
