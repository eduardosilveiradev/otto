/**
 * The update butler.
 *
 * Once a week, no model: the dev tools on this Mac (Codex CLI, Claude Code,
 * bun, gh) and Homebrew's outdated formulae and casks, local version against
 * latest. Each gets one line of what changes, lifted from its own changelog or
 * release notes; when none can be fetched it says "no notes", never a guess.
 * One normal-priority card with [apply tonight] / [skip]. A list already
 * offered or skipped is not offered again; a newer version makes a new list.
 *
 * Apply waits for quiet hours, no T3 thread or coding job running, and a calm
 * load sample (runaway.ts). Until all three hold it waits, night after night.
 * Nothing is said after a clean run; a failure is told once, normal priority,
 * so it lands in the morning.
 *
 * Off unless access.json has `updates`. Commands, the network and the clock
 * are parameters, so the tests never touch the machine.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { loadState, saveState } from './statefile.ts'
import type { LoadState } from './runaway.ts'
import type { Card } from './cards.ts'

export type Exec = (cmd: string[], timeoutMs?: number) => Promise<string | undefined>
export type Fetch = (url: string) => Promise<string | undefined>
export type Update = { name: string; from: string; to: string; note: string; apply: string[] }
export type UpdatesState = {
  lastCheckAt?: string
  lastError?: string
  found?: number
  offer?: { key: string; items: Update[] }
  pending?: { key: string; items: Update[] }
  skipped?: string
  lastApply?: { at: string; ok: string[]; failed: string[] }
}

export const TOOLS = ['codex', 'claude', 'bun', 'gh', 'brew'] as const
export const WEEK_MS = 7 * 86_400_000
export const CHECK_HOUR = 10
const APPLY_TIMEOUT_MS = 15 * 60_000

/** `updates: {}` checks everything; `updates: { tools: ["claude", "brew"] }` narrows it. Absent: off. */
export function updatesConfig(raw: unknown): { tools: string[] } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const t = (raw as { tools?: unknown }).tools
  const tools = Array.isArray(t) ? t.filter((x): x is string => (TOOLS as readonly string[]).includes(x)) : [...TOOLS]
  return { tools }
}

const json = (s: string | undefined): any => { try { return s ? JSON.parse(s) : undefined } catch { return undefined } }
const ver = (s: string | undefined) => /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(s ?? '')?.[0]
const npmLatest = (pkg: string) => async (f: Fetch) => json(await f(`https://registry.npmjs.org/${pkg}/latest`))?.version as string | undefined
const ghRelease = (repo: string, tag: (v: string) => string) => async (v: string, f: Fetch) =>
  json(await f(`https://api.github.com/repos/${repo}/releases/tags/${tag(v)}`))?.body as string | undefined

type Tool = { latest: (f: Fetch) => Promise<string | undefined>; notes: (v: string, f: Fetch) => Promise<string | undefined>; apply: string[] }
// ponytail: one install method per tool (codex via npm, claude's own updater, gh via brew); per-tool apply override when someone installs differently.
export const KNOWN: Record<string, Tool> = {
  codex: { latest: npmLatest('@openai/codex'), notes: ghRelease('openai/codex', v => `rust-v${v}`), apply: ['npm', 'install', '-g', '@openai/codex@latest'] },
  claude: {
    latest: npmLatest('@anthropic-ai/claude-code'),
    notes: async (v, f) => (await f('https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md') ?? '')
      .split(/^## /m).find(sec => sec.split('\n', 1)[0]!.trim() === v),
    apply: ['claude', 'update'],
  },
  bun: { latest: npmLatest('bun'), notes: ghRelease('oven-sh/bun', v => `bun-v${v}`), apply: ['bun', 'upgrade'] },
  gh: {
    latest: async f => json(await f('https://formulae.brew.sh/api/formula/gh.json'))?.versions?.stable,
    notes: ghRelease('cli/cli', v => `v${v}`),
    apply: ['brew', 'upgrade', 'gh'],
  },
}

/** First bullet of a changelog section, as a plain sentence. Nothing usable: "no notes". */
export function noteLine(md: string | undefined): string {
  const bullet = (md ?? '').split('\n').map(l => /^\s*[-*]\s+(.+)/.exec(l)?.[1]).find(Boolean)
  if (!bullet) return 'no notes'
  let s = bullet
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')          // [text](url) -> text
    .replace(/\(?#\d+\)?|https?:\/\/\S+/g, '')          // PR refs and bare links
    .replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()
  if (s.length > 100) s = s.slice(0, 99).replace(/\s+\S*$/, '') + '…'
  return s && !/[.!?…]$/.test(s) ? s + '.' : s || 'no notes'
}

const newer = (from: string, to: string) => { try { return Bun.semver.order(from, to) < 0 } catch { return from !== to } }

/** Everything out of date. Throws only when nothing at all could be read. */
export async function detect(tools: string[], d: { exec: Exec; fetch: Fetch }): Promise<Update[]> {
  const out: Update[] = []
  let read = 0
  if (tools.includes('brew')) {
    await d.exec(['brew', 'update', '--quiet'], 5 * 60_000)   // a stale index still answers; only outdated counts
    const o = json(await d.exec(['brew', 'outdated', '--json=v2'], 60_000))
    if (o) {
      read++
      for (const [kind, list] of [['formula', o.formulae], ['cask', o.casks]] as const) {
        for (const p of list ?? []) {
          const from = [p.installed_versions].flat().at(-1)
          out.push({ name: p.name, from: String(from), to: String(p.current_version), note: '', apply: ['brew', 'upgrade', ...(kind === 'cask' ? ['--cask'] : []), p.name] })
        }
      }
    }
  }
  for (const name of tools) {
    const t = KNOWN[name]
    if (!t || out.some(u => u.name === name)) continue   // brew already listed it: its own upgrade path wins
    const [from, to] = [ver(await d.exec([name, '--version'], 15_000)), await t.latest(d.fetch).catch(() => undefined)]
    if (!from || !to) continue
    read++
    if (newer(from, to)) out.push({ name, from, to, note: '', apply: t.apply })
  }
  if (!read && tools.length) throw new Error('no version could be read')
  for (const u of out) u.note = noteLine(await KNOWN[u.name]?.notes(u.to, d.fetch).catch(() => undefined))
  return out
}

export const listKey = (items: Update[]) =>
  createHash('sha256').update(items.map(u => `${u.name}@${u.to}`).sort().join('\n')).digest('hex').slice(0, 8)

export function formatOffer(items: Update[], key: string): { text: string; card: Card; buttons: { label: string; data: string }[] } {
  const n = items.length
  const lead = `${n} update${n === 1 ? '' : 's'} waiting.`
  const shown = items.slice(0, 15)
  const more = n > shown.length ? `\n…and ${n - shown.length} more` : ''
  return {
    text: `${lead}\n${shown.map(u => `${u.name} ${u.from} → ${u.to}: ${u.note}`).join('\n')}${more}`,
    card: {
      title: lead,
      blocks: [{ type: 'list', items: shown.map(u => ({ title: u.name, detail: u.note.slice(0, 120), trailing: `${u.from} → ${u.to}`.slice(0, 120) })) }],
    },
    buttons: [{ label: 'apply tonight', data: `apply updates ${key}` }, { label: 'skip', data: `skip updates ${key}` }],
  }
}

/** The weekly pass. Returns the offer to send, or null. Mutates state. */
export async function checkUpdates(state: UpdatesState, tools: string[], d: { exec: Exec; fetch: Fetch; now: number }): Promise<ReturnType<typeof formatOffer> | null> {
  state.lastCheckAt = new Date(d.now).toISOString()
  let items: Update[]
  try { items = await detect(tools, d) } catch (err) { state.lastError = String(err).slice(0, 200); return null }
  delete state.lastError
  state.found = items.length
  if (!items.length) { delete state.offer; return null }
  const key = listKey(items)
  if ([state.skipped, state.offer?.key, state.pending?.key].includes(key)) return null
  state.offer = { key, items }
  return formatOffer(items, key)
}

export const checkDue = (s: UpdatesState, now: Date) =>
  now.getHours() >= CHECK_HOUR && (!s.lastCheckAt || now.getTime() - Date.parse(s.lastCheckAt) >= WEEK_MS - 3_600_000)

export const TAP_RE = /^(apply|skip) updates ([a-f0-9]{8})$/

/** [apply tonight] / [skip]. Null when the instruction isn't ours. */
export function updatesTap(state: UpdatesState, instruction: string): string | null {
  const m = TAP_RE.exec(instruction)
  if (!m) return null
  if (state.offer?.key !== m[2]) return state.pending?.key === m[2] ? 'Already set for tonight.' : 'That list is out of date; a fresh one comes with the next check.'
  if (m[1] === 'apply') state.pending = state.offer
  else state.skipped = m[2]
  delete state.offer
  return m[1] === 'apply' ? 'Tonight, once nothing is running.' : 'Skipped.'
}

/** A load sample is calm when it is fresh and nothing in it is over a line. */
export function loadCalm(s: LoadState, now: number): boolean {
  return !!s.at && now - s.at < 30 * 60_000 && !s.swapHotSince && !s.thermalHotSince
    && (s.sys?.pressure ?? 0) < 4 && !Object.values(s.procs).some(p => p.hotSince)
}

/** True when T3's database shows a live run. Any error counts as busy; no database is idle. */
export function t3Busy(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false
  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
    const run = db.query('SELECT status FROM orchestration_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1')
    const threads = db.query('SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL').all() as { thread_id: string }[]
    return threads.some(t => ['preparing', 'queued', 'starting', 'running', 'waiting'].includes((run.get(t.thread_id) as { status?: string } | null)?.status ?? ''))
  } catch { return true } finally { db?.close() }
}

/** The nightly tick. Returns a failure message to send once, or null. Mutates state. */
export async function applyTick(state: UpdatesState, o: { quiet: boolean; busy: boolean; calm: boolean; exec: Exec; now: number }): Promise<string | null> {
  if (!state.pending || !o.quiet || o.busy || !o.calm) return null
  const ok: string[] = [], failed: string[] = []
  for (const u of state.pending.items) ((await o.exec(u.apply, APPLY_TIMEOUT_MS)) === undefined ? failed : ok).push(u.name)
  delete state.pending
  state.lastApply = { at: new Date(o.now).toISOString(), ok, failed }
  if (!failed.length) return null
  return `${failed.length} update${failed.length === 1 ? '' : 's'} didn't apply last night: ${failed.join(', ')}.${ok.length ? ` ${ok.length} went in.` : ''}`
}

const valid = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x)
export const loadUpdates = (file: string): UpdatesState => loadState<UpdatesState>(file, () => ({}), valid)
export const saveUpdates = (file: string, s: UpdatesState): void => saveState(file, s)

export function updatesStatus(configured: boolean, s: UpdatesState | null, now: number): { verdict: 'up' | 'degraded' | 'off' | 'unknown'; at?: number; detail: string } {
  if (!configured) return { verdict: 'off', detail: 'off (updates in access.json)' }
  if (!s?.lastCheckAt) return { verdict: 'unknown', detail: 'has not run yet (weekly from 10:00)' }
  const at = Date.parse(s.lastCheckAt)
  if (s.lastError) return { verdict: 'degraded', at, detail: `check failed, retried next week — ${s.lastError}` }
  if (now - at > WEEK_MS + 2 * 86_400_000) return { verdict: 'degraded', at, detail: 'last check over 9 days ago' }
  const parts = [`${s.found ?? 0} out of date`]
  if (s.pending) parts.push(`${s.pending.items.length} set for tonight`)
  if (s.lastApply) parts.push(`last apply ${s.lastApply.at.slice(0, 10)}: ${s.lastApply.ok.length} ok${s.lastApply.failed.length ? `, failed ${s.lastApply.failed.join(', ')}` : ''}`)
  return { verdict: s.lastApply?.failed.length ? 'degraded' : 'up', at, detail: parts.join('; ') }
}
