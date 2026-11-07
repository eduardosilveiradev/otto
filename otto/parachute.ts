/**
 * The limit-hit parachute.
 *
 * Running out of a plan window mid-task costs more than the wait: the thread of
 * what you were doing is gone by the time it resets. The plugin's
 * UserPromptSubmit hook already posts every session's prompts to /status, where
 * all but Otto's own are dropped unread. One added header (`X-Otto-Hook:
 * prompt`) lets the channel keep a tiny record of the last dev session the user
 * typed in: session id, cwd, transcript path, claude pid and the first words of
 * the prompt. Nothing else from other sessions is read, and the header is the
 * only reason the body is.
 *
 * When the status line's /plan-usage post shows a live window at or over
 * `parachute.percent`, that session is snapshotted (repo, branch, dirty count,
 * the last red test in its transcript tail, the goal) into a note, refreshed at
 * most every five minutes while still over the line. At the window's reset the
 * note goes out once, with [resume]. Before the reset: nothing. If the user is
 * already typing in that session again, or Otto was down for over 12 h past the
 * reset, the note is dropped silently.
 *
 * [resume] takes a session id that must be a uuid; the repo path comes from the
 * session's own transcript and is passed as argv, never interpolated into a
 * shell or AppleScript string.
 *
 * git, ps, osascript and the clipboard are parameters, so tests touch none.
 */

import { existsSync, readdirSync, openSync, readSync, closeSync, statSync } from 'fs'
import { join, basename, isAbsolute, sep } from 'path'
import { run, repoState } from './workspace.ts'
import { parseFailingTest } from './resume.ts'
import { liveWindows, type PlanUsage } from './spend.ts'
import { redactSecrets } from './redact.ts'
import { loadState, saveState } from './statefile.ts'

export type LiveSession = { sessionId: string; cwd: string; transcript: string; pid?: number; goal?: string; at: number }
export type ParkedNote = { sessionId: string; cwd: string; repo: string; branch?: string; dirty: number; goal?: string; failing?: string; pid?: number; resetAt: number; parkedAt: number }
export type ParachuteState = { live?: LiveSession; note?: ParkedNote; sent?: ParkedNote }

const validState = (x: unknown): boolean => !!x && typeof x === 'object' && !Array.isArray(x)
export const loadParachute = (file: string): ParachuteState => loadState(file, () => ({}), validState)
export const peekParachute = (file: string): ParachuteState => loadState(file, () => ({}), validState, { peek: true })
export const saveParachute = (file: string, s: ParachuteState): void => saveState(file, s)

export const DEFAULT_PERCENT = 95
export const LIVE_FRESH_MS = 2 * 3_600_000
export const REPARK_MS = 5 * 60_000
export const SAME_WINDOW_MS = 10 * 60_000
export const SEND_GRACE_MS = 12 * 3_600_000
const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const UUID = new RegExp(`^${UUID_SRC}$`)
export const RESUME_RE = new RegExp(`^resume session (${UUID_SRC})$`)

/** percent over 100 never triggers: that is the off switch. */
export function parachuteConfig(raw?: { percent?: unknown; app?: unknown } | null): { percent: number; app: string } {
  const p = Number(raw?.percent)
  const app = typeof raw?.app === 'string' ? raw.app.trim() : ''
  return { percent: Number.isFinite(p) && p > 0 ? p : DEFAULT_PERCENT, app: app && !app.includes('/') ? app : 'Terminal' }
}

/** The first words of what was typed; nothing for injected text or a one-word "yes". */
export function goalFrom(prompt: string): string | undefined {
  const t = prompt.trim()
  if (!t || t.startsWith('<')) return undefined
  const words = t.split(/\s+/)
  if (words.length < 4) return undefined
  return redactSecrets(words.slice(0, 14).join(' ') + (words.length > 14 ? '…' : '')).text
}

const inside = (dir: string, p: string): boolean => p === dir || p.startsWith(dir + sep)

/** A prompt typed in some session. False (nothing stored) for anything that is not a real dev session. */
export function noteLive(state: ParachuteState, h: unknown, pid: number | undefined, now: number, o: { stateDir: string; projectsDir: string }): boolean {
  const b = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>
  const sessionId = String(b.session_id ?? '')
  const cwd = String(b.cwd ?? '')
  const transcript = String(b.transcript_path ?? '')
  if (!UUID.test(sessionId) || !isAbsolute(cwd) || inside(o.stateDir, cwd) || !transcript.startsWith(o.projectsDir + sep)) return false
  const goal = goalFrom(String(b.prompt ?? '')) ?? (state.live?.sessionId === sessionId ? state.live.goal : undefined)
  state.live = { sessionId, cwd, transcript, ...(pid ? { pid } : {}), ...(goal ? { goal } : {}), at: now }
  return true
}

/** The reset of the window that blocks: the latest one among those at or over the line. */
export function parkWindow(u: PlanUsage | null, percent: number, now: number): number | undefined {
  const resets = liveWindows(u, now).filter(k => u![k]!.used_percentage >= percent).map(k => u![k]!.resets_at * 1000)
  return resets.length ? Math.max(...resets) : undefined
}

export function readTail(file: string, bytes = 512 * 1024): string {
  try {
    const size = statSync(file).size
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    const fd = openSync(file, 'r')
    try { readSync(fd, buf, 0, len, size - len) } finally { closeSync(fd) }
    return buf.toString('utf8')
  } catch { return '' }
}

/** The last red test of the last bun run in a transcript tail. */
export function lastFailingTest(tail: string): string | undefined {
  // ponytail: reads the escaped transcript as text; a JSON walk if bun's output ever stops starting its own lines.
  const text = tail.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"')
  const sums = [...text.matchAll(/^\s*(\d+) fail$/gm)]
  const last = sums[sums.length - 1]
  if (!last || Number(last[1]) === 0) return undefined
  return parseFailingTest(text.slice(0, last.index))
}

export async function gitTop(cwd: string): Promise<string | undefined> {
  return (await run(['git', '-C', cwd, 'rev-parse', '--show-toplevel']))?.trim() || undefined
}

export async function snapshot(live: LiveSession, resetAt: number, now: number, d: { gitTop: typeof gitTop; repoState: typeof repoState; readTail: typeof readTail } = { gitTop, repoState, readTail }): Promise<ParkedNote> {
  const top = await d.gitTop(live.cwd)
  const rs = top ? await d.repoState(top) : undefined
  const failing = lastFailingTest(d.readTail(live.transcript))
  return {
    sessionId: live.sessionId,
    cwd: live.cwd,
    repo: basename(top ?? live.cwd),
    ...(rs?.branch ? { branch: rs.branch } : {}),
    dirty: rs?.dirty ?? 0,
    ...(live.goal ? { goal: live.goal } : {}),
    ...(failing ? { failing } : {}),
    ...(live.pid ? { pid: live.pid } : {}),
    resetAt,
    parkedAt: now,
  }
}

export function shouldPark(state: ParachuteState, resetAt: number, now: number): boolean {
  if (state.sent && Math.abs(state.sent.resetAt - resetAt) < SAME_WINDOW_MS) return false
  if (!state.live || now - state.live.at > LIVE_FRESH_MS) return false
  // A later reset replaces an earlier note: it is the one that blocks.
  if (state.note && Math.abs(state.note.resetAt - resetAt) < SAME_WINDOW_MS && now - state.note.parkedAt < REPARK_MS) return false
  return true
}

export function dueNote(state: ParachuteState, now: number): 'wait' | 'send' | 'drop' {
  const n = state.note
  if (!n || now < n.resetAt) return 'wait'
  if (now - n.resetAt > SEND_GRACE_MS) return 'drop'
  if (state.live?.sessionId === n.sessionId && state.live.at > n.resetAt) return 'drop'
  return 'send'
}

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function formatNote(n: ParkedNote): { text: string; buttons: { label: string; data: string }[] } {
  const where = `${n.repo}${n.branch && n.branch !== 'main' && n.branch !== 'master' ? ` (${n.branch})` : ''}`
  const bits = [where, n.dirty ? `${n.dirty} file${n.dirty === 1 ? '' : 's'} dirty` : '', n.failing ? `${truncate(n.failing, 50)} red` : ''].filter(Boolean)
  return {
    text: `limit's reset. ${n.goal ? `you were on "${n.goal}" — ` : 'you were in '}${bits.join(', ')}.`,
    buttons: [{ label: 'resume', data: `resume session ${n.sessionId}` }],
  }
}

/** The cwd a session's own transcript records, if it still exists. */
export function transcriptCwd(projectsDir: string, sessionId: string): string | undefined {
  if (!UUID.test(sessionId)) return undefined
  let dirs: string[]
  try { dirs = readdirSync(projectsDir) } catch { return undefined }
  for (const d of dirs) {
    const file = join(projectsDir, d, `${sessionId}.jsonl`)
    if (!existsSync(file)) continue
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(readHead(file))
    if (!m) return undefined
    try {
      const cwd = JSON.parse(`"${m[1]}"`) as string
      return isAbsolute(cwd) && existsSync(cwd) ? cwd : undefined
    } catch { return undefined }
  }
  return undefined
}

function readHead(file: string, bytes = 64 * 1024): string {
  try {
    const buf = Buffer.alloc(bytes)
    const fd = openSync(file, 'r')
    try { return buf.toString('utf8', 0, readSync(fd, buf, 0, bytes, 0)) } finally { closeSync(fd) }
  } catch { return '' }
}

const claudeAlive = async (pid: number): Promise<boolean> => basename((await run(['ps', '-o', 'comm=', '-p', String(pid)])) ?? '') === 'claude'
const pbcopy = async (text: string): Promise<void> => { await Bun.spawn(['pbcopy'], { stdin: Buffer.from(text) }).exited }

export async function resumeWorkspace(sessionId: string, o: {
  projectsDir: string
  app: string
  sent?: ParkedNote
  isClaude?: (pid: number) => Promise<boolean>
  exec?: typeof run
  copy?: (text: string) => Promise<void>
  platform?: string
}): Promise<string> {
  const { isClaude = claudeAlive, exec = run, copy = pbcopy, platform = process.platform } = o
  if (!UUID.test(sessionId)) return 'not a session id'
  const cwd = transcriptCwd(o.projectsDir, sessionId)
  if (!cwd) return "can't find where that session was any more."
  // No desktop to open a terminal in (a Linux server): hand back the command instead.
  if (platform !== 'darwin') return `to pick it up: cd ${cwd} && claude --resume ${sessionId}`
  if (o.sent?.sessionId === sessionId && o.sent.pid && await isClaude(o.sent.pid)) {
    await exec(['open', '-a', o.app], undefined, 10_000)
    return `it's still open in ${o.app} — say continue there.`
  }
  if (o.app === 'Terminal') {
    const out = await exec(['osascript',
      '-e', 'on run argv', '-e', 'tell application "Terminal"', '-e', 'activate',
      '-e', 'do script "cd " & quoted form of (item 1 of argv) & " && claude --resume " & (item 2 of argv)',
      '-e', 'end tell', '-e', 'end run', cwd, sessionId], undefined, 10_000)
    return out === undefined ? "couldn't open Terminal." : `opened ${basename(cwd)} in Terminal, resuming the session.`
  }
  await exec(['open', '-a', o.app, cwd], undefined, 10_000)
  await copy(`claude --resume ${sessionId}`)
  return `opened ${basename(cwd)} in ${o.app}; claude --resume is on the clipboard.`
}
