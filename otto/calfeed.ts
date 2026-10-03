#!/usr/bin/env bun
/**
 * The calendar as a push source.
 *
 * Otto reads the calendar the way a person reads a printout: it asks what is on
 * today, gets a list, and forgets it. Everything that actually matters about a
 * calendar is a *change* — the 9am moved to 7am, the client declined, the venue
 * changed to an address across town, the thing you were dreading got cancelled.
 * A snapshot cannot see any of that, and asking a model to eyeball two lists
 * for differences is both expensive and unreliable.
 *
 * So keep the last snapshot of the next 14 days and diff it. What comes out is
 * a small number of typed events that are worth a message, from a much larger
 * number of fields that are not: Google rewrites `updated`, `etag`, `iCalUID`
 * and conference metadata constantly, and treating any of that as a change
 * would mean pinging the user every fifteen minutes about nothing.
 *
 * The two judgement calls that make this trustworthy:
 *
 *   An event that has fallen off the back of the 14-day window has not been
 *   cancelled. It is still there; we simply stopped looking. Disappearance only
 *   counts as a cancellation while the event is still inside the horizon.
 *
 *   A first snapshot produces no changes at all. Everything is new on the first
 *   run, and forty "new invite" messages is the worst possible introduction to
 *   a feature whose entire promise is that it only speaks when something moved.
 *
 * The diff is pure and the fetch is injected, so the tests run on fixtures.
 *
 * CLI: `bun otto/calfeed.ts` — fetch, diff against the stored snapshot, print.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type CalAttendee = {
  email?: string
  displayName?: string
  /** "accepted" | "declined" | "tentative" | "needsAction" */
  responseStatus?: string
  self?: boolean
  organizer?: boolean
  resource?: boolean
}

export type CalEventSnap = {
  id: string
  summary?: string
  status?: string
  location?: string
  start?: { date?: string; dateTime?: string; timeZone?: string }
  end?: { date?: string; dateTime?: string; timeZone?: string }
  attendees?: CalAttendee[]
  organizer?: { email?: string; displayName?: string; self?: boolean }
  htmlLink?: string
  recurringEventId?: string
}

export type CalSnapshot = {
  takenAt: string
  horizonDays: number
  events: CalEventSnap[]
}

export type CalChange =
  | { kind: 'invited'; event: CalEventSnap }
  | { kind: 'moved'; event: CalEventSnap; from: string; to: string }
  | { kind: 'location'; event: CalEventSnap; from?: string; to?: string }
  | { kind: 'cancelled'; event: CalEventSnap }
  | { kind: 'declined'; event: CalEventSnap; who: string }

export const DEFAULT_HORIZON_DAYS = 14
/** Under a minute of drift is Google rewriting the record, not a reschedule. */
const MOVE_THRESHOLD_MS = 60_000

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function startOf(e: CalEventSnap): string | undefined {
  return e.start?.dateTime ?? e.start?.date
}

function instant(e: CalEventSnap): number {
  const s = startOf(e)
  const t = Date.parse(s ?? '')
  return Number.isNaN(t) ? NaN : t
}

function normLocation(s?: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function attendeeName(a: CalAttendee): string {
  return a.displayName || a.email || 'someone'
}

/**
 * Attendees who are not the user and not a room.
 *
 * Conference rooms respond too, and "Meeting Room 4 declined" is not news about
 * a person. The user’s own responseStatus is excluded because they already know what they
 * clicked — telling them they declined something is the fastest way to teach them
 * to ignore this feed.
 */
function humanAttendees(e: CalEventSnap): CalAttendee[] {
  return (e.attendees ?? []).filter(a => !a.self && !a.resource && a.email)
}

export type DiffOpts = {
  /** Changes to events starting before this are dropped — the past cannot move
   * in any way the user can act on. Defaults to the new snapshot's takenAt. */
  now?: number
}

/**
 * Real changes between two snapshots of the same window.
 *
 * Order matters to the caller: cancellations and moves are the actionable ones
 * and come first, new invites last, because a burst is usually one reschedule
 * plus its replacement invite and the reschedule is the story.
 */
export function diffSnapshots(prev: CalSnapshot | null, next: CalSnapshot, opts: DiffOpts = {}): CalChange[] {
  // No baseline means everything looks new. Say nothing and let the next diff
  // be the first real one.
  if (!prev) return []

  const now = opts.now ?? (Date.parse(next.takenAt) || Date.now())
  const horizonEnd = now + next.horizonDays * 24 * 60 * 60 * 1000
  const before = new Map(prev.events.map(e => [e.id, e]))
  const after = new Map(next.events.map(e => [e.id, e]))
  const out: CalChange[] = []

  for (const [id, b] of before) {
    const a = after.get(id)
    const at = instant(b)
    // Something in the past, or beyond the window we can still see, tells us
    // nothing: it may have moved, been cancelled, or simply be out of range.
    if (Number.isNaN(at) || at < now || at > horizonEnd) continue

    if (!a || a.status === 'cancelled') {
      if (b.status !== 'cancelled') out.push({ kind: 'cancelled', event: a ?? b })
      continue
    }

    const bs = instant(b)
    const as = instant(a)
    if (!Number.isNaN(bs) && !Number.isNaN(as) && Math.abs(as - bs) >= MOVE_THRESHOLD_MS) {
      out.push({ kind: 'moved', event: a, from: startOf(b)!, to: startOf(a)! })
    }

    if (normLocation(b.location) !== normLocation(a.location)) {
      out.push({
        kind: 'location', event: a,
        ...(b.location ? { from: b.location } : {}),
        ...(a.location ? { to: a.location } : {}),
      })
    }

    const wasBefore = new Map(humanAttendees(b).map(x => [x.email!, x.responseStatus]))
    for (const person of humanAttendees(a)) {
      if (person.responseStatus !== 'declined') continue
      // Only the transition is news. A declined invite that is still declined
      // tomorrow must not be reported again every scan.
      if (wasBefore.get(person.email!) === 'declined') continue
      out.push({ kind: 'declined', event: a, who: attendeeName(person) })
    }
  }

  for (const [id, a] of after) {
    if (before.has(id)) continue
    if (a.status === 'cancelled') continue
    const at = instant(a)
    if (Number.isNaN(at) || at < now) continue
    out.push({ kind: 'invited', event: a })
  }

  const rank: Record<CalChange['kind'], number> = { cancelled: 0, moved: 1, declined: 2, location: 3, invited: 4 }
  return out.sort((x, y) => rank[x.kind] - rank[y.kind] || instant(x.event) - instant(y.event))
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function when(iso: string, tz: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  // An all-day value has no time to show, and forcing one invents a midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: tz }).format(new Date(t))
  }
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz,
  }).format(new Date(t))
}

/** Timezone is required, not defaulted: the user may live across timezones, and
 * a calendar line without a zone is the exact bug this feature would cause. */
export function formatChange(c: CalChange, tz: string): string {
  const title = (c.event.summary ?? 'untitled').replace(/\s+/g, ' ').slice(0, 60)
  const at = startOf(c.event)
  switch (c.kind) {
    case 'invited':
      return `new: ${title} — ${at ? when(at, tz) : 'no time'} ${tz}`
    case 'moved':
      return `moved: ${title} — ${when(c.from, tz)} → ${when(c.to, tz)} ${tz}`
    case 'location':
      return `location: ${title} (${at ? when(at, tz) : '?'}) — ${c.from ?? 'none'} → ${c.to ?? 'removed'}`
    case 'cancelled':
      return `cancelled: ${title} — was ${at ? when(at, tz) : 'unknown'} ${tz}`
    case 'declined':
      return `${c.who} declined: ${title} — ${at ? when(at, tz) : 'no time'} ${tz}`
  }
}

export function formatChanges(changes: CalChange[], tz: string): string {
  return changes.map(c => formatChange(c, tz)).join('\n')
}

/**
 * Is this worth waking a session for?
 *
 * Everything happening in the next 48 hours is, because there is something to
 * do about it. Beyond that only the hard ones are: a cancellation or a move
 * three weeks out can wait for the morning brief, and a location tweak on a
 * recurring standup never needs to interrupt anything.
 */
export function worthTelling(c: CalChange, now: number): boolean {
  const at = instant(c.event)
  if (Number.isNaN(at)) return false
  const soon = at - now < 48 * 60 * 60 * 1000
  if (soon) return true
  return c.kind === 'cancelled' || c.kind === 'moved' || c.kind === 'invited'
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function loadSnapshot(file: string): CalSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CalSnapshot
    return Array.isArray(parsed?.events) ? parsed : null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: calfeed.json corrupt, moved aside.\n')
    }
    return null
  }
}

export function saveSnapshot(file: string, snap: CalSnapshot): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(snap, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

// ---------------------------------------------------------------------------
// Fetch (injected, so the diff can be tested without a network or a CLI)
// ---------------------------------------------------------------------------

export type Fetcher = (args: string[]) => Promise<string | null>

const FETCH_TIMEOUT_MS = 20_000

export const gogFetcher: Fetcher = async args => {
  try {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => { try { proc.kill() } catch {} }, FETCH_TIMEOUT_MS)
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    clearTimeout(timer)
    return code === 0 ? out : null
  } catch {
    return null
  }
}

/**
 * Snapshot the next `days`. Returns null on failure — never an empty snapshot,
 * because storing "no events" after a failed fetch would make the next diff
 * report the user’s entire fortnight as cancelled.
 */
export async function fetchSnapshot(
  account: string,
  o: { days?: number; now?: Date; fetcher?: Fetcher } = {},
): Promise<CalSnapshot | null> {
  const days = o.days ?? DEFAULT_HORIZON_DAYS
  const now = o.now ?? new Date()
  const fetcher = o.fetcher ?? gogFetcher
  const out = await fetcher([
    'gog', 'calendar', 'events', '-a', account, '--json', '--all',
    '--from', now.toISOString().slice(0, 10),
    '--to', new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    '--max', '250',
  ])
  if (out === null) return null
  try {
    const events = (JSON.parse(out) as { events?: CalEventSnap[] }).events
    if (!Array.isArray(events)) return null
    return {
      takenAt: now.toISOString(),
      horizonDays: days,
      // Keep only what the diff reads. The raw payload is ~40 fields per event,
      // most of which churn, and storing them would make every snapshot look
      // different from the last.
      events: events.filter(e => e.id).map(e => ({
        id: e.id,
        ...(e.summary ? { summary: e.summary } : {}),
        ...(e.status ? { status: e.status } : {}),
        ...(e.location ? { location: e.location } : {}),
        ...(e.start ? { start: e.start } : {}),
        ...(e.end ? { end: e.end } : {}),
        ...(e.attendees ? {
          attendees: e.attendees.map(a => ({
            ...(a.email ? { email: a.email } : {}),
            ...(a.displayName ? { displayName: a.displayName } : {}),
            ...(a.responseStatus ? { responseStatus: a.responseStatus } : {}),
            ...(a.self ? { self: a.self } : {}),
            ...(a.resource ? { resource: a.resource } : {}),
          })),
        } : {}),
        ...(e.organizer ? { organizer: e.organizer } : {}),
        ...(e.htmlLink ? { htmlLink: e.htmlLink } : {}),
        ...(e.recurringEventId ? { recurringEventId: e.recurringEventId } : {}),
      })),
    }
  } catch {
    return null
  }
}

export const CALFEED_FILE = join(
  process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'),
  'calfeed.json',
)

/** One pass: fetch, diff against what is on disk, store the new baseline. */
export async function pollCalendar(
  account: string,
  o: { file?: string; days?: number; now?: Date; fetcher?: Fetcher } = {},
): Promise<CalChange[]> {
  const file = o.file ?? CALFEED_FILE
  const next = await fetchSnapshot(account, o)
  if (!next) return []
  const prev = loadSnapshot(file)
  const changes = diffSnapshots(prev, next)
  saveSnapshot(file, next)
  return changes
}

if (import.meta.main) {
  // Set OTTO_GOOGLE_ACCOUNT in the channel env. There is deliberately no
  // default: a wrong address fails in a way that looks like an empty calendar.
  const account = process.env.OTTO_GOOGLE_ACCOUNT ?? ''
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const changes = await pollCalendar(account)
  console.log(changes.length ? formatChanges(changes, tz) : '(no calendar changes)')
}
