/**
 * Who the user actually talks to.
 *
 * Otto meets "Jony" for the first time on every wake: no idea whether that is a
 * client of two years or a stranger, no idea what timezone the answer will be
 * read in, no idea what the user already explained about them last month. So it either
 * says nothing or says something generic, and both are what an assistant with no
 * memory of people sounds like.
 *
 * One record per human, and the source is the user. `recordPerson` folds in what they
 * say — who someone is to them, where they are, what matters about them — and
 * `describePerson` reads it back. Nothing here mines a mailbox for names: an
 * address book assembled by scraping is mostly senders the user never chose to know,
 * and the ones they did choose are exactly the ones they will tell you about.
 *
 * Three things are not obvious and are the reason the file is worth having.
 *
 *   A stated fact displaces its predecessor but does not erase it. People change
 *   jobs and cities, so the newest value is the answer; the old one stays as a
 *   dated note, because "he was at Acme" is precisely what the user will expect to
 *   still be there a year later.
 *
 *   A timezone is stored as an IANA zone and resolved to an offset at the moment
 *   of asking, never cached as a number — Europe/Berlin is +60 in January and +120
 *   in July, and that is the difference between catching someone and waking them.
 *
 *   Cadence drift is measured against each person's own rhythm, never a global
 *   one. Silence of three weeks is nothing from someone contacted twice a year
 *   and a real signal from someone contacted every Monday. 2.5x their own median
 *   gap is the threshold; anything absolute would flag the whole address book at
 *   once.
 *
 * The message-shaped inputs below (`ingestMessage`, the Date-header and
 * signature parsing it leans on) predate that decision and are no longer wired
 * to the mail scan. `ingestAttendees` still runs, on the calendar snapshot the
 * server already holds — a meeting the user sat in is contact they chose.
 *
 * Nothing here decides to send anything. It answers "who is this and is
 * something off", and the judgement about whether that is worth a message stays
 * with the session.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type Direction = 'in' | 'out'

/** Something the user said about a person, kept in their words and dated. */
export type Note = { at: string; text: string }

export type Person = {
  /** Slug: the primary address, or a slugged name for someone only mentioned. */
  id: string
  name?: string
  /** Lowercased. The first is the primary. */
  addresses: string[]
  /** Display names seen on the wire — "Jony", "Jonathan R.", "J. Rossi". */
  aliases: string[]
  /** Digits, `+` kept when it was given. */
  phones?: string[]
  /** Telegram/iMessage handles, lowercased, no leading @. */
  handles?: string[]
  /** From a signature block if one gave it, else the mail domain. Never invented. */
  org?: string
  city?: string
  /** IANA zone, only when something actually said so. */
  timezone?: string
  /** How the user knows them, in the user's own words: "lawyer in Munich". */
  relationship?: string
  /** Recent UTC offsets in minutes, newest last. Sampled, not averaged. */
  offsetSamples: number[]
  inbound: { first?: string; last?: string; count: number }
  outbound: { first?: string; last?: string; count: number }
  /** ISO timestamps of every contact either way, capped, oldest first. */
  contacts: string[]
  /** What the user has said about them, oldest first. */
  notes?: Note[]
  /** Times the user named them without any message involved. */
  mentions?: number
  updatedAt: string
}

/** Enough history to see a rhythm; short enough that a rhythm that changed a
 * year ago does not outvote this month. */
const MAX_CONTACTS = 60
const MAX_OFFSET_SAMPLES = 12
/** Long enough to hold everything said about someone the user talks about
 * weekly for a year, short enough that the record stays readable in one screen. */
const MAX_NOTES = 40

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

export type ParsedAddress = { name?: string; email: string }

/** "Marco Rossi <m@x.com>", "<m@x.com>", "m@x.com", `"Rossi, Marco" <m@x.com>`. */
export function parseAddress(raw: string): ParsedAddress | undefined {
  const s = raw.trim()
  if (!s) return undefined
  const angled = /^(.*?)<([^>]+)>\s*$/.exec(s)
  const email = normalizeEmail(angled ? angled[2] : s)
  if (!email) return undefined
  const name = angled ? angled[1].trim().replace(/^["']|["']$/g, '').trim() : ''
  return { ...(name ? { name } : {}), email }
}

/**
 * Lowercase, and drop the +tag.
 *
 * Plus-addressing is the same mailbox by definition, so merging is correct.
 * Gmail's dot-insensitivity is NOT applied: it is true only on gmail.com, and
 * stripping dots everywhere would merge two different people at a company that
 * uses first.last@ addresses.
 */
export function normalizeEmail(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/^mailto:/, '')
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(s)
  if (!m) return ''
  return `${m[1].split('+')[0]}@${m[2].replace(/\.$/, '')}`
}

/**
 * Digits only, keeping a leading `+`.
 *
 * No country code is inferred. "5551234567" written by someone in one country and the
 * same digits written by someone in Brazil are different phones, and guessing
 * which from where the user happens to be standing would merge two strangers.
 */
export function normalizePhone(raw: string): string {
  const s = raw.trim().replace(/[^\d+]/g, '')
  const plus = s.startsWith('+')
  const digits = s.replace(/\D/g, '')
  if (digits.length < 6 || digits.length > 15) return ''
  return plus ? `+${digits}` : digits
}

/** `@Jony`, `Jony` and `jony` are one handle. */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase()
}

const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.it', 'yahoo.com.br', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'uol.com.br', 'bol.com.br',
  'terra.com.br', 'libero.it', 'tiscali.it', 'virgilio.it',
])

/**
 * The mail domain, when it means something.
 *
 * A domain is a weaker fact than a signature block and is returned as the
 * domain, not as a guessed company name: "acme-consulting.it" is what is known,
 * and turning that into "Acme Consulting" is invention.
 */
export function orgFromDomain(email: string): string | undefined {
  const domain = email.split('@')[1]
  if (!domain || FREEMAIL.has(domain)) return undefined
  return domain
}

const LEGAL_SUFFIX = /\b(S\.?p\.?A\.?|S\.?r\.?l\.?|S\.?A\.?S\.?|Ltda\.?|LLC|L\.L\.C\.|Inc\.?|GmbH|AG|Ltd\.?|B\.?V\.?|Oy|AB|PLC|Pty|LDA)\b/
const TITLE_LINE = /^\s*(?:[A-Z][\w.]*\s+){0,3}(?:CEO|CTO|CFO|COO|Founder|Co-?founder|Director|Manager|Engineer|Designer|Partner|Head|Lead|President|Advogad[oa]|Avvocato)\b[^,|·]*[,|·]\s*(.+?)\s*$/i

/**
 * Org out of a signature block.
 *
 * Only the tail of the message is considered — a company name in the body is
 * usually someone else's employer. Two shapes are recognised and nothing is
 * inferred beyond them: a legal suffix (the strongest possible signal that a
 * line names a company) and "Title, Company", which is how almost every
 * signature that lacks a suffix is written.
 */
export function orgFromSignature(body: string): string | undefined {
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean)
  const sigStart = lines.findIndex(l => /^--\s*$/.test(l))
  const tail = sigStart >= 0 ? lines.slice(sigStart + 1) : lines.slice(-10)

  for (const line of tail) {
    if (line.length > 80 || /@|https?:\/\/|\+\d|\bwww\./i.test(line)) continue
    // A signature line is a label, not a sentence. Six words is comfortably
    // above the longest real company line and well below prose — without it,
    // "We are pitching to Globex Inc next week" becomes the user’s employer.
    if (line.split(/\s+/).length > 6) continue
    if (LEGAL_SUFFIX.test(line)) return line.replace(/[|·].*$/, '').trim()
  }
  for (const line of tail) {
    const m = TITLE_LINE.exec(line)
    if (m && m[1].length <= 60 && !/@|https?:\/\//.test(m[1])) return m[1].trim()
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Date headers
// ---------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * An RFC 5322 Date header, kept in two pieces.
 *
 * `Date.parse` gets the instant right and throws the offset away, and the
 * offset is the interesting half: it says what the clock on the sender's wall
 * read. "-0300" is a person in Brazil regardless of what UTC thought.
 */
export function parseDateHeader(raw: string): { at: string; offsetMinutes?: number } | undefined {
  const s = raw.trim()
  if (!s) return undefined
  const at = Date.parse(s)
  if (Number.isNaN(at)) return undefined

  const num = /([+-])(\d{2})(\d{2})\s*(?:\([A-Z]+\))?\s*$/.exec(s)
  if (num) {
    const sign = num[1] === '-' ? -1 : 1
    return { at: new Date(at).toISOString(), offsetMinutes: sign * (Number(num[2]) * 60 + Number(num[3])) }
  }
  const iso = /([+-])(\d{2}):(\d{2})$/.exec(s)
  if (iso) {
    const sign = iso[1] === '-' ? -1 : 1
    return { at: new Date(at).toISOString(), offsetMinutes: sign * (Number(iso[2]) * 60 + Number(iso[3])) }
  }
  // Trailing Z, "GMT", or no zone at all: an instant with no wall clock behind
  // it. Better to have no offset than a wrong one.
  return { at: new Date(at).toISOString() }
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '−' : '+'
  const abs = Math.abs(minutes)
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/** The offset seen most often, ties going to the most recent. One email sent
 * from a layover must not move someone to another continent. */
export function dominantOffset(samples: number[]): number | undefined {
  if (!samples.length) return undefined
  const counts = new Map<number, number>()
  for (const s of samples) counts.set(s, (counts.get(s) ?? 0) + 1)
  let best = samples[samples.length - 1]
  let bestCount = 0
  for (const [value, count] of counts) {
    const recency = samples.lastIndexOf(value)
    const bestRecency = samples.lastIndexOf(best)
    if (count > bestCount || (count === bestCount && recency > bestRecency)) {
      best = value
      bestCount = count
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Building the graph
// ---------------------------------------------------------------------------

export function personId(email: string): string {
  return email.toLowerCase()
}

export function slugName(name: string): string {
  return `name:${name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`
}

/**
 * Whether two names are the same person said at two lengths.
 *
 * The user says "Marco Rossi" once and "Marco" for the next year, so an exact
 * match alone files them as two people. A shorter name matches a longer one only
 * at a word boundary: "Marco" is "Marco Rossi", "Marc" is not, and "Marco Rossi"
 * is not "Marco Bianchi".
 */
function namesAgree(a: string, b: string): boolean {
  const x = a.trim().toLowerCase().replace(/\s+/g, ' ')
  const y = b.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!x || !y) return false
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return long.startsWith(short + ' ')
}

/**
 * Everyone the key could mean, exact matches first.
 *
 * An address is unambiguous and returns at most one. A name can return several,
 * and the caller has to decide what to do about that — guessing which Marco was
 * meant is how a graph quietly attributes one person's facts to another.
 */
export function matchPeople(people: Person[], key: string): Person[] {
  const email = normalizeEmail(key)
  if (email) return people.filter(p => p.addresses.includes(email))

  const needle = key.trim().toLowerCase()
  if (!needle) return []
  const exact = people.filter(p =>
    p.id === slugName(needle) ||
    p.name?.toLowerCase() === needle ||
    p.aliases.some(a => a.toLowerCase() === needle))
  if (exact.length) return exact

  return people.filter(p =>
    (p.name && namesAgree(p.name, needle)) ||
    p.aliases.some(a => namesAgree(a, needle)))
}

/** The person a key means, when it means exactly one. */
export function findPerson(people: Person[], key: string): Person | undefined {
  const hits = matchPeople(people, key)
  return hits.length === 1 ? hits[0] : undefined
}

function blank(id: string): Person {
  return {
    id,
    addresses: [],
    aliases: [],
    offsetSamples: [],
    inbound: { count: 0 },
    outbound: { count: 0 },
    contacts: [],
    updatedAt: new Date().toISOString(),
  }
}

function pushContact(p: Person, iso: string): void {
  if (p.contacts.includes(iso)) return
  p.contacts.push(iso)
  p.contacts.sort()
  if (p.contacts.length > MAX_CONTACTS) p.contacts.splice(0, p.contacts.length - MAX_CONTACTS)
}

function noteAlias(p: Person, name?: string): void {
  if (!name) return
  const clean = name.replace(/\s+/g, ' ').trim()
  if (!clean || clean.includes('@')) return
  if (!p.aliases.includes(clean)) p.aliases.push(clean)
  // The longest alias is usually the full name; the shortest is what the user calls
  // them. Keep the longest as the record's name and let callers pick.
  if (!p.name || clean.length > p.name.length) p.name = clean
}

export type MessageObservation = {
  direction: Direction
  /** Raw From header. */
  from: string
  /** Raw To/Cc headers, one entry per address. */
  to?: string[]
  cc?: string[]
  /** Raw Date header, RFC 5322 or ISO. */
  date: string
  /** Body, for the signature block. Only read on inbound mail. */
  body?: string
}

/**
 * Fold one message into the graph.
 *
 * The direction decides whose timezone the Date header describes, and getting
 * this backwards would put every one of their contacts in the user’s own zone: on
 * outbound mail the header is HIS clock, so recipients learn nothing about
 * where they are, only that they were contacted.
 */
export function ingestMessage(people: Person[], msg: MessageObservation): Person[] {
  const parsed = parseDateHeader(msg.date)
  if (!parsed) return people
  const { at, offsetMinutes } = parsed

  const from = parseAddress(msg.from)
  const recipients = [...(msg.to ?? []), ...(msg.cc ?? [])]
    .map(parseAddress)
    .filter((a): a is ParsedAddress => Boolean(a))

  if (msg.direction === 'in') {
    if (!from) return people
    const p = upsertPerson(people, from)
    p.inbound.first ??= at
    p.inbound.last = at
    p.inbound.count++
    if (offsetMinutes !== undefined) {
      p.offsetSamples.push(offsetMinutes)
      if (p.offsetSamples.length > MAX_OFFSET_SAMPLES) p.offsetSamples.shift()
    }
    if (!p.org && msg.body) p.org = orgFromSignature(msg.body) ?? orgFromDomain(from.email)
    pushContact(p, at)
    p.updatedAt = new Date().toISOString()
    // Everyone else on an inbound thread is a real address the user is in contact
    // with, but nothing about their own clock is knowable from it.
    for (const r of recipients) {
      const other = upsertPerson(people, r)
      if (other !== p) { pushContact(other, at); other.updatedAt = new Date().toISOString() }
    }
    return people
  }

  for (const r of recipients) {
    const p = upsertPerson(people, r)
    p.outbound.first ??= at
    p.outbound.last = at
    p.outbound.count++
    pushContact(p, at)
    p.updatedAt = new Date().toISOString()
  }
  return people
}

function upsertPerson(people: Person[], addr: ParsedAddress): Person {
  let p = people.find(x => x.addresses.includes(addr.email))
  if (!p && addr.name) {
    // A known name arriving from a new address is the same person under a
    // second mailbox far more often than it is a stranger with the same name.
    const byName = people.find(x => x.name?.toLowerCase() === addr.name!.toLowerCase() && x.addresses.length > 0)
    if (byName) p = byName
  }
  if (!p) {
    const nameOnly = addr.name ? people.find(x => x.id === slugName(addr.name!)) : undefined
    if (nameOnly) {
      // The user mentioned them before their first email arrived; give the record its
      // real identity now rather than keeping two.
      nameOnly.id = personId(addr.email)
      p = nameOnly
    }
  }
  if (!p) {
    p = blank(personId(addr.email))
    people.push(p)
  }
  if (!p.addresses.includes(addr.email)) p.addresses.push(addr.email)
  noteAlias(p, addr.name)
  return p
}

export type AttendeeObservation = {
  email?: string
  displayName?: string
  /** ISO start of the event — when the contact actually happened. */
  at: string
  self?: boolean
  resource?: boolean
}

/** Calendar attendees. A shared meeting is contact; it just has no direction. */
export function ingestAttendees(people: Person[], attendees: AttendeeObservation[]): Person[] {
  for (const a of attendees) {
    if (a.self || a.resource) continue
    const email = normalizeEmail(a.email ?? '')
    if (!email) continue
    const p = upsertPerson(people, { email, ...(a.displayName ? { name: a.displayName } : {}) })
    const at = Date.parse(a.at)
    if (!Number.isNaN(at)) pushContact(p, new Date(at).toISOString())
    p.updatedAt = new Date().toISOString()
  }
  return people
}

/**
 * A name the user said out loud, with no address attached.
 *
 * Kept because the useful question is usually asked before the first email:
 * "who is Marco" should not come back empty just because the only record of the user
 * is that the user has been mentioned nine times in three weeks.
 */
export function mentionPerson(people: Person[], name: string, at = new Date().toISOString()): Person {
  const clean = name.replace(/\s+/g, ' ').trim()
  const existing = findPerson(people, clean)
  const p = existing ?? blank(slugName(clean))
  if (!existing) people.push(p)
  noteAlias(p, clean)
  p.mentions = (p.mentions ?? 0) + 1
  p.updatedAt = at
  return p
}

// ---------------------------------------------------------------------------
// What the user said
// ---------------------------------------------------------------------------

/**
 * Facts about a person as the user stated them.
 *
 * Every field is optional and none is derived from anything: this is the path
 * for "Marco is my lawyer in Munich, he's the one handling the visa". At least
 * one identifying field — name, email, phone or handle — has to be present, or
 * there is nobody to attach the rest to.
 */
export type StatedFacts = {
  name?: string
  email?: string
  phone?: string
  handle?: string
  relationship?: string
  org?: string
  city?: string
  /** IANA zone. Only when the user said where they are, never guessed from a domain. */
  timezone?: string
  /** One thing worth keeping, in the user's words. */
  note?: string
  /** When it was said. Defaults to now. */
  at?: string
}

function pushNote(p: Person, at: string, text: string): void {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return
  p.notes ??= []
  if (p.notes.some(n => n.text === clean)) return
  p.notes.push({ at, text: clean })
  if (p.notes.length > MAX_NOTES) p.notes.splice(0, p.notes.length - MAX_NOTES)
}

function pushUnique(list: string[] | undefined, value: string): string[] | undefined {
  if (!value) return list
  const out = list ?? []
  if (!out.includes(value)) out.push(value)
  return out
}

/**
 * Set a stated field, remembering what it displaced.
 *
 * The user is the authority, so a new value wins outright — people change jobs
 * and cities and the current answer is the one that should come back. But
 * "he was at Acme" is exactly the kind of thing the user will expect to still be
 * there a year later, so the old value survives as a note rather than being
 * overwritten into nothing.
 */
function stateScalar(
  p: Person,
  key: 'relationship' | 'org' | 'city' | 'timezone',
  value: string | undefined,
  at: string,
): void {
  const v = value?.replace(/\s+/g, ' ').trim()
  if (!v || p[key] === v) return
  if (p[key]) pushNote(p, at, `${key} was ${p[key]}`)
  p[key] = v
}

/**
 * Fold something the user said into the record.
 *
 * Identity is resolved strongest-first — address, then handle, then phone, then
 * name — because a name is the only one of the four that two people can share.
 * A record that existed under a name gets promoted to its address the moment one
 * is given, so the mentions already collected are not stranded on a second copy.
 */
export function recordPerson(people: Person[], f: StatedFacts): Person {
  const at = f.at ?? new Date().toISOString()
  const email = normalizeEmail(f.email ?? '')
  const phone = normalizePhone(f.phone ?? '')
  const handle = normalizeHandle(f.handle ?? '')
  const name = f.name?.replace(/\s+/g, ' ').trim() ?? ''
  if (!email && !phone && !handle && !name) {
    throw new Error('recordPerson needs a name, email, phone or handle')
  }

  let p =
    (email ? people.find(x => x.addresses.includes(email)) : undefined) ??
    (handle ? people.find(x => x.handles?.includes(handle)) : undefined) ??
    (phone ? people.find(x => x.phones?.includes(phone)) : undefined)

  if (!p && name) {
    const hits = matchPeople(people, name)
    // Two people answer to this name, so there is no safe merge and no safe new
    // record either — a third Marco would just make it worse. Say so and let the
    // session ask which one, the way an assistant who knew them both would.
    if (hits.length > 1) {
      throw new Error(`more than one ${name}: ${hits.map(displayName).join(', ')} — say which`)
    }
    p = hits[0]
  }

  if (!p) {
    p = blank(email ? personId(email) : name ? slugName(name) : handle ? `handle:${handle}` : `phone:${phone}`)
    people.push(p)
  } else if (email && !p.addresses.includes(email) && p.id.startsWith('name:')) {
    p.id = personId(email)
  }

  if (email && !p.addresses.includes(email)) p.addresses.push(email)
  p.phones = pushUnique(p.phones, phone)
  p.handles = pushUnique(p.handles, handle)
  noteAlias(p, name)

  stateScalar(p, 'relationship', f.relationship, at)
  stateScalar(p, 'org', f.org, at)
  stateScalar(p, 'city', f.city, at)
  stateScalar(p, 'timezone', f.timezone, at)
  if (f.note) pushNote(p, at, f.note)

  p.updatedAt = at
  return p
}

// ---------------------------------------------------------------------------
// Rhythm
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

export function medianGapDays(contacts: string[]): number | undefined {
  const times = contacts.map(c => Date.parse(c)).filter(t => !Number.isNaN(t)).sort((a, b) => a - b)
  if (times.length < 2) return undefined
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / DAY_MS)
  gaps.sort((a, b) => a - b)
  const mid = gaps.length >> 1
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2
}

export function lastContactAt(p: Person): number | undefined {
  const times = p.contacts.map(c => Date.parse(c)).filter(t => !Number.isNaN(t))
  return times.length ? Math.max(...times) : undefined
}

export type Drift = {
  person: Person
  silentDays: number
  medianDays: number
  ratio: number
}

/**
 * People who have gone quiet by their own standards.
 *
 * Guards, all of them learned from what a naive version would surface: a
 * minimum history, so two coincidental emails do not define a rhythm; a
 * minimum gap, so a daily correspondent is not "overdue" by lunchtime; and a
 * floor on the silence itself, so a person the user mails hourly does not appear
 * every afternoon.
 */
export function cadenceDrift(
  people: Person[],
  now: number,
  o: { factor?: number; minContacts?: number; minMedianDays?: number; minSilentDays?: number } = {},
): Drift[] {
  const factor = o.factor ?? 2.5
  const minContacts = o.minContacts ?? 4
  const minMedianDays = o.minMedianDays ?? 1
  const minSilentDays = o.minSilentDays ?? 7

  const out: Drift[] = []
  for (const person of people) {
    if (person.contacts.length < minContacts) continue
    const median = medianGapDays(person.contacts)
    if (median === undefined || median < minMedianDays) continue
    const last = lastContactAt(person)
    if (last === undefined) continue
    const silentDays = (now - last) / DAY_MS
    if (silentDays < minSilentDays) continue
    const ratio = silentDays / median
    if (ratio < factor) continue
    out.push({ person, silentDays, medianDays: median, ratio })
  }
  return out.sort((a, b) => b.ratio - a.ratio)
}

// ---------------------------------------------------------------------------
// Good hour to call
// ---------------------------------------------------------------------------

export type CallWindow = {
  theirStart: string
  theirEnd: string
  yourStart: string
  yourEnd: string
  /** Length of the overlap in minutes. */
  minutes: number
}

function hhmm(minutesOfDay: number): string {
  const m = ((minutesOfDay % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/**
 * When both of them are awake.
 *
 * Both working days are projected onto UTC and intersected. The day is tried
 * shifted by ±24h because an offset spread wide enough — Berlin and Buenos Aires is
 * five hours, Berlin and Auckland is ten — puts the two windows on different UTC
 * days even though they overlap perfectly well in real life.
 *
 * No overlap returns null. "There is no good hour, pick a bad one" is a real
 * answer and much more useful than a window neither of them is awake for.
 */
export function callWindow(
  theirOffsetMinutes: number,
  yourOffsetMinutes: number,
  o: { theirDay?: [number, number]; yourDay?: [number, number] } = {},
): CallWindow | null {
  const [ts, te] = o.theirDay ?? [9 * 60, 18 * 60]
  const [ys, ye] = o.yourDay ?? [9 * 60, 18 * 60]
  const yourUtc: [number, number] = [ys - yourOffsetMinutes, ye - yourOffsetMinutes]

  let best: { start: number; end: number } | null = null
  for (const shift of [-1440, 0, 1440]) {
    const theirUtc: [number, number] = [ts - theirOffsetMinutes + shift, te - theirOffsetMinutes + shift]
    const start = Math.max(theirUtc[0], yourUtc[0])
    const end = Math.min(theirUtc[1], yourUtc[1])
    if (end - start > 0 && (!best || end - start > best.end - best.start)) best = { start, end }
  }
  if (!best) return null

  return {
    theirStart: hhmm(best.start + theirOffsetMinutes),
    theirEnd: hhmm(best.end + theirOffsetMinutes),
    yourStart: hhmm(best.start + yourOffsetMinutes),
    yourEnd: hhmm(best.end + yourOffsetMinutes),
    minutes: best.end - best.start,
  }
}

/**
 * What a zone's clock reads right now, in minutes off UTC.
 *
 * Computed for a moment rather than stored, because "Europe/Berlin" is +60 in
 * January and +120 in July — a number cached in March is wrong by April. An
 * unrecognised zone returns undefined rather than 0, which would silently claim
 * the person sits in Greenwich.
 */
export function offsetForZone(zone: string, at: Date = new Date()): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at)
    const f = Object.fromEntries(parts.map(p => [p.type, p.value])) as Record<string, string>
    const wall = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour % 24, +f.minute, +f.second)
    return Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000)
  } catch {
    return undefined
  }
}

/**
 * The call window for a person.
 *
 * A stated zone beats observed offsets: the user saying "she's in Buenos Aires" is a
 * fact, and a sampled offset is an inference from where someone happened to be
 * sitting. Offsets are the fallback for people who were never placed.
 */
export function goodHourToCall(p: Person, yourOffsetMinutes: number, at: Date = new Date()): CallWindow | null {
  const theirs = (p.timezone ? offsetForZone(p.timezone, at) : undefined) ?? dominantOffset(p.offsetSamples)
  if (theirs === undefined) return null
  return callWindow(theirs, yourOffsetMinutes)
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function displayName(p: Person): string {
  return p.name ?? p.addresses[0] ?? p.handles?.[0] ?? p.phones?.[0] ?? p.id
}

export function formatPerson(p: Person, now = Date.now()): string {
  const bits: string[] = [displayName(p)]
  if (p.relationship) bits.push(p.relationship)
  if (p.org) bits.push(p.org)
  if (p.city) bits.push(p.city)
  const offset = p.timezone ? offsetForZone(p.timezone, new Date(now)) : dominantOffset(p.offsetSamples)
  if (offset !== undefined) bits.push(formatOffset(offset))
  if (p.inbound.count || p.outbound.count) bits.push(`${p.inbound.count} in / ${p.outbound.count} out`)
  const last = lastContactAt(p)
  if (last !== undefined) bits.push(`last ${Math.round((now - last) / DAY_MS)}d ago`)
  const median = medianGapDays(p.contacts)
  if (median !== undefined) bits.push(`usually every ${median < 1 ? '<1' : Math.round(median)}d`)
  return bits.join(' · ')
}

/**
 * Everything known about one person.
 *
 * The notes are the point and they come last, newest first, because the useful
 * answer to "who is Marco" is usually the most recent thing the user said about him
 * rather than his address. An empty record still prints its headline, so
 * "mentioned three times, nothing else known" is a visible answer instead of an
 * error.
 */
export function describePerson(
  p: Person,
  o: { now?: number; yourOffsetMinutes?: number; maxNotes?: number } = {},
): string {
  const now = o.now ?? Date.now()
  const lines: string[] = [formatPerson(p, now)]

  const reach = [...p.addresses, ...(p.phones ?? []), ...(p.handles ?? []).map(h => `@${h}`)]
  if (reach.length) lines.push(reach.join(', '))

  if (p.timezone) {
    const offset = offsetForZone(p.timezone, new Date(now))
    lines.push(`${p.timezone}${offset === undefined ? '' : ` (${formatOffset(offset)} now)`}`)
  }

  if (o.yourOffsetMinutes !== undefined) {
    const w = goodHourToCall(p, o.yourOffsetMinutes, new Date(now))
    lines.push(w
      ? `good hour to call: their ${w.theirStart}–${w.theirEnd}, your ${w.yourStart}–${w.yourEnd}`
      : p.timezone || p.offsetSamples.length
        ? 'no hour when you are both at your desks'
        : 'no timezone on record — ask where they are')
  }

  if (p.mentions) lines.push(`mentioned ${p.mentions}x`)

  const notes = (p.notes ?? []).slice(-(o.maxNotes ?? 8)).reverse()
  for (const n of notes) lines.push(`${n.at.slice(0, 10)}  ${n.text}`)

  return lines.join('\n')
}

export function formatDrift(d: Drift): string {
  const who = displayName(d.person)
  return `${who}: silent ${Math.round(d.silentDays)}d, normally every ${Math.round(d.medianDays)}d (${d.ratio.toFixed(1)}x)`
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function loadPeople(file: string): Person[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as Person[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: people.json corrupt, moved aside.\n')
    }
    return []
  }
}

export function savePeople(file: string, people: Person[]): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(people, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export const PEOPLE_FILE = join(
  process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'),
  'people.json',
)
