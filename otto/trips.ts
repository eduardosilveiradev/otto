/**
 * A trip, assembled from the mail it arrives in.
 *
 * A trip never turns up as one email. The flight out comes from the airline in
 * March, the hotel from Booking a week later, the return leg after the user decides
 * how long to stay, and the seat assignment the night before. Otto sees four
 * unrelated messages and answers four unrelated questions, so "when do I land"
 * and "when does the hotel stop being free to cancel" are things it can only
 * answer by finding the right email again.
 *
 * This merges the fragments into one object keyed by date range, and the merge
 * is the easy half. The hard half is timezones, which is the reason this file
 * is careful in ways that look excessive:
 *
 *   A flight time without its zone is a bug, not a minor gap. "Lands 14:35" is
 *   a different fact in Berlin and in Buenos Aires, and a booking email that says
 *   14:35 always means local-at-that-airport — which is a zone the email itself
 *   never states. So a time is stored as its local wall clock plus, separately,
 *   the zone if one is known; the UTC instant is derived only when the zone is
 *   known and is simply absent otherwise. Nothing here ever fills in a zone by
 *   assuming the user’s current one; that is precisely how a 09:00 departure becomes a
 *   missed flight.
 *
 *   Airport zones and countries come from a caller-supplied table, not from
 *   this file. A built-in list of "the airports the user uses" would be a guess about
 *   the user, would go stale, and would be wrong silently.
 *
 *   Timezone abbreviations are resolved only when unambiguous. CET and ART mean
 *   one thing; CST means three and BST means two, and picking one of them is a
 *   coin flip dressed as a fact.
 *
 * Everything that cannot be established is left undefined and reported by
 * tripProblems, so the session can ask the user rather than assert something.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { passportProblems, type Doc } from './documents.ts'

// ---------------------------------------------------------------------------
// Zoned times
// ---------------------------------------------------------------------------

export type ZonedTime = {
  /** Wall clock at the place it happens: "2026-08-12T14:35". Never UTC. */
  local: string
  /** IANA zone when known. */
  zone?: string
  /** Offset in minutes when the mail stated one, or the zone resolved to one. */
  offsetMinutes?: number
  /** The instant, present only when the zone or offset is actually known. */
  utc?: string
}

/**
 * Abbreviations that mean exactly one thing.
 *
 * Deliberately short. CST is Central US, China, and Cuba; BST is Britain in
 * summer and Brazil in summer; IST is India, Ireland and Israel. An
 * abbreviation that could be two zones is treated as no information at all.
 */
const UNAMBIGUOUS_ABBR: Record<string, number> = {
  UTC: 0, GMT: 0, Z: 0,
  CET: 60, CEST: 120,
  WET: 0, WEST: 60,
  EET: 120, EEST: 180,
  EST: -300, EDT: -240,
  CDT: -300,
  MST: -420, MDT: -360,
  PST: -480, PDT: -420,
  BRT: -180, BRST: -120,
  ART: -180,
  JST: 540, KST: 540,
  AEST: 600, AEDT: 660,
  NZST: 720, NZDT: 780,
}

export function offsetOfAbbreviation(abbr: string): number | undefined {
  return UNAMBIGUOUS_ABBR[abbr.trim().toUpperCase()]
}

/** UTC offset of an IANA zone at a given instant, in minutes. */
export function zoneOffsetAt(zone: string, utcMs: number): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs))
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
    const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
    return Math.round((asIfUtc - Math.floor(utcMs / 1000) * 1000) / 60_000)
  } catch {
    return undefined
  }
}

/**
 * Local wall clock in a named zone -> the instant.
 *
 * Two passes because the offset depends on the instant we are trying to find:
 * a first guess using the offset at the naive time, then a correction. That is
 * enough for everything except the hour that DST skips, where a booking would
 * be invalid anyway.
 */
export function zonedToUtc(local: string, zone: string): string | undefined {
  const naive = Date.parse(`${local.length === 16 ? local + ':00' : local}Z`)
  if (Number.isNaN(naive)) return undefined
  let ts = naive
  for (let i = 0; i < 2; i++) {
    const off = zoneOffsetAt(zone, ts)
    if (off === undefined) return undefined
    ts = naive - off * 60_000
  }
  return new Date(ts).toISOString()
}

/** Fill in the instant if — and only if — the zone or offset is actually known. */
export function resolveZoned(t: ZonedTime): ZonedTime {
  if (t.utc) return t
  if (t.zone) {
    const utc = zonedToUtc(t.local, t.zone)
    if (utc) {
      const off = zoneOffsetAt(t.zone, Date.parse(utc))
      return { ...t, utc, ...(off !== undefined ? { offsetMinutes: off } : {}) }
    }
  }
  if (t.offsetMinutes !== undefined) {
    const naive = Date.parse(`${t.local.length === 16 ? t.local + ':00' : t.local}Z`)
    if (!Number.isNaN(naive)) return { ...t, utc: new Date(naive - t.offsetMinutes * 60_000).toISOString() }
  }
  return t
}

export function formatZoned(t: ZonedTime): string {
  const label = t.zone ?? (t.offsetMinutes !== undefined ? formatOffsetLabel(t.offsetMinutes) : 'zone unknown')
  return `${t.local.replace('T', ' ')} ${label}`
}

function formatOffsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '−' : '+'
  const abs = Math.abs(minutes)
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Parsing times out of prose
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, gen: 1, feb: 2, fev: 2, mar: 3, apr: 4, abr: 4, mag: 5, may: 5, mai: 5,
  jun: 6, giu: 6, jul: 7, lug: 7, aug: 8, ago: 8, sep: 9, set: 9, oct: 10, ott: 10, out: 10,
  nov: 11, dec: 12, dic: 12, dez: 12,
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export type ParseTimeOpts = {
  /** Required to read a numeric date like 05/08/2026, which no email disambiguates. */
  dateOrder?: 'dmy' | 'mdy'
  /** Year to assume when the text omits it — a booking mail often does. */
  assumeYear?: number
}

/**
 * A date and time written the way booking mail writes them.
 *
 * Returns the wall clock and whatever zone marker was attached, and nothing
 * else. Resolving that marker into an instant is a separate step on purpose:
 * everything here is what the email said, and only that.
 */
export function parseZonedTime(text: string, o: ParseTimeOpts = {}): ZonedTime | undefined {
  const date = parseDatePart(text, o)
  if (!date) return undefined
  const tm = /\b([01]?\d|2[0-3])[:.h]([0-5]\d)\s*(am|pm)?/i.exec(text)
  if (!tm) return undefined
  let hour = Number(tm[1])
  const minute = Number(tm[2])
  const meridiem = tm[3]?.toLowerCase()
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  const local = `${date}T${pad(hour)}:${pad(minute)}`

  const explicit = /(?:GMT|UTC)?\s*([+-])(\d{2}):?(\d{2})\b/.exec(text)
  if (explicit) {
    const sign = explicit[1] === '-' ? -1 : 1
    return resolveZoned({ local, offsetMinutes: sign * (Number(explicit[2]) * 60 + Number(explicit[3])) })
  }
  const abbr = /\(?\b([A-Z]{2,4})\b\)?\s*$/.exec(text.trim())
  const off = abbr ? offsetOfAbbreviation(abbr[1]) : undefined
  if (off !== undefined) return resolveZoned({ local, offsetMinutes: off })

  // No marker: the wall clock is all that is known, and that is recorded
  // honestly rather than papered over with the machine's own zone.
  return { local }
}

export function parseDatePart(text: string, o: ParseTimeOpts): string | undefined {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`

  const named = /\b(\d{1,2})\s+([A-Za-zçêéû]{3,9})\.?,?\s*(\d{4})?/.exec(text)
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()]
    if (month) {
      const year = named[3] ? Number(named[3]) : o.assumeYear
      if (year) return `${year}-${pad(month)}-${pad(Number(named[1]))}`
    }
  }
  const namedFirst = /\b([A-Za-zçêéû]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})?/.exec(text)
  if (namedFirst) {
    const month = MONTHS[namedFirst[1].slice(0, 3).toLowerCase()]
    if (month) {
      const year = namedFirst[3] ? Number(namedFirst[3]) : o.assumeYear
      if (year) return `${year}-${pad(month)}-${pad(Number(namedFirst[2]))}`
    }
  }

  // Boarding passes write the date closed up: 15AUG26, 05OCT2026. The spaced
  // patterns above all require a separator, so without this a pass carries no
  // date at all and every segment on it is discarded.
  const compact = /\b(\d{1,2})([A-Za-z]{3})(\d{4}|\d{2})?\b/g
  for (const match of text.matchAll(compact)) {
    const month = MONTHS[match[2].toLowerCase()]
    const yearToken = match[3] ?? (o.assumeYear === undefined ? undefined : String(o.assumeYear).padStart(4, '0'))
    if (!month || !yearToken) continue
    const year = match[3]?.length === 2 ? 2000 + Number(match[3]) : Number(yearToken)
    const yearText = match[3]?.length === 2 ? String(year) : yearToken.padStart(4, '0')
    const day = Number(match[1])
    const daysInMonth = month === 2
      ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
      : [4, 6, 9, 11].includes(month) ? 30 : 31
    if (day >= 1 && day <= daysInMonth) return `${yearText}-${pad(month)}-${pad(day)}`
  }

  const numeric = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/.exec(text)
  if (numeric) {
    const a = Number(numeric[1])
    const b = Number(numeric[2])
    const year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3])
    // 13/08 can only be day-first, 08/13 can only be month-first. When both
    // readings are possible the caller must say which; guessing here is a
    // one-in-two chance of moving a flight by months.
    const order = a > 12 ? 'dmy' : b > 12 ? 'mdy' : o.dateOrder
    if (!order) return undefined
    const day = order === 'dmy' ? a : b
    const month = order === 'dmy' ? b : a
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
    return `${year}-${pad(month)}-${pad(day)}`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

export type FlightSegment = {
  kind: 'flight'
  /** "LH510" — carrier code plus number, normalized without the space. */
  flight: string
  carrier: string
  from?: string
  to?: string
  depart: ZonedTime
  arrive?: ZonedTime
  pnr?: string
  seat?: string
  cabin?: string
  /** Hours before departure that online check-in opens, when the booking said. */
  checkInOpensHours?: number
}

export type StaySegment = {
  kind: 'stay'
  name: string
  address?: string
  city?: string
  country?: string
  /** YYYY-MM-DD. Hotels are booked by night, not by instant. */
  checkIn: string
  checkOut: string
  confirmation?: string
  freeCancelUntil?: ZonedTime
}

export type Segment = FlightSegment | StaySegment

export type Trip = {
  id: string
  /** YYYY-MM-DD bounds across every segment. */
  start: string
  end: string
  segments: Segment[]
  pnrs: string[]
  /** Message ids the trip was built from — the audit trail. */
  sources: string[]
  updatedAt: string
  /**
   * Lifecycle events already raised for this trip ("checkin:LH510@2026-10-02").
   * Kept on the trip itself so a restart, or a later fragment merging in, can
   * never raise the same one twice. See triplife.ts.
   */
  fired?: string[]
}

export type TripFragment = {
  segments: Segment[]
  pnrs?: string[]
  source?: string
}

export type AirportTable = Record<string, {
  zone?: string
  country?: string
  city?: string
  /** ISO 4217 used there. Optional; only the trip expense roll-up reads it. */
  currency?: string
}>

// ---------------------------------------------------------------------------
// Parsing booking mail
// ---------------------------------------------------------------------------

const PNR_CONTEXT = /(?:booking reference|reservation code|record locator|confirmation (?:code|number)|reference number|PNR|localizador|c[oó]digo de reserva|codice di prenotazione)\s*[:#]?\s*([A-Z0-9]{6})\b/i

/**
 * The record locator, and only when the mail said what it was.
 *
 * A bare six-character token is not a PNR: booking mail is full of order ids,
 * loyalty numbers and CSS colours. Requiring the label costs the occasional
 * real PNR and never invents one.
 */
export function parsePnr(text: string): string | undefined {
  const m = PNR_CONTEXT.exec(text)
  if (!m) return undefined
  const code = m[1].toUpperCase()
  // All digits is an order number; a real locator mixes letters in.
  return /^\d{6}$/.test(code) ? undefined : code
}

const FLIGHT_RE = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/
const ROUTE_RE = /\b([A-Z]{3})\b\s*(?:→|->|–|—|-|to|para|per)\s*\b([A-Z]{3})\b/
const FLIGHT_WORD = /\b(flight|voo|volo|vuelo|flug)\b/i

/**
 * One flight from one line of a booking email.
 *
 * The designator pattern alone matches far too much ("A4 2024", "B2 500"), so a
 * line qualifies only if it also says "flight" or carries a three-letter route.
 * Departure and arrival zones come from the airport table when the caller has
 * one; without it the times stay zoneless and tripProblems says so.
 */
export function parseFlightLine(
  line: string,
  o: ParseTimeOpts & { airports?: AirportTable } = {},
): FlightSegment | undefined {
  const route = ROUTE_RE.exec(line)
  if (!FLIGHT_WORD.test(line) && !route) return undefined
  const f = FLIGHT_RE.exec(line.replace(ROUTE_RE, ' '))
  if (!f) return undefined

  const flight = `${f[1]}${f[2]}`.toUpperCase()
  const from = route?.[1]
  const to = route?.[2]

  // Two times on one line means depart then arrive, in that order — every
  // itinerary in the world is written left to right.
  const times = [...line.matchAll(/\b([01]?\d|2[0-3])[:.h]([0-5]\d)\s*(am|pm)?/gi)]
  const dateText = line
  const depart = parseZonedTime(dateText, o)
  if (!depart) return undefined

  const zoneFor = (iata?: string) => (iata ? o.airports?.[iata.toUpperCase()]?.zone : undefined)
  const departZone = zoneFor(from)
  const seg: FlightSegment = {
    kind: 'flight',
    flight,
    carrier: f[1].toUpperCase(),
    ...(from ? { from: from.toUpperCase() } : {}),
    ...(to ? { to: to.toUpperCase() } : {}),
    depart: resolveZoned(departZone ? { ...depart, zone: departZone } : depart),
  }

  if (times.length > 1) {
    const t = times[1]
    let hour = Number(t[1])
    const meridiem = t[3]?.toLowerCase()
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
    // Arrival is on the departure's calendar day unless it is earlier, in which
    // case the leg crossed midnight. Long-haul that lands two days later is
    // rare enough to be worth getting wrong loudly rather than guessing twice.
    const departDay = seg.depart.local.slice(0, 10)
    const local = `${departDay}T${pad(hour)}:${pad(Number(t[2]))}`
    const arriveDay = local < seg.depart.local
      ? new Date(Date.parse(`${departDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
      : departDay
    const arriveZone = zoneFor(to)
    seg.arrive = resolveZoned({
      local: `${arriveDay}T${pad(hour)}:${pad(Number(t[2]))}`,
      ...(arriveZone ? { zone: arriveZone } : {}),
    })
  }

  const seat = /\bseat\s*:?\s*([0-9]{1,2}[A-K])\b/i.exec(line)
  if (seat) seg.seat = seat[1].toUpperCase()
  return seg
}

const DESIGNATOR_LINE = /^([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})$/
const IATA_LINE = /^[A-Z]{3}$/
const TIME_LINE = /^([01]?\d|2[0-3])[:.]([0-5]\d)\s*([+-]\d+)?$/
const SEAT_LINE = /^\d{1,3}[A-Z]$/
const BOARDING_LINE = /\bboarding\b|\bimbarco\b/i
const DEPARTURE_LINE = /\bdeparture\b|\bpartenza\b|\bdecollo\b/i
const ARRIVAL_LINE = /\barrival\b|\barrivo\b|\batterraggio\b/i
const ISSUE_LINE = /\bissued?\b|\bissue date\b/i

/**
 * A flight from a boarding pass, where the itinerary is a column rather than a
 * line: date, designator, the two airport codes, then the two times, each on a
 * line of its own.
 *
 * `parseFlightLine` cannot see this at all — it needs the route and the
 * designator and the date to share one line, and here they never do. Rather
 * than loosen that (which would make every stray "A4 2024" a flight), this
 * reads the column shape directly and stays a fallback: it only runs when
 * line-by-line parsing found nothing.
 */
export function parseBoardingPass(
  text: string,
  o: ParseTimeOpts & { airports?: AirportTable } = {},
): FlightSegment | undefined {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const zoneFor = (iata?: string) => (iata ? o.airports?.[iata.toUpperCase()]?.zone : undefined)
  const at = (m: RegExpExecArray, day: string) => `${day}T${pad(Number(m[1]))}:${pad(Number(m[2]))}`
  const plusDays = (day: string, n: number) =>
    new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

  const dateNear = (start: number, index: number, end: number): string | undefined => {
    for (let j = start; j < end; j++) {
      if (ISSUE_LINE.test(lines[j])) continue
      const date = parseDatePart(lines[j], o)
      if (date && DEPARTURE_LINE.test(lines[j])) return date
    }
    for (let r = 0; index - r >= start || index + r < end; r++) {
      for (const j of [index - r, index + r]) {
        if (j < start || j >= end || ISSUE_LINE.test(lines[j])) continue
        const date = parseDatePart(lines[j], o)
        if (date) return date
      }
    }
    return undefined
  }

  const labelNear = (index: number, start: number, re: RegExp) => {
    for (let j = index - 1; j >= Math.max(start, index - 3); j--) {
      if (re.test(lines[j])) return true
      if (TIME_LINE.test(lines[j])) return false
      if (!parseDatePart(lines[j], o)) return false
    }
    return false
  }
  const explicitDateNear = (index: number, start: number) => {
    for (let j = index - 1; j >= Math.max(start, index - 3); j--) {
      if (TIME_LINE.test(lines[j])) return undefined
      const date = parseDatePart(lines[j], o)
      if (date) return date
      return undefined
    }
    return undefined
  }
  const seatAfterLabel = (start: number, end: number) => {
    for (let j = start; j < end - 1; j++) {
      if (/^seat\s*:?\s*$/i.test(lines[j]) && SEAT_LINE.test(lines[j + 1])) return lines[j + 1].toUpperCase()
    }
    return undefined
  }

  for (let i = 0; i < lines.length; i++) {
    const d = DESIGNATOR_LINE.exec(lines[i])
    if (!d) continue
    const previousDesignator = lines.findLastIndex((line, j) => j < i && DESIGNATOR_LINE.test(line))
    const start = previousDesignator < 0 ? 0 : previousDesignator + 1
    const nextDesignator = lines.findIndex((line, j) => j > i && DESIGNATOR_LINE.test(line))
    const end = nextDesignator < 0 ? lines.length : nextDesignator
    const date = dateNear(start, i, end)
    if (!date) continue

    const codeIndexes = Array.from({ length: end - i - 1 }, (_, n) => i + n + 1)
      .filter(j => IATA_LINE.test(lines[j]) && !(lines[j] === 'PNR' && /^[A-Z0-9]{6}$/i.test(lines[j + 1] ?? '')))
    const [fromIndex, toIndex] = codeIndexes
    const from = fromIndex === undefined ? undefined : lines[fromIndex]
    const to = toIndex === undefined ? undefined : lines[toIndex]
    const timeStart = toIndex ?? fromIndex ?? i
    const timeEntries = Array.from({ length: end - timeStart - 1 }, (_, n) => timeStart + n + 1)
      .map(index => ({ index, match: TIME_LINE.exec(lines[index]) }))
      .filter((entry): entry is { index: number; match: RegExpExecArray } => entry.match !== null)
    const departure = timeEntries.find(entry => labelNear(entry.index, timeStart + 1, DEPARTURE_LINE))
      ?? timeEntries.find(entry => !labelNear(entry.index, timeStart + 1, BOARDING_LINE) && !labelNear(entry.index, timeStart + 1, ARRIVAL_LINE))
    if (!departure) continue
    const arrival = timeEntries.find(entry => entry !== departure && labelNear(entry.index, timeStart + 1, ARRIVAL_LINE))
      ?? timeEntries.find(entry => entry !== departure && !labelNear(entry.index, timeStart + 1, BOARDING_LINE) && !labelNear(entry.index, timeStart + 1, DEPARTURE_LINE))

    const departureDay = plusDays(date, Number(departure.match[3] ?? 0))
    const departLocal = at(departure.match, departureDay)
    const departZone = zoneFor(from)
    const seg: FlightSegment = {
      kind: 'flight',
      flight: `${d[1]}${d[2]}`.toUpperCase(),
      carrier: d[1].toUpperCase(),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      depart: resolveZoned({ local: departLocal, ...(departZone ? { zone: departZone } : {}) }),
    }

    if (arrival) {
      const explicitArrivalDate = labelNear(arrival.index, timeStart + 1, ARRIVAL_LINE)
        ? explicitDateNear(arrival.index, timeStart + 1)
        : undefined
      const statedOffset = arrival.match[3]
      let arrivalDay = plusDays(explicitArrivalDate ?? date, Number(statedOffset ?? 0))
      if (!explicitArrivalDate && statedOffset === undefined) {
        const arriveZone = zoneFor(to)
        arrivalDay = departureDay
        const sameDay = resolveZoned({ local: at(arrival.match, arrivalDay), ...(arriveZone ? { zone: arriveZone } : {}) })
        const crossesMidnight = sameDay.utc && seg.depart.utc
          ? Date.parse(sameDay.utc) <= Date.parse(seg.depart.utc)
          : at(arrival.match, arrivalDay) < departLocal
        if (crossesMidnight) arrivalDay = plusDays(arrivalDay, 1)
      }
      const arriveZone = zoneFor(to)
      seg.arrive = resolveZoned({ local: at(arrival.match, arrivalDay), ...(arriveZone ? { zone: arriveZone } : {}) })
    }

    const currentFlight = lines.findLastIndex((line, j) => j < i && /^current flight\s*$/i.test(line))
    const seat = seatAfterLabel(i, end) ?? seatAfterLabel(Math.max(currentFlight + 1, i - 6), i)
    if (seat) seg.seat = seat
    return seg
  }
  return undefined
}

const FREE_CANCEL_RE = /free cancellation (?:until|before|up to)|cancelamento gratuito at[ée]|cancellazione gratuita (?:fino a|entro)|free to cancel until/i

/**
 * The moment the hotel stops being free.
 *
 * This is the single most expensive date in a booking and the one nobody
 * remembers. It is parsed with the same zone rules as everything else: hotels
 * state it in their own local time, which is not necessarily the user’s.
 */
export function parseFreeCancellation(text: string, o: ParseTimeOpts & { zone?: string } = {}): ZonedTime | undefined {
  const idx = text.search(FREE_CANCEL_RE)
  if (idx < 0) return undefined
  const tail = text.slice(idx, idx + 200)
  // A deadline with no time of day is the end of that day, not midnight at its
  // start — reading it the other way loses the user a whole day of free cancellation.
  const day = parseDatePart(tail, o)
  const t = parseZonedTime(tail, o) ?? (day ? { local: `${day}T23:59` } : undefined)
  if (!t) return undefined
  return resolveZoned(o.zone ? { ...t, zone: o.zone } : t)
}

export type StayInput = {
  name: string
  checkIn: string
  checkOut: string
  address?: string
  city?: string
  country?: string
  confirmation?: string
  freeCancelUntil?: ZonedTime
}

export function makeStay(input: StayInput, o: ParseTimeOpts = {}): StaySegment | undefined {
  const checkIn = parseDatePart(input.checkIn, o)
  const checkOut = parseDatePart(input.checkOut, o)
  if (!checkIn || !checkOut || checkOut < checkIn) return undefined
  return {
    kind: 'stay',
    name: input.name.trim(),
    checkIn,
    checkOut,
    ...(input.address ? { address: input.address.replace(/\s+/g, ' ').trim() } : {}),
    ...(input.city ? { city: input.city } : {}),
    ...(input.country ? { country: input.country.toUpperCase() } : {}),
    ...(input.confirmation ? { confirmation: input.confirmation } : {}),
    ...(input.freeCancelUntil ? { freeCancelUntil: input.freeCancelUntil } : {}),
  }
}

const CHECKIN_HOURS_RE = /(?:online |web |mobile )?check-?in (?:opens|is open|is available|becomes available|available)\s*(?:from\s*)?(\d{1,3})\s*(?:hours?|hrs?|h)\b(?:\s*before)?/gi
const COUNTER_WORDS = /\b(?:airport|desk|counter|bag(?:gage)?[- ]drop)\b/i

/**
 * How many hours before departure online check-in opens, when the mail says.
 *
 * Only a stated number counts. Airlines range from 24 to 72 hours and some
 * vary by route, so an unstated window stays unstated and the caller applies
 * its default knowing it is one.
 *
 * Booking mail states the airport counter's hours in the same words ("airport
 * check-in opens 3 hours before departure"), so a sentence that mentions the
 * airport, a desk, a counter or bag drop is skipped unless it also says online
 * or web — reading the counter's 3h as the online window would announce
 * check-in the morning of the flight instead of the day before.
 */
export function parseCheckInHours(text: string): number | undefined {
  for (const m of text.matchAll(CHECKIN_HOURS_RE)) {
    const at = m.index ?? 0
    const sentenceStart = Math.max(...['.', '!', '?', '\n'].map(c => text.lastIndexOf(c, at))) + 1
    const ends = ['.', '!', '?', '\n'].map(c => text.indexOf(c, at + m[0].length)).filter(i => i >= 0)
    const sentence = text.slice(sentenceStart, ends.length ? Math.min(...ends) : text.length)
    const online = /\b(?:online|web|mobile)\b/i.test(sentence)
    if (!online && COUNTER_WORDS.test(sentence)) continue
    const h = Number(m[1])
    if (h >= 1 && h <= 168) return h
  }
  return undefined
}

/** Whole-email pass: every flight line it can read, plus the PNR. */
export function parseBookingEmail(
  text: string,
  o: ParseTimeOpts & { airports?: AirportTable; source?: string } = {},
): TripFragment {
  const pnr = parsePnr(text)
  const segments: Segment[] = []
  for (const line of text.split('\n')) {
    const seg = parseFlightLine(line, o)
    if (seg) segments.push(pnr ? { ...seg, pnr } : seg)
  }
  // Only when the line-by-line pass came back empty: a boarding pass lays its
  // itinerary out vertically, so no single line ever qualifies.
  if (!segments.length) {
    const pass = parseBoardingPass(text, o)
    if (pass) segments.push(pnr ? { ...pass, pnr } : pass)
  }
  const checkInHours = parseCheckInHours(text)
  if (checkInHours !== undefined) {
    for (const seg of segments) if (seg.kind === 'flight') seg.checkInOpensHours = checkInHours
  }
  return {
    segments,
    ...(pnr ? { pnrs: [pnr] } : {}),
    ...(o.source ? { source: o.source } : {}),
  }
}

// ---------------------------------------------------------------------------
// Merging fragments into trips
// ---------------------------------------------------------------------------

export function tripId(): string {
  return randomBytes(4).toString('hex')
}

function segmentDates(s: Segment): { start: string; end: string } {
  if (s.kind === 'stay') return { start: s.checkIn, end: s.checkOut }
  const start = s.depart.local.slice(0, 10)
  return { start, end: (s.arrive?.local ?? s.depart.local).slice(0, 10) }
}

function boundsOf(segments: Segment[]): { start: string; end: string } | null {
  const dates = segments.map(segmentDates)
  if (!dates.length) return null
  return {
    start: dates.map(d => d.start).sort()[0],
    end: dates.map(d => d.end).sort().slice(-1)[0],
  }
}

/** Same flight on the same day, or the same hotel from the same night. */
function sameSegment(a: Segment, b: Segment): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'flight' && b.kind === 'flight') {
    return a.flight === b.flight && a.depart.local.slice(0, 10) === b.depart.local.slice(0, 10)
  }
  if (a.kind === 'stay' && b.kind === 'stay') {
    return a.name.toLowerCase() === (b as StaySegment).name.toLowerCase() && a.checkIn === (b as StaySegment).checkIn
  }
  return false
}

/**
 * A later fragment usually knows more than an earlier one — the seat email
 * repeats the flight and adds the seat — so fields fill in but are never
 * blanked. The one exception is a time that gained a zone, which always wins,
 * because a zoned time is strictly better information than an unzoned one.
 */
function mergeSegment(existing: Segment, incoming: Segment): Segment {
  if (existing.kind === 'flight' && incoming.kind === 'flight') {
    return {
      ...existing,
      ...Object.fromEntries(Object.entries(incoming).filter(([, v]) => v !== undefined && v !== '')),
      depart: incoming.depart.utc && !existing.depart.utc ? incoming.depart : existing.depart,
      ...(incoming.arrive || existing.arrive
        ? { arrive: incoming.arrive?.utc && !existing.arrive?.utc ? incoming.arrive : (existing.arrive ?? incoming.arrive) }
        : {}),
    } as FlightSegment
  }
  return {
    ...existing,
    ...Object.fromEntries(Object.entries(incoming).filter(([, v]) => v !== undefined && v !== '')),
  } as Segment
}

/** Days of slack when deciding whether a fragment belongs to an existing trip. */
export const MERGE_SLACK_DAYS = 2

/**
 * Fold a fragment into the trip it belongs to, or start a new one.
 *
 * Keyed by overlapping date range rather than by PNR, because the hotel and the
 * flight have different reference numbers and are still obviously the same
 * trip. A shared PNR is treated as decisive when there is one; the date range,
 * widened by a couple of days, catches everything else.
 */
export function mergeFragment(trips: Trip[], fragment: TripFragment, now = new Date()): { trips: Trip[]; trip: Trip } {
  const bounds = boundsOf(fragment.segments)
  if (!bounds) throw new Error('fragment has no datable segments')

  const slack = MERGE_SLACK_DAYS * 86_400_000
  const startMs = Date.parse(bounds.start)
  const endMs = Date.parse(bounds.end)

  let trip = trips.find(t => (fragment.pnrs ?? []).some(p => t.pnrs.includes(p)))
  trip ??= trips.find(t => Date.parse(t.start) - slack <= endMs && Date.parse(t.end) + slack >= startMs)

  if (!trip) {
    trip = {
      id: tripId(),
      start: bounds.start,
      end: bounds.end,
      segments: [],
      pnrs: [],
      sources: [],
      updatedAt: now.toISOString(),
    }
    trips.push(trip)
  }

  for (const seg of fragment.segments) {
    const i = trip.segments.findIndex(s => sameSegment(s, seg))
    if (i >= 0) trip.segments[i] = mergeSegment(trip.segments[i], seg)
    else trip.segments.push(seg)
  }
  for (const p of fragment.pnrs ?? []) if (!trip.pnrs.includes(p)) trip.pnrs.push(p)
  if (fragment.source && !trip.sources.includes(fragment.source)) trip.sources.push(fragment.source)

  const merged = boundsOf(trip.segments)!
  trip.start = merged.start
  trip.end = merged.end
  trip.segments.sort((a, b) => segmentDates(a).start.localeCompare(segmentDates(b).start))
  trip.updatedAt = now.toISOString()
  return { trips, trip }
}

// ---------------------------------------------------------------------------
// Derived facts
// ---------------------------------------------------------------------------

export type CountryDays = { country: string; days: number; from: string; to: string }

const DAY_MS = 86_400_000

function dayCountInclusive(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1
}

/**
 * Days spent per country, derived from the segments.
 *
 * Counted inclusively at both ends — the day you land and the day you leave
 * both count — because that is how Schengen, and every tax residency rule the user
 * might care about, counts them. That convention double-counts a travel day
 * across two countries on purpose; it is the conservative direction for the
 * question people actually ask, which is "am I close to a limit".
 *
 * A leg whose airports are not in the table contributes nothing rather than a
 * guess, and the gap shows up in tripProblems.
 */
export function daysInCountry(trip: Trip, airports: AirportTable): CountryDays[] {
  const spans = countrySpans(trip, airports)
  const byCountry = new Map<string, CountryDays>()
  for (const s of spans) {
    const existing = byCountry.get(s.country)
    if (!existing) { byCountry.set(s.country, { ...s }); continue }
    existing.days += s.days
    existing.from = existing.from < s.from ? existing.from : s.from
    existing.to = existing.to > s.to ? existing.to : s.to
  }
  return [...byCountry.values()].sort((a, b) => b.days - a.days)
}

/** One inclusive date span per flight arrival; daysInCountry sums them, staylimits.ts expands them. */
export function countrySpans(trip: Trip, airports: AirportTable): CountryDays[] {
  const flights = trip.segments
    .filter((s): s is FlightSegment => s.kind === 'flight')
    .sort((a, b) => a.depart.local.localeCompare(b.depart.local))

  const spans: CountryDays[] = []
  for (let i = 0; i < flights.length; i++) {
    const arrivalCountry = airports[flights[i].to ?? '']?.country
    if (!arrivalCountry) continue
    const from = (flights[i].arrive?.local ?? flights[i].depart.local).slice(0, 10)

    // The user is there until the next flight leaves, or until the trip's last date.
    const next = flights[i + 1]
    const to = next ? next.depart.local.slice(0, 10) : trip.end
    if (to < from) continue
    spans.push({ country: arrivalCountry, days: dayCountInclusive(from, to), from, to })
  }
  return spans
}

/** Free-cancellation deadlines still ahead, soonest first. */
export function cancellationDeadlines(trip: Trip, now = Date.now()): { stay: StaySegment; at: ZonedTime }[] {
  return trip.segments
    .filter((s): s is StaySegment => s.kind === 'stay' && Boolean(s.freeCancelUntil))
    .map(s => ({ stay: s, at: s.freeCancelUntil! }))
    .filter(({ at }) => {
      const t = at.utc ? Date.parse(at.utc) : Date.parse(`${at.local}:00Z`)
      return Number.isNaN(t) || t > now
    })
    .sort((a, b) => (a.at.utc ?? a.at.local).localeCompare(b.at.utc ?? b.at.local))
}

/**
 * Everything about this trip that is not knowable yet.
 *
 * This is the output that keeps the whole file honest: rather than filling a
 * missing zone with the user’s current one, the gap is named so the session can ask
 * the user or look it up.
 */
export function tripProblems(trip: Trip, docs: Doc[] = []): string[] {
  const out: string[] = passportProblems(trip.end, docs)
  for (const s of trip.segments) {
    if (s.kind !== 'flight') continue
    if (!s.depart.utc) out.push(`${s.flight}: departure ${s.depart.local} has no timezone — do not convert it`)
    if (s.arrive && !s.arrive.utc) out.push(`${s.flight}: arrival ${s.arrive.local} has no timezone`)
    if (!s.arrive) out.push(`${s.flight}: no arrival time`)
    if (!s.from || !s.to) out.push(`${s.flight}: route incomplete`)
  }
  const stays = trip.segments.filter((s): s is StaySegment => s.kind === 'stay')
  for (const s of stays) if (!s.address) out.push(`${s.name}: no address`)
  return out
}

export function formatTrip(trip: Trip): string {
  const lines = [`Trip ${trip.id}: ${trip.start} → ${trip.end}${trip.pnrs.length ? ` (${trip.pnrs.join(', ')})` : ''}`]
  for (const s of trip.segments) {
    if (s.kind === 'flight') {
      const route = s.from && s.to ? `${s.from}→${s.to}` : '?'
      lines.push(`  ${s.flight} ${route} dep ${formatZoned(s.depart)}${s.arrive ? ` arr ${formatZoned(s.arrive)}` : ''}${s.seat ? ` seat ${s.seat}` : ''}`)
    } else {
      lines.push(`  ${s.name} ${s.checkIn} → ${s.checkOut}${s.address ? ` — ${s.address}` : ''}${s.freeCancelUntil ? ` (free until ${formatZoned(s.freeCancelUntil)})` : ''}`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function loadTrips(file: string): Trip[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as Trip[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: trips.json corrupt, moved aside.\n')
    }
    return []
  }
}

export function saveTrips(file: string, trips: Trip[]): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(trips, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

const STATE_DIR = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
export const TRIPS_FILE = join(STATE_DIR, 'trips.json')
/** Caller-maintained: { "EZE": { zone: "America/Argentina/Buenos_Aires", country: "AR" } }. */
export const AIRPORTS_FILE = join(STATE_DIR, 'airports.json')

/** The airport table, or an empty one. Never a built-in guess. */
export function loadAirports(file = AIRPORTS_FILE): AirportTable {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as AirportTable) : {}
  } catch {
    return {}
  }
}
