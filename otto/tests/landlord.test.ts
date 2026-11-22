import { test, expect } from 'bun:test'
import { checkLandlord, landlordTap, scan, gitHold, type Deps, type LandlordState } from '../landlord.ts'

const HOME = '/Users/__HOME__'
const NOW = Date.parse('2026-11-08T11:00:00Z')
const DAY = 86_400_000
const OLD = Date.parse('2026-09-03T09:00:00Z')

type Node = { mtime: number; bytes: number; link?: boolean; real?: string }
type Repo = { status?: string; linked?: boolean; unpushed?: number; stashes?: string; branch?: string; broken?: boolean }

/** A fake machine: paths with mtimes and sizes, repos with git answers, simctl JSON. */
function machine(nodes: Record<string, Node>, repos: Record<string, Repo> = {}, sim: { devices?: unknown; runtimes?: unknown } = {}) {
  const calls: string[][] = [], trashed: string[] = [], pruned: string[] = []
  const d: Deps = {
    home: HOME, now: NOW, protect: [`${HOME}/.otto/state`, `${HOME}/.otto/backups`],
    ls: dir => [...new Set(Object.keys(nodes).filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1).split('/')[0]!))],
    touched: p => nodes[p]?.mtime ?? null,
    du: async p => nodes[p]?.bytes ?? null,
    realpath: p => nodes[p]?.real ?? p,
    isLink: p => !!nodes[p]?.link,
    git: (cwd, args) => {
      if (args[0] === 'worktree') { pruned.push(cwd); return '' }
      const r = repos[cwd]
      if (!r || r.broken) return undefined
      const a = args.join(' ')
      if (a === 'status --porcelain') return r.status ?? ''
      if (a === 'rev-parse --absolute-git-dir') return r.linked ? `/repo/.git/worktrees/${cwd.split('/').pop()}` : `${cwd}/.git`
      if (a.endsWith('--git-common-dir')) return r.linked ? '/repo/.git' : `${cwd}/.git`
      if (a.startsWith('rev-list')) return String(r.unpushed ?? 0)
      if (a.startsWith('stash list')) return r.stashes ?? ''
      if (a === 'rev-parse --abbrev-ref HEAD') return r.branch ?? 'main'
      return undefined
    },
    exec: async cmd => {
      calls.push(cmd)
      if (cmd.join(' ') === 'xcrun simctl list devices --json') return JSON.stringify({ devices: sim.devices ?? {} })
      if (cmd.join(' ') === 'xcrun simctl runtime list --json') return JSON.stringify(sim.runtimes ?? {})
      return ''
    },
    trash: p => { if (!nodes[p]) return null; trashed.push(p); delete nodes[p]; return `${HOME}/.Trash/${p.split('/').pop()} x` },
  }
  return { d, nodes, calls, trashed, pruned }
}

const WT = `${HOME}/.t3/worktrees/proj`
const GB = 1e9

test('dirty, unpushed and stashed worktrees and clones are never listed', async () => {
  const { d } = machine({
    [`${WT}/clean`]: { mtime: OLD, bytes: 3 * GB },
    [`${WT}/dirty`]: { mtime: OLD, bytes: 3 * GB },
    [`${WT}/ahead`]: { mtime: OLD, bytes: 3 * GB },
    [`${WT}/stashed`]: { mtime: OLD, bytes: 3 * GB },
    [`${WT}/other-stash`]: { mtime: OLD, bytes: 2 * GB },
    [`${WT}/broken`]: { mtime: OLD, bytes: 3 * GB },
    [`${WT}/fresh`]: { mtime: NOW - 5 * DAY, bytes: 3 * GB },
    [`${HOME}/.otto/build/clone-ok`]: { mtime: OLD, bytes: 2 * GB },
    [`${HOME}/.otto/build/clone-local-branch`]: { mtime: OLD, bytes: 2 * GB },
    [`${HOME}/.otto/build/Otto.app.prev`]: { mtime: OLD, bytes: 2 * GB },   // not a repo: unsure, so kept
  }, {
    [`${WT}/clean`]: { linked: true },
    [`${WT}/dirty`]: { linked: true, status: ' M server.ts\n' },
    [`${WT}/ahead`]: { linked: true, unpushed: 2 },
    [`${WT}/stashed`]: { linked: true, branch: 'otto/x', stashes: 'On otto/x: wip\n' },
    [`${WT}/other-stash`]: { linked: true, branch: 'otto/y', stashes: 'WIP on otto/x: abc msg\n' },
    [`${WT}/broken`]: { broken: true },
    [`${WT}/fresh`]: { linked: true },
    [`${HOME}/.otto/build/clone-ok`]: {},
    [`${HOME}/.otto/build/clone-local-branch`]: { unpushed: 1 },
  })
  const { items, held } = await scan(d)
  expect(items.map(i => i.id).sort()).toEqual([`${HOME}/.otto/build/clone-ok`, `${WT}/clean`, `${WT}/other-stash`])
  expect(held).toBe(6)
})

test('gitHold names the reason', () => {
  const { d } = machine({}, { '/a': { status: '?? new.txt\n' }, '/b': { unpushed: 3 }, '/c': { stashes: 'On main: x' } })
  expect(gitHold('/a', d)).toBe('uncommitted changes')
  expect(gitHold('/b', d)).toBe('unpushed commits')
  expect(gitHold('/c', d)).toBe('a stash')
  expect(gitHold('/missing', d)).toBe('not readable')
})

test('iCloud, symlinks, state and backups are never listed', async () => {
  const C = `${HOME}/Library/Caches`
  const { d } = machine({
    [`${C}/big.app`]: { mtime: OLD, bytes: 2 * GB },
    [`${C}/linked`]: { mtime: OLD, bytes: 2 * GB, link: true },
    [`${C}/into-icloud`]: { mtime: OLD, bytes: 2 * GB, real: `${HOME}/Library/Mobile Documents/x` },
    [`${C}/into-docs`]: { mtime: OLD, bytes: 2 * GB, real: `${HOME}/Documents/Projects/x.nosync` },
    [`${C}/holds-backups`]: { mtime: OLD, bytes: 2 * GB, real: `${HOME}/.otto` },
    [`${C}/small`]: { mtime: OLD, bytes: 50e6 },
  })
  expect((await scan(d)).items.map(i => i.id)).toEqual([`${C}/big.app`])
})

test('the card: total, the month, sizes and ages, unpushed work mentioned', async () => {
  const { d } = machine({
    [`${HOME}/Library/Developer/Xcode/DerivedData/OttoApp-abcdefghijklmnopqrstuvwxyz`]: { mtime: OLD, bytes: 12.4 * GB },
    [`${WT}/done`]: { mtime: Date.parse('2026-08-20T00:00:00Z'), bytes: 1.6 * GB },
    [`${WT}/ahead`]: { mtime: OLD, bytes: 9 * GB },
  }, { [`${WT}/done`]: { linked: true }, [`${WT}/ahead`]: { linked: true, unpushed: 1 } }, {
    devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
      { udid: 'U1', name: 'iPhone 16', state: 'Shutdown', dataPath: `${HOME}/Library/Developer/CoreSimulator/Devices/U1/data`, dataPathSize: 7 * GB, lastUsedAt: '2026-07-01T00:00:00Z' },
      { udid: 'U2', name: 'iPhone 17', state: 'Booted', dataPath: `${HOME}/Library/Developer/CoreSimulator/Devices/U2/data`, dataPathSize: 7 * GB, lastUsedAt: '2026-07-01T00:00:00Z' },
    ] },
    runtimes: {
      R1: { identifier: 'R1', deletable: true, sizeBytes: 8 * GB, lastUsedAt: '2026-11-05T00:00:00Z', runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4', version: '26.4' },
      R2: { identifier: 'R2', deletable: true, sizeBytes: 8 * GB, runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-0', version: '17.0' },   // no lastUsedAt: unknown, kept
    },
  })
  const state: LandlordState = { kept: {} }
  const offer = (await checkLandlord(state, d))!
  expect(offer.card.title).toBe("21 GB you haven't touched since September. Unpushed work left alone.")
  const rows = offer.card.blocks[0]!.items
  expect(rows.map(r => [r.title, r.trailing])).toEqual([
    ['DerivedData OttoApp', '12 GB'],
    ['iPhone 16 (iOS 18.2) simulator', '7.0 GB'],
    ['worktree proj/done', '1.6 GB'],
  ])
  expect(rows[0]!.detail).toBe('Xcode build products, rebuilt on demand; last touched 3 Sep')
  expect(offer.text).toContain('iPhone 16 (iOS 18.2) simulator: 7.0 GB, last touched 1 Jul')
  expect(offer.buttons.map(b => b.label)).toEqual(['evict', 'keep'])
  expect(state.offer!.items).toHaveLength(3)
})

test('evict: re-checks each item, trashes folders, deletes simulators, leaves new work alone', async () => {
  const DD = `${HOME}/Library/Developer/Xcode/DerivedData/App-x`
  const C = `${HOME}/Library/Caches/old`
  const m = machine({
    [DD]: { mtime: OLD, bytes: 5 * GB },
    [C]: { mtime: OLD, bytes: 2 * GB },
    [`${WT}/a`]: { mtime: OLD, bytes: 3 * GB },
    [`${WT}/b`]: { mtime: OLD, bytes: 3 * GB },
  }, { [`${WT}/a`]: { linked: true }, [`${WT}/b`]: { linked: true } }, {
    devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
      { udid: 'U1', name: 'iPhone 16', state: 'Shutdown', dataPath: `${HOME}/Library/Developer/CoreSimulator/Devices/U1/data`, dataPathSize: 7 * GB, lastUsedAt: '2026-07-01T00:00:00Z' },
    ] },
  })
  const state: LandlordState = { kept: {} }
  const offer = (await checkLandlord(state, m.d))!
  // Between the offer and the tap: new commits in one worktree, the cache refilled.
  m.d.git = ((orig) => (cwd: string, args: string[]) => cwd === `${WT}/b` && args[0] === 'rev-list' ? '1' : orig(cwd, args))(m.d.git)
  m.nodes[C]!.mtime = NOW - DAY
  const r = (await landlordTap(state, offer.buttons[0]!.data, m.d))!
  expect(m.trashed.sort()).toEqual([`${WT}/a`, DD])
  expect(m.pruned).toEqual(['/repo/.git'])
  expect(m.calls).toContainEqual(['xcrun', 'simctl', 'delete', 'U1'])
  expect(r.removed.map(x => x.label).sort()).toEqual(['DerivedData App-x', 'iPhone 16 (iOS 18.2) simulator', 'worktree proj/a'])
  expect(r.line).toContain('Freed about 15 GB, folders in the Trash.')
  expect(r.line).toContain('worktree proj/b (unpushed commits)')
  expect(r.line).toContain('cache old (touched since)')
  expect(state.offer).toBeUndefined()
  // A second tap on the same card does nothing.
  expect((await landlordTap(state, offer.buttons[0]!.data, m.d))!.removed).toEqual([])
})

test('keep: each item stays off the card for 90 days', async () => {
  const C = `${HOME}/Library/Caches/old`
  const m = machine({ [C]: { mtime: OLD, bytes: 2 * GB } })
  const state: LandlordState = { kept: {} }
  const offer = (await checkLandlord(state, m.d))!
  expect((await landlordTap(state, offer.buttons[1]!.data, m.d))!.line).toContain('90 days')
  expect(m.trashed).toEqual([])
  expect(await checkLandlord(state, { ...m.d, now: NOW + 30 * DAY })).toBeNull()
  expect(await checkLandlord(state, { ...m.d, now: NOW + 91 * DAY })).not.toBeNull()
  expect(state.kept).toEqual({})
})

test('a stale or foreign tap changes nothing', async () => {
  const m = machine({})
  const state: LandlordState = { kept: {} }
  expect(await landlordTap(state, 'apply updates 12345678', m.d)).toBeNull()
  expect((await landlordTap(state, 'evict landlord 12345678', m.d))!.line).toContain('out of date')
})
