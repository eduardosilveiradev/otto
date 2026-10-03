/**
 * "You should be able to X."
 *
 * The user says some version of that every couple of weeks, and until now the honest
 * answer was a conversation: Otto explains what a recipe would look like, the user
 * says sure, and one of them forgets. Nothing gets built, because building it
 * means writing a file, and writing a file has never been something Otto could
 * offer inside the same message.
 *
 * The forge makes it one exchange: draft the thing, run it against something
 * that actually happened, and come back with one line about what it would have
 * done plus three buttons. The dry run is the point. A recipe that reads well
 * is not evidence of anything — trigger action text always reads well, because
 * it was written by the same model that is about to grade it. Running it
 * against a real past event is the only cheap way to find out that the
 * follow-up nudge would have fired on a newsletter, or that the price watch
 * would have messaged the user at 3am about a rounding change.
 *
 * The pipeline is draft → dry-run → verdict, and all three are pure functions
 * over data. Spawning the twin (selftest.ts), reading history.jsonl and writing
 * the branch are plumbing. The install goes through selfedit.ts like everything
 * else in this wave — a forge that could write its own permission is a forge
 * that only has to be talked into it once.
 */

import { classify, type Decision, type Origin, type Proof } from './selfedit.ts'
import { isRequest, isEngagement, tokenize, type HistoryLine } from './repetition.ts'
import type { SelfTestResult } from './selftest.ts'
import type { CapEntry, FileBefore } from './changelog.ts'
import { buildRevert, entryId } from './changelog.ts'

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export type DraftKind = 'recipe' | 'skill' | 'trigger'

export type DraftFile = { path: string; content: string; before: string | null }

export type Draft = {
  id: string
  kind: DraftKind
  /** How the user would name it. */
  title: string
  /** The one-line behaviour summary. Written before the dry run, checked after. */
  claim: string
  files: DraftFile[]
  /** Branch the draft lives on until it is installed or dropped. */
  branch: string
  /** Words that decide which past event is a fair test of it. */
  matches: string[]
  createdAt: string
}

/** What the request came from, so the install path knows its provenance. */
export type ForgeRequest = {
  text: string
  origin: Origin
  at: string
}

/** "you should be able to..." and its cousins. Cheap, and deliberately narrow. */
const ASK = /\b(you should (be able to|really)|can you learn|could you start|it'?d be (good|nice|useful) if you|why (don'?t|can'?t) you)\b/i

export function looksLikeForgeRequest(text: string): boolean {
  return ASK.test(text)
}

export function draftId(): string {
  return entryId()
}

/**
 * Assemble the draft. The content itself comes from the model; this fixes the
 * shape — where the files land, what the branch is called, and that a claim is
 * mandatory. A draft with no stated claim cannot be graded, and an ungradeable
 * draft is one that gets installed on vibes.
 */
export function makeDraft(input: {
  kind: DraftKind
  title: string
  claim: string
  files: DraftFile[]
  matches: string[]
  at: string
}): Draft {
  if (!input.claim.trim()) throw new Error('a draft needs a claim — what would it have done?')
  if (!input.files.length) throw new Error('a draft needs at least one file')
  const id = draftId()
  return {
    id,
    kind: input.kind,
    title: input.title,
    claim: input.claim.trim(),
    files: input.files,
    branch: `otto/forge-${id}`,
    matches: input.matches.map(m => m.toLowerCase()),
    createdAt: input.at,
  }
}

/** The paths an install would touch — the input to selfedit.classify. */
export function installPaths(d: Draft): string[] {
  return d.files.map(f => f.path)
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

export type Sample = {
  /** The past event the draft is being run against. */
  line: HistoryLine
  at: number
  /**
   * What Otto actually did next, historically. The counterfactual: if the draft
   * would have messaged them and the real Otto stayed silent and they never
   * followed up, the draft is proposing noise.
   */
  ottoResponded: boolean
  heFollowedUp: boolean
}

/**
 * Pick the past event to test against.
 *
 * The most RECENT match, not the best one. A hand-picked best case is what the
 * model would choose, and the whole purpose of the dry run is to be a check on
 * the model's own optimism — so the sample is chosen by a rule the draft's
 * author does not get to influence beyond declaring its match words up front.
 */
export function pickSample(entries: HistoryLine[], draft: Draft, opts: { window?: number } = {}): Sample | null {
  const sorted = [...entries]
    .map(e => ({ e, at: Date.parse(e.ts) }))
    .filter(x => !Number.isNaN(x.at))
    .sort((a, b) => a.at - b.at)

  const window = opts.window ?? 2 * 60 * 60 * 1000

  for (let i = sorted.length - 1; i >= 0; i--) {
    const { e, at } = sorted[i]
    if (!isRequest(e)) continue
    const toks = new Set(tokenize(e.text))
    if (!draft.matches.some(m => toks.has(m))) continue

    const after = sorted.slice(i + 1).filter(x => x.at - at <= window)
    return {
      line: e,
      at,
      ottoResponded: after.some(x => x.e.dir === 'out'),
      heFollowedUp: after.some(x => isEngagement(x.e)),
    }
  }
  return null
}

/** What the twin observed when the draft was run against the sample. */
export type Observation = {
  /** The draft ran without throwing. */
  ran: boolean
  /** It decided to send something (as opposed to correctly staying silent). */
  wouldSend: boolean
  /** The text it would have sent, if any. */
  text?: string
  /** Anything the run wrote to stderr. */
  error?: string
  /** The twin's own load check — a draft that breaks the session is not a draft. */
  selfTest?: SelfTestResult
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type Grade = 'install' | 'tweak' | 'drop'

export type Verdict = {
  grade: Grade
  /** The one-line behaviour summary the user reads. Past tense, about a real day. */
  line: string
  /** Why it graded that way — kept for the changelog, not usually shown. */
  evidence: string[]
}

/** A spoken-length cap; anything over this is a wall of text on a phone. */
const SEND_MAX = 1500

/**
 * Grade the run.
 *
 * The bar is asymmetric on purpose. `install` requires the draft to have done
 * something defensible on a real event; everything ambiguous is `tweak`, and
 * `tweak` is not a failure — it is the normal outcome of a first draft, and it
 * keeps the button that says "install" meaning something.
 */
export function evaluateDryRun(draft: Draft, sample: Sample | null, obs: Observation): Verdict {
  const evidence: string[] = []

  if (obs.selfTest && !obs.selfTest.ok) {
    return { grade: 'drop', line: `it doesn't load — ${obs.selfTest.line}`, evidence: [obs.selfTest.line] }
  }
  if (!obs.ran) {
    return { grade: 'drop', line: `it errored on the first real thing I tried it on${obs.error ? `: ${obs.error.slice(0, 80)}` : ''}`, evidence: [obs.error ?? 'did not run'] }
  }
  if (!sample) {
    // Nothing to test it on is not a pass. It is the least informative outcome
    // there is, and installing on it means installing on the claim alone.
    return {
      grade: 'tweak',
      line: `nothing in the last few weeks looked like ${draft.title.toLowerCase()}, so I couldn't try it on anything real`,
      evidence: ['no sample found'],
    }
  }

  const when = new Date(sample.at).toISOString().slice(0, 10)
  const quoted = sample.line.text.slice(0, 60)

  if (obs.wouldSend && obs.text && obs.text.length > SEND_MAX) {
    evidence.push(`${obs.text.length} chars`)
    return { grade: 'tweak', line: `on ${when} it would have sent you ${obs.text.length} characters about "${quoted}" — too long`, evidence }
  }

  if (obs.wouldSend) {
    // The counterfactual that matters: the real Otto stayed quiet and the user never
    // came back to it, which means there was nothing there to say.
    if (!sample.ottoResponded && !sample.heFollowedUp) {
      evidence.push('would have fired where nothing was happening')
      return {
        grade: 'tweak',
        line: `on ${when} it would have pinged you about "${quoted}" — but you never followed up on that, so it'd be noise`,
        evidence,
      }
    }
    evidence.push('fired where you were already engaged')
    return {
      grade: 'install',
      line: `on ${when} it would have told you: ${(obs.text ?? '').slice(0, 100)}`,
      evidence,
    }
  }

  // Silence is a valid outcome — unless the sample is one where the user clearly
  // wanted an answer, in which case the draft did nothing useful.
  if (sample.heFollowedUp || sample.ottoResponded) {
    evidence.push('stayed silent on an event you were engaged with')
    return { grade: 'tweak', line: `on ${when} it would have stayed quiet about "${quoted}", which is where you wanted something`, evidence }
  }
  evidence.push('correctly silent')
  return { grade: 'install', line: `on ${when} it would have correctly said nothing about "${quoted}"`, evidence }
}

// ---------------------------------------------------------------------------
// What the user sees
// ---------------------------------------------------------------------------

export type Offer = {
  text: string
  buttons: { label: string; data: string }[]
  /** The tier an install would need, so they are told before they tap. */
  decision: Decision
}

/**
 * One line and three buttons. The tier is stated in the message rather than
 * discovered at tap time: a button that turns out to need a typed phrase is a
 * button that feels broken, and the point of showing the tier is that a
 * `guarded` draft should look different from a recipe before the user touches it.
 *
 * Button data carries the draft id, not the draft. Sixty bytes of callback data
 * cannot hold a recipe, and a truncated payload is a button that installs
 * something other than what it said.
 */
export function formatOffer(draft: Draft, v: Verdict, origin: Origin): Offer {
  const decision = classify(installPaths(draft), origin)
  const gate =
    decision.tier === 'guarded'
      ? ' (needs a typed confirm — it touches the channel itself)'
      : decision.tier === 'confirmed'
        ? ''
        : ''
  const head = v.grade === 'drop' ? `built ${draft.title} and it didn't work` : `built ${draft.title}`
  return {
    text: `${head}. ${v.line}${gate}.`,
    buttons:
      v.grade === 'drop'
        ? [{ label: 'drop it', data: `drop forge ${draft.id}` }]
        : [
            { label: 'install', data: `install forge ${draft.id}` },
            { label: 'tweak', data: `tweak forge ${draft.id}` },
            { label: 'drop', data: `drop forge ${draft.id}` },
          ],
    decision,
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * The only way a draft becomes files. Routed through selfedit.classify with the
 * ORIGINAL request's provenance, not the tap's — a tap confirms a change, it
 * does not launder where the idea came from. An "install" button under a draft
 * that an email talked Otto into is still an email-authored install.
 */
export function planInstall(
  draft: Draft,
  request: ForgeRequest,
  proof: Proof,
  ctx: { sha?: string; verdict: Verdict },
): { decision: Decision; entry: CapEntry } {
  const paths = installPaths(draft)
  const decision = classify(paths, request.origin, proof)
  if (!decision.allowed) throw new Error(`self-edit blocked — ${decision.reason}`)

  const befores: FileBefore[] = draft.files.map(f => ({ path: f.path, before: f.before }))
  const entry: CapEntry = {
    id: draft.id,
    at: new Date().toISOString(),
    what: `${draft.title} — ${draft.claim}`,
    ...(ctx.sha ? { sha: ctx.sha } : {}),
    paths,
    tier: decision.tier,
    origin: request.origin,
    by: 'forge',
    revert: buildRevert(befores, ctx.sha),
  }
  return { decision, entry }
}
