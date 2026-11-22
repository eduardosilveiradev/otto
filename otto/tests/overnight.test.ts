import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Overnight } from '../overnight.ts'
import { freshState, onWake, taint } from '../origin.ts'
import { Pips } from '../pips.ts'
import { loadJobs } from '../jobs.ts'
import { updateCodeJob, CodeJobs } from '../codejobs.ts'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'overnight-'))
  let now = Date.parse('2026-11-10T20:00:00Z')
  const clock = () => now, o = new Overnight(dir, clock)
  const until = '2026-11-11T08:00:00Z'
  const start = () => o.control('start', freshState(), false, until)
  const meter = (pct = 90) => writeFileSync(join(dir, 'plan-usage.json'), JSON.stringify({ at: now, five_hour: { used_percentage: pct, resets_at: (now + 3600_000) / 1000 } }))
  return { dir, o, clock, until, start, meter, advance: (ms: number) => { now += ms }, clean: () => rmSync(dir, { recursive: true, force: true }) }
}
const wake = (event: string) => onWake(freshState(), { kind: 'event', event })
test('only owner requests can arm or stop; window survives restart and expires exactly at until', () => {
  const t = setup()
  try {
    for (const state of [wake('job'), wake('trigger'), wake('email-scan'), wake('webhook'), taint(freshState(), 'shared content')]) {
      for (const action of ['start', 'stop']) expect(() => t.o.control(action, state, false, t.until)).toThrow()
    }
    expect(() => t.o.control('start', freshState(), true, t.until)).toThrow()
    expect(() => t.o.control('start', freshState(), false, 'tomorrow')).toThrow()
    expect(() => t.o.control('start', freshState(), false, t.until, 101)).toThrow()
    expect(() => t.o.control('start', freshState(), false, new Date(t.clock() + 24 * 3600_000 + 1).toISOString())).toThrow('within 24 hours')
    const first = t.start()
    const replacement = t.o.control('start', wake('button'), false, new Date(t.clock() + 24 * 3600_000).toISOString())
    expect(replacement).toMatchObject({ replacedWindowId: first.id })
    expect(replacement.id).not.toBe(first.id)
    expect(new Overnight(t.dir, t.clock).status()).toMatchObject({ active: true, reserve: 90 })
    t.o.control('stop', freshState(), false); expect(t.o.active()).toBeUndefined()
    t.start(); t.advance(12 * 3600_000); expect(t.o.authorized(wake('job'))).toBeUndefined()
  } finally { t.clean() }
})
test('internal events authorize the named tools only while armed, never email, webhooks or subsequent taint', () => {
  const t = setup()
  try {
    expect(t.o.authorized(wake('job'))).toBeUndefined(); t.start()
    for (const event of ['job', 'trigger', 'pr-merged', 'button']) {
      const state = wake(event), id = t.o.authorized(state)!
      expect(id).toBe(t.o.active()!.id)
      t.o.log('code_job', id, state.origin, { tier: 'unattended' })
    }
    expect(t.o.status().actions).toBe(3)
    for (const state of [wake('email-scan'), wake('webhook'), taint(wake('job'), 'web page'), taint(wake('trigger'), 'shared content')]) expect(t.o.authorized(state)).toBeUndefined()
  } finally { t.clean() }
})
test('reserve holds Claude coding starts across restart, lets GPT through, and releases the same id at reset', async () => {
  const t = setup(), launches: any[] = []
  try {
    t.start(); t.meter()
    const options = { file: join(t.dir, 'code-jobs.json'), now: t.clock, exec: async () => '', t3: {
      projects: async () => [{ id: 'demo', name: 'Demo', root: '', model: 'gpt-6.1-sol' }], threads: async () => new Map(),
      launch: async (input: any) => { launches.push(input); return { threadId: `t${launches.length}` } },
      send: async () => {}, answer: async () => false, interrupt: async () => {},
    } }
    const jobs = new CodeJobs(options)
    const held = await jobs.start({ project: 'demo', title: 'Fix parser', brief: 'Repair parsing', model: 'sonnet' })
    expect(held.state).toBe('queued'); expect(launches).toHaveLength(0)
    t.meter(89); expect(t.o.hold('another-claude', 'opus')).toBe(true)
    expect(t.o.hold('another-gpt', 'gpt-6.1-sol')).toBe(false)
    expect(t.o.hold('switch-to-gpt', 'sonnet')).toBe(true)
    expect(t.o.hold('switch-to-gpt', 'gpt-6.1-sol')).toBe(false)
    await jobs.start({ project: 'demo', title: 'Fix reader', brief: 'Repair reading', model: 'gpt-6.1-sol' })
    expect(launches).toHaveLength(1)
    const predecessor = await jobs.start({ project: 'demo', title: 'Default GPT', brief: 'Repair defaults' })
    expect(launches).toHaveLength(2)
    const dependent = await jobs.start({ project: 'demo', title: 'Dependent Claude', brief: 'Repair after merge', model: 'sonnet', after: predecessor.id })
    await jobs.poll(); expect(launches).toHaveLength(2)
    updateCodeJob(options.file, predecessor.id, j => ({ ...j, mergedAt: new Date(t.clock()).toISOString() }))
    await jobs.poll(); expect(launches).toHaveLength(2)
    expect(jobs.list().find(j => j.id === dependent.id)?.reserveHeld).toBe(true)
    t.advance(31 * 60_000); await new CodeJobs(options).poll(); expect(launches).toHaveLength(2)
    t.advance(29 * 60_000); await new CodeJobs(options).poll()
    expect(launches).toHaveLength(4); expect(jobs.list().find(j => j.id === held.id)?.threadId).toBe('t3')
    expect(t.o.status().held).toBe(0)
  } finally { t.clean() }
})
test('pip reserve pauses wake timeout and job-event handoffs carry window rights only inside the window', () => {
  const t = setup()
  try {
    const pips = new Pips({ stateDir: t.dir, now: t.clock, config: () => ({}) })
    const p = pips.create({ name: 'Builder', job: 'Review code', instructions: 'Review', tools: ['mcp__plugin_otto_otto__code_job'], solid: 'gem', colour: '#123abc' })
    const state = wake('job')
    const outside = pips.ask(p.id, p.id, 'Review', 'otto', false, state.origin, undefined, t.o.authorized(state))
    pips.tick(); expect(loadJobs(join(t.dir, 'jobs.json'))[0].pip?.codeJobsAllowed).toBe(false)
    // Use a separate pip so the first running handoff cannot block the reserve case.
    const q = pips.create({ name: 'Checker', job: 'Check code', instructions: 'Check', tools: ['mcp__plugin_otto_otto__code_job'], solid: 'gem', colour: '#123abc' })
    t.start(); t.meter()
    const h = pips.ask(q.id, q.id, 'Check', 'otto', false, state.origin, undefined, t.o.authorized(state))
    pips.tick(); expect(h.reserveHeld).toBe(true)
    const g = pips.create({ name: 'GPT helper', job: 'Check defaults', instructions: 'Check', model: 'gpt-6.1-sol', tools: [], solid: 'gem', colour: '#123abc' })
    const gh = pips.ask(g.id, g.id, 'Check', 'user'); pips.tick()
    expect(loadJobs(join(t.dir, 'jobs.json')).find(j => j.id === gh.id)?.pip?.model).toBe('gpt-6.1-sol')
    t.advance(3600_000); pips.tick()
    const job = loadJobs(join(t.dir, 'jobs.json')).find(j => j.id === h.id)!
    expect(h.status).toBe('asked'); expect(job.pip?.codeJobsAllowed).toBe(true)
    expect(job.pip?.deadline).toBe(t.clock() + 30_000)
    expect(outside.overnightId).toBeUndefined()
  } finally { t.clean() }
})
