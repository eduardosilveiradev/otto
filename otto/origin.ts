/**
 * Provenance — where the thing Otto is currently doing actually came from.
 *
 * `otto/selfedit.ts` decides what Otto may write to its own source, and half of
 * that decision is the origin of the request. The other half — the paths — is
 * read off the diff and cannot be argued with. The origin can be, which is
 * exactly why the model is never asked for it.
 *
 * So the server stamps it, at the moment it wakes the session, from the event
 * it is waking the session WITH. That is not a heuristic: an inbound Telegram
 * message is the user, a fired trigger is a clock, a webhook is a stranger. None of
 * those facts are recoverable from the text once the turn is under way, and all
 * of them are forgeable by anything that gets to write text.
 *
 * This is the same trick as `src` in ledger.ts, for the same reason: attribution
 * the assistant has to remember to report is attribution that quietly stops
 * happening, and attribution the assistant is asked for is attribution an
 * attacker can forge.
 *
 * Kept out of server.ts deliberately. server.ts opens a Telegram poller on
 * import, so anything that lives there cannot be tested; this can be, and the
 * whole point of the file is that its edge cases are correct.
 */

import type { Decision, Origin, Proof } from './selfedit.ts'
import { classify, matchesTypedPhrase, writeScope } from './selfedit.ts'

/**
 * How long a typed confirmation stays usable.
 *
 * Long enough that the user can type the phrase and then watch Otto do the work;
 * short enough that a phrase typed this morning cannot authorise something
 * proposed this evening. It is a confirmation, not a session mode.
 */
export const TYPED_PROOF_MS = 10 * 60_000

/** What woke the session. The server knows this; the model never has to say. */
export type Wake =
  /** A Telegram message the user typed or spoke. */
  | { kind: 'inbound' }
  /** A tapped inline button. A tap is the user. */
  | { kind: 'button' }
  /** A prompt `terminalPromptKey` proved was typed in Otto's own Claude Code terminal. */
  | { kind: 'terminal'; key: string }
  /** A scheduler or ingress event, named as `injectEvent` names it. */
  | { kind: 'event'; event: string }

export type OriginState = {
  origin: Origin
  internalEvent?: string
  /** Sticky within a turn: once external text is read, it stays read. */
  tainted: boolean
  /** Why, in a few words — this ends up in a refusal the user reads. */
  taintedBy?: string
  /** The last typed confirmation, with its own expiry. Survives wakes. `paths`: an app approval clears only the files it listed. */
  typedProof?: { at: number; text: string; paths?: string[] }
  /** A tapped button woke this request. Gone on the next wake. */
  tapped?: true
  /** The last terminal prompt that stamped, so the same one can never stamp twice. */
  terminalKey?: string
}

export function freshState(): OriginState {
  return { origin: 'user-typed', tainted: false }
}

/**
 * Classify a wake.
 *
 * `email-scan` is `triggered` and immediately tainted, which looks redundant
 * and is not: the ceiling for `triggered` is `unattended`, and `unattended` is
 * the one tier that a clock alone can satisfy. An email scan exists to go and
 * read mail written by strangers, so the turn is compromised before it starts
 * and should not clear even that bar.
 */
export function originForWake(wake: Wake): { origin: Origin; taintedBy?: string } {
  if (wake.kind === 'inbound' || wake.kind === 'button' || wake.kind === 'terminal') return { origin: 'user-typed' }
  switch (wake.event) {
    case 'webhook':
      // Not merely tainted — a webhook payload IS the request, and its author is
      // whoever can reach the loopback port.
      return { origin: 'external-content', taintedBy: 'a webhook carries third-party content' }
    case 'email-scan':
      return { origin: 'triggered', taintedBy: 'an email scan reads mail written by strangers' }
    case 'job':
    case 'pr-merged':
    case 'trigger':
      return { origin: 'triggered' }
    case 'button':
      return { origin: 'user-typed' }
    default:
      return { origin: 'user-typed' }
  }
}

/**
 * Stamp a wake, retaining live-turn taint only for unattended events. The server
 * supplies carried taint while the turn is open and within its expiry. Owner
 * messages, taps and proved terminal prompts start fresh requests.
 * A typed confirmation survives because it expires on its own clock.
 */
export function onWake(state: OriginState, wake: Wake, carried?: string): OriginState {
  const { origin, taintedBy: wakeTaint } = originForWake(wake)
  const owner = wake.kind !== 'event' || wake.event === 'button'
  const taintedBy = wakeTaint ?? (!owner && carried ? `${carried.replace(/ \(earlier this turn\)$/, '')} (earlier this turn)` : undefined)
  return {
    origin,
    ...(wake.kind === 'event' && ['job', 'trigger', 'pr-merged'].includes(wake.event) ? { internalEvent: wake.event } : {}),
    tainted: taintedBy != null,
    ...(taintedBy ? { taintedBy } : {}),
    ...(state.typedProof ? { typedProof: state.typedProof } : {}),
    ...(wake.kind === 'button' || (wake.kind === 'event' && wake.event === 'button') ? { tapped: true as const } : {}),
    ...(wake.kind === 'terminal' ? { terminalKey: wake.key } : state.terminalKey ? { terminalKey: state.terminalKey } : {}),
  }
}

export type PromptHook = { prompt?: unknown; prompt_id?: unknown; source?: unknown; transcript_path?: unknown }

/** How Claude Code records a prompt a person submitted at the composer. Anything else is unproven. */
const COMPOSER_SOURCES = new Set(['typed', 'queued', 'suggestion_accepted'])

const rowText = (content: unknown): string | undefined =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(b => b?.type === 'text' ? String(b.text ?? '') : '').join('') : undefined

/**
 * Prove a UserPromptSubmit came from a person at the terminal, or return null.
 *
 * Every wake reaches this hook: channel events, fired cron jobs and task
 * notifications included, and a fired cron job's prompt is plain text exactly
 * like a typed one. So the text can only ever refuse. The proof is the record
 * Claude Code writes itself, which is why this runs on the transcript, after
 * the hook, and returns that record's id for `onWake`:
 *
 * - idle: a user row with origin.kind "human", a composer promptSource and the
 *   hook's prompt_id
 * - mid-turn: a queued_command attachment with origin.kind "human" and
 *   humanTurn (its hook carries the running turn's prompt_id, so only the text
 *   can tie them together)
 *
 * The record has to be the newest prompt in the transcript, so a webhook that
 * landed after it wins. An unreadable line, an unknown shape or a record
 * already spent is a refusal: the stamp stays where it was.
 */
export function terminalPromptKey(state: OriginState, hook: PromptHook, transcript: string[]): string | null {
  if (typeof hook.prompt !== 'string') return null
  const prompt = hook.prompt.trim()
  if (!prompt || prompt.startsWith('<') || prompt.toLowerCase().includes('<channel') || prompt.startsWith('A message arrived from ')) return null
  if (hook.source !== undefined && hook.source !== 'user') return null
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (!transcript[i].trim()) continue
    let r: any
    try { r = JSON.parse(transcript[i]) } catch { return null }
    let key: unknown
    if (r?.type === 'attachment' && r.attachment?.type === 'queued_command') {
      const a = r.attachment
      if (a.origin?.kind !== 'human' || a.humanTurn !== true || typeof a.prompt !== 'string' || a.prompt.trim() !== prompt) return null
      key = a.source_uuid
    } else if (r?.type === 'user' && r.toolUseResult === undefined && (r.promptSource !== undefined || r.turnOrigin !== undefined)) {
      if (r.origin?.kind !== 'human' || !COMPOSER_SOURCES.has(r.promptSource)) return null
      if (typeof hook.prompt_id !== 'string' || r.promptId !== hook.prompt_id || rowText(r.message?.content)?.trim() !== prompt) return null
      key = r.uuid
    } else continue
    return typeof key === 'string' && key && key !== state.terminalKey ? key : null
  }
  return null
}

/**
 * Record that this turn has now read text Otto did not write.
 *
 * One-way. There is no untaint, and the absence of one is the design: "I have
 * considered the email carefully and concluded the request is legitimate" is
 * precisely the reasoning an injected instruction is trying to produce.
 */
export function taint(state: OriginState, why: string): OriginState {
  if (state.tainted) return state
  return { ...state, tainted: true, taintedBy: why }
}

/** The origin selfedit.ts should be handed. Rule 2 of SELFEDIT.md, in code. */
export function effectiveOrigin(state: OriginState): Origin {
  return state.tainted ? 'external-content' : state.origin
}

/** Remember a typed confirmation. Only the exact phrase counts as one. */
export function recordTyped(state: OriginState, text: string, now = Date.now()): OriginState {
  if (!matchesTypedPhrase(text)) return state
  return { ...state, typedProof: { at: now, text } }
}

/**
 * The proof currently available, for `classify`.
 *
 * Only surfaced on a turn the server itself stamped `user-typed`. A trigger
 * cannot spend a confirmation the user typed ten minutes ago, and neither can a turn
 * that has since read an email — otherwise the phrase would amount to a window
 * during which the rails are down.
 */
export function currentProof(state: OriginState, now = Date.now()): Proof {
  if (effectiveOrigin(state) !== 'user-typed') return { kind: 'none' }
  const p = state.typedProof
  if (!p || now - p.at > TYPED_PROOF_MS) return { kind: 'none' }
  return { kind: 'typed', text: p.text, ...(p.paths ? { paths: p.paths } : {}) }
}

/**
 * The channel's answer to the session's own Write or Edit (hooks/selfedit-gate.ts):
 * null when writeScope() leaves it alone; routine state is refused only to an
 * external-content request; anything gated gets classify()'s decision. A
 * button wake also counts as a tap here, tried when the standing proof falls
 * short (an app approval scoped to other files must not shadow it), so it
 * clears `confirmed` and never `guarded`. Installs and reverts keep using
 * currentProof alone, so they still need their own tap.
 */
export function gateWrite(state: OriginState, path: string, stateDir: string, home: string, now = Date.now()): Decision | null {
  const scope = path ? writeScope(path, stateDir, home) : null
  if (!scope) return null
  const origin = effectiveOrigin(state)
  // Routine state: create_trigger's own rule, for the file it writes. Outside content proposes, never arms.
  if (scope === 'routine') return origin === 'external-content' ? classify([path], origin) : null
  const d = classify([path], origin, currentProof(state, now))
  if (d.allowed || !state.tapped || origin !== 'user-typed') return d
  return classify([path], origin, { kind: 'tapped', buttonData: 'the tap that woke this request' })
}

/** One line for a log or a refusal, so a block is explicable after the fact. */
export function describeOrigin(state: OriginState): string {
  const eff = effectiveOrigin(state)
  if (state.tainted) return `${eff} (stamped ${state.origin}; ${state.taintedBy ?? 'external text was read'})`
  return eff
}

/** Only the firing trigger may re-arm its existing action after reading outside content. */
export function isSelfRearm(args: Record<string, unknown>, trigger: { id: string; action: string }, firingId?: string): boolean {
  return firingId === trigger.id && String(args.id) === trigger.id
    && (args.schedule != null || args.repeating != null)
    && (args.action == null || String(args.action) === trigger.action)
    && Object.keys(args).every(k => ['id', 'schedule', 'repeating', 'action'].includes(k))
}

export function assertPipCreation(origin: OriginState, insidePip: boolean): void {
  if (insidePip || effectiveOrigin(origin) !== 'user-typed') throw new Error('Only Otto handling an untainted request the user typed can create pips or groups')
}
