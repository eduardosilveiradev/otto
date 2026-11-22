import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pips } from '../pips.ts'
import { loadJobs, updateJob, runnerArgs, tallyCodex, EMPTY_TALLY } from '../jobs.ts'

const input = { name: 'Helper', job: 'Research', instructions: 'Read and report.', tools: ['WebSearch'], solid: 'gem', colour: '#123abc' }
function setup(codex = false) {
  const stateDir = mkdtempSync(join(tmpdir(), 'otto-runner-')), bin = join(stateDir, 'bin'), argsFile = join(stateDir, 'args.json')
  mkdirSync(bin); mkdirSync(join(stateDir, '.local', 'bin'), { recursive: true })
  const file = join(stateDir, 'jobs.json'), pips = new Pips({ stateDir, config: () => ({}), lowClaude: () => codex })
  const pip = pips.create(input), handoff = pips.ask(pip.id, pip.id, 'Check', 'user'); pips.tick()
  mkdirSync(loadJobs(file)[0]!.scratchDir, { recursive: true })
  const stub = `#!${process.execPath}
import { writeFileSync, readFileSync } from 'node:fs'
// Read from a file, not env: the runner hands its child only allowlisted env (headless.ts).
const stub = JSON.parse(readFileSync(${JSON.stringify(join(stateDir, 'stub.json'))}, 'utf8'))
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)))
for (const event of stub.STUB_EVENTS) console.log(JSON.stringify(event))
if (stub.STUB_HANG) setInterval(() => {}, 1000)
else process.exit(Number(stub.STUB_EXIT || 0))
`
  const install = (broken = false) => writeFileSync(codex ? join(bin, 'codex') : join(stateDir, '.local', 'bin', 'claude'), broken ? '#!/missing/pip-runner\n' : stub, { mode: 0o700 })
  const run = async (events: unknown[], extra: Record<string, string> = {}) => {
    writeFileSync(join(stateDir, 'stub.json'), JSON.stringify({ STUB_EVENTS: events, ...extra }))
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'jobs.ts'), '--run', handoff.id], {
      env: { PATH: bin, HOME: stateDir, OTTO_STATE_DIR: stateDir, OTTO_JOBS_FILE: file },
      stdout: 'pipe', stderr: 'pipe',
    })
    const error = new Response(proc.stderr).text()
    const code = await proc.exited; expect(await error).toBe(''); expect(code).toBe(0)
    pips.tick()
    return loadJobs(file)[0]!
  }
  return { stateDir, file, pips, pip, handoff, install, run, args: () => JSON.parse(readFileSync(argsFile, 'utf8')) as string[] }
}

test('Codex stream reports usage without counting cached input twice and preserves failure text', () => {
  let tally = tallyCodex(EMPTY_TALLY, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Result' } }))
  tally = tallyCodex(tally, JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 10 } }))
  expect(tally).toMatchObject({ result: 'Result', tokens: 60, ok: true })
  expect(tallyCodex(tally, JSON.stringify({ type: 'turn.failed', error: { message: 'Offline' } }))).toMatchObject({ ok: false, result: 'Offline' })
})

test('stub Codex runs, resumes its own session, keeps Otto tools and never uses Claude session IDs', async () => {
  const t = setup(true); t.install()
  const job = await t.run([
    { type: 'thread.started', thread_id: 'codex-session' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Found it' } },
    { type: 'turn.completed', usage: { input_tokens: 40, output_tokens: 2 } },
  ])
  expect(job).toMatchObject({ state: 'done', tokensUsed: 42, pip: { sessionId: 'codex-session', sessionStarted: true } })
  expect(t.pips.detail(t.pip.id)).toMatchObject({ state: 'gpt', usage: { runs: 1, tokens: 42 } })
  const args = t.args()
  expect(args).toContain('--ignore-user-config'); expect(args).toContain('features.shell_tool=false')
  expect(args).toContain('sandbox_mode="read-only"'); expect(args).toContain('approval_policy="never"')
  expect(args).toContain('mcp_servers.plugin_otto_otto.enabled_tools=["recall","remember","pip_activity","pip_handoff"]')
  expect(args.some(a => a.includes('OTTO_ORIGIN_PIN="external-content"'))).toBe(true)
  expect(args).not.toContain('--resume'); expect(args).not.toContain(t.pip.sessionId)
  const restarted = new Pips({ stateDir: t.stateDir, config: () => ({}), lowClaude: () => true })
  const next = restarted.ask(t.pip.id, t.pip.id, 'Again', 'user'); restarted.tick()
  const resumed = loadJobs(t.file).find(j => j.id === next.id)!
  expect(runnerArgs(resumed).slice(0, 3)).toEqual(['exec', 'resume', 'codex-session'])
  expect(restarted.pip(t.pip.id).sessionUsed).toBe(false)
  const claude = new Pips({ stateDir: t.stateDir, config: () => ({}), lowClaude: () => false })
  // Finish the Codex turn, then the next wake returns to the separate Claude session.
  updateJob(t.file, next.id, j => ({ ...j, state: 'done', result: 'Done' })); claude.tick()
  const back = claude.ask(t.pip.id, t.pip.id, 'Use Claude', 'user'); claude.tick()
  expect(loadJobs(t.file).find(j => j.id === back.id)?.pip).toMatchObject({ model: 'sonnet', resume: false, sessionId: t.pip.sessionId })
})

test('stub Claude usage and session stay resumable', async () => {
  const t = setup(); t.install()
  const job = await t.run([
    { type: 'system', subtype: 'init' },
    { type: 'result', subtype: 'success', result: 'Found it', usage: { input_tokens: 15, output_tokens: 3 } },
  ])
  expect(job.state).toBe('done')
  expect(t.pips.detail(t.pip.id)).toMatchObject({ usage: { runs: 1, tokens: 18 }, sessionUsed: true })
  expect(t.args()).toContain('--session-id'); expect(t.args()).toContain('--strict-mcp-config')
  expect(t.args().join(' ')).toContain('--autocompact 120000')
})

test('missing CLI, crashing runner, empty success and timeout all fail visibly', async () => {
  for (const failure of ['missing', 'spawn', 'crash', 'empty', 'timeout', 'nonzero', 'blank'] as const) {
    const t = setup(true)
    if (failure !== 'missing') t.install(failure === 'spawn')
    if (failure === 'timeout') updateJob(t.file, t.handoff.id, j => ({ ...j, wallClockMs: 100 }))
    const job = await t.run(failure === 'nonzero' || failure === 'blank' ? [{ type: 'turn.completed', usage: {} }] : [], failure === 'crash' || failure === 'nonzero' ? { STUB_EXIT: '1' } : failure === 'timeout' ? { STUB_HANG: '1' } : {})
    expect(['failed', 'killed']).toContain(job.state)
    expect(t.pips.handoff(t.handoff.id).status).toBe('failed')
    expect(t.pips.history(t.pip.id).at(-1)?.text).toContain('failed')
    expect((await t.pips.action(t.handoff.id, 'retry')).retry?.status).toBe('asked')
  }
})
