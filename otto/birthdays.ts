/**
 * Birthday runway.
 *
 * A birthday is the one date about a person that is fixed, known in advance and
 * still routinely missed, and the miss is always the same shape: it surfaces on
 * the day, at 22:00, when the only thing left to send is a late text. Three days
 * out is when a nudge is worth having — enough time to post something, book a
 * table, or at least put it on the calendar.
 *
 * So each birthday gets exactly one interruption a year, `leadDays` ahead, and
 * on the day itself it sits in the brief instead of buzzing again. The second
 * mention would be the nag; the brief is where the session already looks.
 *
 * Three rules that are not obvious:
 *
 *   "Three days away" is counted in the person's own calendar. Someone in Tokyo
 *   has their birthday a night earlier than the user in Buenos Aires does, and the
 *   day that matters is theirs. Only when nobody placed them does the user's own
 *   zone stand in.
 *
 *   Feb 29 is Feb 28 in a common year — the convention most people born on it
 *   actually keep, and the one that never lets the day silently not happen.
 *
 *   The birthday is stored as the user said it: "03-14" stays yearless and no
 *   age is ever printed for it. A year is only known when they gave one.
 *
 * Nothing here reads mail. A birthday comes from `note_contact`, which is the
 * user talking; a "happy birthday!" in someone's inbox is a stranger's data.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type Birthday = { month: number; day: number; year?: number }

/** A calendar day, with no zone attached: whatever a wall calendar reads. */
export type Ymd = { year: number; month: number; day: number }

export const DEFAULT_LEAD_DAYS = 3

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * "MM-DD" or "YYYY-MM-DD", and nothing looser.
 *
 * "03/04" is March or April depending on which continent wrote it, so the
 * session normalises what the user said into one of these two shapes and this
 * refuses everything else rather than guess. A yearless Feb 29 is valid; a
 * Feb 29 in a year that had none is a typo and is refused.
 */
export function parseBirthday(raw: string): Birthday | undefined {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(raw.trim())
  if (!m) return undefined
  const year = m[1] ? Number(m[1]) : undefined
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1) return undefined
  // A yearless date is checked against a leap year so Feb 29 survives.
  if (day > daysInMonth(year ?? 2000, month)) return undefined
  if (year !== undefined && (year < 1900 || year > 2100)) return undefined
  return { month, day, ...(year !== undefined ? { year } : {}) }
}

/** Where the birthday falls in a given year: Feb 29 lands on Feb 28 in a common one. */
export function birthdayInYear(b: Birthday, year: number): Ymd {
  if (b.month === 2 && b.day === 29 && !isLeap(year)) return { year, month: 2, day: 28 }
  return { year, month: b.month, day: b.day }
}

/**
 * What the wall calendar reads in a zone at a moment.
 *
 * An unrecognised zone returns undefined rather than falling back to UTC, so
 * the caller can choose the user's zone instead — UTC is nobody's calendar.
 */
export function localDate(zone: string, at: Date): Ymd | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(at)
    const f = Object.fromEntries(parts.map(p => [p.type, p.value])) as Record<string, string>
    return { year: +f.year, month: +f.month, day: +f.day }
  } catch {
    return undefined
  }
}

function dayNumber(d: Ymd): number {
  return Date.UTC(d.year, d.month - 1, d.day) / 86_400_000
}

export type NextBirthday = {
  /** The day it next falls, on or after today. */
  on: Ymd
  /** 0 on the day itself. */
  days: number
  /** The age they turn on `on`, only when the year is known. */
  turns?: number
}

/** The next occurrence on or after `today`. */
export function nextBirthday(b: Birthday, today: Ymd): NextBirthday {
  let on = birthdayInYear(b, today.year)
  if (dayNumber(on) < dayNumber(today)) on = birthdayInYear(b, today.year + 1)
  const days = dayNumber(on) - dayNumber(today)
  return { on, days, ...(b.year !== undefined ? { turns: on.year - b.year } : {}) }
}

/** Their age today, only when the year is known. Feb 29 people age on Feb 28 in common years. */
export function ageOn(b: Birthday, today: Ymd): number | undefined {
  if (b.year === undefined) return undefined
  const thisYear = birthdayInYear(b, today.year)
  const had = dayNumber(today) >= dayNumber(thisYear)
  return today.year - b.year - (had ? 0 : 1)
}

export function formatYmd(d: Ymd, o: { weekday?: boolean } = {}): string {
  const base = `${d.day} ${MONTH_NAMES[d.month - 1]}`
  if (!o.weekday) return base
  const wd = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()
  return `${WEEKDAYS[wd]} ${base}`
}

/** For `who`: the date as given, and the age when the year is known. */
export function describeBirthday(raw: string, today: Ymd): string | undefined {
  const b = parseBirthday(raw)
  if (!b) return undefined
  const date = `${b.day} ${MONTH_NAMES[b.month - 1]}${b.year !== undefined ? ` ${b.year}` : ''}`
  const next = nextBirthday(b, today)
  const age = ageOn(b, today)
  const when =
    next.days === 0 ? (age !== undefined ? `${age} today` : 'today')
    : next.days === 1 ? 'tomorrow'
    : next.days <= 30 ? `in ${next.days} days` : ''
  const bits = [age !== undefined && next.days !== 0 ? `age ${age}` : '', when].filter(Boolean)
  return `birthday ${date}${bits.length ? ` (${bits.join(', ')})` : ''}`
}

// ---------------------------------------------------------------------------
// Who is due
// ---------------------------------------------------------------------------

/** The slice of a Person this file reads. Kept structural so people.ts stays the owner. */
export type BirthdayPerson = { id: string; name?: string; birthday?: string; timezone?: string }

export type BirthdayHit<P extends BirthdayPerson = BirthdayPerson> = {
  person: P
  on: Ymd
  days: number
  turns?: number
  /** The zone the days were counted in. */
  zone: string
}

/** Which zone's calendar counts for this person. */
function zoneFor(p: BirthdayPerson, userZone: string, at: Date): { zone: string; today: Ymd } | undefined {
  if (p.timezone) {
    const today = localDate(p.timezone, at)
    if (today) return { zone: p.timezone, today }
  }
  const today = localDate(userZone, at)
  return today ? { zone: userZone, today } : undefined
}

/** Everyone whose next birthday is within `withinDays` (0 = today only), soonest first. */
export function upcomingBirthdays<P extends BirthdayPerson>(
  people: P[],
  at: Date,
  o: { userZone: string; withinDays: number },
): BirthdayHit<P>[] {
  const out: BirthdayHit<P>[] = []
  for (const person of people) {
    if (!person.birthday) continue
    const b = parseBirthday(person.birthday)
    if (!b) continue
    const where = zoneFor(person, o.userZone, at)
    if (!where) continue
    const next = nextBirthday(b, where.today)
    if (next.days > o.withinDays) continue
    out.push({ person, on: next.on, days: next.days, zone: where.zone, ...(next.turns !== undefined ? { turns: next.turns } : {}) })
  }
  return out.sort((a, b) => a.days - b.days)
}

/**
 * The people owed a nudge right now.
 *
 * The window is 1..leadDays rather than exactly leadDays: a machine asleep on
 * the third day out should still say something on the second, and a nudge is
 * still worth it the day before. Day 0 is never a nudge — that day belongs to
 * the brief. Each birthday is spent once per occurrence, keyed by the year it
 * falls in, so a 29 Dec nudge for a 1 Jan birthday is next year's and does not
 * block the one after it. leadDays 0 turns nudges off.
 */
export function birthdaysToNudge<P extends BirthdayPerson>(
  people: P[],
  state: BirthdayState,
  at: Date,
  o: { userZone: string; leadDays: number },
): BirthdayHit<P>[] {
  if (o.leadDays < 1) return []
  return upcomingBirthdays(people, at, { userZone: o.userZone, withinDays: o.leadDays })
    .filter(h => h.days >= 1 && state[h.person.id]?.year !== h.on.year)
}

export function markNudged(state: BirthdayState, id: string, year: number, at = new Date().toISOString()): void {
  state[id] = { year, at }
}

/** Drop records for people who are gone or no longer have a birthday on file. */
export function pruneBirthdayState(state: BirthdayState, liveIds: string[]): boolean {
  const live = new Set(liveIds)
  let changed = false
  for (const id of Object.keys(state)) if (!live.has(id)) { delete state[id]; changed = true }
  return changed
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** callback_data leaves 60 bytes for the instruction. */
const BUTTON_DATA_MAX = 60

function fitButton(make: (name: string) => string, name: string): string {
  for (const candidate of [name, name.split(/\s+/)[0]]) {
    if (Buffer.byteLength(make(candidate), 'utf8') <= BUTTON_DATA_MAX) return make(candidate)
  }
  let n = name.split(/\s+/)[0]
  while (n.length > 1 && Buffer.byteLength(make(n), 'utf8') > BUTTON_DATA_MAX) n = n.slice(0, -1)
  return make(n)
}

export type Nudge = { text: string; buttons: { label: string; data: string }[] }

/**
 * The one message a birthday gets.
 *
 * The buttons carry everything a tap needs days later — name and date — because
 * a tap comes back as a bare instruction with no conversation behind it.
 */
export function formatNudge(h: BirthdayHit, displayName: string): Nudge {
  const when = h.days === 1 ? `tomorrow, ${formatYmd(h.on, { weekday: true })}` : formatYmd(h.on, { weekday: true })
  const turns = h.turns !== undefined ? ` — turns ${h.turns}` : ''
  const date = formatYmd(h.on)
  return {
    text: `${displayName}'s birthday is ${when}${turns}.`,
    buttons: [
      { label: 'remind me on the day', data: fitButton(n => `remind me on ${date}: ${n}'s birthday`, displayName) },
      { label: 'draft a message', data: fitButton(n => `draft a birthday message to ${n}`, displayName) },
    ],
  }
}

/**
 * The brief's line for birthdays that are today, or nothing.
 *
 * Deliberately not a `Label:` line. The watchdog treats a labelled section that
 * used to render and then stops as a source gone dark, and this one is meant to
 * vanish at midnight.
 */
export function formatBirthdayLine<P extends BirthdayPerson>(hits: BirthdayHit<P>[], name: (p: P) => string): string | undefined {
  const today = hits.filter(h => h.days === 0)
  if (!today.length) return undefined
  return `Birthday today — ${today.map(h => `${name(h.person)}${h.turns !== undefined ? ` (${h.turns})` : ''}`).join(', ')}.`
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Person id → the occurrence year already nudged about, and when. */
export type BirthdayState = Record<string, { year: number; at: string }>

export function loadBirthdayState(file: string): BirthdayState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as BirthdayState) : {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: birthdays.json corrupt, moved aside.\n')
    }
    return {}
  }
}

export function saveBirthdayState(file: string, state: BirthdayState): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export const BIRTHDAYS_FILE = join(
  process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'),
  'birthdays.json',
)
