/**
 * Dead-module sweep. Once a month the channel looks for modules nothing has
 * used lately and proposes deleting them. It only proposes: the branch is built
 * in a scratch worktree and the merge is a guarded change, cleared only by
 * Approve in the app (SELFEDIT.md).
 *
 * "Dead" means what the server can actually see firing. A module is tool-bound
 * when every reference the server's own files (SERVER_FILES) make to its imported
 * names sits inside the definition (tools.ts) or the callTool `case` block
 * (toolcalls.ts) of some tools T. It is dead
 * when no tool in T and no `bun otto/<module>.ts` run has been seen for
 * `idleDays`, tracking has run at least that long, and nothing else (a trigger,
 * another module, a script) names it. Modules the scheduler, the brief or the
 * inbound paths reach are never candidates, because nothing measures them firing.
 *
 * Pure functions and state I/O only; git and model calls stay in chores.ts.
 */
import { loadState, saveState } from './statefile.ts'
import { tierForPath } from './selfedit.ts'
import type { Finding } from './docdrift.ts'

export const DAY = 86_400_000
export const TOOL_USAGE_NAME = 'tool-usage.json'
export const SWEEP_STATE_NAME = 'deadsweep.json'

// ---------------------------------------------------------------------------
// Usage: the evidence
// ---------------------------------------------------------------------------

/** Keys are tool names, or `cli:<module>` for a `bun otto/<module>.ts` run. */
export type ToolUsage = { since: string; uses: Record<string, { count: number; lastAt: string }> }

export function loadUsage(file: string, now = Date.now()): ToolUsage {
  return loadState<ToolUsage>(
    file,
    () => ({ since: new Date(now).toISOString(), uses: {} }),
    v => !!v && typeof (v as any).since === 'string' && typeof (v as any).uses === 'object',
  )
}

export function saveUsage(file: string, u: ToolUsage): void { saveState(file, u) }

export function recordUse(u: ToolUsage, key: string, now: number): ToolUsage {
  const e = u.uses[key] ?? { count: 0, lastAt: '' }
  e.count++
  e.lastAt = new Date(now).toISOString()
  u.uses[key] = e
  return u
}

/** The modules a shell command runs directly: `bun otto/packages.ts parse` → packages. */
export function cliModules(cmd: string): string[] {
  const out = new Set<string>()
  for (const m of cmd.matchAll(/(?:^|[\s'"/])otto\/([a-z][a-z0-9-]*)\.ts\b/g)) out.add(m[1])
  return [...out]
}

/** Rails and rarely-needed safety valves: a quiet month is not evidence they are unused. */
export const NEVER_SWEPT = [
  'reply', 'react', 'edit_message', 'delete_message', 'burn', 'recall', 'remember', 'forget', 'brief', 'snooze', 'settings',
  'otto_status', 'watchdog_report', 'self_edit_check', 'self_test', 'forge', 'capability_log', 'revert_capability',
  'ask_approval', 'reload',
]

// ---------------------------------------------------------------------------
// Reading the server: tool definitions in tools.ts, handlers in toolcalls.ts
// ---------------------------------------------------------------------------

/**
 * The server is these files, read together: a reference from any of them keeps a
 * module alive, and a sweep prunes imports from all of them. Other modules count
 * only as importers (findCandidates' `files`).
 */
export const SERVER_FILES = ['server.ts', 'taps.ts', 'chores.ts', 'toolcalls.ts', 'http.ts', 'tools.ts']

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordRe = (names: string[]) => new RegExp(`(?<![\\w$])(?:${names.map(escapeRe).join('|')})(?![\\w$])`)

/**
 * Named imports from sibling modules, anywhere in the file (a server file may have one mid-file).
 * Default, namespace and side-effect imports are ignored, so such a module is never a
 * candidate. That is the safe direction.
 */
export function parseImports(src: string): Map<string, { names: string[]; lines: number[] }> {
  const out = new Map<string, { names: string[]; lines: number[] }>()
  for (const m of src.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'\.\/([\w.-]+)\.ts'/gm)) {
    const start = src.slice(0, m.index).split('\n').length - 1
    const n = m[0].split('\n').length
    const names = m[1].split(',').map(s => s.trim().replace(/^type\s+/, '')).filter(Boolean)
      .map(s => s.split(/\s+as\s+/).pop()!.trim())
    const e = out.get(m[2]) ?? { names: [], lines: [] }
    e.names.push(...names)
    for (let i = 0; i < n; i++) e.lines.push(start + i)
    out.set(m[2], e)
  }
  return out
}

export type ToolBlock = { tool: string; kind: 'def' | 'case'; start: number; end: number }

/**
 * Every tool definition and handler block (inclusive lines, 0-based), by the layout
 * the server keeps them in: definitions in the TOOLS array of tools.ts, handlers as
 * `case` blocks in the switch of toolcalls.ts's callTool. Pass either file, or all of them joined.
 */
export function toolBlocks(src: string): ToolBlock[] {
  const lines = src.split('\n')
  const out: ToolBlock[] = []
  const list = lines.findIndex(l => l.startsWith('export const TOOLS'))
  for (let i = list + 1; list >= 0 && i < lines.length && lines[i] !== ']'; i++) {
    const name = lines[i] === '  {' ? /^    name: '([a-z_]+)',$/.exec(lines[i + 1] ?? '')?.[1] : undefined
    if (!name) continue
    let j = i + 1
    while (j < lines.length && lines[j] !== '  },') j++
    out.push({ tool: name, kind: 'def', start: i, end: j })
    i = j
  }
  const call = lines.findIndex(l => l.startsWith('export async function callTool('))
  if (call < 0) return out
  // The switch's own cases share one indent; a nested switch inside a handler is deeper.
  const indent = lines.slice(call + 1).map(l => /^(\s+)case '[a-z_]+': \{$/.exec(l)?.[1]).find(Boolean)
  let open: { tool: string; start: number } | null = null
  for (let i = call + 1; indent && i < lines.length; i++) {
    const c = lines[i].startsWith(indent) ? /^case '([a-z_]+)': \{$/.exec(lines[i].slice(indent.length)) : null
    if (c || lines[i].startsWith(`${indent}default:`)) {
      // A family heading between two cases belongs to neither: a block ends at its closing brace.
      let end = i - 1
      while (open && end > open.start && lines[end] !== `${indent}}`) end--
      if (open) out.push({ ...open, kind: 'case', end })
      open = c ? { tool: c[1], start: i } : null
      if (!c) break
    }
  }
  return out
}

/** The 0-based lines each tool owns: its definition block plus its case block. */
export function toolSpans(src: string): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const b of toolBlocks(src)) {
    const lines = out.get(b.tool) ?? []
    for (let i = b.start; i <= b.end; i++) lines.push(i)
    out.set(b.tool, lines)
  }
  return out
}

/** module → the tools it is bound to. Conservative: a comment, string or property access counts as a reference. */
export function boundModules(src: string): Map<string, string[]> {
  const lines = src.split('\n')
  const owner = new Map<number, string>()
  for (const [tool, ls] of toolSpans(src)) for (const l of ls) owner.set(l, tool)
  const out = new Map<string, string[]>()
  for (const [mod, { names, lines: own }] of parseImports(src)) {
    if (!names.length) continue
    const re = wordRe(names)
    const skip = new Set(own)
    const tools = new Set<string>()
    let ok = true
    for (let i = 0; i < lines.length && ok; i++) {
      if (skip.has(i) || !re.test(lines[i])) continue
      const t = owner.get(i)
      if (t) tools.add(t); else ok = false
    }
    if (ok && tools.size) out.set(mod, [...tools])
  }
  return out
}

export type Candidate = { module: string; tools: string[]; idleDays: number }

export function findCandidates(o: {
  src: string
  /** repo-relative otto/*.ts and otto/tests/*.ts contents, SERVER_FILES excluded */
  files: Record<string, string>
  externallyReferenced: Set<string>
  usage: ToolUsage
  triggerTexts: string[]
  kept: string[]
  now: number
  idleDays: number
}): Candidate[] {
  const since = Date.parse(o.usage.since)
  if (o.now - since < o.idleDays * DAY) return []
  let out: Candidate[] = []
  const bound = boundModules(o.src)
  for (const [m, tools] of bound) {
    if (tools.some(t => NEVER_SWEPT.includes(t)) || tierForPath(`otto/${m}.ts`).tier === 'guarded') continue
    if (o.kept.includes(m) || o.externallyReferenced.has(m)) continue
    // Any specifier, so a dynamic `import('./m.ts')` counts as much as a static one.
    const imp = new RegExp(`['"]\\.\\.?/${escapeRe(m)}\\.ts['"]`)
    if (Object.entries(o.files).some(([p, text]) => p !== `otto/tests/${m}.test.ts` && imp.test(text))) continue
    const named = new RegExp(`\\b(${tools.map(escapeRe).join('|')})\\b`)
    if (o.triggerTexts.some(t => named.test(t) || t.includes(`${m}.ts`))) continue
    const last = Math.max(0, ...[...tools, `cli:${m}`].map(k => Date.parse(o.usage.uses[k]?.lastAt ?? '') || 0))
    const idle = Math.floor((o.now - Math.max(last, since)) / DAY)
    if (idle >= o.idleDays) out.push({ module: m, tools, idleDays: idle })
  }
  // A tool goes only when every module bound to it goes: otherwise a kept module
  // would lose its tool through a neighbour's sweep.
  for (let n = -1; n !== out.length;) {
    n = out.length
    const going = new Set(out.map(c => c.module))
    const held = new Set([...bound].flatMap(([m, t]) => going.has(m) ? [] : t))
    out = out.filter(c => !c.tools.some(t => held.has(t)))
  }
  return out.sort((a, b) => b.idleDays - a.idleDays)
}

/** The server without these modules: their imports from every server file, their tools' handlers and definitions. Keyed like the input. */
export function pruneServer(files: Record<string, string>, modules: string[], tools: string[]): Record<string, string> {
  const blocks = Object.fromEntries(Object.entries(files).map(([f, src]) => [f, toolBlocks(src)]))
  for (const t of tools) {
    for (const kind of ['case', 'def'] as const) {
      if (!Object.values(blocks).some(bs => bs.some(b => b.tool === t && b.kind === kind))) throw new Error(`pruneServer: no definition/case for ${t}`)
    }
  }
  const out: Record<string, string> = {}
  const names: string[] = []
  for (const [f, src] of Object.entries(files)) {
    const drop = new Set<number>()
    for (const b of blocks[f]) if (tools.includes(b.tool)) for (let i = b.start; i <= b.end; i++) drop.add(i)
    const imports = parseImports(src)
    for (const m of modules) {
      const imp = imports.get(m)
      if (!imp) continue
      names.push(...imp.names)
      for (const l of imp.lines) drop.add(l)
    }
    out[f] = src.split('\n').filter((_, i) => !drop.has(i)).join('\n')
  }
  for (const n of names) if (Object.values(out).some(src => wordRe([n]).test(src))) throw new Error(`pruneServer: ${n} is still referenced`)
  return out
}

/** Distinct local days with an inbound message at or after sinceMs. */
export function activeDays(entries: { ts: string; dir: string }[], sinceMs: number): number {
  const days = new Set<string>()
  for (const e of entries) {
    const t = Date.parse(e.ts)
    if (e.dir !== 'in' || !(t >= sinceMs)) continue
    const d = new Date(t)
    days.add(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`)
  }
  return days.size
}

/** `idleDays` 0 turns the sweep off. */
export function sweepConfig(raw?: { idleDays?: unknown }): { idleDays: number } {
  const n = Number(raw?.idleDays)
  return { idleDays: raw?.idleDays !== undefined && raw?.idleDays !== null && Number.isFinite(n) && n >= 0 ? n : 60 }
}

// ---------------------------------------------------------------------------
// Sweep state and the offer
// ---------------------------------------------------------------------------

export type SweepRecord = {
  id: string; branch: string; at: string; modules: Candidate[]
  removed: number; added: number; docLines: number; selfTest: string
  status: 'offered' | 'merged' | 'kept' | 'ignored' | 'stale'
}
export type SweepState = { sweeps: SweepRecord[]; kept: string[]; lastError?: string; lastRunAt?: string }

export function loadSweepState(file: string): SweepState {
  return loadState<SweepState>(file, () => ({ sweeps: [], kept: [] }), v => !!v && Array.isArray((v as any).sweeps))
}

export function saveSweepState(file: string, s: SweepState): void {
  saveState(file, { ...s, sweeps: s.sweeps.slice(-12) })
}

export function parseShortstat(s: string): { removed: number; added: number } {
  return {
    removed: Number(/(\d+) deletions?\(-\)/.exec(s)?.[1] ?? 0),
    added: Number(/(\d+) insertions?\(\+\)/.exec(s)?.[1] ?? 0),
  }
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

export function formatSweepOffer(r: SweepRecord): { text: string; buttons: { label: string; data: string }[] } {
  const n = r.modules.length
  const count = n < WORDS.length ? WORDS[n] : String(n)
  const idle = Math.min(...r.modules.map(m => m.idleDays))
  const names = r.modules.map(m => m.module).join(', ')
  // "self-test" is a word here, not the tool name: messages never name tools.
  return {
    text: `${count} module${n === 1 ? '' : 's'} ${n === 1 ? "hasn't" : "haven't"} been used in ${idle} days: ${names}. a branch without ${n === 1 ? 'it' : 'them'} drops ${r.removed} lines and passes its self-test.`,
    buttons: [{ label: 'look', data: `look sweep ${r.id}` }, { label: 'keep them', data: `keep sweep ${r.id}` }],
  }
}

export function sweepSummary(r: SweepRecord): string {
  const lines = r.modules.map(m => `- ${m.module} (tool${m.tools.length === 1 ? '' : 's'} ${m.tools.join(', ')}): unused ${m.idleDays} days`)
  lines.push(`Doc lines trimmed to match: ${r.docLines}.`, `Loaded clean in a disconnected copy: ${r.selfTest}.`, 'Approve merges it into main; the capability log keeps the undo.')
  return lines.join('\n').slice(0, 1500)
}

// ---------------------------------------------------------------------------
// Standing docs that name what was deleted
// ---------------------------------------------------------------------------

/**
 * Doc lines (outside code fences) naming a removed tool in backticks or a removed `<m>.ts`.
 * docdrift only flags snake_case names that vanished, so a single-word tool name would otherwise survive
 * in CLAUDE.md and tell the session to call a tool that no longer exists.
 */
export function docMentions(docs: { doc: string; text: string }[], tools: string[], modules: string[]): Finding[] {
  const out: Finding[] = []
  const path = new RegExp(`(?<![\\w-])(${modules.map(escapeRe).join('|')})\\.ts\\b`)
  for (const { doc, text } of docs) {
    let fence = false
    text.split('\n').forEach((line, i) => {
      if (/^\s*```/.test(line)) { fence = !fence; return }
      if (fence) return
      const tool = tools.find(t => line.includes(`\`${t}\``))
      if (tool) { out.push({ doc, line: i + 1, kind: 'tool', token: tool, message: `names removed tool ${tool}` }); return }
      const p = modules.length ? path.exec(line) : null
      if (p) out.push({ doc, line: i + 1, kind: 'path', token: `${p[1]}.ts`, message: `names removed module ${p[1]}.ts` })
    })
  }
  return out
}

export type DocEdit = { doc: string; line: number; text: string }

/** The first JSON array in a model reply, fenced or bare; anything else is no edits. */
export function parseDocEdits(text: string): DocEdit[] {
  const a = text.indexOf('['), b = text.lastIndexOf(']')
  if (a < 0 || b < a) return []
  try {
    const arr = JSON.parse(text.slice(a, b + 1))
    return Array.isArray(arr)
      ? arr.filter(e => e && typeof e.doc === 'string' && Number.isInteger(e.line) && typeof e.text === 'string')
        .map(e => ({ doc: e.doc, line: e.line, text: e.text }))
      : []
  } catch { return [] }
}

/** Applies an edit only to a flagged line. `""` deletes it. The plugin instructions block isn't line-addressable. */
export function applyDocEdits(files: Record<string, string>, flagged: Finding[], edits: DocEdit[]): { files: Record<string, string>; applied: number; rejected: number } {
  const ok = new Set(flagged.map(f => `${f.doc}:${f.line}`))
  const marks = new Map<string, Map<number, string>>()
  let applied = 0, rejected = 0
  for (const e of edits) {
    if (e.doc.endsWith('(instructions)') || !ok.has(`${e.doc}:${e.line}`) || !(e.doc in files) || /\n/.test(e.text)) { rejected++; continue }
    const m = marks.get(e.doc) ?? new Map<number, string>()
    m.set(e.line, e.text); marks.set(e.doc, m); applied++
  }
  const out = { ...files }
  for (const [doc, m] of marks) {
    out[doc] = files[doc].split('\n')
      .map((l, i) => (m.has(i + 1) ? m.get(i + 1)! : l))
      .filter((l, i) => !(m.get(i + 1) === ''))
      .join('\n')
  }
  return { files: out, applied, rejected }
}

// A read-only dry run: what the sweep would consider today, from live usage. It builds nothing.
if (import.meta.main) {
  const { readFileSync } = await import('fs')
  const { join } = await import('path')
  const { homedir } = await import('os')
  const src = SERVER_FILES.map(f => readFileSync(join(import.meta.dir, f), 'utf8')).join('\n')
  const usage = loadUsage(join(process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'), TOOL_USAGE_NAME))
  const since = Date.parse(usage.since)
  console.log(`tracking since ${usage.since.slice(0, 10)} (${Math.floor((Date.now() - since) / DAY)} days)`)
  for (const [m, tools] of boundModules(src)) {
    const last = Math.max(since, ...[...tools, `cli:${m}`].map(k => Date.parse(usage.uses[k]?.lastAt ?? '') || 0))
    console.log(`${m.padEnd(18)} idle ${String(Math.floor((Date.now() - last) / DAY)).padStart(3)}d  ${tools.join(', ')}`)
  }
}
