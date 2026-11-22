import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildRulebook, groupByTopic, topicOf, headline, rulebookCard, formatRulebook, findRule, deleteRule, editRule, restoreMemory, monthlyOffer, due, ruleId } from '../rulebook.ts'
import { writeMemory, parseMemory, type Memory, type MemoryType } from '../memory.ts'
import { resolveRevert } from '../changelog.ts'
import { validateCard } from '../cards.ts'
import type { RecallStats } from '../recallstats.ts'

// Scratch directories only, never the real store.
const root = mkdtempSync(join(tmpdir(), 'otto-rulebook-'))
afterAll(() => { try { rmSync(root, { recursive: true }) } catch {} })
const dirs: Record<string, string> = { global: join(root, 'global'), proj: join(root, 'proj') }

const DAY = 86_400_000
const NOW = Date.parse('2026-11-23T12:00:00Z')
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()

function mem(scope: string, name: string, description: string, writtenDaysAgo = 200, type: MemoryType = 'feedback'): Memory {
  const w = writeMemory({ name, description, type, body: `${description}.\n\n**Why:** they said so.`, scope, dir: dirs[scope] })
  return parseMemory(w.path, readFileSync(w.path, 'utf8'), scope, NOW - writtenDaysAgo * DAY)!
}
const stats = (hits: Record<string, number>, sinceDaysAgo = 300): RecallStats => ({
  since: iso(sinceDaysAgo), misses: {},
  hits: Object.fromEntries(Object.entries(hits).map(([k, d]) => [k, { count: 1, firstAt: iso(d), lastAt: iso(d) }])),
})

test('topics: first matching keyword wins, unknowns are other', () => {
  expect(topicOf('show the email draft before sending')).toBe('email')
  expect(topicOf('merge code-job PRs yourself')).toBe('code')
  expect(topicOf('no eyes emoji reactions on telegram')).toBe('messaging')
  expect(topicOf('be nice')).toBe('other')
})

test('grouping and staleness: feedback only, 60-day line, house rules count as use', () => {
  const a = mem('global', 'short-telegram', 'Telegram replies stay short')
  const b = mem('global', 'draft-first', 'Show every email draft before sending')
  const c = mem('proj', 'merge-prs', 'Merge code job PRs once mergeable')
  const d = mem('proj', 'fresh-rule', 'New rule about telegram bubbles', 5)
  const u = mem('global', 'who-they-are', 'Not a rule', 200, 'user')
  const rules = buildRulebook([a, b, c, d, u], stats({
    'global/short-telegram': 90,   // own hit is old, but the house-rules block carrying it was returned yesterday
    'global/house-rules': 1,
    'proj/merge-prs': 70,
  }), NOW)
  expect(rules.map(r => r.name).sort()).toEqual(['draft-first', 'fresh-rule', 'merge-prs', 'short-telegram'])
  const by = Object.fromEntries(rules.map(r => [r.name, r]))
  expect(by['short-telegram'].stale).toBe(false)
  expect(by['short-telegram'].lastUsedAt).toBe(iso(1))
  expect(by['merge-prs'].stale).toBe(true)        // project rules are not in house rules; last returned 70 days ago
  expect(by['fresh-rule'].stale).toBe(false)      // written 5 days ago, never returned yet
  expect(by['draft-first'].stale).toBe(false)     // in the global house-rules block
  expect(by['merge-prs'].path).toBe(join(dirs.proj, 'merge-prs.md'))
  expect([...groupByTopic(rules).keys()]).toEqual(['code', 'email', 'messaging'])
  expect(headline(rules)).toBe("4 rules. 1 hasn't applied since September.")
  expect(formatRulebook(rules)).toContain(`[${ruleId('proj/merge-prs')}] Merge code job PRs once mergeable (stale)`)
})

test('never returned: stale only after 60 days of exposure since counting began', () => {
  const m = mem('proj', 'old-unused', 'An old rule nobody recalls', 400)
  expect(buildRulebook([m], stats({}, 30), NOW)[0].stale).toBe(false)
  const r = buildRulebook([m], stats({}, 90), NOW)
  expect(r[0].stale).toBe(true)
  expect(headline(r)).toBe("1 rule. 1 hasn't applied in 60+ days.")
})

test('card validates, stale rules get delete buttons first, monthly offer only when something is stale', () => {
  const fresh = mem('proj', 'card-fresh', 'Reply short in the app', 3)
  const old = mem('proj', 'card-old', 'Never play audio on the speakers', 400)
  const rules = buildRulebook([fresh, old], stats({}, 90), NOW)
  const { card, buttons } = rulebookCard(rules)
  expect(validateCard(card).ok).toBe(true)
  expect(buttons[0]).toEqual({ label: 'delete: Never play audio on the speakers', data: `delete rule ${ruleId('proj/card-old')}` })
  expect(monthlyOffer(rules)).toEqual({ text: "2 rules. 1 hasn't applied in 60+ days.", buttons: [{ label: 'review', data: 'review rulebook' }] })
  expect(monthlyOffer(rules.filter(r => !r.stale))).toBeNull()
})

test('monthly window is the 22nd–24th from 10:00, once a month', () => {
  expect(due(undefined, new Date(2026, 10, 22, 10))).toBe(true)
  expect(due(undefined, new Date(2026, 10, 22, 9))).toBe(false)
  expect(due('2026-11', new Date(2026, 10, 23, 12))).toBe(false)
  for (const d of [1, 3, 8, 10, 15, 17, 25]) expect(due(undefined, new Date(2026, 10, d, 12))).toBe(false)
})

test('delete then undo restores the file and only its index line', () => {
  const m = mem('global', 'delete-me', 'Delete me rule about email')
  const rule = findRule(buildRulebook([m], stats({}), NOW), ruleId('global/delete-me'))!
  const fileBefore = readFileSync(m.path, 'utf8')
  const revert = deleteRule(rule)
  expect(existsSync(m.path)).toBe(false)
  const idx = join(dirs.global, 'MEMORY.md')
  expect(readFileSync(idx, 'utf8')).not.toContain('(delete-me.md)')
  // A memory written after the delete must survive the undo.
  mem('global', 'later', 'Written after the delete')
  expect(resolveRevert({ id: 'x', at: '', what: '', paths: [], tier: 'confirmed', origin: 'user-typed', by: 'rulebook', revert }).selfContained).toBe(true)
  restoreMemory(revert)
  expect(readFileSync(m.path, 'utf8')).toBe(fileBefore)
  const after = readFileSync(idx, 'utf8')
  expect(after).toContain('- [delete-me](delete-me.md) — Delete me rule about email')
  expect(after).toContain('(later.md)')
})

test('edit rewrites the description in place, keeps the body, and undoes', () => {
  const m = mem('proj', 'edit-me', 'Old wording of the rule')
  writeFileSync(m.path, readFileSync(m.path, 'utf8').replace('metadata:', 'extra: kept\nmetadata:'))
  const original = readFileSync(m.path, 'utf8')
  const rule = findRule(buildRulebook([m], stats({}), NOW), 'edit-me')!
  const revert = editRule(rule, '  New wording,\n one line ')
  const text = readFileSync(m.path, 'utf8')
  expect(text).toContain('description: New wording, one line\n')
  expect(text).toContain('extra: kept')
  expect(text).toContain('**Why:** they said so.')
  expect(text).not.toContain('Old wording of the rule\n---')
  expect(readFileSync(join(dirs.proj, 'MEMORY.md'), 'utf8')).toContain('- [edit-me](edit-me.md) — New wording, one line')
  const reparsed = parseMemory(m.path, text, 'proj', NOW)!
  expect(buildRulebook([reparsed], stats({}), NOW)[0].text).toBe('New wording, one line')
  expect(() => editRule(rule, '  ')).toThrow()
  restoreMemory(revert)
  expect(readFileSync(m.path, 'utf8')).toBe(original)
  expect(readFileSync(join(dirs.proj, 'MEMORY.md'), 'utf8')).toContain('- [edit-me](edit-me.md) — Old wording of the rule')
})
