/**
 * Durable memory — the markdown files, read directly.
 *
 * This replaces a Python stack that ran five lifecycle hooks, a SQLite shadow
 * index, a chroma vector store, a local embedding model and a detached worker
 * process, all to search 520 short markdown files. The files were always the
 * source of truth; everything else was an index that had to be kept in sync,
 * rebuilt when it drifted, and paid for on every single turn.
 *
 * What replaced it: read the files, score them with BM25, return the top few.
 * At this corpus size the whole search is a few milliseconds of string work, so
 * there is nothing to cache to disk, nothing to reindex, and nothing that can
 * disagree with the files.
 *
 * The deliberate trade: no embeddings, so no true semantic matching. A query
 * for "money" will not surface a memory that only ever says "cost". Mitigated
 * by scoring the frontmatter description far above the body — descriptions are
 * written as one-line summaries, which makes them a hand-written index — and by
 * light stemming so plurals and -ing forms collide. If that turns out to be too
 * blunt, the fix is a better lexical signal, not a model.
 *
 * Recall is pull, not push. Nothing here injects into a turn; the assistant
 * calls it when it has a reason to.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export type Memory = {
  /** Slug — the filename without .md, and the frontmatter name. */
  name: string
  description: string
  type: MemoryType
  body: string
  /** "global", or a project slug like "-Users-you-Projects-your-repo". */
  scope: string
  path: string
  mtimeMs: number
  /** [[wikilinks]] to other memories. */
  links: string[]
}

export const MEMORY_ROOT = join(homedir(), '.claude', 'memory')
export const GLOBAL_DIR = join(MEMORY_ROOT, 'global')
export const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/** The index file is a human-readable table of contents, not data we read back. */
const INDEX_FILE = 'MEMORY.md'

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference']

export function parseMemory(path: string, raw: string, scope: string, mtimeMs: number): Memory | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  const frontmatter = m ? m[1] : ''
  const body = (m ? m[2] : raw).trim()

  const field = (key: string): string | undefined => {
    const hit = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm').exec(frontmatter)
    return hit ? hit[1].replace(/^["']|["']$/g, '') : undefined
  }

  const rawType = field('type')
  const type = (TYPES as string[]).includes(rawType ?? '') ? (rawType as MemoryType) : 'project'
  const name = field('name') ?? basename(path, '.md')
  // A file with no body and no description carries nothing worth returning.
  const description = field('description') ?? ''
  if (!body && !description) return null

  return {
    name,
    description,
    type,
    body,
    scope,
    path,
    mtimeMs,
    links: [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map(x => x[1].trim()),
  }
}

function readDir(dir: string, scope: string): Memory[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const out: Memory[] = []
  for (const n of names) {
    if (!n.endsWith('.md') || n === INDEX_FILE) continue
    const path = join(dir, n)
    try {
      const st = statSync(path)
      const mem = parseMemory(path, readFileSync(path, 'utf8'), scope, st.mtimeMs)
      if (mem) out.push(mem)
    } catch {}
  }
  return out
}

/** Every memory dir: the global store plus one per project that has ever had one. */
export function memoryDirs(): { dir: string; scope: string }[] {
  const dirs = [{ dir: GLOBAL_DIR, scope: 'global' }]
  let projects: string[] = []
  try { projects = readdirSync(PROJECTS_DIR) } catch { return dirs }
  for (const slug of projects) {
    const dir = join(PROJECTS_DIR, slug, 'memory')
    if (existsSync(dir)) dirs.push({ dir, scope: slug })
  }
  return dirs
}

/**
 * Load everything, cached in-process and invalidated by directory mtime.
 *
 * A dir's mtime changes when a file is added or removed but NOT when one is
 * edited in place, so the cache also carries a short TTL. Both are cheap
 * insurance for a load that costs a few milliseconds anyway.
 */
let cache: { at: number; sig: string; memories: Memory[] } | null = null
const CACHE_TTL_MS = 20_000

function signature(dirs: { dir: string }[]): string {
  return dirs.map(d => {
    try { return `${d.dir}:${statSync(d.dir).mtimeMs}` } catch { return `${d.dir}:0` }
  }).join('|')
}

export function loadMemories(force = false): Memory[] {
  const dirs = memoryDirs()
  const sig = signature(dirs)
  if (!force && cache && cache.sig === sig && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.memories
  }
  const memories = dirs.flatMap(d => readDir(d.dir, d.scope))
  cache = { at: Date.now(), sig, memories }
  return memories
}

export function invalidateCache(): void {
  cache = null
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these',
  'those', 'as', 'by', 'from', 'has', 'have', 'had', 'do', 'does', 'did', 'not',
  'what', 'when', 'where', 'which', 'who', 'how', 'why', 'i', 'you', 'he', 'his',
  'my', 'me', 'we', 'they', 'them', 'their', 'about', 'into', 'so', 'if', 'then',
])

/**
 * Crude suffix trimming, not a real stemmer. It exists so "trigger"/"triggers"
 * and "cache"/"caching" collide; anything more aggressive starts merging words
 * that mean different things, which is worse than missing a plural.
 */
export function stem(word: string): string {
  let w = word
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (w.length > suffix.length + 3 && w.endsWith(suffix)) return w.slice(0, -suffix.length)
  }
  return w
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_+#.-]+/)
    .map(t => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
    .map(stem)
}

const K1 = 1.4
const B = 0.72
/** The description is a hand-written one-line summary — treat it as a title. */
const DESCRIPTION_WEIGHT = 4
const NAME_WEIGHT = 3

type Indexed = { mem: Memory; tf: Map<string, number>; len: number }

function indexOne(mem: Memory): Indexed {
  const tf = new Map<string, number>()
  const add = (text: string, weight: number) => {
    for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + weight)
  }
  add(mem.name.replace(/-/g, ' '), NAME_WEIGHT)
  add(mem.description, DESCRIPTION_WEIGHT)
  add(mem.body, 1)
  let len = 0
  for (const v of tf.values()) len += v
  return { mem, tf, len }
}

export type SearchOpts = {
  /** "global", a project slug, or "all" (default). */
  scope?: string
  type?: MemoryType
  limit?: number
  /** Boost memories in this scope without excluding the rest. */
  preferScope?: string
}

export type SearchHit = { memory: Memory; score: number }

export function searchMemories(memories: Memory[], query: string, opts: SearchOpts = {}): SearchHit[] {
  const { scope, type, limit = 8, preferScope } = opts
  const pool = memories.filter(m => {
    if (scope && scope !== 'all' && m.scope !== scope) return false
    if (type && m.type !== type) return false
    return true
  })
  if (!pool.length) return []

  const terms = tokenize(query)
  const docs = pool.map(indexOne)
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1

  // No usable query: fall back to most-recently-written, which is the only
  // honest ordering when nothing was asked.
  if (!terms.length) {
    return [...pool]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map(memory => ({ memory, score: 0 }))
  }

  const df = new Map<string, number>()
  for (const t of new Set(terms)) {
    df.set(t, docs.reduce((n, d) => n + (d.tf.has(t) ? 1 : 0), 0))
  }

  const hits: SearchHit[] = []
  for (const d of docs) {
    let score = 0
    for (const t of terms) {
      const f = d.tf.get(t)
      if (!f) continue
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / avgLen))))
    }
    if (score <= 0) continue
    // A memory written for the project you are standing in is more likely to be
    // the one meant, all else equal.
    if (preferScope && d.mem.scope === preferScope) score *= 1.25
    hits.push({ memory: d.mem, score })
  }

  return hits.sort((a, b) => b.score - a.score || b.memory.mtimeMs - a.memory.mtimeMs).slice(0, limit)
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '') || 'memory'
}

export function dirForScope(scope: string): string {
  return scope === 'global' ? GLOBAL_DIR : join(PROJECTS_DIR, scope, 'memory')
}

export function renderMemory(m: { name: string; description: string; type: MemoryType; body: string }): string {
  return [
    '---',
    `name: ${m.name}`,
    `description: ${m.description}`,
    'metadata:',
    `  type: ${m.type}`,
    '  node_type: memory',
    '---',
    '',
    m.body.trim(),
    '',
  ].join('\n')
}

/**
 * Keep MEMORY.md in step. It is the table of contents a session reads at
 * startup, so a memory missing from it is invisible until something searches
 * for it by name.
 */
export function updateIndex(dir: string, name: string, description: string): void {
  const path = join(dir, INDEX_FILE)
  const line = `- [${name}](${name}.md) — ${description}`
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split('\n')
  } catch {
    lines = ['# Memory Index', '']
  }
  const existing = lines.findIndex(l => l.includes(`(${name}.md)`))
  if (existing >= 0) lines[existing] = line
  else lines.push(line)
  writeFileSync(path, lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').replace(/\n*$/, '\n'))
}

export function removeFromIndex(dir: string, name: string): void {
  const path = join(dir, INDEX_FILE)
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(l => !l.includes(`(${name}.md)`))
    writeFileSync(path, lines.join('\n').replace(/\n*$/, '\n'))
  } catch {}
}

export function writeMemory(input: {
  name?: string
  description: string
  type: MemoryType
  body: string
  scope: string
  /** Overrides the scope-derived location. Tests use it; nothing else should. */
  dir?: string
}): Memory {
  const name = slugify(input.name ?? input.description)
  const dir = input.dir ?? dirForScope(input.scope)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.md`)
  writeFileSync(path, renderMemory({ name, description: input.description, type: input.type, body: input.body }))
  updateIndex(dir, name, input.description)
  invalidateCache()
  return {
    name,
    description: input.description,
    type: input.type,
    body: input.body,
    scope: input.scope,
    path,
    mtimeMs: Date.now(),
    links: [...input.body.matchAll(/\[\[([^\]]+)\]\]/g)].map(x => x[1].trim()),
  }
}

export function deleteMemory(memories: Memory[], name: string, scope?: string): Memory | null {
  const target = memories.find(m => m.name === name && (!scope || m.scope === scope))
  if (!target) return null
  try { rmSync(target.path) } catch { return null }
  removeFromIndex(dirForScope(target.scope), target.name)
  invalidateCache()
  return target
}

export function formatHit(h: SearchHit, full = false): string {
  const scope = h.memory.scope === 'global' ? 'global' : h.memory.scope.split('-').slice(-2).join('-')
  const head = `[${h.memory.name}] (${h.memory.type}, ${scope})`
  const body = full ? h.memory.body : h.memory.description || h.memory.body.slice(0, 200)
  return `${head}\n  ${body.replace(/\n/g, '\n  ')}`
}
