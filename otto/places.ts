/**
 * Places the user has been told about, been to, or wants to go.
 *
 * "Ana said there's a ramen place in Lisbon you'd love" is said once, in
 * passing, months before the user is standing in Lisbon at lunchtime. By then
 * the name is gone and so is who said it. This file keeps both, and keeps them
 * in the user's words.
 *
 * Same rule as the people graph: the source is the user. Nothing here reads a
 * mailbox or a booking confirmation for venues — a restaurant that sent a
 * newsletter is not a recommendation, and a place the user chose to mention is
 * exactly the one worth keeping.
 *
 * Three things are not obvious.
 *
 *   A place is its name in its city, folded. "Café Lume" in "Lisboa" and
 *   "cafe lume" in "lisboa" are one record; the same name in another city is
 *   another place. Accents and case are dropped for the match only — the
 *   spelling stored is the first one the user gave.
 *
 *   A new value displaces the old one but does not erase it. want becomes
 *   been becomes loved (or avoid), and "it was on the list because Ana said so"
 *   is still worth having after the visit, so each displaced value stays as a
 *   dated note, the way a person's old city does.
 *
 *   recommendedBy is resolved against the people graph, never copied in as a
 *   bare string. Two Marcos is a question for the user, not a coin toss, and a
 *   name nobody has explained yet becomes a mention there, so "who is Ana"
 *   has an answer the next time it is asked.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { matchPeople, mentionPerson, displayName, type Person } from './people.ts'

export const PLACE_KINDS = ['restaurant', 'cafe', 'bar', 'shop', 'sight', 'other'] as const
export const PLACE_STATUSES = ['want', 'been', 'loved', 'avoid'] as const
export type PlaceKind = typeof PLACE_KINDS[number]
export type PlaceStatus = typeof PLACE_STATUSES[number]

/** Something the user said about a place, kept in their words and dated. */
export type PlaceNote = { at: string; text: string }

export type Place = {
  /** Folded "name|city": the identity, stable across spellings. */
  id: string
  /** As the user first spelled it. */
  name: string
  city: string
  kind: PlaceKind
  status: PlaceStatus
  /** Display name of whoever recommended it, as the people graph knows them. */
  recommendedBy?: string
  /** That person's id in people.json. It can be an address, so it never leaves the Mac. */
  recommenderId?: string
  /** Lowercased, unique. */
  tags: string[]
  /** What the user said, and every value a newer one displaced. Oldest first. */
  notes: PlaceNote[]
  createdAt: string
  updatedAt: string
}

/** Enough for a place the user keeps going back to; short enough to read in one screen. */
const MAX_NOTES = 30

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Case, accents and spacing dropped: "Café  Lúme" and "cafe lume" fold alike. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function placeId(name: string, city: string): string {
  return `${fold(name)}|${fold(city)}`
}

export function findPlace(places: Place[], name: string, city: string): Place | undefined {
  const id = placeId(name, city)
  return places.find(p => p.id === id)
}

// ---------------------------------------------------------------------------
// Recommenders
// ---------------------------------------------------------------------------

/**
 * Who a recommender's name means in the people graph.
 *
 * One match links to it; none records a mention, the way a name said in
 * passing is recorded by note_contact; more than one throws, because picking a
 * Marco is how a recommendation ends up credited to the wrong person.
 */
export function resolveRecommender(people: Person[], name: string): { id: string; name: string } {
  const clean = name.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('recommendedBy is empty')
  const hits = matchPeople(people, clean)
  if (hits.length > 1) {
    throw new Error(`more than one ${clean}: ${hits.map(displayName).join(', ')} — say which`)
  }
  const p = hits[0] ?? mentionPerson(people, clean)
  return { id: p.id, name: displayName(p) }
}

// ---------------------------------------------------------------------------
// What the user said
// ---------------------------------------------------------------------------

export type PlaceInput = {
  name: string
  city: string
  kind?: string
  status?: string
  /** Already resolved with resolveRecommender. */
  recommendedBy?: { id: string; name: string }
  /** The user's own words, verbatim. */
  note?: string
  tags?: string[]
  /** When it was said. Defaults to now. */
  at?: string
}

function pushNote(p: Place, at: string, text: string): void {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean || p.notes.some(n => n.text === clean)) return
  p.notes.push({ at, text: clean })
  if (p.notes.length > MAX_NOTES) p.notes.splice(0, p.notes.length - MAX_NOTES)
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined || value === '') return undefined
  const v = value.trim().toLowerCase()
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${field} must be one of ${allowed.join(', ')}`)
  return v as T
}

function cleanTags(tags: string[] | undefined): string[] {
  return (tags ?? []).map(t => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean)
}

/**
 * Fold something the user said about a place into the list.
 *
 * Same name in the same city — case and accents aside — updates the record:
 * the newest kind, status and recommender win, the ones they displaced stay as
 * dated notes, tags accumulate, and the note is appended. Anything else is a
 * new place, wanted unless the user said otherwise.
 */
export function recordPlace(places: Place[], input: PlaceInput): { place: Place; created: boolean } {
  const name = input.name?.replace(/\s+/g, ' ').trim()
  const city = input.city?.replace(/\s+/g, ' ').trim()
  if (!name) throw new Error('name is required')
  if (!city) throw new Error('city is required — the same name in two cities is two places')
  const kind = oneOf(input.kind, PLACE_KINDS, 'kind')
  const status = oneOf(input.status, PLACE_STATUSES, 'status')
  const at = input.at ?? new Date().toISOString()

  let p = findPlace(places, name, city)
  const created = !p
  if (!p) {
    p = {
      id: placeId(name, city),
      name,
      city,
      kind: kind ?? 'other',
      status: status ?? 'want',
      tags: [],
      notes: [],
      createdAt: at,
      updatedAt: at,
    }
    places.push(p)
  } else {
    if (kind && kind !== p.kind) { pushNote(p, at, `kind was ${p.kind}`); p.kind = kind }
    if (status && status !== p.status) { pushNote(p, at, `status was ${p.status}`); p.status = status }
  }

  const rec = input.recommendedBy
  if (rec && rec.id !== p.recommenderId) {
    if (p.recommendedBy) pushNote(p, at, `recommended by ${p.recommendedBy}`)
    p.recommendedBy = rec.name
    p.recommenderId = rec.id
  }
  for (const t of cleanTags(input.tags)) if (!p.tags.includes(t)) p.tags.push(t)
  if (input.note) pushNote(p, at, input.note)

  p.updatedAt = at
  return { place: p, created }
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

export type PlaceQuery = {
  city?: string
  kind?: string
  status?: string
  /** Matched, folded, against name, city, tags, notes and recommender. */
  text?: string
  limit?: number
}

function haystack(p: Place): string {
  return fold([p.name, p.city, p.kind, p.recommendedBy ?? '', ...p.tags, ...p.notes.map(n => n.text)].join(' '))
}

export function queryPlaces(places: Place[], q: PlaceQuery = {}): Place[] {
  const city = q.city ? fold(q.city) : undefined
  const kind = oneOf(q.kind, PLACE_KINDS, 'kind')
  const status = oneOf(q.status, PLACE_STATUSES, 'status')
  const text = q.text ? fold(q.text) : undefined
  const hits = places.filter(p =>
    (!city || fold(p.city) === city) &&
    (!kind || p.kind === kind) &&
    (!status || p.status === status) &&
    (!text || haystack(p).includes(text)))
  hits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return q.limit ? hits.slice(0, q.limit) : hits
}

/**
 * Places for a recall query: any word of three letters or more, ranked by how
 * many matched. Recall is asked in a few distinctive words ("ramen lisbon"),
 * not a phrase, so requiring the whole string would miss nearly everything.
 */
export function searchPlaces(places: Place[], query: string, limit = 8): Place[] {
  const words = [...new Set(fold(query).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3))]
  if (!words.length) return []
  return places
    .map(p => { const h = haystack(p); return { p, score: words.filter(w => h.includes(w)).length } })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.p.updatedAt.localeCompare(a.p.updatedAt))
    .slice(0, limit)
    .map(x => x.p)
}

/** One line: "Lume (Lisbon) · cafe · loved · via Ana · #brunch — "best pastel in town"". */
export function formatPlace(p: Place): string {
  const bits = [`${p.name} (${p.city})`, p.kind, p.status]
  if (p.recommendedBy) bits.push(`via ${p.recommendedBy}`)
  if (p.tags.length) bits.push(p.tags.map(t => `#${t}`).join(' '))
  // The newest thing the user said, not a displaced value the merge wrote.
  const said = [...p.notes].reverse().find(n => !/^(kind|status) was |^recommended by /.test(n.text))
  return bits.join(' · ') + (said ? ` — "${said.text}"` : '')
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function loadPlaces(file: string): Place[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as Place[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: places.json corrupt, moved aside.\n')
    }
    return []
  }
}

/** places.json for a reader that must not touch it: a viewer never moves a corrupt file aside. */
export function readPlaces(file: string): Place[] {
  if (!existsSync(file)) return []
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`${file} is not an array`)
  return parsed as Place[]
}

export function savePlaces(file: string, places: Place[]): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(places, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export const PLACES_FILE = join(
  process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'),
  'places.json',
)
