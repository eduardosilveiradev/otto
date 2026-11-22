/**
 * Nothing the user says is lost to a restart.
 *
 * Telegram delivers each update exactly once. The moment the poller takes a
 * message the offset moves on, and from then on the only copy is the
 * notification the server pushed into the session. If the session restarts
 * before it answers — a crash, a /mcp reload, a self-install, the machine
 * waking into a new session — that notification dies with it, and from the user's
 * side they were simply ignored. They will not resend; they will assume Otto
 * saw it and chose silence.
 *
 * Every inbound message is written down before handover. A delivered transcript
 * record confirms receipt for app messages and journaled events; a reply or a
 * reaction also counts as handling its target. Messages without receipt tracking
 * keep the coarse chat-level reply policy.
 *
 * On restart, unconfirmed entries are handed over with `redelivered="1"` so the
 * session knows it may have started on them already. An enqueue record alone
 * does not confirm receipt: a restart may have cut in before delivery.
 *
 * Receipt-tracked messages stop replaying once the transcript shows delivery.
 * Until then they get at most MAX_ATTEMPTS replays; untracked messages get one.
 * Attempts are saved before sending to bound crash loops.
 */

import { readFileSync, writeFileSync, renameSync, openSync, readSync, closeSync, statSync, readdirSync } from 'fs'
import { join } from 'path'

export type JournalEntry = {
  chat_id: string
  message_id: string
  /** What the session was shown, capped. Enough to answer it cold. */
  text: string
  /** ISO time the server received it. */
  ts: string
  /** The notification meta it went out with, replayed as-is. */
  meta: Record<string, string>
  answered?: boolean
  redelivered?: boolean
  /** Receipt-tracked app messages and journaled events: false until the
   * transcript shows it. An unread one is replayed again, up to MAX_ATTEMPTS starts. */
  read?: boolean
  /** Starts it has been replayed on, and when last: one start replays a message once. */
  attempts?: number
  attemptedAt?: string
  /** Unread, and given up on (replays spent, or about to age out): the user was told, once. */
  abandoned?: boolean
}

/** Entries older than this are dropped whatever their state. */
export const KEEP_MS = 48 * 3_600_000
/** access.json `redeliverHours` when unset. */
export const DEFAULT_REDELIVER_HOURS = 6
/** Per start. A backlog bigger than this is a different problem than a restart. */
export const REDELIVER_CAP = 10
/** Replays of a message never read. Two restarts in a row before the session reaches one are
 * ordinary (a reload, then a self-install); more than this is a loop, and replaying feeds it. */
export const MAX_ATTEMPTS = 3
/** The whole message: a replay that cuts off a pasted list loses its end. Past the app's 64 KB frames, nothing real. */
const TEXT_MAX = 64_000

export function loadJournal(file: string): JournalEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as JournalEntry[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: inbound journal corrupt, moved aside.\n')
    }
    return []
  }
}

export function saveJournal(file: string, entries: JournalEntry[]): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

/** Past KEEP_MS an entry goes, except one never read and not yet given up on: that one stays until
 * takeAbandoned has named it (and the unread tombstone exists), or it would vanish unnamed and its
 * history row would turn Read. Two weeks is the limit whatever happens. */
export function pruneJournal(entries: JournalEntry[], now: number): JournalEntry[] {
  return entries.filter(e => {
    const age = now - Date.parse(e.ts)
    return age <= KEEP_MS || (age <= 14 * 24 * 3_600_000 && e.read === false && !e.answered && !e.abandoned)
  })
}

/** Add one inbound message. Telegram can redeliver an update; the id dedupes it. The app's
 * messages are written on arrival and again with their full meta just before they go in,
 * so a second write keeps the entry (time and flags) and takes the newer meta. */
export function recordInbound(
  entries: JournalEntry[],
  e: { chat_id: string; message_id: string; text: string; meta: Record<string, string>; read?: boolean },
  now: number,
): JournalEntry[] {
  const kept = pruneJournal(entries, now)
  const had = kept.find(x => x.chat_id === e.chat_id && x.message_id === e.message_id)
  if (had) { had.meta = e.meta; had.text = e.text.length > TEXT_MAX ? `${e.text.slice(0, TEXT_MAX)}…` : e.text; return kept }
  const text = e.text.length > TEXT_MAX ? `${e.text.slice(0, TEXT_MAX)}…` : e.text
  return [...kept, { ...e, text, ts: new Date(now).toISOString() }]
}

/**
 * Something went back to `chat_ids` at `now`. Every message there that arrived
 * by then is answered, and so is the one it threads under. Except one the session
 * hasn't read yet (`unread`): it is still waiting behind the turn that replied.
 */
export function markAnswered(
  entries: JournalEntry[],
  chat_ids: string[],
  now: number,
  reply_to?: string,
  unread?: Set<string>,
): JournalEntry[] {
  for (const e of entries) {
    if (!chat_ids.includes(e.chat_id)) continue
    if (e.message_id === reply_to || (Date.parse(e.ts) <= now && !unread?.has(e.message_id))) e.answered = true
  }
  return entries
}

/** A tap or an approval acts on the moment it was made: past ten minutes, replaying a "Pay it now"
 * is worse than dropping it (named in the thread by takeAbandoned instead). */
const EVENT_TAP_MS = 10 * 60_000

/** How long after it arrived an entry may still be replayed. A message known unread never reached
 * the session at all, so it stays owed as long as the journal keeps it; injected events (reminders,
 * webhooks) keep the configured window, taps and approvals ten minutes. */
function replayWindow(e: JournalEntry, windowMs: number): number {
  if (e.meta.event === 'pr-merged' || e.meta.event === 'job') return 24 * 3_600_000
  if (e.meta.event === 'button') return Math.min(windowMs, EVENT_TAP_MS)
  if (e.meta.event) return windowMs
  return e.read === false ? KEEP_MS : windowMs
}

/** The session's transcript shows these: they are read, and never replayed again. An injected
 * event (a tap, a reminder) is also done with: it may rightly draw no reply, and replaying a
 * "send ✓" sends twice. */
export function markRead(entries: JournalEntry[], ids: string[]): JournalEntry[] {
  for (const e of entries) {
    if (e.read !== false || !ids.includes(e.message_id)) continue
    e.read = true
    if (e.meta.event) e.answered = true
  }
  return entries
}

/**
 * The messages to hand over again, oldest first, with each attempt recorded.
 * One known to be unread (`read: false`) can go again on a later start, MAX_ATTEMPTS in all.
 * Only messages from before `bootAt` qualify: anything newer reached this
 * process and is being answered right now.
 */
export function takeRedeliveries(
  entries: JournalEntry[],
  opts: { now: number; windowMs: number; bootAt: number; cap?: number },
): JournalEntry[] {
  const picked = entries
    // Anything this process already handed over (since bootAt) is in the session's queue: not replayed.
    .filter(e => !(e.attemptedAt && Date.parse(e.attemptedAt) >= opts.bootAt))
    .filter(e => e.read !== true && !e.answered && !e.abandoned && (!e.redelivered || (e.read === false && (e.attempts ?? 1) < MAX_ATTEMPTS)))
    .filter(e => {
      const at = Date.parse(e.ts)
      return at < opts.bootAt && opts.now - at <= replayWindow(e, opts.windowMs)
    })
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    .slice(0, opts.cap ?? REDELIVER_CAP)
  for (const e of picked) { e.redelivered = true; e.attempts = (e.attempts ?? 0) + 1; e.attemptedAt = new Date(opts.now).toISOString() }
  return picked
}

/** App messages a new process should still treat as unread: not read, not answered, and with
 * replays left. Spent ones stay out, or the typing dots would wait on them forever. */
export function unreadOwed(entries: JournalEntry[], o: { now: number }): string[] {
  return entries.filter(e => e.read === false && !e.answered && !e.abandoned && (e.attempts ?? 0) < MAX_ATTEMPTS && o.now - Date.parse(e.ts) <= KEEP_MS)
    .map(e => e.message_id)
}

/** Unread messages the journal is about to stop trying (replays spent, or within the hour of
 * aging out), flagged so each is named to the user once rather than dropped in silence. */
export function takeAbandoned(entries: JournalEntry[], now: number, o: { bootAt: number; windowMs: number }): JournalEntry[] {
  const out = entries.filter(e => {
    if (e.read !== false || e.answered || e.abandoned) return false
    const age = now - Date.parse(e.ts)
    if (age > KEEP_MS - 3_600_000) return true   // about to leave the journal for good
    // Handed to the session by this process (arrived, or replayed, since it started): it is still in
    // the session's queue behind a long turn, not lost.
    if (Date.parse(e.attemptedAt ?? e.ts) >= o.bootAt) return false
    return (e.attempts ?? 0) >= MAX_ATTEMPTS || age > (e.meta.event ? replayWindow(e, o.windowMs) : KEEP_MS - 3_600_000)
  })
  for (const e of out) e.abandoned = true
  return out
}

/** Only delivered channel envelopes count. Queue operations, tool output and quoted ids
 * are not receipts. Mid-turn delivery is a queued_command attachment in Claude Code. */
export function deliveredIds(line: string): string[] {
  let row: any
  try { row = JSON.parse(line) } catch { return [] }
  if (!row || typeof row !== 'object') return []
  let text: string
  if (row.type === 'attachment' && row.attachment?.type === 'queued_command') {
    text = row.attachment.prompt
  } else if (row.type === 'user' && !row.toolUseResult && !row.queueTranscriptOnly) {
    const content = row.message?.content
    text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : ''
  } else return []
  if (typeof text !== 'string') return []
  return [...text.matchAll(/<channel\s+source="plugin:otto:otto"\s[^>]*\bmessage_id="([^"<>]+)"[^>]*>/g)].map(m => m[1]!)
}

/** Incremental, complete JSONL scan: no tail limit, and no partial-line receipts.
 * A fresh process rescans durable transcripts before deciding what was lost. */
export class TranscriptReceipts {
  private files = new Map<string, { offset: number; pending: Buffer; ids: Set<string>; ino: number }>()

  read(file: string): Set<string> {
    const stat = statSync(file)
    let state = this.files.get(file)
    if (!state || stat.size < state.offset || stat.ino !== state.ino) {
      state = { offset: 0, pending: Buffer.alloc(0), ids: new Set(), ino: stat.ino }
      this.files.set(file, state)
    }
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(64 * 1024)
      // Buffer partial UTF-8 bytes until the next newline before decoding.
      let pending = state.pending
      while (state.offset < stat.size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, stat.size - state.offset), state.offset)
        if (!n) break
        state.offset += n
        pending = Buffer.concat([pending, buf.subarray(0, n)])
        let end: number
        while ((end = pending.indexOf(10)) >= 0) {
          for (const id of deliveredIds(pending.subarray(0, end).toString('utf8'))) state.ids.add(id)
          pending = pending.subarray(end + 1)
        }
      }
      state.pending = pending
    } finally { closeSync(fd) }
    return state.ids
  }
}

/** Recover receipts even when the old process died before another hook ran.
 * Only top-level session transcripts can acknowledge the main session's inbox. */
export function recoverRead(entries: JournalEntry[], projects: string): JournalEntry[] {
  const owed = entries.filter(e => e.read === false && !e.answered)
  if (!owed.length) return entries
  const oldest = Math.min(...owed.map(e => Date.parse(e.ts)))
  const receipts = new TranscriptReceipts()
  try {
    for (const dir of readdirSync(projects, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const project = join(projects, dir.name)
      for (const name of readdirSync(project)) {
        if (!name.endsWith('.jsonl')) continue
        const file = join(project, name)
        try {
          if (statSync(file).mtimeMs >= oldest) markRead(entries, [...receipts.read(file)])
        } catch { /* An unreadable transcript is not evidence of delivery. */ }
      }
    }
  } catch { /* Keep messages owed when transcripts are unavailable. */ }
  return entries
}
