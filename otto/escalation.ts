/**
 * How many times may one open loop interrupt the user?
 *
 * Two, ever. That is the whole design.
 *
 * Loops today have exactly one behaviour: they sit in the brief, and whichever
 * sweep reads the brief may decide to mention them. Nothing tracks whether a
 * given loop has already been raised, so a loop with a due date is either
 * mentioned on every single sweep — which is nagging, and which they will learn to
 * skim past — or forgotten entirely because no sweep happened to think it was
 * worth the interruption that day. Both failure modes come from the same hole:
 * the loop has no memory of how loudly it has already spoken.
 *
 * So a due-dated loop walks a fixed curve instead:
 *
 *   quiet          more than two days out. It lives in the brief and nowhere else.
 *   digest         inside two days. One mention, riding a message they were already
 *                  getting. Costs no notification.
 *   morning        the morning it is due. One real interruption, with buttons.
 *   overdue-check  a day past due, once. "Is this dead?" with buttons.
 *   exhausted      it has had its two interruptions. It stays in the brief until
 *                  it is closed, and it never buzzes again.
 *
 * The cap is structural rather than advisory: `exhausted` has no successor
 * stage, so no future sweep can talk itself into one more nudge. If a loop
 * genuinely needs to keep speaking after that, the honest move is to convert it
 * into a trigger they armed on purpose, which is a decision they make rather than
 * one a sweep makes for them.
 *
 * Loops with no due date never escalate at all. They never gave it a deadline,
 * so Otto inventing urgency for them would be inventing information.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'

export type Stage = 'quiet' | 'digest' | 'morning' | 'overdue-check' | 'exhausted'

export type LoopLike = {
  id: string
  due?: string
  status?: string
  text?: string
}

export type EscalationRecord = {
  /** Stages already delivered, in order. */
  fired: Stage[]
  lastAt: string
}

export type EscalationState = Record<string, EscalationRecord>

export type Plan = {
  stage: Stage
  /** True only for stages that are allowed to cost them a notification. */
  interrupt: boolean
  /** Buttons the interrupting stages should carry, as label/data pairs. */
  buttons: { label: string; data: string }[]
  why: string
}

const DAY = 24 * 60 * 60 * 1000
/** How far ahead a loop starts riding the digest. */
export const DIGEST_LEAD_MS = 2 * DAY
/** Local hours that count as "the morning of". */
export const MORNING_FROM = 7
export const MORNING_TO = 12

/** A due with no time on it: a calendar day where they are, not an instant. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * The stage this loop is entitled to right now, or null when it should stay
 * silent. Pure: the caller supplies the clock and the local hour, because the
 * country they are in changes what "morning" means and that is not this file's
 * problem to guess.
 */
export function planLoop(
  loop: LoopLike,
  state: EscalationState,
  opts: { now: number; localHour: number; today?: string },
): Plan | null {
  if ((loop.status ?? 'open') !== 'open') return null
  if (!loop.due) return null
  const due = Date.parse(loop.due)
  if (Number.isNaN(due)) return null

  const fired = state[loop.id]?.fired ?? []
  const has = (s: Stage) => fired.includes(s)
  // The curve only ever moves forward. Without this, a loop that has already
  // had its morning nudge would fall back to offering a digest mention, which
  // reads as the escalation going into reverse.
  const ORDER: Stage[] = ['quiet', 'digest', 'morning', 'overdue-check']
  const reached = fired.reduce((max, s) => Math.max(max, ORDER.indexOf(s)), -1)
  const ahead = (s: Stage) => ORDER.indexOf(s) > reached
  if (has('overdue-check')) {
    return { stage: 'exhausted', interrupt: false, buttons: [], why: 'already had its two interruptions' }
  }

  const { now, localHour } = opts
  const msToDue = due - now
  const overdueBy = -msToDue
  // A bare date parses as midnight UTC, so a 24-hour window around that
  // instant made "2026-10-12" come due the morning of the 11th. Compare it as a
  // calendar day against the caller's local date instead.
  const dateOnly = DATE_ONLY.test(loop.due)
  const today = opts.today ?? new Date(now).toISOString().slice(0, 10)
  const daysPast = Math.round((Date.parse(today) - due) / DAY)

  // A day past due, once: is this still a thing?
  if (dateOnly ? daysPast >= 1 : overdueBy >= DAY) {
    return {
      stage: 'overdue-check',
      interrupt: true,
      buttons: buttonsFor('overdue-check', loop),
      why: `${Math.floor(overdueBy / DAY)}d overdue and never closed`,
    }
  }

  // The morning it comes due — the one nudge that is actually actionable.
  const sameDay = dateOnly ? daysPast === 0 : msToDue <= DAY && msToDue > -DAY
  if (sameDay && localHour >= MORNING_FROM && localHour < MORNING_TO && !has('morning')) {
    return { stage: 'morning', interrupt: true, buttons: buttonsFor('morning', loop), why: 'due today' }
  }

  // Inside two days: one free mention on something they were already being sent.
  if (msToDue <= DIGEST_LEAD_MS && ahead('digest')) {
    return { stage: 'digest', interrupt: false, buttons: [], why: 'due within two days' }
  }

  if (msToDue > DIGEST_LEAD_MS) {
    return { stage: 'quiet', interrupt: false, buttons: [], why: 'more than two days out' }
  }

  // Inside the window but this stage is spent, and the next one is not due yet.
  return null
}

/**
 * Button data is written as trigger action text on purpose: a tap can arrive
 * days later or after a restart, so it has to carry the whole instruction.
 */
export function buttonsFor(stage: Stage, loop: LoopLike): { label: string; data: string }[] {
  if (stage === 'morning') {
    return [
      { label: 'done', data: `close loop ${loop.id} as done` },
      { label: 'tomorrow', data: `move loop ${loop.id} due date to tomorrow` },
      { label: 'drop it', data: `close loop ${loop.id} as dropped` },
    ]
  }
  if (stage === 'overdue-check') {
    return [
      { label: 'done', data: `close loop ${loop.id} as done` },
      { label: 'still live', data: `keep loop ${loop.id} open and clear its due date` },
      { label: 'drop it', data: `close loop ${loop.id} as dropped` },
    ]
  }
  return []
}

/**
 * The action text for one escalation event.
 *
 * A cold agent will read this having never seen the loop, so it carries the id,
 * the text, the deadline and the exact button payloads. The last line is the
 * cap, spelled out: without it a session looking at an overdue loop will offer
 * to remind the user again, which is how a two-interruption budget quietly becomes
 * unbounded.
 */
export function formatEscalation(
  batch: { loop: LoopLike; plan: Plan }[],
  opts: { chat?: string } = {},
): string {
  const lines = batch.map(({ loop, plan }) => [
    `- [${loop.id}] ${loop.text ?? ''}${loop.due ? ` (due ${loop.due.slice(0, 10)})` : ''} — ${plan.why}`,
    `  buttons: ${plan.buttons.map(b => `${b.label} → "${b.data}"`).join(', ')}`,
  ].join('\n'))

  return [
    batch.length === 1
      ? 'An open loop has come due and is allowed one interruption now.'
      : `${batch.length} open loops have come due and are allowed one interruption now.`,
    '',
    ...lines,
    '',
    opts.chat
      ? `Send the user one short message covering all of it, with the buttons above attached, to chat_id ${opts.chat}. priority "urgent" — these are things they asked to be held to.`
      : '',
    'Say what is due and what they owe on it. Do not explain why you are mentioning it now.',
    'If a loop is plainly already handled — you closed it, or the thing it was waiting on arrived — close it with remember(kind:"loop", status:"done") and say nothing about that one.',
    'This is the last time these loops may interrupt the user. Do not offer to remind them again; if they want that, they arm a trigger.',
  ].filter(Boolean).join('\n')
}

export function recordStage(
  state: EscalationState,
  loopId: string,
  stage: Stage,
  now = Date.now(),
): EscalationState {
  const rec = state[loopId] ?? { fired: [], lastAt: '' }
  if (!rec.fired.includes(stage)) rec.fired.push(stage)
  rec.lastAt = new Date(now).toISOString()
  state[loopId] = rec
  return state
}

/** Escalation state for loops that no longer exist is dead weight. */
export function pruneEscalation(state: EscalationState, liveIds: Iterable<string>): EscalationState {
  const live = new Set(liveIds)
  for (const id of Object.keys(state)) if (!live.has(id)) delete state[id]
  return state
}

export function loadEscalation(file: string): EscalationState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as EscalationState) : {}
  } catch {
    return {}
  }
}

export function saveEscalation(file: string, state: EscalationState): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * Everything due for an interruption right now, loudest first. The caller still
 * decides whether to send: this says what is *allowed*, not what is wise.
 */
export function dueForInterruption(
  loops: LoopLike[],
  state: EscalationState,
  opts: { now: number; localHour: number; today?: string },
): { loop: LoopLike; plan: Plan }[] {
  const out: { loop: LoopLike; plan: Plan }[] = []
  for (const loop of loops) {
    const plan = planLoop(loop, state, opts)
    if (plan?.interrupt) out.push({ loop, plan })
  }
  const rank: Record<string, number> = { 'overdue-check': 0, morning: 1 }
  return out.sort((a, b) => (rank[a.plan.stage] ?? 9) - (rank[b.plan.stage] ?? 9))
}
