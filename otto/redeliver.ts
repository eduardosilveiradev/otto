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
 * So every inbound message is written down before it is handed over, and
 * crossed off when something goes back to that chat. On the next start whatever
 * is still uncrossed, and young enough to still matter, is handed over again
 * with `redelivered="1"` so the session knows it may be reading something it
 * already started on.
 *
 * "Answered" is deliberately coarse: any reply or reaction to the chat after
 * the message arrived counts, as does a reply threaded under it. The session
 * often answers three messages with one reply, and a reaction is a complete
 * answer to "ok thanks". Erring toward answered costs a missed redelivery,
 * which is today's behaviour; erring the other way repeats the user's own
 * words back into the session hours later, which is worse.
 *
 * Each message is redelivered at most once, ever. The flag is written before
 * the notification goes out: a crash in between loses the replay, and the
 * other order repeats it on every crash-loop iteration.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'

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
}

/** Entries older than this are dropped whatever their state. */
export const KEEP_MS = 48 * 3_600_000
/** access.json `redeliverHours` when unset. */
export const DEFAULT_REDELIVER_HOURS = 6
/** Per start. A backlog bigger than this is a different problem than a restart. */
export const REDELIVER_CAP = 10
const TEXT_MAX = 1500

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

export function pruneJournal(entries: JournalEntry[], now: number): JournalEntry[] {
  return entries.filter(e => now - Date.parse(e.ts) <= KEEP_MS)
}

/** Add one inbound message. Telegram can redeliver an update; the id dedupes it. */
export function recordInbound(
  entries: JournalEntry[],
  e: { chat_id: string; message_id: string; text: string; meta: Record<string, string> },
  now: number,
): JournalEntry[] {
  const kept = pruneJournal(entries, now)
  if (kept.some(x => x.chat_id === e.chat_id && x.message_id === e.message_id)) return kept
  const text = e.text.length > TEXT_MAX ? `${e.text.slice(0, TEXT_MAX)}…` : e.text
  return [...kept, { ...e, text, ts: new Date(now).toISOString() }]
}

/**
 * Something went back to `chat_ids` at `now`. Every message there that arrived
 * by then is answered, and so is the one it threads under.
 */
export function markAnswered(
  entries: JournalEntry[],
  chat_ids: string[],
  now: number,
  reply_to?: string,
): JournalEntry[] {
  for (const e of entries) {
    if (!chat_ids.includes(e.chat_id)) continue
    if (Date.parse(e.ts) <= now || e.message_id === reply_to) e.answered = true
  }
  return entries
}

/**
 * The messages to hand over again, oldest first, flagged so they never go twice.
 * Only messages from before `bootAt` qualify: anything newer reached this
 * process and is being answered right now.
 */
export function takeRedeliveries(
  entries: JournalEntry[],
  opts: { now: number; windowMs: number; bootAt: number; cap?: number },
): JournalEntry[] {
  const picked = entries
    .filter(e => !e.answered && !e.redelivered)
    .filter(e => {
      const at = Date.parse(e.ts)
      return at < opts.bootAt && opts.now - at <= opts.windowMs
    })
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    .slice(0, opts.cap ?? REDELIVER_CAP)
  for (const e of picked) e.redelivered = true
  return picked
}
