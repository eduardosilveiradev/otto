import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadJournal, saveJournal, recordInbound, markRead, takeRedeliveries } from '../redeliver.ts'
import { PrMerges, MAX_DELIVERED, loadPrMerges, journalMergeDelivery } from '../prmerges.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-prmerges-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const START = Date.parse('2026-10-01T10:00:00Z')
const pr = (number = 1, extra = {}) => ({
  repository: { nameWithOwner: 'example/demo' }, number, title: 'A change',
  url: `https://github.com/example/demo/pull/${number}`, mergedAt: new Date(START + 60_000).toISOString(),
  mergedBy: { login: 'example' }, baseRefName: 'main', headRefName: 'feature/change', ...extra,
})
function harness() {
  const file = join(mkdtempSync(join(tmp, 's-')), 'prmerges.json')
  let now = START
  let nodes = [pr()]
  let fail = false
  let accepted = true
  let next: string | null = null
  const calls: string[][] = []
  const events: { event: string; content: string; meta: Record<string, string>; id: string }[] = []
  let jobs: { id: string; repo?: string; branch?: string; prNumber?: number }[] = []
  const deps = {
    file, now: () => now, jobs: () => jobs,
    exec: async (cmd: string[]) => {
      calls.push(cmd)
      if (fail) throw new Error('gh offline')
      if (cmd[2] === 'user') return JSON.stringify({ login: 'example' })
      return JSON.stringify({ data: { search: { nodes, pageInfo: { hasNextPage: !!next, endCursor: next } } } })
    },
    injectEvent: async (event: string, content: string, meta: Record<string, string>, id: string) => {
      if (!accepted) return false
      events.push({ event, content, meta, id })
      return true
    },
  }
  return {
    file, calls, events, deps, watcher: new PrMerges(deps), state: () => loadPrMerges(file),
    advance: (ms = 120_000) => { now += ms }, nodes: (p: ReturnType<typeof pr>[]) => { nodes = p },
    fail: (v: boolean) => { fail = v }, accept: (v: boolean) => { accepted = v },
    jobs: (j: typeof jobs) => { jobs = j }, next: (s: string | null) => { next = s },
  }
}

test('first run establishes the cursor without searching or delivering old merges', async () => {
  const h = harness()
  await h.watcher.tick()
  expect(h.events).toEqual([])
  expect(h.calls).toEqual([])
  expect(h.state().cursor).toBe('2026-10-01T10:00:00Z')
  h.nodes([pr(1, { mergedAt: '2026-10-01T09:59:00Z' })])
  h.advance()
  await h.watcher.tick()
  expect(h.events).toEqual([])
})

test('a new merge delivers once, with one search per tick and runtime login', async () => {
  const h = harness()
  await h.watcher.tick(); h.advance(); await h.watcher.tick()
  expect(h.events).toHaveLength(1)
  expect(h.events[0]).toMatchObject({ event: 'pr-merged', id: 'pr-merged:example/demo#1', meta: {
    repo: 'example/demo', pr: '1', title: 'A change', url: 'https://github.com/example/demo/pull/1',
    merged_at: '2026-10-01T10:01:00.000Z', merged_by: 'example', base: 'main',
  } })
  expect(h.calls[0]).toEqual(['gh', 'api', 'user'])
  expect(h.calls[1]).toContain('q=owner:example is:pr is:merged merged:2026-10-01T10:00:00Z..2026-10-01T10:02:00Z sort:updated-asc')
  h.advance(); await h.watcher.tick()
  expect(h.calls).toHaveLength(3)
  expect(h.events).toHaveLength(1)
})

test('restart catches merges during downtime and dedupes previously delivered PRs', async () => {
  const h = harness()
  await h.watcher.tick(); h.advance(); await h.watcher.tick()
  h.advance(3_600_000)
  h.nodes([pr(), pr(2, { mergedAt: '2026-10-01T10:30:00Z' })])
  await new PrMerges(h.deps).tick()
  expect(h.events.map(e => e.meta.pr)).toEqual(['1', '2'])
})

test('job matching requires the repo and either PR number or head branch, even for app-merged jobs', async () => {
  for (const match of [{ prNumber: 1 }, { branch: 'feature/change' }]) {
    const h = harness()
    h.jobs([{ id: 'foreign', repo: 'example/other', prNumber: 1 }, { id: 'job-1', repo: 'EXAMPLE/demo', ...match }])
    await h.watcher.tick(); h.advance(); await h.watcher.tick()
    expect(h.events[0]!.meta.job).toBe('job-1')
    h.advance(); await new PrMerges(h.deps).tick()
    expect(h.events).toHaveLength(1)
  }
})

test('gh failure records an error without advancing the cursor, then retries', async () => {
  const h = harness()
  await h.watcher.tick()
  h.fail(true); h.advance(); await h.watcher.tick()
  expect(h.state().lastError?.message).toBe('gh offline')
  expect(h.state().cursor).toBe('2026-10-01T10:00:00Z')
  h.fail(false); h.advance(); await h.watcher.tick()
  expect(h.events).toHaveLength(1)
  expect(h.state().lastError).toBeUndefined()
})

test('failed injection retries without skipping the merge', async () => {
  const h = harness()
  await h.watcher.tick(); h.accept(false); h.advance(); await h.watcher.tick()
  expect(h.state().cursor).toBe('2026-10-01T10:00:00Z')
  expect(h.state().delivered).toEqual({})
  h.accept(true); h.advance(); await h.watcher.tick()
  expect(h.events).toHaveLength(1)
})

test('pagination persists across restarts with one search per tick', async () => {
  const h = harness()
  await h.watcher.tick(); h.next('page-2'); h.advance(); await h.watcher.tick()
  expect(h.state().cursor).toBe('2026-10-01T10:00:00Z')
  expect(h.state().scan?.after).toBe('page-2')
  h.next(null); h.nodes([pr(2)]); h.advance()
  await new PrMerges(h.deps).tick()
  expect(h.calls.at(-1)).toContain('after=page-2')
  expect(h.state().cursor).toBe('2026-10-01T10:02:00Z')
  expect(h.events).toHaveLength(2)
})

test('catchup is bounded to 24 hours, titles stay on one line, merger is optional', async () => {
  const h = harness()
  await h.watcher.tick(); h.advance(48 * 3_600_000)
  h.nodes([pr(), pr(2, { title: 'one\ntwo', mergedBy: null, mergedAt: '2026-10-03T09:00:00Z' })])
  await h.watcher.tick()
  expect(h.calls.at(-1)?.join(' ')).toContain('merged:2026-10-02T10:00:00Z..2026-10-03T10:00:00Z')
  expect(h.events).toHaveLength(1)
  expect(h.events[0]!.content).not.toContain('\n')
  expect(h.events[0]!.meta.merged_by).toBeUndefined()
})

test('dedupe is capped without evicting live keys and replays', async () => {
  const h = harness()
  await h.watcher.tick()
  const s = h.state()
  s.delivered = Object.fromEntries(Array.from({ length: MAX_DELIVERED }, (_, i) => [`example/demo#${i + 10}`, '2026-10-01T10:01:00Z']))
  writeFileSync(h.file, JSON.stringify(s))
  h.advance(); await h.watcher.tick()
  expect(h.state().lastError?.message).toContain('capacity')
  expect(h.events).toHaveLength(0)
  h.advance(25 * 3_600_000)
  h.nodes([pr(2, { mergedAt: '2026-10-02T11:00:00Z' })])
  await h.watcher.tick()
  expect(Object.keys(h.state().delivered)).toHaveLength(1)
  expect(JSON.parse(readFileSync(h.file, 'utf8')).lastError).toBeUndefined()
})


test('journal acceptance survives a transport failure and a crash before the watcher saves', async () => {
  const h = harness()
  const journal = join(tmp, 'journal.json')
  let sent = 0
  const deliver = journalMergeDelivery(journal, async (event, content, meta, id) => {
    sent++
    saveJournal(journal, recordInbound(loadJournal(journal), {
      chat_id: event, message_id: id, text: content, meta: { ...meta, event, message_id: id }, read: false,
    }, START + 120_000))
    return false // transport died, but the journal owes the notification
  })
  const deps = { ...h.deps, injectEvent: deliver }
  await new PrMerges(deps).tick()
  const before = readFileSync(h.file, 'utf8')
  h.advance()
  await new PrMerges(deps).tick()
  expect(sent).toBe(1)
  // Simulate a restart in the gap after journaling but before saving the watcher cursor.
  writeFileSync(h.file, before)
  await new PrMerges(deps).tick()
  expect(sent).toBe(1)
  expect(h.state().delivered['example/demo#1']).toBeDefined()
  const pending = loadJournal(journal)
  expect(takeRedeliveries(pending, { now: START + 12 * 3_600_000, bootAt: START + 12 * 3_600_000, windowMs: 6 * 3_600_000 })).toHaveLength(1)
  markRead(pending, ['pr-merged:example/demo#1'])
  expect(takeRedeliveries(pending, { now: START + 13 * 3_600_000, bootAt: START + 13 * 3_600_000, windowMs: 6 * 3_600_000 })).toHaveLength(0)
})

test('invalid search pages do not advance the cursor', async () => {
  const h = harness()
  await h.watcher.tick(); h.advance()
  await new PrMerges({ ...h.deps, exec: async cmd => cmd[2] === 'user'
    ? JSON.stringify({ login: 'example' }) : JSON.stringify({ errors: [{ message: 'query failed' }] }) }).tick()
  expect(h.state().cursor).toBe('2026-10-01T10:00:00Z')
  expect(h.state().lastError?.message).toContain('search failed')
  expect(h.events).toHaveLength(0)
})

test('overlapping ticks share one in-flight search', async () => {
  const h = harness()
  await h.watcher.tick(); h.advance()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let searches = 0
  const watcher = new PrMerges({ ...h.deps, exec: async cmd => {
    if (cmd[2] === 'graphql') { searches++; await blocked }
    return h.deps.exec(cmd)
  } })
  const first = watcher.tick()
  await Promise.resolve()
  await watcher.tick()
  release(); await first
  expect(searches).toBe(1)
  expect(h.events).toHaveLength(1)
})

test('non-host merge watcher leaves shared cursor and deliveries untouched', async () => {
  const file = join(tmp, 'non-host.json')
  const before = JSON.stringify({ cursor: new Date(START).toISOString(), delivered: {} })
  writeFileSync(file, before)
  const watcher = new PrMerges({ file, isHost: () => false, jobs: () => [],
    exec: async () => { throw new Error('non-host must not scan') },
    injectEvent: async () => { throw new Error('non-host must not emit') } })
  await watcher.tick()
  expect(readFileSync(file, 'utf8')).toBe(before)
})

test('offline merge polling is gated to one probe per five minutes without advancing the cursor', async () => {
  const file = join(mkdtempSync(join(tmp, 'offline-')), 'prmerges.json')
  let now = START
  const calls: string[][] = []
  const watcher = new PrMerges({ file, now: () => now, jobs: () => [], injectEvent: async () => true,
    exec: async cmd => { calls.push(cmd); return undefined },
  })
  await watcher.tick()
  const cursor = loadPrMerges(file).cursor
  for (now++; now < START + 3_600_000; now += 20_000) await watcher.tick()
  expect(calls.filter(c => c[2] === 'rate_limit')).toHaveLength(12)
  expect(calls.filter(c => c[2] !== 'rate_limit')).toHaveLength(1)
  expect(loadPrMerges(file).cursor).toBe(cursor)
})

function checkoutHarness() {
  const h = harness()
  const dir = mkdtempSync(join(tmp, 'git-'))
  const origin = join(dir, 'origin.git'), source = join(dir, 'source'), cwd = join(dir, 'checkout')
  const git = (at: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: at, env: {
      ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'you@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'you@example.com',
    } })
    if (r.exitCode) throw new Error(r.stderr.toString())
    return r.stdout.toString().trim()
  }
  git(dir, 'init', '--bare', '--initial-branch=main', origin)
  git(dir, 'clone', origin, source)
  writeFileSync(join(source, 'file.txt'), 'original\n')
  git(source, 'add', '.'); git(source, 'commit', '-m', 'Initial'); git(source, 'push', 'origin', 'main')
  git(dir, 'clone', origin, cwd)
  const remote = 'git@github.com:example/demo.git'
  git(cwd, 'remote', 'set-url', 'origin', remote)
  // GitHub identity with transport confined to the temporary bare origin.
  git(cwd, 'config', `url.${origin}.insteadOf`, remote)
  const from = git(cwd, 'rev-parse', 'HEAD'), log = join(dir, 'capability-log.json')
  let reloads = 0, refusal: string | undefined
  const watcher = new PrMerges({ ...h.deps, checkout: {
    cwd, log, reload: async beforeRestart => { reloads++; if (!refusal) beforeRestart(); return refusal },
  } })
  return { ...h, cwd, from, log, git: (...args: string[]) => git(cwd, ...args),
    reloads: () => reloads, refuse: (why: string) => { refusal = why },
    merge: (file = 'file.txt', contents = 'merged\n') => {
      if (file.includes('/')) Bun.spawnSync(['mkdir', '-p', join(source, file.slice(0, file.lastIndexOf('/')))])
      writeFileSync(join(source, file), contents)
      git(source, 'add', '.'); git(source, 'commit', '-m', 'Merged change'); git(source, 'push', 'origin', 'main')
      return git(source, 'rev-parse', 'HEAD')
    },
    tick: async () => { await watcher.tick(); h.advance(); await watcher.tick() },
    again: () => watcher.tick(),
  }
}

test('clean fast-forward reloads once, injects nothing and logs the from/to commits and undo', async () => {
  const h = checkoutHarness(), to = h.merge()
  await h.tick(); await h.again()
  expect(h.git('rev-parse', 'HEAD')).toBe(to)
  expect(h.reloads()).toBe(1)
  expect(h.events).toEqual([])
  const entries = JSON.parse(readFileSync(h.log, 'utf8'))
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ sha: to, by: 'prmerges',
    revert: { kind: 'git-revert', sha: h.from, paths: ['file.txt'] } })
  for (const value of ['#1', h.from, to]) expect(entries[0].what).toContain(value)
})

test('dirty tree restores tracked and untracked edits after pulling', async () => {
  const h = checkoutHarness()
  h.merge('new.txt')
  writeFileSync(join(h.cwd, 'file.txt'), 'local edits\n')
  writeFileSync(join(h.cwd, 'untracked.txt'), 'keep me\n')
  await h.tick()
  expect(readFileSync(join(h.cwd, 'file.txt'), 'utf8')).toBe('local edits\n')
  expect(readFileSync(join(h.cwd, 'untracked.txt'), 'utf8')).toBe('keep me\n')
  expect(h.git('stash', 'list')).toBe('')
  expect(h.reloads()).toBe(1)
  expect(h.events).toEqual([])
})

test('stash conflict retains the named stash and injects a failure without reloading', async () => {
  const h = checkoutHarness()
  h.merge()
  writeFileSync(join(h.cwd, 'file.txt'), 'conflicting local edits\n')
  await h.tick()
  expect(h.git('stash', 'list')).toContain('pr-merged #1')
  expect(h.reloads()).toBe(0)
  expect(h.events).toHaveLength(1)
  expect(h.events[0]!.content).toContain('stash pop failed or conflicted')
  expect(h.events[0]!.content).toContain(h.git('rev-parse', 'refs/stash'))
  expect(h.events[0]!.content).toContain('stash@{0}')
})

test('non-fast-forward preserves local commits and restores dirty edits before the failure event', async () => {
  const h = checkoutHarness()
  h.merge()
  writeFileSync(join(h.cwd, 'local.txt'), 'local commit\n')
  h.git('add', '.'); h.git('commit', '-m', 'Local')
  const local = h.git('rev-parse', 'HEAD')
  writeFileSync(join(h.cwd, 'dirty.txt'), 'local edits\n')
  await h.tick()
  expect(h.git('rev-parse', 'HEAD')).toBe(local)
  expect(readFileSync(join(h.cwd, 'dirty.txt'), 'utf8')).toBe('local edits\n')
  expect(h.git('stash', 'list')).toBe('')
  expect(h.reloads()).toBe(0)
  expect(h.events[0]!.content).toContain('git pull --ff-only failed')
})

for (const path of ['otto/supervisor.ts', '.mcp.json']) {
  test(`${path} pulls but requests a manual reconnect without reloading`, async () => {
    const h = checkoutHarness(), to = h.merge(path)
    await h.tick()
    expect(h.git('rev-parse', 'HEAD')).toBe(to)
    expect(h.reloads()).toBe(0)
    expect(h.events[0]!.content).toContain('manual reconnect required')
  })
}

test('reload refusal injects the reason and writes no auto-reload entry', async () => {
  const h = checkoutHarness()
  h.merge(); h.refuse('the code on disk does not compile')
  await h.tick()
  expect(h.events[0]!.content).toContain('Reload refused: the code on disk does not compile')
  expect(() => readFileSync(h.log)).toThrow()
})

for (const extra of [{ repository: { nameWithOwner: 'example/other' } }, { baseRefName: 'release' }]) {
  test(`foreign repo or base retains existing event behavior: ${JSON.stringify(extra)}`, async () => {
    const h = checkoutHarness()
    h.nodes([pr(1, extra)]); h.merge()
    await h.tick()
    expect(h.git('rev-parse', 'HEAD')).toBe(h.from)
    expect(h.reloads()).toBe(0)
    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.content).toBe(`${extra.repository?.nameWithOwner ?? 'example/demo'}#1 merged: A change (https://github.com/example/demo/pull/1)`)
  })
}


test('a scheduled restart leaves the rest of the merge page for the next process', async () => {
  const h = checkoutHarness()
  h.merge(); h.nodes([pr(), pr(2)])
  await h.tick()
  expect(h.reloads()).toBe(1)
  expect(Object.keys(h.state().delivered)).toEqual(['example/demo#1'])
  expect(h.state().cursor).toBe('2026-10-01T10:00:00Z')
})

test('a merge from a coding job carries its price tag', async () => {
  const h = harness()
  h.jobs([{ id: 'j1', repo: 'example/demo', prNumber: 1, cost: '2.1M Claude tokens · ~3% of the week' } as any])
  await h.watcher.tick(); h.advance(); await h.watcher.tick()
  expect(h.events[0]!.content).toBe('example/demo#1 merged: A change (https://github.com/example/demo/pull/1) · 2.1M Claude tokens · ~3% of the week')
  expect(h.events[0]!.meta.job).toBe('j1')
})
