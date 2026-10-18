/**
 * Facts that know where they came from, how old they are, and when they were
 * replaced.
 *
 * A fact note used to be a sentence and a timestamp. That is fine for "the
 * dentist is Dr Rossi" and wrong for "lives in Lisbon": the second one quietly
 * goes false the day they move, and the store had no way to notice. Worse, the
 * move gets remembered too, and recall hands back both cities with equal
 * confidence.
 *
 * Three things fix that, all applied at write time or read time with no pass in
 * between:
 *
 *   Provenance. `source` says who said it — telegram, app, terminal,
 *   email:<id>, consolidation — so a fact lifted from a stranger's email is
 *   never mistaken for one the user typed.
 *
 *   Staleness. `confirmedAt` is when it was last said. A fact about something
 *   that moves (where they live, where they work, a phone number, a plan) older
 *   than `staleness.days` comes back from recall with its age attached. Facts
 *   written before this existed have no confirmedAt and count from createdAt.
 *
 *   Contradiction on write. A new fact with the same `key`, or the same subject
 *   phrase, as an open fact with a different value supersedes it. The old one
 *   stays on disk with `supersededBy` — history is evidence — but recall stops
 *   returning it. The same value said again only bumps confirmedAt.
 *
 * Subject matching is deliberately literal. "Home city: Lisbon" and "home city
 * is Porto" share a subject; "moved to Porto" does not share one with anything,
 * because guessing that it contradicts "lives in Lisbon" is how a store starts
 * deleting true things. A key is the reliable path; the phrase is a net.
 */

import { upsertNote, type Note } from './store.ts'

export const DEFAULT_STALE_DAYS = 180

/** The `staleness` block of access.json, with anything unusable falling back. */
export function resolveStaleDays(cfg: { days?: unknown } | undefined): number {
  const d = cfg?.days
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : DEFAULT_STALE_DAYS
}

// ---------------------------------------------------------------------------
// Subject and value
// ---------------------------------------------------------------------------

/** Who the fact is about, when that is the user — it adds nothing to a subject. */
const FILLER = /^(?:the user'?s?|user'?s?|their|they|my|i|the)(?:\s+|$)/

/**
 * Where a fact splits into subject and value. Copulas drop out of the subject;
 * verb phrases stay in it, canonicalised, so "lives in" and "live in" collide.
 * "was" is not here: a fact in the past tense is not a standing truth to replace.
 */
const SPLIT = /\s+(?:is|are|=)\s+|\s*:\s+|(?:^|\s+)(lives?|works?|goes|go|stud(?:y|ies)|attends?)\s+(in|at|for|as|to)?\s*/i

const VERB: Record<string, string> = {
  live: 'live', lives: 'live', work: 'work', works: 'work', go: 'go', goes: 'go',
  study: 'study', studies: 'study', attend: 'attend', attends: 'attend',
}

/** More words than this before the verb is a sentence, not a subject. */
const MAX_SUBJECT_WORDS = 4

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

export function splitFact(text: string): { subject?: string; value: string } {
  const m = SPLIT.exec(text)
  if (!m) return { value: norm(text) }
  let head = text.slice(0, m.index).toLowerCase().trim()
  for (let prev = ''; prev !== head;) { prev = head; head = head.replace(FILLER, '') }
  const verb = m[1] ? [VERB[m[1].toLowerCase()], m[2]?.toLowerCase()].filter(Boolean).join(' ') : ''
  const subject = norm(`${head} ${verb}`)
  const value = norm(text.slice(m.index + m[0].length))
  if (!subject || !value || subject.split(' ').length > MAX_SUBJECT_WORDS + (verb ? verb.split(' ').length : 0)) {
    return { value: norm(text) }
  }
  return { subject, value }
}

export function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, '.')
}

function isOpenFact(n: Note): boolean {
  return n.kind === 'fact' && !n.supersededBy && (n.status ?? 'open') === 'open'
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type FactWrite = {
  action: 'created' | 'confirmed' | 'superseded'
  note: Note
  /** The facts this write replaced. Empty unless action is "superseded". */
  superseded: Note[]
}

/**
 * Remember a fact, reconciling it with what is already known.
 *
 * Mutates `notes` in place like upsertNote; the caller saves.
 */
export function rememberFact(
  notes: Note[],
  input: { text: string; key?: string; tags?: string[]; source?: string },
  now = new Date().toISOString(),
): FactWrite {
  const text = input.text.trim()
  if (!text) throw new Error('text is required when creating a note')
  const key = input.key ? normalizeKey(input.key) : undefined
  const mine = splitFact(text)

  const matches = notes.filter(n => {
    if (!isOpenFact(n)) return false
    if (key && n.key === key) return true
    // Two different keys are two different things, whatever the words say.
    if (key && n.key && n.key !== key) return false
    return mine.subject != null && splitFact(n.text).subject === mine.subject
  })

  const same = matches.find(n => splitFact(n.text).value === mine.value)
  const others = matches.filter(n => n !== same)

  let note: Note
  let action: FactWrite['action']
  if (same) {
    same.confirmedAt = now
    same.updatedAt = now
    if (key && !same.key) same.key = key
    note = same
    action = 'confirmed'
  } else {
    // A fact found by its phrase takes over the old one's key, so the next
    // change is found by key even if it is worded differently.
    const inherited = key ?? matches.find(n => n.key)?.key
    note = upsertNote(notes, {
      kind: 'fact',
      text,
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(inherited ? { key: inherited } : {}),
      confirmedAt: now,
    }).note
    note.createdAt = now
    action = others.length ? 'superseded' : 'created'
  }

  for (const old of others) {
    old.supersededBy = note.id
    old.updatedAt = now
  }
  return { action, note, superseded: others }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Things that change under a person without the store hearing about it. */
const VOLATILE = /\b(?:address|city|lives?|living|lived|works?|working|job|phone|school|plans?)\b/i

export function isVolatile(n: Pick<Note, 'text' | 'key'>): boolean {
  return VOLATILE.test(n.text) || (n.key != null && VOLATILE.test(n.key.replace(/[._-]+/g, ' ')))
}

const DAY_MS = 86_400_000

export function humanAge(ms: number): string {
  const days = Math.floor(ms / DAY_MS)
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`
  const months = Math.round(days / 30.44)
  if (months < 24) return `${months} months`
  const years = Math.floor(days / 365.25)
  return `${years} years`
}

/**
 * The age note recall appends, or '' when there is nothing to say: not a fact,
 * not about something that moves, or said recently enough to trust.
 */
export function factAgeNote(n: Note, now: number, staleDays = DEFAULT_STALE_DAYS): string {
  if (n.kind !== 'fact' || !isVolatile(n)) return ''
  const at = Date.parse(n.confirmedAt ?? n.createdAt)
  if (Number.isNaN(at)) return ''
  const age = now - at
  if (age <= staleDays * DAY_MS) return ''
  return ` (said ${humanAge(age)} ago, may have changed)`
}
