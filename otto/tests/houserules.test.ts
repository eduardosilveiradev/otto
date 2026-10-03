import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  compileHouseRules, writeHouseRules, extractRule, similar, HOUSE_RULES_NAME, GENERATED_MARK,
} from '../houserules.ts'
import { writeMemory, parseMemory, type Memory } from '../memory.ts'

// Memory files go to a scratch directory passed explicitly — never the real store.
const dir = mkdtempSync(join(tmpdir(), 'otto-hr-'))
afterAll(() => { try { rmSync(dir, { recursive: true }) } catch {} })

function load(): Memory[] {
  return readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').flatMap(f => {
    const path = join(dir, f)
    const m = parseMemory(path, readFileSync(path, 'utf8'), 'global', statSync(path).mtimeMs)
    return m ? [m] : []
  })
}

const DAY = 86_400_000
let clock = 0
function fb(name: string, description: string, body = 'Correction.', over: Partial<Memory> = {}): Memory {
  return { name, description, type: 'feedback', body, scope: 'global', path: `__HOME__/${name}.md`, mtimeMs: 1_000_000 + (clock++) * DAY, links: [], ...over }
}

test('the rule is the description; a stated why is appended short', () => {
  const m = fb('a', 'Never use emoji in replies.', 'Do not.\n**Why:** they read it as noise on a small screen')
  expect(extractRule(m)!.text).toBe('Never use emoji in replies (why: they read it as noise on a small screen)')
})

test('a memory with no description falls back to the first sentence of the body', () => {
  const m = fb('a', '', 'Keep replies under two lines. More detail follows.')
  expect(extractRule(m)!.core).toBe('Keep replies under two lines')
})

test('near-duplicate corrections collapse to the newest wording', () => {
  const mems = [
    fb('old', 'Never use emoji in your replies'),
    fb('other', 'Always include the timezone on times'),
    fb('new', 'Never use emoji in replies'),
  ]
  const c = compileHouseRules(mems)
  expect(c.merged).toBe(1)
  expect(c.rules.map(r => r.text)).toEqual(['Never use emoji in replies', 'Always include the timezone on times'])
  expect(c.rules[0].merged).toEqual(['old'])
})

test('short rules sharing two words are different corrections and stay separate', () => {
  const c = compileHouseRules([fb('a', 'reply short on telegram'), fb('b', 'reply lowercase on telegram')])
  expect(c.merged).toBe(0)
  expect(c.rules.map(r => r.text).sort()).toEqual(['reply lowercase on telegram', 'reply short on telegram'])
})

test('the same short rule worded identically still collapses', () => {
  const c = compileHouseRules([fb('a', 'Reply short on Telegram.'), fb('b', 'reply short on telegram')])
  expect(c.rules).toHaveLength(1)
  expect(c.merged).toBe(1)
})

test('similar() needs three shared words unless the sets are identical', () => {
  const s = (...w: string[]) => new Set(w)
  expect(similar(s('a', 'b'), s('a', 'c'), 0.6)).toBe(false)
  expect(similar(s('a', 'b'), s('a', 'b', 'c'), 0.6)).toBe(false)   // two shared, not enough
  expect(similar(s('a', 'b'), s('a', 'b'), 0.6)).toBe(true)
  expect(similar(s('a', 'b', 'c', 'd'), s('a', 'b', 'c', 'e'), 0.6)).toBe(true)
  expect(similar(s(), s('a'), 0.6)).toBe(false)
})

test('unrelated corrections are not merged just for sharing a word', () => {
  const c = compileHouseRules([fb('a', 'Draft emails in a dry tone'), fb('b', 'Never send emails without a draft shown')])
  expect(c.rules).toHaveLength(2)
})

test('only global feedback counts, and never the compiler’s own output', () => {
  const c = compileHouseRules([
    fb('g', 'Answer in the terminal when typed there'),
    fb('p', 'Use tabs in this repo', 'x', { scope: '-some-project' }),
    fb('u', 'A user memory', 'x', { type: 'user' }),
    fb(HOUSE_RULES_NAME, 'Compiled house rules'),
  ])
  expect(c.rules.map(r => r.from)).toEqual(['g'])
})

test('output is stable across runs and respects the size budget, dropping the oldest', () => {
  const mems = Array.from({ length: 40 }, (_, i) => fb(`m${i}`, `Distinct correction number ${i} about topic${i}x`))
  const a = compileHouseRules(mems, { maxChars: 400 })
  const b = compileHouseRules([...mems].reverse(), { maxChars: 400 })
  expect(a.block).toBe(b.block)
  expect(a.block.length).toBeLessThanOrEqual(400)
  expect(a.dropped).toBeGreaterThan(0)
  expect(a.rules[0].from).toBe('m39')
})

test('no feedback compiles to nothing', () => {
  expect(compileHouseRules([]).block).toBe('')
})

test('written once as a global reference memory; unchanged input is not rewritten', () => {
  writeMemory({ name: 'fb-one', description: 'Never use emoji in replies', type: 'feedback', body: 'x', scope: 'global', dir })
  writeMemory({ name: 'fb-two', description: 'Always include the timezone on times', type: 'feedback', body: 'x', scope: 'global', dir })
  const first = writeHouseRules(load(), { dir })
  expect(first.result).toBe('written')
  const mem = load().find(m => m.name === HOUSE_RULES_NAME)!
  expect(mem.type).toBe('reference')
  expect(mem.body.startsWith(GENERATED_MARK)).toBe(true)
  expect(mem.body).toContain('- Never use emoji in replies')
  expect(writeHouseRules(load(), { dir }).result).toBe('unchanged')

  // The compiled memory is not itself a correction: a re-run must not feed on it.
  const again = compileHouseRules(load())
  expect(again.rules).toHaveLength(2)
})

test('a memory of that name the pass did not write is never overwritten', () => {
  const path = join(dir, `${HOUSE_RULES_NAME}.md`)
  writeFileSync(path, '---\nname: house-rules\ndescription: mine\nmetadata:\n  type: reference\n---\n\nhand written\n')
  const r = writeHouseRules(load(), { dir })
  expect(r.result).toBe('foreign-memory')
  expect(readFileSync(path, 'utf8')).toContain('hand written')
})
