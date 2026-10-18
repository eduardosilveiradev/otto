import { test, expect } from 'bun:test'
import { upsertNote, searchNotes, formatNote, type Note } from '../store.ts'
import {
  rememberFact, splitFact, factAgeNote, isVolatile, humanAge, resolveStaleDays,
  normalizeKey, DEFAULT_STALE_DAYS,
} from '../facts.ts'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-13T12:00:00Z')
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

// ---------------------------------------------------------------------------
// Subject and value
// ---------------------------------------------------------------------------

test('a copula splits subject from value and drops out of the subject', () => {
  expect(splitFact('Home city: Lisbon')).toEqual({ subject: 'home city', value: 'lisbon' })
  expect(splitFact("The user's home city is Porto.")).toEqual({ subject: 'home city', value: 'porto' })
})

test('a verb phrase stays in the subject, canonicalised', () => {
  expect(splitFact('Lives in Lisbon').subject).toBe('live in')
  expect(splitFact('They live in Porto').subject).toBe('live in')
  expect(splitFact('The user works at Acme').subject).toBe('work at')
})

test('someone else is a different subject from the user', () => {
  expect(splitFact('Their sister lives in Vienna').subject).toBe('sister live in')
})

test('no split, or a whole sentence before the verb, means no subject', () => {
  expect(splitFact('moved house last spring').subject).toBeUndefined()
  expect(splitFact('the thing we talked about on the phone last week is done').subject).toBeUndefined()
})

test('keys normalise case and spaces', () => {
  expect(normalizeKey(' Home City ')).toBe('home.city')
})

// ---------------------------------------------------------------------------
// Write: create, confirm, supersede
// ---------------------------------------------------------------------------

test('a new fact gets confirmedAt, key and source', () => {
  const notes: Note[] = []
  const w = rememberFact(notes, { text: 'Home city: Lisbon', key: 'home.city', source: 'telegram' }, ago(10))
  expect(w.action).toBe('created')
  expect(w.note).toMatchObject({ kind: 'fact', key: 'home.city', source: 'telegram', confirmedAt: ago(10) })
  expect(notes).toHaveLength(1)
})

test('the same key with a new value supersedes, keeping the old one on disk', () => {
  const notes: Note[] = []
  const old = rememberFact(notes, { text: 'Lisbon', key: 'home.city', source: 'telegram' }, ago(300)).note
  const w = rememberFact(notes, { text: 'Porto', key: 'home.city', source: 'app' }, ago(1))
  expect(w.action).toBe('superseded')
  expect(w.superseded.map(n => n.id)).toEqual([old.id])
  expect(notes).toHaveLength(2)
  expect(old.supersededBy).toBe(w.note.id)
  expect(w.note.supersededBy).toBeUndefined()
})

test('the same subject phrase with a new value supersedes without a key', () => {
  const notes: Note[] = []
  const old = rememberFact(notes, { text: 'Home city: Lisbon' }).note
  const w = rememberFact(notes, { text: 'home city is Porto' })
  expect(w.action).toBe('superseded')
  expect(old.supersededBy).toBe(w.note.id)
})

test('a phrase match inherits the old key so the next change is found by key', () => {
  const notes: Note[] = []
  rememberFact(notes, { text: 'Home city: Lisbon', key: 'home.city' })
  const w = rememberFact(notes, { text: 'home city is Porto' })
  expect(w.note.key).toBe('home.city')
  const next = rememberFact(notes, { text: 'Oslo', key: 'home.city' })
  expect(next.superseded.map(n => n.id)).toEqual([w.note.id])
})

test('re-stating the same value only bumps confirmedAt', () => {
  const notes: Note[] = []
  const first = rememberFact(notes, { text: 'Home city: Lisbon', source: 'telegram' }, ago(300)).note
  const w = rememberFact(notes, { text: 'home city is lisbon', source: 'terminal' }, ago(2))
  expect(w.action).toBe('confirmed')
  expect(w.note).toBe(first)
  expect(notes).toHaveLength(1)
  expect(first.confirmedAt).toBe(ago(2))
  expect(first.createdAt).toBe(ago(300))
  expect(first.source).toBe('telegram')
  expect(first.text).toBe('Home city: Lisbon')
})

test('different keys never collide, whatever the phrase says', () => {
  const notes: Note[] = []
  rememberFact(notes, { text: 'Home city: Lisbon', key: 'home.city' })
  const w = rememberFact(notes, { text: 'Home city: Porto', key: 'partner.home.city' })
  expect(w.action).toBe('created')
  expect(notes.filter(n => n.supersededBy)).toHaveLength(0)
})

test('unrelated facts sit side by side', () => {
  const notes: Note[] = []
  rememberFact(notes, { text: 'Home city: Lisbon' })
  const w = rememberFact(notes, { text: 'School: Northside High' })
  expect(w.action).toBe('created')
  expect(notes.filter(n => n.supersededBy)).toHaveLength(0)
})

test('a superseded fact is not superseded again or reconfirmed', () => {
  const notes: Note[] = []
  const lisbon = rememberFact(notes, { text: 'Lisbon', key: 'home.city' }).note
  const porto = rememberFact(notes, { text: 'Porto', key: 'home.city' }).note
  // Moving back to Lisbon is a new fact replacing Porto, not a revival of the old note.
  const back = rememberFact(notes, { text: 'Lisbon', key: 'home.city' })
  expect(back.action).toBe('superseded')
  expect(back.note).not.toBe(lisbon)
  expect(lisbon.supersededBy).toBe(porto.id)
  expect(porto.supersededBy).toBe(back.note.id)
})

test('facts written before this existed are matched and backfill from createdAt', () => {
  // A note as notes.json held it before: no key, no confirmedAt.
  const legacy: Note = { id: 'aaaa0001', kind: 'fact', text: 'Lives in Lisbon', tags: [], createdAt: ago(250) }
  const notes = [legacy]
  expect(factAgeNote(legacy, NOW)).toBe(' (said 8 months ago, may have changed)')
  const w = rememberFact(notes, { text: 'Lives in Porto' })
  expect(w.action).toBe('superseded')
  expect(legacy.supersededBy).toBe(w.note.id)
})

test('loops are never reconciled as facts', () => {
  const notes: Note[] = []
  upsertNote(notes, { kind: 'loop', text: 'School: send the form' })
  const w = rememberFact(notes, { text: 'School: Northside High' })
  expect(w.action).toBe('created')
  expect(notes[0].supersededBy).toBeUndefined()
})

test('rewriting a fact by id counts as saying it again', () => {
  const notes: Note[] = []
  const n = rememberFact(notes, { text: 'School: Northside' }, ago(400)).note
  upsertNote(notes, { id: n.id, text: 'School: Northside High' })
  expect(Date.parse(n.confirmedAt!)).toBeGreaterThan(Date.parse(ago(1)))
})

// ---------------------------------------------------------------------------
// Read: search and age notes
// ---------------------------------------------------------------------------

test('search hides superseded facts unless asked', () => {
  const notes: Note[] = []
  rememberFact(notes, { text: 'Home city: Lisbon', key: 'home.city' })
  rememberFact(notes, { text: 'Home city: Porto', key: 'home.city' })
  expect(searchNotes(notes, { query: 'city' }).map(n => n.text)).toEqual(['Home city: Porto'])
  expect(searchNotes(notes, { query: 'city', includeSuperseded: true })).toHaveLength(2)
  expect(searchNotes(notes, { kind: 'fact' })).toHaveLength(1)
})

test('search finds a fact by its key', () => {
  const notes: Note[] = []
  rememberFact(notes, { text: 'Porto', key: 'home.city' })
  expect(searchNotes(notes, { query: 'home.city' })).toHaveLength(1)
})

test('formatNote shows key, source and supersession', () => {
  const notes: Note[] = []
  const old = rememberFact(notes, { text: 'Lisbon', key: 'home.city', source: 'telegram' }).note
  rememberFact(notes, { text: 'Porto', key: 'home.city', source: 'email:abc123' })
  expect(formatNote(old)).toContain('{home.city}')
  expect(formatNote(old)).toContain('(via telegram)')
  expect(formatNote(old)).toContain(`(superseded by ${old.supersededBy})`)
})

test('volatile subjects are recognised in text or key', () => {
  expect(isVolatile({ text: 'Lives in Porto' })).toBe(true)
  expect(isVolatile({ text: 'Phone: +00 000 000' })).toBe(true)
  expect(isVolatile({ text: 'Porto', key: 'home.city' })).toBe(true)
  expect(isVolatile({ text: 'Northside High', key: 'school' })).toBe(true)
  expect(isVolatile({ text: 'Allergic to penicillin' })).toBe(false)
})

test('an old volatile fact gets an age note, a fresh one or a stable one does not', () => {
  const notes: Note[] = []
  const city = rememberFact(notes, { text: 'Lives in Lisbon' }, ago(213)).note
  const fresh = rememberFact(notes, { text: 'Works at Acme' }, ago(30)).note
  const stable = rememberFact(notes, { text: 'Allergic to penicillin' }, ago(900)).note
  expect(factAgeNote(city, NOW)).toBe(' (said 7 months ago, may have changed)')
  expect(factAgeNote(fresh, NOW)).toBe('')
  expect(factAgeNote(stable, NOW)).toBe('')
})

test('reconfirming resets the age', () => {
  const notes: Note[] = []
  const n = rememberFact(notes, { text: 'Lives in Lisbon' }, ago(400)).note
  expect(factAgeNote(n, NOW)).not.toBe('')
  rememberFact(notes, { text: 'lives in Lisbon' }, ago(1))
  expect(factAgeNote(n, NOW)).toBe('')
})

test('the threshold comes from config', () => {
  const notes: Note[] = []
  const n = rememberFact(notes, { text: 'Lives in Lisbon' }, ago(40)).note
  expect(factAgeNote(n, NOW, 30)).toBe(' (said 40 days ago, may have changed)')
  expect(factAgeNote(n, NOW)).toBe('')
})

test('loops never get an age note', () => {
  const { note } = upsertNote([], { kind: 'loop', text: 'call the school' })
  note.createdAt = ago(400)
  expect(factAgeNote(note, NOW)).toBe('')
})

test('ages read like a person would say them', () => {
  expect(humanAge(1 * DAY)).toBe('1 day')
  expect(humanAge(45 * DAY)).toBe('45 days')
  expect(humanAge(213 * DAY)).toBe('7 months')
  expect(humanAge(800 * DAY)).toBe('2 years')
})

test('staleness.days falls back to the default when unusable', () => {
  expect(resolveStaleDays(undefined)).toBe(DEFAULT_STALE_DAYS)
  expect(resolveStaleDays({})).toBe(180)
  expect(resolveStaleDays({ days: -4 })).toBe(180)
  expect(resolveStaleDays({ days: 'soon' })).toBe(180)
  expect(resolveStaleDays({ days: 90 })).toBe(90)
})
