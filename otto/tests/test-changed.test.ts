import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { changedFiles, selectTests } from '../test-changed.ts'

const sources = new Map([
  ['otto/a.ts', '#!/usr/bin/env bun\nexport const a = 1'],
  ['otto/b.ts', 'export { a } from "./a.ts"'],
  ['otto/tests/a.test.ts', 'import { a } from "../a.ts"'],
  ['otto/tests/b.test.ts', 'const b = import("../b")'],
  ['otto/tests/other.test.ts', ''],
])

test('selects direct and transitive importers, changed tests themselves, and nothing for unrelated files', () => {
  expect(selectTests(['otto/a.ts'], sources)).toEqual(['otto/tests/a.test.ts', 'otto/tests/b.test.ts'])
  expect(selectTests(['otto/tests/other.test.ts'], sources)).toEqual(['otto/tests/other.test.ts'])
  expect(selectTests(['README.md'], sources)).toEqual([])
  expect(selectTests([], sources)).toEqual([])
  expect(selectTests(['otto/a.ts'], new Map([...sources].filter(([file]) => file !== 'otto/a.ts')))).toEqual(['otto/tests/a.test.ts', 'otto/tests/b.test.ts'])
})

test('combines branch commits, staged, unstaged and untracked paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'changed-tests-'))
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
    expect(result.exitCode).toBe(0)
  }
  try {
    git('init', '-q')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'you@example.com')
    for (const file of ['branch.ts', 'staged.ts', 'unstaged.ts']) writeFileSync(join(root, file), 'base')
    git('add', '.')
    git('commit', '-qm', 'base')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    writeFileSync(join(root, 'branch.ts'), 'committed')
    git('add', '.')
    git('commit', '-qm', 'branch')
    writeFileSync(join(root, 'staged.ts'), 'staged')
    git('add', '.')
    writeFileSync(join(root, 'unstaged.ts'), 'unstaged')
    writeFileSync(join(root, 'new test.ts'), 'new')
    expect(changedFiles(root).sort()).toEqual(['branch.ts', 'new test.ts', 'staged.ts', 'unstaged.ts'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
