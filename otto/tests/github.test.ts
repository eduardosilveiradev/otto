import { test, expect, spyOn } from 'bun:test'
import { Github, CALL_CAP } from '../github.ts'
import { CommandError } from '../workspace.ts'

test('unreachable skips all readers and runs at most twelve coalesced probes per hour', async () => {
  let now = 0, up = false
  const calls: string[][] = []
  const github = new Github(async cmd => {
    calls.push(cmd)
    if (!up) throw new CommandError('error connecting to api.github.com', 1)
    return '[]'
  }, () => now)
  await expect(github.run(['gh', 'pr', 'list'])).rejects.toThrow()
  for (; now < 3_600_000; now += 20_000) {
    await Promise.allSettled(Array.from({ length: 10 }, (_, i) => github.run(['gh', i % 2 ? 'pr' : 'api', 'view'])))
  }
  expect(calls.filter(c => c[2] === 'rate_limit')).toHaveLength(12)
  expect(calls.filter(c => c[2] !== 'rate_limit')).toHaveLength(1)
  up = true
  expect(await github.run(['gh', 'pr', 'list'])).toBe('[]')
  expect(github.status.reachable).toBe(true)
})

test('shared budget counts concurrent calls and probes, logs once, and clears after ten minutes', async () => {
  let now = 0
  const counted: number[][] = []
  const calls: string[][] = []
  const log = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const github = new Github(async cmd => { calls.push(cmd); return '[]' }, () => now, c => counted.push(c))
    await Promise.allSettled(Array.from({ length: CALL_CAP + 20 }, (_, i) => github.run(['gh', ['pr', 'api', 'search'][i % 3]!, 'list'])))
    expect(calls).toHaveLength(CALL_CAP)
    expect(counted.at(-1)).toHaveLength(CALL_CAP)
    expect(log).toHaveBeenCalledTimes(1)
    now = 600_000
    await github.run(['gh', 'pr', 'list'])
    expect(calls).toHaveLength(CALL_CAP + 1)
    now = 3_600_000
    await github.run(['gh', 'pr', 'list'])
    expect(counted.at(-1)).toEqual([600_000, 3_600_000])
  } finally { log.mockRestore() }
})
