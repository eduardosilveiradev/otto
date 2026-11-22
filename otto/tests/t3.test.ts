import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { T3Client, modelLabel, snapFrom, t3ThreadUrl } from '../t3.ts'
import { startFakeT3 } from './faket3.ts'

const fake = startFakeT3()
afterAll(() => fake.stop())
const dir = mkdtempSync(join(tmpdir(), 'otto-t3-'))
const tokenFile = join(dir, 't3-token')
writeFileSync(tokenFile, fake.token)
const client = new T3Client({ origin: fake.url, tokenFile, mint: async () => fake.token, db: join(dir, 'none.sqlite') })

fake.projects.push({ id: 'p1', title: 'demo', workspaceRoot: '__HOME__/demo', defaultModelSelection: null })
fake.threads.push(
  { id: 'old', projectId: 'p1', status: 'idle', createdAt: '2026-11-01T00:00:00.000Z', modelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' } },
  { id: 'asks', projectId: 'p1', status: 'running', activityRunStatus: 'running', activeRunId: 'r9', branch: 'fix/a', createdAt: '2026-11-02T00:00:00.000Z',
    modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' }, updatedAt: '2026-11-05T10:00:00.000Z',
    pendingRuntimeRequest: { id: 'req1', kind: 'user_input', createdAt: '2026-11-05T09:59:00.000Z', blocking: true } },
)
fake.projections.asks = {
  thread: {}, messages: [{ role: 'assistant', text: 'Looking.' }],
  providerTurns: [{ tokenUsage: { usedTokens: 1000 } }, { tokenUsage: { usedTokens: 2500 } }],
  turnItems: [
    { type: 'dynamic_tool', status: 'completed', title: 'Read a.ts' },
    { type: 'user_input_request', requestId: 'req1', status: 'waiting', questions: [{ id: 'q-which', header: 'Which', question: 'Keep both rows?', options: [{ label: 'One row', description: '' }, { label: 'Keep both', description: '' }] }] },
  ],
}

test('modelLabel', () => {
  expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelLabel('gpt-6.1-sol')).toBe('GPT 6.1 Sol')
  expect(modelLabel('gpt-6.2-sol')).toBe('GPT 6.2 Sol')
  expect(modelLabel('gpt-6-astra')).toBe('GPT 6 Astra')
  expect(modelLabel('claude-haiku-5')).toBe('Haiku 5')
})

test('projects and thread snapshots, question included', async () => {
  expect(await client.projects()).toEqual([{ id: 'p1', name: 'demo', root: '__HOME__/demo', model: 'claude-opus-5-5' }])
  const snaps = await client.threads(['asks', 'missing'])
  expect(snaps.get('missing')).toEqual({ id: 'missing', status: 'gone' })
  expect(snaps.get('asks')).toEqual({
    id: 'asks', status: 'input', t3Status: 'running', activeTurn: true, tokensUsed: 3500, model: 'Opus 5.5', branch: 'fix/a', lastMessage: 'Looking.', updatedAt: '2026-11-05T10:00:00.000Z',
    question: { text: 'Keep both rows?', answers: ['One row', 'Keep both'], askedAt: '2026-11-05T09:59:00.000Z' },
  })
})

test('snapFrom: running, approvals, failures', () => {
  expect(snapFrom({ id: 'x', status: 'running', activityRunStatus: 'running' }, { turnItems: [{ status: 'running', title: 'bun test' }] })).toMatchObject({ status: 'running', now: 'bun test' })
  expect(snapFrom({ id: 'x', status: 'idle', pendingRuntimeRequest: { id: 'r', kind: 'command', createdAt: 't' } }, undefined))
    .toMatchObject({ status: 'input', question: { text: 'It wants approval to run a command.', answers: ['Approve', 'Decline'] } })
  expect(snapFrom({ id: 'x', status: 'failed' }, undefined).status).toBe('error')
  expect(snapFrom({ id: 'x', status: 'completed' }, undefined).status).toBe('idle')
})

test('launch starts a worktree thread with the brief, on the model last used for it', async () => {
  const r = await client.launch({ projectId: 'p1', title: 'Fix it', brief: 'do the thing', branch: 'otto/fix-it', model: 'claude-sonnet-5-5' })
  expect(r).toMatchObject({ threadId: 'thread-1', branch: 'otto/fix-it', model: 'Sonnet 5.5' })
  const l = fake.launches[0]
  expect(l).toMatchObject({
    projectId: 'p1', title: 'Fix it', runtimeMode: 'full-access', interactionMode: 'default',
    modelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' },
    workspaceStrategy: { type: 'worktree', baseRef: 'main', branch: 'otto/fix-it', startFromOrigin: true },
    initialMessage: { text: 'do the thing', attachments: [] },
  })
  expect(l.commandId).toBeTruthy()
  // No model: the project's newest thread decides.
  await client.launch({ projectId: 'p1', title: 'Again', brief: 'b', branch: 'otto/again', baseRef: 'dev' })
  expect(fake.launches[1].modelSelection.model).toBe('claude-sonnet-5-5')
  expect(fake.launches[1].workspaceStrategy.baseRef).toBe('dev')
})

test('a socket dropped during the launch call says the launch may have landed', async () => {
  fake.closeOn = 'orchestration.launchThread'
  try {
    await expect(client.launch({ projectId: 'p1', title: 'Dropped', brief: 'b', branch: 'otto/dropped', model: 'claude-sonnet-5-5' }))
      .rejects.toThrow(/^T3 orchestration\.launchThread lost its connection: /)
    // Dropped before the launch went out: a plain close, nothing to wait for.
    fake.closeOn = 'orchestration.subscribeShell'
    await expect(client.launch({ projectId: 'p1', title: 'Early', brief: 'b', branch: 'otto/early', model: 'claude-sonnet-5-5' }))
      .rejects.toThrow(/^T3 Code closed the connection/)
  } finally { fake.closeOn = undefined }
})

test('send queues behind a running turn; interrupt names the run', async () => {
  fake.commands.length = 0
  await client.send('asks', 'also fix b')
  await client.send('old', 'start again')
  expect(fake.commands.map(c => [c.type, c.threadId, c.dispatchMode.type, c.deliveryIntent, c.text])).toEqual([
    ['message.dispatch', 'asks', 'queue_after_active', 'auto', 'also fix b'],
    ['message.dispatch', 'old', 'start_immediately', undefined, 'start again'],
  ])
  await client.interrupt('asks')
  await client.interrupt('old')   // nothing running: nothing sent
  expect(fake.commands.at(-1)).toMatchObject({ type: 'run.interrupt', threadId: 'asks', runId: 'r9' })
  expect(fake.commands).toHaveLength(3)
})

test('answer responds to the pending question by its id, and says when there was none', async () => {
  fake.commands.length = 0
  expect(await client.answer('asks', 'One row')).toBe(true)
  expect(fake.commands[0]).toMatchObject({ type: 'runtime-request.respond', threadId: 'asks', requestId: 'req1', answers: { 'q-which': 'One row' } })
  expect(await client.answer('old', 'hello')).toBe(false)
  const t = fake.threads.find(x => x.id === 'old')!
  t.pendingRuntimeRequest = { id: 'ap1', kind: 'command', createdAt: 't' }
  expect(await client.answer('old', 'Approve')).toBe(true)
  expect(fake.commands.at(-1)).toMatchObject({ requestId: 'ap1', decision: 'accept' })
  t.pendingRuntimeRequest = null
})

test('a token T3 turns away is replaced once', async () => {
  writeFileSync(tokenFile, 'stale')
  expect((await client.projects()).length).toBe(1)
  expect(readFileSync(tokenFile, 'utf8').trim()).toBe(fake.token)
})

test('T3 down and no database: it says so', async () => {
  const down = new T3Client({ origin: 'http://127.0.0.1:9', tokenFile, mint: async () => fake.token, db: join(dir, 'none.sqlite') })
  await expect(down.threads(['asks'])).rejects.toThrow()
})

test('T3 down: thread state comes from its database, opened read-only', async () => {
  const { Database } = await import('bun:sqlite')
  const file = join(dir, 'state.sqlite')
  const db = new Database(file)
  db.run('CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT)')
  db.run('CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, ordinal INT, status TEXT, requested_at TEXT)')
  db.run('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL)', ['t1', JSON.stringify({ id: 't1', branch: 'fix/a', modelSelection: { model: 'claude-opus-5-5' } })])
  db.run('INSERT INTO orchestration_v2_projection_runs VALUES (?, 1, ?, ?), (?, 2, ?, ?)', ['t1', 'completed', '2026-11-05T10:00:00Z', 't1', 'running', '2026-11-05T12:01:00Z'])
  db.close()
  const down = new T3Client({ origin: 'http://127.0.0.1:9', tokenFile, mint: async () => fake.token, db: file })
  const s = await down.threads(['t1', 'gone'])
  expect(s.get('t1')).toEqual({ id: 't1', status: 'running', t3Status: 'running', model: 'Opus 5.5', branch: 'fix/a', runRequestedAt: '2026-11-05T12:01:00Z' })
  expect(s.get('gone')!.status).toBe('gone')
})

test('snapFrom: the PR T3 linked to the thread', () => {
  const linked = { host: 'github.com', repository: 'example/core', number: 40, url: 'https://github.com/example/core/pull/40' }
  expect(snapFrom({ id: 'x', status: 'idle', linkedPullRequest: null, pullRequests: [linked] }, undefined).pr).toEqual({ repo: 'example/core', n: 40 })
  expect(snapFrom({ id: 'x', status: 'idle', pullRequests: [] }, undefined).pr).toBeUndefined()
})

test('usage: plan windows and the token scan, each settling on its own', async () => {
  fake.providers = [{ instanceId: 'claudeAgent', driver: 'claudeAgent', usageLimits: { checkedAt: '2026-11-05T10:00:00.000Z', windows: [{ id: 'five_hour', kind: 'session', label: 'Session', usedPercent: 19 }] } }]
  const q = { sinceDay: '2026-11-01', untilDay: '2026-11-05', timeZone: 'Europe/Berlin' }
  const a = await client.usage(q)
  expect(a.providers).toEqual({ status: 'fulfilled', value: fake.providers })
  expect(a.summary.status).toBe('rejected')
  expect(fake.commands.at(-1)).toEqual({ usage: q })
  fake.summary = { readAt: 'x', buckets: [] }
  expect((await client.usage(q)).summary).toEqual({ status: 'fulfilled', value: fake.summary })
  const down = new T3Client({ origin: 'http://127.0.0.1:9', tokenFile, mint: async () => fake.token, db: join(dir, 'none.sqlite') })
  const d = await down.usage(q)
  expect([d.providers.status, d.summary.status]).toEqual(['rejected', 'rejected'])

})

test('T3 pending background work survives an idle snapshot; requests still win', () => {
  for (const kind of ['command', 'subagent', 'monitor', 'background_task']) {
    const shell = { id: 'x', status: 'idle', pendingBackgroundTasks: [{ taskId: 'task-1', kind, description: 'the build' }] }
    expect(snapFrom(shell, undefined)).toMatchObject({ status: 'idle', backgroundWork: 'Waiting on the build' })
    expect(snapFrom({ ...shell, pendingRuntimeRequest: { id: 'r', kind: 'user_input', createdAt: 'now' } }, undefined).status).toBe('input')
  }
  expect(snapFrom({ id: 'x', status: 'idle', pendingBackgroundTasks: [] }, undefined).backgroundWork).toBeUndefined()
})


test('thread deep links use the environment id and encode path segments', () => {
  const environmentFile = join(dir, 'environment-id')
  writeFileSync(environmentFile, 'test-environment\n')
  expect(t3ThreadUrl('thread/with spaces?#', environmentFile))
    .toBe('t3code://threads/test-environment/thread%2Fwith%20spaces%3F%23')
  expect(t3ThreadUrl(undefined, environmentFile)).toBeNull()
  expect(t3ThreadUrl('thread', join(dir, 'missing-environment'))).toBeNull()
  writeFileSync(environmentFile, '  \n')
  expect(t3ThreadUrl('thread', environmentFile)).toBeNull()
})


test('T3 PR links distinguish actual creation from watching, linking, and dismissed stack members', () => {
  const link = { host: 'github.com', repository: 'example/core', number: 40 }
  const snap = snapFrom({ id: 'x', status: 'idle', pullRequests: [
    { ...link, source: 'created' },
    { ...link, number: 41, source: 'agent' },
    { ...link, number: 42, source: 'stack-dismissed' },
  ] }, undefined)
  expect(snap.prs).toEqual([{ repo: 'example/core', n: 41 }, { repo: 'example/core', n: 40, openedByThread: true }])
})

test('multiple pending questions retain all suggested answers', () => {
  const shell = { ...fake.threads.find(t => t.id === 'asks')! }
  const projection = { turnItems: [{ type: 'user_input_request', requestId: 'req1', status: 'waiting', questions: [
    { id: 'a', question: 'Which branch?', options: [{ label: 'main' }] },
    { id: 'b', question: 'Which mode?', options: [{ label: 'fast' }, { label: 'full' }] },
  ] }] }
  expect(snapFrom(shell, projection).question).toMatchObject({ text: 'Which branch?\n\nWhich mode?', answers: ['Which branch?: main', 'Which mode?: fast', 'Which mode?: full'] })
})

test('snapFrom uses the newest run request, not the thread update time', () => {
  expect(snapFrom({ id: 't1', status: 'idle', updatedAt: '2026-11-05T13:00:00Z' }, {
    runs: [{ ordinal: 2, requestedAt: '2026-11-05T12:01:00Z' }, { ordinal: 1, requestedAt: '2026-11-05T10:00:00Z' }],
  }).runRequestedAt).toBe('2026-11-05T12:01:00Z')
})

test('launch effort uses each resolved provider descriptor and rejects unsupported values before launching', async () => {
  const providers = fake.providers
  fake.providers = [
    { instanceId: 'claudeAgent', driver: 'claudeAgent', models: [{ slug: 'claude-fable-5-2', capabilities: { optionDescriptors: [{ id: 'effort', type: 'select', options: ['low', 'medium', 'high', 'xhigh', 'max'].map(id => ({ id })) }] } }] },
    { instanceId: 'codex', driver: 'codex', models: [{ slug: 'gpt-6.1-sol', capabilities: { optionDescriptors: [{ id: 'reasoningEffort', type: 'select', options: ['low', 'medium', 'high', 'xhigh'].map(id => ({ id })) }] } }] },
  ]
  try {
    for (const [model, id] of [['claude-fable-5-2', 'effort'], ['gpt-6.1-sol', 'reasoningEffort']]) {
      const launched = await client.launch({ projectId: 'p1', title: 'Effort', brief: 'test', branch: 'otto/effort', model, effort: 'xhigh' })
      expect(fake.launches.at(-1).modelSelection.options).toEqual([{ id, value: 'xhigh' }])
      expect(launched.model).toContain(' · xhigh')
      expect((await client.threads([launched.threadId])).get(launched.threadId)?.model).toContain(' · xhigh')
    }
    const before = fake.launches.length
    for (const effort of ['max', 'banana']) {
      await expect(client.launch({ projectId: 'p1', title: 'Bad', brief: 'test', branch: 'otto/bad', model: 'gpt-6.1-sol', effort: effort as any })).rejects.toThrow('accepted: low, medium, high, xhigh')
    }
    expect(fake.launches).toHaveLength(before)
    const claude = fake.providers[0]
    fake.providers.push({ ...claude, instanceId: 'claude-custom' })
    fake.threads.push({ id: 'custom', projectId: 'p1', createdAt: '2099-01-01T00:00:00Z', modelSelection: { instanceId: 'claude-custom', model: 'claude-fable-5-2' } })
    await client.launch({ projectId: 'p1', title: 'Custom', brief: 'test', branch: 'otto/custom', model: 'fable', effort: 'max' })
    expect(fake.launches.at(-1).modelSelection).toMatchObject({ instanceId: 'claude-custom', model: 'claude-fable-5-2', options: [{ id: 'effort', value: 'max' }] })
    await client.launch({ projectId: 'p1', title: 'Default', brief: 'test', branch: 'otto/default', effort: 'low' })
    expect(fake.launches.at(-1).modelSelection).toMatchObject({ instanceId: 'claude-custom', options: [{ id: 'effort', value: 'low' }] })
  } finally { fake.providers = providers }
})

test('snapFrom keeps T3’s raw status verbatim', () => {
  expect(snapFrom({ id: 'x', status: 'running', activityRunStatus: 'preparing' }, undefined)).toMatchObject({ status: 'running', t3Status: 'preparing' })
  expect(snapFrom({ id: 'x', status: 'interrupted' }, undefined)).toMatchObject({ status: 'idle', t3Status: 'interrupted' })
  expect(snapFrom({ id: 'x', status: 'something_new' }, undefined).t3Status).toBe('something_new')
  expect(snapFrom({ id: 'x' }, undefined).t3Status).toBeUndefined()
})

test('repoint moves the project folder through projects.mutate', async () => {
  fake.projects.push({ id: 'p2', title: 'moved', workspaceRoot: '__HOME__/Documents/moved', defaultModelSelection: null })
  await client.repoint('p2', '__HOME__/.otto/build/moved-clone')
  expect(fake.commands.at(-1)).toMatchObject({ type: 'project.update', projectId: 'p2', workspaceRoot: '__HOME__/.otto/build/moved-clone' })
  expect(fake.commands.at(-1).commandId).toBeTruthy()
  expect((await client.projects()).find(p => p.id === 'p2')?.root).toBe('__HOME__/.otto/build/moved-clone')
})

test('an idle thread T3 has not touched reuses its projection; running ones are read every time', async () => {
  const c = new T3Client({ origin: fake.url, tokenFile, mint: async () => fake.token, db: join(dir, 'none.sqlite') })
  fake.threads.push(
    { id: 'quiet', projectId: 'p1', status: 'idle', updatedAt: '2026-11-05T10:00:00.000Z' },
    { id: 'busy', projectId: 'p1', status: 'running', activityRunStatus: 'running', updatedAt: '2026-11-05T10:00:00.000Z' },
  )
  const reads: string[] = []
  const store: Record<string, any> = {
    quiet: { messages: [{ role: 'assistant', text: 'All done.' }], providerTurns: [{ tokenUsage: { usedTokens: 70 } }], turnItems: [] },
    busy: { messages: [], providerTurns: [], turnItems: [{ type: 'dynamic_tool', status: 'running', title: 'Run tests' }] },
  }
  const before = fake.projections
  fake.projections = new Proxy(store, { get: (t, k: string) => { reads.push(k); return t[k] } })
  try {
    const first = await c.threads(['quiet', 'busy'])
    const again = await c.threads(['quiet', 'busy'])
    expect(again.get('quiet')).toEqual(first.get('quiet')!)
    expect(again.get('quiet')).toMatchObject({ status: 'idle', lastMessage: 'All done.', tokensUsed: 70 })
    expect(again.get('busy')).toMatchObject({ status: 'running', now: 'Run tests' })
    expect(reads.filter(k => k === 'quiet')).toHaveLength(1)
    expect(reads.filter(k => k === 'busy')).toHaveLength(2)
    fake.threads.find(t => t.id === 'quiet')!.updatedAt = '2026-11-05T11:00:00.000Z'
    await c.threads(['quiet'])
    expect(reads.filter(k => k === 'quiet')).toHaveLength(2)
  } finally {
    fake.projections = before
    fake.threads.splice(fake.threads.findIndex(t => t.id === 'quiet'), 2)
  }
})
