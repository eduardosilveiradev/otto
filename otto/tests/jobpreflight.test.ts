import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { preflight, inICloud, CodeJobs, loadCodeJobs, type Exec, type T3 } from '../codejobs.ts'

const URL = 'git@github.com:example/demo.git'
/** A home with an iCloud Documents folder and a plain one, on disk so realpath works. */
function home() {
  const h = realpathSync(mkdtempSync(join(tmpdir(), 'otto-preflight-')))
  for (const d of ['Documents/demo/.git', 'Documents/demo.nosync/.git', 'code/demo/.git']) mkdirSync(join(h, d), { recursive: true })
  return h
}
/** git, stubbed: `fail` names the subcommands (or rev-parse refs) that exit non-zero. */
function git(fail: string[] = []) {
  const calls: [string[], string | undefined][] = []
  const exec: Exec = async (cmd, cwd) => {
    calls.push([cmd, cwd])
    if (fail.includes(cmd[1]!) || fail.includes(cmd.at(-1)!)) return undefined
    if (cmd[1] === 'remote') return URL
    return ''
  }
  return { exec, calls, ran: () => calls.map(([c, cwd]) => `${c.slice(1, 3).join(' ')} @ ${cwd ?? '-'}`) }
}

test('inICloud: Documents, Desktop and iCloud Drive count; .nosync and elsewhere do not', () => {
  const h = home()
  expect(inICloud(join(h, 'Documents/demo'), h)).toBe(true)
  expect(inICloud(join(h, 'Library/Mobile Documents/com~apple~CloudDocs/x'), h)).toBe(true)
  expect(inICloud(join(h, 'Documents/demo.nosync'), h)).toBe(false)
  expect(inICloud(join(h, 'code/demo'), h)).toBe(false)
  expect(inICloud(join(h, 'Documents-old/demo'), h)).toBe(false)
})

test('a healthy checkout passes untouched', async () => {
  const h = home(), root = join(h, 'code/demo'), g = git()
  expect(await preflight(root, 'main', g.exec, h)).toBe(root)
  expect(g.ran()).toEqual([`remote get-url @ ${root}`, `fetch --quiet @ ${root}`, `rev-parse --verify @ ${root}`])
  // A local-only repo (no origin) isn't fetched, as T3 doesn't fetch it either.
  const local = git(['remote'])
  expect(await preflight(root, 'main', local.exec, h)).toBe(root)
  expect(local.ran()).toEqual([`remote get-url @ ${root}`, `rev-parse --verify @ ${root}`])
})

test('an iCloud checkout is swapped for a clone outside it, cloned once then fetched', async () => {
  const h = home(), root = join(h, 'Documents/demo'), clone = join(h, '.otto/build/demo-clone')
  const g = git()
  expect(await preflight(root, 'main', g.exec, h)).toBe(clone)
  expect(g.calls.find(([c]) => c[1] === 'clone')![0]).toEqual(['git', 'clone', '--quiet', URL, clone])
  expect(g.calls.some(([c, cwd]) => c[1] === 'fetch' && cwd === root)).toBe(false) // git never writes in iCloud

  mkdirSync(join(clone, '.git'), { recursive: true })
  const again = git()
  expect(await preflight(root, 'main', again.exec, h)).toBe(clone)
  expect(again.ran()).toEqual([`remote get-url @ ${root}`, `remote get-url @ ${clone}`, `fetch --quiet @ ${clone}`, `rev-parse --verify @ ${clone}`])
})

test('fetch that fails or times out is refused in one line', async () => {
  const h = home()
  await expect(preflight(join(h, 'code/demo'), 'main', git(['fetch']).exec, h)).rejects.toThrow(/^git fetch in .*code\/demo failed or took over 30s$/)
  await expect(preflight(join(h, 'Documents/demo'), 'main', git(['clone']).exec, h)).rejects.toThrow('is in iCloud and cloning')
})

test('a base branch missing from origin is refused by name; a local base is still fine', async () => {
  const h = home(), root = join(h, 'code/demo')
  await expect(preflight(root, 'release', git(['refs/remotes/origin/release', 'release^{commit}']).exec, h)).rejects.toThrow('base branch "release" isn\'t in')
  expect(await preflight(root, 'release', git(['refs/remotes/origin/release']).exec, h)).toBe(root)
})

test('launch repoints an iCloud project before T3 starts, and a refusal never reaches T3', async () => {
  const h = home(), root = join(h, 'Documents/demo')
  const repointed: [string, string][] = [], launched: string[] = []
  const t3 = {
    projects: async () => [{ id: 'p1', name: 'demo', root }],
    threads: async () => new Map(),
    launch: async (o: { branch: string }) => { launched.push(o.branch); return { threadId: 't1', branch: o.branch } },
    repoint: async (id: string, dir: string) => { repointed.push([id, dir]) },
    send: async () => {}, answer: async () => false, interrupt: async () => {},
  } as unknown as T3
  const file = join(mkdtempSync(join(tmpdir(), 'otto-preflight-jobs-')), 'code-jobs.json')
  await new CodeJobs({ file, t3, exec: git().exec, home: h }).start({ project: 'demo', title: 'A', brief: 'b', branch: 'feat/a', model: 'gpt-6.1-sol' })
  expect(repointed).toEqual([['p1', join(h, '.otto/build/demo-clone')]])
  expect(launched).toEqual(['feat/a'])
  expect(loadCodeJobs(file)[0]!.steps.map(s => s.text)).toEqual(['Handed off to T3 Code', 'Moved the project out of iCloud', 'Created worktree'])

  await expect(new CodeJobs({ file, t3, exec: git(['fetch']).exec, home: h }).start({ project: 'demo', title: 'B', brief: 'b', branch: 'feat/b', model: 'gpt-6.1-sol' })).rejects.toThrow('git fetch')
  expect(launched).toEqual(['feat/a'])
  expect(loadCodeJobs(file).find(j => j.branch === 'feat/b')!.launchError).toContain('git fetch')
})

test('OTTO_T3_HOST: git in a T3 folder goes over ssh with -C and quoted arguments', async () => {
  const calls: [string[], string | undefined][] = []
  const exec: Exec = async (cmd, cwd) => { calls.push([cmd, cwd]); return cmd.at(-1)!.includes('get-url') ? URL : '' }
  const { overSsh } = await import('../codejobs.ts')
  const root = "__HOME__/code/it's demo"
  expect(await preflight(root, 'main', overSsh(exec, 'mac.example'), '__HOME__', true)).toBe(root)
  const q = `'__HOME__/code/it'\\''s demo'`
  expect(calls).toEqual([
    [['ssh', '-o', 'BatchMode=yes', 'mac.example', '--', `'git' '-C' ${q} 'remote' 'get-url' 'origin'`], undefined],
    [['ssh', '-o', 'BatchMode=yes', 'mac.example', '--', `'git' '-C' ${q} 'fetch' '--quiet' 'origin'`], undefined],
    [['ssh', '-o', 'BatchMode=yes', 'mac.example', '--', `'git' '-C' ${q} 'rev-parse' '--verify' '--quiet' 'refs/remotes/origin/main'`], undefined],
  ])
})

test('OTTO_T3_HOST: an iCloud checkout is cloned under the remote home, checked with test -e', async () => {
  const calls: string[] = []
  const exec: Exec = async cmd => { calls.push(cmd.at(-1)!); return cmd.at(-1)!.startsWith("'test'") ? undefined : URL }
  const { overSsh } = await import('../codejobs.ts')
  const dir = await preflight('/remote/home/Documents/demo', 'main', overSsh(exec, 'mac.example'), '/remote/home', true)
  expect(dir).toBe('/remote/home/.otto/build/demo-clone')
  expect(calls[1]).toBe(`'test' '-e' '/remote/home/.otto/build/demo-clone/.git'`)
  expect(calls[2]).toBe(`'git' 'clone' '--quiet' '${URL}' '/remote/home/.otto/build/demo-clone'`)
})

test('CodeJobs: t3Host sends every T3-folder git call through ssh; unset, git runs here with a cwd', async () => {
  const t3 = {
    projects: async () => [{ id: 'p1', name: 'demo', root: '/remote/home/code/demo' }],
    threads: async () => new Map(),
    launch: async (o: { branch: string }) => ({ threadId: 't1', branch: o.branch }),
    send: async () => {}, answer: async () => false, interrupt: async () => {},
  } as unknown as T3
  const run = async (t3Host?: string) => {
    const calls: [string[], string | undefined][] = []
    const exec: Exec = async (cmd, cwd) => {
      calls.push([cmd, cwd])
      const s = cmd.join(' ')
      return s.includes('printenv') ? '/remote/home' : s.includes('remote') ? URL : s.includes("'test'") ? undefined : ''
    }
    const file = join(mkdtempSync(join(tmpdir(), 'otto-preflight-ssh-')), 'code-jobs.json')
    await new CodeJobs({ file, t3, exec, t3Host }).start({ project: 'demo', title: 'A', brief: 'b', branch: 'feat/a', model: 'gpt-6.1-sol' })
    return calls.filter(([c]) => c[0] === 'ssh' || c[0] === 'git')
  }
  const remote = await run('mac.example')
  expect(remote.length).toBeGreaterThan(0)
  expect(remote.every(([c, cwd]) => c.slice(0, 5).join(' ') === 'ssh -o BatchMode=yes mac.example --' && cwd === undefined)).toBe(true)
  expect(remote.map(([c]) => c[5])).toContain(`'printenv' 'HOME'`)
  const local = await run()
  expect(local.every(([c, cwd]) => c[0] === 'git' && (cwd === '/remote/home/code/demo' || c[1] === 'clone'))).toBe(true)
  expect(local[0]![0]).toEqual(['git', 'remote', 'get-url', 'origin'])
})
