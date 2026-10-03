/**
 * House rules — the user's own corrections, compiled into one block.
 *
 * Every "no, not like that" the user gives ends up as a `feedback` memory, one
 * file each, and the session only benefits from them if it happens to recall the
 * right one. Over months they pile up as near-duplicates ("don't use emoji",
 * "no emoji in replies") that a search returns three of and a human never
 * re-reads. This compiles them, nightly, into a single short, deduplicated
 * list: the user's corrections, not Otto's opinions.
 *
 * Deliberately mechanical. The input is already a one-line description per
 * correction, so extraction is "take the description", deduplication is token
 * overlap, and ordering is newest first (a later correction wins the wording).
 * No model call is needed; if a smarter rewrite is ever wanted it belongs
 * behind this file's single `compileHouseRules` entry point, not scattered.
 *
 * Only global-scope feedback is compiled: a correction made inside one repo is
 * not a rule about the user everywhere. And the output is written as a memory
 * under a reserved name, marked as generated, so a hand-written memory of the
 * same name is never overwritten and the compiler never reads its own output.
 */

import { tokenize, loadMemories, writeMemory, type Memory } from './memory.ts'

export const HOUSE_RULES_NAME = 'house-rules'
/** First line of the generated body. A memory without it was not written by this pass. */
export const GENERATED_MARK = '<!-- generated nightly from feedback memories; edits are overwritten -->'

export type Rule = { text: string; from: string; merged: string[] }

export type Compiled = {
  rules: Rule[]
  /** Corrections folded into another as duplicates. */
  merged: number
  /** Corrections that did not fit the size budget (oldest go first). */
  dropped: number
  block: string
}

const RULE_MAX = 160
const WHY_MAX = 90

/** One line, no bullets or markup noise, capped. */
function clean(s: string, max: number): string {
  const t = s
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/^[\s>*\-–—#]+/, '')
    .replace(/[*_`]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;:,\s]+$/, '')
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** The rule text, plus a short "why" when the memory states one. */
export function extractRule(m: Memory): { text: string; core: string } | null {
  let core = clean(m.description, RULE_MAX)
  if (!core) {
    // No description: the first sentence of the body is the correction.
    core = clean(m.body.split(/(?<=[.!?])\s|\n/)[0] ?? '', RULE_MAX)
  }
  if (!core) return null
  const why = /^\s*[*_]*why[*_]*\s*:[*_]*\s*(.+)$/im.exec(m.body)?.[1]
  const w = why ? clean(why, WHY_MAX) : ''
  return { core, text: w ? `${core} (why: ${w})` : core }
}

/**
 * Two corrections are one rule only when they say the same thing: identical
 * word sets, or heavy overlap across at least three shared words. Short rules
 * are the trap — "reply short on telegram" and "reply lowercase on telegram"
 * share two of three words and are different instructions, so a fractional
 * score alone would merge exactly the corrections that matter most.
 */
export function similar(a: Set<string>, b: Set<string>, threshold: number): boolean {
  if (!a.size || !b.size) return false
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  if (inter === a.size && inter === b.size) return true
  return inter >= 3 && inter / (a.size + b.size - inter) >= threshold
}

export type CompileOpts = { maxRules?: number; maxChars?: number; similarity?: number }

export function compileHouseRules(memories: Memory[], opts: CompileOpts = {}): Compiled {
  const { maxRules = 25, maxChars = 1500, similarity = 0.6 } = opts
  const feedback = memories
    .filter(m => m.type === 'feedback' && m.scope === 'global' && m.name !== HOUSE_RULES_NAME)
    // Newest first; name breaks ties so the output is stable across runs.
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))

  const kept: (Rule & { tokens: Set<string> })[] = []
  let merged = 0
  for (const m of feedback) {
    const r = extractRule(m)
    if (!r) continue
    const tokens = new Set(tokenize(r.core))
    const twin = kept.find(k => similar(k.tokens, tokens, similarity))
    if (twin) { twin.merged.push(m.name); merged++; continue }
    kept.push({ text: r.text, from: m.name, merged: [], tokens })
  }

  const header = 'House rules — the user’s standing corrections, newest first:'
  let rules = kept.slice(0, maxRules)
  const render = (rs: Rule[]) => [header, ...rs.map(r => `- ${r.text}`)].join('\n')
  while (rules.length > 1 && render(rules).length > maxChars) rules = rules.slice(0, -1)
  const dropped = kept.length - rules.length

  return {
    rules: rules.map(({ text, from, merged }) => ({ text, from, merged })),
    merged,
    dropped,
    block: rules.length ? render(rules) : '',
  }
}

export type WriteResult = 'written' | 'unchanged' | 'no-rules' | 'foreign-memory'

/**
 * Compile and store as a global memory. Idempotent: an unchanged block is not
 * rewritten, so the memory's mtime means "the rules last changed" and nothing
 * churns. Never deletes — with no feedback at all it does nothing, and it will
 * not touch a memory of that name it did not write.
 */
export function writeHouseRules(
  memories: Memory[] = loadMemories(true),
  opts: CompileOpts & { dir?: string } = {},
): { result: WriteResult; compiled: Compiled } {
  const compiled = compileHouseRules(memories, opts)
  if (!compiled.rules.length) return { result: 'no-rules', compiled }

  const body = `${GENERATED_MARK}\n${compiled.block}`
  const existing = memories.find(m => m.name === HOUSE_RULES_NAME && m.scope === 'global')
  if (existing && !existing.body.startsWith(GENERATED_MARK)) return { result: 'foreign-memory', compiled }
  if (existing && existing.body.trim() === body.trim()) return { result: 'unchanged', compiled }

  writeMemory({
    name: HOUSE_RULES_NAME,
    description: `Compiled house rules: ${compiled.rules.length} standing corrections from the user, regenerated nightly`,
    type: 'reference',
    body,
    scope: 'global',
    ...(opts.dir ? { dir: opts.dir } : {}),
  })
  return { result: 'written', compiled }
}
