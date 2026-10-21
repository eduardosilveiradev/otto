/**
 * Keep-in-touch nudges.
 *
 * The cadence is something the user states, never something inferred. The
 * rhythm people.ts measures (`cadenceDrift`) needs a history of contacts, and in
 * practice that history is empty for everyone: the graph holds only what they
 * told Otto. So the only person who can be nudged is one they said they want to
 * stay in touch with, and how often. Nobody else is ever raised.
 *
 * Two budgets keep it from becoming the nag it exists to prevent. Each person
 * gets one nudge per cadence period (the clock restarts at the nudge, so an
 * ignored one comes back a full period later, not tomorrow). And across everyone
 * at most `weeklyCap` go out in any seven days, most overdue first, the rest
 * waiting for next hour's check.
 *
 * Snooze and stop are settled here, in the channel, from the button's own text:
 * a tap comes back days later with no conversation behind it, and neither needs
 * the session to answer.
 */
import { homedir } from 'os'
import { join } from 'path'
import { loadState, saveState } from './statefile.ts'
import { fitButton } from './birthdays.ts'

const DAY_MS = 86_400_000
const SNOOZE_DAYS = 30

/**
 * "weekly", "every 6 weeks", "45" → days; "off" → 'off'; anything else, or a
 * period under a day, → undefined so the caller can say what it accepts.
 */
export function parseCadence(raw: string): number | 'off' | undefined {
  const s = raw.trim().toLowerCase()
  if (['off', 'never', 'stop'].includes(s)) return 'off'
  const named: Record<string, number> = { weekly: 7, fortnightly: 14, biweekly: 14, monthly: 30, quarterly: 90, yearly: 365 }
  if (s in named) return named[s]
  let days: number
  const m = s.match(/^every (\d+) (day|week|month)s?$/)
  if (m) days = Number(m[1]) * { day: 1, week: 7, month: 30 }[m[2] as 'day' | 'week' | 'month']
  else if (/^\d+$/.test(s)) days = Number(s)
  else return undefined
  return days >= 1 ? days : undefined
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Person id → when they were last nudged, and until when they are snoozed. */
export type KeepInTouchState = Record<string, { nudgedAt?: string; snoozedUntil?: string }>

export const KEEPINTOUCH_FILE = join(process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'), 'keepintouch.json')

export const loadKitState = (file: string): KeepInTouchState =>
  loadState(file, () => ({}), v => !!v && typeof v === 'object' && !Array.isArray(v))

export const saveKitState = (file: string, s: KeepInTouchState): void => saveState(file, s)

// ---------------------------------------------------------------------------
// Who is due
// ---------------------------------------------------------------------------

/** The slice of a people.ts Person this module reads; people.ts stays the owner. */
export type KitPerson = { id: string; name?: string; cadenceDays?: number; lastTouch?: string; contacts: string[] }

export type KitHit<P extends KitPerson = KitPerson> = { person: P; sinceDays: number; cadenceDays: number }

/**
 * The moment the clock last restarted: the later of when they said they spoke,
 * any contact on record, the last nudge and the end of a snooze. A snooze that
 * has run out counts as a restart, so snoozing "a month" buys a month of quiet
 * and then one nudge, not an immediate one.
 */
export function anchorFor(p: KitPerson, rec?: KeepInTouchState[string]): number | undefined {
  const times = [p.lastTouch, ...p.contacts, rec?.nudgedAt, rec?.snoozedUntil]
    .map(t => (t ? Date.parse(t) : NaN)).filter(t => !Number.isNaN(t))
  return times.length ? Math.max(...times) : undefined
}

export function keepInTouchDue<P extends KitPerson>(
  people: P[], state: KeepInTouchState, now: number, o: { weeklyCap: number; skip?: Set<string> },
): KitHit<P>[] {
  const recent = (r?: KeepInTouchState[string]) => !!r?.nudgedAt && now - Date.parse(r.nudgedAt) < 7 * DAY_MS
  const sent = Object.values(state).filter(r => recent(r)).length
  const room = Math.max(0, o.weeklyCap - sent)
  if (!room) return []
  const hits: KitHit<P>[] = []
  for (const person of people) {
    const cadenceDays = person.cadenceDays
    if (!cadenceDays || cadenceDays < 1 || o.skip?.has(person.id)) continue
    const rec = state[person.id]
    // One nudge per person per week whatever the cadence: each record holds only
    // the latest nudge, so this is what keeps the count above honest.
    if (recent(rec)) continue
    if (rec?.snoozedUntil && Date.parse(rec.snoozedUntil) > now) continue
    const anchor = anchorFor(person, rec)
    if (anchor === undefined) continue
    const sinceDays = Math.floor((now - anchor) / DAY_MS)
    if (sinceDays >= cadenceDays) hits.push({ person, sinceDays, cadenceDays })
  }
  return hits.sort((a, b) => b.sinceDays / b.cadenceDays - a.sinceDays / a.cadenceDays).slice(0, room)
}

/** Stamp before sending, so a failed send cannot become a repeat. */
export function markKitNudged(state: KeepInTouchState, id: string, at = new Date().toISOString()): void {
  state[id] = { ...state[id], nudgedAt: at }
  delete state[id].snoozedUntil
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export function describeCadence(days: number): string {
  return ({ 7: 'weekly', 14: 'fortnightly', 30: 'monthly', 90: 'quarterly' } as Record<number, string>)[days] ?? `every ${days} days`
}

function span(days: number): string {
  if (days < 14) return `${days} days`
  if (days < 60) return `${Math.round(days / 7)} weeks`
  return `${Math.round(days / 30)} months`
}

export type KitNudge = { text: string; buttons: { label: string; data: string }[] }

/** The buttons carry the name, because the tap that comes back has nothing else. */
export function formatKitNudge(h: KitHit, displayName: string): KitNudge {
  return {
    text: `It's been ${span(h.sinceDays)} since you last spoke to ${displayName} — you said ${describeCadence(h.cadenceDays)}.`,
    buttons: [
      { label: 'draft a message', data: fitButton(n => `draft a check-in message to ${n}`, displayName) },
      { label: 'snooze a month', data: fitButton(n => `snooze check-ins with ${n} for a month`, displayName) },
      { label: 'stop for them', data: fitButton(n => `stop check-ins with ${n}`, displayName) },
    ],
  }
}

// ---------------------------------------------------------------------------
// Taps
// ---------------------------------------------------------------------------

export const KIT_TAP_RE = /^(snooze|stop) check-ins with (.+?)(?: for a month)?$/

export function parseKitTap(instruction: string): { kind: 'snooze' | 'stop'; name: string } | undefined {
  const m = instruction.trim().match(KIT_TAP_RE)
  return m ? { kind: m[1] as 'snooze' | 'stop', name: m[2] } : undefined
}

/**
 * Settle a snooze or stop. Undefined when the name matches nobody (or more than
 * one), which sends the tap on to the session instead of guessing. Stop keeps
 * `lastTouch`: they did speak to them, and that stays true.
 */
export function applyKitTap<P extends KitPerson & { notes?: { at: string; text: string }[] }>(
  people: P[], state: KeepInTouchState, tap: { kind: 'snooze' | 'stop'; name: string }, now: number,
  find: (name: string) => P | undefined,
): { line: string; peopleChanged: boolean; stateChanged: boolean } | undefined {
  const person = find(tap.name)
  if (!person) return undefined
  const name = person.name ?? tap.name
  if (tap.kind === 'snooze') {
    const until = new Date(now + SNOOZE_DAYS * DAY_MS)
    state[person.id] = { ...state[person.id], snoozedUntil: until.toISOString() }
    const day = until.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    return { line: `ok — nothing about ${name} until ${day}`, peopleChanged: false, stateChanged: true }
  }
  const text = `check-ins stopped (was every ${person.cadenceDays}d)`
  const had = person.cadenceDays !== undefined
  delete person.cadenceDays
  if (had && !person.notes?.some(n => n.text === text)) (person.notes ??= []).push({ at: new Date(now).toISOString(), text })
  // The nudge they are answering still counts toward this week's cap.
  const nudgedAt = state[person.id]?.nudgedAt
  if (nudgedAt) state[person.id] = { nudgedAt }
  else delete state[person.id]
  return { line: `ok — no more check-in nudges for ${name}`, peopleChanged: true, stateChanged: true }
}
