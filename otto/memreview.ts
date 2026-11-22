#!/usr/bin/env bun
/**
 * Nightly review of the durable memory corpus, the second half of the 04:00 job.
 *
 * Consolidation only adds. Left alone the corpus grows near-duplicates (an old
 * repo rename left whole scopes doubled) and vague entries ("X had issues") that
 * read like memories but give a later session nothing to act on.
 *
 * Split in two on purpose:
 *   1. A read-only headless session (Read/Grep/Glob/recall, permission mode
 *      dontAsk) reads a catalog of every memory and returns a plan as
 *      structured output: merges, rewrites, removals.
 *   2. This file checks the plan and applies it. Every rule that keeps a bad
 *      night cheap is code here, not a request in the prompt: a tar.gz of every
 *      memory dir before the first write, at most MAX_CHANGES changes a night,
 *      dates, quoted words and Why / How to apply lines must survive, a memory
 *      edited since the catalog was built is left alone, and a per-night log
 *      says what moved where.
 *
 * `forget` already deletes a memory and its index line, but nothing renamed or
 * repointed links, so the merge (move [[links]] and MEMORY.md lines from the
 * removed memories to the survivor) lives here.
 *
 * Undo: `tar -xzf ~/.otto/memory-backups/memory-<day>.tar.gz -C ~` puts back
 * every file the review changed or removed; memories written since are kept.
 *
 * CLI: `bun otto/memreview.ts [--dry-run]`
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync, utimesSync } from 'fs'
import { homedir } from 'os'
import { join, basename, dirname, relative, isAbsolute } from 'path'
import { createHash } from 'crypto'
import { parseMemory, memoryDirs, removeFromIndex, invalidateCache, PROJECTS_DIR, type Memory } from './memory.ts'
import { HOUSE_RULES_NAME } from './houserules.ts'
import { spawnHeadless } from './consolidate.ts'
import { loadState, saveState } from './statefile.ts'

export const MAX_CHANGES = 30
export const KEEP_NIGHTS = 14
/** Memories offered for a rewrite each night, least recently reviewed first. */
export const CANDIDATES = 60
export const BACKUP_DIR = join(homedir(), '.otto', 'memory-backups')
const INDEX = 'MEMORY.md'

type Dir = { dir: string; scope: string }
/** `ref` is `<scope>/<file>`: the file name, not the frontmatter name, is what is unique in a dir. */
export type Entry = Memory & { ref: string; file: string; raw: string; hash: string }

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return null } }

export function loadCorpus(dirs: Dir[]): Entry[] {
  const out: Entry[] = []
  for (const { dir, scope } of dirs) {
    let names: string[] = []
    try { names = readdirSync(dir).sort() } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.md') || n === INDEX) continue
      const path = join(dir, n)
      const raw = read(path)
      if (raw === null) continue
      const m = parseMemory(path, raw, scope, statSync(path).mtimeMs)
      const file = basename(n, '.md')
      // house-rules is compiled from feedback memories every night; editing it is pointless.
      if (m && m.name !== HOUSE_RULES_NAME && file !== HOUSE_RULES_NAME) out.push({ ...m, ref: `${scope}/${file}`, file, raw, hash: sha(raw) })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The plan and its checks
// ---------------------------------------------------------------------------

export type Merge = { into: string; from: string[]; description: string; body: string; reason: string }
export type Rewrite = { memory: string; description: string; body: string; reason: string }
export type Removal = { memory: string; reason: string }
export type ReviewPlan = { merges: Merge[]; rewrites: Rewrite[]; removals: Removal[] }
export type Op = ({ kind: 'merge' } & Merge) | ({ kind: 'rewrite' } & Rewrite) | ({ kind: 'remove' } & Removal)

const refsOf = (op: Op) => op.kind === 'merge' ? [op.into, ...op.from] : [op.memory]

const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?: \d{4})?/g
const QUOTE_RE = /"([^"\n]{2,})"|“([^”\n]{2,})”/g
const KEEP_LINES = ['Why:', 'How to apply:']

/** What the new text dropped from the old: dates, quoted words, and the Why / How to apply lines. */
export function missingFrom(sources: string[], result: string): string[] {
  const need = new Set<string>()
  for (const s of sources) {
    for (const m of s.matchAll(DATE_RE)) need.add(m[0])
    for (const m of s.matchAll(QUOTE_RE)) need.add(m[1] ?? m[2])
    for (const k of KEEP_LINES) if (s.includes(k)) need.add(k)
  }
  return [...need].filter(n => !result.includes(n))
}

/**
 * Valid ops in plan order (merges, then removals, then rewrites), and why the rest
 * were refused. `activity` ranks scopes: a merge may not land in a scope that is
 * less alive than one it empties, or the content ends up where no session reads it.
 */
export function checkPlan(plan: ReviewPlan, corpus: Entry[], activity: (scope: string) => number, candidates?: Set<string>): { ops: Op[]; rejected: { op: Op; why: string }[] } {
  const byRef = new Map(corpus.map(e => [e.ref, e]))
  const used = new Set<string>()
  const ops: Op[] = []
  const rejected: { op: Op; why: string }[] = []
  const all: Op[] = [
    ...(plan.merges ?? []).map(m => ({ kind: 'merge' as const, ...m, from: m.from ?? [] })),
    ...(plan.removals ?? []).map(r => ({ kind: 'remove' as const, ...r })),
    ...(plan.rewrites ?? []).map(r => ({ kind: 'rewrite' as const, ...r })),
  ]
  const problem = (op: Op): string | null => {
    const refs = refsOf(op)
    const unknown = refs.find(r => !byRef.has(r))
    if (unknown) return `no memory ${unknown}`
    if (new Set(refs).size !== refs.length) return 'a memory is listed twice'
    const twice = refs.find(r => used.has(r))
    if (twice) return `${twice} is already in another change tonight`
    if (!op.reason?.trim()) return 'no reason given'
    if (op.kind === 'remove') return null
    if (op.kind === 'rewrite' && candidates && !candidates.has(op.memory)) return 'not offered for a rewrite tonight'
    if (!op.description?.trim() || op.description.includes('\n')) return 'description must be one line'
    if (!op.body?.trim()) return 'empty body'
    if (op.kind === 'merge') {
      if (!op.from.length) return 'merge with nothing to merge'
      const into = byRef.get(op.into)!
      const livelier = op.from.find(f => activity(byRef.get(f)!.scope) > activity(into.scope))
      if (livelier) return `${op.into} lives in a less active scope than ${livelier}`
    }
    const lost = missingFrom(refs.map(r => byRef.get(r)!.body), op.body)
    return lost.length ? `would drop ${lost.map(l => JSON.stringify(l)).join(', ')}` : null
  }
  for (const op of all) {
    const why = problem(op)
    if (why) { rejected.push({ op, why }); continue }
    refsOf(op).forEach(r => used.add(r))
    ops.push(op)
  }
  return { ops, rejected }
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/** Swap the description and body; every other frontmatter key (dates, session ids) stays. */
function rewriteFile(e: Entry, description: string, body: string, mtimeMs: number): void {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(e.raw)?.[1] ?? `name: ${e.name}\nmetadata:\n  type: ${e.type}`
  const head = /^description:.*$/m.test(fm) ? fm.replace(/^description:.*$/m, `description: ${description}`) : `${fm}\ndescription: ${description}`
  writeFileSync(e.path, `---\n${head}\n---\n\n${body.trim()}\n`)
  // A rewrite is not news: memdiet ranks by mtime, so keep the order it had.
  const t = new Date(mtimeMs)
  utimesSync(e.path, t, t)
  // Only an existing index line: a memory the diet unindexed stays unindexed.
  const idx = join(dirname(e.path), INDEX)
  const text = read(idx)
  if (text === null) return
  const next = text.split('\n').map(l => l.includes(`(${e.file}.md)`) && l.includes(' — ') ? `${l.slice(0, l.indexOf(' — '))} — ${description}` : l).join('\n')
  if (next !== text) writeFileSync(idx, next)
}

/**
 * Point every [[link]], (file.md) link and "(global memory)" index line that
 * named a removed memory at its survivor. Links resolve the way memviewer does:
 * same scope, then global, then any — so a same-named memory in another scope
 * keeps its own links.
 */
export function repoint(moves: Map<Entry, Entry | null>, corpus: Entry[], dirs: Dir[]): number {
  if (!moves.size) return 0
  const target = (scope: string, raw: string): Entry | null | undefined => {
    const t = raw.trim().toLowerCase()
    const c = corpus.filter(e => e.name.toLowerCase() === t || e.file.toLowerCase() === t)
    const hit = c.find(e => e.scope === scope) ?? c.find(e => e.scope === 'global') ?? c[0]
    return hit && moves.has(hit) ? moves.get(hit) : undefined
  }
  const swap = (text: string, scope: string) => text
    .replace(/\[\[([^\]]+)\]\]/g, (all, x) => { const to = target(scope, x); return to ? `[[${to.name}]]` : all })
    .replace(/\]\((?!https?:)((?:[^)\s]*\/)?)([^/)\s]+)\.md\)/g, (all, pre, x) => { const to = target(scope, x); return to ? `](${pre}${to.file}.md)` : all })
  let changed = 0
  const gone = new Set(moves.keys())
  for (const e of corpus) {
    if (gone.has(e)) continue
    const now = read(e.path)
    if (now === null) continue
    const next = swap(now, e.scope)
    if (next === now) continue
    const st = statSync(e.path)
    writeFileSync(e.path, next)
    utimesSync(e.path, st.atime, st.mtime)
    changed++
  }
  const bare = new Map([...moves].filter(([g]) => g.scope === 'global').map(([g, to]) => [g.name, to]))
  for (const { dir, scope } of dirs) {
    const path = join(dir, INDEX)
    const text = read(path)
    if (text === null) continue
    const keyOf = (l: string) => /^- (\S+) \(global memory\)/.exec(l)?.[1] ?? /\(([^)\s]+\.md)\)/.exec(l)?.[1]
    const pairs: [string, string | null][] = text.split('\n').map(l => {
      // "- name (global memory) — …": a project index pointing at a global memory.
      const m = /^- (\S+) \(global memory\)/.exec(l)
      if (m && bare.has(m[1])) {
        const to = bare.get(m[1])
        if (!to || to.scope !== 'global') return [l, null]
        return [l, swap(l.replace(m[1], to.name), scope)]
      }
      return [l, swap(l, scope)]
    })
    // A repointed line that now names a memory the index already lists is a duplicate; untouched lines stay as they were.
    const seen = new Set(pairs.filter(([a, b]) => a === b).map(([a]) => keyOf(a)).filter(Boolean))
    const lines: string[] = []
    for (const [a, b] of pairs) {
      if (b === null) continue
      const k = b !== a && b.startsWith('- ') ? keyOf(b) : undefined
      if (k) { if (seen.has(k)) continue; seen.add(k) }
      lines.push(b)
    }
    const next = lines.join('\n')
    if (next !== text) { writeFileSync(path, next); changed++ }
  }
  return changed
}

export type Applied = { applied: Op[]; skipped: { op: Op; why: string }[]; repointed: number }

export function applyOps(ops: Op[], corpus: Entry[], dirs: Dir[]): Applied {
  const byRef = new Map(corpus.map(e => [e.ref, e]))
  const applied: Op[] = []
  const skipped: { op: Op; why: string }[] = []
  const moves = new Map<Entry, Entry | null>()
  const remove = (e: Entry) => { rmSync(e.path, { force: true }); removeFromIndex(dirname(e.path), e.file) }
  for (const op of ops) {
    const entries = refsOf(op).map(r => byRef.get(r)!)
    // Someone (or tonight's consolidation) wrote it after the plan was made: their version wins.
    const stale = entries.find(e => read(e.path) !== e.raw)
    if (stale) { skipped.push({ op, why: `${stale.ref} changed since the plan was made` }); continue }
    if (op.kind === 'remove') { remove(entries[0]); moves.set(entries[0], null) }
    else if (op.kind === 'rewrite') rewriteFile(entries[0], op.description, op.body, entries[0].mtimeMs)
    else {
      const [into, ...from] = entries
      rewriteFile(into, op.description, op.body, Math.max(...entries.map(e => e.mtimeMs)))
      for (const f of from) { remove(f); moves.set(f, into) }
    }
    applied.push(op)
  }
  const repointed = repoint(moves, corpus, dirs)
  invalidateCache()
  return { applied, skipped, repointed }
}

// ---------------------------------------------------------------------------
// Backup and log
// ---------------------------------------------------------------------------

function countFiles(dir: string): number {
  try { return readdirSync(dir, { recursive: true }).filter(f => statSync(join(dir, String(f))).isFile()).length } catch { return 0 }
}

const countTar = (file: string) => {
  const r = Bun.spawnSync(['tar', '-tzf', file])
  return r.exitCode === 0 ? r.stdout.toString().split('\n').filter(l => l && !l.endsWith('/')).length : -1
}

/**
 * tar.gz of every memory dir, paths relative to home like the 8 Nov one-off, so
 * `tar -xzf <file> -C ~` restores. The first backup of a day is never replaced:
 * a second run that day must not overwrite the state from before the first.
 */
export function backupMemory(dirs: Dir[], home: string, backupDir: string, day: string): { file: string; files: number; reused: boolean } {
  mkdirSync(backupDir, { recursive: true })
  const file = join(backupDir, `memory-${day}.tar.gz`)
  if (existsSync(file)) return { file, files: countTar(file), reused: true }
  const rel = dirs.map(d => relative(home, d.dir)).filter(r => r && !r.startsWith('..') && !isAbsolute(r) && existsSync(join(home, r)))
  const want = rel.reduce((n, r) => n + countFiles(join(home, r)), 0)
  const r = Bun.spawnSync(['tar', '-czf', file, '-C', home, ...rel], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const got = r.exitCode === 0 ? countTar(file) : -1
  if (got !== want) {
    rmSync(file, { force: true })
    throw new Error(`memory backup incomplete (${got} of ${want} files): ${r.stderr.toString().trim()}`)
  }
  return { file, files: got, reused: false }
}

/** Keep the newest `keep` nights of backups and their logs. */
export function pruneBackups(backupDir: string, keep = KEEP_NIGHTS): string[] {
  let names: string[] = []
  try { names = readdirSync(backupDir) } catch { return [] }
  const days = names.map(f => /^memory-(\d{4}-\d{2}-\d{2})\.tar\.gz$/.exec(f)?.[1]).filter((d): d is string => !!d).sort().reverse()
  const old = days.slice(keep)
  for (const d of old) for (const f of [`memory-${d}.tar.gz`, `review-${d}.md`]) rmSync(join(backupDir, f), { force: true })
  return old
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The night's change log, appended to review-<day>.md beside the backup. */
export function formatLog(o: { at: Date; backup: { file: string; files: number }; corpus: Entry[]; result: Applied; rejected: { op: Op; why: string }[]; deferred: Op[] }): string {
  const byRef = new Map(o.corpus.map(e => [e.ref, e]))
  const desc = (r: string) => oneLine(byRef.get(r)?.description ?? '')
  const out = [
    `## Run at ${o.at.toISOString()}`,
    '',
    `Backup: ${basename(o.backup.file)} (${o.backup.files} files, taken before this run touched anything). Undo all of it: \`tar -xzf ~/.otto/memory-backups/${basename(o.backup.file)} -C ~\`.`,
    '',
  ]
  const section = (title: string, rows: string[]) => { if (rows.length) out.push(`### ${title}`, '', ...rows, '') }
  const ops = o.result.applied
  section('Merged', ops.flatMap(op => op.kind !== 'merge' ? [] : [
    `- ${op.from.map(f => `\`${f}\``).join(', ')} → \`${op.into}\`: ${oneLine(op.reason)}`,
    ...op.from.map(f => `  - removed \`${f}\` was: ${desc(f)}`),
    `  - description before: ${desc(op.into)}`,
    `  - description after: ${oneLine(op.description)}`,
  ]))
  section('Rewritten', ops.flatMap(op => op.kind !== 'rewrite' ? [] : [
    `- \`${op.memory}\`: ${oneLine(op.reason)}`,
    `  - before: ${desc(op.memory)}`,
    `  - after: ${oneLine(op.description)}`,
  ]))
  // A removal has no survivor, so its body goes in the log as well as the tarball.
  section('Removed', ops.flatMap(op => op.kind !== 'remove' ? [] : [
    `- \`${op.memory}\`: ${oneLine(op.reason)}`,
    `  - was: ${desc(op.memory)}`,
    ...(byRef.get(op.memory)?.body ?? '').split('\n').map(l => `    > ${l}`),
  ]))
  section('Not applied', [
    ...o.rejected.map(r => `- ${r.op.kind} ${refsOf(r.op).map(x => `\`${x}\``).join(', ')}: ${r.why}`),
    ...o.result.skipped.map(r => `- ${r.op.kind} ${refsOf(r.op).map(x => `\`${x}\``).join(', ')}: ${r.why}`),
    ...(o.deferred.length ? [`- ${o.deferred.length} more change(s) over the nightly cap of ${MAX_CHANGES}; they wait for the next night`] : []),
  ])
  if (o.result.repointed) out.push(`Links and index lines repointed in ${o.result.repointed} file(s).`, '')
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

export const REVIEW_PROMPT = `You are reviewing the durable memory corpus. Nobody is watching this run and nothing you say is sent anywhere; your only output is the structured plan.

The catalog file named below lists every durable memory, grouped by scope with its directory. Each line is: ref, type, description, outgoing links. A ref is "<scope>/<file>" — use refs exactly as written. Read any memory file you need with Read (directory + file + ".md"); Grep across the directories finds overlaps the descriptions hide. recall works too.

Plan up to ${MAX_CHANGES} changes, most valuable first:

1. merges — two or more memories that cover the same thing become one. Pick the survivor with the best name as "into", list the others in "from", and write the combined description and body. Every fact, date, decision, quoted phrase, path, command and id from every merged memory must survive in the body. When copies sit in different scopes, the survivor goes in the scope marked most recently active (global outranks every project); a scope marked "no sessions" is a leftover of an old rename.
2. rewrites — only for refs in the CANDIDATES list. A vague memory ("X had issues", "be careful with Y") is rewritten so it says what to do, when, and why, with the concrete names, paths, commands, ids and dates it needs. Use only what is in that memory, the memories it links to, or what recall returns. Never invent a specific. A memory that is already specific and actionable needs no change: leave it out.
3. removals — a memory that cannot be made actionable and holds nothing durable, and that no merge can absorb. Say why.

Hard rules (a change that breaks one is thrown away):
- Copy every date, quoted phrase and the user's own words verbatim. Never change a date or a decision.
- A feedback memory keeps its "Why:" and "How to apply:" lines.
- Descriptions are one line that reads like an index entry.
- Each memory appears in at most one change.

An empty plan is a good night when nothing needs doing. A wrong merge is worse than a missed one.`

const STR = { type: 'string' }
export const PLAN_SCHEMA = {
  type: 'object',
  required: ['merges', 'rewrites', 'removals'],
  properties: {
    merges: { type: 'array', items: { type: 'object', required: ['into', 'from', 'description', 'body', 'reason'], properties: { into: STR, from: { type: 'array', items: STR }, description: STR, body: STR, reason: STR } } },
    rewrites: { type: 'array', items: { type: 'object', required: ['memory', 'description', 'body', 'reason'], properties: { memory: STR, description: STR, body: STR, reason: STR } } },
    removals: { type: 'array', items: { type: 'object', required: ['memory', 'reason'], properties: { memory: STR, reason: STR } } },
  },
}

/** Newest transcript per project scope; global outranks every project. */
export function scopeActivity(projectsDir = PROJECTS_DIR): (scope: string) => number {
  const memo = new Map<string, number>()
  return scope => {
    if (scope === 'global') return Infinity
    if (!memo.has(scope)) {
      let latest = 0
      try {
        for (const f of readdirSync(join(projectsDir, scope))) {
          if (f.endsWith('.jsonl')) latest = Math.max(latest, statSync(join(projectsDir, scope, f)).mtimeMs)
        }
      } catch {}
      memo.set(scope, latest)
    }
    return memo.get(scope)!
  }
}

export function renderCatalog(corpus: Entry[], dirs: Dir[], candidates: Set<string>, activity: (scope: string) => number): string {
  const out = ['# Memory catalog', '']
  for (const { dir, scope } of dirs) {
    const rows = corpus.filter(e => e.scope === scope)
    if (!rows.length) continue
    const a = activity(scope)
    const when = a === Infinity ? 'global' : a ? `last session ${new Date(a).toISOString().slice(0, 10)}` : 'no sessions'
    out.push(`## ${scope} (${when}) — ${dir}`, '')
    for (const e of rows) out.push(`- ${e.ref} [${e.type}] ${oneLine(e.description)}${e.links.length ? ` {links: ${e.links.join(', ')}}` : ''}`)
    out.push('')
  }
  out.push('# CANDIDATES (rewrite only these)', '', ...[...candidates].map(r => `- ${r}`), '')
  return out.join('\n')
}

/** Structured output from `claude -p --output-format json`: one result object, or the verbose array ending in one. */
export function parsePlan(stdout: string): ReviewPlan | string {
  try {
    const j = JSON.parse(stdout)
    const r = Array.isArray(j) ? j.findLast((x: { type?: string }) => x?.type === 'result') : j
    const p = r?.structured_output
    if (p && Array.isArray(p.merges) && Array.isArray(p.rewrites) && Array.isArray(p.removals)) return p as ReviewPlan
    return `no plan in the output (${r?.subtype ?? 'no result'}): ${String(r?.result ?? '').slice(0, 300)}`
  } catch {
    return `unreadable output: ${stdout.slice(-300)}`
  }
}

async function spawnPlanner(catalog: string, cwd: string): Promise<ReviewPlan | string> {
  const prompt = `${REVIEW_PROMPT}\n\nCatalog: ${catalog}`
  const res = await spawnHeadless(prompt, {
    cwd,
    tools: 'Read,Grep,Glob,mcp__plugin_otto_otto__recall',
    // Read-only by construction: nothing outside the allowlist runs, and no write tool exists.
    mode: 'dontAsk',
    args: ['--output-format', 'json', '--json-schema', JSON.stringify(PLAN_SCHEMA)],
    timeoutMs: 30 * 60_000,
  })
  return res.ok ? parsePlan(res.output) : `planner failed: ${res.output.slice(-300)}`
}

// ---------------------------------------------------------------------------
// One night
// ---------------------------------------------------------------------------

type ReviewState = { reviewed: Record<string, string> }

export type ReviewOpts = {
  dryRun?: boolean
  workDir: string
  stateFile: string
  dirs?: Dir[]
  home?: string
  backupDir?: string
  now?: Date
  activity?: (scope: string) => number
  /** The planner; tests pass a stub. */
  plan?: (catalogPath: string, cwd: string) => Promise<ReviewPlan | string>
}

export const dayStamp = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function formatOps(ops: Op[]): string[] {
  return ops.map(op =>
    op.kind === 'merge' ? `merge ${op.from.join(' + ')} → ${op.into}: ${oneLine(op.reason)}`
    : op.kind === 'rewrite' ? `rewrite ${op.memory}: ${oneLine(op.description)}`
    : `remove ${op.memory}: ${oneLine(op.reason)}`)
}

export async function runReview(o: ReviewOpts): Promise<string> {
  const dirs = o.dirs ?? memoryDirs()
  const now = o.now ?? new Date()
  const backupDir = o.backupDir ?? BACKUP_DIR
  const activity = o.activity ?? scopeActivity()
  const corpus = loadCorpus(dirs)
  const state = loadState<ReviewState>(o.stateFile, () => ({ reviewed: {} }), x => !!x && typeof (x as ReviewState).reviewed === 'object')
  // Each memory gets one rewrite look until its content changes, so the pass converges instead of rewording forever.
  const candidates = new Set(corpus.filter(e => state.reviewed[e.ref] !== e.hash).sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, CANDIDATES).map(e => e.ref))

  mkdirSync(o.workDir, { recursive: true })
  const catalog = join(o.workDir, 'catalog.md')
  writeFileSync(catalog, renderCatalog(corpus, dirs, candidates, activity))
  const plan = await (o.plan ?? spawnPlanner)(catalog, o.workDir)
  if (typeof plan === 'string') return `memory review: ${plan}`

  const { ops, rejected } = checkPlan(plan, corpus, activity, candidates)
  const todo = ops.slice(0, MAX_CHANGES)
  const deferred = ops.slice(MAX_CHANGES)
  if (o.dryRun) {
    return [
      `dry run — ${corpus.length} memories, ${candidates.size} offered for rewrite; nothing written`,
      ...formatOps(todo).map(l => `  ${l}`),
      ...rejected.map(r => `  refused ${r.op.kind} ${refsOf(r.op).join(', ')}: ${r.why}`),
      ...(deferred.length ? [`  ${deferred.length} more over the cap of ${MAX_CHANGES}`] : []),
    ].join('\n')
  }

  let summary = 'memory review: nothing to change'
  if (todo.length) {
    // No backup, no writes.
    const backup = backupMemory(dirs, o.home ?? homedir(), backupDir, dayStamp(now))
    const result = applyOps(todo, corpus, dirs)
    const log = join(backupDir, `review-${dayStamp(now)}.md`)
    const head = existsSync(log) ? '' : `# Memory review — ${dayStamp(now)}\n\n`
    writeFileSync(log, head + formatLog({ at: now, backup, corpus, result, rejected, deferred }) + '\n', { flag: 'a' })
    pruneBackups(backupDir)
    const n = (k: Op['kind']) => result.applied.filter(x => x.kind === k).length
    summary = `memory review: ${n('merge')} merged, ${n('rewrite')} rewritten, ${n('remove')} removed${result.skipped.length + rejected.length ? `, ${result.skipped.length + rejected.length} refused` : ''}${deferred.length ? `, ${deferred.length} deferred` : ''} — log ${log}`
  }

  // Deferred and refused ones come back tomorrow; everything else offered tonight has had its look.
  const pending = new Set([...deferred, ...rejected.map(r => r.op)].flatMap(refsOf))
  const after = loadCorpus(dirs)
  for (const e of after) if (candidates.has(e.ref) && !pending.has(e.ref)) state.reviewed[e.ref] = e.hash
  const live = new Set(after.map(e => e.ref))
  for (const r of Object.keys(state.reviewed)) if (!live.has(r)) delete state.reviewed[r]
  saveState(o.stateFile, state)
  return summary
}

if (import.meta.main) {
  const stateDir = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
  console.log(await runReview({
    dryRun: process.argv.includes('--dry-run'),
    workDir: join(stateDir, 'memreview'),
    stateFile: join(stateDir, 'memreview.json'),
  }))
}
