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

import type { Origin, Proof } from './selfedit.ts'
import { matchesTypedPhrase } from './selfedit.ts'

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
  /** A scheduler or ingress event, named as `injectEvent` names it. */
  | { kind: 'event'; event: string }

export type OriginState = {
  origin: Origin
  /** Sticky within a turn: once external text is read, it stays read. */
  tainted: boolean
  /** Why, in a few words — this ends up in a refusal the user reads. */
  taintedBy?: string
  /** The last typed confirmation, with its own expiry. Survives wakes. */
  typedProof?: { at: number; text: string }
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
  if (wake.kind === 'inbound' || wake.kind === 'button') return { origin: 'user-typed' }
  switch (wake.event) {
    case 'webhook':
      // Not merely tainted — a webhook payload IS the request, and its author is
      // whoever can reach the loopback port.
      return { origin: 'external-content' }
    case 'email-scan':
      return { origin: 'triggered', taintedBy: 'an email scan reads mail written by strangers' }
    case 'trigger':
      return { origin: 'triggered' }
    case 'button':
      return { origin: 'user-typed' }
    default:
      return { origin: 'user-typed' }
  }
}

/**
 * Start a new turn. Taint does not survive the wake that set it — it is a
 * property of what this turn has read, and the next turn has read nothing yet.
 * A typed confirmation does survive, because it expires on its own clock.
 */
export function onWake(state: OriginState, wake: Wake): OriginState {
  const { origin, taintedBy } = originForWake(wake)
  return {
    origin,
    tainted: taintedBy != null,
    ...(taintedBy ? { taintedBy } : {}),
    ...(state.typedProof ? { typedProof: state.typedProof } : {}),
  }
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
  return { kind: 'typed', text: p.text }
}

/** One line for a log or a refusal, so a block is explicable after the fact. */
export function describeOrigin(state: OriginState): string {
  const eff = effectiveOrigin(state)
  if (state.tainted) return `${eff} (stamped ${state.origin}; ${state.taintedBy ?? 'external text was read'})`
  return eff
}
