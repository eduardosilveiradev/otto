import { test, expect, spyOn } from 'bun:test'
import { slotSnapshot } from '../slots.ts'
import { t3ThreadUrl, modelLabel } from '../t3.ts'
import { formatCodeJob, checksLine, diffPreview, parseCouncil, cellScore, memberName, wireJob, wireJobs, t3Label, T3_STATUS_LABELS, JOB_START_STALE_MS, type CodeJob, type PrInfo, type WireJob } from '../codejobs.ts'

const job = (over: Partial<CodeJob> = {}): CodeJob => ({
  id: 'j1', title: 'Fix the thing', brief: 'fix it', project: 'demo', repo: 'example/demo', branch: 'fix/thing',
  threadId: 't1', agent: 'T3 Code', where: 'local', model: 'Opus 5.5', createdAt: '2026-11-05T10:00:00.000Z',
  startedAt: '2026-11-05T10:00:01.000Z', tokenBudget: 400_000, steps: [{ ts: '2026-11-05T10:00:00.000Z', text: 'Handed off from chat' }], ...over,
})
const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
  repo: 'example/demo', headBranch: 'fix/thing', state: 'OPEN', body: '', ...over,
  pr: { n: 7, title: 'Fix', url: 'https://github.com/example/demo/pull/7', add: 3, del: 1, files: 1, checks: 'Check passing', draft: false, mergeable: 'MERGEABLE', base: 'main', diff: [] },
})

test('checksLine', () => {
  expect(checksLine([])).toBe('No checks')
  expect(checksLine([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe('All 2 checks passing')
  expect(checksLine([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: null }])).toBe('1 of 2 checks running')
  expect(checksLine([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { state: 'PENDING' }])).toBe('1 of 2 checks failing')
  expect(checksLine([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('Check passing')
})

test('diffPreview keeps the first hunks, a dozen lines each', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts',
    '@@ -1,3 +1,3 @@ fn', ' keep', '-old', '+new',
    'diff --git a/b.ts b/b.ts', 'new file mode 100644', '--- /dev/null', '+++ b/b.ts', '@@ -0,0 +1,20 @@',
    ...Array.from({ length: 20 }, (_, i) => `+line ${i}`),
    '@@ -5 +5 @@', '-x', '+y', '@@ -9 +9 @@', '-z', '+w',
  ].join('\n')
  const d = diffPreview(diff)
  expect(d).toHaveLength(3)
  expect(d[0]).toEqual({ file: 'src/a.ts', hunk: '@@ -1,3 +1,3 @@ fn', lines: [[' ', 'keep'], ['-', 'old'], ['+', 'new']] })
  expect(d[1]!.file).toBe('b.ts')
  expect(d[1]!.lines).toHaveLength(12)
  expect(d[2]!.lines).toEqual([['-', 'x'], ['+', 'y']])
})

test('parseCouncil reads the council table', () => {
  const body = [
    'Some prose.', '', '## Council review', '', 'Rounds: 3', '',
    '| Delegate | Round 1 | Round 2 | Round 3 |', '| --- | --- | --- | --- |',
    '| Claude Opus 5.5 | 7/10 | 8 / 9 | 9/10 |', '| GPT-6.1-Sol | no score | 6 / 7 | 10/10 |', '', 'After.',
  ].join('\n')
  expect(parseCouncil(body)).toEqual([
    { round: 1, scores: { Opus: 7, Sol: null }, fixes: [] },
    { round: 2, scores: { Opus: 9, Sol: 7 }, fixes: [] },
    { round: 3, scores: { Opus: 9, Sol: 10 }, fixes: [] },
  ])
  expect(parseCouncil('no table here')).toEqual([])
  expect(cellScore('4 / no score')).toBeNull()
  expect(memberName('GPT Sol')).toBe('Sol')
})

test('wireJob: the state comes from the thread and the PR', () => {
  expect(wireJob(job({ threadId: undefined }), undefined, undefined, Date.parse(job().createdAt)).state).toBe('queued')
  expect(wireJob(job(), { id: 't1', status: 'running', now: 'Reading a.ts' }, undefined)).toMatchObject({ state: 'running', now: 'Reading a.ts', pr: null })
  const review = wireJob(job(), { id: 't1', status: 'idle', tokensUsed: 1234, updatedAt: '2026-11-05T11:00:00.000Z' }, pr())
  expect(review).toMatchObject({ state: 'review', tokensUsed: 1234, now: null, question: null, endedAt: '2026-11-05T11:00:00.000Z' })
  expect(review.pr!.n).toBe(7)
  // Running beats review: a steer after the PR opened is still work in progress.
  expect(wireJob(job(), { id: 't1', status: 'running' }, pr()).state).toBe('running')
  const q = { text: 'Which one?', answers: ['A', 'B'], askedAt: '2026-11-05T10:30:00.000Z' }
  expect(wireJob(job(), { id: 't1', status: 'input', question: q }, undefined)).toMatchObject({ state: 'input', question: q })
  // Idle with no PR, last words asking something: that's the question.
  expect(wireJob(job(), { id: 't1', status: 'idle', lastMessage: 'I could not push.\n\nShould I force it?' }, undefined))
    .toMatchObject({ state: 'input', question: { text: 'I could not push.\n\nShould I force it?', answers: [] } })
  // Idle with no PR, last words a report: done, for you to look at, nothing to answer.
  expect(wireJob(job(), { id: 't1', status: 'idle', lastMessage: 'Why it broke? The cache.\n\nFixed it and ran the suite: all green.' }, undefined))
    .toMatchObject({ state: 'done', question: null, pr: null })
  const merged = wireJob(job({ mergedAt: '2026-11-05T12:00:00.000Z' }), { id: 't1', status: 'idle' }, pr({ state: 'MERGED' }))
  expect(merged).toMatchObject({ state: 'merged', endedAt: '2026-11-05T12:00:00.000Z', pr: null })
  expect(wireJob(job({ stoppedAt: '2026-11-05T12:00:00.000Z' }), { id: 't1', status: 'idle' }, undefined).state).toBe('stopped')
  expect(wireJob(job(), { id: 't1', status: 'idle' }, pr({ state: 'CLOSED' })).state).toBe('stopped')
})

test('wireJob: council comes from the PR body', () => {
  const body = '| Delegate | Round 1 |\n| --- | --- |\n| Claude Opus | 9/10 |\n| GPT Sol | 8/10 |'
  expect(wireJob(job(), { id: 't1', status: 'idle' }, pr({ body })).council).toEqual([{ round: 1, scores: { Opus: 9, Sol: 8 }, fixes: [] }])
})

test('wireJobs counts today, newest first', () => {
  const now = Date.parse('2026-11-05T15:00:00')
  const today = new Date(now - 3600_000).toISOString(), yesterday = new Date(now - 30 * 3600_000).toISOString()
  const a = { ...wireJob(job({ id: 'a', createdAt: yesterday }), { id: 't1', status: 'running', tokensUsed: 100 }, undefined) }
  const b = { ...wireJob(job({ id: 'b', createdAt: today }), { id: 't1', status: 'running', tokensUsed: 50 }, undefined) }
  const c = { ...wireJob(job({ id: 'c', createdAt: yesterday, stoppedAt: yesterday }), { id: 't1', status: 'idle', tokensUsed: 9 }, undefined) }
  const w = wireJobs([a, b, c], now)
  expect(w.jobs.map(j => j.id)).toEqual(['b', 'a', 'c'])
  expect(w.usage).toMatchObject({ jobsToday: 1, tokensToday: 150 })
})

// ---------------------------------------------------------------------------
// CodeJobs, against a fake T3 and a fake gh
// ---------------------------------------------------------------------------

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { JobEvents } from '../jobevents.ts'
import { CodeJobs, loadCodeJobs, saveCodeJobs, updateCodeJob, repoFromRemotes, type T3, type ThreadSnap, type WireJobs, type Exec } from '../codejobs.ts'

type Gh = { pr?: Record<string, any>; prs?: Record<string, any>[]; mergeOk?: boolean; calls: string[][]; remotes: Record<string, string>; search?: unknown[] }
function fakeGh(gh: Gh) {
  let branch: string | undefined
  return async (cmd: string[], cwd?: string) => {
    gh.calls.push(cmd)
    const [, a, b] = cmd
    if (cmd[0] === 'git' && a === 'remote') return gh.remotes[cwd ?? ''] ?? ''
    if (cmd[0] === 'git' && (a === 'fetch' || a === 'rev-parse')) return ''
    if (a === 'api' && b === 'rate_limit') return '{}'
    if (a === 'search' && b === 'prs') return JSON.stringify(gh.search ?? [])
    if (a === 'pr' && b === 'list') {
      branch = cmd[cmd.indexOf('--head') + 1]
      const raws = gh.prs ?? (gh.pr ? [gh.pr] : [])
      return JSON.stringify(raws.map(raw => ({ ...raw, headRefName: raw.headRefName ?? branch })).filter(raw => raw.headRefName === branch))
    }
    if (a === 'pr' && b === 'view') {
      const raw = (gh.prs ?? (gh.pr ? [gh.pr] : [])).find(raw => raw.number === Number(cmd[3]))
      return raw ? JSON.stringify({ ...raw, headRefName: raw.headRefName ?? branch ?? 'fix/thing' }) : undefined
    }
    if (a === 'pr' && b === 'diff') return 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b'
    if (a === 'pr' && b === 'merge') {
      if (!gh.mergeOk) return undefined
      gh.pr = { ...gh.pr, state: 'MERGED', mergedAt: '2026-11-05T12:00:00Z' }
      return ''
    }
    return undefined
  }
}
/** A folder git would call a checkout: `.git` is all remoteRepo looks for before asking git. */
const checkout = () => { const d = mkdtempSync(join(tmpdir(), 'otto-wt-')); writeFileSync(join(d, '.git'), 'gitdir: x'); return d }
const remote = (repo: string, name = 'origin') => `${name}\thttps://github.com/${repo}.git (fetch)\n${name}\thttps://github.com/${repo}.git (push)`

function fakeT3(root: string): T3 & { snaps: Map<string, ThreadSnap>; sent: [string, string][]; answered: [string, string][]; interrupted: string[]; pending: boolean; worktree?: string } {
  const f = {
    snaps: new Map<string, ThreadSnap>(), sent: [] as [string, string][], answered: [] as [string, string][], interrupted: [] as string[], pending: false, worktree: undefined as string | undefined,
    projects: async () => [{ id: 'p1', name: 'demo', root }],
    threads: async (ids: string[]) => new Map(ids.map(id => [id, f.snaps.get(id) ?? { id, status: 'gone' as const }])),
    launch: async (o: { branch: string; model?: string }) => { f.snaps.set('t1', { id: 't1', status: 'running', now: 'Reading', tokensUsed: 10 }); return { threadId: 't1', branch: o.branch, model: modelLabel(o.model) ?? 'Opus 5.5', ...(f.worktree ? { worktreePath: f.worktree } : {}) } },
    send: async (id: string, text: string) => { f.sent.push([id, text]) },
    answer: async (id: string, text: string) => { if (!f.pending) return false; f.answered.push([id, text]); return true },
    interrupt: async (id: string) => { f.interrupted.push(id) },
  }
  return f
}
const PR = { number: 7, title: 'Fix it', url: 'https://github.com/example/demo/pull/7', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', baseRefName: 'main', additions: 3, deletions: 1, changedFiles: 1,
  statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], body: '| Delegate | Round 1 |\n| --- | --- |\n| Claude Opus | 9/10 |' }

function setup(o: { now?: () => number; attention?: (jobs: WireJob[], records: CodeJob[]) => Promise<void> } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'otto-codejobs-')), 'code-jobs.json')
  const root = checkout()
  const gh: Gh = { calls: [], remotes: { [root]: remote('example/demo') } }
  const t3 = fakeT3(root)
  const pushed: WireJobs[] = []
  const jobs = new CodeJobs({ file, t3, slots: async () => { const s = await slotSnapshot(dirname(file)); s.mac.load = 0; return s }, exec: fakeGh(gh), push: w => pushed.push(w), ...o })
  return { file, gh, t3, pushed, jobs, root }
}
const call = (jobs: CodeJobs, path: string, body?: unknown) =>
  jobs.handle(new Request(`http://x${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), path)

test('start records the thread, branch and repo, and pushes the new list', async () => {
  const { file, t3, pushed, jobs } = setup()
  const launch = spyOn(t3, 'launch')
  const j = await jobs.start({ project: 'Demo', title: 'Fix the thing', brief: 'fix it', note: 'you asked at 09:00' })
  expect(j).toMatchObject({ state: 'running', project: 'demo', agent: 'T3 Code', where: 'local', model: 'Opus 5.5', now: 'Reading', tokensUsed: 10, pr: null })
  expect(launch.mock.calls[0]![0].brief).toStartWith('fix it\n\n')
  expect(launch.mock.calls[0]![0].brief).toContain('bun run test:changed')
  expect(launch.mock.calls[0]![0].brief).toContain('PR.md at the worktree root')
  expect(launch.mock.calls[0]![0].brief).toContain('/otto/slots.ts run --name')
  expect(j.branch).toMatch(/^otto\/fix-the-thing-[0-9a-f]{6}$/)
  expect(j.steps.map(s => s.text)).toEqual(['Handed off to T3 Code', 'Created worktree'])
  expect(loadCodeJobs(file)[0]).toMatchObject({ threadId: 't1', repo: 'example/demo', projectId: 'p1', brief: launch.mock.calls[0]![0].brief })
  expect(pushed.at(-1)!.jobs).toHaveLength(1)
  await expect(jobs.start({ project: 'nope', title: 'x', brief: 'y' })).rejects.toThrow('no T3 project "nope" — known: demo')
  await expect(jobs.start({ project: 'demo', title: ' ', brief: 'y' })).rejects.toThrow('required')
  expect(t3.snaps.size).toBe(1)
})

test('rename persists in snapshots and pushes after T3 refresh and restart', async () => {
  const { file, t3, pushed, jobs } = setup()
  saveCodeJobs(file, [job()])
  t3.snaps.set('t1', { id: 't1', status: 'running' })
  const response = await call(jobs, '/app/jobs/rename', { id: 'j1', title: '  New title  ' })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ title: 'New title' })
  expect(pushed.at(-1)!.jobs[0]!.title).toBe('New title')
  await jobs.poll()
  expect((await jobs.snapshot()).jobs[0]!.title).toBe('New title')
  const restarted = new CodeJobs({ file, t3, exec: fakeGh({ calls: [], remotes: {} }) })
  expect((await restarted.snapshot()).jobs[0]!.title).toBe('New title')
  expect(loadCodeJobs(file)[0]!.title).toBe('New title')
  for (const title of ['', '   ', 'x'.repeat(201), 123, null]) {
    expect((await call(jobs, '/app/jobs/rename', { id: 'j1', title })).status).toBe(400)
  }
  expect((await call(jobs, '/app/jobs/rename', { id: 'j1', title: 'x'.repeat(200) })).status).toBe(200)
  expect((await call(jobs, '/app/jobs/rename', { id: 'missing', title: 'New' })).status).toBe(404)
})

test('rename also updates the title shown by jobs waiting for it', async () => {
  const { file, jobs } = setup()
  saveCodeJobs(file, [job(), job({ id: 'j2', threadId: undefined, after: 'j1', afterTitle: 'Fix the thing' })])
  await jobs.rename('j1', 'New title')
  expect(loadCodeJobs(file).find(j => j.id === 'j2')!.afterTitle).toBe('New title')
  expect((await jobs.snapshot()).jobs.find(j => j.id === 'j2')).toMatchObject({ afterTitle: 'New title', now: 'After New title' })
})

test('move persists after refresh and restart without moving the T3 project or checkout', async () => {
  const { file, t3, gh, pushed, jobs } = setup()
  const original = job({ projectId: 'p1', worktreePath: '/tmp/demo-worktree', path: '/tmp/demo' })
  saveCodeJobs(file, [original])
  t3.snaps.set('t1', { id: 't1', status: 'running' })
  const repoint = spyOn(t3, 'repoint'), launch = spyOn(t3, 'launch'), projects = spyOn(t3, 'projects')
  const response = await call(jobs, '/app/jobs/move', { id: 'j1', project: '  Any new project  ' })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ project: 'Any new project' })
  expect(pushed.at(-1)!.jobs[0]!.project).toBe('Any new project')
  await jobs.poll()
  expect((await jobs.snapshot()).jobs[0]!.project).toBe('Any new project')
  const restarted = new CodeJobs({ file, t3, exec: fakeGh(gh) })
  expect((await restarted.snapshot()).jobs[0]!.project).toBe('Any new project')
  expect(loadCodeJobs(file)[0]).toMatchObject({ ...original, project: 'Any new project' })
  expect(repoint).not.toHaveBeenCalled()
  expect(launch).not.toHaveBeenCalled()
  expect(projects).not.toHaveBeenCalled()
  for (const project of ['', '  ', 123, null]) {
    expect((await call(jobs, '/app/jobs/move', { id: 'j1', project })).status).toBe(400)
  }
  expect((await call(jobs, '/app/jobs/move', { id: 'missing', project: 'demo' })).status).toBe(404)
})

test('delete stops a running job before permanently removing it and pushing the list', async () => {
  const { file, t3, pushed, jobs } = setup()
  saveCodeJobs(file, [job()])
  t3.snaps.set('t1', { id: 't1', status: 'running' })
  const stop = spyOn(jobs, 'stop')
  const response = await call(jobs, '/app/jobs/delete', { id: 'j1' })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
  expect(stop).toHaveBeenCalledWith('j1')
  expect(t3.interrupted).toEqual(['t1'])
  expect(loadCodeJobs(file)).toEqual([])
  expect(pushed.at(-1)!.jobs).toEqual([])
  await jobs.poll()
  expect((await jobs.snapshot()).jobs).toEqual([])
  const restarted = new CodeJobs({ file, t3 })
  expect((await restarted.snapshot()).jobs).toEqual([])
  expect((await call(jobs, '/app/jobs/delete', { id: 'j1' })).status).toBe(404)
})

test('delete never waits on a job that already ended or on an interrupt that hangs', async () => {
  const { file, t3, jobs } = setup()
  jobs.stopWaitMs = 20
  const hang = spyOn(t3, 'interrupt').mockImplementation(() => new Promise(() => {}))
  saveCodeJobs(file, [job({ endedAt: '2026-01-01T00:00:00.000Z' })])
  expect((await call(jobs, '/app/jobs/delete', { id: 'j1' })).status).toBe(200)
  expect(hang).not.toHaveBeenCalled()   // ended: nothing to stop
  saveCodeJobs(file, [job()])
  expect((await call(jobs, '/app/jobs/delete', { id: 'j1' })).status).toBe(200)
  expect(hang).toHaveBeenCalledTimes(1)   // running: asked to stop, not waited on forever
  expect(loadCodeJobs(file)).toEqual([])
})

test('delete stops a queued job without launching it', async () => {
  const { file, t3, jobs } = setup()
  saveCodeJobs(file, [job({ threadId: undefined })])
  const stop = spyOn(jobs, 'stop'), launch = spyOn(t3, 'launch')
  expect((await call(jobs, '/app/jobs/delete', { id: 'j1' })).status).toBe(200)
  expect(stop).toHaveBeenCalledWith('j1')
  expect(t3.interrupted).toEqual([])
  expect(launch).not.toHaveBeenCalled()
  expect(loadCodeJobs(file)).toEqual([])
})

test('delete leaves an open PR and its branch alone, and accepts merged jobs', async () => {
  const { file, t3, gh, jobs } = setup()
  gh.pr = { ...PR }
  saveCodeJobs(file, [job({ prNumber: 7, prInfo: pr() })])
  t3.snaps.set('t1', { id: 't1', status: 'idle' })
  expect((await call(jobs, '/app/jobs/delete', { id: 'j1' })).status).toBe(200)
  expect(gh.pr).toEqual(PR)
  expect(gh.calls.every(cmd => !['close', 'merge', 'delete', 'push'].some(word => cmd.includes(word)))).toBe(true)
  expect(loadCodeJobs(file)).toEqual([])
  saveCodeJobs(file, [job({ mergedAt: new Date().toISOString() })])
  const interrupted = t3.interrupted.length
  expect((await call(jobs, '/app/jobs/delete', { id: 'j1' })).status).toBe(200)
  expect(t3.interrupted).toHaveLength(interrupted)
})

test('a snapshot already reading T3 cannot undo a rename, move or deletion', async () => {
  for (const action of ['rename', 'move', 'delete']) {
    const { file, t3, jobs } = setup()
    saveCodeJobs(file, [job()])
    const threads = t3.threads.bind(t3)
    let resume!: () => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { resume = resolve })
    let first = true
    t3.threads = async ids => {
      if (first) { first = false; started(); await gate }
      return threads(ids)
    }
    const stale = jobs.snapshot()
    await waiting
    expect((await call(jobs, `/app/jobs/${action}`, { id: 'j1', title: 'New title', project: 'New group' })).status).toBe(200)
    resume()
    const result = await stale
    if (action === 'delete') expect(result.jobs).toEqual([])
    else expect(result.jobs[0]).toMatchObject(action === 'rename' ? { title: 'New title' } : { project: 'New group' })
    expect(jobs.cached()).toEqual(result)
  }
})

test('the same code_job again soon after is the job it made, not a second thread', async () => {
  let now = Date.parse('2026-11-12T10:00:00Z')
  const { file, t3, jobs } = setup({ now: () => now })
  const launch = spyOn(t3, 'launch')
  const ask = { project: 'demo', title: 'Fix the thing', brief: 'fix it' }
  const first = await jobs.start(ask)
  // A reload cut the reply off; the session retries word for word.
  const again = await jobs.start({ ...ask, title: ' Fix the thing ' })
  expect(again).toMatchObject({ id: first.id, existing: true })
  expect(launch).toHaveBeenCalledTimes(1)
  // A different brief is a different job.
  expect((await jobs.start({ ...ask, brief: 'fix it differently' })).id).not.toBe(first.id)
  // Mid-launch when otto restarted: say so rather than start another.
  saveCodeJobs(file, loadCodeJobs(file).map(j => j.id === first.id ? { ...j, threadId: undefined, launchClaimedAt: new Date(now).toISOString() } : j))
  await expect(jobs.start(ask)).rejects.toThrow(`job [${first.id}] for this same request may already have a T3 Code thread`)
  // Past the window, or once it ended, the same words start a new job.
  now += 16 * 60_000
  const later = await jobs.start(ask)
  expect(later.existing).toBeUndefined()
  expect(launch).toHaveBeenCalledTimes(3)
  // A thread that failed is fair to ask for again straight away.
  t3.snaps.set('t1', { id: 't1', status: 'error' })
  expect((await jobs.snapshot()).jobs.find(j => j.id === later.id)?.state).toBe('failed')
  const retried = await jobs.start(ask)
  expect(retried.id).not.toBe(later.id)
  // ...and the retry is then the one a further retry finds, not the failed one before it.
  t3.snaps.set('t1', { id: 't1', status: 'running' })
  expect(await jobs.start(ask)).toMatchObject({ id: retried.id, existing: true })
  expect(launch).toHaveBeenCalledTimes(4)
  // Idle in its first minute is a thread T3 hasn't started running yet, not a finished one.
  t3.snaps.set('t1', { id: 't1', status: 'idle' })
  expect(await jobs.start(ask)).toMatchObject({ id: retried.id, existing: true })
  now += 61_000
  expect((await jobs.start(ask)).id).not.toBe(retried.id)
  expect(launch).toHaveBeenCalledTimes(5)
})

test('a launch that timed out may have a thread: the same request is not launched again', async () => {
  const { t3, jobs } = setup()
  const launch = spyOn(t3, 'launch').mockImplementation(async () => { throw new Error('T3 orchestration.launchThread timed out after 20 s (T3 Code may be busy)') })
  const ask = { project: 'demo', title: 'Fix the thing', brief: 'fix it' }
  await expect(jobs.start(ask)).rejects.toThrow('T3 may still have started it')
  await expect(jobs.start(ask)).rejects.toThrow('may already have a T3 Code thread')
  expect(launch).toHaveBeenCalledTimes(1)
  // The socket dropped during the launch call itself: the same.
  launch.mockImplementation(async () => { throw new Error('T3 orchestration.launchThread lost its connection: T3 Code closed the connection mid-request (did it restart?)') })
  await expect(jobs.start({ ...ask, title: 'Dropped' })).rejects.toThrow('T3 may still have started it')
  await expect(jobs.start({ ...ask, title: 'Dropped' })).rejects.toThrow('may already have a T3 Code thread')
  // Dropped before anything was sent: nothing to wait for.
  launch.mockImplementation(async () => { throw new Error('T3 Code closed the connection mid-request (did it restart?)') })
  await expect(jobs.start({ ...ask, title: 'Early' })).rejects.toThrow('closed the connection')
  await expect(jobs.start({ ...ask, title: 'Early' })).rejects.toThrow('closed the connection')
  expect(launch).toHaveBeenCalledTimes(4)
  launch.mockClear()
  // Refused outright (nothing reached T3): a retry is a new attempt.
  launch.mockImplementation(async () => { throw new Error('T3 Code refused the connection at http://127.0.0.1:1; is it running?') })
  await expect(jobs.start({ ...ask, title: 'Other thing' })).rejects.toThrow('refused')
  await expect(jobs.start({ ...ask, title: 'Other thing' })).rejects.toThrow('refused')
  expect(launch).toHaveBeenCalledTimes(2)
})

test('after a restart, a PR merged on GitHub is not read again', async () => {
  const { file, gh, t3 } = setup()
  const merged = pr({ state: 'MERGED', mergedAt: '2026-11-05T12:00:00Z' })
  saveCodeJobs(file, [job({ prNumber: 7, prInfo: merged, mergedAt: '2026-11-05T12:00:00Z', endedAt: '2026-11-05T12:00:00Z',
    steps: [{ ts: '2026-11-05T12:00:00Z', text: 'Merged PR #7', note: 'on GitHub' }] })])
  t3.snaps.set('t1', { id: 't1', status: 'idle' })
  gh.pr = { ...PR, state: 'MERGED', mergedAt: '2026-11-05T12:00:00Z', headRefName: 'fix/thing' }
  const booted = new CodeJobs({ file, t3, exec: fakeGh(gh), now: () => Date.parse('2026-11-06T12:00:00Z') })
  expect((await booted.snapshot()).jobs[0]).toMatchObject({ state: 'merged' })
  expect(gh.calls.filter(c => c[0] === 'gh' && c[1] === 'pr')).toHaveLength(0)
})

test('overlapping reads record a new PR once and share one GitHub read', async () => {
  const { file, gh, t3, jobs } = setup()
  const j = await jobs.start({ project: 'demo', title: 'Fix', brief: 'b', branch: 'fix/x' })
  t3.snaps.set('t1', { id: 't1', status: 'idle' })
  gh.pr = PR
  gh.calls.length = 0
  // The app's /app/jobs, the 20 s poll and code_jobs all landing while gh is slow.
  await Promise.all([...Array.from({ length: 5 }, () => jobs.snapshot()), jobs.snapshot({ fresh: j.id })])
  expect(loadCodeJobs(file)[0]!.steps.filter(s => s.text === 'Opened PR #7')).toHaveLength(1)
  expect(gh.calls.filter(c => c[1] === 'pr' && c[2] === 'view').length).toBeLessThanOrEqual(2)
})

test('a PR on the branch makes it review, with checks, diff and council; merge squashes it server-side', async () => {
  const { file, gh, t3, jobs } = setup()
  const j = await jobs.start({ project: 'demo', title: 'Fix', brief: 'b', branch: 'fix/x' })
  t3.snaps.set('t1', { id: 't1', status: 'idle', tokensUsed: 5000 })
  gh.pr = PR
  const r = await (await call(jobs, '/app/jobs')).json() as WireJobs
  const card = r.jobs[0]!
  expect(card).toMatchObject({ state: 'review', tokensUsed: 5000, council: [{ round: 1, scores: { Opus: 9 }, fixes: [] }] })
  expect(card.pr).toMatchObject({ n: 7, mergeable: 'MERGEABLE', base: 'main', add: 3, del: 1, files: 1, checks: 'Check passing', draft: false, diff: [{ file: 'x.ts', lines: [['-', 'a'], ['+', 'b']] }] })
  expect(card.steps.map(s => s.text)).toContain('Opened PR #7')
  expect(r.usage).toMatchObject({ jobsToday: 1, tokensToday: 5000, tokenBudget: 4_000_000 })

  // gh refuses (say, checks required): the job stays in review and the app hears why.
  const refused = await call(jobs, '/app/jobs/merge', { id: j.id })
  expect(refused.status).toBe(502)
  expect(loadCodeJobs(file)[0]!.mergedAt).toBeUndefined()

  gh.mergeOk = true
  const merged = await (await call(jobs, '/app/jobs/merge', { id: j.id })).json() as any
  expect(merged).toMatchObject({ id: j.id, state: 'merged', tokensUsed: 5000, pr: null })
  expect(gh.calls.filter(c => c[2] === 'merge').at(-1)).toEqual(['gh', 'pr', 'merge', '7', '--repo', 'example/demo', '--squash'])
  expect(merged.steps.at(-1)).toMatchObject({ text: 'Merged PR #7', note: 'you, from the app' })
  // Merging twice is not an error and does nothing more.
  const n = gh.calls.filter(c => c[2] === 'merge').length
  expect((await call(jobs, '/app/jobs/merge', { id: j.id })).status).toBe(200)
  expect(gh.calls.filter(c => c[2] === 'merge').length).toBe(n)
})

test('a merged job freezes its price tag: tokens and the weekly window delta, logged for the rollup', async () => {
  const { file, gh, t3, jobs } = setup()
  const plan = (pct: number) => writeFileSync(join(dirname(file), 'plan-usage.json'), JSON.stringify({ at: Date.now(), seven_day: { used_percentage: pct, resets_at: Math.floor(Date.now() / 1000) + 86_400 } }))
  plan(40)
  const j = await jobs.start({ project: 'demo', title: 'Fix', brief: 'b', branch: 'fix/x' })
  t3.snaps.set('t1', { id: 't1', status: 'idle', tokensUsed: 2_100_000 })
  gh.pr = PR
  expect((await (await call(jobs, '/app/jobs')).json() as WireJobs).jobs[0]!.cost).toBeUndefined()
  plan(43)
  gh.mergeOk = true
  const merged = await (await call(jobs, '/app/jobs/merge', { id: j.id })).json() as any
  expect(merged.cost).toBe('2.1M Claude tokens · ~3% of the week')
  expect(jobs.cost(loadCodeJobs(file)[0]!)).toBe('2.1M Claude tokens · ~3% of the week')
  plan(60) // later readings never move a finished job's share
  expect(jobs.cost(loadCodeJobs(file)[0]!)).toBe('2.1M Claude tokens · ~3% of the week')
  expect(JSON.parse(readFileSync(join(dirname(file), 'job-costs.jsonl'), 'utf8'))).toMatchObject({ id: j.id, title: 'Fix', model: 'Opus 5.5', tokens: 2_100_000, share: 3 })
})

test('merge refuses a draft or a missing PR', async () => {
  const { gh, jobs } = setup()
  const j = await jobs.start({ project: 'demo', title: 'Fix', brief: 'b' })
  const none = await call(jobs, '/app/jobs/merge', { id: j.id })
  expect(none.status).toBe(409)
  expect(((await none.json()) as any).error).toBe('no PR on this branch yet')
  gh.pr = { ...PR, isDraft: true }
  expect((await call(jobs, '/app/jobs/merge', { id: j.id })).status).toBe(409)
  expect(gh.calls.some(c => c[2] === 'merge')).toBe(false)
})

test('answer goes to the pending question, else as a message; steer is a message; stop interrupts', async () => {
  const { t3, jobs } = setup()
  const j = await jobs.start({ project: 'demo', title: 'Fix', brief: 'b' })
  t3.snaps.set('t1', { id: 't1', status: 'input', question: { text: 'Which?', answers: ['A', 'B'], askedAt: '2026-11-05T10:00:00.000Z' } })
  t3.pending = true
  const a = await (await call(jobs, '/app/jobs/answer', { id: j.id, text: 'A' })).json() as any
  expect(t3.answered).toEqual([['t1', 'A']])
  expect(a.steps.at(-1)).toMatchObject({ text: 'You answered', note: 'A' })
  t3.pending = false
  await call(jobs, '/app/jobs/answer', { id: j.id, text: 'B then' })
  await call(jobs, '/app/jobs/steer', { id: j.id, text: 'use the helper in x.ts' })
  expect(t3.sent).toEqual([['t1', 'B then'], ['t1', 'use the helper in x.ts']])
  expect((await call(jobs, '/app/jobs/steer', { id: j.id, text: '  ' })).status).toBe(400)

  const s = await (await call(jobs, '/app/jobs/stop', { id: j.id })).json() as any
  expect(s.state).toBe('stopped')
  expect(t3.interrupted).toEqual(['t1'])
  expect((await call(jobs, '/app/jobs/steer', { id: j.id, text: 'more' })).status).toBe(409)
})

test('routes: bad method, unknown action, missing id, unknown job', async () => {
  const { jobs } = setup()
  expect((await jobs.handle(new Request('http://x/app/jobs', { method: 'POST' }), '/app/jobs')).status).toBe(405)
  expect((await call(jobs, '/app/jobs/explode', {})).status).toBe(404)
  expect((await jobs.handle(new Request('http://x/app/jobs/stop'), '/app/jobs/stop')).status).toBe(405)
  expect((await call(jobs, '/app/jobs/stop', {})).status).toBe(400)
  expect((await call(jobs, '/app/jobs/stop', { id: 'jzzz' })).status).toBe(404)
})

test('poll pushes only when something changed; a PR merged on GitHub ends the job', async () => {
  const { file, gh, t3, pushed, jobs } = setup()
  await jobs.start({ project: 'demo', title: 'Fix', brief: 'b' })
  const n = pushed.length
  await jobs.poll()
  expect(pushed.length).toBe(n)
  t3.snaps.set('t1', { id: 't1', status: 'running', now: 'bun test', tokensUsed: 10 })
  await jobs.poll()
  expect(pushed.length).toBe(n + 1)
  expect(pushed.at(-1)!.jobs[0]!.now).toBe('bun test')
  gh.pr = { ...PR, state: 'MERGED', mergedAt: '2026-11-05T12:00:00Z' }
  t3.snaps.set('t1', { id: 't1', status: 'idle', tokensUsed: 10 })
  await jobs.poll()
  expect(pushed.at(-1)!.jobs[0]).toMatchObject({ state: 'merged', endedAt: '2026-11-05T12:00:00Z' })
  expect(loadCodeJobs(file)[0]).toMatchObject({ mergedAt: '2026-11-05T12:00:00Z', tokensUsed: 10 })
  expect(readFileSync(file, 'utf8')).toContain('on GitHub')
})

// A job: the T3 project's folder sat inside a repo with no GitHub remote, so start() kept no
// repo; the agent opened its PR in the repo it really worked in and T3 linked it to the thread.
// It showed as "Asked you something" with its final report as the question and no merge button.
test('a job with no repo finds its PR through the thread: review, PR card, merge on that repo', async () => {
  const { file, gh, t3, jobs } = setup()
  gh.remotes = {} // the project folder's repo has no remotes at all
  const j = await jobs.start({ project: 'demo', title: 'Job cards in the chat thread', brief: 'b', branch: 'feat/chat-job-cards' })
  expect(loadCodeJobs(file)[0]!.repo).toBeUndefined()
  const report = 'Opened https://github.com/example/core/pull/40 against main.\n\nFull suite: 1800 pass, 0 fail. Not merged.'
  t3.snaps.set('t1', { id: 't1', status: 'idle', branch: 'feat/chat-job-cards', lastMessage: report, pr: { repo: 'example/core', n: 40 } })
  gh.pr = { ...PR, headRefName: 'feat/chat-job-cards', number: 40, url: 'https://github.com/example/core/pull/40', body: '' }
  const card = ((await (await call(jobs, '/app/jobs')).json()) as WireJobs).jobs[0]!
  expect(card).toMatchObject({ state: 'review', question: null, pr: { n: 40 } })
  expect(gh.calls).toContainEqual(expect.arrayContaining(['pr', 'view', '40', '--repo', 'example/core']))
  expect(loadCodeJobs(file)[0]).toMatchObject({ repo: 'example/core', prNumber: 40 })
  gh.mergeOk = true
  expect(await (await call(jobs, '/app/jobs/merge', { id: j.id })).json()).toMatchObject({ state: 'merged' })
  expect(gh.calls.filter(c => c[2] === 'merge').at(-1)).toEqual(['gh', 'pr', 'merge', '40', '--repo', 'example/core', '--squash'])
})

test('no repo and no link: a PR URL in the last message, else a lone open PR on the branch', async () => {
  const { file, gh, t3, jobs } = setup()
  gh.remotes = {}
  await jobs.start({ project: 'demo', title: 'One', brief: 'b', branch: 'feat/one' })
  t3.snaps.set('t1', { id: 't1', status: 'idle', lastMessage: 'Done: https://github.com/example/core/pull/40' })
  gh.pr = { ...PR, number: 40, headRefName: 'feat/one' }
  expect(((await (await call(jobs, '/app/jobs')).json()) as WireJobs).jobs[0]).toMatchObject({ state: 'review', pr: { n: 40 } })
  expect(loadCodeJobs(file)[0]).toMatchObject({ repo: 'example/core', prNumber: 40 })

  const b = setup()
  b.gh.remotes = {}
  await b.jobs.start({ project: 'demo', title: 'Two', brief: 'b', branch: 'feat/two' })
  b.t3.snaps.set('t1', { id: 't1', status: 'idle', lastMessage: 'Pushed and opened the PR.' })
  b.gh.search = [{ repository: { nameWithOwner: 'example/core' }, number: 41 }]
  b.gh.pr = { ...PR, number: 41, headRefName: 'feat/two' }
  expect(((await (await call(b.jobs, '/app/jobs')).json()) as WireJobs).jobs[0]).toMatchObject({ state: 'review', pr: { n: 41 } })
  expect(b.gh.calls).toContainEqual(['gh', 'search', 'prs', '--head', 'feat/two', '--author', '@me', '--state', 'open', '--json', 'repository,number'])
  expect(loadCodeJobs(b.file)[0]).toMatchObject({ repo: 'example/core', prNumber: 41 })
})

test('repoFromRemotes picks like T3 Code: fetch URLs, upstream, then origin, then by name; GitHub only', () => {
  expect(repoFromRemotes(remote('me/fork') + '\n' + remote('example/core', 'upstream'))).toBe('example/core')
  expect(repoFromRemotes('b\tgit@github.com:example/b.git (fetch)\na\tssh://git@github.com/example/a (fetch)')).toBe('example/a')
  expect(repoFromRemotes('origin\thttps://gitlab.com/example/x.git (fetch)\nzed\thttps://github.com/example/z.git (fetch)')).toBe('example/z')
  expect(repoFromRemotes('origin\thttps://github.com/example/x.git (push)')).toBeUndefined()
  expect(repoFromRemotes('local\t/tmp/local-repo (fetch)')).toBeUndefined()
  expect(repoFromRemotes(undefined)).toBeUndefined()
})

test('start: a given repo is kept and never re-read; a path names it by its remote; bad ones are refused', async () => {
  const a = setup()
  a.gh.remotes = {}
  await a.jobs.start({ project: 'demo', title: 'A', brief: 'b', branch: 'feat/a', repo: 'example/core' })
  expect(loadCodeJobs(a.file)[0]).toMatchObject({ repo: 'example/core', repoGiven: true })
  a.t3.snaps.set('t1', { id: 't1', status: 'running', worktreePath: checkout() })
  await call(a.jobs, '/app/jobs')
  expect(a.gh.calls.filter(c => c[0] === 'git' && c[1] === 'remote' && c[2] === '-v')).toEqual([])

  const b = setup()
  const path = checkout()
  b.gh.remotes[path] = remote('example/core')
  await b.jobs.start({ project: 'demo', title: 'B', brief: 'b', branch: 'feat/b', path })
  expect(loadCodeJobs(b.file)[0]).toMatchObject({ repo: 'example/core', path })

  await expect(b.jobs.start({ project: 'demo', title: 'C', brief: 'b', repo: 'not a repo' })).rejects.toThrow('owner/name')
  await expect(b.jobs.start({ project: 'demo', title: 'C', brief: 'b', path: 'relative/dir' })).rejects.toThrow('absolute')
})

test('the worktree names the repo over the project folder, re-read until a PR pins it; old jobs backfill', async () => {
  let clock = Date.parse('2026-11-05T12:00:00Z')
  const { file, gh, t3, jobs, root } = setup({ now: () => clock })
  const wt = checkout()
  t3.worktree = wt
  gh.remotes = { [root]: remote('example/projects'), [wt]: remote('example/core') }
  await jobs.start({ project: 'demo', title: 'A', brief: 'b', branch: 'feat/a' })
  expect(loadCodeJobs(file)[0]!.repo).toBe('example/core')

  // An old job: kept the project folder's repo, before worktrees were read.
  saveCodeJobs(file, loadCodeJobs(file).map(j => ({ ...j, repo: 'example/projects' })))
  t3.snaps.set('t1', { id: 't1', status: 'running', worktreePath: wt })
  clock += 61_000
  await call(jobs, '/app/jobs')
  expect(loadCodeJobs(file)[0]!.repo).toBe('example/core')

  // The agent repoints its remote mid-run: the next refresh follows it.
  gh.remotes[wt] = remote('example/core-next', 'upstream') + '\n' + remote('example/core')
  clock += 121_000
  await call(jobs, '/app/jobs')
  expect(loadCodeJobs(file)[0]!.repo).toBe('example/core-next')

  // Its PR turns up: repo and number are pinned and the remote isn't read again.
  t3.snaps.set('t1', { id: 't1', status: 'idle', worktreePath: wt, lastMessage: 'Opened the PR.' })
  gh.pr = { ...PR, number: 12 }
  clock += 61_000
  expect(((await (await call(jobs, '/app/jobs')).json()) as WireJobs).jobs[0]).toMatchObject({ state: 'review', pr: { n: 12 } })
  expect(loadCodeJobs(file)[0]).toMatchObject({ repo: 'example/core-next', prNumber: 12 })
  const reads = gh.calls.filter(c => c[0] === 'git').length
  gh.remotes[wt] = remote('example/elsewhere')
  clock += 61_000
  await call(jobs, '/app/jobs')
  expect(gh.calls.filter(c => c[0] === 'git').length).toBe(reads)
  expect(loadCodeJobs(file)[0]!.repo).toBe('example/core-next')
})

 test('merge uses the repository discovered during its fresh PR lookup', async () => {
  const { file, gh, jobs } = setup()
  const path = checkout()
  gh.remotes[path] = remote('example/correct')
  saveCodeJobs(file, [job({ repo: 'example/old', path, prNumber: undefined })])
  gh.pr = { ...PR, number: 12 }
  gh.mergeOk = true
  await jobs.merge('j1')
  expect(gh.calls.filter(c => c[2] === 'merge').at(-1)).toEqual(['gh', 'pr', 'merge', '12', '--repo', 'example/correct', '--squash'])
 })

test('idle waiting jobs never turn their progress into a question', () => {
  for (const lastMessage of ['Waiting on the run.', 'Waiting for the build.', "I'm waiting on CI.", 'Running in the background.', "I'll check back."]) {
    expect(wireJob(job({ id: 'j12ebab' }), { id: 't1', status: 'idle', lastMessage }, undefined))
      .toMatchObject({ state: 'waiting', now: lastMessage, question: null, endedAt: null })
  }
  expect(wireJob(job(), { id: 't1', status: 'idle', backgroundWork: 'Waiting on the build', lastMessage: 'Working.' }, undefined))
    .toMatchObject({ state: 'waiting', now: 'Waiting on the build', question: null })
  for (const lastMessage of ['Which option should I use?', 'Waiting on the build. Should I retry?', 'Waiting for your approval.', 'Waiting on CI. Please confirm the target.']) {
    expect(wireJob(job(), { id: 't1', status: 'idle', lastMessage }, undefined).state).toBe('input')
  }
  const question = { text: 'Keep both rows?', answers: ['Yes', 'No'], askedAt: 'now' }
  expect(wireJob(job(), { id: 't1', status: 'input', backgroundWork: 'Waiting on the build', lastMessage: 'Waiting on the run.', question }, undefined))
    .toMatchObject({ state: 'input', question })
  expect(wireJob(job(), { id: 't1', status: 'idle', backgroundWork: 'Waiting on the build' }, pr()).state).toBe('review')
  expect(wireJob(job(), { id: 't1', status: 'running', backgroundWork: 'Waiting on the build' }, undefined).state).toBe('running')
  expect(wireJob(job(), { id: 't1', status: 'error', lastMessage: 'Waiting on the run.' }, undefined).state).toBe('failed')
})


test('wire jobs expose the agent thread even when finished, and null before launch', () => {
  expect(wireJob(job(), { id: 't1', status: 'idle' }, undefined))
    .toMatchObject({ threadId: 't1', threadUrl: t3ThreadUrl('t1') })
  expect(wireJob(job({ stoppedAt: '2026-11-05T12:00:00Z' }), undefined, undefined))
    .toMatchObject({ threadId: 't1', threadUrl: t3ThreadUrl('t1') })
  expect(wireJob(job({ threadId: undefined }), undefined, undefined))
    .toMatchObject({ threadId: null, threadUrl: null })
})


test('steer answers a pending T3 request, falling back to a message only without one', async () => {
  const { file, t3, jobs } = setup()
  const j = await jobs.start({ project: 'demo', title: 'Fix', brief: 'b' })
  t3.pending = true
  const answered = await (await call(jobs, '/app/jobs/steer', { id: j.id, text: '  Keep both  ' })).json() as WireJob
  expect(t3.answered).toEqual([['t1', 'Keep both']])
  expect(t3.sent).toEqual([])
  expect(answered.steps.at(-1)).toMatchObject({ text: 'You answered it', note: 'Keep both' })
  expect(loadCodeJobs(file)[0]!.steps.at(-1)).toMatchObject({ text: 'You answered it', note: 'Keep both' })

  t3.pending = false
  const steered = await (await call(jobs, '/app/jobs/steer', { id: j.id, text: '  Also update the README  ' })).json() as WireJob
  expect(t3.answered).toEqual([['t1', 'Keep both']])
  expect(t3.sent).toEqual([['t1', 'Also update the README']])
  expect(steered.steps.at(-1)).toMatchObject({ text: 'You steered it', note: 'Also update the README' })
  expect(loadCodeJobs(file)[0]!.steps.at(-1)).toMatchObject({ text: 'You steered it', note: 'Also update the README' })
})


test('an active turn wins over PR closure, while explicit stop and merge still win', () => {
  for (const state of ['MERGED', 'CLOSED'] as const) {
    const info = pr({ state, mergedAt: state === 'MERGED' ? '2026-11-05T12:00:00Z' : undefined })
    expect(wireJob(job(), { id: 't1', status: 'running' }, info)).toMatchObject({ state: 'running', endedAt: null })
    expect(wireJob(job(), { id: 't1', status: 'input', activeTurn: true }, info).state).toBe('input')
  }
  expect(wireJob(job({ stoppedAt: 'now' }), { id: 't1', status: 'running' }, pr()).state).toBe('stopped')
  expect(wireJob(job({ mergedAt: 'now' }), { id: 't1', status: 'running' }, pr()).state).toBe('merged')
})

test('j2dcd76-shaped merge and reviewer jobs ignore another job’s linked PR in every state', async () => {
  for (const state of ['OPEN', 'MERGED', 'CLOSED']) {
    const { file, gh, t3, jobs } = setup()
    saveCodeJobs(file, [job({ id: 'j2dcd76', branch: 'review-and-merge' }), job({ id: 'j61349d', threadId: 'other-thread', branch: 'feat/other' })])
    gh.pr = { ...PR, state, headRefName: 'feat/other', mergedAt: state === 'MERGED' ? '2026-11-05T12:00:00Z' : undefined }
    t3.snaps.set('t1', { id: 't1', status: 'running', now: 'Reviewing the next job', pr: { repo: 'example/demo', n: 7, openedByThread: true } })
    const card = (await jobs.snapshot()).jobs.find(j => j.id === 'j2dcd76')!
    expect(card).toMatchObject({ state: 'running', pr: null, question: null, endedAt: null })
    const saved = loadCodeJobs(file).find(j => j.id === 'j2dcd76')!
    expect([saved.prNumber, saved.mergedAt, saved.stoppedAt]).toEqual([undefined, undefined, undefined])
    t3.snaps.set('t1', { id: 't1', status: 'idle', lastMessage: 'Reviewed and merged the other jobs.', pr: { repo: 'example/demo', n: 7 } })
    expect((await jobs.snapshot()).jobs.find(j => j.id === 'j2dcd76')).toMatchObject({ state: 'done', pr: null, question: null })
  }
})

test('an unrelated linked or mentioned PR needs branch ownership or proof of creation', async () => {
  for (const openedByThread of [false, true]) {
    const { file, gh, t3, jobs } = setup()
    saveCodeJobs(file, [job()])
    gh.pr = { ...PR, headRefName: 'feat/another-branch' }
    t3.snaps.set('t1', { id: 't1', status: 'idle', lastMessage: 'Looked at https://github.com/example/demo/pull/7', pr: { repo: 'example/demo', n: 7, openedByThread } })
    expect((await jobs.snapshot()).jobs[0]!.pr?.n ?? null).toBe(openedByThread ? 7 : null)
    expect(loadCodeJobs(file)[0]!.prNumber).toBe(openedByThread ? 7 : undefined)
    if (openedByThread) {
      // The creation proof survives a fresh merge lookup without a thread snapshot.
      gh.mergeOk = true
      expect((await jobs.merge('j1')).state).toBe('merged')
    }
  }
})

test('a foreign latest link cannot hide a PR on the worktree branch', async () => {
  for (const ownLinked of [false, true]) {
    const { file, gh, t3, jobs } = setup()
    saveCodeJobs(file, [job({ branch: 'original-branch' })])
    gh.prs = [{ ...PR, number: 99, headRefName: 'unrelated-branch' }, { ...PR, headRefName: 'actual-worktree-branch' }]
    t3.snaps.set('t1', { id: 't1', status: 'idle', branch: 'actual-worktree-branch', prs: [{ repo: 'example/demo', n: 99 }, ...(ownLinked ? [{ repo: 'example/demo', n: 7 }] : [])] })
    expect((await jobs.snapshot()).jobs[0]).toMatchObject({ state: 'review', pr: { n: 7 }, branch: 'actual-worktree-branch' })
  }
})

test('an own PR merged during a turn is persisted as complete only after the turn ends', async () => {
  const { file, gh, t3, jobs } = setup()
  saveCodeJobs(file, [job()])
  gh.pr = { ...PR, headRefName: 'fix/thing', state: 'MERGED', mergedAt: '2026-11-05T12:00:00Z' }
  t3.snaps.set('t1', { id: 't1', status: 'running' })
  expect((await jobs.snapshot()).jobs[0]).toMatchObject({ state: 'running', endedAt: null })
  expect(loadCodeJobs(file)[0]!.mergedAt).toBeUndefined()
  t3.snaps.set('t1', { id: 't1', status: 'idle' })
  expect((await jobs.snapshot()).jobs[0]).toMatchObject({ state: 'merged', pr: null })
  expect(loadCodeJobs(file)[0]!.mergedAt).toBe('2026-11-05T12:00:00Z')
})

test('a job incorrectly finished by a foreign PR is revalidated after the fix', async () => {
  const { file, gh, t3, jobs } = setup({ now: () => Date.parse('2026-11-06T12:00:00Z') })
  saveCodeJobs(file, [job({ id: 'j2dcd76', branch: 'review-jobs', prNumber: 7, mergedAt: '2026-11-05T12:00:00Z', endedAt: '2026-11-05T12:00:00Z', steps: [{ ts: '2026-11-05T12:00:00Z', text: 'Merged PR #7', note: 'on GitHub' }] }), job({ id: 'j61349d', threadId: 'other-thread', branch: 'feat/other' })])
  gh.pr = { ...PR, headRefName: 'feat/other', state: 'MERGED' }
  t3.snaps.set('t1', { id: 't1', status: 'running' })
  expect((await jobs.snapshot()).jobs.find(j => j.id === 'j2dcd76')).toMatchObject({ state: 'running', pr: null, endedAt: null })
  const saved = loadCodeJobs(file).find(j => j.id === 'j2dcd76')!
  expect([saved.prNumber, saved.mergedAt, saved.stoppedAt, saved.endedAt]).toEqual([undefined, undefined, undefined, undefined])
})

test('full PR detail rejects a foreign stale pin using the same ownership rules as job cards', async () => {
  const { file, gh, t3, jobs } = setup()
  saveCodeJobs(file, [job({ branch: 'review-jobs', prNumber: 7 })])
  gh.pr = { ...PR, headRefName: 'unrelated-branch' }
  t3.snaps.set('t1', { id: 't1', status: 'idle' })
  const response = await jobs.handle(new Request('http://localhost/app/jobs/pr?id=j1'), '/app/jobs/pr')
  expect(response.status).toBe(404)
  expect(loadCodeJobs(file)[0]!.prNumber).toBeUndefined()
  expect(gh.calls.some(c => c[1] === 'api')).toBe(false)
})

// Sanitized copies of the seven live records, including stale repository/branch metadata.
import after43 from './fixtures/codejobs-after-43.json'
const realJobs = after43 as CodeJob[]
const realJob = (id: string) => structuredClone(realJobs.find(j => j.id === id)!)

for (const id of ['j61349d', 'j68e7f4']) {
  test(`${id}: a recorded stop survives stale GitHub history and any thread state`, async () => {
    const j = { ...realJob(id), stoppedAt: '2026-11-05T17:43:00Z' }
    for (const status of ['input', 'running', 'idle'] as const) {
      expect(wireJob(j, { id: j.threadId!, status }, pr({ state: 'MERGED' })).state).toBe('stopped')
    }
    const { file, t3, jobs } = setup({ now: () => Date.parse('2026-11-06T12:00:00Z') })
    saveCodeJobs(file, [j])
    t3.snaps.set(j.threadId!, { id: j.threadId!, status: 'input' })
    expect((await jobs.snapshot()).jobs[0]).toMatchObject({ state: 'stopped', question: null })
    expect(loadCodeJobs(file)[0]!.stoppedAt).toBe(j.stoppedAt)
  })
}

for (const id of ['j2dcd76', 'j2fe04b']) {
  test(`${id}: merging other jobs' PRs finishes without an owned PR`, async () => {
    const { file, gh, t3, jobs } = setup()
    const j = realJob(id)
    saveCodeJobs(file, [j, ...realJobs.filter(x => x.id !== id)])
    gh.prs = [{ ...PR, number: 11, headRefName: 'feat/pr-timeline', state: 'MERGED' },
      { ...PR, number: 10, headRefName: 'feat/composer-attach-mentions' }]
    t3.snaps.set(j.threadId!, { id: j.threadId!, status: 'idle', updatedAt: '2026-11-05T19:00:00Z',
      lastMessage: 'Reviewed and merged the ready PRs. Your remaining PR is blocked.',
      prs: [{ repo: 'example/demo-app', n: 11 }, { repo: 'example/demo-app', n: 10 }] })
    expect((await jobs.snapshot()).jobs.find(x => x.id === id)).toMatchObject({ state: 'done', pr: null, question: null, endedAt: '2026-11-05T19:00:00Z' })
  })
}

for (const [id, n, branch] of [['j8790b4', 4, 'feat/cmd-number-projects'], ['j2e29ca', 5, 'feat/usage-page'], ['j9b7417', 11, 'feat/pr-timeline']] as const) {
  test(`${id}: its merged branch PR is found despite continuation or stale repo metadata`, async () => {
    const { file, gh, t3, jobs, root } = setup()
    const j = realJob(id)
    saveCodeJobs(file, realJobs)
    gh.remotes[root] = remote('example/demo-app')
    gh.pr = { ...PR, number: n, headRefName: branch, state: 'MERGED', mergedAt: '2026-11-05T18:54:32Z' }
    t3.snaps.set(j.threadId!, { id: j.threadId!, status: 'idle', branch: id === 'j9b7417' ? branch : `${branch}-2`,
      worktreePath: root, lastMessage: 'Finished. Your changes are merged.' })
    expect((await jobs.snapshot()).jobs.find(x => x.id === id)).toMatchObject({ state: 'merged', question: null, pr: null })
    expect(loadCodeJobs(file).find(x => x.id === id)).toMatchObject({ repo: 'example/demo-app', prNumber: n, mergedAt: '2026-11-05T18:54:32Z' })
  })
}

test('idle reports and empty finished turns are done; real requests still need input', () => {
  for (const lastMessage of [undefined, '', 'Your changes are ready.', 'Please see the report above.', 'The approve button is fixed.']) {
    expect(wireJob(job(), { id: 't1', status: 'idle', lastMessage }, undefined)).toMatchObject({ state: 'done', question: null })
  }
  for (const lastMessage of ['Which target?', 'Please confirm the target.', 'Waiting for your approval.']) {
    expect(wireJob(job(), { id: 't1', status: 'idle', lastMessage, backgroundWork: 'Waiting on CI' }, pr()).state).toBe('input')
  }
})

test('a recorded merged PR on a shared continuation branch remains merged without a thread', async () => {
  const { file, gh, jobs } = setup()
  const j = { ...realJob('j8790b4'), prNumber: 4 }
  saveCodeJobs(file, [realJob('j61349d'), j])
  gh.pr = { ...PR, number: 4, headRefName: j.branch, state: 'MERGED', mergedAt: '2026-11-05T18:13:16Z' }
  expect((await jobs.snapshot()).jobs.find(x => x.id === j.id)).toMatchObject({ state: 'merged', question: null })
})


import { CommandError } from '../workspace.ts'

test('merge returns and logs trimmed gh stderr and exit status without tokens', async () => {
  const { file, gh, t3 } = setup()
  saveCodeJobs(file, [job()])
  gh.pr = PR
  const exec = fakeGh(gh)
  const fake = ['gh', 'p_'].join('') + 'x'.repeat(36)
  const opaque = ['private', 'value'].join('-')
  const jobs = new CodeJobs({ file, t3, exec: async (cmd, cwd) => {
    if (cmd[1] === 'pr' && cmd[2] === 'merge') {
      throw new CommandError(`  GraphQL: merge denied. Authorization: ${'Bearer ' + fake}\nGH_TOKEN=${opaque}\n` + 'details '.repeat(300), 9)
    }
    return exec(cmd, cwd)
  } })
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const response = await call(jobs, '/app/jobs/merge', { id: 'j1' })
    expect(response.status).toBe(502)
    const { error } = await response.json() as { error: string }
    expect(error).toContain('exit 9: GraphQL: merge denied.')
    expect(error).toContain('[redacted]')
    expect(error).not.toContain(fake)
    expect(error).not.toContain(opaque)
    expect(error.length).toBeLessThan(1300)
    expect(log).toHaveBeenCalledTimes(1)
    const logged = String(log.mock.calls[0]![0])
    expect(logged).toContain('exit 9: GraphQL: merge denied.')
    expect(logged).not.toContain(fake)
    expect(logged).not.toContain(opaque)
    expect(loadCodeJobs(file)[0]!.mergedAt).toBeUndefined()
  } finally { log.mockRestore() }
})

test('a timed-out merge reports the timeout, but accepts a confirmed merge on re-read', async () => {
  for (const merged of [false, true]) {
    const { file, gh, t3 } = setup()
    saveCodeJobs(file, [job()])
    gh.pr = PR
    const exec = fakeGh(gh)
    const jobs = new CodeJobs({ file, t3, exec: async (cmd, cwd) => {
      if (cmd[1] === 'pr' && cmd[2] === 'merge') {
        if (merged) gh.pr = { ...PR, state: 'MERGED' }
        throw new CommandError('', 143, true)
      }
      return exec(cmd, cwd)
    } })
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await call(jobs, '/app/jobs/merge', { id: 'j1' })
      expect(response.status).toBe(merged ? 200 : 502)
      if (merged) expect(await response.json()).toMatchObject({ state: 'merged' })
      else expect(await response.json()).toMatchObject({ error: 'gh could not merge PR #7: timed out after 60000 ms; exit 143: no stderr' })
    } finally { log.mockRestore() }
  }
})


test('merge refreshes conflicts and refuses without calling gh merge', async () => {
  const { gh, jobs } = setup()
  const j = await jobs.start({ project: 'demo', title: 'Fix', brief: 'b' })
  gh.pr = PR
  await jobs.snapshot({ fresh: j.id })
  gh.pr = { ...PR, mergeable: 'CONFLICTING', baseRefName: 'release/next' }
  const response = await call(jobs, '/app/jobs/merge', { id: j.id })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'PR #7 has merge conflicts with release/next' })
  expect(gh.calls.some(c => c[2] === 'merge')).toBe(false)
})

for (const stderr of ['Pull request is not mergeable', 'PR has merge conflicts', 'HTTP 503: service unavailable']) {
  test(`merge classifies gh stderr: ${stderr}`, async () => {
    const { file, gh, t3 } = setup()
    saveCodeJobs(file, [job()])
    gh.pr = { ...PR, mergeable: 'UNKNOWN' }
    const exec = fakeGh(gh)
    const jobs = new CodeJobs({ file, t3, exec: async (cmd, cwd) => {
      if (cmd[1] === 'pr' && cmd[2] === 'merge') throw new CommandError(stderr, 1)
      return exec(cmd, cwd)
    } })
    const response = await call(jobs, '/app/jobs/merge', { id: 'j1' })
    const conflict = stderr !== 'HTTP 503: service unavailable'
    expect(response.status).toBe(conflict ? 409 : 502)
    expect(await response.json()).toEqual({ error: conflict ? 'PR #7 has merge conflicts with main' : `gh could not merge PR #7: exit 1: ${stderr}` })
    expect(loadCodeJobs(file)[0]!.mergedAt).toBeUndefined()
  })
}

for (const pending of [false, true]) {
  test(`resolve resumes the review thread via ${pending ? 'answer' : 'send'}`, async () => {
    const { file, gh, t3, jobs } = setup({ now: () => Date.parse('2026-11-05T12:00:00Z') })
    saveCodeJobs(file, [job({ endedAt: '2026-11-05T11:00:00Z' })])
    gh.pr = { ...PR, mergeable: 'CONFLICTING', baseRefName: 'release/next' }
    t3.snaps.set('t1', { id: 't1', status: 'idle' })
    expect((await jobs.snapshot()).jobs[0]!.state).toBe('review')
    t3.pending = pending
    // T3 starts a new turn when the request is answered or the message arrives.
    const answer = t3.answer, send = t3.send
    t3.answer = async (...args) => {
      const answered = await answer(...args)
      if (answered) t3.snaps.set('t1', { id: 't1', status: 'running' })
      return answered
    }
    t3.send = async (...args) => {
      await send(...args)
      t3.snaps.set('t1', { id: 't1', status: 'running' })
    }
    const response = await call(jobs, '/app/jobs/resolve', { id: 'j1' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'j1', state: 'running', endedAt: null, steps: expect.arrayContaining([expect.objectContaining({ text: 'You asked it to resolve the conflicts' })]) })
    const messages = pending ? t3.answered : t3.sent
    expect(messages).toHaveLength(1)
    expect(messages[0]![0]).toBe('t1')
    for (const phrase of ['PR #7', 'example/demo', 'origin/release/next', 'fix/thing', 'intent of both sides', "project's tests", 'push to the same branch', 'Do not merge the PR']) expect(messages[0]![1]).toContain(phrase)
    expect(pending ? t3.sent : t3.answered).toEqual([])
    expect(gh.calls.some(c => c[2] === 'merge')).toBe(false)
    gh.pr = PR
    expect((await call(jobs, '/app/jobs/resolve', { id: 'j1' })).status).toBe(409)
    expect(messages).toHaveLength(1)
  })
}

test('resolve rejects a non-conflicting or absent PR without dispatching', async () => {
  for (const mergeable of ['MERGEABLE', 'UNKNOWN', undefined]) {
    const { file, gh, t3, jobs } = setup()
    saveCodeJobs(file, [job()])
    gh.pr = mergeable ? { ...PR, mergeable } : undefined
    expect((await call(jobs, '/app/jobs/resolve', { id: 'j1' })).status).toBe(409)
    expect(t3.sent).toEqual([])
    expect(t3.answered).toEqual([])
  }
})

test('wire PR exposes base and lazy mergeability from gh', async () => {
  for (const mergeable of ['MERGEABLE', 'CONFLICTING', 'UNKNOWN', undefined]) {
    const { file, gh, jobs } = setup()
    saveCodeJobs(file, [job()])
    gh.pr = { ...PR, mergeable, baseRefName: 'release/next' }
    const response = await call(jobs, '/app/jobs')
    expect(await response.json()).toMatchObject({ jobs: [{ pr: { mergeable: mergeable ?? 'UNKNOWN', base: 'release/next' } }] })
    const fields = gh.calls.find(c => c[2] === 'list')!.at(-1)!.split(',')
    expect(fields).toContain('mergeable')
    expect(fields).toContain('baseRefName')
  }
})


test('poll observes attention even when an action already refreshed the app snapshot', async () => {
  const observed: WireJob[][] = []
  const { jobs, t3 } = setup({ attention: async w => { observed.push(w) } })
  const j = await jobs.start({ project: 'demo', title: 'Fix', brief: 'b' })
  t3.snaps.set('t1', { id: 't1', status: 'input', question: { text: 'Which?', answers: ['A'], askedAt: 'now' } })
  await jobs.snapshot()
  await jobs.poll()
  await jobs.poll()
  expect(observed).toHaveLength(2)
  expect(observed[0]!.find(x => x.id === j.id)?.state).toBe('input')
})

test('a failed PR lookup (GitHub down) keeps the job in review instead of flipping it to done', async () => {
  let clock = Date.parse('2026-11-05T12:00:00Z')
  const { gh, t3, jobs } = setup({ now: () => clock })
  await jobs.start({ project: 'demo', title: 'Fix', brief: 'b', branch: 'fix/x' })
  t3.snaps.set('t1', { id: 't1', status: 'idle' })
  gh.pr = { ...PR, headRefName: 'fix/x' }
  expect((await (await call(jobs, '/app/jobs')).json() as WireJobs).jobs[0]).toMatchObject({ state: 'review', pr: { n: 7 } })
  gh.pr = undefined // every gh call now comes back empty, as when the API times out
  clock += 61_000
  expect((await (await call(jobs, '/app/jobs')).json() as WireJobs).jobs[0]).toMatchObject({ state: 'review', pr: { n: 7 } })
})

import { Github } from '../github.ts'
import { DEFAULT_GPT_MODEL } from '../jobs.ts'


test('GitHub reachability confirms failures, ignores a single blip, and recovers', async () => {
  let mode = 'blip'
  let now = 1000
  const github = new Github(async cmd => {
    if (mode === 'ok' || (mode === 'blip' && cmd[1] === 'api')) return '[]'
    return undefined
  }, () => now)
  await expect(github.run(['gh', 'pr', 'list'])).rejects.toThrow()
  expect(github.status).toEqual({ reachable: true })
  mode = 'down'
  await expect(github.run(['gh', 'pr', 'list'])).rejects.toThrow()
  expect(github.status).toMatchObject({ reachable: false, since: new Date(1000).toISOString() })
  now = 2000
  await expect(github.run(['gh', 'pr', 'list'])).rejects.toThrow()
  expect(github.status.since).toBe(new Date(1000).toISOString())
  mode = 'ok'
  now += 5 * 60_000
  await github.run(['gh', 'pr', 'list'])
  expect(github.status).toEqual({ reachable: true })
})

test('no PR and HTTP 404 are answers, not outages', async () => {
  const github = new Github(async cmd => {
    if (cmd[2] === 'list') return '[]'
    throw new CommandError('HTTP 404: Not Found', 1)
  })
  expect(await github.run(['gh', 'pr', 'list'])).toBe('[]')
  await expect(github.run(['gh', 'pr', 'view'])).rejects.toThrow('404')
  expect(github.status).toEqual({ reachable: true })
})

test('network errors and timeouts require a failed probe; auth errors do not', async () => {
  for (const failure of [new CommandError('error connecting to api.github.com', 1), new CommandError('', null, true)]) {
    const github = new Github(async () => { throw failure })
    await expect(github.run(['gh', 'pr', 'view'])).rejects.toThrow()
    expect(github.status.reachable).toBe(false)
  }
  let calls = 0
  const github = new Github(async () => { calls++; throw new CommandError('HTTP 401: Bad credentials', 1) })
  await expect(github.run(['gh', 'pr', 'view'])).rejects.toThrow()
  expect(github.status.reachable).toBe(true)
  expect(calls).toBe(1)
})

test('an outage still reports jobs without a PR, and only those', async () => {
  const { file, t3, gh } = setup()
  saveCodeJobs(file, [job({ prNumber: 7 }), job({ id: 'j2', threadId: 't2', branch: 'fix/other' })])
  t3.snaps.set('t1', { id: 't1', status: 'idle' })
  t3.snaps.set('t2', { id: 't2', status: 'idle' })
  gh.pr = { ...PR, headRefName: 'fix/thing' }   // j1's PR only
  let down = false, now = 1000
  const seen: string[][] = []
  const exec = fakeGh(gh)
  const jobs = new CodeJobs({ file, t3, now: () => now, exec: async (...args) => down ? undefined : exec(args[0], args[1]), attention: async w => { seen.push(w.map(j => j.id)) } })
  await jobs.snapshot()
  down = true
  now += 301_000
  await jobs.poll()
  expect(jobs.cached()!.github.reachable).toBe(false)
  expect(seen.at(-1)).toEqual(['j2'])
})

test('outage keeps PR cards stale without review events, returns 503, and recovers', async () => {
  const { file, t3, gh } = setup()
  saveCodeJobs(file, [job({ prNumber: 7 })])
  t3.snaps.set('t1', { id: 't1', status: 'idle' })
  gh.pr = PR
  let down = false, now = 1000, events = 0
  const exec = fakeGh(gh)
  const jobs = new CodeJobs({ file, t3, now: () => now, exec: async (...args) => down ? undefined : exec(args[0], args[1]), attention: async () => { events++ } })
  expect((await jobs.snapshot()).jobs[0]!.state).toBe('review')
  down = true
  now += 301_000
  await jobs.poll()
  const snapshot = jobs.cached()!
  expect(snapshot.github).toMatchObject({ reachable: false, since: new Date(now).toISOString() })
  expect(snapshot.jobs[0]).toMatchObject({ state: 'review', prStale: true, pr: { n: 7 } })
  expect(events).toBe(0)
  const response = await jobs.handle(new Request('http://x/app/jobs/pr?id=j1'), '/app/jobs/pr')
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'GitHub is unreachable', code: 'github_unreachable' })
  down = false
  now += 301_000
  const recovered = await jobs.snapshot()
  expect(recovered.github).toEqual({ reachable: true })
  expect(recovered.jobs[0]!.prStale).toBeUndefined()
})


test('local gh auth commands cannot clear a confirmed network outage', async () => {
  const github = new Github(async cmd => cmd[1] === 'auth' ? 'test-token' : undefined)
  await expect(github.run(['gh', 'pr', 'view'])).rejects.toThrow()
  await github.run(['gh', 'auth', 'token'])
  expect(github.status.reachable).toBe(false)
})

test('a job far over its token budget keeps going, even from a record with an old budgetPause', async () => {
  const oldPause = { budgetPause: { tokens: 400_000, askedAt: '2026-11-05T11:00:00.000Z' }, budgetHandledTokens: 400_000 }
  for (const over of [{}, oldPause]) {
    const { jobs, t3, file } = setup()
    saveCodeJobs(file, [job(over as Partial<CodeJob>)])
    t3.snaps.set('t1', { id: 't1', status: 'running', tokensUsed: 9_000_000 })
    await jobs.poll()
    expect(jobs.cached()!.jobs[0]).toMatchObject({ state: 'running', question: null, tokensUsed: 9_000_000, tokenBudget: 400_000 })
    expect(t3.interrupted).toEqual([])
    t3.snaps.set('t1', { id: 't1', status: 'idle', tokensUsed: 9_000_000 })
    expect((await jobs.snapshot()).jobs[0]).toMatchObject({ state: 'done', question: null })
    // "finish it" is now an ordinary message to the thread, not a budget command.
    await jobs.answer('j1', 'finish it')
    expect(t3.sent).toEqual([['t1', 'finish it']])
    expect(loadCodeJobs(file)[0]!.tokenBudget).toBe(400_000)
  }
})

const startBrief ={ project: 'demo', title: 'Fix', brief: 'fix' }
function meter(file: string, used = 80, at = Date.now()) {
  writeFileSync(join(dirname(file), 'plan-usage.json'), JSON.stringify({ at, seven_day: { used_percentage: used, resets_at: (at + 86_400_000) / 1000 } }))
}

test('low weekly meter moves a default job to GPT and leaves explicit GPT alone', async () => {
  for (const model of [undefined, DEFAULT_GPT_MODEL]) {
    const { jobs, t3, file } = setup()
    meter(file)
    const launch = spyOn(t3, 'launch')
    const j = await jobs.start({ ...startBrief, model })
    expect(j.model).toBe('GPT 6.2 Sol')
    expect(launch.mock.calls[0]![0]).toMatchObject({ model: DEFAULT_GPT_MODEL })
  }
})

test('an explicit gpt-6.1-sol still passes through and labels as 6.1', async () => {
  const { jobs, t3, file } = setup()
  meter(file)
  const launch = spyOn(t3, 'launch')
  const j = await jobs.start({ ...startBrief, model: 'gpt-6.1-sol' })
  expect(j.model).toBe('GPT 6.1 Sol')
  expect(launch.mock.calls[0]![0]).toMatchObject({ model: 'gpt-6.1-sol' })
})

test('low weekly meter refuses explicit Claude and honours override', async () => {
  const { jobs, t3, file } = setup()
  meter(file, 81)
  const launch = spyOn(t3, 'launch')
  await expect(jobs.start({ ...startBrief, model: 'claude-opus-5-5' })).rejects.toThrow('19%')
  expect(launch).not.toHaveBeenCalled()
  await jobs.start({ ...startBrief, model: 'claude-opus-5-5', override_low_limit: true })
  expect(launch.mock.calls[0]![0]).toMatchObject({ model: 'claude-opus-5-5' })
})

test('unreadable, stale, reset, or healthy weekly usage launches normally', async () => {
  for (const state of ['missing', 'invalid', 'malformed', 'stale', 'reset', 'healthy']) for (const model of [undefined, 'claude-opus-5-5']) {
    const { jobs, t3, file } = setup()
    const usageFile = join(dirname(file), 'plan-usage.json')
    if (state === 'invalid') writeFileSync(usageFile, '{')
    if (state === 'malformed') writeFileSync(usageFile, JSON.stringify({ seven_day: { used_percentage: 90 } }))
    if (state === 'stale') meter(file, 90, Date.now() - 3600_000)
    if (state === 'reset') writeFileSync(usageFile, JSON.stringify({ at: Date.now(), seven_day: { used_percentage: 90, resets_at: Date.now() / 1000 - 1 } }))
    if (state === 'healthy') meter(file, 75)
    const launch = spyOn(t3, 'launch')
    await jobs.start({ ...startBrief, model })
    expect(launch.mock.calls[0]![0].model).toBe(model)
  }
})

test('a newer T3 run reopens a stopped job and emits review normally', async () => {
  let now = Date.parse('2026-11-05T12:00:00Z')
  let watcher: JobEvents
  const events: string[] = []
  const { jobs, file, t3, gh } = setup({ now: () => now,
    attention: (wire, records) => watcher.observe(wire, records) })
  watcher = new JobEvents({ file: join(dirname(file), 'job-events.json'), now: () => now,
    injectEvent: async (_e, _c, meta) => { events.push(meta.state!); return true } })
  saveCodeJobs(file, [job()])
  t3.snaps.set('t1', { id: 't1', status: 'running', runRequestedAt: '2026-11-05T10:00:00Z', updatedAt: '2026-11-05T12:00:30Z' })
  expect((await jobs.stop('j1')).state).toBe('stopped')
  await jobs.poll()
  expect((await jobs.snapshot()).jobs[0]!.state).toBe('stopped')
  expect(events).toEqual([])
  now += 60_000
  t3.snaps.set('t1', { id: 't1', status: 'running', runRequestedAt: new Date(now).toISOString() })
  await jobs.poll()
  expect(jobs.cached()!.jobs[0]!.state).toBe('running')
  expect(loadCodeJobs(file)[0]!.stoppedAt).toBeUndefined()
  gh.pr = PR
  now += 40 * 60_000
  t3.snaps.set('t1', { id: 't1', status: 'idle', runRequestedAt: '2026-11-05T12:01:00Z', updatedAt: new Date(now).toISOString() })
  await jobs.poll()
  expect(jobs.cached()!.jobs[0]).toMatchObject({ state: 'review', pr: { n: 7 } })
  expect(events).toEqual(['review'])
  // Recovery also works when the new run ended before the next poll.
  saveCodeJobs(file, [job({ stoppedAt: '2026-11-05T12:00:00Z', endedAt: '2026-11-05T12:00:00Z' })])
  expect((await jobs.snapshot()).jobs[0]!.state).toBe('review')
  saveCodeJobs(file, [job({ stoppedAt: '2026-11-05T12:00:00Z' })])
  gh.pr = undefined
  await jobs.poll()
  expect(jobs.cached()!.jobs[0]!.state).toBe('done')
  expect(events).toEqual(['review', 'done'])
})

test('non-host polling cannot consume the host job event', async () => {
  let host = false
  let watcher: JobEvents
  const events: string[] = []
  const { jobs, file, t3, gh } = setup({ attention: (wire, records) => watcher.observe(wire, records) })
  const eventFile = join(dirname(file), 'job-events.json')
  const before = '{"jobs":{}}\n'
  writeFileSync(eventFile, before)
  watcher = new JobEvents({ file: eventFile, isHost: () => host,
    injectEvent: async (_e, _c, meta) => { events.push(meta.state!); return true } })
  saveCodeJobs(file, [job()])
  t3.snaps.set('t1', { id: 't1', status: 'idle' })
  gh.pr = PR
  await jobs.poll()
  expect(events).toEqual([])
  expect(readFileSync(eventFile, 'utf8')).toBe(before)
  host = true
  await jobs.poll()
  expect(events).toEqual(['review'])
})

test('Fable and its alias obey low-limit guard', async () => {
  for (const model of ['claude-fable-5-2', 'fable']) {
    const { jobs, file } = setup()
    meter(file, 81)
    await expect(jobs.start({ ...startBrief, model })).rejects.toThrow('override_low_limit')
    await jobs.start({ ...startBrief, model, override_low_limit: true })
  }
})

test('job router fills missing fields, persists effort, displays it, and preserves explicit fields', async () => {
  for (const model of [undefined, 'claude-opus-5-5']) {
    const { jobs, t3, file } = setup()
    writeFileSync(join(dirname(file), 'access.json'), JSON.stringify({ router: { jobs: true } }))
    const launch = spyOn(t3, 'launch')
    const j = await jobs.start({ ...startBrief, brief: 'debug this code', model })
    expect(launch.mock.calls[0]![0]).toMatchObject({ model: model ?? 'claude-fable-5-2', effort: 'xhigh' })
    expect(loadCodeJobs(file)[0].effort).toBe('xhigh')
    expect(j.model).toContain(' · xhigh')
    expect(formatCodeJob(j)).toContain(' · xhigh')
  }
  const { jobs, t3, file } = setup()
  writeFileSync(join(dirname(file), 'access.json'), JSON.stringify({ router: { jobs: true } }))
  const launch = spyOn(t3, 'launch')
  await jobs.start({ ...startBrief, effort: 'low' })
  expect(launch.mock.calls[0]![0]).toMatchObject({ model: 'claude-fable-5-2', effort: 'low' })
})

test('low-window GPT default wins routed model, UI never goes to GPT', async () => {
  const { jobs, t3, file } = setup()
  meter(file)
  writeFileSync(join(dirname(file), 'access.json'), JSON.stringify({ router: { jobs: true } }))
  const launch = spyOn(t3, 'launch')
  await jobs.start({ ...startBrief, brief: 'debug code' })
  expect(launch.mock.calls[0]![0]).toMatchObject({ model: DEFAULT_GPT_MODEL, effort: 'xhigh' })
  await expect(jobs.start({ ...startBrief, brief: 'design a UI' })).rejects.toThrow('override_low_limit')
  await jobs.start({ ...startBrief, brief: 'design a UI', override_low_limit: true })
  expect(launch.mock.calls.at(-1)![0].model).toBe('claude-fable-5-2')
  await expect(jobs.start({ ...startBrief, brief: 'design a UI', model: 'gpt-6.1-sol' })).rejects.toThrow('never GPT')
})

test('ten PR-less ended jobs make at most sixty gh calls in an hour', async () => {
  let now = Date.parse('2026-11-05T12:00:00Z')
  const start = now
  const { jobs, file, gh, t3 } = setup({ now: () => now })
  saveCodeJobs(file, Array.from({ length: 10 }, (_, i) => job({ id: `j${i}`, threadId: `t${i}`, branch: `fix/${i}`, endedAt: new Date(start).toISOString() })))
  for (let i = 0; i < 10; i++) t3.snaps.set(`t${i}`, { id: `t${i}`, status: 'idle' })
  for (; now < start + 3_600_000; now += 20_000) await jobs.poll()
  expect(gh.calls.filter(c => c[0] === 'gh').length).toBeLessThanOrEqual(60)
  expect(gh.calls.filter(c => c[0] === 'gh').length).toBeGreaterThanOrEqual(40)
})

test('missing PR backoff is 1, 2, 5, 15, 30 minutes; status change resets it immediately', async () => {
  let now = Date.parse('2026-11-05T12:00:00Z')
  const start = now
  const { jobs, file, gh, t3 } = setup({ now: () => now })
  saveCodeJobs(file, [job({ endedAt: new Date(start).toISOString() })])
  t3.snaps.set('t1', { id: 't1', status: 'idle' })
  await jobs.poll()
  let count = 1
  for (const minutes of [1, 2, 5, 15, 30, 30]) {
    now += minutes * 60_000 - 1
    await jobs.poll()
    expect(gh.calls.length).toBe(count)
    now++
    await jobs.poll()
    expect(gh.calls.length).toBe(++count)
  }
  now++
  t3.snaps.set('t1', { id: 't1', status: 'running' })
  await jobs.poll()
  expect(gh.calls.length).toBe(++count)
  now += 60_000
  await jobs.poll()
  expect(gh.calls.length).toBe(++count)
  saveCodeJobs(file, [job({ endedAt: new Date(start).toISOString() })])
  now = start + 24 * 3_600_000
  t3.snaps.set('t1', { id: 't1', status: 'idle' })
  await jobs.poll()
  expect(gh.calls.length).toBe(count)
})

test('open PR has a five-minute TTL; fresh rechecks metadata and only a changed SHA fetches diff', async () => {
  let now = 0
  const { jobs, file, gh, t3 } = setup({ now: () => now })
  saveCodeJobs(file, [job()])
  t3.snaps.set('t1', { id: 't1', status: 'idle' })
  gh.pr = { ...PR, headRefOid: 'abc' }
  await jobs.poll()
  const initial = gh.calls.length
  now = 299_999
  await jobs.poll()
  expect(gh.calls.length).toBe(initial)
  now++
  await jobs.poll()
  expect(gh.calls.length).toBe(initial + 1)
  t3.snaps.set('t1', { id: 't1', status: 'running' })
  await jobs.poll()
  expect(gh.calls.length).toBe(initial + 2)
  expect(gh.calls.filter(c => c[2] === 'diff')).toHaveLength(1)
  gh.pr.headRefOid = 'def'
  t3.snaps.set('t1', { id: 't1', status: 'idle' })
  await jobs.poll()
  expect(gh.calls.filter(c => c[2] === 'diff')).toHaveLength(2)
})

for (const existing of [false, true]) test(`deferred PR survives restart and ${existing ? 'pins an existing head' : 'creates once'}`, async () => {
  const { file, root, t3 } = setup()
  writeFileSync(join(root, 'PR.md'), 'Fix the thing\n\nBody.')
  saveCodeJobs(file, [job({ path: root, repo: 'example/demo', base: 'release' })])
  t3.snaps.set('t1', { id: 't1', status: 'idle', worktreePath: root, lastMessage: 'Finished' })
  let down = true, creates = 0, pushes = 0, published = false, hasPr = existing
  let now = Date.now()
  const exec: Exec = async cmd => {
    if (cmd[0] === 'git') {
      if (cmd[1] === 'remote') return remote('example/demo')
      if (cmd[1] === 'ls-remote') return published ? 'abc\trefs/heads/fix/thing' : ''
      if (cmd[1] === 'push') { pushes++; published = true; return '' }
    }
    if (down) return undefined
    if (cmd[1] === 'api') return '{}'
    if (cmd[2] === 'list') return JSON.stringify(hasPr ? [{ ...PR, headRefName: 'fix/thing' }] : [])
    if (cmd[2] === 'view') return JSON.stringify({ ...PR, headRefName: 'fix/thing' })
    if (cmd[2] === 'diff') return ''
    if (cmd[2] === 'create') { creates++; hasPr = true; expect(cmd).toContain('release'); return PR.url }
    return '[]'
  }
  const events: string[] = []
  const attention = new JobEvents({ file: join(dirname(file), 'events.json'), injectEvent: async kind => { events.push(kind); return true } })
  const jobs = new CodeJobs({ file, t3, exec, now: () => now, attention: (w, r) => attention.observe(w, r) })
  await jobs.poll()
  expect(loadCodeJobs(file)[0]!.pendingPr).toMatchObject({ title: 'Fix the thing', branch: 'fix/thing', base: 'release' })
  expect(jobs.cached()!.jobs[0]).toMatchObject({ state: 'done', now: 'Review pending GitHub' })
  expect(events).toEqual([])
  expect(pushes).toBe(1)
  down = false
  now += 5 * 60_000
  const restarted = new CodeJobs({ file, t3, exec, now: () => now })
  await restarted.poll()
  await restarted.poll()
  await new CodeJobs({ file, t3, exec }).poll()
  expect(loadCodeJobs(file)[0]!.pendingPr).toBeUndefined()
  expect(loadCodeJobs(file)[0]!.prNumber).toBe(7)
  expect(creates).toBe(existing ? 0 : 1)
})

test('PR.md queues a PR even while reachable and records a failed push', async () => {
  const { file, root, t3 } = setup()
  writeFileSync(join(root, 'PR.md'), 'Fix deferred jobs\n\nKeep the body.')
  saveCodeJobs(file, [job({ path: root, repo: 'example/demo' })])
  t3.snaps.set('t1', { id: 't1', status: 'error', worktreePath: root })
  const jobs = new CodeJobs({ file, t3, exec: async cmd => cmd[0] === 'gh' ? '[]' : cmd[1] === 'remote' ? remote('example/demo') : cmd[1] === 'ls-remote' ? '' : undefined })
  await jobs.poll()
  const pending = loadCodeJobs(file)[0]!.pendingPr!
  expect(pending).toMatchObject({ title: 'Fix deferred jobs', error: 'Could not push the branch' })
  expect(readFileSync(pending.bodyPath, 'utf8')).toBe('Keep the body.')
  expect(jobs.cached()!.jobs[0]!.state).toBe('done')
})

for (const c of [{ name: 'no PR.md', draft: false, ago: 60_000 }, { name: 'ended two days ago', draft: true, ago: 2 * 86_400_000 }]) test(`no deferred PR or push for a job with ${c.name}`, async () => {
  const { file, root, t3 } = setup()
  if (c.draft) writeFileSync(join(root, 'PR.md'), 'Old thing\n\nBody.')
  saveCodeJobs(file, [job({ path: root, repo: 'example/demo' })])
  t3.snaps.set('t1', { id: 't1', status: 'idle', worktreePath: root, updatedAt: new Date(Date.now() - c.ago).toISOString() })
  const calls: string[][] = []
  const jobs = new CodeJobs({ file, t3, exec: async cmd => { calls.push(cmd); return cmd[1] === 'remote' ? remote('example/demo') : undefined } })
  await jobs.poll()
  expect(loadCodeJobs(file)[0]!.pendingPr).toBeUndefined()
  expect(calls.filter(x => x[1] === 'push' || x[1] === 'ls-remote')).toEqual([])
})

test('after queues without a thread and rejects an unknown predecessor', async () => {
  const { jobs, file, t3 } = setup()
  saveCodeJobs(file, [job()])
  const launch = spyOn(t3, 'launch')
  const queued = await jobs.start({ project: 'demo', title: 'Follow-up', brief: 'Continue', after: 'j1', origin: 'triggered' })
  expect(launch).not.toHaveBeenCalled()
  expect(queued).toMatchObject({ state: 'queued', afterTitle: 'Fix the thing', threadId: null, startedAt: null, now: 'After Fix the thing' })
  expect(jobs.list().find(j => j.id === queued.id)).toMatchObject({ after: 'j1', origin: 'triggered' })
  expect(jobs.list().find(j => j.id === queued.id)?.worktreePath).toBeUndefined()
  await expect(jobs.start({ project: 'demo', title: 'Unknown', brief: 'Continue', after: 'missing' })).rejects.toThrow('unknown predecessor')
  await expect(jobs.start({ project: 'demo', title: 'Tainted', brief: 'Continue', after: 'j1', origin: 'external-content' })).rejects.toThrow('external content')
  expect(launch).not.toHaveBeenCalled()
})

test('after launches once after an observed merge, including overlapping polls and a restart', async () => {
  const { jobs, file, t3, gh } = setup()
  saveCodeJobs(file, [job()])
  const queued = await jobs.start({ project: 'demo', title: 'Follow-up', brief: 'Continue', after: 'j1', baseRef: 'release/next', origin: 'triggered' })
  const original = t3.launch.bind(t3)
  const launch = spyOn(t3, 'launch')
  await jobs.poll()
  expect(launch).not.toHaveBeenCalled()
  gh.pr = { ...PR, state: 'MERGED', mergedAt: '2026-11-05T12:00:00Z' }
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  launch.mockImplementationOnce(async input => { await barrier; return original(input) })
  const restarted = new CodeJobs({ file, t3, exec: fakeGh(gh) })
  const polling = restarted.poll()
  // Wait until the launch RPC is in flight, then overlap a poll on each instance.
  while (!launch.mock.calls.length) await Promise.resolve()
  await Promise.all([restarted.poll(), jobs.poll()])
  expect(launch).toHaveBeenCalledTimes(1)
  expect(loadCodeJobs(file).find(j => j.id === queued.id)?.launchClaimedAt).toBeDefined()
  release()
  await polling
  await restarted.poll()
  await new CodeJobs({ file, t3, exec: fakeGh(gh) }).poll()
  expect(launch).toHaveBeenCalledTimes(1)
  expect(launch.mock.calls[0]![0]).toMatchObject({ baseRef: 'release/next', title: 'Follow-up', projectId: 'p1' })
  expect(loadCodeJobs(file).find(j => j.id === queued.id)).toMatchObject({ threadId: 't1', origin: 'triggered' })
  expect(loadCodeJobs(file).find(j => j.id === queued.id)?.after).toBeUndefined()
})

for (const closedPr of [false, true]) test(`after a ${closedPr ? 'closed PR' : 'stopped predecessor'} needs input in snapshots and raises one event across restarts`, async () => {
  const events: { content: string; meta: Record<string, string> }[] = []
  const { jobs, file, t3, gh } = setup()
  saveCodeJobs(file, [job(closedPr ? {} : { stoppedAt: new Date().toISOString(), steps: [] })])
  if (closedPr) gh.pr = { ...PR, state: 'CLOSED' }
  const queued = await jobs.start({ project: 'demo', title: 'Follow-up', brief: 'Continue', after: 'j1', origin: 'user-typed' })
  const launch = spyOn(t3, 'launch')
  const deps = { file: join(dirname(file), 'events.json'), injectEvent: async (_: string, content: string, meta: Record<string, string>) => { events.push({ content, meta }); return true } }
  const make = () => {
    const watcher = new JobEvents(deps)
    return new CodeJobs({ file, t3, exec: fakeGh(gh), attention: (wire, records) => watcher.observe(wire, records) })
  }
  const restarted = make()
  await Promise.all([restarted.poll(), restarted.poll()])
  await restarted.poll()
  await make().poll()
  expect(launch).not.toHaveBeenCalled()
  expect((await restarted.snapshot()).jobs.find(j => j.id === queued.id)).toMatchObject({ state: 'input', afterTitle: 'Fix the thing' })
  const inputs = events.filter(e => e.meta.job === queued.id)
  expect(inputs).toHaveLength(1)
  expect(inputs[0]!.meta.state).toBe('input')
  expect(inputs[0]!.content).toContain('Start this job anyway or drop it?')
  if (closedPr) {
    await restarted.answer(queued.id, 'Start anyway')
    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls[0]![0].baseRef).toBe('main')
    expect(restarted.list().find(j => j.id === queued.id)?.origin).toBe('user-typed')
  } else {
    await restarted.answer(queued.id, 'Drop it')
    await restarted.poll()
    expect(launch).not.toHaveBeenCalled()
    expect(restarted.list().find(j => j.id === queued.id)?.stoppedAt).toBeDefined()
  }
})

test('a persisted launch claim prevents another launch after a restart', async () => {
  const { jobs, file, t3, gh } = setup()
  saveCodeJobs(file, [job({ mergedAt: new Date().toISOString() })])
  const queued = await jobs.start({ project: 'demo', title: 'Follow-up', brief: 'Continue', after: 'j1' })
  saveCodeJobs(file, jobs.list().map(j => j.id === queued.id ? { ...j, launchClaimedAt: new Date().toISOString() } : j))
  const launch = spyOn(t3, 'launch')
  await new CodeJobs({ file, t3, exec: fakeGh(gh) }).poll()
  expect(launch).not.toHaveBeenCalled()
})

test('state follows T3 first, and every T3 status has a label', () => {
  const cases: [string, ThreadSnap['status'], WireJob['state'], string][] = [
    ['queued', 'running', 'queued', 'Queued'], ['preparing', 'running', 'running', 'Preparing'],
    ['starting', 'running', 'running', 'Starting'], ['running', 'running', 'running', 'Running'],
    ['waiting', 'running', 'waiting', 'Waiting on background work'], ['interrupted', 'idle', 'stopped', 'Interrupted'],
    ['cancelled', 'idle', 'stopped', 'Cancelled'], ['rolled_back', 'idle', 'stopped', 'Rolled back'],
    ['failed', 'error', 'failed', 'Failed'], ['completed', 'idle', 'done', 'Completed'], ['idle', 'idle', 'done', 'Idle'],
  ]
  expect(Object.keys(T3_STATUS_LABELS).sort()).toEqual(cases.map(c => c[0]).sort())
  for (const [t3Status, status, state, label] of cases) {
    expect(wireJob(job(), { id: 't1', status, t3Status }, undefined)).toMatchObject({ state, t3Status, t3Label: label })
  }
  // A question pauses any status; an unknown status falls back to its raw string.
  expect(wireJob(job(), { id: 't1', status: 'input', t3Status: 'running' }, undefined)).toMatchObject({ state: 'input', t3Label: 'Running' })
  expect(t3Label('brand_new')).toBe('brand_new')
  expect(wireJob(job(), { id: 't1', status: 'idle', t3Status: 'brand_new' }, undefined)).toMatchObject({ state: 'done', t3Label: 'brand_new' })
  expect(wireJob(job(), { id: 't1', status: 'running', t3Status: 'waiting', backgroundWork: 'Waiting on CI' }, undefined).now).toBe('Waiting on CI')
})

test('a PR does not override what T3 says: running stays running, idle reads as review', () => {
  for (const t3Status of ['running', 'preparing', 'starting']) {
    expect(wireJob(job({ prNumber: 7 }), { id: 't1', status: 'running', t3Status }, pr()).state).toBe('running')
  }
  expect(wireJob(job({ prNumber: 7 }), { id: 't1', status: 'running', t3Status: 'waiting' }, pr()).state).toBe('waiting')
  expect(wireJob(job({ prNumber: 7 }), { id: 't1', status: 'idle', t3Status: 'idle' }, pr())).toMatchObject({ state: 'review', pr: { n: 7 } })
  expect(wireJob(job({ prNumber: 7 }), { id: 't1', status: 'idle', t3Status: 'completed' }, pr({ state: 'MERGED' })).state).toBe('merged')
})

test('a failed GitHub lookup leaves the T3-derived state and the last PR facts alone', async () => {
  const { file, t3, gh } = setup()
  saveCodeJobs(file, [job({ prNumber: 7 }), job({ id: 'j2', threadId: 't2', branch: 'fix/other', prNumber: 8 })])
  t3.snaps.set('t1', { id: 't1', status: 'idle', t3Status: 'idle' })
  t3.snaps.set('t2', { id: 't2', status: 'running', t3Status: 'running' })
  gh.prs = [{ ...PR, headRefName: 'fix/thing' }, { ...PR, number: 8, url: 'https://github.com/example/demo/pull/8', headRefName: 'fix/other' }]
  let down = false, now = 1000
  const exec = fakeGh(gh)
  const jobs = new CodeJobs({ file, t3, now: () => now, exec: async (...args) => down ? undefined : exec(args[0], args[1]) })
  const before = (await jobs.snapshot()).jobs.map(j => [j.id, j.state, j.t3Status, j.pr?.n])
  expect(before).toEqual([['j1', 'review', 'idle', 7], ['j2', 'running', 'running', 8]])
  down = true
  now += 301_000
  const after = await jobs.snapshot({ fresh: 'j1' })
  expect(after.github.reachable).toBe(false)
  expect(after.jobs.map(j => [j.id, j.state, j.t3Status, j.pr?.n])).toEqual(before)
})

test('a failed T3 read keeps the last thread states instead of flapping them', async () => {
  const { t3, jobs } = setup()
  await jobs.start({ project: 'Demo', title: 'Fix the thing', brief: 'fix it' })
  t3.snaps.set('t1', { id: 't1', status: 'idle', t3Status: 'interrupted' })
  await jobs.poll()
  expect(jobs.cached()!.jobs[0]!.state).toBe('stopped')
  spyOn(t3, 'threads').mockRejectedValue(new Error('T3 unreachable'))
  await jobs.poll()
  expect(jobs.cached()!.jobs[0]!.state).toBe('stopped')
})

// Pace: a clock `day` days (plus an hour) after the weekly reset, with the meter at `used`.
function paced(day: number, used = 10, access: Record<string, unknown> = { pace: {} }) {
  const now = Date.parse('2026-11-17T12:00:00Z'), from = now - day * 86_400_000 - 3600_000
  const s = setup({ now: () => now })
  writeFileSync(join(dirname(s.file), 'plan-usage.json'), JSON.stringify({ at: now, seven_day: { used_percentage: used, resets_at: (from + 7 * 86_400_000) / 1000 } }))
  writeFileSync(join(dirname(s.file), 'access.json'), JSON.stringify(access))
  const wd = (t: number) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short' })
  return { ...s, launch: spyOn(s.t3, 'launch'), days: `${wd(from)}–${wd(from + 2 * 86_400_000)}` }
}

test('pace: restricted days send non-UI to Sol and UI to Opus high, and say so in the first step', async () => {
  const { jobs, launch, days } = paced(1)
  const j = await jobs.start(startBrief)
  expect(launch.mock.calls[0]![0]).toMatchObject({ model: DEFAULT_GPT_MODEL })
  expect(j.steps[0]!.note).toBe(`pace: ${days} non-UI → GPT 6.2 Sol`)
  const ui = await jobs.start({ ...startBrief, title: 'Restyle', brief: 'design a UI', note: 'from the app' })
  expect(launch.mock.calls[1]![0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  expect(ui.steps[0]!.note).toBe(`pace: no Fable ${days} → Opus high · from the app`)
  // An explicit non-Fable model still wins.
  await jobs.start({ ...startBrief, title: 'Other', model: 'claude-opus-5-5', effort: 'xhigh' })
  expect(launch.mock.calls[2]![0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' })
})

test('pace overrides the router on restricted days', async () => {
  const { jobs, launch } = paced(0, 10, { pace: {}, router: { jobs: true } })
  await jobs.start({ ...startBrief, brief: 'design a UI' })
  expect(launch.mock.calls[0]![0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
})

test('pace: Fable and hillclimb are refused on restricted days unless overridden', async () => {
  const { jobs, launch, days } = paced(2)
  await expect(jobs.start({ ...startBrief, model: 'claude-fable-5-2' })).rejects.toThrow(`pace: no Fable ${days}`)
  await expect(jobs.start({ ...startBrief, title: 'Hillclimb latency' })).rejects.toThrow('no hillclimb')
  expect(launch).not.toHaveBeenCalled()
  await jobs.start({ ...startBrief, model: 'claude-fable-5-2', override_low_limit: true })
  await jobs.start({ ...startBrief, title: 'HILLCLIMB latency', override_low_limit: true })
  expect(launch.mock.calls[0]![0]).toMatchObject({ model: 'claude-fable-5-2' })
  expect(launch).toHaveBeenCalledTimes(2)
})

test('pace: day 3 allows one Opus hillclimb under 45%, refuses at 45%', async () => {
  const { jobs, launch } = paced(3, 44)
  const j = await jobs.start({ ...startBrief, title: 'hillclimb speed' })
  expect(launch.mock.calls[0]![0]).toMatchObject({ model: 'claude-opus-5-5' })
  expect(j.steps[0]!.note).toBe('pace: day-3 hillclimb under 45% → Opus')
  await expect(jobs.start({ ...startBrief, title: 'hillclimb size' })).rejects.toThrow('one hillclimb')
  await expect(paced(3, 44).jobs.start({ ...startBrief, title: 'hillclimb', model: 'fable' })).rejects.toThrow('not Fable')
  await expect(paced(3, 45).jobs.start({ ...startBrief, title: 'hillclimb' })).rejects.toThrow('45%')
  // Non-hillclimb jobs on day 3 and anything on days 4-6 route as before.
  const late = paced(4, 44)
  await late.jobs.start({ ...startBrief, title: 'hillclimb', model: 'claude-fable-5-2' })
  await late.jobs.start(startBrief)
  expect(late.launch.mock.calls.map(c => c[0].model)).toEqual(['claude-fable-5-2', undefined])
})

test('no pace block leaves restricted days as before', async () => {
  const { jobs, launch } = paced(1, 10, {})
  const j = await jobs.start({ ...startBrief, title: 'hillclimb', brief: 'design a UI' })
  expect(launch.mock.calls[0]![0].model).toBe('claude-fable-5-2')
  expect(j.steps[0]!.note).toBeUndefined()
})


test('never-started jobs expire, while intentional queues stay queued', () => {
  const queued = job({ threadId: undefined, startedAt: undefined })
  const start = Date.parse(queued.createdAt)
  const staleAt = start + JOB_START_STALE_MS
  expect(wireJob(queued, undefined, undefined, staleAt - 1)).toMatchObject({ state: 'queued', now: 'Starting' })
  expect(wireJob(queued, undefined, undefined, staleAt)).toMatchObject({ state: 'failed', now: 'Failed to start: no live T3 thread. Check T3 before retrying.' })
  expect(wireJob({ ...queued, after: 'previous', afterTitle: 'Previous job' }, undefined, undefined, staleAt)).toMatchObject({ state: 'queued', now: 'After Previous job' })
  expect(wireJob({ ...queued, reserveHeld: true }, undefined, undefined, staleAt)).toMatchObject({ state: 'queued', now: 'Waiting for plan reset' })
  expect(wireJob({ ...queued, launchClaimedAt: queued.createdAt }, undefined, undefined, staleAt).state).toBe('failed')
  expect(wireJob(job(), { id: 't1', status: 'gone' }, undefined, staleAt).state).toBe('failed')
  expect(wireJob(job(), undefined, undefined, staleAt).state).toBe('running')
  expect(wireJob(job(), { id: 't1', status: 'running' }, undefined, staleAt).state).toBe('running')
  expect(wireJob({ ...queued, launchError: 'Launch refused' }, undefined, undefined, start)).toMatchObject({ state: 'failed', question: null, now: 'Launch failed: Launch refused' })
})


test('snapshots and pushes exclude never-started jobs from running', async () => {
  let now = Date.parse('2026-11-05T10:00:00Z')
  const { file, jobs, t3, pushed } = setup({ now: () => now })
  saveCodeJobs(file, [
    job({ id: 'running' }),
    job({ id: 'after', threadId: undefined, startedAt: undefined, after: 'running', afterTitle: 'Running job' }),
    job({ id: 'orphan', threadId: undefined, startedAt: undefined }),
    job({ id: 'missing', threadId: 'missing' }),
  ])
  t3.snaps.set('t1', { id: 't1', status: 'running' })
  now += JOB_START_STALE_MS - 1
  await jobs.poll()
  expect(jobs.cached()!.jobs.filter(j => j.state === 'running').map(j => j.id)).toEqual(['running'])
  expect(jobs.cached()!.jobs.find(j => j.id === 'orphan')).toMatchObject({ state: 'queued', now: 'Starting' })
  now++
  await jobs.poll()
  expect(Object.fromEntries(pushed.at(-1)!.jobs.map(j => [j.id, j.state])))
    .toEqual({ running: 'running', after: 'queued', orphan: 'failed', missing: 'failed' })
  const restarted = new CodeJobs({ file, t3, exec: async () => undefined, now: () => now })
  expect((await restarted.snapshot()).jobs.filter(j => j.state === 'running').map(j => j.id)).toEqual(['running'])
})


test('a fresh instance cannot fail an existing thread when T3 is unreachable', async () => {
  const now = Date.parse(job().createdAt) + JOB_START_STALE_MS + 1
  const events: string[] = []
  const { file, t3, jobs } = setup({ now: () => now, attention: async wire => {
    events.push(...wire.filter(j => j.state === 'failed').map(j => j.id))
  } })
  saveCodeJobs(file, [job(), job({ id: 'never-launched', threadId: undefined, startedAt: undefined })])
  const threads = spyOn(t3, 'threads').mockRejectedValue(new Error('T3 unreachable'))
  await jobs.poll()
  expect(jobs.cached()!.jobs.find(j => j.id === 'j1')!.state).toBe('running')
  expect(events).toEqual(['never-launched'])
  // A successful read that omits the thread confirms it is missing.
  threads.mockResolvedValue(new Map())
  await jobs.poll()
  expect(jobs.cached()!.jobs.find(j => j.id === 'j1')!.state).toBe('failed')
})

test('overview snapshot keeps short slot waits on the job and pushes the same contract', async () => {
  const { file, t3, jobs, pushed, root } = setup()
  const row = await jobs.start({ project: 'demo', title: 'Fix the thing', brief: 'fix it' })
  const d = new Date(); d.setHours(0, 0, 0, 0)
  const since = new Date(d.getTime() + 1000).toISOString(), to = new Date(d.getTime() + 2000).toISOString()
  const slots = join(dirname(file), 'slots')
  mkdirSync(slots, { recursive: true })
  writeFileSync(join(slots, 'wait-a.json'), JSON.stringify({ pid: 999999, start: 1, token: 'a', cwd: join(root, 'otto'), since, to }))
  t3.snaps.set('t1', { id: 't1', status: 'running', worktreePath: root, lastMessage: '**Reading** tests. Next sentence.' })
  updateCodeJob(file, row.id, j => ({ ...j, startedAt: new Date(d).toISOString() }))
  const snapshot = await jobs.snapshot()
  expect(snapshot.mac).toMatchObject({ waiting: 0 })
  expect(snapshot.jobs[0]).toMatchObject({ activity: 'Reading tests.', slotWait: null })
  expect(snapshot.jobs[0]!.spans).toContainEqual({ state: 'wait', from: since, to })
  expect(loadCodeJobs(file)[0]!.slotWaits).toHaveLength(1)
  unlinkSync(join(slots, 'wait-a.json'))
  const again = await jobs.snapshot()
  expect(again.jobs[0]!.spans).toContainEqual({ state: 'wait', from: since, to })
  await jobs.poll()
  expect(pushed.at(-1)!.mac).toHaveProperty('limit')
  t3.snaps.set('t1', { id: 't1', status: 'idle', lastMessage: 'Done.' })
  expect((await jobs.snapshot()).jobs[0]!.activity).toBeNull()
})
