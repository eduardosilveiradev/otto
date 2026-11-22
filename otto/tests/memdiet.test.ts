import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  projectSlug, contextFiles, measureContext, superseded, planDiet, renderDiff, dietPaths, applyDiet,
  formatDietOffer, loadDietState, saveDietState, actionKey, type DietAction, type DietRun,
} from '../memdiet.ts'
import { writeMemory, parseMemory, type Memory, type MemoryType } from '../memory.ts'
import type { AuditRow } from '../recallstats.ts'

// Memory files go to scratch directories passed explicitly, never the real store.
const root = mkdtempSync(join(tmpdir(), 'otto-diet-'))
afterAll(() => { try { rmSync(root, { recursive: true }) } catch {} })
const dirs = { global: join(root, 'global'), proj: join(root, 'proj') }
const dirFor = (scope: string) => dirs[scope as keyof typeof dirs]

const DAY = 86_400_000
let clock = 0
/** Writes the file and its index line, then reads it back the way the store does. */
function mem(scope: 'global' | 'proj', name: string, description: string, type: MemoryType = 'user', body = 'Line one.\nLine two.\nLine three.\nLine four.'): Memory {
  const written = writeMemory({ name, description, type, body, scope, dir: dirFor(scope) })
  const m = parseMemory(written.path, readFileSync(written.path, 'utf8'), scope, 1_000_000 + (clock++) * DAY)!
  return m
}
const row = (m: Memory, ageDays = 40): AuditRow => ({ key: `${m.scope}/${m.name}`, type: m.type, description: m.description, ageDays, hits: 0 })
const indexOf = (scope: 'global' | 'proj') => readFileSync(join(dirFor(scope), 'MEMORY.md'), 'utf8')

test('projectSlug matches the projects directory naming', () => {
  expect(projectSlug('/x/.y/repo')).toBe('-x--y-repo')
})

test('contextFiles walks from the repo up to / then the home files, MEMORY.md last', () => {
  expect(contextFiles('/a/repo', '__HOME__')).toEqual([
    '/a/repo/CLAUDE.md', '/a/repo/CLAUDE.local.md', '/a/CLAUDE.md', '/a/CLAUDE.local.md', '/CLAUDE.md', '/CLAUDE.local.md',
    '__HOME__/.claude/CLAUDE.md', '__HOME__/.claude/projects/-a-repo/memory/MEMORY.md',
  ])
})

test('measureContext is chars/4, skips missing files and counts only the first 200 index lines', () => {
  const m = measureContext([
    { path: '/a/CLAUDE.md', text: 'x'.repeat(400) },
    { path: '/a/CLAUDE.local.md', text: null },
    { path: '/h/memory/MEMORY.md', text: Array.from({ length: 300 }, () => 'abcd').join('\n') },
  ])
  expect(m.files).toHaveLength(2)
  expect(m.files[0].tokens).toBe(100)
  expect(m.files[1].tokens).toBe(Math.ceil((200 * 4 + 199) / 4))
  expect(m.tokens).toBe(m.files[0].tokens + m.files[1].tokens)
})

test('superseded pairs a near-identical newer memory, but only within a scope and type', () => {
  const older = mem('global', 'age-old', 'age 13 freshman year fall 2026')
  const newer = mem('global', 'age-new', 'age 13 freshman year hs fall 2026')
  expect(superseded([older, newer])).toEqual([{ older, newer }])
  expect(superseded([older, { ...newer, scope: 'proj' }])).toEqual([])
  expect(superseded([older, { ...newer, type: 'project' }])).toEqual([])
})

test('the short-rule trap: two different corrections are not one', () => {
  const a = mem('global', 'short', 'reply short on telegram', 'feedback')
  const b = mem('global', 'lower', 'reply lowercase on telegram', 'feedback')
  expect(superseded([a, b])).toEqual([])
})

test('house-rules is never paired', () => {
  const a = mem('global', 'house-rules', 'house rules the user keeps standing corrections newest first', 'feedback')
  const b = mem('global', 'other-rules', 'house rules the user keeps standing corrections newest first', 'feedback')
  expect(superseded([a, b])).toEqual([])
})

test('planDiet: unindex carries the exact index line; no line or another scope yields nothing', () => {
  const m = mem('proj', 'quiet-note', 'a note nobody recalls')
  const other = mem('global', 'global-note', 'a global note nobody recalls')
  const ghost: Memory = { ...mem('proj', 'ghost', 'no index line'), name: 'ghost' }
  writeFileSync(join(dirs.proj, 'MEMORY.md'), indexOf('proj').split('\n').filter(l => !l.includes('(ghost.md)')).join('\n'))
  const plan = planDiet({
    memories: [m, other, ghost], neverHit: [row(m), row(other), row(ghost)], indexText: indexOf('proj'),
    indexScope: 'proj', indexFor: s => indexOf(s as 'proj'), declined: [],
  })
  expect(plan).toEqual([{ kind: 'unindex', scope: 'proj', file: 'quiet-note', line: '- [quiet-note](quiet-note.md) — a note nobody recalls', days: 40 }])
})

test('planDiet: a superseded pair is one drop and no unindex for the same file; declined and max apply', () => {
  const older = mem('global', 'job-old', 'works at the bakery on weekends since spring')
  const newer = mem('global', 'job-new', 'works at the bakery on weekends since summer')
  const lone = mem('proj', 'lone', 'only one of me')
  const base = { memories: [older, newer, lone], indexText: indexOf('proj'), indexScope: 'global', indexFor: (s: string) => indexOf(s as 'global') }
  const plan = planDiet({ ...base, neverHit: [row(older)], declined: [] })
  expect(plan).toHaveLength(1)
  expect(plan[0]).toMatchObject({ kind: 'drop', scope: 'global', file: 'job-old', by: 'job-new', line: '- [job-old](job-old.md) — works at the bakery on weekends since spring' })
  expect(planDiet({ ...base, neverHit: [row(older)], declined: [actionKey(plan[0])] })).toEqual([])

  const a = mem('proj', 'aa', 'dusty ledger about alpha'), b = mem('proj', 'bb', 'quiet recipe covering bravo')
  const capped = planDiet({ memories: [older, newer, a, b], neverHit: [row(a, 10), row(b, 90)], indexText: indexOf('proj'), indexScope: 'proj', indexFor: s => indexOf(s as 'proj'), declined: [], max: 2 })
  expect(capped.map(x => x.kind)).toEqual(['drop', 'unindex'])
  expect((capped[1] as Extract<DietAction, { kind: 'unindex' }>).file).toBe('bb')   // oldest first
})

test('an index line is found by file name even when the frontmatter name differs', () => {
  const m = mem('proj', 'file-name', 'description')
  const renamed: Memory = { ...m, name: 'a different frontmatter name' }
  const plan = planDiet({
    memories: [renamed], neverHit: [{ ...row(m), key: 'proj/a different frontmatter name' }], indexText: indexOf('proj'),
    indexScope: 'proj', indexFor: () => '', declined: [],
  })
  expect(plan.map(a => a.kind === 'unindex' && a.file)).toEqual(['file-name'])
})

test('renderDiff shows the removed index lines and the deleted file', () => {
  const diff = renderDiff([
    { kind: 'unindex', scope: 'proj', file: 'name', line: '- [name](name.md) — gist', days: 40 },
    { kind: 'drop', scope: 'global', file: 'old', by: 'newer', line: '- [old](old.md) — gist', head: 'a\nb' },
  ])
  expect(diff).toContain('--- proj/MEMORY.md')
  expect(diff).toContain('- - [name](name.md) — gist')
  expect(diff).toContain('--- global/old.md (deleted; newer replaces it)')
  expect(diff).toContain('(deleted; newer replaces it)')
})

test('renderDiff stays under 4000 chars and says how much it cut', () => {
  const many: DietAction[] = Array.from({ length: 50 }, (_, i) => ({ kind: 'unindex', scope: 'proj', file: `n${i}`, line: `- [n${i}](n${i}.md) — ${'x'.repeat(120)}`, days: 40 }))
  const diff = renderDiff(many)
  expect(diff.length).toBeLessThanOrEqual(4000)
  expect(diff).toMatch(/… \d+ more lines$/)
})

test('applyDiet removes only its lines, deletes only superseded files, and is idempotent', () => {
  const o = mem('global', 'ap-old', 'apply test thing that happened on a sunny afternoon')
  const n = mem('global', 'ap-new', 'apply test thing that happened on a sunny evening')
  const keep = mem('proj', 'ap-keep', 'stays in the index')
  const gone = mem('proj', 'ap-gone', 'leaves the index only')
  const plan = planDiet({
    memories: [o, n, keep, gone], neverHit: [row(gone)], indexText: indexOf('proj'), indexScope: 'proj',
    indexFor: s => indexOf(s as 'global'), declined: [],
  })
  expect(plan.map(a => a.kind)).toEqual(['drop', 'unindex'])
  expect(applyDiet(plan, dirFor)).toBe(2)
  expect(existsSync(join(dirs.global, 'ap-old.md'))).toBe(false)
  expect(existsSync(join(dirs.global, 'ap-new.md'))).toBe(true)
  expect(indexOf('global')).not.toContain('(ap-old.md)')
  expect(indexOf('global')).toContain('(ap-new.md)')
  expect(existsSync(join(dirs.proj, 'ap-gone.md'))).toBe(true)   // only the index line goes
  expect(indexOf('proj')).not.toContain('(ap-gone.md)')
  expect(indexOf('proj')).toContain('(ap-keep.md)')
  const before = [indexOf('global'), indexOf('proj')]
  expect(applyDiet(plan, dirFor)).toBe(0)
  expect([indexOf('global'), indexOf('proj')]).toEqual(before)
})

test('a drop whose replacement is gone is skipped, and dietPaths dedupes MEMORY.md', () => {
  const o = mem('global', 'sk-old', 'skip test memory of the old trip')
  const n = mem('global', 'sk-new', 'skip test memory of the new trip')
  const a: DietAction = { kind: 'drop', scope: 'global', file: 'sk-old', by: 'sk-new', head: '' }
  rmSync(n.path)
  expect(applyDiet([a], dirFor)).toBe(0)
  expect(existsSync(o.path)).toBe(true)
  const u: DietAction = { kind: 'unindex', scope: 'global', file: 'x', line: '- x', days: 1 }
  expect(dietPaths([a, u, u], dirFor)).toEqual([join(dirs.global, 'MEMORY.md'), join(dirs.global, 'sk-old.md')])
})

const run = (tokens: number, u: number, d: number): DietRun => ({
  month: '2026-11', at: '', tokens, files: [], status: 'offered',
  actions: [
    ...Array.from({ length: u }, (_, i): DietAction => ({ kind: 'unindex', scope: 'g', file: `u${i}`, line: 'l', days: 1 })),
    ...Array.from({ length: d }, (_, i): DietAction => ({ kind: 'drop', scope: 'g', file: `d${i}`, by: 'n', head: '' })),
  ],
})

test('the offer is one plain line with one button', () => {
  expect(formatDietOffer(run(9200, 14, 5))!.text).toBe('~9k tokens before you type. 14 never recalled, 5 superseded.')
  expect(formatDietOffer(run(9200, 14, 0))!.text).toBe('~9k tokens before you type. 14 never recalled.')
  expect(formatDietOffer(run(100, 0, 2))!.text).toBe('~1k tokens before you type. 2 superseded.')
  expect(formatDietOffer(run(9200, 0, 0))).toBeNull()
  expect(Buffer.byteLength(formatDietOffer(run(9200, 1, 0))!.buttons[0].data)).toBeLessThanOrEqual(60)
  expect(formatDietOffer(run(9200, 1, 0))!.buttons[0].data).toBe('view diet 2026-11')
})

test('diet state keeps twelve runs and moves a corrupt file aside', () => {
  const f = join(root, 'memdiet.json')
  const s = loadDietState(f)
  for (let i = 0; i < 15; i++) s.runs.push({ ...run(1, 0, 0), month: `m${i}` })
  saveDietState(f, s)
  expect(loadDietState(f).runs).toHaveLength(12)
  writeFileSync(f, 'nope{')
  expect(loadDietState(f)).toEqual({ runs: [], declined: [] })
  expect(readdirSync(root).some(n => n.startsWith('memdiet.json.corrupt-'))).toBe(true)
  expect(statSync(root).isDirectory()).toBe(true)
})
