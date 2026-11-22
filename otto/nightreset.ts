/**
 * A fresh conversation every morning, right after the 04:00 memory run.
 *
 * Otto's session runs for days and only shrinks when Claude Code compacts it,
 * so it carries stale context. Once the nightly consolidation has distilled the
 * transcripts into memory, this clears the live conversation with `/clear` in
 * its tmux pane (run.sh); the MCP servers, this channel included, keep running.
 *
 * In order, stopping at the first thing that says no (a skip is logged and kept
 * for otto_status, never messaged):
 *   1. the session must be quiet: no message from the user in the last 30
 *      minutes, no app message unread or unanswered, no turn open, no reply
 *      still pacing out;
 *   2. the tmux pane must show Claude Code's empty prompt and no spinner;
 *   3. one event asks the session to save what is still open as loops with ids,
 *      then we wait (up to 10 minutes) for that turn to end, and check 1 and 2
 *      again, because a held message or a user can wake it meanwhile;
 *   4. `/clear`, then one short event pointing the fresh context at `brief` and
 *      `recall` (nothing injects it on a SessionStart with source "clear").
 */

export const QUIET_MS = 30 * 60_000
export const IDLE_CAP_MS = 10 * 60_000
export const POLL_MS = 5_000

export type Busy = {
  /** Epoch ms of the newest message from the user on any surface, 0 for none. */
  lastUserAt: number
  /** App messages the session has not read yet, or read and not answered. */
  appOwed: number
  turnOpen: boolean
  /** App replies still going out bubble by bubble. */
  pacing: number
}

export function skipReason(b: Busy, now: number): string | null {
  if (now - b.lastUserAt < QUIET_MS) return `the user wrote ${Math.max(1, Math.round((now - b.lastUserAt) / 60_000))} min ago`
  if (b.appOwed) return `${b.appOwed} app message(s) unread or unanswered`
  if (b.turnOpen) return 'a turn is in progress'
  if (b.pacing) return 'a reply is still pacing out'
  return null
}

/** A spinner line: a glyph, then an ellipsis somewhere ("✽ Wibbling… (44s · ↓2.4k tokens)"). */
const SPINNER = /^[·✢✳✶✻✽]\s.*…/
const RULE = /^─{10,}$/

/**
 * Claude Code at rest: its composer is an empty `❯` between two horizontal
 * rules, and nothing is spinning. The composer stays drawn during a turn, so the
 * spinner is what tells the two apart; any doubt reads as busy.
 */
export function atPrompt(pane: string): boolean {
  const lines = pane.split('\n').map(l => l.trim())
  if (lines.some(l => SPINNER.test(l) || /esc to interrupt|tokens\)|thinking with \w+ effort/i.test(l))) return false
  return lines.some((l, i) => l === '❯' && RULE.test(lines[i - 1] ?? '') && RULE.test(lines[i + 1] ?? ''))
}

export const SAVE_TEXT = [
  'Nightly reset: this conversation is cleared once this turn ends; memory is already distilled.',
  'Save anything still open that only this conversation knows, each as a loop (remember kind "loop") with its ids:',
  'drafts shown but not sent (draft id, recipient), questions waiting on the user, things you are waiting on.',
  'Skip what is already a loop. Send nothing to the user.',
].join(' ')

export const FRESH_TEXT = 'Fresh conversation after the nightly reset. Open loops and memory carry what came before: '
  + 'call `brief` when a message needs today\'s context and `recall` before answering about anything earlier. Send nothing to the user.'

export type ResetDeps = {
  busy(): Busy
  now(): number
  /** tmux on the session's own socket; ok false when tmux or the session isn't there. */
  tmux(args: string[]): Promise<{ ok: boolean; out: string }>
  inject(kind: 'save' | 'fresh', text: string): Promise<boolean>
  sleep(ms: number): Promise<void>
}

export type ResetOutcome = { at: string; reset: boolean; reason: string }

export async function nightlyReset(d: ResetDeps, target = 'otto'): Promise<ResetOutcome> {
  const done = (reset: boolean, reason: string): ResetOutcome => ({ at: new Date(d.now()).toISOString(), reset, reason })
  const pane = async (): Promise<string | null> => {
    const r = await d.tmux(['capture-pane', '-p', '-t', target])
    return r.ok ? r.out : null
  }
  const check = async (): Promise<string | null> => {
    const why = skipReason(d.busy(), d.now())
    if (why) return why
    const p = await pane()
    if (p == null) return 'no tmux session (run without tmux)'
    return atPrompt(p) ? null : "the pane isn't at Claude Code's empty prompt"
  }

  let why = await check()
  if (why) return done(false, why)
  if (!await d.inject('save', SAVE_TEXT)) return done(false, 'the save event did not reach the session')
  const deadline = d.now() + IDLE_CAP_MS
  do await d.sleep(POLL_MS)
  while ((d.busy().turnOpen || d.busy().pacing) && d.now() < deadline)
  if (d.busy().turnOpen) return done(false, 'the save turn was still running after 10 min')
  why = await check()
  if (why) return done(false, `after saving: ${why}`)

  // Typed and submitted apart: in one burst the composer can take Enter as a newline.
  if (!(await d.tmux(['send-keys', '-t', target, '-l', '/clear'])).ok) return done(false, 'tmux send-keys failed')
  await d.sleep(500)
  // Only Enter what is provably ours: anything else in the composer is left alone.
  if (!(await pane())?.includes('❯ /clear')) return done(false, "/clear didn't reach the composer")
  await d.tmux(['send-keys', '-t', target, 'Enter'])
  for (let i = 0; ; i++) {
    await d.sleep(2_000)
    const p = await pane()
    if (p != null && atPrompt(p)) break
    if (p == null || i === 1) return done(false, '/clear sent but the prompt did not come back')
    if (p.includes('❯ /clear')) await d.tmux(['send-keys', '-t', target, 'Enter'])
  }
  await d.inject('fresh', FRESH_TEXT)
  return done(true, 'cleared')
}
