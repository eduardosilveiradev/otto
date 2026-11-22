import { test, expect } from 'bun:test'
import { staleSweep, stalePrTap, type Pr } from '../stalepr.ts'
import { validateCard } from '../cards.ts'

const NOW = Date.parse('2026-11-15T18:00:00Z')
const old = new Date(NOW - 9 * 86_400_000).toISOString()
const fresh = new Date(NOW - 86_400_000).toISOString()
const pr = (number: number, base: string, head: string, extra: Partial<Pr> = {}): Pr => ({
  number, title: `Change ${number}`, body: '', createdAt: old, baseRefName: base, headRefName: head,
  mergeable: 'MERGEABLE', isCrossRepository: false, ...extra,
})
function gh(prs: () => Pr[], fail?: (cmd: string[]) => boolean) {
  const calls: string[][] = []
  const exec = async (cmd: string[]) => {
    calls.push(cmd)
    if (fail?.(cmd)) throw new Error('not mergeable')
    if (cmd[2] !== 'graphql') return ''
    return JSON.stringify({ data: { viewer: { repositories: { nodes: [
      { name: 'demo', nameWithOwner: 'example/demo', isArchived: false, defaultBranchRef: { name: 'main' }, pullRequests: { nodes: prs() } },
      { name: 'attic', nameWithOwner: 'example/attic', isArchived: true, defaultBranchRef: { name: 'main' }, pullRequests: { nodes: [pr(9, 'main', 'x')] } },
    ] } } } })
  }
  return { exec, calls }
}
const noWait = async () => {}

test('a stack is one chain in merge order with one merge-the-stack button', async () => {
  // Listed out of order; #4 sits on #3, #5 on #4.
  const { exec } = gh(() => [pr(5, 'c', 'd'), pr(3, 'main', 'a'), pr(4, 'a', 'c')])
  const s = (await staleSweep(exec, NOW, noWait))!
  expect(validateCard(s.card).ok).toBe(true)
  const items = (s.card.blocks[0] as { items: { title: string; detail: string }[] }).items
  expect(items.map(i => i.title)).toEqual(['demo#3 Change 3', 'demo#4 Change 4', 'demo#5 Change 5'])
  expect(items[1]!.detail).toBe('9d old · stack 2/3')
  expect(s.buttons).toEqual([{ label: 'merge the stack demo#3..#5', data: 'merge stack demo#3..#5' }])
  expect(s.buttons.every(b => Buffer.byteLength(b.data!) <= 60)).toBe(true)
})

test('fresh PRs and archived repos are left out', async () => {
  const { exec } = gh(() => [pr(1, 'main', 'a', { body: 'Fixes the thing. And more.', title: '' }), pr(2, 'main', 'b', { createdAt: fresh })])
  const s = (await staleSweep(exec, NOW, noWait))!
  const items = (s.card.blocks[0] as { items: { title: string }[] }).items
  expect(items.map(i => i.title)).toEqual(['demo#1 Fixes the thing.'])
  expect(s.buttons.map(b => b.data)).toEqual(['merge PR demo#1', 'close PR demo#1'])
})

test('a conflicting PR shows as conflicting with no merge button', async () => {
  const { exec } = gh(() => [pr(1, 'main', 'a', { mergeable: 'CONFLICTING' })])
  const s = (await staleSweep(exec, NOW, noWait))!
  expect((s.card.blocks[0] as { items: { trailing: string }[] }).items[0]!.trailing).toBe('conflicts')
  expect(s.buttons.map(b => b.data)).toEqual(['close PR demo#1'])
})

test('nothing stale, or GitHub down, means no card', async () => {
  expect(await staleSweep(gh(() => [pr(1, 'main', 'a', { createdAt: fresh })]).exec, NOW, noWait)).toBeNull()
  await expect(staleSweep(async () => '<html>unicorn</html>', NOW, noWait)).rejects.toThrow()
})

test('UNKNOWN mergeability is asked once more before it shows as not checked', async () => {
  const { exec, calls } = gh(() => [pr(1, 'main', 'a', { mergeable: 'UNKNOWN' })])
  const s = (await staleSweep(exec, NOW, noWait))!
  expect(calls.length).toBe(2)
  expect((s.card.blocks[0] as { items: { trailing: string }[] }).items[0]!.trailing).toBe('not checked')
  expect(s.buttons.map(b => b.data)).toEqual(['close PR demo#1'])
})

test('a stack merge retargets each next PR to main, then merges it, in order', async () => {
  const { exec, calls } = gh(() => [pr(5, 'c', 'd'), pr(3, 'main', 'a'), pr(4, 'a', 'c')])
  expect(await stalePrTap(exec, 'merge stack demo#3..#5')).toBe('merged demo #3, #4, #5 into main')
  const R = ['-R', 'example/demo']
  expect(calls.slice(1)).toEqual([
    ['gh', 'pr', 'merge', '3', ...R, '--merge'],
    ['gh', 'pr', 'edit', '4', ...R, '--base', 'main'], ['gh', 'pr', 'merge', '4', ...R, '--merge'],
    ['gh', 'pr', 'edit', '5', ...R, '--base', 'main'], ['gh', 'pr', 'merge', '5', ...R, '--merge'],
  ])
})

test('a failed merge stops the stack, and a retap resumes from what is left', async () => {
  const { exec } = gh(() => [pr(5, 'c', 'd'), pr(3, 'main', 'a'), pr(4, 'a', 'c')], c => c[2] === 'merge' && c[3] === '4')
  expect(await stalePrTap(exec, 'merge stack demo#3..#5')).toBe('merged #3; stopped at demo#4: not mergeable')
  // #3 landed and #4 now targets main.
  const again = gh(() => [pr(5, 'c', 'd'), pr(4, 'main', 'c')])
  expect(await stalePrTap(again.exec, 'merge stack demo#3..#5')).toBe('merged demo #4, #5 into main')
})

test('close, and taps that no longer match what is open', async () => {
  const { exec, calls } = gh(() => [pr(1, 'main', 'a'), pr(3, 'main', 'b', { mergeable: 'CONFLICTING' }), pr(4, 'b', 'c')])
  expect(await stalePrTap(exec, 'close PR demo#1')).toBe('closed demo#1')
  expect(calls.at(-1)).toEqual(['gh', 'pr', 'close', '1', '-R', 'example/demo'])
  expect(await stalePrTap(exec, 'merge stack demo#3..#4')).toBe('demo#3 has conflicts; nothing merged')
  expect(await stalePrTap(exec, 'merge PR demo#4')).toBe('demo#4 is stacked on #3 now; not merging')
  expect(await stalePrTap(exec, 'merge PR demo#7')).toBe('demo#7 is no longer open')
  expect(await stalePrTap(exec, 'backoff abc daily')).toBeNull()
})
