import { test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseMemory, tokenize, stem, slugify, renderMemory, searchMemories,
  writeMemory, deleteMemory, updateIndex, removeFromIndex, formatHit,
  type Memory,
} from '../memory.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-mem-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

function mem(over: Partial<Memory> & { name: string; description: string; body: string }): Memory {
  return { type: 'project', scope: 'global', path: `/x/${over.name}.md`, mtimeMs: 0, links: [], ...over }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('frontmatter and body are separated', () => {
  const raw = `---
name: a-thing
description: A thing that matters
metadata:
  type: feedback
  node_type: memory
---

The body goes here.`
  const m = parseMemory('/x/a-thing.md', raw, 'global', 5)!
  expect(m.name).toBe('a-thing')
  expect(m.description).toBe('A thing that matters')
  expect(m.type).toBe('feedback')
  expect(m.body).toBe('The body goes here.')
  expect(m.scope).toBe('global')
})

test('an unknown or missing type falls back to project', () => {
  const raw = '---\nname: x\ndescription: d\nmetadata:\n  type: nonsense\n---\nbody'
  expect(parseMemory('/x/x.md', raw, 'global', 0)!.type).toBe('project')
  expect(parseMemory('/x/x.md', '---\nname: x\ndescription: d\n---\nbody', 'global', 0)!.type).toBe('project')
})

test('a missing name falls back to the filename', () => {
  const m = parseMemory('/x/from-file.md', '---\ndescription: d\n---\nbody', 'global', 0)!
  expect(m.name).toBe('from-file')
})

test('a file with no frontmatter is still readable', () => {
  const m = parseMemory('/x/plain.md', 'just some text', 'global', 0)!
  expect(m.body).toBe('just some text')
  expect(m.name).toBe('plain')
})

test('an empty memory is dropped rather than returned blank', () => {
  expect(parseMemory('/x/empty.md', '---\nname: x\n---\n\n', 'global', 0)).toBeNull()
})

test('wikilinks are extracted', () => {
  const m = parseMemory('/x/a.md', '---\ndescription: d\n---\nsee [[other-thing]] and [[third]]', 'global', 0)!
  expect(m.links).toEqual(['other-thing', 'third'])
})

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

test('stemming collides plurals and -ing forms', () => {
  expect(stem('triggers')).toBe('trigger')
  expect(stem('caching')).toBe('cach')
  expect(stem('cached')).toBe('cach')
  expect(stem('memories')).toBe('memory')
})

test('short words are left alone rather than mangled', () => {
  expect(stem('is')).toBe('is')
  expect(stem('bed')).toBe('bed')
  expect(stem('ties')).toBe('ties')
})

test('tokenizer drops stopwords and keeps technical shapes', () => {
  expect(tokenize('the cost of a c++ build')).toEqual(['cost', 'c++', 'build'])
  expect(tokenize('bot.pid is empty')).toContain('bot.pid')
})

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const corpus = [
  mem({ name: 'sim-racing', description: 'the user — sim racing hobby, Logitech G923 wheel', body: 'The user races in iRacing and Assetto Corsa.' }),
  mem({ name: 'cooking', description: 'the user — technique-driven cooking hobby', body: 'Reverse sear, deglaze, grass-fed steaks.' }),
  mem({ name: 'cost-sensitive', description: 'User prioritizes speed and cost efficiency over features', body: 'Switched models mid-session over token spend.', type: 'feedback' }),
  mem({ name: 'otto-triggers', description: 'Otto trigger engine stores cron and email triggers', body: 'Triggers fire as injected events.', scope: '-home-x-otto' }),
]

test('the description outweighs the body', () => {
  // "hobby" appears in two descriptions; "racing" only in one.
  const hits = searchMemories(corpus, 'racing hobby')
  expect(hits[0].memory.name).toBe('sim-racing')
})

test('stemming makes singular and plural queries agree', () => {
  const a = searchMemories(corpus, 'trigger')
  const b = searchMemories(corpus, 'triggers')
  expect(a[0].memory.name).toBe('otto-triggers')
  expect(b[0].memory.name).toBe('otto-triggers')
})

test('a query matching nothing returns nothing rather than the whole corpus', () => {
  expect(searchMemories(corpus, 'quantum tuba flugelhorn')).toHaveLength(0)
})

test('an empty query falls back to most recent, not to noise', () => {
  const dated = corpus.map((m, i) => ({ ...m, mtimeMs: i }))
  const hits = searchMemories(dated, '', { limit: 2 })
  expect(hits).toHaveLength(2)
  expect(hits[0].memory.name).toBe('otto-triggers')
})

test('scope filters and type filters exclude', () => {
  expect(searchMemories(corpus, 'trigger', { scope: 'global' })).toHaveLength(0)
  expect(searchMemories(corpus, 'cost', { type: 'feedback' })).toHaveLength(1)
  expect(searchMemories(corpus, 'cost', { type: 'user' })).toHaveLength(0)
})

test('preferScope boosts without excluding', () => {
  const withPref = searchMemories(corpus, 'trigger', { preferScope: '-home-x-otto' })
  expect(withPref[0].memory.name).toBe('otto-triggers')
  // Still reachable from elsewhere.
  expect(searchMemories(corpus, 'trigger', { preferScope: 'global' })).toHaveLength(1)
})

test('limit is honoured', () => {
  expect(searchMemories(corpus, 'ada hobby', { limit: 1 })).toHaveLength(1)
})

test('an empty corpus does not throw', () => {
  expect(searchMemories([], 'anything')).toEqual([])
})

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

test('slugify produces safe, bounded filenames', () => {
  expect(slugify('Ada — prefers TypeScript!')).toBe('ada-prefers-typescript')
  expect(slugify('!!!')).toBe('memory')
  expect(slugify('x'.repeat(200)).length).toBeLessThanOrEqual(60)
})

test('rendered memory round-trips through the parser', () => {
  const raw = renderMemory({ name: 'a-b', description: 'desc line', type: 'user', body: 'the body' })
  const parsed = parseMemory('/x/a-b.md', raw, 'global', 0)!
  expect(parsed.name).toBe('a-b')
  expect(parsed.description).toBe('desc line')
  expect(parsed.type).toBe('user')
  expect(parsed.body).toBe('the body')
})

test('writing creates the file and indexes it', () => {
  const m = writeMemory({ description: 'A brand new fact', type: 'user', body: 'Body text.', scope: 'global', dir: tmp })
  expect(existsSync(m.path)).toBe(true)
  expect(readFileSync(join(tmp, 'MEMORY.md'), 'utf8')).toContain('(a-brand-new-fact.md)')
})

test('rewriting the same name updates in place instead of duplicating', () => {
  writeMemory({ name: 'dupe-check', description: 'first', type: 'user', body: 'one', scope: 'global', dir: tmp })
  writeMemory({ name: 'dupe-check', description: 'second', type: 'user', body: 'two', scope: 'global', dir: tmp })
  const index = readFileSync(join(tmp, 'MEMORY.md'), 'utf8')
  expect(index.match(/\(dupe-check\.md\)/g)).toHaveLength(1)
  expect(index).toContain('second')
  expect(readFileSync(join(tmp, 'dupe-check.md'), 'utf8')).toContain('two')
})

test('deleting removes both the file and its index line', () => {
  const m = writeMemory({ name: 'to-delete', description: 'gone soon', type: 'user', body: 'x', scope: 'global', dir: tmp })
  const gone = deleteMemory([m], 'to-delete')
  expect(gone?.name).toBe('to-delete')
  expect(existsSync(m.path)).toBe(false)
  removeFromIndex(tmp, 'to-delete')
  expect(readFileSync(join(tmp, 'MEMORY.md'), 'utf8')).not.toContain('(to-delete.md)')
})

test('deleting something that is not there reports rather than throws', () => {
  expect(deleteMemory([], 'never-existed')).toBeNull()
})

test('formatHit shows scope and type, and can return the full body', () => {
  const h = { memory: corpus[0], score: 1 }
  expect(formatHit(h)).toContain('(project, global)')
  expect(formatHit(h, true)).toContain('iRacing')
})
