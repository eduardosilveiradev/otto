import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildRevert,
  resolveRevert,
  weeklyLine,
  revertable,
  formatEntry,
  appendEntry,
  loadLog,
  markReverted,
  entryId,
  INLINE_FILE_MAX,
  type CapEntry,
} from '../changelog.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-clog-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const NOW = Date.parse('2026-08-12T09:00:00Z')
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

function entry(over: Partial<CapEntry> = {}): CapEntry {
  return {
    id: over.id ?? entryId(),
    at: ago(2),
    what: 'added a nocturne CI watch',
    paths: ['otto/skills/recipes/SKILL.md'],
    tier: 'confirmed',
    origin: 'user-typed',
    by: 'forge',
    revert: { kind: 'restore-files', files: [{ path: 'otto/skills/recipes/SKILL.md', before: 'old text' }] },
    ...over,
  }
}

test('a small change carries its own previous bytes', () => {
  const r = buildRevert([{ path: 'otto/skills/x.md', before: 'before' }], 'abc1234')
  expect(r.kind).toBe('restore-files')
  expect(resolveRevert(entry({ revert: r })).selfContained).toBe(true)
})

// The whole reason the payload is not just a sha.
test('a self-contained revert still resolves with no git and no working tree', () => {
  const e = entry()
  const r = resolveRevert(e)
  expect(r.selfContained).toBe(true)
  expect(r.plan[0]).toContain('write 8 bytes back to otto/skills/recipes/SKILL.md')
  expect(r.caveat).toBeUndefined()
})

test('a file that did not exist before is reverted by deleting it', () => {
  const r = buildRevert([{ path: 'otto/skills/new.md', before: null }])
  const plan = resolveRevert(entry({ revert: r })).plan
  expect(plan[0]).toContain('delete otto/skills/new.md')
  expect(plan[0]).toContain('did not exist')
})

test('an oversize diff falls back to a sha and says so out loud', () => {
  const big = 'x'.repeat(INLINE_FILE_MAX + 1)
  const r = buildRevert([{ path: 'otto/huge.ts', before: big }], 'deadbeef1234')
  expect(r.kind).toBe('git-revert')
  const res = resolveRevert(entry({ revert: r }))
  expect(res.selfContained).toBe(false)
  expect(res.caveat).toContain('best-effort')
  expect(res.caveat).toContain('deadbeef')
  expect(res.plan[0]).toContain('git checkout deadbeef1234')
})

test('an oversize diff with no sha admits it cannot be undone', () => {
  const r = buildRevert([{ path: 'otto/huge.ts', before: 'x'.repeat(INLINE_FILE_MAX + 1) }])
  expect(r.kind).toBe('none')
  expect(resolveRevert(entry({ revert: r })).caveat).toContain('cannot be undone')
})

test('trigger installs revert without touching git at all', () => {
  const del = resolveRevert(entry({ revert: { kind: 'delete-trigger', triggerId: 'a1b2c3' } }))
  expect(del.selfContained).toBe(true)
  expect(del.plan[0]).toBe('delete trigger a1b2c3')

  const restore = resolveRevert(
    entry({ revert: { kind: 'restore-trigger', trigger: { id: 'a1b2c3', action: 'old action' } } }),
  )
  expect(restore.plan[0]).toContain('old action')
})

test('an already-reverted entry has nothing left to do', () => {
  const r = resolveRevert(entry({ revertedAt: ago(1) }))
  expect(r.plan).toEqual([])
  expect(r.caveat).toContain('already reverted')
})

test('the weekly line names what changed and how to undo it', () => {
  const text = weeklyLine([entry({ id: 'aa11', what: 'added a nocturne CI watch' })], NOW)!
  expect(text).toContain('one thing')
  expect(text).toContain('added a nocturne CI watch')
  expect(text).toContain('[aa11]')
  expect(text).toContain('"undo <id>"')
})

test('a quiet week says nothing at all', () => {
  expect(weeklyLine([], NOW)).toBeNull()
  expect(weeklyLine([entry({ at: ago(24 * 30) })], NOW)).toBeNull()
})

test('rollbacks are reported alongside installs', () => {
  const text = weeklyLine(
    [entry({ what: 'added a watch' }), entry({ what: 'changed the brief', revertedAt: ago(1) })],
    NOW,
  )!
  expect(text).toContain('1 rolled back')
  expect(text).toContain('changed the brief')
})

test('a best-effort undo is flagged in the weekly line rather than buried', () => {
  const fragile = entry({
    id: 'bb22',
    revert: { kind: 'git-revert', sha: 'abc', paths: ['otto/x.ts'], why: 'too big' },
  })
  const text = weeklyLine([fragile], NOW)!
  expect(text).toContain('best-effort')
  expect(text).toContain('bb22')
  expect(text).not.toContain('"undo <id>"')
})

test('revertable is newest-first and drops reverted and stale entries', () => {
  const entries = [
    entry({ id: 'old', at: ago(24 * 30) }),
    entry({ id: 'done', at: ago(3), revertedAt: ago(1) }),
    entry({ id: 'new', at: ago(1) }),
    entry({ id: 'mid', at: ago(5) }),
  ]
  expect(revertable(entries, 7 * 24 * 3_600_000, NOW).map(e => e.id)).toEqual(['new', 'mid'])
})

test('formatEntry carries provenance and the undo on one screen', () => {
  const text = formatEntry(entry({ id: 'cc33', origin: 'user-typed', tier: 'confirmed' }))
  expect(text).toContain('[cc33]')
  expect(text).toContain('forge, confirmed (user-typed)')
  expect(text).toContain('undo: write 8 bytes back')
})

test('the log round-trips through disk and marks reverts', () => {
  const file = join(tmp, 'capability-log.json')
  appendEntry(file, entry({ id: 'dd44' }))
  appendEntry(file, entry({ id: 'ee55' }))
  expect(loadLog(file).map(e => e.id)).toEqual(['dd44', 'ee55'])
  expect(markReverted(file, 'dd44', ago(0))!.id).toBe('dd44')
  expect(loadLog(file)[0].revertedAt).toBe(ago(0))
  expect(markReverted(file, 'nope', ago(0))).toBeNull()
})

// This file is the only copy of every revert payload — losing it silently is
// the one failure that makes every other entry worthless.
test('a corrupt log is moved aside, not dropped', () => {
  const file = join(tmp, 'broken.json')
  writeFileSync(file, '{not json')
  expect(loadLog(file)).toEqual([])
  expect(readdirSync(tmp).some(f => f.startsWith('broken.json.corrupt-'))).toBe(true)
})

test('a missing log is simply empty', () => {
  expect(loadLog(join(tmp, 'never-written.json'))).toEqual([])
})
