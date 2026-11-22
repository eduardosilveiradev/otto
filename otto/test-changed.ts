import { readFileSync } from 'fs'
import { posix } from 'path'

const isTest = (file: string) => /[._](test|spec)\.[cm]?[jt]sx?$/.test(file)
const ts = new Bun.Transpiler({ loader: 'ts' })
const tsx = new Bun.Transpiler({ loader: 'tsx' })

// shortcut: computed imports and subprocess entry points need the full pre-PR suite; add edges if fast-lane coverage needs them.
/** Follow relative imports, including shared helpers, back to the tests that use them. */
export function selectTests(changed: string[], sources: Map<string, string>): string[] {
  const affected = new Set(changed)
  const imports = new Map<string, string[]>()
  for (const [file, source] of sources) {
    imports.set(file, (file.endsWith('x') ? tsx : ts).scanImports(source.replace(/^#![^\n]*/, '')).flatMap(({ path }) => {
      if (!path.startsWith('.')) return []
      const base = posix.normalize(posix.join(posix.dirname(file), path))
      const resolved = [base, ...['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'].map(ext => base + ext)]
        .find(candidate => sources.has(candidate) || affected.has(candidate))
      return resolved ? [resolved] : []
    }))
  }
  let grew = true
  while (grew) {
    grew = false
    for (const [file, deps] of imports) {
      if (!affected.has(file) && deps.some(dep => affected.has(dep))) { affected.add(file); grew = true }
    }
  }
  return [...sources.keys()].filter(file => isTest(file) && affected.has(file)).sort()
}

export function changedFiles(root: string): string[] {
  return [...new Set([
    ...git(root, ['diff', '--name-only', '-z', 'origin/main...HEAD']),
    ...git(root, ['diff', '--name-only', '-z', 'HEAD']),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])]
}

function git(root: string, args: string[]): string[] {
  const result = Bun.spawnSync(['git', ...args], { cwd: root })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim())
  return result.stdout.toString().split('\0').filter(Boolean)
}

if (import.meta.main) {
  const root = posix.dirname(import.meta.dir)
  const files = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'otto'])
  const sources = new Map<string, string>()
  for (const file of new Set(files.filter(file => /\.[cm]?[jt]sx?$/.test(file)))) {
    try { sources.set(file, readFileSync(posix.join(root, file), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const tests = selectTests(changedFiles(root), sources)
  console.log(tests.length ? `Changed tests:\n${tests.join('\n')}` : 'No changed tests.')
  let code = 0
  // An empty `bun test` would accidentally run the entire suite.
  if (tests.length) code = await Bun.spawn(['bun', 'test', ...tests.map(file => './' + file)], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] }).exited
  const docs = await Bun.spawn(['bun', 'otto/docdrift.ts'], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] }).exited
  process.exit(code || docs)
}
