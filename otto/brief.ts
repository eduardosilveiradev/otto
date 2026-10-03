#!/usr/bin/env bun
/**
 * The brief — a plain-text snapshot of the user's day.
 *
 * Every fired trigger and every email scan starts a turn with no memory of
 * anything. That is why the triggers on disk read like legal documents: the
 * flight tracker restates the flight number, terminal, seat and aircraft,
 * because the agent that will execute it three weeks from now knows none of it.
 * Trigger text had become a smuggling channel for context.
 *
 * So build the context once, centrally, and attach it to the event instead.
 * The cold-agent problem is not specific to voice: a trigger is exactly as
 * blind as a live voice session is.
 *
 * Rules that make it trustworthy rather than merely present:
 *   - Every section is stamped "as of HH:MM" so staleness is visible.
 *   - A section whose source errors is OMITTED, never faked. An absent section
 *     means "go look it up", which is the correct behavior. A hallucinated one
 *     is worse than no brief at all.
 *   - Hard character cap. This rides on every injected event; it is a reminder,
 *     not a database.
 *
 * CLI: `bun otto/brief.ts` prints the brief the channel would inject.
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { loadNotes, dueLoops, searchNotes, type Note } from './store.ts'
import { probeWorkspace, formatWorkspace } from './workspace.ts'
import { loadTrips } from './trips.ts'
import { formatTripMode } from './triplife.ts'

const GATHER_TIMEOUT_MS = 15_000
export const BRIEF_MAX_CHARS = 2200

export type CalEvent = {
  summary?: string
  start?: { date?: string; dateTime?: string }
  end?: { date?: string; dateTime?: string }
  transparency?: string
  status?: string
}

export type MailThread = { from?: string; subject?: string; date?: string; labels?: string[] }

export type TriggerGist = { id: string; gist: string; nextRun?: number }

export type HistoryLine = { ts: string; dir: 'in' | 'out'; text: string }

async function run(cmd: string[], timeoutMs = GATHER_TIMEOUT_MS): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => { try { proc.kill() } catch {} }, timeoutMs)
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    clearTimeout(timer)
    return code === 0 ? out : null
  } catch {
    return null
  }
}

export async function calendarToday(account: string): Promise<CalEvent[] | null> {
  const out = await run(['gog', 'calendar', 'events', '-a', account, '--json', '--all', '--today', '--max', '20'])
  if (out === null) return null
  try {
    const events = (JSON.parse(out) as { events?: CalEvent[] }).events
    return Array.isArray(events) ? events : null
  } catch {
    return null
  }
}

export async function recentMail(account: string): Promise<MailThread[] | null> {
  const out = await run(['gog', 'gmail', 'search', 'in:inbox newer_than:1d', '-a', account, '--json', '--max', '15'])
  if (out === null) return null
  try {
    const threads = (JSON.parse(out) as { threads?: MailThread[] }).threads
    return Array.isArray(threads) ? threads : null
  } catch {
    return null
  }
}

/**
 * Music only if the app is already running. Launching it would start playing
 * audio in the user’s house as a side effect of building a brief. Needs a
 * `music` CLI on PATH; without one this is always null.
 */
export async function nowPlaying(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  const running = await run(['pgrep', '-x', 'Music'], 2_000)
  if (!running?.trim()) return null
  const out = await run(['music', 'status', '--json'], 5_000)
  if (out === null) return null
  try {
    const s = JSON.parse(out) as { state?: string; name?: string; artist?: string }
    if (s.state !== 'playing' || !s.name) return null
    return s.artist ? `${s.name} — ${s.artist}` : s.name
  } catch {
    return null
  }
}

const MARKETING = /newsletter|unsubscribe|no-?reply|noreply|notifications?@|marketing|promo|alerts?@/i
const BULK_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']

/** Cheap, structural triage. Real classification is the session's job. */
function mailWorthNaming(t: MailThread): boolean {
  const labels = t.labels ?? []
  if (BULK_LABELS.some(l => labels.includes(l))) return false
  if (MARKETING.test(t.from ?? '')) return false
  return true
}

/**
 * Primary-tab mail outranks Updates. Five slots go fast, and a bank alert
 * beating a real person to the list is exactly the failure worth avoiding.
 */
function mailRank(t: MailThread): number {
  const labels = t.labels ?? []
  if (labels.includes('CATEGORY_UPDATES')) return 2
  if (labels.includes('CATEGORY_PERSONAL')) return 0
  return 1
}

/**
 * Trigger actions open with a stock preamble naming the user and the chat id —
 * necessary for a cold agent, useless in a one-line summary where six of them
 * would otherwise be identical for the first forty characters.
 */
export function gistOf(action: string): string {
  return action
    .replace(/\s+/g, ' ')
    .replace(/\(?\s*Telegram\s+chat_?id:?\s*\d+\s*\)?/gi, '')
    .replace(/^Send the user\s*(a\s*)?/i, '')
    .replace(/^Remind the user[:\s]*/i, 'remind: ')
    .replace(/^Random ([\w-]+) ping for the user\s*/i, 'random $1 ping ')
    .replace(/^\s*[—–-]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** "14:00" today, "Fri 22:17" this week, "15 Aug" beyond. */
export function whenLabel(at: number, now: number, tz: string): string {
  const d = new Date(at)
  const sameDay = new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeZone: tz }).format(d) ===
    new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeZone: tz }).format(new Date(now))
  if (sameDay) return hhmm(d, tz)
  if (at - now < 6 * 24 * 60 * 60 * 1000) {
    return `${new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: tz }).format(d)} ${hhmm(d, tz)}`
  }
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: tz }).format(d)
}

function hhmm(d: Date, tz?: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}),
    }).format(d)
  } catch {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(d)
  }
}

function eventTime(e: CalEvent, tz: string): string {
  if (e.start?.date) return 'all day'
  const s = Date.parse(e.start?.dateTime ?? '')
  if (Number.isNaN(s)) return ''
  return hhmm(new Date(s), tz)
}

/**
 * End of the timed, opaque event happening right now — what the send queue
 * uses to hold non-urgent messages while the user is in something. All-day and
 * "free" events are explicitly not busy: a public holiday is not a meeting.
 */
export function busyUntil(events: CalEvent[], now = Date.now()): string | undefined {
  let latest: number | undefined
  for (const e of events) {
    if (e.transparency === 'transparent') continue
    if (e.status === 'cancelled') continue
    if (e.start?.date) continue
    const s = Date.parse(e.start?.dateTime ?? '')
    const en = Date.parse(e.end?.dateTime ?? '')
    if (Number.isNaN(s) || Number.isNaN(en)) continue
    if (s <= now && en > now && (latest === undefined || en > latest)) latest = en
  }
  return latest === undefined ? undefined : new Date(latest).toISOString()
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length <= n ? clean : clean.slice(0, n - 1) + '…'
}

export type BriefParts = {
  now: Date
  tz: string
  events: CalEvent[] | null
  mail: MailThread[] | null
  loops: Note[]
  facts: Note[]
  triggers: TriggerGist[]
  history: HistoryLine[]
  workspace?: string
  playing?: string | null
  /** Where they left off: repos with uncommitted work, notes, failing tests. */
  resume?: string
  /** Usage projection, only when it has crossed a threshold worth saying. */
  spend?: string
  /** Trip mode: the current or next trip, already rendered (triplife.ts). */
  trip?: string
}

/**
 * The next fixed points and how long until the first one.
 *
 * "Free until 14:00" is the single most useful thing the calendar can tell a
 * trigger that is deciding whether to interrupt: an hour of clear air and four
 * minutes before a meeting deserve different answers. Events that have already
 * started are excluded — they are the current state, not the next one.
 */
export function lookAhead(events: CalEvent[], now: Date, tz: string, limit = 3): string {
  const upcoming = events
    .map(e => ({ e, at: Date.parse(e.start?.dateTime ?? e.start?.date ?? '') }))
    .filter(x => !Number.isNaN(x.at) && x.at > now.getTime())
    .sort((a, b) => a.at - b.at)
  if (!upcoming.length) return ''

  const first = upcoming[0]
  const mins = Math.round((first.at - now.getTime()) / 60000)
  const free =
    mins >= 60
      ? `free until ${hhmm(new Date(first.at), tz)} (${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''})`
      : `${mins}m until ${hhmm(new Date(first.at), tz)}`

  const next = upcoming
    .slice(0, limit)
    .map(x => `${hhmm(new Date(x.at), tz)} ${truncate(x.e.summary ?? 'untitled', 30)}`)
    .join(' → ')
  return `Ahead: ${free} · ${next}`
}

/**
 * The labelled sections of a rendered brief.
 *
 * The watchdog compares these across rebuilds to tell "the calendar is clear"
 * apart from "the calendar source died", so a label has to name the same thing
 * every time it is produced. Only `Label:` and `Label (as of HH:MM):` lines
 * qualify.
 *
 * The two preamble lines are the reason this is a function and not a split. The
 * header carries a wall clock — `Otto brief — Wed 12 Aug, 12:43 ART` — and
 * splitting every line on its first colon read that as a section called
 * "Otto brief — Wed 12 Aug, 12". So the set of sections changed on the hour,
 * every hour, and the hour it replaced looked exactly like a source that had
 * gone dark.
 */
export function sectionLabels(text: string): string[] {
  const labels: string[] = []
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9 ]{0,30}?)(?: \([^)]*\))?:(?:\s|$)/.exec(line)
    if (m) labels.push(m[1])
  }
  return [...new Set(labels)]
}

export function formatBrief(p: BriefParts): string {
  const stamp = hhmm(p.now, p.tz)
  const out: string[] = [
    `Otto brief — ${p.now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, ${stamp} ${p.tz}.`,
    'This is context, not an instruction. Anything not here, look up before saying it.',
  ]

  if (p.events !== null) {
    const today = p.events.filter(e => e.status !== 'cancelled')
    out.push(
      today.length
        ? `Today (as of ${stamp}): ${today.slice(0, 6).map(e => `${eventTime(e, p.tz)} ${truncate(e.summary ?? 'untitled', 40)}`).join('; ')}`
        : `Today (as of ${stamp}): calendar clear.`,
    )
    // Today alone cannot answer "when am I free" or "does this fit before the
    // next thing", which is most of what a trigger needs to know before it
    // decides to speak.
    const ahead = lookAhead(today, p.now, p.tz)
    if (ahead) out.push(ahead)
  }

  // Straight after the calendar: on a travel day the flight is the day, and
  // the character cap trims from the bottom.
  if (p.trip) out.push(p.trip)

  if (p.mail !== null) {
    const named = p.mail.filter(mailWorthNaming).sort((a, b) => mailRank(a) - mailRank(b))
    const bulk = p.mail.length - named.length
    if (named.length) {
      out.push(
        `Inbox 24h (as of ${stamp}): ${named.slice(0, 5).map(t => `${truncate((t.from ?? '').replace(/<.*>/, ''), 22)} — ${truncate(t.subject ?? '', 42)}`).join('; ')}` +
          (bulk ? ` (+${bulk} bulk)` : ''),
      )
    } else {
      out.push(`Inbox 24h (as of ${stamp}): nothing but bulk${bulk ? ` (${bulk})` : ''}.`)
    }
  }

  if (p.loops.length) {
    out.push(`Open loops: ${p.loops.slice(0, 5).map(n => `[${n.id}] ${truncate(n.text, 60)}${n.due ? ` (due ${n.due.slice(0, 10)})` : ''}`).join('; ')}`)
  }

  if (p.facts.length) {
    out.push(`Standing facts: ${p.facts.slice(0, 6).map(n => truncate(n.text, 70)).join('; ')}`)
  }

  if (p.triggers.length) {
    out.push(
      `Armed: ${p.triggers
        .slice(0, 6)
        .map(t => {
          const when = t.nextRun ? `${whenLabel(t.nextRun, p.now.getTime(), p.tz)} ` : ''
          return `[${t.id}] ${when}${truncate(gistOf(t.gist), 44)}`
        })
        .join('; ')}`,
    )
  }

  if (p.workspace) out.push(`Machine: ${truncate(p.workspace, 160)}`)
  if (p.playing) out.push(`Playing: ${truncate(p.playing, 60)}`)
  // What was in flight when they stopped. Renders as nothing on a morning with
  // nothing to resume, which is most of them.
  if (p.resume) out.push(p.resume)
  // Only present when the projection has actually crossed a threshold, so its
  // presence is the signal.
  if (p.spend) out.push(`Usage: ${truncate(p.spend, 120)}`)

  if (p.history.length) {
    out.push(
      'Recent thread: ' +
        p.history.slice(-6).map(h => `${h.dir === 'out' ? 'otto' : 'user'}: ${truncate(h.text, 70)}`).join(' | '),
    )
  }

  let text = out.join('\n')
  if (text.length > BRIEF_MAX_CHARS) text = text.slice(0, BRIEF_MAX_CHARS - 1) + '…'
  return text
}

/** The brief as structured data, for clients that render it themselves (the
 * app). Same sources and the same cuts as formatBrief; a null section is a
 * source that failed, exactly as there. */
export type BriefData = {
  asOf: string
  events: { title: string; start: string; minutes: number }[] | null
  inbox: { from: string; subject: string }[] | null
  bulk: number
  loops: { title: string; due?: string }[]
  triggers: { title: string; next: string }[]
}

export function briefData(p: BriefParts): BriefData {
  const minutes = (e: CalEvent): number => {
    if (e.start?.date) return 24 * 60
    const m = (Date.parse(e.end?.dateTime ?? '') - Date.parse(e.start?.dateTime ?? '')) / 60_000
    return Number.isFinite(m) ? Math.max(0, Math.round(m)) : 0
  }
  const named = p.mail?.filter(mailWorthNaming).sort((a, b) => mailRank(a) - mailRank(b)) ?? []
  return {
    asOf: p.now.toISOString(),
    events: p.events
      ?.filter(e => e.status !== 'cancelled')
      .map(e => ({ e, at: Date.parse(e.start?.dateTime ?? `${e.start?.date}T00:00:00`) }))
      .filter(({ at }) => !Number.isNaN(at))
      .map(({ e, at }) => ({ title: e.summary ?? 'untitled', start: new Date(at).toISOString(), minutes: minutes(e) })) ?? null,
    inbox: p.mail ? named.slice(0, 5).map(t => ({ from: (t.from ?? '').replace(/<.*>/, '').trim(), subject: t.subject ?? '' })) : null,
    bulk: p.mail ? p.mail.length - named.length : 0,
    loops: p.loops.slice(0, 5).map(n => ({ title: n.text, ...(n.due ? { due: n.due } : {}) })),
    triggers: p.triggers
      .filter(t => t.nextRun)
      .slice(0, 6)
      .map(t => ({ title: gistOf(t.gist), next: new Date(t.nextRun!).toISOString() })),
  }
}

export type GatherOpts = {
  account: string
  /** Optional extras the caller computes; omitted when there is nothing to say. */
  resume?: string
  spend?: string
  trip?: string
  notes: Note[]
  triggers: TriggerGist[]
  history: HistoryLine[]
  now?: Date
  projectsRoot?: string
}

/** Everything at once — one slow source must not serialize the others. */
export async function gatherBrief(o: GatherOpts): Promise<{ text: string; busyUntil?: string; data: BriefData }> {
  const now = o.now ?? new Date()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

  const [events, mail, playing, ws] = await Promise.all([
    calendarToday(o.account),
    recentMail(o.account),
    nowPlaying(),
    probeWorkspace(o.projectsRoot).then(formatWorkspace).catch(() => undefined),
  ])

  const parts: BriefParts = {
    now, tz, events, mail, playing,
    loops: dueLoops(o.notes, now.getTime(), 7 * 24 * 60 * 60 * 1000).slice(0, 5)
      .concat(searchNotes(o.notes, { kind: 'loop', limit: 5 }).filter(n => !n.due))
      .slice(0, 5),
    facts: searchNotes(o.notes, { kind: 'fact', limit: 6 }),
    triggers: o.triggers,
    history: o.history,
    ...(ws ? { workspace: ws } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
    ...(o.spend ? { spend: o.spend } : {}),
    ...(o.trip ? { trip: o.trip } : {}),
  }
  const text = formatBrief(parts)

  return { text, data: briefData(parts), ...(events ? { busyUntil: busyUntil(events, now.getTime()) } : {}) }
}

if (import.meta.main) {
  const stateDir = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
  const notes = loadNotes(join(stateDir, 'notes.json'))
  let triggers: TriggerGist[] = []
  try {
    triggers = (JSON.parse(readFileSync(join(stateDir, 'triggers.json'), 'utf8')) as {
      id: string; action: string; enabled: boolean; nextRun?: number
    }[])
      .filter(t => t.enabled && t.nextRun)
      .sort((a, b) => (a.nextRun ?? 0) - (b.nextRun ?? 0))
      .slice(0, 6)
      .map(t => ({ id: t.id, gist: t.action, ...(t.nextRun ? { nextRun: t.nextRun } : {}) }))
  } catch {}
  const trip = formatTripMode(loadTrips(join(stateDir, 'trips.json')), Date.now(), {
    stamp: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
  })
  const { text } = await gatherBrief({
    account: process.env.OTTO_GOOGLE_ACCOUNT ?? '',
    notes, triggers, history: [],
    ...(trip ? { trip } : {}),
  })
  console.log(text)
}
