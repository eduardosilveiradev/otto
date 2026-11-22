import { test, expect } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Overnight } from '../overnight.ts'
import { freshState } from '../origin.ts'
import { Pips } from '../pips.ts'
import { createJob, saveJobs } from '../jobs.ts'
import { startTwin } from './apptwin.ts'
import { startFakeT3, fakeCheckout } from './faket3.ts'

for (const origin of ['triggered', 'model-authored'] as const) {
  test(`pip coding audits retain ${origin}; expiry leaves activity and handoffs working`, async () => {
    const fake = startFakeT3()
    fake.projects.push({ id: 'demo', title: 'demo', workspaceRoot: fakeCheckout(), defaultModelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol' } })
    let t = await startTwin(undefined, { OTTO_T3_URL: fake.url })
    try {
      await t.stop()
      writeFileSync(join(t.state, 't3-token'), fake.token)
      const window = new Overnight(t.state), armed = window.control('start', freshState(), false, new Date(Date.now() + 3600_000).toISOString())
      const pips = new Pips({ stateDir: t.state, config: () => ({}) })
      const pip = pips.create({ name: 'Coordinator', job: 'Coordinate tests', instructions: 'Coordinate test work.', tools: ['mcp__plugin_otto_otto__code_job', 'mcp__plugin_otto_otto__code_job_answer', 'mcp__plugin_otto_otto__code_jobs'], solid: 'gem', colour: '#123abc' })
      const handoff = pips.ask(pip.id, pip.id, 'Coordinate tests', 'otto', false, origin, undefined, armed.id)
      handoff.jobId = handoff.id
      pips.message(pip.id, 'otto', 'Test handoff recorded', 'system')
      const job = createJob({ task: 'Coordinate tests', tools: pip.tools }, { scratchRoot: join(t.state, 'jobs'), id: handoff.id })
      job.state = 'running'; job.startedAt = new Date().toISOString()
      job.pip = { id: pip.id, overnightId: armed.id, model: 'sonnet', sessionId: pip.sessionId, resume: false, codeJobsAllowed: true, deadline: Date.now() + 30000, readyAt: new Date().toISOString(), supervisorPid: process.pid }
      saveJobs(join(t.state, 'jobs.json'), [job])
      t = await t.restart()
      const call = (operation: string, args: unknown) => fetch(t.url + '/', { method: 'POST', headers: { authorization: 'Bearer twin-webhook-token', 'content-type': 'application/json' }, body: JSON.stringify({ source: 'otto-pip', pipJob: job.id, operation, args }) })
      const input = { project: 'demo', title: 'Repair parser', brief: 'Repair a parser', repo: 'example/demo', model: 'gpt-6.1-sol' }
      const response = await call('code_job', input)
      expect(response.status).toBe(200)
      const started = await response.json() as any
      expect((await call('code_job_answer', { id: started.id, text: 'Check parsing too' })).status).toBe(200)
      const log = () => JSON.parse(readFileSync(join(t.state, 'capability-log.json'), 'utf8')) as any[]
      expect(log()).toHaveLength(2)
      for (const entry of log()) expect(entry).toMatchObject({ origin, tier: 'unattended', windowId: armed.id })
      expect((await call('code_job_answer', { id: 'not-owned', text: 'Fail' })).status).toBe(403)
      expect(log()).toHaveLength(2)
      window.control('stop', freshState(), false)
      const status = origin === 'triggered' ? 400 : 200
      expect((await call('code_job', { ...input, title: 'Repair another parser' })).status).toBe(status)
      expect((await call('code_job_answer', { id: started.id, text: 'Check once more' })).status).toBe(status)
      expect((await call('code_jobs', {})).status).toBe(200)
      expect((await call('pip_activity', { text: 'Still coordinating' })).status).toBe(200)
      expect((await call('pip_handoff', { conversation_id: pip.id, pip_id: 'otto', ask: 'Status update' })).status).toBe(200)
      expect(log()).toHaveLength(2)
    } finally { await t.stop(); fake.stop() }
  }, 30000)
}
