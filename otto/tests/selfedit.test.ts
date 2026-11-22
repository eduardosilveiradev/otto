import { describe, test, expect } from 'bun:test'
import {
  classify,
  requiredTier,
  tierForPath,
  normalizePath,
  matchesTypedPhrase,
  TYPED_PHRASE,
  writeScope,
  type Proof,
} from '../selfedit.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')

const typed: Proof = { kind: 'typed', text: TYPED_PHRASE }
const tapped: Proof = { kind: 'tapped', buttonData: 'install draft abc' }

test('the send path and the rails are guarded', () => {
  for (const p of [
    'otto/server.ts',
    'otto/tools.ts',
    'otto/queue.ts',
    'otto/selfedit.ts',
    'otto/tests/selfedit.test.ts',
    'SELFEDIT.md',
    '~/.otto/state/access.json',
    '~/.otto/state/.env',
    'run.sh',
    'templates/otto.service.template',
    'scripts/install.sh',
    'scripts/otto-ctl.sh',
    'otto/package.json',
  ]) {
    expect(tierForPath(p).tier).toBe('guarded')
  }
})

test('recipes, prose and ordinary modules need one tap', () => {
  for (const p of ['otto/skills/recipes/SKILL.md', 'CLAUDE.md', 'README.md', 'otto/memory.ts', 'scripts/triage.js']) {
    expect(tierForPath(p).tier).toBe('confirmed')
  }
})

test('the rails, hooks and anything outside the repo need the typed phrase', () => {
  for (const p of ['otto/origin.ts', 'otto/forge.ts', 'otto/apptokens.ts', 'otto/dash.ts', 'otto/hooks/hooks.json', 'hooks/hooks.json',
    'otto/node_modules/x/index.js', '~/.claude/agents/a.md', '~/.claude/CLAUDE.md', '/home/x/.claude/plugins/cache/otto/hooks/hooks.json',
    '~/.claude/skills/s/SKILL.md']) {
    expect(tierForPath(p).tier).toBe('guarded')
  }
  expect(tierForPath('~/.claude/memory/global/x.md').tier).toBe('confirmed')
})

test('trigger and recipe parameters change unattended', () => {
  expect(tierForPath('trigger:a1b2c3/action').tier).toBe('unattended')
  expect(tierForPath('trigger:a1b2c3/schedule').tier).toBe('unattended')
  expect(tierForPath('recipe-param:price-watch/last-price').tier).toBe('unattended')
})

// The rename hazard: this table will fall behind the tree at some point, and
// the only safe way to be behind is to over-guard.
test('an unrecognised path outside every known root is guarded, not confirmed', () => {
  expect(tierForPath('/etc/hosts').tier).toBe('guarded')
  expect(tierForPath('~/.zshrc').tier).toBe('guarded')
  expect(tierForPath('~/.claude/settings.json').tier).toBe('guarded')
  // A new Otto module is an Otto module: a tap is proportionate.
  expect(tierForPath('otto/brand-new-thing.ts').tier).toBe('confirmed')
})

test('a file no rule names is guarded, even under a root Otto uses', () => {
  for (const p of ['runtime/.mcp.json', 'logs/x', 'docs/new.md', 'telegram.env', `${REPO}/run.ps1`]) {
    expect(tierForPath(p).tier).toBe('guarded')
  }
})

test('case does not dodge a rule: the disk is case-insensitive', () => {
  for (const p of ['otto/Server.ts', 'otto/.MCP.json', 'scripts/Install.sh', 'selfedit.MD', 'OTTO/HTTP.TS', `${REPO}/OTTO/server.ts`]) {
    expect(tierForPath(p).tier).toBe('guarded')
  }
  expect(tierForPath('readme.md').tier).toBe('confirmed')
})

test('what run.sh executes is as guarded as run.sh', () => {
  for (const p of ['otto/session-loop.sh', 'otto/tmux.conf', 'otto/restart.ts']) {
    expect(tierForPath(p).tier).toBe('guarded')
  }
})

test('the modules split out of server.ts are as guarded as server.ts', () => {
  for (const f of ['server.ts', 'toolcalls.ts', 'http.ts', 'taps.ts', 'chores.ts', 'dispatch.ts']) {
    expect(tierForPath(`otto/${f}`).tier).toBe('guarded')
  }
})

test('traversal cannot dodge a rule', () => {
  expect(normalizePath('./otto/../otto/server.ts')).toBe('otto/server.ts')
  expect(tierForPath('otto/skills/../../otto/server.ts').tier).toBe('guarded')
  expect(tierForPath('../../../etc/passwd').tier).toBe('guarded')
  // A climb out lands in someone else's scripts/, not ours.
  expect(tierForPath('../other/scripts/x.sh').tier).toBe('guarded')
  expect(tierForPath('../other/otto/skills/a/SKILL.md').tier).toBe('guarded')
})

test('the tier is the maximum over every path touched', () => {
  const r = requiredTier(['otto/skills/recipes/SKILL.md', 'otto/server.ts'])
  expect(r.tier).toBe('guarded')
  expect(r.because.join(' ')).toContain('server.ts')
  // ...and the evidence lists only the paths that set it.
  expect(r.because.join(' ')).not.toContain('SKILL.md')
})

// The single most important test in the file.
test('a fired trigger can never reach the send path, however it asks', () => {
  const d = classify(['otto/server.ts'], 'triggered', typed)
  expect(d.allowed).toBe(false)
  expect(d.ceiling).toBe('unattended')
  expect(d.reason).toContain('tops out at unattended')
})

test('a fired trigger may still update its own parameters', () => {
  expect(classify(['trigger:a1b2c3/action'], 'triggered').allowed).toBe(true)
})

test('email content can never install anything, at any tier', () => {
  for (const p of ['trigger:a1b2c3/action', 'otto/skills/recipes/SKILL.md', 'otto/server.ts']) {
    const d = classify([p], 'external-content', typed)
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('propose but never install')
  }
})

test('a tap clears confirmed and never clears guarded', () => {
  expect(classify(['CLAUDE.md'], 'user-typed', tapped).allowed).toBe(true)
  const guarded = classify(['otto/server.ts'], 'user-typed', tapped)
  expect(guarded.allowed).toBe(false)
  expect(guarded.reason).toContain(TYPED_PHRASE)
})

test('the typed phrase clears guarded, and only when it is the phrase', () => {
  expect(classify(['otto/server.ts'], 'user-typed', typed).allowed).toBe(true)
  const wrong = classify(['otto/server.ts'], 'user-typed', { kind: 'typed', text: 'yes go ahead' })
  expect(wrong.allowed).toBe(false)
  expect(wrong.reason).toContain('not the phrase')
})

test('the phrase tolerates punctuation and case but not paraphrase', () => {
  expect(matchesTypedPhrase('I approve the Otto core change.')).toBe(true)
  expect(matchesTypedPhrase('  i   approve the otto core change  ')).toBe(true)
  expect(matchesTypedPhrase('i approve the otto change')).toBe(false)
  expect(matchesTypedPhrase('approve the otto core change')).toBe(false)
})

test('Otto acting on its own idea can reach confirmed but never guarded', () => {
  expect(classify(['otto/skills/recipes/SKILL.md'], 'model-authored', tapped).allowed).toBe(false)
  expect(classify(['otto/server.ts'], 'model-authored', typed).allowed).toBe(false)
  // model-authored is capped at confirmed, and confirmed still wants the user’s tap —
  // which by definition arrives as user-typed.
  expect(classify(['otto/skills/recipes/SKILL.md'], 'model-authored').ceiling).toBe('confirmed')
})

test('an empty change list is trivially unattended', () => {
  expect(classify([], 'triggered').allowed).toBe(true)
  expect(classify([], 'triggered').tier).toBe('unattended')
})

test('an app approval clears the files it listed and no others', () => {
  const approved: Proof = { kind: 'typed', text: TYPED_PHRASE, paths: ['otto/server.ts'] }
  expect(classify(['otto/server.ts'], 'user-typed', approved).allowed).toBe(true)
  // The hook passes absolute paths, in whatever case the model typed.
  expect(classify([join(REPO, 'otto/Server.ts')], 'user-typed', approved).allowed).toBe(true)
  expect(classify(['otto/server.ts'], 'user-typed', { ...approved, paths: [join(REPO, 'otto/server.ts')] }).allowed).toBe(true)
  for (const paths of [['otto/http.ts'], ['otto/server.ts', 'otto/http.ts'], ['otto/skills/recipes/SKILL.md']]) {
    const d = classify(paths, 'user-typed', approved)
    expect(d.allowed).toBe(false)
    expect(d.reason).not.toContain('cleared')
  }
  // The phrase typed on Telegram names no files, so it is not scoped.
  expect(classify(['otto/http.ts'], 'user-typed', typed).allowed).toBe(true)
})

test('the write hook gates the repo, the named state files and named ~/.claude files, nothing else', () => {
  for (const home of ['/h', '/test-home/otto']) {
    const state = `${home}/.otto/state`
    for (const p of [join(REPO, 'otto/server.ts'), join(REPO, 'runtime/x.txt'), join(REPO.toUpperCase(), 'otto/x.ts'),
      `${state}/access.json`, `${state}/.env`, `${state}/bot.pid`, `${state}/origin.json`, `${state}/status-url`,
      `${state}/app-tokens.json`, `${state}/app-token`, `${state}/forge/d1.json`, `${state}/forge/sub/x.json`, `${state}/capability-log.json`,
      `${state}/t3-token`, `${state}/t3-usage-token`, `${state}/app-release/key`,
      `${home}/.claude/settings.json`, `${home}/.claude/skills/s/SKILL.md`, `${home}/.claude/CLAUDE.md`, `${home}/.claude/hooks/x.sh`]) {
      expect(writeScope(p, state, home)).toBe('gated')
    }
    for (const p of [`${home}/.claude/projects/slug/memory/MEMORY.md`, `${home}/.claude/memory/global/x.md`, `${home}/.claude/plans/p.md`,
      `${home}/Documents/app/src/hooks/useX.ts`, `${home}/Documents/app/.env`, `${home}/worktrees/otto-x/otto/server.ts`,
      `${home}/.otto/study/a.study.json`, `${REPO}-other/otto/server.ts`]) {
      expect(writeScope(p, state, home)).toBeNull()
    }
  }
})

test('every other state file is routine: its own scope, not ungated', () => {
  const state = '/test-home/otto/.otto/state'
  for (const f of ['triggers.json', 'boards.json', 'pips.json', 'notes.json', 'backup-state.json', 'capability-log.json.bak', 'forge.json', 'app-release/release.json', 'jobs/j1.json', 'digests/d.md', 'app-tokens.json.lock']) {
    expect(writeScope(`${state}/${f}`, state, '/test-home/otto')).toBe('routine')
  }
})

test('forge drafts, the capability log, the T3 tokens and the release key need the typed phrase, never a tap', () => {
  const state = '/test-home/otto/.otto/state'
  for (const f of ['forge/d1.json', 'capability-log.json', 't3-token', 't3-usage-token', 'app-release/key']) {
    const p = `${state}/${f}`
    expect(classify([p], 'user-typed', { kind: 'tapped', buttonData: 'install forge d1' }).allowed).toBe(false)
    expect(classify([p], 'triggered', { kind: 'typed', text: TYPED_PHRASE }).allowed).toBe(false)
    expect(classify([p], 'user-typed', { kind: 'typed', text: TYPED_PHRASE }).allowed).toBe(true)
  }
})

describe('the write hook', () => {
  const hook = join(REPO, 'otto/hooks/selfedit-gate.ts')
  // Async: the stub channel below runs in this process and must answer while the hook waits.
  const run = async (state: string, file: string, env: Record<string, string> = { OTTO_CHANNEL_HOST: '1' }) => {
    const r = Bun.spawn(['bun', hook], {
      stdin: Buffer.from(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file } })),
      stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', OTTO_STATE_DIR: state, ...env },
    })
    return { code: await r.exited, err: await new Response(r.stderr).text() }
  }
  const serve = (status: number, body: string | null) => {
    const state = mkdtempSync(join(tmpdir(), 'gate-'))
    const server = Bun.serve({ port: 0, fetch: () => new Response(body, { status }) })
    writeFileSync(join(state, 'status-url'), `http://127.0.0.1:${server.port}/status`)
    return { state, server }
  }

  test('exits 2 with the reason when the channel refuses', async () => {
    const { state, server } = serve(403, 'self-edit blocked — needs the typed phrase')
    try {
      const r = await run(state, join(REPO, 'otto/server.ts'))
      expect(r.code).toBe(2)
      expect(r.err).toContain('needs the typed phrase')
    } finally { server.stop(true) }
  })

  test('exits 0 when the channel allows it', async () => {
    const { state, server } = serve(204, null)
    try { expect((await run(state, join(REPO, 'otto/server.ts'))).code).toBe(0) } finally { server.stop(true) }
  })

  test('with the channel down, a guarded path fails closed and an outside path passes', async () => {
    const state = mkdtempSync(join(tmpdir(), 'gate-'))
    expect((await run(state, join(REPO, 'otto/server.ts'))).code).toBe(2)
    expect((await run(state, join(tmpdir(), 'scratch.txt'))).code).toBe(0)
    expect((await run(state, join(state, 'triggers.json'))).code).toBe(0)
    expect((await run(state, join(state, 'app-tokens.json'))).code).toBe(2)
    for (const f of ['forge/d1.json', 'capability-log.json', 't3-token', 't3-usage-token', 'app-release/key']) {
      expect((await run(state, join(state, f))).code).toBe(2)
    }
  })

  test('other sessions are never gated', async () => {
    const state = mkdtempSync(join(tmpdir(), 'gate-'))
    expect((await run(state, join(REPO, 'otto/server.ts'), {})).code).toBe(0)
  })
})
