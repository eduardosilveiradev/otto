import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseMemory } from '../memory.ts'
import { collect, readNotes, scopeLabel, summaryPrompt, buildHtml } from '../memviewer.ts'
import { emptyStats } from '../recallstats.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-memviewer-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const DAY = 86_400_000
const now = Date.parse('2026-06-01T00:00:00Z')

const raw = `---
name: likes-short-replies
description: Replies stay short
metadata:
  type: feedback
---

Keep it to a line. See [[who-they-are]].`

test('frontmatter, notes and recall stats come together as items', () => {
  const fb = parseMemory('/x/likes-short-replies.md', raw, 'global', now - 90 * DAY)!
  const user = parseMemory('/x/who-they-are.md', '---\nname: who-they-are\ndescription: The user\nmetadata:\n  type: user\n---\nA person.', 'global', now - 90 * DAY)!
  expect(fb.type).toBe('feedback')
  expect(fb.links).toEqual(['who-they-are'])

  const file = join(tmp, 'notes.json')
  writeFileSync(file, JSON.stringify([
    { id: 'a1', kind: 'loop', text: 'Pay the plumber\nby Friday', tags: [], createdAt: '2026-05-01T00:00:00Z', due: '2026-05-30' },
    { id: 'b2', kind: 'loop', text: 'Old thing', tags: [], createdAt: '2026-05-01T00:00:00Z', status: 'done' },
    { id: 'c3', kind: 'fact', text: 'Lives somewhere', tags: ['home'], createdAt: '2026-05-01T00:00:00Z' },
  ]))
  const notes = readNotes(file)

  const stats = emptyStats(now - 60 * DAY)
  stats.hits['global/who-they-are'] = { count: 3, firstAt: '2026-05-01T00:00:00Z', lastAt: '2026-05-31T00:00:00Z' }
  const items = collect([fb, user], notes, stats, { now })

  expect(items.filter(i => i.store === 'durable')).toHaveLength(2)
  expect(items.find(i => i.name === 'likes-short-replies')!.badge).toBe('never')
  const who = items.find(i => i.name === 'who-they-are')!
  expect(who.badge).toBeUndefined()
  expect(who.hits).toBe(3)
  const loop = items.find(i => i.id === 'a1')!
  expect(loop.status).toBe('open')              // a loop with no status is open
  expect(loop.name).toBe('Pay the plumber')     // first line only
  expect(items.find(i => i.id === 'c3')!.status).toBeUndefined()

  const prompt = summaryPrompt(items, '2026-06-01')
  expect(prompt).toContain('Keep it to a line.')   // global feedback bodies go in whole
  expect(prompt).toContain('due 2026-05-30')
  expect(prompt).not.toContain('Old thing')         // closed loops stay out

  const html = buildHtml(items, { text: '## Who they are\n</script>', note: '' }, new Date(now).toISOString())
  expect(html).not.toContain('/*DATA*/')
  expect(html.match(/<\/script>/g)!.length).toBe(2)  // embedded data cannot close the tag
})

test('notes are read without touching the file', () => {
  expect(readNotes(join(tmp, 'missing.json'))).toEqual([])
  const bad = join(tmp, 'bad.json')
  writeFileSync(bad, '{not json')
  expect(() => readNotes(bad)).toThrow()
  expect(existsSync(bad)).toBe(true)
  expect(readdirSync(tmp).some(f => f.includes('corrupt'))).toBe(false)
})

test('project scopes are labelled relative to home', () => {
  expect(scopeLabel('-home-someone--otto-repo', '/home/someone')).toBe('~/.otto-repo')
  expect(scopeLabel('global', '/home/someone')).toBe('global')
})
