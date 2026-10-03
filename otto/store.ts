/**
 * Otto's own durable memory — the notes store.
 *
 * Before this existed the only places a fact could live were CLAUDE.md (edited
 * by hand), the session's own memory (which a fired trigger never sees), and
 * trigger action text — which recipes had started abusing as a database: the
 * price-watch recipe stores last week's price *inside its own prompt* and
 * rewrites the prompt to update it. That is a KV store spelled as a paragraph.
 *
 * Four record kinds share one file because they share one lifecycle (write
 * once, search often, occasionally close) and the volume is small enough that
 * load-all/save-all costs nothing:
 *
 *   fact   standing truth about the user or the world they operate in
 *   loop   something owed — by them or to them — with an optional due date
 *   saved  a link, document or clipping the user parked for later
 *   write  an outbound change Otto made (calendar event, task) + how to undo it
 *
 * Everything is machine-local, 0600, and never leaves the box.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { randomBytes } from 'crypto'

export type NoteKind = 'fact' | 'loop' | 'saved' | 'write'
export type NoteStatus = 'open' | 'done' | 'dropped'

export type Note = {
  id: string
  kind: NoteKind
  text: string
  tags: string[]
  createdAt: string
  updatedAt?: string
  /** loop only: ISO date/datetime it comes due. */
  due?: string
  /** loop and write: open until closed. Facts and saved items stay open. */
  status?: NoteStatus
  /** Where it came from — "telegram", "email:<thread>", "trigger:<id>". */
  source?: string
  /** write only: the plain-English inverse, executable with no other context. */
  undo?: string
  /** loop: why it was closed, when a pass closed it on evidence. Absent when a
   * person closed it — they know why. */
  closedReason?: string
  /** loop: who closed it. Only ever set by the nightly hygiene pass. */
  closedBy?: 'hygiene'
  closedAt?: string
  /** loop: set when a closed loop is reopened. A reopened loop is never
   * auto-closed again — reopening it was the user disagreeing with the pass. */
  reopenedAt?: string
  /** loop: when its due date was pushed later, newest last. Avoidance evidence. */
  deferrals?: string[]
}

/** More than this is a loop nobody is going to finish; the tail adds nothing. */
const DEFERRALS_KEPT = 20

export function noteId(): string {
  return randomBytes(4).toString('hex')
}

export function loadNotes(file: string): Note[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as Note[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Same policy as triggers.json: never let a corrupt file wedge the
      // channel, but never silently destroy it either.
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: notes.json corrupt, moved aside.\n')
    }
    return []
  }
}

export function saveNotes(file: string, notes: Note[]): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(notes, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

/** Upsert. An id that already exists is patched; anything else is created. */
export function upsertNote(
  notes: Note[],
  patch: Partial<Note> & { kind?: NoteKind; text?: string },
): { notes: Note[]; note: Note; created: boolean } {
  const now = new Date().toISOString()
  if (patch.id) {
    const existing = notes.find(n => n.id === patch.id)
    if (!existing) throw new Error(`no note ${patch.id}`)
    // A due date moving later is a deferral. Only a real move counts: re-sending
    // the same date, or pulling it earlier, is not the loop being put off.
    if (existing.kind === 'loop' && patch.due !== undefined && existing.due) {
      const was = Date.parse(existing.due)
      const now2 = Date.parse(patch.due)
      if (!Number.isNaN(was) && !Number.isNaN(now2) && now2 > was) {
        existing.deferrals = [...(existing.deferrals ?? []), now].slice(-DEFERRALS_KEPT)
      }
    }
    if (patch.status === 'open' && existing.status && existing.status !== 'open') {
      delete existing.closedReason
      delete existing.closedBy
      delete existing.closedAt
      existing.reopenedAt = now
    }
    Object.assign(existing, {
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.due !== undefined ? { due: patch.due } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.source !== undefined ? { source: patch.source } : {}),
      ...(patch.undo !== undefined ? { undo: patch.undo } : {}),
      ...(patch.closedReason !== undefined ? { closedReason: patch.closedReason } : {}),
      ...(patch.closedBy !== undefined ? { closedBy: patch.closedBy } : {}),
      ...(patch.closedAt !== undefined ? { closedAt: patch.closedAt } : {}),
      updatedAt: now,
    })
    return { notes, note: existing, created: false }
  }
  if (!patch.kind) throw new Error('kind is required when creating a note')
  if (!patch.text?.trim()) throw new Error('text is required when creating a note')
  const note: Note = {
    id: noteId(),
    kind: patch.kind,
    text: patch.text.trim(),
    tags: patch.tags ?? [],
    createdAt: now,
    ...(patch.due ? { due: patch.due } : {}),
    // Loops and writes are stateful; facts and clippings just are.
    ...(patch.status
      ? { status: patch.status }
      : patch.kind === 'loop' || patch.kind === 'write'
        ? { status: 'open' as NoteStatus }
        : {}),
    ...(patch.source ? { source: patch.source } : {}),
    ...(patch.undo ? { undo: patch.undo } : {}),
  }
  notes.push(note)
  return { notes, note, created: true }
}

/**
 * Substring-and-token search. Deliberately not fuzzy: the caller is a language
 * model that can retry with a different word, and a scoring function that
 * surfaces near-misses would let a stale fact answer a question it does not
 * actually cover.
 */
export function searchNotes(
  notes: Note[],
  opts: { query?: string; kind?: NoteKind; tag?: string; includeClosed?: boolean; limit?: number } = {},
): Note[] {
  const { query, kind, tag, includeClosed = false, limit = 20 } = opts
  const terms = (query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 1)

  const hits = notes.filter(n => {
    if (kind && n.kind !== kind) return false
    if (tag && !n.tags.includes(tag)) return false
    if (!includeClosed && n.status && n.status !== 'open') return false
    if (!terms.length) return true
    const hay = `${n.text} ${n.tags.join(' ')} ${n.source ?? ''}`.toLowerCase()
    return terms.every(t => hay.includes(t))
  })

  // Due things first, soonest first; then most recently touched.
  hits.sort((a, b) => {
    const ad = a.due ? Date.parse(a.due) : NaN
    const bd = b.due ? Date.parse(b.due) : NaN
    if (!Number.isNaN(ad) && !Number.isNaN(bd)) return ad - bd
    if (!Number.isNaN(ad)) return -1
    if (!Number.isNaN(bd)) return 1
    return (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)
  })
  return hits.slice(0, limit)
}

export function formatNote(n: Note): string {
  const bits = [`[${n.id}] ${n.kind}`]
  if (n.status && n.status !== 'open') bits.push(`(${n.status})`)
  if (n.due) bits.push(`due ${n.due}`)
  if (n.tags.length) bits.push(`#${n.tags.join(' #')}`)
  const head = bits.join(' ')
  const tail = (n.undo ? `\n      undo: ${n.undo}` : '') +
    (n.closedReason ? `\n      closed: ${n.closedReason}` : '')
  return `${head} — ${n.text}${tail}`
}

/** Loops that are open and either overdue or coming due inside `withinMs`. */
export function dueLoops(notes: Note[], now: number, withinMs: number): Note[] {
  return notes
    .filter(n => n.kind === 'loop' && (n.status ?? 'open') === 'open')
    .filter(n => {
      if (!n.due) return false
      const d = Date.parse(n.due)
      return !Number.isNaN(d) && d <= now + withinMs
    })
    .sort((a, b) => Date.parse(a.due!) - Date.parse(b.due!))
}
