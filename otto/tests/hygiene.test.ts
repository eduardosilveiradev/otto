import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  planHygiene, runHygiene, resolveConfig, parseCrashNote, formatHygieneEvent, capAsks,
  recentClosures, loadHygieneState, DEFAULT_CONFIG, hygieneDue, type HygieneState,
} from '../hygiene.ts'
import { bugNote, regressionPath } from '../selftriage.ts'
import { loadNotes, saveNotes, upsertNote, formatNote, type Note } from '../store.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-hyg-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const DAY = 86_400_000
const NOW = Date.parse('2026-09-29T05:00:00Z')
const fresh = (): HygieneState => ({ proposed: {}, avoidanceNamed: {} })

function loop(id: string, text: string, over: Partial<Note> = {}): Note {
  return { id, kind: 'loop', text, tags: [], createdAt: '2026-06-01T00:00:00Z', status: 'open', ...over }
}
/** A revert-kind crash note by default: the kind that quiet time is evidence for. */
function crash(id: string, iso: string, cause = 'TypeError: x is undefined', kind: 'revert' | 'bug' = 'revert'): Note {
  const tail = kind === 'revert' ? 'Reverted the install.' : 'Bug filed with a failing test.'
  return loop(id, `crash loop: 3 restarts from ${iso}. Cause: ${cause}. ${tail}`, {
    tags: ['crash', kind === 'revert' ? 'revert' : 'file-bug'],
    createdAt: iso,
  })
}

// ---- crash loops ----------------------------------------------------------

test('parses exactly what selftriage.bugNote writes', () => {
  const b = bugNote({
    loop: { restarts: 3, firstAt: Date.parse('2026-08-01T10:00:00Z'), windowMs: 600_000 },
    crash: { kind: 'TypeError', message: 'boom', signature: 'TypeError: boom', frames: [] },
    action: 'file-bug',
  } as never)
  const n = loop('c1', b.text, { tags: b.tags })
  const c = parseCrashNote(n)
  expect(c).toMatchObject({ iso: '2026-08-01T10:00:00.000Z' })
  expect((c as { cause?: string }).cause).toBe('TypeError: boom')
})

test('a weeks-old crash loop with no recurrence closes itself, with the reason', () => {
  const notes = [crash('c1', '2026-08-20T10:00:00Z')]
  const plan = planHygiene(notes, fresh(), { now: NOW })
  expect(plan.close).toHaveLength(1)
  expect(plan.close[0]).toMatchObject({ id: 'c1', status: 'done' })
  expect(plan.close[0].reason).toContain('no crash recorded for 39 days')
  expect(plan.close[0].reason).toContain('last 2026-08-20')
})

test('a crash inside the window keeps the old one open', () => {
  const notes = [crash('old', '2026-08-01T10:00:00Z', 'A'), crash('recent', '2026-09-25T10:00:00Z', 'B')]
  const plan = planHygiene(notes, fresh(), { now: NOW })
  expect(plan.close).toEqual([])
})

test('the window is configurable', () => {
  const notes = [crash('c1', '2026-09-20T10:00:00Z')]
  expect(planHygiene(notes, fresh(), { now: NOW }).close).toEqual([])
  const short = resolveConfig({ crashQuietDays: 5 })
  expect(planHygiene(notes, fresh(), { now: NOW, config: short }).close).toHaveLength(1)
})

test('the same cause recurring supersedes the older note instead of leaving both', () => {
  const notes = [crash('old', '2026-09-10T10:00:00Z'), crash('new', '2026-09-20T10:00:00Z')]
  const plan = planHygiene(notes, fresh(), { now: NOW })
  expect(plan.close).toEqual([{ id: 'old', status: 'dropped', reason: expect.stringContaining('superseded by note new') }])
})

test('an unreadable crash timestamp is proposed, never closed', () => {
  const notes = [loop('c1', 'crash loop: some restarts from sometime.')]
  const plan = planHygiene(notes, fresh(), { now: NOW })
  expect(plan.close).toEqual([])
  expect(plan.propose.map(p => p.id)).toEqual(['c1'])
})

test('a reopened crash loop is never auto-closed again', () => {
  const n = { ...crash('c1', '2026-08-01T10:00:00Z'), reopenedAt: '2026-09-01T00:00:00Z' }
  expect(planHygiene([n], fresh(), { now: NOW }).close).toEqual([])
})

test('non-crash loops are untouched by the crash rule', () => {
  const plan = planHygiene([loop('a', 'send the signed contract')], fresh(), { now: NOW })
  expect(plan.close).toEqual([])
})

// ---- duplicates and proposals ----------------------------------------------

test('exact duplicates close, keeping the oldest', () => {
  const notes = [
    loop('a', 'Send the contract.', { createdAt: '2026-09-01T00:00:00Z' }),
    loop('b', 'send the  contract', { createdAt: '2026-09-10T00:00:00Z' }),
    loop('c', 'send the contract to the landlord', { createdAt: '2026-09-11T00:00:00Z' }),
  ]
  const plan = planHygiene(notes, fresh(), { now: NOW })
  expect(plan.close).toEqual([{ id: 'b', status: 'dropped', reason: 'duplicate of loop a' }])
})

test('old and overdue is only proposed — and only once', () => {
  const notes = [loop('a', 'file the return', { due: '2026-07-01', createdAt: '2026-06-01T00:00:00Z' })]
  const plan = planHygiene(notes, fresh(), { now: NOW })
  expect(plan.close).toEqual([])
  expect(plan.propose).toHaveLength(1)
  expect(plan.propose[0].reason).toContain('overdue')
  const state = { ...fresh(), proposed: { a: '2026-09-01T00:00:00Z' } }
  expect(planHygiene(notes, state, { now: NOW }).propose).toEqual([])
})

test('a loop touched recently is not proposed even when overdue', () => {
  const notes = [loop('a', 'file the return', { due: '2026-07-01', updatedAt: '2026-09-20T00:00:00Z' })]
  expect(planHygiene(notes, fresh(), { now: NOW }).propose).toEqual([])
})

test('a loop with no due date is proposed only after a long silence', () => {
  const young = loop('a', 'think about the garden', { createdAt: '2026-08-01T00:00:00Z' })
  const old = loop('b', 'think about the shed', { createdAt: '2026-05-01T00:00:00Z' })
  const plan = planHygiene([young, old], fresh(), { now: NOW })
  expect(plan.propose.map(p => p.id)).toEqual(['b'])
})

test('closed loops, facts and saved items are never candidates', () => {
  const notes: Note[] = [
    loop('a', 'done thing', { status: 'done', due: '2026-01-01' }),
    { id: 'f', kind: 'fact', text: 'old fact', tags: [], createdAt: '2025-01-01T00:00:00Z' },
  ]
  const plan = planHygiene(notes, fresh(), { now: NOW })
  expect(plan).toEqual({ close: [], propose: [], avoidance: [] })
})

// ---- avoidance ---------------------------------------------------------------

test('deferrals are recorded only when the due date moves later', () => {
  const notes: Note[] = [loop('a', 'call the dentist', { due: '2026-09-01' })]
  upsertNote(notes, { id: 'a', due: '2026-09-01' })       // same date
  upsertNote(notes, { id: 'a', due: '2026-08-30' })       // earlier
  expect(notes[0].deferrals).toBeUndefined()
  upsertNote(notes, { id: 'a', due: '2026-09-02' })
  upsertNote(notes, { id: 'a', due: '2026-09-05' })
  expect(notes[0].deferrals).toHaveLength(2)
})

test('avoidance is named at the threshold, and never again', () => {
  const n = loop('a', 'call the dentist', { due: '2026-10-01', deferrals: ['2026-09-01T00:00:00Z', '2026-09-08T00:00:00Z'] })
  expect(planHygiene([n], fresh(), { now: NOW }).avoidance).toEqual([])
  n.deferrals!.push('2026-09-15T00:00:00Z')
  const plan = planHygiene([n], fresh(), { now: NOW })
  expect(plan.avoidance).toMatchObject([{ id: 'a', deferrals: 3 }])
  n.deferrals!.push('2026-09-22T00:00:00Z')
  const state = { ...fresh(), avoidanceNamed: { a: '2026-09-16T00:00:00Z' } }
  expect(planHygiene([n], state, { now: NOW }).avoidance).toEqual([])
})

test('a loop being closed is not also named as avoided', () => {
  const n = { ...crash('c1', '2026-08-01T10:00:00Z'), deferrals: ['a', 'b', 'c'] }
  const plan = planHygiene([n], fresh(), { now: NOW })
  expect(plan.close).toHaveLength(1)
  expect(plan.avoidance).toEqual([])
})

// ---- the pass, against files ---------------------------------------------------

function setup(name: string, notes: Note[]) {
  const notesFile = join(tmp, `${name}-notes.json`)
  const stateFile = join(tmp, `${name}-hygiene.json`)
  saveNotes(notesFile, notes)
  return { notesFile, stateFile }
}

test('the nightly pass closes, records why, and can be undone', () => {
  const f = setup('run', [crash('c1', '2026-08-20T10:00:00Z')])
  const r = runHygiene({ ...f, now: NOW })
  expect(r.closed).toBe(1)
  let n = loadNotes(f.notesFile)[0]
  expect(n).toMatchObject({ status: 'done', closedBy: 'hygiene', closedAt: new Date(NOW).toISOString() })
  expect(n.closedReason).toContain('no crash recorded')
  expect(formatNote(n)).toContain('closed: no crash recorded')
  expect(recentClosures(loadNotes(f.notesFile), NOW - DAY)).toHaveLength(1)

  // Undo: reopen through the ordinary path. The evidence is cleared, the loop
  // is marked reopened, and the next pass leaves it alone.
  const notes = loadNotes(f.notesFile)
  upsertNote(notes, { id: 'c1', status: 'open' })
  saveNotes(f.notesFile, notes)
  n = loadNotes(f.notesFile)[0]
  expect(n.closedReason).toBeUndefined()
  expect(n.reopenedAt).toBeDefined()
  expect(runHygiene({ ...f, now: NOW + DAY }).closed).toBe(0)
  expect(loadNotes(f.notesFile)[0].status).toBe('open')
})

test('nothing is ever deleted', () => {
  const f = setup('nodelete', [crash('c1', '2026-08-20T10:00:00Z'), loop('a', 'x'), loop('b', 'x')])
  runHygiene({ ...f, now: NOW })
  expect(loadNotes(f.notesFile).map(n => n.id).sort()).toEqual(['a', 'b', 'c1'])
})

test('a dry run changes nothing on disk', () => {
  const f = setup('dry', [crash('c1', '2026-08-20T10:00:00Z')])
  const before = readFileSync(f.notesFile, 'utf8')
  const r = runHygiene({ ...f, now: NOW, dryRun: true })
  expect(r.plan.close).toHaveLength(1)
  expect(readFileSync(f.notesFile, 'utf8')).toBe(before)
  expect(loadHygieneState(f.stateFile)).toEqual(fresh())
})

test('a second run says nothing new: proposals and avoidance fire once across nights', () => {
  const stale = loop('a', 'file the return', { due: '2026-07-01' })
  const slid = loop('b', 'call the dentist', { due: '2026-10-05', deferrals: ['x', 'y', 'z'] })
  const f = setup('once', [stale, slid])
  const first = runHygiene({ ...f, now: NOW })
  expect(first.plan.propose).toHaveLength(1)
  expect(first.plan.avoidance).toHaveLength(1)
  expect(formatHygieneEvent(first.plan)).not.toBeNull()
  const second = runHygiene({ ...f, now: NOW + DAY })
  expect(second.plan).toEqual({ close: [], propose: [], avoidance: [] })
  expect(formatHygieneEvent(second.plan)).toBeNull()
})

test('overflow asks are not marked as said, so they wait a night instead of vanishing', () => {
  const many = Array.from({ length: 7 }, (_, i) => loop(`l${i}`, `stale thing ${i}`, { due: '2026-07-01' }))
  const f = setup('cap', many)
  const first = runHygiene({ ...f, now: NOW })
  expect(first.plan.propose).toHaveLength(4)
  const second = runHygiene({ ...f, now: NOW + DAY })
  expect(second.plan.propose).toHaveLength(3)
  expect(new Set([...first.plan.propose, ...second.plan.propose].map(p => p.id)).size).toBe(7)
})

test('capAsks puts avoidance ahead of stale proposals', () => {
  const plan = capAsks({
    close: [],
    propose: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, text: 't', reason: 'r' })),
    avoidance: [{ id: 'a', text: 't', deferrals: 3, dues: [] }],
  }, 4)
  expect(plan.avoidance).toHaveLength(1)
  expect(plan.propose).toHaveLength(3)
})

test('the event is self-contained, buttons fit Telegram, and it asks for normal priority', () => {
  const plan = { close: [], propose: [{ id: 'abcd1234', text: 'file the return', reason: '90d overdue' }], avoidance: [] }
  const text = formatHygieneEvent(plan, { chat: '1234567890' })!
  expect(text).toContain('close loop abcd1234 as dropped')
  expect(text).toContain('priority "normal"')
  expect(text).toContain('1234567890')
  for (const m of text.matchAll(/→ "([^"]+)"/g)) expect(Buffer.byteLength(m[1])).toBeLessThanOrEqual(60)
})

test('resolveConfig falls back on junk', () => {
  expect(resolveConfig({ crashQuietDays: 'soon', staleLoopDays: -3, avoidanceThreshold: 0 })).toEqual(DEFAULT_CONFIG)
  expect(resolveConfig(null)).toEqual(DEFAULT_CONFIG)
  expect(resolveConfig({ crashQuietDays: 7.9 }).crashQuietDays).toBe(7)
})

test('a corrupt state file reads as empty rather than throwing', () => {
  const file = join(tmp, 'corrupt-state.json')
  writeFileSync(file, '{not json')
  expect(loadHygieneState(file)).toEqual(fresh())
})

// ---- review fixes ------------------------------------------------------------

test('non-Latin loops are not closed as duplicates of unrelated loops', () => {
  const notes = [
    loop('a', 'позвонить маме', { due: '2026-10-01', createdAt: '2026-09-01T00:00:00Z' }),
    loop('b', 'купить хлеб', { due: '2026-10-01', createdAt: '2026-09-02T00:00:00Z' }),
    loop('c', '母親に電話する', { due: '2026-10-01', createdAt: '2026-09-03T00:00:00Z' }),
    loop('d', '📞🍞', { due: '2026-10-01', createdAt: '2026-09-04T00:00:00Z' }),
    loop('e', '🛒', { due: '2026-10-01', createdAt: '2026-09-05T00:00:00Z' }),
  ]
  expect(planHygiene(notes, fresh(), { now: NOW }).close).toEqual([])
})

test('real duplicates are still found in other scripts, accents intact', () => {
  const notes = [
    loop('a', 'Позвонить маме!', { createdAt: '2026-09-01T00:00:00Z' }),
    loop('b', 'позвонить  маме', { createdAt: '2026-09-02T00:00:00Z' }),
    loop('c', 'ligar para a mãe', { createdAt: '2026-09-03T00:00:00Z' }),
    loop('d', 'ligar para a m e', { createdAt: '2026-09-04T00:00:00Z' }),
  ]
  const plan = planHygiene(notes, fresh(), { now: NOW })
  // "mãe" and "m e" are different sentences; only the Cyrillic pair is one loop.
  expect(plan.close).toEqual([{ id: 'b', status: 'dropped', reason: 'duplicate of loop a' }])
})

test('a filed-bug crash loop is proposed once when quiet, never closed on silence alone', () => {
  const notes = [crash('c1', '2026-08-01T10:00:00Z', 'TypeError: boom', 'bug')]
  const plan = planHygiene(notes, fresh(), { now: NOW })
  expect(plan.close).toEqual([])
  expect(plan.propose).toHaveLength(1)
  expect(plan.propose[0].reason).toContain('failing regression test')
  const said = { ...fresh(), proposed: { c1: '2026-09-01T00:00:00Z' } }
  expect(planHygiene(notes, said, { now: NOW })).toEqual({ close: [], propose: [], avoidance: [] })
})

test('a filed-bug crash loop closes once its regression test is gone, and only then', () => {
  const notes = [crash('c1', '2026-08-01T10:00:00Z', 'TypeError: boom', 'bug')]
  const gone = planHygiene(notes, fresh(), { now: NOW, regressionExists: () => false })
  expect(gone.close).toHaveLength(1)
  expect(gone.close[0].reason).toContain('regression test no longer exists')
  for (const answer of [true, undefined]) {
    const plan = planHygiene(notes, fresh(), { now: NOW, regressionExists: () => answer })
    expect(plan.close).toEqual([])
    expect(plan.propose).toHaveLength(1)
  }
  // The checker is asked about the same path selftriage writes.
  const asked: string[] = []
  planHygiene(notes, fresh(), { now: NOW, regressionExists: sig => { asked.push(sig); return true } })
  expect(asked).toEqual(['TypeError: boom'])
  expect(regressionPath('TypeError: boom')).toBe('otto/tests/regressions/typeerror-boom.test.ts')
})

test('an unknown-cause filed bug has no test to check and is proposed, not closed', () => {
  const notes = [crash('c1', '2026-08-01T10:00:00Z', 'unknown', 'bug')]
  const plan = planHygiene(notes, fresh(), { now: NOW, regressionExists: () => false })
  expect(plan.close).toEqual([])
  expect(plan.propose).toHaveLength(1)
})

test('unrelated crashes with an unknown cause do not supersede each other', () => {
  const notes = [
    crash('old', '2026-09-10T10:00:00Z', 'unknown'),
    crash('new', '2026-09-20T10:00:00Z', 'unknown'),
  ]
  expect(planHygiene(notes, fresh(), { now: NOW }).close).toEqual([])
  // Once quiet, each closes on its own evidence — not as "superseded".
  const later = planHygiene(notes, fresh(), { now: NOW + 30 * DAY })
  expect(later.close.map(c => c.id).sort()).toEqual(['new', 'old'])
  expect(later.close.every(c => !c.reason.includes('superseded'))).toBe(true)
})

test('bugNote text round-trips into the right kind', () => {
  const base = { loop: { restarts: 3, firstAt: Date.parse('2026-08-01T10:00:00Z'), windowMs: 600_000 } }
  const revert = bugNote({ ...base, blamed: { id: 'x1', what: 'A recipe' }, action: 'revert' } as never)
  const bug = bugNote({ ...base, crash: { kind: 'E', message: 'm', signature: 'E: m', frames: [] }, action: 'file-bug' } as never)
  expect((parseCrashNote(loop('r', revert.text)) as { kind: string }).kind).toBe('revert')
  expect((parseCrashNote(loop('b', bug.text)) as { kind: string }).kind).toBe('bug')
})

test('a loop is never both proposed and named in the same plan, or across nights', () => {
  const both = loop('a', 'file the return', {
    due: '2026-07-01', createdAt: '2026-05-01T00:00:00Z',
    deferrals: ['2026-06-01T00:00:00Z', '2026-06-10T00:00:00Z', '2026-06-20T00:00:00Z'],
  })
  const plan = planHygiene([both], fresh(), { now: NOW })
  expect(plan.avoidance.map(a => a.id)).toEqual(['a'])
  expect(plan.propose).toEqual([])

  const f = setup('both', [both])
  expect(runHygiene({ ...f, now: NOW }).plan.avoidance).toHaveLength(1)
  const next = runHygiene({ ...f, now: NOW + DAY })
  expect(next.plan).toEqual({ close: [], propose: [], avoidance: [] })
  expect(formatHygieneEvent(next.plan)).toBeNull()
})

test('a slow consolidation delays the pass instead of skipping the night', () => {
  const base = { today: '2026-09-29', lastConsolidationDay: '2026-09-29', consolidationInFlight: false }
  expect(hygieneDue({ ...base, hour: 4 })).toBe(false)                          // too early
  expect(hygieneDue({ ...base, hour: 5 })).toBe(true)
  expect(hygieneDue({ ...base, hour: 5, consolidationInFlight: true })).toBe(false)
  expect(hygieneDue({ ...base, hour: 6 })).toBe(true)                            // 05:00 tick was busy; still runs
  expect(hygieneDue({ ...base, hour: 6, lastHygieneDay: '2026-09-29' })).toBe(false)
  // Consolidation has not finished today: wait...
  expect(hygieneDue({ ...base, hour: 6, lastConsolidationDay: '2026-09-28' })).toBe(false)
  // ...but not forever, if the machine slept through 04:00.
  expect(hygieneDue({ ...base, hour: 9, lastConsolidationDay: '2026-09-28' })).toBe(true)
  expect(hygieneDue({ ...base, hour: 9, lastConsolidationDay: undefined, consolidationInFlight: true })).toBe(false)
})
