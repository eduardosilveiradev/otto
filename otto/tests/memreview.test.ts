import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadCorpus, checkPlan, applyOps, backupMemory, pruneBackups, missingFrom, parsePlan, runReview, MAX_CHANGES,
  type ReviewPlan,
} from '../memreview.ts'

// Everything lives under a scratch "home"; the real memory store is never touched.
const root = mkdtempSync(join(tmpdir(), 'otto-review-'))
afterAll(() => { try { rmSync(root, { recursive: true }) } catch {} })

let n = 0
function setup() {
  const home = join(root, `h${n++}`)
  const dirs = [
    { dir: join(home, '.claude', 'memory', 'global'), scope: 'global' },
    { dir: join(home, '.claude', 'projects', '-live', 'memory'), scope: '-live' },
    { dir: join(home, '.claude', 'projects', 'old', 'memory'), scope: 'old' },
  ]
  for (const d of dirs) mkdirSync(d.dir, { recursive: true })
  const at = (scope: string) => dirs.find(d => d.scope === scope)!.dir
  const mem = (scope: string, file: string, body: string, o: { name?: string; type?: string; description?: string } = {}) =>
    writeFileSync(join(at(scope), `${file}.md`), `---\nname: ${o.name ?? file}\ndescription: ${o.description ?? `about ${file}`}\nmetadata:\n  type: ${o.type ?? 'project'}\n  modified: 2026-11-01\n---\n\n${body}\n`)
  const index = (scope: string, text: string) => writeFileSync(join(at(scope), 'MEMORY.md'), text)
  const text = (scope: string, file: string) => readFileSync(join(at(scope), file), 'utf8')
  const activity = (s: string) => s === 'global' ? Infinity : s === '-live' ? 2 : 0
  return { home, dirs, at, mem, index, text, activity }
}

const empty: ReviewPlan = { merges: [], rewrites: [], removals: [] }

test('missingFrom catches a dropped date, quote or Why line and nothing else', () => {
  const old = 'Decided 8 Nov 2026, again on 2026-11-10. They said "keep it short".\n**Why:** noise.\n**How to apply:** trim.'
  expect(missingFrom([old], old)).toEqual([])
  expect(missingFrom([old], 'keep it short, 2026-11-10. Why: How to apply:')).toEqual(['8 Nov 2026'])
  expect(missingFrom([old], '8 Nov 2026 2026-11-10 keep it short')).toEqual(['Why:', 'How to apply:'])
})

test('checkPlan refuses unknown refs, double use, lost content, merges into a deader scope, and rewrites not offered', () => {
  const s = setup()
  s.mem('-live', 'a', 'Fixed on 2026-11-02.')
  s.mem('old', 'a', 'Fixed on 2026-11-02, same thing.')
  s.mem('-live', 'b', 'Vague.')
  const corpus = loadCorpus(s.dirs)
  const { ops, rejected } = checkPlan({
    merges: [
      { into: 'old/a', from: ['-live/a'], description: 'd', body: 'Fixed on 2026-11-02.', reason: 'dup' },
      { into: '-live/a', from: ['old/a'], description: 'd', body: 'Fixed.', reason: 'dup' },
      { into: '-live/a', from: ['old/a'], description: 'd', body: 'Fixed on 2026-11-02.', reason: 'dup' },
    ],
    rewrites: [
      { memory: '-live/a', description: 'd', body: 'x 2026-11-02', reason: 'r' },
      { memory: '-live/b', description: 'd', body: 'x', reason: 'r' },
      { memory: '-live/nope', description: 'd', body: 'x', reason: 'r' },
    ],
    removals: [],
  }, corpus, s.activity, new Set(['-live/a']))
  expect(ops.map(o => o.kind)).toEqual(['merge'])
  expect(rejected.map(r => r.why)).toEqual([
    'old/a lives in a less active scope than -live/a',
    'would drop "2026-11-02"',
    '-live/a is already in another change tonight',
    'not offered for a rewrite tonight',
    'no memory -live/nope',
  ])
})

test('a merge keeps the survivor, removes the rest, and repoints links and index lines across scopes', () => {
  const s = setup()
  s.mem('global', 'keep', 'Original on 2026-11-01.\nWhy: x\nHow to apply: y', { type: 'feedback' })
  s.mem('global', 'dupe', 'Same rule, 2026-11-03.')
  // File name and frontmatter name differ, as an old rename left them.
  s.mem('-live', 'oldfile', 'Third copy.', { name: 'oldname' })
  s.mem('-live', 'linker', 'See [[dupe]] and [[oldname]] and [it](oldfile.md).')
  // A same-named memory in another scope must keep its own links.
  s.mem('old', 'dupe', 'Unrelated, lives in old.')
  s.mem('old', 'other', 'Points at [[dupe]].')
  s.index('global', '# Memory Index\n\n- [keep](keep.md) — about keep\n- [dupe](dupe.md) — about dupe\n')
  s.index('-live', '# Memory Index\n\n- [Old label](oldfile.md) — about oldfile\n- [linker](linker.md) — links\n- dupe (global memory) — the dupe\n- keep (global memory) — the keep\n- [[dupe]] mentioned inline\n')
  const corpus = loadCorpus(s.dirs)
  const before = statSync(join(s.at('-live'), 'linker.md')).mtimeMs
  const { ops } = checkPlan({
    ...empty,
    merges: [{ into: 'global/keep', from: ['global/dupe', '-live/oldfile'], description: 'the merged rule', body: 'Original on 2026-11-01, again 2026-11-03.\nWhy: x\nHow to apply: y', reason: 'same rule' }],
  }, corpus, s.activity)
  const res = applyOps(ops, corpus, s.dirs)
  expect(res.applied).toHaveLength(1)
  expect(existsSync(join(s.at('global'), 'dupe.md'))).toBe(false)
  expect(existsSync(join(s.at('-live'), 'oldfile.md'))).toBe(false)
  const kept = s.text('global', 'keep.md')
  expect(kept).toContain('description: the merged rule')
  expect(kept).toContain('modified: 2026-11-01')
  expect(kept).toContain('again 2026-11-03')
  expect(s.text('-live', 'linker.md')).toContain('See [[keep]] and [[keep]] and [it](keep.md).')
  // Repointing a link is not a content change: mtime stays.
  expect(Math.floor(statSync(join(s.at('-live'), 'linker.md')).mtimeMs)).toBe(Math.floor(before))
  expect(s.text('old', 'other.md')).toContain('[[dupe]]')
  expect(s.text('global', 'MEMORY.md')).toBe('# Memory Index\n\n- [keep](keep.md) — the merged rule\n')
  // The bare global line collapses into the existing keep line; the inline link is repointed.
  expect(s.text('-live', 'MEMORY.md')).toBe('# Memory Index\n\n- [linker](linker.md) — links\n- keep (global memory) — the keep\n- [[keep]] mentioned inline\n')
})

test('an op whose memory changed after the plan was made is skipped', () => {
  const s = setup()
  s.mem('-live', 'a', 'Vague.')
  const corpus = loadCorpus(s.dirs)
  s.mem('-live', 'a', 'Edited by tonight\'s consolidation.')
  const { ops } = checkPlan({ ...empty, rewrites: [{ memory: '-live/a', description: 'd', body: 'Sharp.', reason: 'vague' }] }, corpus, s.activity)
  const res = applyOps(ops, corpus, s.dirs)
  expect(res.applied).toHaveLength(0)
  expect(res.skipped[0].why).toContain('changed since the plan')
  expect(s.text('-live', 'a.md')).toContain('Edited by tonight')
})

test('a rewrite keeps the file, its mtime and an unindexed memory unindexed', () => {
  const s = setup()
  s.mem('-live', 'a', 'Vague.')
  s.mem('-live', 'b', 'Also vague.')
  s.index('-live', '# Memory Index\n\n- [Label](a.md) — about a\n')
  utimesSync(join(s.at('-live'), 'a.md'), new Date(1_000_000), new Date(1_000_000))
  const corpus = loadCorpus(s.dirs)
  const { ops } = checkPlan({ ...empty, rewrites: [
    { memory: '-live/a', description: 'run X when Y', body: 'Run X when Y, because Z.', reason: 'vague' },
    { memory: '-live/b', description: 'do B', body: 'Do B.', reason: 'vague' },
  ] }, corpus, s.activity)
  applyOps(ops, corpus, s.dirs)
  expect(s.text('-live', 'a.md')).toContain('Run X when Y, because Z.')
  expect(statSync(join(s.at('-live'), 'a.md')).mtimeMs).toBe(1_000_000)
  expect(s.text('-live', 'MEMORY.md')).toBe('# Memory Index\n\n- [Label](a.md) — run X when Y\n')
})

test('backup archives every memory dir relative to home, never replaces the day, and keeps 14 nights', () => {
  const s = setup()
  s.mem('global', 'g', 'G.')
  s.mem('-live', 'p', 'P.')
  s.index('-live', '# Memory Index\n')
  const out = join(s.home, 'backups')
  const b = backupMemory(s.dirs, s.home, out, '2026-11-12')
  expect(b).toMatchObject({ files: 3, reused: false })
  const listed = Bun.spawnSync(['tar', '-tzf', b.file]).stdout.toString()
  expect(listed).toContain('.claude/memory/global/g.md')
  expect(listed).toContain('.claude/projects/-live/memory/MEMORY.md')
  s.mem('global', 'later', 'L.')
  expect(backupMemory(s.dirs, s.home, out, '2026-11-12')).toMatchObject({ files: 3, reused: true })

  for (let d = 1; d <= 16; d++) {
    const day = `2026-10-${String(d).padStart(2, '0')}`
    writeFileSync(join(out, `memory-${day}.tar.gz`), '')
    writeFileSync(join(out, `review-${day}.md`), '')
  }
  writeFileSync(join(out, 'prune-2026-11-08.md'), 'one-off report')
  expect(pruneBackups(out)).toEqual(['2026-10-03', '2026-10-02', '2026-10-01'])
  const left = readdirSync(out)
  expect(left.filter(f => f.startsWith('memory-'))).toHaveLength(14)
  expect(left).not.toContain('review-2026-10-03.md')
  expect(left).toContain('prune-2026-11-08.md')
})

test('runReview caps the night, backs up first, logs every change, and dry-run writes nothing', async () => {
  const s = setup()
  for (let i = 0; i < MAX_CHANGES + 5; i++) s.mem('-live', `m${i}`, `Vague ${i}.`)
  s.mem('-live', 'gone', 'Nothing durable.')
  s.mem('-live', 'dupe', 'Copy of m0, 2026-11-05.')
  s.index('-live', '# Memory Index\n\n- [m0](m0.md) — about m0\n- [dupe](dupe.md) — about dupe\n')
  const plan: ReviewPlan = {
    merges: [{ into: '-live/m0', from: ['-live/dupe'], description: 'm0 merged', body: 'Do m0, 2026-11-05.', reason: 'same' }],
    removals: [{ memory: '-live/gone', reason: 'no content' }],
    rewrites: Array.from({ length: MAX_CHANGES + 5 }, (_, i) => i).filter(i => i > 0).map(i => ({ memory: `-live/m${i}`, description: `do ${i}`, body: `Do ${i}.`, reason: 'vague' })),
  }
  const backupDir = join(s.home, 'backups')
  const o = { workDir: join(s.home, 'work'), stateFile: join(s.home, 'state.json'), dirs: s.dirs, home: s.home, backupDir, now: new Date(2026, 10, 12, 4), activity: s.activity, plan: async () => plan }

  const dry = await runReview({ ...o, dryRun: true })
  expect(dry).toContain('nothing written')
  expect(dry).toContain('merge -live/dupe → -live/m0')
  expect(existsSync(backupDir)).toBe(false)
  expect(existsSync(o.stateFile)).toBe(false)
  expect(s.text('-live', 'm1.md')).toContain('Vague 1.')

  const out = await runReview(o)
  expect(out).toContain('1 merged')
  expect(out).toContain(`${MAX_CHANGES - 2} rewritten`)
  expect(out).toContain('1 removed')
  expect(out).toContain('6 deferred')
  const tar = Bun.spawnSync(['tar', '-tzf', join(backupDir, 'memory-2026-11-12.tar.gz')]).stdout.toString()
  expect(tar).toContain('-live/memory/gone.md')
  const log = readFileSync(join(backupDir, 'review-2026-11-12.md'), 'utf8')
  expect(log).toContain('# Memory review — 2026-11-12')
  expect(log).toContain('- `-live/dupe` → `-live/m0`: same')
  expect(log).toContain('  - before: about m1\n  - after: do 1')
  expect(log).toContain('    > Nothing durable.')
  expect(log).toContain('6 more change(s) over the nightly cap')
  expect(existsSync(join(s.at('-live'), 'gone.md'))).toBe(false)
  // Deferred memories come back as candidates; ones that had their look do not.
  const state = JSON.parse(readFileSync(o.stateFile, 'utf8')).reviewed
  expect(state['-live/m1']).toBeDefined()
  expect(state[`-live/m${MAX_CHANGES + 4}`]).toBeUndefined()
})

test('runReview applies nothing when the planner fails', async () => {
  const s = setup()
  s.mem('-live', 'a', 'A.')
  const backupDir = join(s.home, 'backups')
  const out = await runReview({ workDir: join(s.home, 'w'), stateFile: join(s.home, 's.json'), dirs: s.dirs, home: s.home, backupDir, plan: async () => 'planner failed: timeout' })
  expect(out).toBe('memory review: planner failed: timeout')
  expect(existsSync(backupDir)).toBe(false)
})

test('parsePlan reads structured output from a single result or the verbose array', () => {
  const plan = { merges: [], rewrites: [], removals: [{ memory: 'global/x', reason: 'r' }] }
  expect(parsePlan(JSON.stringify({ type: 'result', structured_output: plan }))).toEqual(plan)
  expect(parsePlan(JSON.stringify([{ type: 'system' }, { type: 'result', structured_output: plan }]))).toEqual(plan)
  expect(parsePlan(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }))).toContain('error_max_turns')
  expect(parsePlan('not json')).toContain('unreadable')
})
