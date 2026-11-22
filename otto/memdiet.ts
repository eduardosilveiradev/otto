/**
 * Memory diet. On the 1st of each month the channel measures what every session
 * pays before the user types a word, and proposes trimming the memory part.
 *
 * What is measured: the files Claude Code puts in front of the session first.
 * Every CLAUDE.md and CLAUDE.local.md from the repo up to `/`, ~/.claude/CLAUDE.md,
 * and the project MEMORY.md (only its first 200 lines load). chars/4 stands in for
 * tokens: enough for "~9k", and no tokenizer dependency.
 *
 * What is proposed, at most 20 actions: drop the index line of a memory nothing
 * has recalled (the file stays searchable), or delete a memory a newer one
 * replaced. Declined or ignored actions never come back. CLAUDE.md is measured,
 * never edited. Nothing here writes on its own: the server applies a plan only
 * after Approve in the app.
 */
import { readFileSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import { loadState, saveState } from './statefile.ts'
import { tokenize, removeFromIndex, dirForScope, invalidateCache, type Memory } from './memory.ts'
import { similar, HOUSE_RULES_NAME } from './houserules.ts'
import { memoryKey, type AuditRow } from './recallstats.ts'

export const DIET_STATE_NAME = 'memdiet.json'
export const MAX_ACTIONS = 20
export const INDEX_LINES = 200
export const approxTokens = (s: string) => Math.ceil(s.length / 4)

/** The ~/.claude/projects naming. */
export const projectSlug = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-')

/** In load order; the project MEMORY.md is always last (the server reads the index from it). */
export function contextFiles(repoRoot: string, home: string): string[] {
  const out: string[] = []
  for (let dir = repoRoot; ; dir = dirname(dir)) {
    out.push(join(dir, 'CLAUDE.md'), join(dir, 'CLAUDE.local.md'))
    if (dirname(dir) === dir) break
  }
  out.push(join(home, '.claude', 'CLAUDE.md'), join(home, '.claude', 'projects', projectSlug(repoRoot), 'memory', 'MEMORY.md'))
  return out
}

export function measureContext(files: { path: string; text: string | null }[]): { files: { path: string; tokens: number }[]; tokens: number } {
  const out = files.flatMap(f => f.text === null ? [] : [{
    path: f.path,
    tokens: approxTokens(basename(f.path) === 'MEMORY.md' ? f.text.split('\n').slice(0, INDEX_LINES).join('\n') : f.text),
  }])
  return { files: out, tokens: out.reduce((n, f) => n + f.tokens, 0) }
}

/** `file` and `by` are basenames without .md: index lines key on the file name, which can differ from the frontmatter name. */
export type DietAction =
  | { kind: 'unindex'; scope: string; file: string; line: string; days: number }
  | { kind: 'drop'; scope: string; file: string; by: string; line?: string; head: string }

export const actionKey = (a: DietAction) => `${a.kind}:${a.scope}/${a.file}`

/** Same scope and type, newest first, greedy the way compileHouseRules pairs them: an older memory maps to the newest similar one, and one already marked older can't be a "newer". */
export function superseded(memories: Memory[]): { older: Memory; newer: Memory }[] {
  const out: { older: Memory; newer: Memory }[] = []
  const groups = new Map<string, Memory[]>()
  for (const m of memories) {
    if (m.name === HOUSE_RULES_NAME) continue
    const k = `${m.scope}\0${m.type}`
    groups.set(k, [...(groups.get(k) ?? []), m])
  }
  for (const g of groups.values()) {
    g.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
    const kept: { m: Memory; tokens: Set<string> }[] = []
    for (const m of g) {
      const tokens = new Set(tokenize(m.description))
      const twin = kept.find(k => similar(k.tokens, tokens, 0.6))
      if (twin) out.push({ older: m, newer: twin.m })
      else kept.push({ m, tokens })
    }
  }
  return out
}

const indexLine = (text: string, file: string) => text.split('\n').find(l => l.includes(`(${file}.md)`))

export function planDiet(o: {
  memories: Memory[]
  neverHit: AuditRow[]
  indexText: string
  indexScope: string
  indexFor: (scope: string) => string
  declined: string[]
  max?: number
}): DietAction[] {
  const drops: DietAction[] = superseded(o.memories)
    .sort((a, b) => a.older.mtimeMs - b.older.mtimeMs)
    .map(({ older, newer }) => {
      const file = basename(older.path, '.md')
      const line = indexLine(o.indexFor(older.scope), file)
      return {
        kind: 'drop' as const, scope: older.scope, file, by: basename(newer.path, '.md'),
        ...(line ? { line } : {}), head: older.body.split('\n').filter(l => l.trim()).slice(0, 3).join('\n'),
      }
    })
  const dropped = new Set(drops.map(actionKey).map(k => k.replace(/^drop:/, '')))
  const byKey = new Map(o.memories.map(m => [memoryKey(m), m]))
  const unindexes: DietAction[] = []
  for (const row of [...o.neverHit].sort((a, b) => b.ageDays - a.ageDays)) {
    const m = byKey.get(row.key)
    if (!m || m.scope !== o.indexScope) continue
    const file = basename(m.path, '.md')
    const line = indexLine(o.indexText, file)
    if (!line || dropped.has(`${m.scope}/${file}`)) continue
    unindexes.push({ kind: 'unindex', scope: m.scope, file, line, days: row.ageDays })
  }
  const skip = new Set(o.declined)
  return [...drops, ...unindexes].filter(a => !skip.has(actionKey(a))).slice(0, o.max ?? MAX_ACTIONS)
}

/** What the app's approval screen shows. Capped so one screen carries it. */
export function renderDiff(actions: DietAction[]): string {
  const lines: string[] = []
  const scopes = [...new Set(actions.map(a => a.scope))]
  for (const scope of scopes) {
    const idx = actions.filter(a => a.scope === scope).flatMap(a => a.line ? [a.line] : [])
    if (idx.length) lines.push(`--- ${scope}/MEMORY.md`, ...idx.map(l => `- ${l}`))
  }
  for (const a of actions) {
    if (a.kind === 'drop') lines.push(`--- ${a.scope}/${a.file}.md (deleted; ${a.by} replaces it)`, ...a.head.split('\n').map(l => `- ${l}`))
  }
  const LIMIT = 4000
  let out = '', n = 0
  for (; n < lines.length; n++) {
    if (out.length + lines[n].length + 1 > LIMIT - 30) break
    out += (out ? '\n' : '') + lines[n]
  }
  return n < lines.length ? `${out}\n… ${lines.length - n} more lines` : out
}

/** Each scope's MEMORY.md, then each dropped file, once. */
export function dietPaths(actions: DietAction[], dirFor: (scope: string) => string = dirForScope): string[] {
  const out = new Set<string>()
  for (const a of actions) out.add(join(dirFor(a.scope), 'MEMORY.md'))
  for (const a of actions) if (a.kind === 'drop') out.add(join(dirFor(a.scope), `${a.file}.md`))
  return [...out]
}

/** Idempotent: a line already gone or a file already deleted counts nothing and writes nothing. */
export function applyDiet(actions: DietAction[], dirFor: (scope: string) => string = dirForScope): number {
  let n = 0
  const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
  for (const a of actions) {
    const dir = dirFor(a.scope)
    if (a.kind === 'unindex') {
      if (!indexLine(read(join(dir, 'MEMORY.md')), a.file)) continue
      removeFromIndex(dir, a.file); n++
    } else {
      // The newer one must still be there, or the older is the only copy.
      if (!read(join(dir, `${a.by}.md`)) || !read(join(dir, `${a.file}.md`))) continue
      rmSync(join(dir, `${a.file}.md`), { force: true })
      removeFromIndex(dir, a.file); n++
    }
  }
  invalidateCache()
  return n
}

export type DietRun = {
  month: string; at: string; tokens: number; files: { path: string; tokens: number }[]
  actions: DietAction[]
  status: 'offered' | 'approved' | 'declined' | 'ignored' | 'quiet'
}
export type DietState = { runs: DietRun[]; declined: string[] }

export function loadDietState(file: string): DietState {
  return loadState<DietState>(file, () => ({ runs: [], declined: [] }), v => !!v && Array.isArray((v as any).runs) && Array.isArray((v as any).declined))
}

export function saveDietState(file: string, s: DietState): void {
  saveState(file, { ...s, runs: s.runs.slice(-12) })
}

export function formatDietOffer(r: DietRun): { text: string; buttons: { label: string; data: string }[] } | null {
  if (!r.actions.length) return null
  const u = r.actions.filter(a => a.kind === 'unindex').length
  const d = r.actions.length - u
  const parts = [...(u ? [`${u} never recalled`] : []), ...(d ? [`${d} superseded`] : [])]
  return {
    text: `~${Math.max(1, Math.round(r.tokens / 1000))}k tokens before you type. ${parts.join(', ')}.`,
    buttons: [{ label: 'view diff', data: `view diet ${r.month}` }],
  }
}

// A dry run against the live store. It writes nothing.
if (import.meta.main) {
  const { homedir } = await import('os')
  const { loadMemories } = await import('./memory.ts')
  const { loadStats, auditMemories } = await import('./recallstats.ts')
  const root = join(import.meta.dir, '..')
  const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return null } }
  const files = contextFiles(root, homedir())
  const m = measureContext(files.map(path => ({ path, text: read(path) })))
  console.log(`~${m.tokens} tokens`)
  for (const f of m.files) console.log(`  ${String(f.tokens).padStart(6)}  ${f.path.replace(homedir(), '~')}`)
  const memories = loadMemories(true)
  const stateDir = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
  const audit = auditMemories(memories, loadStats(join(stateDir, 'recall-stats.json')), { skipNames: [HOUSE_RULES_NAME] })
  const actions = planDiet({
    memories, neverHit: audit.neverHit, indexText: read(files[files.length - 1]) ?? '', indexScope: projectSlug(root),
    indexFor: s => read(join(dirForScope(s), 'MEMORY.md')) ?? '', declined: loadDietState(join(stateDir, DIET_STATE_NAME)).declined,
  })
  console.log(`${actions.length} action(s)`)
  console.log(renderDiff(actions))
}
