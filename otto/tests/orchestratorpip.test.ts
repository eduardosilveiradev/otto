import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pips, PIP_JOBS, assertPipJobTool } from '../pips.ts'
import { loadJobs, updateJob, applyEvent, budgetExceeded } from '../jobs.ts'
import { JobEvents } from '../jobevents.ts'
import { wireJob, type CodeJob } from '../codejobs.ts'
import { effectiveOrigin, freshState, onWake } from '../origin.ts'
import { DEFAULT_GPT_MODEL } from '../jobs.ts'

const input = { name: 'Code', job: 'Coordinate coding', instructions: 'Carry tasks to a PR.', tools: PIP_JOBS.map(t => `mcp__plugin_otto_otto__${t}`), solid: 'gem', colour: '#123abc' }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-pip-'))
  const pips = new Pips({ stateDir: dir, config: () => ({}), lowClaude: () => false })
  return { dir, pips, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('coding tools are selectable and unknown tools are refused, including the tools endpoint', async () => {
  const t = setup()
  try {
    const p = t.pips.create(input)
    expect(p.tools).toEqual(expect.arrayContaining(input.tools))
    expect(() => t.pips.edit(p.id, { tools: ['unknown'] })).toThrow('tools must be selected')
    expect(t.pips.edit(p.id, { tools: p.tools }).tools).toEqual(p.tools)   // the stored list round-trips, auto tools included
    expect(() => t.pips.create({ ...input, tools: ['unknown'] })).toThrow('tools must be selected')
    const res = await t.pips.handle(new Request('http://localhost/app/pips/tools'), 'test')
    const { tools } = await res.json() as any
    expect(tools).toEqual(expect.arrayContaining([
      { id: input.tools[0], label: 'Coding jobs (start)' },
      { id: input.tools[1], label: 'Coding jobs (read)' },
    ]))
  } finally { t.cleanup() }
})

test('pip wakes have no token ceiling, orchestrator or not', () => {
  const t = setup()
  try {
    const orchestrator = t.pips.create(input)
    const reader = t.pips.create({ ...input, name: 'Reader', job: 'Reads', tools: ['Read'] })
    for (const p of [orchestrator, reader]) {
      const h = t.pips.ask(p.id, p.id, 'go', 'user', false, 'user-typed')
      t.pips.tick()
      const job = loadJobs(join(t.dir, 'jobs.json')).find(j => j.id === h.jobId)!
      expect(budgetExceeded({ ...job, tokensUsed: job.tokenBudget * 100 })).toBe(false)
    }
  } finally { t.cleanup() }
})

test('host stamps coding permission from the wake, never from runner arguments', () => {
  for (const from of ['user', 'otto', 'peer']) for (const wake of ['owner', 'otto', 'button', 'email-scan', 'webhook', 'trigger']) {
    const t = setup()
    try {
      const p = t.pips.create(input), peer = t.pips.create({ ...input, name: 'Peer', job: 'Research' })
      const group = t.pips.createGroup('Work', [p.id, peer.id])
      const origin = wake === 'otto' ? 'model-authored' : effectiveOrigin(onWake(freshState(), wake === 'owner' ? { kind: 'inbound' } : { kind: 'event', event: wake }))
      const sender = from === 'peer' ? peer.id : from
      const h = t.pips.ask(group.id, p.id, 'Build it', sender, wake === 'trigger', origin)
      t.pips.tick()
      const job = updateJob(join(t.dir, 'jobs.json'), h.jobId!, j => applyEvent(j, { type: 'start', at: Date.now() }))!
      const allowed = from !== 'peer' && ['owner', 'otto', 'button'].includes(wake)
      expect(job.pip?.codeJobsAllowed).toBe(allowed)
      for (const tool of ['code_job', 'code_job_answer']) {
        if (allowed) expect(() => assertPipJobTool(job, tool)).not.toThrow()
        else expect(() => assertPipJobTool(job, tool)).toThrow('require an owner')
      }
      expect(() => assertPipJobTool(job, 'code_jobs')).not.toThrow()
      expect(() => assertPipJobTool({ ...job, tools: [] }, 'code_job')).toThrow('allowlist')
    } finally { t.cleanup() }
  }
})

test('pip job attention stays in its own thread; Otto jobs and deleted pips use the main session', async () => {
  const t = setup()
  try {
    const p = t.pips.create(input), main: string[] = []
    const watcher = new JobEvents({ file: join(t.dir, 'events.json'),
      pipEvent: (id, content, eventId) => t.pips.jobEvent(id, content, eventId),
      injectEvent: async (_e, _c, _m, id) => { main.push(id); return true },
    })
    const record: CodeJob = { pipId: p.id, id: 'j1', title: 'Fix', project: 'demo', brief: 'Fix it', agent: 'T3 Code', where: 'local', threadId: 't1', createdAt: new Date().toISOString(), tokenBudget: 100, steps: [] }
    const base = wireJob(record, { id: 't1', status: 'running' }, undefined)
    await watcher.observe([{ ...base, state: 'review', pr: { n: 7 } as any }], [record])
    await watcher.observe([{ ...base, state: 'input', question: { text: 'Which?', answers: ['A'], askedAt: 'now' } }], [record])
    expect(main).toEqual([])
    const wakes = t.pips.detail(p.id).wakes
    expect(wakes).toHaveLength(2)
    expect(wakes.every(h => h.conversation === p.id)).toBe(true)
    expect(wakes.some(h => h.ask.includes('Which?'))).toBe(true)
    t.pips.tick()
    const job = loadJobs(join(t.dir, 'jobs.json'))[0]!
    expect(job.pip?.codeJobsAllowed).toBe(true)
    updateJob(join(t.dir, 'jobs.json'), job.id, j => applyEvent(j, { type: 'start', at: Date.now() }))
    updateJob(join(t.dir, 'jobs.json'), job.id, j => applyEvent(j, { type: 'finish', at: Date.now(), result: 'Handled' }))
    t.pips.tick()
    expect(t.pips.handoff(job.id).relayedTo).toBeUndefined()
    await watcher.observe([{ ...base, id: 'otto-job', state: 'input' }], [{ ...record, id: 'otto-job', pipId: undefined }])
    expect(main).toHaveLength(1)
    t.pips.archivePip(p.id)
    await watcher.observe([{ ...base, state: 'failed' }], [record])
    expect(main).toHaveLength(2)
  } finally { t.cleanup() }
})

test('pip jobs retain ownership and the weekly limit; answers reuse pending requests or send a follow-up', async () => {
  const { CodeJobs } = await import('../codejobs.ts')
  const { writeFileSync } = await import('node:fs')
  const t = setup()
  try {
    const launches: any[] = [], answers: string[] = [], sent: string[] = []
    let pending = true
    const jobs = new CodeJobs({ file: join(t.dir, 'code-jobs.json'), exec: async () => '[]', t3: {
      projects: async () => [{ id: 'p1', name: 'demo', root: '/tmp/demo' }],
      launch: async o => { launches.push(o); return { threadId: 't1', model: o.model } },
      threads: async () => new Map([['t1', { id: 't1', status: 'running' as const }]]),
      answer: async (_id, text) => { answers.push(text); return pending },
      send: async (_id, text) => { sent.push(text) }, interrupt: async () => {},
    } })
    const now = Date.now()
    writeFileSync(join(t.dir, 'plan-usage.json'), JSON.stringify({ at: now, seven_day: { used_percentage: 81, resets_at: (now + 86400000) / 1000 } }))
    const input = { pipId: 'orchestrator', project: 'demo', title: 'Fix', brief: 'Fix a parser', repo: 'example/demo' }
    const job = await jobs.start(input)
    expect(jobs.list()[0]?.pipId).toBe('orchestrator')
    expect(launches[0].model).toBe(DEFAULT_GPT_MODEL)
    await expect(jobs.start({ ...input, model: 'claude-opus-5-5', override_low_limit: true })).rejects.toThrow('19%')
    expect(launches).toHaveLength(1)
    await jobs.answer(job.id, 'Use A')
    expect(answers).toEqual(['Use A']); expect(sent).toEqual([])
    pending = false
    await jobs.answer(job.id, 'Also fix B')
    expect(sent).toEqual(['Also fix B'])
  } finally { t.cleanup() }
})

test('host bridge starts, reads and answers jobs with pinned pip ownership', async () => {
  const { startTwin } = await import('./apptwin.ts')
  const { startFakeT3, fakeCheckout } = await import('./faket3.ts')
  const { writeFileSync } = await import('node:fs')
  const { createJob, saveJobs } = await import('../jobs.ts')
  const fake = startFakeT3()
  fake.projects.push({ id: 'p1', title: 'demo', workspaceRoot: fakeCheckout(), defaultModelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol' } })
  const t = await startTwin(undefined, { OTTO_T3_URL: fake.url })
  try {
    writeFileSync(join(t.state, 't3-token'), fake.token)
    const job = createJob({ task: 'Coordinate', tools: input.tools }, { scratchRoot: join(t.state, 'jobs') })
    job.state = 'running'
    job.pip = { id: 'orchestrator', model: 'sonnet', sessionId: 'test-session', resume: false, deadline: Date.now() + 30000, codeJobsAllowed: true }
    const file = join(t.state, 'jobs.json')
    saveJobs(file, [job])
    const call = (operation: string, args: unknown) => fetch(t.url + '/', { method: 'POST', headers: { authorization: 'Bearer twin-webhook-token', 'content-type': 'application/json' }, body: JSON.stringify({ source: 'otto-pip', pipJob: job.id, operation, args }) })
    const res = await call('code_job', { project: 'demo', title: 'Fix', brief: 'Fix a parser', repo: 'example/demo' })
    expect(res.status).toBe(200)
    const started = await res.json() as any
    expect(started.id).toBeTruthy()
    expect(JSON.parse(await Bun.file(join(t.state, 'code-jobs.json')).text())[0].pipId).toBe('orchestrator')
    expect((await call('code_jobs', { id: started.id })).status).toBe(200)
    expect((await call('code_job_answer', { id: started.id, text: 'Also fix B' })).status).toBe(200)
    expect(fake.commands.some((c: any) => c.type === 'message.dispatch' && c.text === 'Also fix B')).toBe(true)
    expect((await call('code_job_answer', { id: 'other-job', text: 'Do it' })).status).toBe(403)
    expect((await (await call('code_jobs', {})).json() as any[]).map(j => j.id)).toEqual([started.id])
    // Another pip sees neither the list entry nor the job by id.
    job.pip.id = 'other-pip'; saveJobs(file, [job])
    expect(await (await call('code_jobs', {})).json()).toEqual([])
    expect(await (await call('code_jobs', { id: started.id })).json()).toBeNull()
    job.pip.id = 'orchestrator'
    job.pip.codeJobsAllowed = false; saveJobs(file, [job])
    expect((await call('code_job', { project: 'demo', title: 'Blocked', brief: 'No' })).status).toBe(400)
    expect(fake.launches).toHaveLength(1)
  } finally { await t.stop(); fake.stop() }
}, 30000)
