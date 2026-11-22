import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFileSync } from 'fs'
import {
  DAY, NEVER_SWEPT, parseImports, toolBlocks, toolSpans, boundModules, findCandidates, pruneServer, cliModules,
  loadUsage, saveUsage, recordUse, activeDays, docMentions, parseDocEdits, applyDocEdits, formatSweepOffer,
  sweepSummary, sweepConfig, parseShortstat, loadSweepState, saveSweepState, SERVER_FILES, type ToolUsage, type SweepRecord,
} from '../deadsweep.ts'

const dir = mkdtempSync(join(tmpdir(), 'otto-sweep-'))
afterAll(() => { try { rmSync(dir, { recursive: true }) } catch {} })

const MINI_SERVER = [
  "import { x } from 'grammy'",
  'import {',
  '  alphaFn,',
  '  type AlphaT,',
  "} from './alpha.ts'",
  "import { gammaFn } from './gamma.ts'",
  '',
  'const boot = 1',
  "import { betaFn as bf } from './beta.ts'",
  '',
  'mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))',
  '',
  'export async function callTool(name: string, args: Args) {',
  '  switch (name) {',
  "    case 'alpha_tool': {",
  '      const t: AlphaT = alphaFn()',
  '      switch (t.kind) {',
  "        case 'nested': {",
  '          return t',
  '        }',
  '        default:',
  '          return t',
  '      }',
  '    }',
  '',
  '    // ── Another family ──',
  "    case 'beta_tool': {",
  '      return bf(gammaFn())',
  '    }',
  '',
  '    default:',
  '      return null',
  '  }',
  '}',
  '',
  'function tick() { return gammaFn() }',
  '',
].join('\n')

const MINI_TOOLS = [
  "import { alphaFn } from './alpha.ts'",
  "import { betaFn as bf } from './beta.ts'",
  '',
  'export const TOOLS: Tool[] = [',
  '  {',
  "    name: 'alpha_tool',",
  '    description: alphaFn(),',
  '  },',
  '  {',
  "    name: 'beta_tool',",
  '    description: bf(),',
  '  },',
  ']',
  '',
].join('\n')

/** What the sweep analyses: the server files joined, as chores.ts reads them. */
const MINI = MINI_SERVER + '\n' + MINI_TOOLS

const lineOf = (src: string, needle: string) => src.split('\n').findIndex(l => l.includes(needle))

test('parseImports finds multi-line, aliased and mid-file imports and ignores packages', () => {
  const imp = parseImports(MINI_SERVER)
  expect(imp.get('alpha')).toEqual({ names: ['alphaFn', 'AlphaT'], lines: [1, 2, 3, 4] })
  expect(imp.get('beta')!.names).toEqual(['bf'])
  expect(imp.get('beta')!.lines).toEqual([lineOf(MINI_SERVER, "from './beta.ts'")])
  expect(imp.has('grammy')).toBe(false)
  expect([...imp.keys()].sort()).toEqual(['alpha', 'beta', 'gamma'])
})

test('toolSpans cover the definition block and the case block', () => {
  const lines = toolSpans(MINI).get('alpha_tool')!
  const defStart = lineOf(MINI, "name: 'alpha_tool'") - 1
  expect(MINI.split('\n')[defStart]).toBe('  {')
  expect(lines).toContain(defStart)
  expect(lines).toContain(defStart + 3)   // the `  },`
  const caseAt = lineOf(MINI, "case 'alpha_tool'")
  const betaCase = lineOf(MINI, "case 'beta_tool'")
  for (let i = caseAt; i < betaCase - 2; i++) expect(lines).toContain(i)
  expect(lines).not.toContain(betaCase - 1)   // a family heading between cases goes with neither
  expect(lines).not.toContain(betaCase)
  const beta = toolSpans(MINI).get('beta_tool')!
  expect(beta).not.toContain(lineOf(MINI, '    default:'))
  expect(beta).toContain(lineOf(MINI, 'return bf(gammaFn())'))
})

test('boundModules keeps tool-only modules and drops one used at top level', () => {
  const b = boundModules(MINI)
  expect(b.get('alpha')).toEqual(['alpha_tool'])
  expect(b.get('beta')).toEqual(['beta_tool'])
  expect(b.has('gamma')).toBe(false)
})

test('real tree: every tool has exactly one definition and one case block', () => {
  const src = SERVER_FILES.map(f => readFileSync(join(import.meta.dir, '..', f), 'utf8')).join('\n')
  const blocks = toolBlocks(src)
  const defs = blocks.filter(b => b.kind === 'def'), cases = blocks.filter(b => b.kind === 'case')
  expect(defs.length).toBeGreaterThan(20)
  expect(defs.length).toBe(cases.length)
  const names = new Set(defs.map(b => b.tool))
  expect(names.size).toBe(defs.length)
  for (const n of names) expect(cases.filter(b => b.tool === n).length).toBe(1)
  expect(boundModules(src).size).toBeGreaterThan(0)
  const old: ToolUsage = { since: new Date(Date.now() - 400 * DAY).toISOString(), uses: {} }
  const swept = findCandidates({ src, files: {}, externallyReferenced: new Set(), usage: old, triggerTexts: [], kept: [], now: Date.now(), idleDays: 60 })
  for (const c of swept) for (const t of c.tools) expect(NEVER_SWEPT).not.toContain(t)
})

const NOW = Date.UTC(2026, 5, 1)
const usage = (over: Partial<ToolUsage['uses']> = {}, ago = 90): ToolUsage => ({ since: new Date(NOW - ago * DAY).toISOString(), uses: over as ToolUsage['uses'] })
const find = (o: Partial<Parameters<typeof findCandidates>[0]> = {}) =>
  findCandidates({ src: MINI, files: {}, externallyReferenced: new Set(), usage: usage(), triggerTexts: [], kept: [], now: NOW, idleDays: 60, ...o })

test('findCandidates proposes an unused tool-bound module', () => {
  expect(find()).toEqual([
    { module: 'alpha', tools: ['alpha_tool'], idleDays: 90 },
    { module: 'beta', tools: ['beta_tool'], idleDays: 90 },
  ])
})

test('every kind of evidence of life keeps a module off the list', () => {
  const alphaOnly = (r: ReturnType<typeof find>) => r.map(c => c.module)
  const recent = { count: 1, lastAt: new Date(NOW - 5 * DAY).toISOString() }
  expect(alphaOnly(find({ usage: usage({}, 30) }))).toEqual([])
  expect(alphaOnly(find({ usage: usage({ alpha_tool: recent }) }))).toEqual(['beta'])
  expect(alphaOnly(find({ usage: usage({ 'cli:alpha': recent }) }))).toEqual(['beta'])
  expect(alphaOnly(find({ triggerTexts: ['call alpha_tool weekly'] }))).toEqual(['beta'])
  expect(alphaOnly(find({ triggerTexts: ['run otto/alpha.ts nightly'] }))).toEqual(['beta'])
  expect(alphaOnly(find({ kept: ['alpha'] }))).toEqual(['beta'])
  expect(alphaOnly(find({ externallyReferenced: new Set(['alpha']) }))).toEqual(['beta'])
  expect(alphaOnly(find({ files: { 'otto/other.ts': "import { alphaFn } from './alpha.ts'" } }))).toEqual(['beta'])
  expect(alphaOnly(find({ files: { 'otto/tests/x.test.ts': "import { alphaFn } from '../alpha.ts'" } }))).toEqual(['beta'])
  expect(alphaOnly(find({ files: { 'otto/other.ts': "const a = await import('./alpha.ts')" } }))).toEqual(['beta'])
  // its own test does not count as another user
  expect(alphaOnly(find({ files: { 'otto/tests/alpha.test.ts': "import { alphaFn } from '../alpha.ts'" } }))).toEqual(['alpha', 'beta'])
})

test('a guarded module is never a candidate', () => {
  const src = MINI.replaceAll('alpha', 'forge')
  expect(find({ src }).map(c => c.module)).toEqual(['beta'])
})

test('a tool shared with a kept module stays, and so does every module bound to it', () => {
  const src = MINI
    .replace("import { gammaFn } from './gamma.ts'", "import { gammaFn } from './gamma.ts'\nimport { deltaFn } from './delta.ts'")
    .replace('        return t\n', '        return deltaFn(t)\n')
  expect(boundModules(src).get('delta')).toEqual(['alpha_tool'])
  expect(find({ src }).map(c => c.module).sort()).toEqual(['alpha', 'beta', 'delta'])
  expect(find({ src, kept: ['delta'] }).map(c => c.module)).toEqual(['beta'])
  expect(find({ src, kept: ['alpha'] }).map(c => c.module)).toEqual(['beta'])
})

test('pruneServer removes the imports and both blocks from whichever file holds them, nothing else', () => {
  const OTHER = "import { alphaFn } from './alpha.ts'\nexport const unrelated = 1\n"
  const files = { 'toolcalls.ts': MINI_SERVER, 'tools.ts': MINI_TOOLS, 'chores.ts': OTHER }
  const pruned = pruneServer(files, ['alpha'], ['alpha_tool'])
  expect(pruned['tools.ts']).not.toContain('alpha')
  expect(pruned['chores.ts']).toBe('export const unrelated = 1\n')
  const out = Object.values(pruned).join('\n')
  expect(out).not.toContain('alpha')
  expect(out).not.toContain('AlphaT')
  for (const keep of ["import { gammaFn } from './gamma.ts'", "import { betaFn as bf } from './beta.ts'", "name: 'beta_tool'", 'return bf(gammaFn())', 'function tick()', '    default:']) {
    expect(out).toContain(keep)
  }
  expect(() => pruneServer(files, ['alpha'], ['nope_tool'])).toThrow('no definition/case')
  const leaky = { ...files, 'chores.ts': 'export function tick() { return alphaFn() }\n' }
  expect(() => pruneServer(leaky, ['alpha'], ['alpha_tool'])).toThrow('still referenced')
})

test('cliModules reads module runs out of a shell command', () => {
  expect(cliModules('cd x && bun otto/packages.ts parse --source email:1')).toEqual(['packages'])
  expect(cliModules('bun /abs/otto/backup.ts restore a b')).toEqual(['backup'])
  expect(cliModules('echo otto')).toEqual([])
})

test('usage round-trips through statefile; a missing file starts counting now; a corrupt one is moved aside', () => {
  const f = join(dir, 'usage.json')
  const fresh = loadUsage(f, NOW)
  expect(fresh.since).toBe(new Date(NOW).toISOString())
  recordUse(fresh, 'recall', NOW + 1000); recordUse(fresh, 'recall', NOW + 2000)
  saveUsage(f, fresh)
  const back = loadUsage(f, 0)
  expect(back.uses.recall.count).toBe(2)
  expect(back.uses.recall.lastAt).toBe(new Date(NOW + 2000).toISOString())
  writeFileSync(f, '{nope')
  expect(loadUsage(f, NOW).uses).toEqual({})
  expect(readdirSync(dir).some(n => n.startsWith('usage.json.corrupt-'))).toBe(true)
})

test('activeDays counts distinct days of inbound messages only, from sinceMs', () => {
  const at = (d: number, h: number) => new Date(2026, 4, d, h).toISOString()
  const entries = [
    { ts: at(1, 10), dir: 'in' }, { ts: at(1, 15), dir: 'in' }, { ts: at(2, 9), dir: 'in' },
    { ts: at(3, 9), dir: 'out' }, { ts: at(2, 12), dir: 'out' },
  ]
  expect(activeDays(entries, 0)).toBe(2)
  expect(activeDays(entries, new Date(2026, 4, 2).getTime())).toBe(1)
})

test('docMentions flags backticked tools and module paths, skips fences', () => {
  const text = ['use `alpha_tool` here', 'see [x](otto/alpha.ts)', '```', '`alpha_tool` in code', '```', 'plain alpha_tool', 'other `beta_tool`'].join('\n')
  const f = docMentions([{ doc: 'CLAUDE.md', text }], ['alpha_tool'], ['alpha'])
  expect(f.map(x => [x.line, x.kind])).toEqual([[1, 'tool'], [2, 'path']])
  expect(docMentions([{ doc: 'a', text: 'x' }], [], [])).toEqual([])
})

test('doc edits: parse a fenced array, apply only flagged lines, deletions do not shift others', () => {
  expect(parseDocEdits('```json\n[{"doc":"a.md","line":2,"text":"hi"}]\n```')).toEqual([{ doc: 'a.md', line: 2, text: 'hi' }])
  expect(parseDocEdits('I could not do that [sorry]')).toEqual([])
  expect(parseDocEdits('[{"doc":"a.md","line":"2","text":"x"}]')).toEqual([])
  const files = { 'a.md': 'one\ntwo\nthree\nfour', 'otto/server.ts (instructions)': 'x\ny' }
  const flagged = [
    { doc: 'a.md', line: 2, kind: 'tool' as const, token: 't', message: '' },
    { doc: 'a.md', line: 3, kind: 'tool' as const, token: 't', message: '' },
    { doc: 'otto/server.ts (instructions)', line: 1, kind: 'tool' as const, token: 't', message: '' },
  ]
  const r = applyDocEdits(files, flagged, [
    { doc: 'a.md', line: 2, text: '' },
    { doc: 'a.md', line: 3, text: 'THREE' },
    { doc: 'a.md', line: 4, text: 'unflagged' },
    { doc: 'otto/server.ts (instructions)', line: 1, text: 'z' },
  ])
  expect(r.files['a.md']).toBe('one\nTHREE\nfour')
  expect(r.files['otto/server.ts (instructions)']).toBe('x\ny')
  expect([r.applied, r.rejected]).toEqual([2, 2])
})

const rec = (modules: SweepRecord['modules'], removed: number): SweepRecord => ({
  id: 'abcd1234', branch: 'otto/sweep-abcd1234', at: '', modules, removed, added: 0, docLines: 3, selfTest: 'loaded clean', status: 'offered',
})

test('the offer reads plainly, names no tool, and its buttons fit', () => {
  const two = rec([{ module: 'alpha', tools: ['alpha_tool'], idleDays: 74 }, { module: 'beta', tools: ['beta_tool'], idleDays: 90 }], 612)
  const o = formatSweepOffer(two)
  expect(o.text).toBe("two modules haven't been used in 74 days: alpha, beta. a branch without them drops 612 lines and passes its self-test.")
  const one = formatSweepOffer(rec([two.modules[0]], 5)).text
  expect(one).toContain("one module hasn't been used")
  expect(one).toContain('without it drops')
  for (const b of o.buttons) expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(60)
  expect(o.text).not.toContain('self_test')
  const s = sweepSummary(two)
  expect(s).not.toContain('self_test')
  expect(s.length).toBeLessThanOrEqual(1500)
  expect(s).toContain('- alpha (tool alpha_tool): unused 74 days')
  expect(formatSweepOffer(rec(Array.from({ length: 12 }, (_, i) => ({ module: `m${i}`, tools: ['t'], idleDays: 61 })), 9)).text).toMatch(/^12 modules/)
})

test('config and shortstat parsing', () => {
  expect(sweepConfig({})).toEqual({ idleDays: 60 })
  expect(sweepConfig(undefined)).toEqual({ idleDays: 60 })
  expect(sweepConfig({ idleDays: 0 })).toEqual({ idleDays: 0 })
  expect(sweepConfig({ idleDays: 'x' })).toEqual({ idleDays: 60 })
  expect(sweepConfig({ idleDays: 30 })).toEqual({ idleDays: 30 })
  expect(parseShortstat(' 5 files changed, 3 insertions(+), 612 deletions(-)')).toEqual({ removed: 612, added: 3 })
  expect(parseShortstat(' 1 file changed, 4 deletions(-)')).toEqual({ removed: 4, added: 0 })
})

test('sweep state keeps the newest twelve', () => {
  const f = join(dir, 'sweep.json')
  const s = loadSweepState(f)
  for (let i = 0; i < 15; i++) s.sweeps.push({ ...rec([], 0), id: String(i) })
  saveSweepState(f, s)
  expect(loadSweepState(f).sweeps.map(x => x.id)[0]).toBe('3')
  expect(loadSweepState(f).sweeps.length).toBe(12)
})
