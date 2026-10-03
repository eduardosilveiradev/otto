import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkDocs, instructionsOverBudget, instructionsText, INSTRUCTIONS_MAX } from '../docdrift.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-drift-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

/** A tiny repo: one tool, one state file, one skill, one env var. */
function repo(doc: string, extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmp, 'r-'))
  const files: Record<string, string> = {
    'CLAUDE.md': doc,
    'otto/server.ts': "const F = 'notes.json'\nconst t = 'set_thing'\nconst e = process.env.OTTO_THING\nconst d = 'forge'\n",
    'otto/skills/status/SKILL.md': '---\nname: status\n---\nbody',
    'otto/helper.ts': '// helper',
    ...extra,
  }
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true })
    writeFileSync(join(root, p), c)
  }
  return root
}

test('a doc that only names things that exist is clean', () => {
  const root = repo('Use `set_thing` and `/otto:status`; state in `notes.json`, `forge/`; see `otto/helper.ts` and [it](otto/helper.ts). Env `OTTO_THING`.')
  expect(checkDocs(root)).toEqual([])
})

test('a removed tool is named', () => {
  const f = checkDocs(repo('Call `drop_thing` first.'))
  expect(f).toHaveLength(1)
  expect(f[0]).toMatchObject({ kind: 'tool', token: 'drop_thing', doc: 'CLAUDE.md', line: 1 })
})

test('a command with no skill is named', () => {
  const f = checkDocs(repo('Run `/otto:gone`.'))
  expect(f[0]).toMatchObject({ kind: 'command', token: '/otto:gone' })
})

test('a state file or dir nothing refers to is named, machine-local paths are not', () => {
  const f = checkDocs(repo('State: `~/.otto/state/ghost.json`, `phantom/`, and `~/.claude/settings.json` (not ours).'))
  expect(f.map(x => x.token).sort()).toEqual(['ghost.json', 'phantom/'])
})

test('a dead path or link is named; a bare file name found anywhere resolves', () => {
  const f = checkDocs(repo('See `otto/missing.ts`, [x](otto/nope.md) and `helper.ts`.'))
  expect(f.map(x => x.token).sort()).toEqual(['otto/missing.ts', 'otto/nope.md'])
})

test('an env var no code reads is named', () => {
  const f = checkDocs(repo('Set `OTTO_NOPE`.'))
  expect(f[0]).toMatchObject({ kind: 'env', token: 'OTTO_NOPE' })
})

test('code fences are not scanned', () => {
  expect(checkDocs(repo('```\n`drop_thing` /otto:gone\n```\n'))).toEqual([])
})

test('the plugin instructions block is scanned like any doc', () => {
  const root = repo('ok', {
    'otto/server.ts': "const x = 1\ninstructions: [\n  'Use `ghost_tool` now.',\n  'and `set_thing`',\n].join('\\n')\nconst t = 'set_thing'\n",
  })
  const f = checkDocs(root)
  expect(f).toHaveLength(1)
  expect(f[0]).toMatchObject({ token: 'ghost_tool', doc: 'otto/server.ts (instructions)' })
})


// The real thing. This is the one CI cares about.
const REAL = join(import.meta.dir, '..', '..')

test('the real docs name nothing the code no longer has', () => {
  const found = checkDocs(REAL)
  expect(found.map(f => `${f.doc}:${f.line} ${f.message}`)).toEqual([])
})

test('the real plugin instructions stay under their cap', () => {
  expect(instructionsText(REAL)!.length).toBeGreaterThan(500)
  expect(instructionsOverBudget(REAL)).toBeNull()
  expect(instructionsText(REAL)!.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX)
})

test('the repo carries no personal identifiers in the files this feature added', () => {
  const { readFileSync } = require('fs')
  const files = ['heartbeat.ts', 'deadman.ts', 'status.ts', 'docdrift.ts', 'skills/status/SKILL.md']
  for (const f of files) {
    const text = readFileSync(join(import.meta.dir, '..', f), 'utf8')
    expect(text).not.toMatch(/\/Users\/[A-Za-z]/)
    expect(text).not.toMatch(/@(gmail|icloud|outlook)\.com/)
  }
})
