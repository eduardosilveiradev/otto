import { test, expect } from 'bun:test'
import { PrDetails, patchFile } from '../prdetail.ts'
import { saveCodeJobs, type Exec, CodeJobs } from '../codejobs.ts'

const head = { number: 7, headRefOid: 'abc', title: 'Fix thing', body: '', author: { login: 'someone' }, createdAt: '2026-01-01T10:00:00Z' }
function fixture(fail?: string) {
  const calls: string[][] = []
  const exec: Exec = async (cmd, _cwd, timeout) => {
    calls.push(cmd)
    expect(timeout).toBe(15_000)
    const path = cmd.find(s => s.startsWith('repos/')) ?? ''
    if (fail && path.includes(fail)) return undefined
    if (cmd[1] === 'pr') return JSON.stringify(head)
    if (cmd.includes('graphql')) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
      nodes: [{ id: 'thread1', path: 'a.ts', line: 1, isResolved: true, isOutdated: false, comments: { nodes: [{ id: 'comment1', body: 'Change this', author: { login: 'someone' }, diffHunk: '@@ -1 +1 @@' }], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false },
    } } } } })
    if (path.includes('/files')) return JSON.stringify([[{ filename: 'a.ts', status: 'modified', additions: 2500, deletions: 0, patch: Array.from({ length: 2500 }, () => '+new').join('\n') }]])
    if (path.includes('/commits?')) return JSON.stringify([[{ sha: 'abc', author: { login: 'someone' }, commit: { message: 'Fix', author: { date: '2026-01-01T10:01:00Z' } } }]])
    if (path.includes('/check-runs')) return JSON.stringify([{ check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-01-01T10:01:00Z', completed_at: '2026-01-01T10:02:00Z', output: { summary: 'Passed' } }] }])
    if (path.includes('/statuses')) return JSON.stringify([[]])
    if (path.includes('/reviews')) return JSON.stringify([[{ id: 3, user: { login: 'someone' }, state: 'APPROVED', submitted_at: '2026-01-01T10:03:00Z', body: 'OK' }]])
    if (path.includes('/comments')) return JSON.stringify([[{ id: 4, user: { login: 'someone' }, body: 'Hello', created_at: '2026-01-01T10:02:00Z' }]])
    if (path.includes('/timeline')) return JSON.stringify([[{ id: 5, event: 'labeled', label: { name: 'bug' }, created_at: '2026-01-01T10:04:00Z' }, { id: 4, event: 'commented', created_at: '2026-01-01T10:02:00Z' }]])
    throw new Error(`Unexpected gh call: ${cmd.join(' ')}`)
  }
  return { exec, calls }
}

test('merges timeline chronologically and deduplicates section entries with pointers', async () => {
  const { exec } = fixture()
  const result = await new PrDetails(exec).read('example/demo', 7)
  expect(result.timeline.map((e: any) => e.type)).toEqual(['opened', 'committed', 'commented', 'reviewed', 'labeled'])
  expect(result.timeline[2].pointer).toEqual({ section: 'conversation', id: '4' })
  expect(result.reviewThreads[0]).toMatchObject({ isResolved: true, isOutdated: false })
  expect(result.commits[0].checks.entries[0].durationMs).toBe(60_000)
})

test('truncates each patch at 2000 lines with an explicit flag', async () => {
  const { exec } = fixture()
  const result = await new PrDetails(exec).read('example/demo', 7)
  expect(result.files[0].patch.split('\n')).toHaveLength(2000)
  expect(result.files[0]).toMatchObject({ truncated: true, patchUnavailable: false })
})

test('a failed section does not hide the rest of the PR', async () => {
  const { exec } = fixture('/files')
  const result = await new PrDetails(exec).read('example/demo', 7)
  expect(result.files.error).toContain('failed or timed out')
  expect(result.head.number).toBe(7)
  expect(result.timeline).toHaveLength(5)
})

test('cache coalesces reads, expires at 5 min, and fresh detects a changed head SHA', async () => {
  const { exec, calls } = fixture()
  let now = 0
  let sha = 'abc'
  const reader = new PrDetails(async (cmd, cwd, timeout) => {
    const out = await exec(cmd, cwd, timeout)
    return cmd.includes('number,headRefOid') ? JSON.stringify({ number: 7, headRefOid: sha }) : out
  }, () => now)
  const count = () => calls.filter(c => c.includes('--slurp')).length
  const first = await reader.read('example/demo', 7)
  const n = count()
  expect(await reader.read('example/demo', 7)).toBe(first)
  expect(count()).toBe(n)
  now = 300_001
  await reader.read('example/demo', 7)
  expect(count()).toBeGreaterThan(n)
  const next = count()
  sha = 'def'
  await reader.read('example/demo', 7, true)
  expect(count()).toBeGreaterThan(next)
})

test('route validates method and job id before GitHub work', async () => {
  const jobs = new CodeJobs({ file: '/nonexistent/code-jobs.json', t3: {} as any, exec: async () => { throw new Error('unexpected') } })
  expect((await jobs.handle(new Request('http://localhost/app/jobs/pr', { method: 'POST' }), '/app/jobs/pr')).status).toBe(405)
  expect((await jobs.handle(new Request('http://localhost/app/jobs/pr'), '/app/jobs/pr')).status).toBe(400)
  expect((await jobs.handle(new Request('http://localhost/app/jobs/pr?id=missing'), '/app/jobs/pr')).status).toBe(404)
})


test('binary and unavailable patches are distinct from empty text patches', () => {
  expect(patchFile({ filename: 'image.png', binary: true })).toMatchObject({ binary: true, patch: null, patchUnavailable: true })
  expect(patchFile({ filename: 'large.txt' })).toMatchObject({ binary: null, patchUnavailable: true })
  expect(patchFile({ filename: 'empty.txt', patch: '' })).toMatchObject({ binary: false, patch: '', patchUnavailable: false, truncated: false })
})

test('retrieves omitted text patches and identifies binary files from the diff', async () => {
  const { exec } = fixture()
  const reader = new PrDetails(async (cmd, cwd, timeout) => {
    if (cmd.includes('diff')) return 'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\ndiff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
    if (cmd.some(s => s.includes('/files?'))) return JSON.stringify([[{ filename: 'image.png', status: 'modified', additions: 0, deletions: 0 }, { filename: 'a.ts', status: 'modified', additions: 1, deletions: 1 }]])
    return exec(cmd, cwd, timeout)
  })
  const result = await reader.read('example/demo', 7)
  expect(result.files[0]).toMatchObject({ binary: true, patchUnavailable: true })
  expect(result.files[1]).toMatchObject({ binary: false, patchUnavailable: false, patch: '@@ -1 +1 @@\n-old\n+new' })
})

test('flattens REST pages and retains a partial check error', async () => {
  const { exec } = fixture()
  const reader = new PrDetails(async (cmd, cwd, timeout) => {
    if (cmd.some(s => s.includes('/statuses?'))) return undefined
    if (cmd.some(s => s.includes('/comments?'))) return JSON.stringify([[{ id: 1, body: 'First', created_at: '2026-01-01T10:00:00Z' }], [{ id: 2, body: 'Second', created_at: '2026-01-01T10:01:00Z' }]])
    return exec(cmd, cwd, timeout)
  })
  const result = await reader.read('example/demo', 7)
  expect(result.conversation).toHaveLength(2)
  expect(result.checks.entries).toHaveLength(1)
  expect(result.checks.contexts.error).toContain('failed or timed out')
})

test('rejects option-shaped references and invalid repository paths before invoking gh', async () => {
  const calls: string[][] = []
  const reader = new PrDetails(async cmd => { calls.push(cmd); return undefined })
  for (const [repo, ref] of [['example/demo', '--web'], ['../demo/path', 7], ['../demo', 7], ['example/..', 7], ['example/demo', 0]] as const) {
    await expect(reader.read(repo, ref)).rejects.toThrow('Invalid repository or PR reference')
  }
  expect(calls).toHaveLength(0)
})

test('inlines GitHub images across bodies, retries deleted branches by SHA, and caches beyond detail TTL', async () => {
  const raw = 'https://raw.githubusercontent.com/example/demo/feat/screens/docs/a.png'
  const blob = 'https://github.com/example/demo/blob/feat/screens/docs/b.png?raw=true'
  const attachment = 'https://github.com/user-attachments/assets/image'
  const external = 'https://example.org/a.png'
  const body = `![screen](${raw}) <img src="${attachment}" width="20"> ![other](${external}) ![blob](${blob})`
  const { exec } = fixture()
  const calls: string[] = []
  let now = 0
  const reader = new PrDetails(async (cmd, cwd, timeout) => {
    if (cmd[1] === 'auth') return 'test-token'
    const value = await exec(cmd, cwd, timeout)
    if (cmd[1] === 'pr') return JSON.stringify({ ...head, headRefName: 'feat/screens', body })
    if (cmd.some(s => s.includes('/reviews?'))) return JSON.stringify([[{ id: 3, body: `![review](${attachment})` }]])
    return value
  }, () => now, (async (url: any, options: any) => {
    calls.push(String(url))
    expect(options.headers.Authorization).toBe('token test-token')
    expect(options.redirect).toBe('manual')
    expect(String(url)).not.toContain('example.org')
    return String(url) === raw || String(url).endsWith('/feat/screens/docs/b.png') ? new Response('', { status: 404 }) : new Response('png', { headers: { 'content-type': 'image/png' } })
  }) as unknown as typeof fetch)
  const result = await reader.read('example/demo', 7)
  expect(result.head.body).toBe(`![screen](data:image/png;base64,cG5n) <img src="data:image/png;base64,cG5n" width="20"> ![other](${external}) ![blob](data:image/png;base64,cG5n)`)
  expect(result.reviews[0].body).toContain('data:image/png')
  expect(calls).toEqual([raw, 'https://raw.githubusercontent.com/example/demo/abc/docs/a.png', attachment,
    'https://raw.githubusercontent.com/example/demo/feat/screens/docs/b.png', 'https://raw.githubusercontent.com/example/demo/abc/docs/b.png'])
  now = 31_000
  await reader.read('example/demo', 7)
  expect(calls).toHaveLength(5)
})

test('leaves failed, oversized and off-host redirected images unchanged', async () => {
  const { PrImages } = await import('../primages.ts')
  for (const response of [
    () => new Response('', { status: 302, headers: { location: 'https://example.org/private' } }),
    () => new Response('no', { status: 403 }),
    () => new Response('large', { headers: { 'content-type': 'image/png', 'content-length': String(6 * 1024 * 1024) } }),
    () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
  ]) {
    let calls = 0
    const images = new PrImages(async () => 'test-token', (async () => { calls++; return response() }) as unknown as typeof fetch)
    const detail = { body: '![x](https://objects.githubusercontent.com/image)' }
    expect(await images.inline(detail, 'example/demo', {})).toEqual(detail)
    expect(calls).toBe(1)
  }
})

test('shares the image byte budget between PR and comment bodies', async () => {
  const { PrImages } = await import('../primages.ts')
  let calls = 0
  const images = new PrImages(async () => 'test-token', (async () => {
    calls++
    return new Response(new Uint8Array(5 * 1024 * 1024), { headers: { 'content-type': 'image/png' } })
  }) as unknown as typeof fetch)
  const result = await images.inline({ body: Array.from({ length: 4 }, (_, i) => `![x](https://objects.githubusercontent.com/${i})`).join('\n'), comments: [{ body: '![x](https://objects.githubusercontent.com/last)' }] }, 'example/demo', {})
  expect(result.body.match(/data:image\/png/g)).toHaveLength(4)
  expect(result.comments[0].body).toContain('https://objects.githubusercontent.com/last')
  expect(calls).toBe(4)
})

test('last successful detail survives failed refresh and cache expiry', async () => {
  const { exec } = fixture()
  let down = false, now = 0
  const details = new PrDetails(async (...args) => down ? undefined : exec(...args), () => now)
  const good = await details.read('example/demo', 7)
  down = true
  now = 300_001
  expect((await details.read('example/demo', 7)).head.error).toContain('failed or timed out')
  expect(await details.cached('example/demo', 7)).toEqual(good)
})


import { existsSync, mkdtempSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

test('stored closed PRs bypass GitHub during an outage and after cache expiry', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'otto-pr-outage-')), 'jobs.json')
  saveCodeJobs(file, [{ id: 'j1', title: 'Fix', brief: 'Fix', project: 'demo', repo: 'example/demo', branch: 'fix', prNumber: 7,
    agent: 'T3 Code', where: 'local', createdAt: new Date(0).toISOString(), tokenBudget: 100, steps: [] }])
  const { exec } = fixture()
  let down = false, now = 1000
  const jobs = new CodeJobs({ file, now: () => now, t3: { threads: async () => new Map() } as any, exec: async (cmd, cwd, timeout) => {
    if (down) return undefined
    if (cmd[1] === 'pr' && cmd[2] === 'diff') return ''
    if (cmd[1] === 'pr') return JSON.stringify({ ...head, state: 'CLOSED', headRefName: 'fix' })
    return exec(cmd, cwd, timeout)
  } })
  const read = () => jobs.handle(new Request('http://x/app/jobs/pr?id=j1'), '/app/jobs/pr')
  const first = await read()
  expect(first.status).toBe(200)
  expect((await first.json()).head.number).toBe(7)
  down = true
  const stale = await read()
  expect(stale.status).toBe(200)
  expect(await stale.json()).toMatchObject({ head: { number: 7, state: 'CLOSED' } })
  down = false
  now += 61_000
  const recovered = await read()
  expect(recovered.status).toBe(200)
  expect((await recovered.json()).stale).toBeUndefined()
})

for (const state of ['MERGED', 'CLOSED'] as const) {
  test(`${state} detail survives restart and is served from disk without gh or T3 calls`, async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'otto-terminal-pr-')), 'jobs.json')
    saveCodeJobs(file, [{ id: 'j1', title: 'Fix', brief: 'Fix', project: 'demo', repo: 'example/demo', branch: 'fix', prNumber: 7,
      ...(state === 'MERGED' ? { mergedAt: '2026-01-02T10:00:00Z' } : {}),
      agent: 'T3 Code', where: 'local', createdAt: new Date(0).toISOString(), tokenBudget: 100, steps: [] }])
    const { exec } = fixture()
    const jobs = new CodeJobs({ file, t3: { threads: async () => new Map() } as any, exec: async (cmd, cwd, timeout) => {
      if (cmd[1] === 'pr' && cmd[2] === 'diff') return ''
      if (cmd[1] === 'pr') return JSON.stringify({ ...head, state, headRefName: 'fix', mergedAt: state === 'MERGED' ? '2026-01-02T10:00:00Z' : null })
      return exec(cmd, cwd, timeout)
    } })
    const request = () => new Request('http://x/app/jobs/pr?id=j1')
    const first = await jobs.handle(request(), '/app/jobs/pr')
    expect(first.status).toBe(200)
    const detail = await first.json()
    expect(detail.head.state).toBe(state)
    expect(readdirSync(join(dirname(file), 'pr-details'))).toHaveLength(1)
    let ghCalls = 0, threadCalls = 0
    const restarted = new CodeJobs({ file, now: () => Date.now() + 120_000,
      t3: { threads: async () => { threadCalls++; throw new Error('unavailable') } } as any,
      exec: async () => { ghCalls++; return undefined },
    })
    const stored = await restarted.handle(request(), '/app/jobs/pr')
    expect(stored.status).toBe(200)
    expect(await stored.json()).toEqual(detail)
    expect(ghCalls).toBe(0)
    expect(threadCalls).toBe(0)
  })
}

test('merged PR with no stored detail returns known fields during an outage, including after restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'otto-merged-fallback-')), 'jobs.json')
  const mergedAt = '2026-01-02T10:00:00Z'
  saveCodeJobs(file, [{ id: 'j1', title: 'Job title', brief: 'Fix', project: 'demo', repo: 'example/demo', branch: 'fix', prNumber: 7,
    mergedAt, prInfo: { repo: 'example/demo', headBranch: 'fix', state: 'MERGED', mergedAt, body: 'PR body',
      pr: { n: 7, title: 'PR title', url: 'https://github.com/example/demo/pull/7', add: 12, del: 4, files: 3, checks: 'No checks', draft: false, mergeable: 'UNKNOWN', base: 'main', diff: [] } },
    agent: 'T3 Code', where: 'local', createdAt: new Date(0).toISOString(), tokenBudget: 100, steps: [] }])
  const jobs = new CodeJobs({ file, t3: {} as any, exec: async () => undefined })
  const read = () => jobs.handle(new Request('http://x/app/jobs/pr?id=j1'), '/app/jobs/pr')
  const response = await read()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ stale: true, head: {
    number: 7, title: 'PR title', url: 'https://github.com/example/demo/pull/7', state: 'MERGED', mergedAt,
    body: 'PR body', additions: 12, deletions: 4, changedFiles: 3,
  } })
  expect((await read()).status).toBe(200)
  expect(existsSync(join(dirname(file), 'pr-details'))).toBe(false)
})

test('legacy merged job without a saved PR snapshot still renders during an outage', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'otto-merged-legacy-')), 'jobs.json')
  saveCodeJobs(file, [{ id: 'j1', title: 'Fix it', brief: 'Fix', project: 'demo', repo: 'example/demo', prNumber: 7,
    mergedAt: '2026-01-02T10:00:00Z', agent: 'T3 Code', where: 'local', createdAt: new Date(0).toISOString(), tokenBudget: 100, steps: [] }])
  const jobs = new CodeJobs({ file, t3: {} as any, exec: async () => undefined })
  const response = await jobs.handle(new Request('http://x/app/jobs/pr?id=j1'), '/app/jobs/pr')
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ stale: true, head: { number: 7, title: 'Fix it', state: 'MERGED', url: 'https://github.com/example/demo/pull/7' } })
})

test('detail TTL makes no gh calls and an unchanged head reuses file patches', async () => {
  const { exec, calls } = fixture()
  let now = 0
  const details = new PrDetails(exec, () => now)
  await details.read('example/demo', 7)
  const count = calls.length
  now = 299_999
  await details.read('example/demo', 7)
  expect(calls).toHaveLength(count)
  now++
  await details.read('example/demo', 7)
  expect(calls.length).toBeGreaterThan(count)
  expect(calls.filter(c => c.some(arg => arg.includes('/pulls/7/files')))).toHaveLength(1)
})
