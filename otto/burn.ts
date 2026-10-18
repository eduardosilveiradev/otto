/**
 * Burn this message.
 *
 * A password pasted into the chat does not stay in the chat. Before the session
 * has even read it, the channel has written it to history.jsonl, pushed it into
 * the dashboard's live feed, and journalled it for redelivery; that night the
 * session transcript holding it is distilled into memory, which every future
 * session reads. Deleting it in Telegram removes the one copy the user can see.
 *
 * So a burn overwrites the text, in place, everywhere the channel persisted it:
 *
 *   history.jsonl + history.1.jsonl   every line carrying that message id
 *   the chat feed                     the dashboard's in-memory ring
 *   inbound-journal.json              the entry, and any reply_to_text quoting it
 *   queue.json                        a held outgoing message, if given its id
 *
 * The text becomes "[burned]"; the line, the id, the timestamp and the order
 * all stay, so a cursor, a long-poll seq or a reply thread still resolves.
 *
 * The session transcript is Claude Code's, not ours, and is not rewritten. What
 * is under our control is what happens to it next: burned.json keeps a sha256 of
 * the text, and consolidate.ts drops any transcript entry containing it before
 * a digest is written. A hash, not the text — the point of the file is to
 * remember what to forget without remembering it.
 *
 * Containment, not equality, because the transcript wraps the message in a
 * channel envelope and sometimes appends a hint. Testing every window of every
 * entry with sha256 would be quadratic on a long session, so each record also
 * carries a 30-bit rolling fingerprint: the window that matches it is the only
 * one that gets hashed. A secret shorter than MIN_CONTAIN characters is matched
 * as a whole entry only — "1234" inside a phone number is not the PIN.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { createHash } from 'crypto'
import type { JournalEntry } from './redeliver.ts'
import type { QueuedMessage } from './queue.ts'

export const BURNED_TEXT = '[burned]'
/** Below this many characters a secret is matched only as an entire entry. */
export const MIN_CONTAIN = 8
/** Telegram lets a bot delete a message only this long after it was sent. */
export const DELETE_WINDOW_MS = 48 * 3_600_000

export type BurnedRecord = {
  sha256: string
  /** UTF-16 length, the window size the matcher slides. */
  len: number
  /** Rolling fingerprint of the whole text; see rolling(). */
  rk: number
  chat_id?: string
  message_id: string
  at: string
}

export type BurnTarget = { message_id: string; chat_id?: string }

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function loadBurned(file: string): BurnedRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as BurnedRecord[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: burned.json corrupt, moved aside.\n')
    }
    return []
  }
}

export function saveBurned(file: string, records: BurnedRecord[]): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const RK_BASE = 131
const RK_MOD = 1_000_000_007

/** Polynomial hash over UTF-16 code units. Every intermediate stays under 2^53. */
export function rolling(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * RK_BASE + text.charCodeAt(i)) % RK_MOD
  return h
}

/** Add the texts of one burn. "[burned]" itself and repeats are skipped. */
export function recordBurned(
  records: BurnedRecord[],
  texts: string[],
  target: BurnTarget,
  now: number,
): BurnedRecord[] {
  const out = [...records]
  for (const raw of texts) {
    const text = raw.trim()
    if (!text || text === BURNED_TEXT) continue
    const hash = sha256(text)
    if (out.some(r => r.sha256 === hash)) continue
    out.push({
      sha256: hash, len: text.length, rk: rolling(text),
      ...(target.chat_id ? { chat_id: target.chat_id } : {}),
      message_id: target.message_id,
      at: new Date(now).toISOString(),
    })
  }
  return out
}

/** True when `text` contains, or for a short secret is, a burned text. */
export function burnedMatcher(records: BurnedRecord[]): (text: string) => boolean {
  if (!records.length) return () => false
  const whole = new Set<string>()
  const byLen = new Map<number, Map<number, Set<string>>>()
  for (const r of records) {
    whole.add(r.sha256)
    if (r.len < MIN_CONTAIN) continue
    const byRk = byLen.get(r.len) ?? new Map<number, Set<string>>()
    byRk.set(r.rk, (byRk.get(r.rk) ?? new Set()).add(r.sha256))
    byLen.set(r.len, byRk)
  }
  return (text: string) => {
    if (whole.has(sha256(text.trim()))) return true
    for (const [len, byRk] of byLen) {
      if (text.length < len) continue
      // BASE^(len-1), to take the outgoing character back off.
      let pow = 1
      for (let i = 1; i < len; i++) pow = (pow * RK_BASE) % RK_MOD
      let h = rolling(text.slice(0, len))
      for (let i = 0; ; i++) {
        const hashes = byRk.get(h)
        if (hashes?.has(sha256(text.slice(i, i + len)))) return true
        if (i + len >= text.length) break
        h = (h - (text.charCodeAt(i) * pow) % RK_MOD + RK_MOD) % RK_MOD
        h = (h * RK_BASE + text.charCodeAt(i + len)) % RK_MOD
      }
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// The stores the channel writes inbound text to
// ---------------------------------------------------------------------------

type Line = { ts?: string; dir?: string; chat_id?: string; message_id?: string; kind?: string; text?: string }

function hits(t: BurnTarget, chat_id?: string, message_id?: string): boolean {
  return message_id === t.message_id && (!t.chat_id || chat_id === t.chat_id)
}

/**
 * history.jsonl content with the target's text burned. Lines keep their place
 * and every field but text; a line that does not parse is left exactly as it was.
 */
export function burnHistory(raw: string, t: BurnTarget): { raw: string; texts: string[]; count: number; chat_id?: string; ts?: string } {
  const texts: string[] = []
  let count = 0
  let chat_id: string | undefined
  let ts: string | undefined
  const lines = raw.split('\n').map(line => {
    if (!line) return line
    let e: Line
    try { e = JSON.parse(line) } catch { return line }
    if (!hits(t, e.chat_id, e.message_id)) return line
    count++
    chat_id ??= e.chat_id
    ts ??= e.ts
    if (typeof e.text === 'string') texts.push(e.text)
    return JSON.stringify({ ...e, text: BURNED_TEXT })
  })
  return { raw: lines.join('\n'), texts, count, ...(chat_id ? { chat_id } : {}), ...(ts ? { ts } : {}) }
}

/**
 * The journal with the target burned, and with the quote of it carried by any
 * message that replied to it. The journal caps text with an ellipsis; the text
 * handed back drops it, so it is still a substring of the original.
 */
export function burnJournal(entries: JournalEntry[], t: BurnTarget): { entries: JournalEntry[]; texts: string[]; count: number; chat_id?: string; ts?: string } {
  const texts: string[] = []
  let count = 0
  let chat_id: string | undefined
  let ts: string | undefined
  const out = entries.map(e => {
    if (hits(t, e.chat_id, e.message_id)) {
      count++
      chat_id ??= e.chat_id
      ts ??= e.ts
      texts.push(e.text.endsWith('…') ? e.text.slice(0, -1) : e.text)
      return { ...e, text: BURNED_TEXT }
    }
    if (e.meta?.reply_to_id === t.message_id && e.meta.reply_to_text && (!t.chat_id || e.chat_id === t.chat_id)) {
      count++
      return { ...e, meta: { ...e.meta, reply_to_text: BURNED_TEXT } }
    }
    return e
  })
  return { entries: out, texts, count, ...(chat_id ? { chat_id } : {}), ...(ts ? { ts } : {}) }
}

/** A held outgoing message burned by its queue id. Only ever by id: inbound text is never queued. */
export function burnQueue(q: QueuedMessage[], t: BurnTarget): { queue: QueuedMessage[]; texts: string[]; count: number } {
  const texts: string[] = []
  const queue = q.map(m => {
    if (!hits(t, m.chat_id, m.id)) return m
    texts.push(m.text)
    return { ...m, text: BURNED_TEXT }
  })
  return { queue, texts, count: texts.length }
}

// ---------------------------------------------------------------------------
// `last: true`
// ---------------------------------------------------------------------------

/**
 * "burn that" is itself the newest inbound message by the time the tool runs,
 * so it is passed over: a short message that is only the request. Anything
 * longer is taken at its word, since the secret may well start with "delete".
 */
const REQUEST_RE = /^(?:pls |please )?(?:burn|delete|remove|unsend|nuke|scrub)\b.{0,30}$|shouldn[’']?t have sent|should not have sent|didn[’']?t mean to send/i

export function isBurnRequest(text: string): boolean {
  const t = text.trim()
  return t.length <= 60 && REQUEST_RE.test(t)
}

/** The user's most recent inbound message across history lines, skipping the request to burn it. */
export function lastInbound(raws: string[], chat_id?: string): { message_id: string; chat_id: string } | undefined {
  const ins: { ts: string; message_id: string; chat_id: string; text: string }[] = []
  for (const raw of raws) {
    for (const line of raw.split('\n')) {
      if (!line) continue
      let e: Line
      try { e = JSON.parse(line) } catch { continue }
      if (e.dir !== 'in' || !e.message_id || !e.chat_id || e.kind === 'reaction') continue
      if (chat_id && e.chat_id !== chat_id) continue
      ins.push({ ts: e.ts ?? '', message_id: e.message_id, chat_id: e.chat_id, text: e.text ?? '' })
    }
  }
  ins.sort((a, b) => a.ts.localeCompare(b.ts))
  // Only the newest can be the request; an older "delete that" is just something they said.
  if (ins.length > 1 && isBurnRequest(ins[ins.length - 1].text)) ins.pop()
  const e = ins[ins.length - 1]
  return e ? { message_id: e.message_id, chat_id: e.chat_id } : undefined
}
