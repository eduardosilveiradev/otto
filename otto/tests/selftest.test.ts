import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  selfTestPlan,
  scrubEnv,
  scratchAccess,
  assertDisconnected,
  materialize,
  summarize,
  SCRUBBED,
  COPIED_STATE,
  SELFTEST_PROMPT,
  LIVE_STATE_DIR,
} from '../selftest.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-selftest-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

function plan(over: Partial<Parameters<typeof selfTestPlan>[0]> = {}) {
  return selfTestPlan({
    worktree: join(tmp, 'worktree'),
    liveStateDir: join(tmp, 'live'),
    scratchRoot: mkdtempSync(join(tmp, 'scratch-')),
    env: { PATH: '/usr/bin', OTTO_CHANNEL_HOST: '1', TELEGRAM_BOT_TOKEN: 'secret' },
    ...over,
  })
}

// The single most important line in the file: run.sh exports OTTO_CHANNEL_HOST
// for the whole session, so an inherited environment makes the twin seize the
// token and leave the real assistant deaf.
test('the channel-host flag never survives into the twin', () => {
  const env = scrubEnv({ OTTO_CHANNEL_HOST: '1', PATH: '/usr/bin' })
  expect(env.OTTO_CHANNEL_HOST).toBeUndefined()
  expect(env.PATH).toBe('/usr/bin')
})

test('the bot token is scrubbed too — the second lock', () => {
  expect(scrubEnv({ TELEGRAM_BOT_TOKEN: 'x' }).TELEGRAM_BOT_TOKEN).toBeUndefined()
  for (const k of SCRUBBED) expect(scrubEnv({ [k]: 'x' })[k]).toBeUndefined()
})

// An empty string is still a value; code checking presence would be fooled.
test('scrubbing removes the key rather than blanking it', () => {
  expect('OTTO_CHANNEL_HOST' in scrubEnv({ OTTO_CHANNEL_HOST: '1' })).toBe(false)
})

test('the twin is started without --channels, so it never advertises the capability', () => {
  expect(plan().argv).not.toContain('--channels')
  expect(plan().argv).toContain('-p')
})

test('state is pointed at scratch, never at the live directory', () => {
  const p = plan()
  expect(p.env.OTTO_STATE_DIR).toBe(p.stateDir)
  expect(p.env.OTTO_STATE_DIR).not.toStartWith(LIVE_STATE_DIR)
  expect(p.env.OTTO_STATE_DIR).not.toContain('.claude/channels/otto')
  expect(p.env.OTTO_PROJECTS_DIR).toStartWith(p.stateDir)
})

// The third lock: even a twin that somehow became a host has no allowed chat.
test('the scratch allowlist rejects every chat there is', () => {
  const a = JSON.parse(scratchAccess())
  expect(a.dmPolicy).toBe('disabled')
  expect(a.allowFrom).toEqual([])
  expect(a.pending).toEqual({})
  expect(a.emailScanMinutes).toBe(0)
})

test('assertDisconnected catches a badly built plan', () => {
  const p = plan()
  expect(() => assertDisconnected(p)).not.toThrow()

  expect(() => assertDisconnected({ ...p, env: { ...p.env, OTTO_CHANNEL_HOST: '1' } })).toThrow(/survived/)
  expect(() => assertDisconnected({ ...p, argv: [...p.argv, '--channels', 'x'] })).toThrow(/channel host/)
  expect(() =>
    assertDisconnected({ ...p, env: { ...p.env, OTTO_STATE_DIR: '/home/x/.claude/channels/otto' } }),
  ).toThrow(/live state/)
  expect(() =>
    assertDisconnected({ ...p, env: { ...p.env, OTTO_STATE_DIR: LIVE_STATE_DIR } }),
  ).toThrow(/live state/)
})

test('state is copied, not linked — the twin cannot disarm the user’s reminders', () => {
  const live = join(tmp, 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'triggers.json'), '[{"id":"a1b2c3"}]')
  writeFileSync(join(live, '.env'), 'TELEGRAM_BOT_TOKEN=secret')
  writeFileSync(join(live, 'access.json'), '{"dmPolicy":"allowlist","allowFrom":["1234567890"]}')

  const p = plan()
  materialize(p)

  expect(readFileSync(join(p.stateDir, 'triggers.json'), 'utf8')).toContain('a1b2c3')
  // Mutating the twin's copy leaves the live file untouched.
  writeFileSync(join(p.stateDir, 'triggers.json'), '[]')
  expect(readFileSync(join(live, 'triggers.json'), 'utf8')).toContain('a1b2c3')
})

test('secrets and the real allowlist are never copied in', () => {
  const p = plan()
  materialize(p)
  expect(existsSync(join(p.stateDir, '.env'))).toBe(false)
  expect(JSON.parse(readFileSync(join(p.stateDir, 'access.json'), 'utf8')).dmPolicy).toBe('disabled')
  expect(COPIED_STATE).not.toContain('.env')
  expect(COPIED_STATE).not.toContain('access.json')
})

test('a missing live state directory is not fatal', () => {
  const p = plan({ liveStateDir: join(tmp, 'does-not-exist') })
  expect(() => materialize(p)).not.toThrow()
  expect(readdirSync(p.stateDir)).toEqual(['access.json'])
})

// The prompt asking nicely is the weakest of the four locks; the allowlist is
// the one that holds, so assert the allowlist and not just the prose.
test('the send tools are outside the allowlist, not merely discouraged', () => {
  expect(SELFTEST_PROMPT).toContain('Do NOT call reply')
  expect(SELFTEST_PROMPT).toContain('create_trigger')

  const argv = plan().argv
  const allowed = argv[argv.indexOf('--allowedTools') + 1].split(',')
  for (const forbidden of ['reply', 'react', 'create_trigger', 'remember', 'forget']) {
    expect(allowed.some(t => t.endsWith(forbidden))).toBe(false)
  }
  expect(allowed).toContain('mcp__plugin_otto_otto__list_triggers')
})

test('a clean sentinel is a pass', () => {
  const r = summarize('some chatter\nSELFTEST tools=18 triggers=7 notes=42 errors=0\n')
  expect(r.ok).toBe(true)
  expect(r).toMatchObject({ tools: 18, triggers: 7, notes: 42, errors: 0 })
  expect(r.line).toContain('18 tools')
})

test('a sentinel with errors is a fail', () => {
  expect(summarize('SELFTEST tools=18 triggers=0 notes=0 errors=2').ok).toBe(false)
})

test('no tools loaded is a fail even with zero errors', () => {
  expect(summarize('SELFTEST tools=0 triggers=0 notes=0 errors=0').ok).toBe(false)
})

// A session that wandered off is not an unknown result — it is a failure, and
// it must stop an install.
test('a run that never printed the sentinel is a failure, not an unknown', () => {
  const r = summarize('I had a look around and everything seems fine!')
  expect(r.ok).toBe(false)
  expect(r.line).toContain('never reported')
  expect(r.line).toContain('everything seems fine')
})

test('no output at all is also a failure', () => {
  expect(summarize('')).toMatchObject({ ok: false, line: 'twin never reported: no output' })
})
