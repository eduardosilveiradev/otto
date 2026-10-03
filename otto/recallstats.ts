/**
 * Recall instrumentation — what was asked for and not found, and what gets used.
 *
 * `recall` is pull-only, so the store has no way to know which memories earn
 * their place. Two cheap counters fix that without touching how search works:
 *
 *   misses  a query that returned nothing from either store. A gap in memory
 *           looks identical to "never happened" from the inside; logging the
 *           query makes the gap visible, and a repeated miss is a fact worth
 *           writing down.
 *   hits    how many times each memory was actually returned by a query.
 *           Memories that never come back are either unfindable (bad
 *           description) or dead (no longer true); either way the audit
 *           surfaces them for a human to fix or retire.
 *
 * Only queries with words in them count. An empty query is "list the recent
 * ones" — browsing, not asking — and counting it would make whatever was
 * written last look popular.
 *
 * Nothing here decides anything or deletes anything; it reports.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { tokenize, type Memory } from './memory.ts'

const DAY = 24 * 60 * 60 * 1000

export type Miss = {
  /** First wording seen; later phrasings that normalise the same are folded in. */
  query: string
  count: number
  firstAt: string
  lastAt: string
  /** Set when a later query with the same words did find something. */
  resolvedAt?: string
}

export type HitRecord = { count: number; firstAt: string; lastAt: string }

export type RecallStats = {
  /** When counting began — a memory cannot be "never hit" for longer than this. */
  since: string
  misses: Record<string, Miss>
  hits: Record<string, HitRecord>
}

export const MAX_MISSES = 200
/** Safety net only — the nightly pass prunes deleted memories; this bounds a store that never runs it. */
export const MAX_HITS = 5000
const QUERY_MAX = 120

export function emptyStats(now = Date.now()): RecallStats {
  return { since: new Date(now).toISOString(), misses: {}, hits: {} }
}

export function loadStats(file: string, now = Date.now()): RecallStats {
  try {
    const p = JSON.parse(readFileSync(file, 'utf8')) as Partial<RecallStats>
    if (p && typeof p === 'object' && typeof p.since === 'string') {
      return {
        since: p.since,
        misses: p.misses && typeof p.misses === 'object' ? p.misses : {},
        hits: p.hits && typeof p.hits === 'object' ? p.hits : {},
      }
    }
  } catch {}
  return emptyStats(now)
}

export function saveStats(file: string, s: RecallStats): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

/** Order-insensitive, stemmed: "landlord deposit" and "deposit landlords" are one gap. */
export function missKey(query: string): string {
  const t = tokenize(query)
  return t.length ? [...new Set(t)].sort().join(' ') : query.trim().toLowerCase()
}

export const memoryKey = (m: Pick<Memory, 'scope' | 'name'>) => `${m.scope}/${m.name}`

/**
 * Record one recall call. `returned` is what was actually handed back (after
 * the limit), as memory keys and note ids, so a hit means "it was in front of
 * the assistant", not "it matched somewhere below the cut".
 */
export function recordRecall(
  stats: RecallStats,
  call: { query: string; memories: string[]; noteIds: string[]; now?: number },
): RecallStats {
  const query = call.query.trim()
  if (!query) return stats
  const at = new Date(call.now ?? Date.now()).toISOString()
  const key = missKey(query)
  const found = call.memories.length + call.noteIds.length > 0

  if (!found) {
    const prior = stats.misses[key]
    if (prior) {
      prior.count++
      prior.lastAt = at
      delete prior.resolvedAt // asked again and still nothing: the gap is open again
    } else {
      stats.misses[key] = { query: query.slice(0, QUERY_MAX), count: 1, firstAt: at, lastAt: at }
      const keys = Object.keys(stats.misses)
      if (keys.length > MAX_MISSES) {
        // Oldest activity goes first; a gap nobody has hit lately is the least urgent.
        keys.sort((a, b) => stats.misses[a].lastAt.localeCompare(stats.misses[b].lastAt))
        for (const k of keys.slice(0, keys.length - MAX_MISSES)) delete stats.misses[k]
      }
    }
    return stats
  }

  if (stats.misses[key] && !stats.misses[key].resolvedAt) stats.misses[key].resolvedAt = at
  for (const k of [...call.memories, ...call.noteIds.map(id => `note:${id}`)]) {
    const h = stats.hits[k]
    if (h) { h.count++; h.lastAt = at }
    else stats.hits[k] = { count: 1, firstAt: at, lastAt: at }
  }
  const keys = Object.keys(stats.hits)
  if (keys.length > MAX_HITS) {
    keys.sort((a, b) => stats.hits[a].lastAt.localeCompare(stats.hits[b].lastAt))
    for (const k of keys.slice(0, keys.length - MAX_HITS)) delete stats.hits[k]
  }
  return stats
}

/**
 * Drop counters for memories and notes that no longer exist. A deleted memory's
 * count is not evidence about anything, and left alone the table only grows.
 * `live` holds memory keys and `note:<id>` keys.
 */
export function pruneHits(stats: RecallStats, live: Set<string>): number {
  let n = 0
  for (const k of Object.keys(stats.hits)) {
    if (!live.has(k)) { delete stats.hits[k]; n++ }
  }
  return n
}

/** True when a recall with this query would be counted at all. */
export const countsQuery = (query: string) => query.trim().length > 0

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

export type AuditOpts = {
  now?: number
  /** A memory nothing has touched (written or returned) for this long is stale. */
  staleDays?: number
  /** A memory must have been exposed to this many days of counting to be "never hit". */
  graceDays?: number
  /** Derived memories that are outputs of a pass, not knowledge worth auditing. */
  skipNames?: string[]
}

export type AuditRow = { key: string; type: string; description: string; ageDays: number; hits: number; lastHitDays?: number }

export type Audit = {
  trackingDays: number
  neverHit: AuditRow[]
  stale: AuditRow[]
  topHit: AuditRow[]
  misses: (Miss & { key: string })[]
}

export function auditMemories(memories: Memory[], stats: RecallStats, opts: AuditOpts = {}): Audit {
  const now = opts.now ?? Date.now()
  const staleMs = (opts.staleDays ?? 180) * DAY
  const graceMs = (opts.graceDays ?? 30) * DAY
  const skip = new Set(opts.skipNames ?? [])
  const since = Date.parse(stats.since)

  const neverHit: AuditRow[] = []
  const stale: AuditRow[] = []
  const all: AuditRow[] = []

  for (const m of memories) {
    if (skip.has(m.name)) continue
    const key = memoryKey(m)
    const h = stats.hits[key]
    const lastHit = h ? Date.parse(h.lastAt) : NaN
    const row: AuditRow = {
      key,
      type: m.type,
      description: m.description || m.body.slice(0, 80),
      ageDays: Math.floor((now - m.mtimeMs) / DAY),
      hits: h?.count ?? 0,
      ...(h ? { lastHitDays: Math.floor((now - lastHit) / DAY) } : {}),
    }
    all.push(row)
    if (!h) {
      // Exposure runs from whichever is later: it was written, or counting began.
      const exposed = now - Math.max(m.mtimeMs, Number.isNaN(since) ? m.mtimeMs : since)
      if (exposed >= graceMs) neverHit.push(row)
    } else if (now - lastHit >= staleMs && now - m.mtimeMs >= staleMs) {
      stale.push(row)
    }
  }

  const byAge = (a: AuditRow, b: AuditRow) => b.ageDays - a.ageDays
  return {
    trackingDays: Number.isNaN(since) ? 0 : Math.floor((now - since) / DAY),
    neverHit: neverHit.sort(byAge),
    stale: stale.sort((a, b) => (b.lastHitDays ?? 0) - (a.lastHitDays ?? 0)),
    topHit: all.filter(r => r.hits).sort((a, b) => b.hits - a.hits).slice(0, 5),
    misses: Object.entries(stats.misses)
      .filter(([, m]) => !m.resolvedAt)
      .map(([key, m]) => ({ key, ...m }))
      .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)),
  }
}

export function formatAudit(a: Audit, opts: { limit?: number; section?: 'never_hit' | 'stale' | 'misses' | 'all' } = {}): string {
  const limit = opts.limit ?? 10
  const want = (s: string) => !opts.section || opts.section === 'all' || opts.section === s
  const row = (r: AuditRow) =>
    `  ${r.key} (${r.type}, ${r.ageDays}d old${r.hits ? `, ${r.hits} hits, last ${r.lastHitDays}d ago` : ''}) — ${r.description.slice(0, 90)}`
  const out = [`Counting for ${a.trackingDays} day(s).${a.trackingDays < 30 ? ' Early days — never-hit is provisional.' : ''}`]
  const section = <T>(title: string, rows: T[], fmt: (r: T) => string) => {
    if (!rows.length) return
    out.push(`${title} (${rows.length}${rows.length > limit ? `, first ${limit}` : ''}):`, ...rows.slice(0, limit).map(fmt))
  }
  if (want('never_hit')) section('NEVER RETURNED', a.neverHit, row)
  if (want('stale')) section('STALE (used once, not lately)', a.stale, row)
  if (want('misses')) {
    section('RECALL MISSES (unresolved)', a.misses, m => `  "${m.query}" ×${m.count}, last ${m.lastAt.slice(0, 10)}`)
  }
  if (opts.section === 'all' || !opts.section) section('MOST USED', a.topHit, row)
  return out.length > 1 ? out.join('\n') : `${out[0]}\nNothing to report.`
}
