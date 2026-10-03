/**
 * Which model should do this bit of work.
 *
 * Otto's main session is an Opus turn with a 2200-character brief attached and
 * a full tool surface loaded. That is the right shape for talking to the user
 * and the wrong shape for deciding whether a Ryanair receipt counts as
 * marketing — which the email scan does forty times a day, on text it has
 * already fetched, against a rule that fits in a sentence.
 *
 * The mistake to avoid is a single fixed cheap model. "Cheap" is not a property
 * of a workload, it is a property of a workload's hardest instance: reading a
 * price off a static page is Haiku work, reading a price off a page that moved
 * its layout is not, and a shadow evaluation of a drafted trigger is neither.
 * So the router looks at the item and picks a tier, and the cheap tier gets to
 * say "this needs a real turn" without being overruled.
 *
 * Three tiers:
 *   haiku    mechanical, bounded, one rule, short input
 *   sonnet   still mechanical but the input is long, messy, or visual
 *   main     anything that will produce words the user reads, or touches state
 *
 * The routing rule is pure and tested here; the spawning is plumbing and lives
 * in server.ts. Nothing in this file talks to the network.
 */

/** Current ids. Aliases would drift under us on a release; pin the exact strings. */
export const HAIKU = 'claude-haiku-4-5-20251001'
export const SONNET = 'claude-sonnet-5'
/** Not a model id — the main session handles it inline, with its own context. */
export const MAIN = 'main-session'

export type ModelId = typeof HAIKU | typeof SONNET | typeof MAIN

/** The mechanical jobs worth routing away from the main session at all. */
export type TriageKind =
  /** "is this inbox item worth waking the user for" — one rule, one email. */
  | 'scan-classification'
  /** price-watch and friends: read one value off a page Otto already fetched. */
  | 'watch-page'
  /** run a drafted recipe against a past event and say what it would have done. */
  | 'shadow-eval'
  /** summarise a forwarded link or PDF well enough to store as a `saved` note. */
  | 'clipping-summary'
  /** anything not on this list. */
  | 'other'

export type TriageItem = {
  kind: TriageKind
  /** Characters of input the model has to read. */
  chars: number
  /** Images or PDFs in the payload — no text-only shortcut available. */
  attachments?: number
  /** The output is shown to the user as written, not re-processed by Otto. */
  userFacing?: boolean
  /** The result causes a write: a trigger, a note, a calendar event. */
  writes?: boolean
  /** A previous cheap attempt on this same item failed or escalated. */
  retryOf?: ModelId
}

export type Route = {
  model: ModelId
  /** One clause, logged next to the spend so a bad rule is findable later. */
  why: string
}

/** Above this, a Haiku context window stops being the cheap option. */
const HAIKU_CHARS = 6_000
/** Above this it is not mechanical work any more, whatever it was labelled. */
const SONNET_CHARS = 120_000

/**
 * Route one item.
 *
 * The order of the guards is the whole rule, and it is deliberately
 * conservative at the top: anything the user will read, and anything that writes,
 * goes to the main session regardless of how short it looks. A one-line
 * Telegram message is cheap in tokens and expensive in trust.
 */
export function routeModel(item: TriageItem): Route {
  if (item.userFacing) return { model: MAIN, why: 'the user reads the output as written' }
  if (item.writes) return { model: MAIN, why: 'it writes state' }
  if (item.kind === 'other') return { model: MAIN, why: 'not a known mechanical job' }

  // A cheap attempt that already failed does not get a second identical try.
  if (item.retryOf === HAIKU) return { model: SONNET, why: 'haiku escalated' }
  if (item.retryOf === SONNET) return { model: MAIN, why: 'sonnet escalated' }

  if (item.chars > SONNET_CHARS) return { model: MAIN, why: `${item.chars} chars is past mechanical` }

  // Shadow evaluation is judgement about judgement — it asks whether a drafted
  // behaviour would have been *right*, which is the one thing Haiku is worst at.
  if (item.kind === 'shadow-eval') return { model: SONNET, why: 'evaluating a draft is a judgement call' }

  if (item.attachments) return { model: SONNET, why: 'has attachments to look at' }
  if (item.chars > HAIKU_CHARS) return { model: SONNET, why: `${item.chars} chars is past haiku's sweet spot` }

  return { model: HAIKU, why: `${item.kind}, ${item.chars} chars, one rule` }
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/**
 * What a cheap tier is allowed to say back.
 *
 * `verdict` is the answer; `escalate` is the cheap model declining to be the
 * one who decides. Keeping those separate is what stops the tier from being a
 * quality downgrade: the small model's job includes recognising its own limit,
 * and the router honours that rather than second-guessing it.
 */
export type CheapVerdict = {
  /** Free text answer, or null when it refused to answer. */
  verdict: string | null
  /** The cheap model asking for a human-grade turn. */
  escalate?: boolean
  /** 0..1. Absent is treated as "did not say", not as "certain". */
  confidence?: number
  /** Set when the run itself broke — timeout, bad JSON, non-zero exit. */
  error?: string
}

/** Below this a stated confidence is not worth acting on unreviewed. */
const CONFIDENCE_FLOOR = 0.6

export function shouldEscalate(v: CheapVerdict): boolean {
  if (v.error) return true
  if (v.escalate) return true
  if (v.verdict === null) return true
  if (v.confidence !== undefined && v.confidence < CONFIDENCE_FLOOR) return true
  return false
}

/** The next tier up, or null when there is nowhere left to escalate. */
export function nextTier(model: ModelId): ModelId | null {
  if (model === HAIKU) return SONNET
  if (model === SONNET) return MAIN
  return null
}

/**
 * The full loop as data: route, then re-route on escalation until the main
 * session owns it. Returned as a plan rather than executed, so the caller can
 * log it, cap it, or refuse the last hop when the item is not worth a real turn.
 */
export function escalationPlan(item: TriageItem): Route[] {
  const plan: Route[] = [routeModel(item)]
  let cur = plan[0].model
  while (cur !== MAIN) {
    const next = nextTier(cur)
    if (!next) break
    plan.push({ model: next, why: `${cur} escalated` })
    cur = next
  }
  return plan
}

/** For the spend line in the weekly changelog — never a cost estimate. */
export function formatRoute(r: Route): string {
  const name = r.model === MAIN ? 'main session' : r.model === HAIKU ? 'haiku' : 'sonnet'
  return `${name} (${r.why})`
}
