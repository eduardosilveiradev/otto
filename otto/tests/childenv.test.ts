import { test, expect } from 'bun:test'
import { headlessEnv, noToolArgs } from '../headless.ts'
import { runnerEnv, runnerArgs, type Job } from '../jobs.ts'
import { headlessArgs, ALLOWED_TOOLS } from '../consolidate.ts'

const base = { PATH: '/bin', HOME: '/h', TMPDIR: '/t', OTTO_STATE_DIR: '/s', TEST_SECRET: 'zebra42', TELEGRAM_BOT_TOKEN: 'x', OTTO_RELAY_SECRET: 'y', OTTO_CHANNEL_HOST: '1', OTTO_SUPERVISED: '1' }
const pipJob = { id: 'job1', task: 'hi', tools: ['Read', 'WebFetch', 'mcp__plugin_otto_otto__recall'], pip: { id: 'pip1', model: 'sonnet', sessionId: 's', resume: false } } as unknown as Job

test('child env keeps the allowlist and none of the .env secrets', () => {
  for (const env of [headlessEnv(base), runnerEnv(pipJob, base)]) {
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/h', TMPDIR: '/t', OTTO_STATE_DIR: '/s' })
    for (const k of ['TEST_SECRET', 'TELEGRAM_BOT_TOKEN', 'OTTO_RELAY_SECRET', 'OTTO_CHANNEL_HOST', 'OTTO_SUPERVISED']) expect(env[k]).toBeUndefined()
  }
  expect(JSON.stringify(runnerEnv(pipJob, base))).not.toContain('zebra42')
})

test('consolidation and triage children are cut to their tools with --tools', () => {
  const c = headlessArgs('p', { tools: ALLOWED_TOOLS })
  expect(c[c.indexOf('--tools') + 1]).toBe('Read,Grep,Glob')
  expect(c[c.indexOf('--disallowedTools') + 1]).toContain('mcp__plugin_otto_otto__reply')
  const t = noToolArgs('p', 'haiku')
  expect(t[t.indexOf('--tools') + 1]).toBe('')
})

test('a pip cannot Read, Grep or Glob the state dir; a plain job is not limited', () => {
  const args = runnerArgs(pipJob)
  expect(args[args.indexOf('--disallowedTools') + 1].split(',').some(r => /^Read\(\/\/.+\/\*\*\)$/.test(r))).toBe(true)
  const plain = runnerArgs({ ...pipJob, pip: undefined } as Job)
  expect(plain[plain.indexOf('--disallowedTools') + 1]).not.toContain('Read(')
})

