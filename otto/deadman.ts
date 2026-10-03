/**
 * The dead-man checker. Run by launchd every few minutes, independent of the
 * channel server: `bun otto/deadman.ts`. Decisions live in heartbeat.ts.
 *
 * It imports nothing from server.ts on purpose — a checker that shares a crash
 * with the thing it checks is not a checker. What it may touch:
 *
 *   read    heartbeat.json, access.json (the first allowFrom id and quietHours),
 *           and one key, TELEGRAM_BOT_TOKEN, from the state .env
 *   write   deadman.json (its own memory) and one loop note in notes.json
 *
 * It never edits access.json, .env or any config.
 *
 * How an outage is raised: the channel that normally speaks is the thing that
 * is down, so the alert goes out directly over Telegram — once — and a loop
 * note is filed so the brief carries it as soon as the session is back. The
 * loop has no due date, so the escalation curve leaves it alone: one message is
 * the whole interruption budget for an outage.
 */

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  readHeartbeat, evaluate, describeOutage, loadDeadmanState, saveDeadmanState,
  type DeadmanState, type Heartbeat,
} from './heartbeat.ts'
import { loadNotes, saveNotes, upsertNote } from './store.ts'

export type DeadmanDeps = {
  stateDir: string
  now: number
  pidAlive: (pid: number) => boolean
  quiet: (spec: string | undefined, now: number) => boolean
  /** Deliver the alert. Throwing means it did not go out, and it will be retried. */
  notify: (text: string) => Promise<void>
}

export type DeadmanResult = { did: 'none' | 'raised' | 'recovered' | 'notify-failed'; why?: string }

export function quietAt(spec: string | undefined, now: number): boolean {
  if (!spec) return false
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(spec.trim())
  if (!m) return false
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  const start = Number(m[1]) * 60 + Number(m[2])
  const end = Number(m[3]) * 60 + Number(m[4])
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end
}

function readAccess(dir: string): { allowFrom?: string[]; quietHours?: string } {
  try { return JSON.parse(readFileSync(join(dir, 'access.json'), 'utf8')) } catch { return {} }
}

export async function runDeadman(deps: DeadmanDeps): Promise<DeadmanResult> {
  const { stateDir, now } = deps
  const hbFile = join(stateDir, 'heartbeat.json')
  const stateFile = join(stateDir, 'deadman.json')
  const notesFile = join(stateDir, 'notes.json')

  const hb: Heartbeat | null = readHeartbeat(hbFile)
  const state = loadDeadmanState(stateFile)
  const quietHours = readAccess(stateDir).quietHours
  const { action, state: next } = evaluate(hb, state, now, {
    pidAlive: deps.pidAlive,
    held: deps.quiet(quietHours, now),
  })

  let result: DeadmanResult = { did: 'none', why: action.kind === 'none' ? action.why : undefined }
  const persist = (s: DeadmanState) => saveDeadmanState(stateFile, s)

  if (action.kind === 'raise') {
    // File the loop first and idempotently: if the send fails and this runs
    // again, it finds the same note rather than piling up a second one.
    const tag = `deadman:${action.since}`
    const notes = loadNotes(notesFile)
    let note = notes.find(n => n.tags.includes(tag))
    if (!note) {
      note = upsertNote(notes, {
        kind: 'loop',
        text: `outage: I stopped responding at ${new Date(action.since).toISOString()}. ${describeOutage(action)}`,
        tags: ['outage', tag],
        source: 'deadman',
      }).note
      saveNotes(notesFile, notes)
    }
    next.outage = { since: action.since, noteId: note.id }
    try {
      await deps.notify(describeOutage(action))
      next.outage.raisedAt = now
      result = { did: 'raised' }
    } catch (err) {
      result = { did: 'notify-failed', why: String(err).slice(0, 120) }
    }
  } else if (action.kind === 'recover') {
    const notes = loadNotes(notesFile)
    const id = action.outage.noteId
    if (id && notes.some(n => n.id === id)) {
      upsertNote(notes, { id, status: 'done' })
      saveNotes(notesFile, notes)
    }
    result = { did: 'recovered' }
  }

  persist(next)
  return result
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** One key out of the state .env, and nothing else from it. */
export function readEnvKey(file: string, key: string): string | undefined {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return undefined
}

async function telegramNotify(stateDir: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? readEnvKey(join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN')
  const chat = readAccess(stateDir).allowFrom?.[0]
  if (!token) throw new Error('no bot token available')
  if (!chat) throw new Error('no allowlisted chat')
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }),
    signal: AbortSignal.timeout(15_000),
  })
  // Never echo the URL: it carries the token.
  if (!res.ok) throw new Error(`telegram answered ${res.status}`)
}

if (import.meta.main) {
  const stateDir = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
  if (!existsSync(stateDir)) process.exit(0)
  const r = await runDeadman({
    stateDir,
    now: Date.now(),
    pidAlive: pid => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } },
    quiet: quietAt,
    notify: text => telegramNotify(stateDir, text),
  })
  if (r.did !== 'none') console.error(`deadman: ${r.did}${r.why ? ` (${r.why})` : ''}`)
}
