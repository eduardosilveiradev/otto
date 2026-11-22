/**
 * The rulebook — every rule the user has given Otto, on one page they can edit.
 *
 * A rule is a `feedback` memory, global or project scope. house-rules.ts
 * compiles the global ones nightly; this lists all of them, one row per file,
 * with when it was written and when it last mattered (recall-stats: the last
 * time recall returned it, or returned the compiled house-rules block that
 * carries it). A rule nothing has returned for 60 days is stale.
 *
 * Delete removes the file and its index line; edit rewrites the description
 * (the rule's text) in place. Both return a capability-log revert carrying the
 * old bytes, so "undo that" restores it. Mechanical, no model call.
 */
import { readFileSync, writeFileSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import { createHash } from 'crypto'
import { invalidateCache, removeFromIndex, type Memory } from './memory.ts'
import { isExpired } from './store.ts'
import { compileHouseRules, extractRule, HOUSE_RULES_NAME } from './houserules.ts'
import { memoryKey, type RecallStats } from './recallstats.ts'
import type { Card } from './cards.ts'
import type { RevertPayload } from './changelog.ts'

const DAY = 86_400_000
export const STALE_DAYS = 60

export type Rule = {
  id: string; key: string; name: string; scope: string; path: string
  text: string; topic: string; writtenAt: string; lastUsedAt?: string; stale: boolean
}

export const ruleId = (key: string) => createHash('sha1').update(key).digest('hex').slice(0, 8)

/** First topic with a keyword in the rule wins; order matters (an email draft is email, not messaging). */
const TOPICS: [string, RegExp][] = [
  ['email', /\b(e-?mails?|mail|gmail|inbox|drafts?|receipts?|phishing)\b/],
  ['code', /\b(pr|prs|merge|commits?|push|tests?|builds?|repo|code|branch|deploy|ci|jobs?|xcode|worktrees?)\b/],
  ['school', /\b(homework|school|study|tutor\w*|exams?|textbooks?|teacher)\b/],
  ['home & music', /\b(music|playlists?|songs?|audio|lights?|home|ac|speakers?)\b/],
  ['money & shopping', /\b(price|money|buy|shopping|subscriptions?|budget|shoes?|spend\w*)\b/],
  ['messaging', /\b(telegram|app|imessage|whatsapp|repl(y|ies)|messages?|texts?|bubbles?|emoji|react\w*|ping\w*|voice)\b/],
]
export const topicOf = (s: string) => TOPICS.find(([, re]) => re.test(s.toLowerCase()))?.[0] ?? 'other'

export function buildRulebook(memories: Memory[], stats: RecallStats, now = Date.now(), staleDays = STALE_DAYS): Rule[] {
  const since = Date.parse(stats.since)
  // A rule inside the compiled house-rules block mattered whenever that block was returned.
  const house = stats.hits[`global/${HOUSE_RULES_NAME}`]?.lastAt
  const inHouse = new Set(compileHouseRules(memories).rules.flatMap(r => [r.from, ...r.merged]))
  const rules: Rule[] = []
  for (const m of memories) {
    if (m.type !== 'feedback' || m.name === HOUSE_RULES_NAME || isExpired(m, now)) continue
    const text = extractRule(m)?.core
    if (!text) continue
    const key = memoryKey(m)
    const own = stats.hits[key]?.lastAt
    const lastUsedAt = [own, m.scope === 'global' && inHouse.has(m.name) ? house : undefined]
      .filter((x): x is string => !!x).sort().pop()
    const exposedFrom = lastUsedAt ? Date.parse(lastUsedAt) : Math.max(m.mtimeMs, Number.isNaN(since) ? m.mtimeMs : since)
    rules.push({
      id: ruleId(key), key, name: m.name, scope: m.scope, path: m.path, text,
      topic: topicOf(`${m.name} ${text}`), writtenAt: new Date(m.mtimeMs).toISOString(),
      ...(lastUsedAt ? { lastUsedAt } : {}), stale: now - exposedFrom >= staleDays * DAY,
    })
  }
  return rules.sort((a, b) => a.topic.localeCompare(b.topic) || Number(b.stale) - Number(a.stale) || b.writtenAt.localeCompare(a.writtenAt))
}

export const groupByTopic = (rules: Rule[]) => {
  const g = new Map<string, Rule[]>()
  for (const r of rules) g.set(r.topic, [...(g.get(r.topic) ?? []), r])
  return g
}

const day = (iso: string) => iso.slice(0, 10)
const month = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })
const scopeLabel = (s: string) => s === 'global' ? 'global' : s.split('-').filter(Boolean).slice(-2).join('-')

/** "42 rules. 3 haven't applied since August." */
export function headline(rules: Rule[]): string {
  const stale = rules.filter(r => r.stale)
  const head = `${rules.length} rule${rules.length === 1 ? '' : 's'}.`
  if (!stale.length) return `${head} All applied in the last ${STALE_DAYS} days.`
  const latest = stale.map(r => r.lastUsedAt).filter((x): x is string => !!x).sort().pop()
  const verb = stale.length === 1 ? "hasn't" : "haven't"
  return `${head} ${stale.length} ${verb} applied ${latest && stale.every(r => r.lastUsedAt) ? `since ${month(latest)}` : `in ${STALE_DAYS}+ days`}.`
}

export function formatRulebook(rules: Rule[]): string {
  if (!rules.length) return 'No rules yet — feedback memories become rules.'
  const out = [headline(rules)]
  for (const [topic, rs] of groupByTopic(rules)) {
    out.push('', `${topic}:`)
    for (const r of rs) {
      out.push(`- [${r.id}] ${r.text}${r.stale ? ' (stale)' : ''}`,
        `  ${scopeLabel(r.scope)}/${basename(r.path)}, written ${day(r.writtenAt)}, last mattered ${r.lastUsedAt ? day(r.lastUsedAt) : 'never'}`)
    }
  }
  return out.join('\n')
}

/** Up to 11 topics as lists under the headline; delete buttons for the stale ones first. */
export function rulebookCard(rules: Rule[], maxButtons = 8): { card: Card; buttons: { label: string; data: string }[] } {
  const groups = [...groupByTopic(rules)].slice(0, 11)
  const card: Card = {
    title: headline(rules).slice(0, 80),
    blocks: groups.map(([topic, rs]) => ({
      type: 'list' as const,
      items: rs.slice(0, 20).map(r => ({
        title: r.text.slice(0, 120),
        detail: `${topic} · ${scopeLabel(r.scope)} · written ${day(r.writtenAt)}`.slice(0, 120),
        trailing: r.stale ? 'stale' : r.lastUsedAt ? day(r.lastUsedAt) : 'new',
      })),
    })),
  }
  if (!card.blocks.length) card.blocks = [{ type: 'text', text: 'No rules yet.' }]
  const order = [...rules.filter(r => r.stale), ...rules.filter(r => !r.stale)]
  const buttons = order.slice(0, maxButtons).map(r => ({ label: `delete: ${r.text.slice(0, 40)}`, data: `delete rule ${r.id}` }))
  return { card, buttons }
}

// ---------------------------------------------------------------------------
// Edits. Each returns the capability-log revert, carrying the old bytes.
// ---------------------------------------------------------------------------

export type MemoryRevert = Extract<RevertPayload, { kind: 'restore-memory' }>

const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return null } }
const indexLineOf = (path: string) => read(join(dirname(path), 'MEMORY.md'))?.split('\n').find(l => l.includes(`(${basename(path)})`))

export const findRule = (rules: Rule[], ref: string) => rules.find(r => r.id === ref || r.key === ref || r.name === ref) ?? null

export function deleteRule(rule: Rule): MemoryRevert {
  const before = read(rule.path)
  if (before === null) throw new Error(`rule ${rule.id} is already gone`)
  const indexLine = indexLineOf(rule.path)
  rmSync(rule.path)
  removeFromIndex(dirname(rule.path), basename(rule.path, '.md'))
  invalidateCache()
  return { kind: 'restore-memory', path: rule.path, before, ...(indexLine ? { indexLine } : {}) }
}

/** Rewrites the description line (the rule's text) and its index line; the body (why, how) stays. */
export function editRule(rule: Rule, text: string): MemoryRevert {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('rule text is empty')
  const before = read(rule.path)
  if (before === null) throw new Error(`rule ${rule.id} is gone`)
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(before)
  if (!fm) throw new Error(`${basename(rule.path)} has no frontmatter`)
  const head = /^description:.*$/m.test(fm[1])
    ? fm[1].replace(/^description:.*$/m, `description: ${clean}`)
    : fm[1].replace(/^(name:.*)$/m, `$1\ndescription: ${clean}`)
  writeFileSync(rule.path, before.replace(fm[1], () => head))
  const indexLine = indexLineOf(rule.path)
  if (indexLine) {
    const idx = join(dirname(rule.path), 'MEMORY.md')
    writeFileSync(idx, read(idx)!.replace(indexLine, () => indexLine.replace(/ — .*$/, ` — ${clean}`)))
  }
  invalidateCache()
  return { kind: 'restore-memory', path: rule.path, before, ...(indexLine ? { indexLine } : {}) }
}

/** The inverse of either: the old bytes back, and the old index line back if it is missing or changed. */
export function restoreMemory(r: MemoryRevert): void {
  writeFileSync(r.path, r.before)
  if (r.indexLine) {
    const idx = join(dirname(r.path), 'MEMORY.md')
    const lines = (read(idx) ?? '# Memory Index\n').replace(/\n*$/, '').split('\n')
    const at = lines.findIndex(l => l.includes(`(${basename(r.path)})`))
    if (at >= 0) lines[at] = r.indexLine
    else lines.push(r.indexLine)
    writeFileSync(idx, lines.join('\n') + '\n')
  }
  invalidateCache()
}

// ---------------------------------------------------------------------------
// The monthly message: 22nd–24th from 10:00, clear of the memory diet (1st–3rd),
// the landlord (8th–10th) and the dead-module sweep (15th–17th).
// ---------------------------------------------------------------------------

export const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
export const due = (lastMonth: string | undefined, now: Date) =>
  now.getDate() >= 22 && now.getDate() <= 24 && now.getHours() >= 10 && lastMonth !== monthOf(now)

/** Silent unless something is stale: a count of rules that all still apply is not worth a message. */
export function monthlyOffer(rules: Rule[]): { text: string; buttons: { label: string; data: string }[] } | null {
  if (!rules.some(r => r.stale)) return null
  return { text: headline(rules), buttons: [{ label: 'review', data: 'review rulebook' }] }
}
