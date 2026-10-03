#!/usr/bin/env bun
/**
 * A second Otto, wired to nothing.
 *
 * Wave 3 writes code that server.ts loads. There is no way to know whether that
 * code loads without loading it, and loading it in the live session is the same
 * experiment as the deploy: if it is wrong, the thing that finds out is the
 * channel the user talks through.
 *
 * So: a twin. A git worktree of the candidate code, a scratch copy of the state
 * directory, and a headless session pointed at both. Tools answer, triggers
 * parse, the MCP server starts — and nothing it does can reach Telegram.
 *
 * That last part is the whole file, and it is enforced three times over, because
 * one lock is not enough for a mistake whose failure mode is "a test run sent
 * the user eleven messages at 3am":
 *
 *   1. OTTO_CHANNEL_HOST is scrubbed. consolidate.ts already learned this one
 *      the hard way — run.sh exports it for the whole session, so a naively
 *      inherited environment tells the child it is the channel host and it
 *      reaps the parent's poller and seizes the token.
 *   2. TELEGRAM_BOT_TOKEN is scrubbed too. Belt and braces: if the child ever
 *      decided it was a host anyway, it would have nothing to poll with.
 *   3. The scratch access.json has dmPolicy "disabled" and an empty allowlist,
 *      so assertAllowedChat throws on every chat id there is — including the
 *      real one, which is the one that matters.
 *
 * State is copied, never linked. A twin that shares triggers.json with the live
 * session is a twin that can disarm the user’s reminders.
 *
 * CLI: `bun otto/selftest.ts [--branch <name>] [--keep]`
 */

import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { claudeBin, headlessMcpArgs } from './headless.ts'

/** Copied into the twin. Everything else is either secret or reconstructible. */
export const COPIED_STATE = ['triggers.json', 'notes.json', 'email-state.json', 'runtime.json', 'history.jsonl']

/** Never copied. `.env` holds the bot token; access.json is written fresh. */
export const NEVER_COPIED = ['.env', 'access.json', 'bot.pid', 'voice-daemon.json']

/**
 * Anything that could reconnect the twin to the real world. Scrubbed rather
 * than overridden: an empty string is still a value, and code that checks for
 * presence rather than truthiness would be fooled by one.
 */
export const SCRUBBED = [
  'OTTO_CHANNEL_HOST',
  'TELEGRAM_BOT_TOKEN',
  'OTTO_ACCESS_MODE',
  'ANTHROPIC_API_KEY',
]

export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (SCRUBBED.includes(k)) continue
    out[k] = v
  }
  return out
}

/**
 * access.json for the twin. Disabled policy, empty allowlist, no pending
 * pairings — so every path into the send tool throws before it reaches
 * Telegram, whatever the candidate code decided to do.
 */
export function scratchAccess(): string {
  return JSON.stringify({ dmPolicy: 'disabled', allowFrom: [], pending: {}, emailScanMinutes: 0 }, null, 2) + '\n'
}

export type SelfTestPlan = {
  worktree: string
  stateDir: string
  env: Record<string, string>
  argv: string[]
  /** Files to copy in, resolved. */
  copy: { from: string; to: string }[]
  /** Written fresh rather than copied. */
  write: { path: string; content: string }[]
}

/**
 * The prompt the twin runs. Deliberately does not ask it to *do* anything —
 * loading the plugin, listing the tools and reading state back is the entire
 * test, and a twin asked to "try things out" is a twin looking for a side
 * effect to have.
 */
export const SELFTEST_PROMPT = `You are a disposable staging copy of Otto. Nobody is reading your output except a test harness, and you cannot reach Telegram — the channel is deliberately disconnected.

Do exactly this and nothing else:

1. List the tools the otto plugin exposes.
2. Call list_triggers and report how many parsed.
3. Call recall with the query "test" and report how many notes came back.
4. Do NOT call reply, react, edit_message, create_trigger, update_trigger, delete_trigger, set_email_state, remember, or forget. This copy shares no state with the real one and any write here is wasted, but a call to reply would be a bug worth finding.

Then print exactly one line:

SELFTEST tools=<n> triggers=<n> notes=<n> errors=<n>

If anything failed to load, print that line anyway with errors set, followed by the error text.`

/** The one directory the twin must never be pointed at. */
export const LIVE_STATE_DIR = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')

/** Where state lived before the move to ~/.otto. Still rejected: a stale
 * OTTO_STATE_DIR in someone's environment must not silently pass the guard. */
const LEGACY_STATE_DIR = join('.claude', 'channels', 'otto')

export function selfTestPlan(opts: {
  worktree: string
  liveStateDir?: string
  scratchRoot?: string
  env?: Record<string, string | undefined>
  claude?: string
}): SelfTestPlan {
  const live = opts.liveStateDir ?? LIVE_STATE_DIR
  const stateDir = join(opts.scratchRoot ?? mkdtempSync(join(tmpdir(), 'otto-twin-')), 'otto')
  const env = scrubEnv(opts.env ?? process.env)
  env.OTTO_STATE_DIR = stateDir
  // The twin must not consolidate memory or probe the user’s real projects directory.
  env.OTTO_PROJECTS_DIR = join(stateDir, 'projects')

  return {
    worktree: opts.worktree,
    stateDir,
    env,
    argv: [
      opts.claude ?? claudeBin(),
      '-p',
      SELFTEST_PROMPT,
      '--permission-mode',
      'auto',
      // No --channels flag: without it the client never advertises the channel
      // capability, so server.ts stays tools-only and never polls.
      '--allowedTools',
      'mcp__plugin_otto_otto__list_triggers,mcp__plugin_otto_otto__recall,Read,Grep,Glob',
      // The twin must run the candidate server, not whichever plugin the user has
      // enabled globally — and it must not start any channel plugin at all.
      ...headlessMcpArgs({ otto: true }, join(opts.worktree, 'otto')),
    ],
    copy: COPIED_STATE.map(f => ({ from: join(live, f), to: join(stateDir, f) })),
    write: [{ path: join(stateDir, 'access.json'), content: scratchAccess() }],
  }
}

/** Belt-and-braces assertion for the caller, so a bad plan fails loudly. */
export function assertDisconnected(plan: SelfTestPlan): void {
  for (const k of SCRUBBED) {
    if (k in plan.env) throw new Error(`selftest: ${k} survived into the twin's environment`)
  }
  if (plan.argv.includes('--channels')) throw new Error('selftest: the twin must not be started as a channel host')
  if (
    !plan.env.OTTO_STATE_DIR ||
    plan.env.OTTO_STATE_DIR.startsWith(LIVE_STATE_DIR) ||
    plan.env.OTTO_STATE_DIR.includes(LEGACY_STATE_DIR)
  ) {
    throw new Error('selftest: the twin is pointed at live state')
  }
}

// ---------------------------------------------------------------------------
// Reading the result
// ---------------------------------------------------------------------------

export type SelfTestResult = {
  ok: boolean
  tools?: number
  triggers?: number
  notes?: number
  errors: number
  /** One line, for a forge verdict or a canary gate. */
  line: string
}

const SENTINEL = /SELFTEST tools=(\d+) triggers=(\d+) notes=(\d+) errors=(\d+)/

/**
 * A run that produced no sentinel is a failure, not an unknown. The twin's only
 * job is to print one line; a session that finished without printing it either
 * crashed or wandered off, and both should stop an install.
 */
export function summarize(output: string): SelfTestResult {
  const m = SENTINEL.exec(output)
  if (!m) {
    const tail = output.trim().split('\n').slice(-3).join(' ').slice(0, 200)
    return { ok: false, errors: 1, line: `twin never reported: ${tail || 'no output'}` }
  }
  const [, tools, triggers, notes, errors] = m.map(Number)
  const ok = errors === 0 && tools > 0
  return {
    ok,
    tools,
    triggers,
    notes,
    errors,
    line: ok
      ? `twin loaded: ${tools} tools, ${triggers} triggers, ${notes} notes`
      : `twin loaded with ${errors} error(s) and ${tools} tools`,
  }
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

export function materialize(plan: SelfTestPlan): void {
  mkdirSync(plan.stateDir, { recursive: true })
  for (const { from, to } of plan.copy) {
    if (!existsSync(from)) continue
    if (NEVER_COPIED.some(n => from.endsWith(n))) continue
    copyFileSync(from, to)
  }
  for (const { path, content } of plan.write) writeFileSync(path, content, { mode: 0o600 })
}

export async function runSelfTest(plan: SelfTestPlan, timeoutMs = 5 * 60_000): Promise<SelfTestResult> {
  assertDisconnected(plan)
  materialize(plan)
  if (!existsSync(plan.argv[0])) return { ok: false, errors: 1, line: 'claude CLI not found' }
  try {
    const proc = Bun.spawn(plan.argv, { env: plan.env, cwd: plan.worktree, stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => { try { proc.kill() } catch {} }, timeoutMs)
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    clearTimeout(timer)
    return summarize(out)
  } catch (err) {
    return { ok: false, errors: 1, line: `twin failed to start: ${String(err).slice(0, 120)}` }
  }
}

export function cleanup(plan: SelfTestPlan): void {
  try { rmSync(plan.stateDir, { recursive: true, force: true }) } catch {}
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const plan = selfTestPlan({ worktree: process.cwd() })
  const res = await runSelfTest(plan)
  console.log(res.line)
  if (!argv.includes('--keep')) cleanup(plan)
  process.exit(res.ok ? 0 : 1)
}
