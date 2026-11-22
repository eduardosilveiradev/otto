import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pips, assertPipCreation, type Handoff, type PipConfig } from '../pips.ts'
import { loadJobs, updateJob, applyEvent, tallyStream, tallyCodex, EMPTY_TALLY, budgetExceeded } from '../jobs.ts'
import { collectStatus } from '../status.ts'
import { freshState, taint, onWake } from '../origin.ts'
import { DEFAULT_GPT_MODEL } from '../jobs.ts'
const input = (name = 'Fares') => ({ name, job: `${name} research`, instructions: 'Read and report.', tools: ['WebSearch'], solid: 'gem', colour: '#123abc' })
function setup(config: PipConfig = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'otto-pips-')), frames: any[] = [], otto: any[] = [], results: Handoff[] = []
  let now = Date.parse('2026-11-09T08:00:00Z'), low = false
  const options = { stateDir, config: () => config, publish: (f: unknown) => frames.push(f), now: () => now, lowClaude: () => low, deliverOtto: async (...args: unknown[]) => { otto.push(args) }, resultToOtto: (h: Handoff) => { results.push(h) } }
  let runtime = new Pips(options)
  return { get p() { return runtime }, stateDir, frames, otto, results, advance: (ms: number) => { now += ms }, low: () => { low = true }, restart: () => { runtime = new Pips(options) },
    start: (id: string) => updateJob(join(stateDir, 'jobs.json'), id, j => applyEvent(j, { type: 'start', at: now })),
    finish: (id: string, result = 'Found flights') => updateJob(join(stateDir, 'jobs.json'), id, j => applyEvent(j, { type: 'finish', at: now, result })),
    jobs: () => loadJobs(join(stateDir, 'jobs.json')) }
}
test('wake, stub completion, sleep and restart retain session and scratch', () => {
  const t = setup(), p = t.p.create(input()), h = t.p.ask(p.id, p.id, 'Find flights')
  t.p.tick(); const j = t.jobs()[0]!
  expect(j.pip).toMatchObject({ id: p.id, resume: false, sessionId: p.sessionId }); expect(p.state).toBe('working')
  t.start(j.id); t.p.tick(); t.finish(j.id); t.p.tick()
  expect(t.p.handoff(h.id)).toMatchObject({ status: 'answered', reply: 'Found flights', relayedTo: 'otto' })
  expect(t.p.pip(p.id).state).toBe('rest')
  t.restart(); t.advance(600001); t.p.tick(); expect(t.p.pip(p.id).state).toBe('rest'); expect(t.p.pip(p.id).awakeUntil).toBeUndefined()
  t.p.ask(p.id, p.id, 'And return flights?'); t.p.tick()
  expect(t.jobs()[1]!.pip).toMatchObject({ resume: true, sessionId: p.sessionId }); expect(t.jobs()[1]!.scratchDir).toBe(j.scratchDir)
})
test('total and awake caps queue; timeout fails visibly and never runs late', () => {
  const t = setup({ maxTotal: 2, maxAwake: 1 }), a = t.p.create(input()), b = t.p.create(input('Stays'))
  expect(() => t.p.create(input('Planner'))).toThrow('cap')
  t.p.ask(a.id, a.id, 'Go'); const h = t.p.ask(b.id, b.id, 'Wait')
  t.p.tick(); expect(t.jobs()).toHaveLength(1)
  t.advance(30001); t.p.tick(); expect(t.p.handoff(h.id).status).toBe('failed')
  expect(t.p.history(b.id).at(-1)?.text).toContain('not delivered')
  t.advance(600001); t.p.tick(); expect(t.jobs()).toHaveLength(1)
})
test('group routing, deduped sends, mandatory group link and membership lines', async () => {
  const t = setup(), a = t.p.create(input()), c = t.p.createGroup('Berlin in March', [a.id])
  expect(t.p.targets(c.id, '@fares find flights')).toEqual([a.id]); expect(t.p.targets(c.id, 'Plan this')).toEqual(['otto'])
  expect(() => t.p.targets(c.id, '@Stranger do it')).toThrow()
  await t.p.send(c.id, { id: 'm1', text: 'Plan this' }); await t.p.send(c.id, { id: 'm1', text: 'Plan this' }); expect(t.otto).toHaveLength(1)
  const b = t.p.create({ ...input('Stays'), group_id: c.id })
  expect(t.p.history('app').at(-1)?.group?.members.map(m => m.id)).toContain(b.id)
  expect(t.p.history(c.id).at(-1)?.pip_id).toBe(b.id)
})
test('creation rejects tainted, triggered, webhook and pip contexts', () => {
  expect(() => assertPipCreation(freshState(), false)).not.toThrow()
  for (const state of [taint(freshState(), 'mail'), onWake(freshState(), { kind: 'event', event: 'trigger' }), onWake(freshState(), { kind: 'event', event: 'webhook' })]) expect(() => assertPipCreation(state, false)).toThrow()
  expect(() => assertPipCreation(freshState(), true)).toThrow()
})
test('low Claude routes schedules, owner messages and follow-on handoffs to Codex', async () => {
  const t = setup(); t.low()
  const a = t.p.create(input()), b = t.p.create(input('Stays')), g = t.p.createGroup('Trip', [a.id, b.id])
  t.p.edit(a.id, { schedules: [{ name: 'Check', label: 'Every minute', schedule: '* * * * *', tz: 'UTC', ask: 'Scheduled check' }] })
  t.advance(60001); t.p.tick()
  expect(t.jobs()).toHaveLength(1); expect(t.p.pip(a.id).state).toBe('gpt')
  expect(t.p.detail(a.id).runsOn).toMatchObject({ available: true, model: DEFAULT_GPT_MODEL, requestedModel: 'sonnet', schedulesHeld: false })
  t.start(t.jobs()[0]!.id); t.finish(t.jobs()[0]!.id); t.p.tick(); await t.p.flushOtto()
  await t.p.send(g.id, { id: 'manual', text: '@Fares find flights' })
  const first = t.jobs()[1]!
  expect(first.pip?.model).toBe(DEFAULT_GPT_MODEL)
  const parent = t.p.activeHandoff(first.id), follow = t.p.ask(g.id, b.id, 'Find a room', a.id, parent.scheduled)
  t.p.tick()
  expect(t.jobs().find(j => j.id === follow.id)?.pip?.model).toBe(DEFAULT_GPT_MODEL)
  expect(t.p.pip(b.id).state).toBe('gpt')
  expect(t.p.history(g.id).some(m => m.text.includes('now on GPT'))).toBe(true)
  t.restart(); expect(t.p.handoff(follow.id).scheduled).toBe(false)
})
test('failed actions persist retry link and Otto fallback, repeated actions dedupe', async () => {
  const t = setup(), p = t.p.create(input()), h = t.p.ask(p.id, p.id, 'Go'); t.advance(30001); t.p.tick()
  const retry = await t.p.action(h.id, 'retry'); await t.p.action(h.id, 'retry')
  expect(h.actions).toHaveLength(1); expect(retry.retry?.id).toBe(h.actions![0]!.handoffId)
  await t.p.action(h.id, 'ask_otto'); await t.p.action(h.id, 'ask_otto'); expect(t.otto).toHaveLength(1)
  t.restart(); expect(t.p.handoff(h.id).actions).toHaveLength(2)
})
test('live activity, button routing, shared reads, search and named cron schedules', async () => {
  const t = setup(), p = t.p.create(input()), h = t.p.ask(p.id, p.id, 'Review'); t.p.tick()
  t.p.activity(h.jobId!, 'Waiting for your call', [{ label: 'Hold', ask: 'Hold the release' }])
  expect(t.p.list('phone').find(c => c.id === p.id)?.activity[0]?.activity).toBe('Waiting for your call')
  const b = p.buttons[0]!; await t.p.tap(p.id, b.id); await t.p.tap(p.id, b.id)
  expect(t.p.history(p.id).filter(m => m.text.includes('asked Fares'))).toHaveLength(2)
  expect(t.frames.some(f => f.type === 'pip_activity')).toBe(true)
  t.p.read(p.id, 'phone'); expect(t.p.list('desktop').find(c => c.id === p.id)?.unread).toBe(0)
  expect(t.p.search('Fares', 'phone').length).toBeGreaterThan(0)
  t.p.edit(p.id, { schedules: [{ name: 'Morning route check', label: 'Weekdays 7:30', schedule: '30 7 * * 1-5', tz: 'Europe/Berlin', ask: 'Check the route' }] })
  expect(t.p.detail(p.id).nextWakeAt).toBeGreaterThan(0)
  expect(() => t.p.edit(p.id, { schedules: [{ schedule: '* * * * *', tz: 'Invalid/Zone' }] })).toThrow()
})
test('zero pips; unsafe tools, Otto sphere and invalid patch are rejected', () => {
  const t = setup(); t.p.tick(); expect(t.p.list('phone')).toHaveLength(1)
  expect(() => t.p.create({ ...input(), tools: ['Bash'] })).toThrow('tools')
  expect(() => t.p.create({ ...input(), solid: 'sphere' })).toThrow('sphere')
  const p = t.p.create(input()); expect(() => t.p.edit(p.id, { paused: true, name: '' })).toThrow(); expect(p.paused).toBe(false)
})

test('schedules wake their own thread; pause suppresses future wakes and survives restart', () => {
  const t = setup(), p = t.p.create(input())
  t.p.edit(p.id, { schedules: [{ name: 'Minute check', label: 'Every minute UTC', schedule: '* * * * *', tz: 'UTC', ask: 'Check fares' }] })
  t.advance(60000); t.p.tick()
  expect(t.jobs()[0]?.pip?.id).toBe(p.id)
  expect(t.p.history(p.id).some(m => m.handoff_id)).toBe(true)
  t.p.edit(p.id, { paused: true }); t.restart(); t.advance(60000); t.p.tick()
  expect(t.jobs()).toHaveLength(1); expect(t.p.detail(p.id).nextWakeAt).toBeNull()
})

test('the supervisor refuses an expired wake before invoking even a stub runner', async () => {
  const t = setup(), p = t.p.create(input())
  t.p.ask(p.id, p.id, 'Find flights'); t.p.tick()
  const job = t.jobs()[0]!
  updateJob(join(t.stateDir, 'jobs.json'), job.id, j => ({ ...j, pip: { ...j.pip!, deadline: Date.now() - 1 } }))
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'jobs.ts'), '--run', job.id], {
    env: { PATH: process.env.PATH!, HOME: t.stateDir, OTTO_STATE_DIR: t.stateDir, OTTO_JOBS_FILE: join(t.stateDir, 'jobs.json') }, stdout: 'pipe', stderr: 'pipe',
  })
  expect(await proc.exited).toBe(0)
  expect(t.jobs()[0]?.state).toBe('killed')
  expect(t.jobs()[0]?.pip?.readyAt).toBeUndefined()
})

test('an acknowledged Otto send remains in the durable outbox if delivery fails', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'otto-pips-outbox-'))
  let failing = true, delivered = 0
  const o = { stateDir, config: () => ({}), deliverOtto: async () => { if (failing) throw new Error('offline'); delivered++ } }
  let p = new Pips(o), c = p.createGroup('Trip')
  await expect(p.send(c.id, { id: 'queued-user-message', text: 'Plan it' })).rejects.toThrow('offline')
  failing = false; p = new Pips(o); await p.flushOtto()
  await p.send(c.id, { id: 'queued-user-message', text: 'Plan it' })
  expect(delivered).toBe(1); expect(p.history(c.id).filter(m => m.sender === 'user')).toHaveLength(1)
})

test('handoffs in Otto thread include relay times; failure to wake does not reserve a phantom slot', () => {
  const t = setup({ maxAwake: 1 }), a = t.p.create(input()), b = t.p.create(input('Stays'))
  const h = t.p.ask('app', a.id, 'Find flights'); t.p.tick(); t.start(h.jobId!); t.finish(h.jobId!); t.p.tick()
  expect(h.toldOttoAt).toBeTruthy(); expect(h.toldUserAt).toBeTruthy()
  expect(t.p.history('app').some(m => m.sender === 'otto' && m.handoff_id === h.id && m.kind === 'text')).toBe(true)
  t.advance(600001); t.p.tick(); const noWake = t.p.ask(b.id, b.id, 'Wake'); t.p.tick(); t.advance(30001); t.p.tick()
  expect(noWake.status).toBe('failed'); expect(t.p.pip(b.id).awakeUntil).toBeUndefined()
})

test('shared unread watermark includes later messages even in the same millisecond', () => {
  const t = setup(), c = t.p.createGroup('Trip')
  t.p.read(c.id, 'phone'); t.p.message(c.id, 'otto', 'A later reply')
  expect(t.p.list('desktop').find(r => r.id === c.id)?.unread).toBe(1)
})

test('restart reconciles a live stub supervisor without a duplicate turn', () => {
  const t = setup(), p = t.p.create(input()), h = t.p.ask(p.id, p.id, 'Check')
  t.p.tick(); t.start(h.jobId!)
  updateJob(join(t.stateDir, 'jobs.json'), h.jobId!, j => ({ ...j, pip: { ...j.pip!, readyAt: new Date().toISOString(), sessionStarted: true } }))
  t.restart(); t.p.tick(); expect(t.jobs()).toHaveLength(1); expect(t.p.pip(p.id).sessionUsed).toBe(true)
  t.finish(h.jobId!); t.p.tick(); expect(t.p.handoff(h.id).status).toBe('answered')
})

test('queued timeout does not overwrite the activity of a turn already running on that pip', () => {
  const t = setup(), p = t.p.create(input()), running = t.p.ask(p.id, p.id, 'First')
  t.p.tick(); t.start(running.jobId!)
  updateJob(join(t.stateDir, 'jobs.json'), running.jobId!, j => ({ ...j, pip: { ...j.pip!, readyAt: new Date().toISOString() } }))
  t.p.tick(); t.p.activity(running.jobId!, 'Checking fares')
  const queued = t.p.ask(p.id, p.id, 'Second'); t.advance(30001); t.p.tick()
  expect(queued.status).toBe('failed'); expect(p.activity).toBe('Checking fares'); expect(p.state).toBe('working')
})

test('a pip can escalate approval to Otto with a stored relay and conservative source', async () => {
  const t = setup(), p = t.p.create(input()), work = t.p.ask(p.id, p.id, 'Propose a booking')
  t.p.tick(); const h = t.p.askOtto(work.jobId!, 'Please show this booking draft for approval')
  await t.p.flushOtto(); expect(t.otto[0]?.[3]).toBe('pip'); expect(h.to).toBe('otto'); expect(h.toldOttoAt).toBeTruthy()
  t.p.answerOtto(h.id, 'Here is the draft. Approve?'); expect(h.status).toBe('answered'); expect(h.toldUserAt).toBeTruthy()
})

test('long pip replies retain the complete handoff and split visible text without losing output', () => {
  const t = setup(), p = t.p.create(input()), h = t.p.ask(p.id, p.id, 'Research')
  t.p.tick(); t.start(h.jobId!); const reply = 'a'.repeat(40000)
  t.finish(h.jobId!, reply); t.p.tick()
  expect(h.reply).toBe(reply)
  expect(t.p.history(p.id).filter(m => m.sender === p.id).map(m => m.text).join('')).toBe(reply)
})

test('default caps admit three awake pips and retain at most twelve registered pips', () => {
  const t = setup(), pips = Array.from({ length: 12 }, (_, i) => t.p.create(input(`Helper${i}`)))
  for (const p of pips.slice(0, 4)) t.p.ask(p.id, p.id, 'Check')
  t.p.tick(); expect(t.jobs()).toHaveLength(3)
  expect(() => t.p.create(input('OneTooMany'))).toThrow('cap')
})

test('HTTP failed actions, invalid bodies and unsafe edits follow the client contract', async () => {
  const t = setup(), p = t.p.create(input()), h = t.p.ask(p.id, p.id, 'Check')
  t.advance(30001); t.p.tick()
  const request = (path: string, method: string, body: string) => new Request('http://localhost' + path, { method, body, headers: { 'content-type': 'application/json' } })
  const action = await t.p.handle(request(`/app/handoffs/${h.id}/actions`, 'POST', JSON.stringify({ action: 'retry' })), 'phone')
  expect(action.status).toBe(200); expect((await action.json() as any).retry.id).toBe(h.actions![0]!.handoffId)
  const edit = await t.p.handle(request(`/app/pips/${p.id}`, 'PATCH', '{"tools":["Bash"]}'), 'phone')
  expect(edit.status).toBe(400)
  const invalid = await t.p.handle(request(`/app/conversations/${p.id}/messages`, 'POST', 'null'), 'phone')
  expect(invalid.status).toBe(400)
})

test('owner routes validate, publish and archive without losing history or running deleted schedules', async () => {
  const t = setup()
  const request = (path: string, method = 'GET', body?: unknown) => t.p.handle(new Request(`http://localhost/app/${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), 'test-device')
  const json = async (path: string, method = 'GET', body?: unknown) => {
    const r = await request(path, method, body); expect(r.status).toBe(200); return r.json() as Promise<any>
  }
  const tools = await json('pips/tools')
  expect(tools.tools.map((t: any) => t.id)).toContain('WebSearch')
  expect(tools.tools.every((t: any) => typeof t.label === 'string' && t.label.length)).toBe(true)
  expect((await request('pips', 'POST', { ...input(), tools: ['Shell'] })).status).toBe(400)
  const a = await json('pips', 'POST', input()), b = await json('pips', 'POST', input('Stays'))
  expect(a.canReach.some((x: any) => x.name === 'Web search')).toBe(true)
  expect((await request(`pips/${a.id}`, 'PATCH', { tools: ['Shell'] })).status).toBe(400)
  expect((await request(`pips/${a.id}`, 'PATCH', { solid: 'sphere' })).status).toBe(400)
  expect((await request(`pips/${a.id}`, 'PATCH', { colour: 'red' })).status).toBe(400)
  const edited = await json(`pips/${a.id}`, 'PATCH', { solid: 'capsule', colour: '#abcdef', tools: ['Read'] })
  expect(edited.solid).toBe('capsule'); expect(edited.colour).toBe('#abcdef')
  expect(edited.tools).toContain('Read'); expect(edited.tools).not.toContain('WebSearch')
  const g = await json('groups', 'POST', { name: 'Trip', members: [a.id] })
  expect(g.members).toEqual(['otto', a.id]); expect(g.memberStates).toHaveLength(2)
  for (const name of ['', 'a'.repeat(61), null]) expect((await request(`groups/${g.id}`, 'PATCH', { name })).status).toBe(400)
  expect((await request(`groups/${g.id}`, 'PATCH', { name: 'New', other: true })).status).toBe(400)
  const renamed = await json(`groups/${g.id}`, 'PATCH', { name: 'New trip' })
  expect(renamed.name).toBe('New trip'); expect(renamed.lastMessage.text).toBe('Renamed to New trip')
  const added = await json(`groups/${g.id}/members`, 'POST', { pip_id: b.id })
  expect(added.members).toEqual(['otto', a.id, b.id])
  const count = t.p.history(g.id).length, frameCount = t.frames.length
  await json(`groups/${g.id}/members`, 'POST', { pip_id: b.id })
  expect(t.p.history(g.id)).toHaveLength(count)
  expect(t.frames).toHaveLength(frameCount)
  expect((await request(`groups/${g.id}/members/otto`, 'DELETE')).status).toBe(400)
  const removed = await json(`groups/${g.id}/members/${b.id}`, 'DELETE')
  expect(removed.members).toEqual(['otto', a.id]); expect(t.p.pip(b.id).name).toBe('Stays')
  expect(removed.lastMessage.text).toBe('Otto removed Stays')
  for (const id of ['app', a.id]) {
    expect((await request(`groups/${id}`, 'DELETE')).status).toBe(400)
    expect((await request(`groups/${id}`, 'PATCH', { name: 'No' })).status).toBe(400)
    expect((await request(`groups/${id}/members`, 'POST', { pip_id: b.id })).status).toBe(400)
  }
  for (const id of ['otto', 'app']) expect((await request(`pips/${id}`, 'DELETE')).status).toBe(400)
  await json(`pips/${a.id}`, 'PATCH', { schedules: [{ name: 'Check', label: 'Every minute', schedule: '* * * * *', tz: 'UTC', ask: 'Go' }] })
  expect((await request(`pips/${a.id}`, 'DELETE')).status).toBe(204)
  expect(t.p.conversation(g.id).members).toEqual(['otto'])
  expect((await json('pips')).pips.map((p: any) => p.id)).not.toContain(a.id)
  expect((await json('conversations')).conversations.map((c: any) => c.id)).not.toContain(a.id)
  expect(t.p.search('Fares', '').map(r => r.conversation.id)).not.toContain(a.id)
  t.advance(60001); t.p.tick(); expect(t.jobs()).toHaveLength(0)
  expect((await request(`groups/${g.id}`, 'DELETE')).status).toBe(204)
  expect(t.p.list('').map(c => c.id)).not.toContain(g.id)
  expect(t.p.search('New trip', '').map(r => r.conversation.id)).not.toContain(g.id)
  expect(t.p.history(g.id).length).toBeGreaterThan(0)
  expect(t.p.pip(b.id).archived).toBeUndefined()
  expect(t.frames.some(f => f.type === 'conversations_changed')).toBe(true)
  expect(t.frames.some(f => f.type === 'group_link' && f.group.name === 'New trip')).toBe(true)
  t.restart()
  expect(t.p.list('').map(c => c.id)).not.toContain(g.id)
  expect(t.p.history(a.id)).toBeArray()
  expect(t.p.detail(a.id).nextWakeAt).toBeNull()
  t.advance(60001); t.p.tick(); expect(t.jobs()).toHaveLength(0)
})

test('low weekly capacity does not hold owner buttons, Retry or direct pip messages', async () => {
  const t = setup(); t.low()
  const p = t.p.create(input())
  await t.p.send(p.id, { id: 'own-thread', text: 'Find flights' })
  let job = t.jobs()[0]!
  t.start(job.id); t.p.tick()
  t.finish(job.id, JSON.stringify({ text: 'Choose', buttons: [{ label: 'Continue', ask: 'More flights' }] })); t.p.tick()
  const tapped = await t.p.tap(p.id, t.p.pip(p.id).buttons[0]!.id)
  t.p.tick()
  expect(t.jobs().find(j => j.id === tapped.handoff?.id)?.pip?.model).toBe(DEFAULT_GPT_MODEL)
  job = t.jobs()[1]!
  t.start(job.id); t.p.tick()
  updateJob(join(t.stateDir, 'jobs.json'), job.id, j => applyEvent(j, { type: 'fail', at: Date.now(), error: 'Stub failure' }))
  t.p.tick()
  const retried = await t.p.action(tapped.handoff!.id, 'retry')
  expect(t.jobs().find(j => j.id === retried.retry?.id)?.pip?.model).toBe(DEFAULT_GPT_MODEL)
})

test('archiving a pip during a turn preserves history and lets reconciliation finish', () => {
  const t = setup(), p = t.p.create(input()), g = t.p.createGroup('Trip', [p.id])
  t.p.ask(g.id, p.id, 'Find flights'); t.p.tick()
  const job = t.jobs()[0]!
  t.start(job.id); t.p.tick(); t.p.archivePip(p.id)
  t.finish(job.id); expect(() => t.p.tick()).not.toThrow()
  expect(t.p.history(g.id).at(-1)?.text).toBe('Found flights')
  expect(t.p.pip(p.id).state).toBe('asleep')
})

const run = (t: ReturnType<typeof setup>, h: Handoff, result?: string) => { t.p.tick(); t.start(h.jobId!); t.finish(h.jobId!, result); t.p.tick() }
const ownerHandoff = (t: ReturnType<typeof setup>, conversation: string) => t.p.handoff(t.p.history(conversation).findLast(m => m.handoff_id)!.handoff_id!)

test('owner messages, @mentions and button taps are owner handoffs that never reach Otto', async () => {
  const t = setup(), p = t.p.create(input()), g = t.p.createGroup('Trip', [p.id])
  await t.p.send(p.id, { id: 'direct', text: 'Find flights' })
  const direct = ownerHandoff(t, p.id)
  expect(direct).toMatchObject({ from: 'user', to: p.id }); expect(t.p.history(p.id).some(m => m.text === 'You asked Fares')).toBe(true)
  expect(t.jobs()[0]!.task).toContain('Ask from the user:\nFind flights')
  run(t, direct, JSON.stringify({ text: 'Book it?', buttons: [{ label: 'Book', ask: 'book it' }] }))
  expect(direct).toMatchObject({ status: 'answered', reply: 'Book it?' }); expect(direct.toldUserAt).toBeTruthy()
  expect(direct.relayedTo).toBeUndefined(); expect(direct.toldOttoAt).toBeUndefined()
  const button = t.p.history(p.id).findLast(m => m.buttons?.length)!.buttons![0]!
  const { handoff: tapped } = await t.p.tap(p.id, button.id) as { handoff: Handoff }
  expect(tapped.from).toBe('user'); run(t, tapped)
  await t.p.send(g.id, { id: 'mention', text: '@Fares find hotels' })
  const mention = ownerHandoff(t, g.id)
  expect(mention.from).toBe('user'); run(t, mention)
  expect(t.results).toEqual([]); expect(t.otto).toEqual([])
})

test('Otto-started, scheduled and pip-to-Otto handoffs keep reporting to Otto', async () => {
  const t = setup(), p = t.p.create(input())
  const fromOtto = t.p.ask(p.id, p.id, 'Find flights'); run(t, fromOtto)
  expect(fromOtto).toMatchObject({ from: 'otto', relayedTo: 'otto' }); expect(fromOtto.toldOttoAt).toBeTruthy()
  const scheduled = t.p.ask(p.id, p.id, 'Daily check', 'otto', true); run(t, scheduled); await t.p.flushOtto(); await t.p.flushOtto()
  expect(t.results.map(h => h.id)).toEqual([fromOtto.id, scheduled.id])
  await t.p.send(p.id, { id: 'owner', text: 'Propose a booking' })
  const owner = ownerHandoff(t, p.id); t.p.tick()
  const asked = t.p.askOtto(owner.jobId!, 'Please approve'); await t.p.flushOtto()
  expect(asked.from).toBe(p.id); expect(t.otto[0]?.[3]).toBe('pip'); expect(asked.toldOttoAt).toBeTruthy()
})

test('Retry keeps the original sender and its reporting', async () => {
  const t = setup(), p = t.p.create(input())
  await t.p.send(p.id, { id: 'owner', text: 'Find flights' })
  const owner = ownerHandoff(t, p.id)
  t.advance(30001); t.p.tick(); expect(owner.status).toBe('failed'); expect(t.results).toEqual([])
  const { retry } = await t.p.action(owner.id, 'retry')
  expect(retry!.from).toBe('user'); run(t, retry!); expect(t.results).toEqual([])
  const otto = t.p.ask(p.id, p.id, 'Check'); t.advance(30001); t.p.tick(); expect(otto.status).toBe('failed'); expect(t.results.map(h => h.id)).toEqual([otto.id])
  expect((await t.p.action(otto.id, 'retry')).retry!.from).toBe('otto')
})

test('a pip can hand off to another pip after an owner message', async () => {
  const t = setup(), a = t.p.create(input()), b = t.p.create(input('Stays')), g = t.p.createGroup('Trip', [a.id, b.id])
  await t.p.send(g.id, { id: 'owner', text: '@Fares find flights' })
  const owner = ownerHandoff(t, g.id); t.p.tick()
  const next = t.p.ask(g.id, b.id, 'Find a hotel near the airport', a.id)
  expect(next.from).toBe(a.id); expect(t.p.history(g.id).some(m => m.text === 'Fares asked Stays')).toBe(true)
  run(t, owner, 'Flights found'); run(t, next, 'Hotel found')
  expect(next).toMatchObject({ status: 'answered', reply: 'Hotel found' }); expect(owner.status).toBe('answered')
  expect(t.p.history(g.id).some(m => m.sender === b.id && m.text === 'Hotel found')).toBe(true)
  expect(t.results.map(h => h.id)).toEqual([next.id])
})


test('wake audit and usage survive restart and job pruning without double counting', async () => {
  const t = setup(), p = t.p.create(input())
  for (const [from, scheduled, tokens] of [['user', false, 12], ['otto', false, 34], ['otto', true, 56]] as const) {
    const h = t.p.ask(p.id, p.id, 'Check', from, scheduled); t.p.tick()
    updateJob(join(t.stateDir, 'jobs.json'), h.jobId!, j => ({ ...applyEvent(j, { type: 'start', at: Date.now() }), tokensUsed: tokens, pip: { ...j.pip!, readyAt: new Date().toISOString() } }))
    t.finish(h.jobId!); t.p.tick(); await t.p.flushOtto(); await t.p.flushOtto()
  }
  t.restart(); t.p.tick()
  expect(t.p.detail(p.id).usage).toMatchObject({ runs: 3, tokens: 102 })
  expect(t.p.detail(p.id).wakes.map(w => [w.trigger, w.outcome])).toEqual([['owner_message', 'answered'], ['handoff', 'answered'], ['schedule', 'answered']])
  writeFileSync(join(t.stateDir, 'jobs.json'), '[]'); t.restart(); t.p.tick()
  expect(t.p.detail(p.id).usage).toMatchObject({ runs: 3, tokens: 102 })
})

test('a result notification lost during restart replays under its stable ID, with one visible reply', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'otto-pip-replay-')), received = new Set<string>()
  let offline = true
  const options = { stateDir, config: () => ({}), resultToOtto: async (h: Handoff) => {
    if (offline) throw new Error('offline')
    received.add(h.id)
  } }
  let pips = new Pips(options), p = pips.create(input()), h = pips.ask(p.id, p.id, 'Check')
  pips.tick()
  updateJob(join(stateDir, 'jobs.json'), h.jobId!, j => applyEvent(applyEvent(j, { type: 'start', at: Date.now() }), { type: 'finish', at: Date.now(), result: 'Saved result' }))
  pips = new Pips(options); pips.tick()
  await expect(pips.flushOtto()).rejects.toThrow('offline')
  expect(pips.handoff(h.id).toldOttoAt).toBeUndefined()
  offline = false; pips = new Pips(options); await pips.flushOtto(); pips.tick(); await pips.flushOtto()
  pips = new Pips(options); pips.tick(); await pips.flushOtto()
  expect([...received]).toEqual([h.id]); expect(pips.handoff(h.id).toldOttoAt).toBeTruthy()
  expect(pips.history(p.id).filter(m => m.text === 'Saved result')).toHaveLength(1)
})

test('a dead supervisor and a turn past its wall clock fail visibly with working recovery actions', async () => {
  for (const crashed of [true, false]) {
    const t = setup(), p = t.p.create(input()), h = t.p.ask(p.id, p.id, 'Check', 'user'); t.p.tick()
    updateJob(join(t.stateDir, 'jobs.json'), h.jobId!, j => ({ ...applyEvent(j, { type: 'start', at: Date.parse(h.askedAt), pid: 2147483647 }), pip: { ...j.pip!, readyAt: h.askedAt, supervisorPid: crashed ? 2147483647 : process.pid } }))
    if (!crashed) t.advance(600001)
    t.restart(); t.p.tick()
    expect(t.p.handoff(h.id)).toMatchObject({ status: 'failed', error: crashed ? 'pip runner crashed' : 'pip runner timed out' })
    expect(t.p.history(p.id).at(-1)?.text).toContain('failed')
    expect((await t.p.action(h.id, 'retry')).retry?.status).toBe('asked')
    await t.p.action(h.id, 'ask_otto'); expect(t.otto).toHaveLength(1)
  }
})

test('Codex fallback requires a fresh weekly reading strictly below 25% remaining', () => {
  const now = Date.now()
  for (const [used, at, reset, model] of [
    [75, now, now + 86400000, 'sonnet'],
    [75.1, now, now + 86400000, DEFAULT_GPT_MODEL],
    [90, now - 86400000, now + 86400000, 'sonnet'],
    [90, now, now - 1, 'sonnet'],
  ] as const) {
    const stateDir = mkdtempSync(join(tmpdir(), 'otto-pip-capacity-'))
    writeFileSync(join(stateDir, 'plan-usage.json'), JSON.stringify({ at, seven_day: { used_percentage: used, resets_at: reset / 1000 } }))
    const pips = new Pips({ stateDir, config: () => ({}), now: () => now }), pip = pips.create(input())
    pips.ask(pip.id, pip.id, 'Check', 'user'); pips.tick()
    expect(loadJobs(join(stateDir, 'jobs.json'))[0]?.pip?.model).toBe(model)
    expect(pips.detail(pip.id).runsOn.model).toBe(model)
  }
})


test('explicit Codex model is accepted through the existing pip creation API', async () => {
  const t = setup()
  const response = await t.p.handle(new Request('http://localhost/app/pips', { method: 'POST', body: JSON.stringify({ ...input(), model: 'gpt-6.1-sol' }) }), 'test-device')
  expect(response.status).toBe(200)
  const pip = await response.json() as any
  expect(pip.runsOn.model).toBe('gpt-6.1-sol')
  t.p.ask(pip.id, pip.id, 'Check', 'user'); t.p.tick()
  expect(t.jobs()[0]?.pip?.model).toBe('gpt-6.1-sol')
  expect(t.p.pip(pip.id).state).toBe('gpt')
})

test('fresh and resumed wakes bound conversation messages independently', () => {
  for (const resumed of [false, true]) {
    const t = setup(), p = t.p.create(input())
    p.sessionUsed = resumed
    for (let i = 0; i < 25; i++) t.p.message(p.id, 'otto', String(i).padEnd(2500, 'x'), 'text')
    t.p.ask(p.id, p.id, 'Go'); t.p.tick()
    const context = JSON.parse(t.jobs()[0]!.task.split('Conversation context (data):\n')[1]!.split('\nReturn JSON')[0]!)
    expect(context).toHaveLength(resumed ? 8 : 20)
    expect(Math.max(...context.map((m: any) => m.text.length))).toBe(resumed ? 600 : 2000)
  }
})
test('run token breakdown and cost reach handoff, activity and persisted totals', async () => {
  const t = setup(), p = t.p.create(input()), h = t.p.ask(p.id, p.id, 'Go')
  t.p.tick()
  let tally = tallyStream(EMPTY_TALLY, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300 } } }))
  tally = tallyStream(tally, JSON.stringify({ type: 'result', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300 }, total_cost_usd: 0.012 }))
  updateJob(join(t.stateDir, 'jobs.json'), h.jobId!, j => ({ ...j, tokensUsed: tally.tokens, usage: tally.usage, costUsd: tally.costUsd }))
  const activity = t.p.activity(h.jobId!, 'Checking')
  expect(h).toMatchObject({ tokens: 420, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300 }, costUsd: 0.012 })
  expect(activity.lastWake).toMatchObject({ tokens: 420, costUsd: 0.012 })
  expect(activity.usage).toMatchObject({ tokens: 420, inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, costUsd: 0.012 })
  t.start(h.jobId!); t.finish(h.jobId!); t.p.tick(); t.restart()
  expect(t.p.detail(p.id).usage.costUsd).toBe(0.012)
  const rows = await collectStatus({ stateDir: t.stateDir, usageHome: t.stateDir, now: Date.now(), http: async () => ({ status: 200 }), run: async () => true, pidAlive: () => true })
  expect(rows.find(r => r.id === 'pips')?.detail).toContain('last wake 420 tokens ($0.0120); total 420 tokens ($0.0120)')
  expect(tallyCodex(EMPTY_TALLY, JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80 } }))).toMatchObject({ tokens: 120, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 } })
})
test('a pip wake has no token ceiling: no warning, and the budget never kills it', () => {
  const t = setup(), p = t.p.create(input()), group = t.p.createGroup('Research', [p.id])
  const h = t.p.ask(group.id, p.id, 'Go'); t.p.tick()
  updateJob(join(t.stateDir, 'jobs.json'), h.jobId!, j => ({ ...j, tokensUsed: 50_000_000 }))
  t.p.tick()
  expect(t.p.history(p.id).some(m => m.text.startsWith('Wake budget:'))).toBe(false)
  const j = loadJobs(join(t.stateDir, 'jobs.json')).find(j => j.id === h.jobId)!
  expect(budgetExceeded(j)).toBe(false)
})
test("search skips Otto's messages without text, like a photo", () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'otto-pips-'))
  const photo = { id: 'p1', conversation_id: 'app', sender: 'user', kind: 'text', ts: '2026-11-09T08:00:00Z' } as any
  const p = new Pips({ stateDir, config: () => ({}), ottoHistory: () => [photo, { ...photo, id: 't1', text: 'Boiler service on Friday' }] })
  expect(p.search('boiler', 'phone').map(r => r.conversation.id)).toEqual(['app'])
})
