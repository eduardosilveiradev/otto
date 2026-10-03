/**
 * The voice rules, enforced by something that cannot get tired.
 *
 * CLAUDE.md is emphatic about how Otto talks: terse, dry, no filler, never a
 * mention of triggers or scans or sessions, and spoken replies short and free of
 * links, lists and code. Every one of those rules is currently enforced by the
 * session remembering to follow it, which it mostly does — and then at 03:00,
 * eleven hours into a context, on the fourth message of a burst, it says "Let me
 * know if you'd like me to adjust that!" or "my email scan found" and the
 * illusion of one entity is gone.
 *
 * These are the checks a regex can make with no model call and no judgement, so
 * they belong in the send path rather than in the prompt. What a regex cannot
 * decide, it does not decide: this file blocks only the phrasings that are
 * unambiguous and trivially fixable, and merely warns about everything where a
 * false positive would be worse than a miss.
 *
 * The distinction that matters:
 *
 *   block  the message does not go out; the model is told exactly what to fix
 *          and resends. Reserved for filler and for machinery leaking into the user’s
 *          view, both of which are always rewritable in one pass.
 *   warn   the message goes out with a note attached, because the rule has
 *          real exceptions and a blocked send would be worse than a slightly
 *          wrong one.
 *
 * Nothing here inspects meaning, so nothing here can be talked out of firing by
 * the content of an email.
 */

export type LintSeverity = 'block' | 'warn'

export type Finding = {
  severity: LintSeverity
  /** Stable identifier, so the model is told the same thing every time. */
  code: string
  /** What is wrong, phrased as the fix. */
  message: string
  /** The offending excerpt, when there is one worth quoting. */
  match?: string
}

export type LintContext = {
  /** True when this send will be spoken. */
  voice?: boolean
  /** Median length of the user’s recent outbound messages, when known. */
  medianLength?: number
  /** Conversation is exempt from the length rule; a real answer can be long. */
  conversational?: boolean
}

/**
 * Filler. Every one of these is a phrase CLAUDE.md names or a close cousin, and
 * every one can be deleted outright without losing information — which is why
 * they are safe to block.
 */
const FILLER: { re: RegExp; hint: string }[] = [
  { re: /\blet me know if\b[^.!?]*/i, hint: 'delete it; they know they can reply' },
  { re: /\b(?:i'?m |i am )?happy to help\b/i, hint: 'delete it' },
  { re: /\bi hope (?:this|that) helps\b/i, hint: 'delete it' },
  { re: /\b(?:feel free to|don'?t hesitate to)\b[^.!?]*/i, hint: 'delete it' },
  { re: /^(?:certainly|absolutely|of course|great question|good question)[!,.]/i, hint: 'open with the answer' },
  { re: /\byou'?re absolutely right\b/i, hint: 'just make the correction' },
  { re: /\bis there anything else\b[^.!?]*/i, hint: 'delete it' },
  { re: /\bwould you like me to\b[^.!?]*\?/i, hint: 'either do it or offer one button' },
]

/**
 * Machinery. Only the self-referential forms are blocked: "the trigger fired"
 * is Otto describing its own plumbing, while "trigger a rebuild" is ordinary
 * English and must survive. Bare nouns are warned about instead of blocked, so
 * a message about a GitHub Action or a CT scan is never held hostage.
 */
const LEAKAGE: { re: RegExp; hint: string }[] = [
  { re: /\b(?:my|the|a|another|this) (?:trigger|cron job|scheduled task)\b/i, hint: 'say what it is about, not what scheduled it' },
  { re: /\btrigger (?:fired|ran|is armed|went off)\b/i, hint: 'say what it is about, not what scheduled it' },
  { re: /\b(?:my|the|an|hourly) (?:email )?scan\b/i, hint: 'say "I saw" or "your inbox has"' },
  { re: /\b(?:my|the|a|an|another) (?:sub)?agents?\b/i, hint: 'you are one entity; say "I"' },
  { re: /\b(?:in |during |from )?(?:this|the|my|a new|another) session\b/i, hint: 'you are one entity; drop the session' },
  { re: /\b(?:my|the) (?:tools?|tool call|context window|prompt)\b/i, hint: 'describe the thing, not the mechanism' },
  { re: /\b(?:i )?(?:ran|called|used) (?:the |my )?(?:tool|recall|brief|gog)\b/i, hint: 'just state what you found' },
  { re: /\bwebhook\b/i, hint: 'name the system that sent it instead' },
]

const BARE_MACHINERY = /\b(trigger|scan|agent|session|webhook|cron)\b/i

const URL_RE = /https?:\/\/\S+/i
const CODE_FENCE_RE = /```|`[^`\n]+`/
const LIST_RE = /^\s*(?:[-*•]|\d+[.)])\s+/m

/** Claims that mail went out. Otto may only say this after a shown, approved draft. */
const SENT_MAIL_RE = /\b(?:i(?:'ve| have)? )?(?:sent|replied to|forwarded|emailed)\b[^.!?]*\b(?:email|mail|reply|thread|message to)\b/i

/** Voice notes are a minute of the user’s time; past this it should have been text. */
export const VOICE_SOFT_LIMIT = 700
/** How far past the user’s own median a written message can run before it is worth flagging. */
export const LENGTH_FACTOR = 3

export function lintOutbound(text: string, ctx: LintContext = {}): Finding[] {
  const findings: Finding[] = []
  const body = text.trim()
  if (!body) return findings

  for (const { re, hint } of FILLER) {
    const m = body.match(re)
    if (m) {
      findings.push({
        severity: 'block',
        code: 'filler',
        message: `filler — ${hint}`,
        match: m[0].trim().slice(0, 80),
      })
      break // one is enough; naming them all reads as a lecture
    }
  }

  for (const { re, hint } of LEAKAGE) {
    const m = body.match(re)
    if (m) {
      findings.push({
        severity: 'block',
        code: 'machinery',
        message: `they should never see the machinery — ${hint}`,
        match: m[0].trim().slice(0, 80),
      })
      break
    }
  }

  // Bare mention with no self-referential frame: probably fine, worth a glance.
  if (!findings.some(f => f.code === 'machinery')) {
    const bare = body.match(BARE_MACHINERY)
    if (bare) {
      findings.push({
        severity: 'warn',
        code: 'machinery-maybe',
        message: `"${bare[1]}" reads as plumbing unless it is genuinely the user’s subject`,
        match: bare[0],
      })
    }
  }

  if (ctx.voice) {
    if (URL_RE.test(body)) {
      findings.push({ severity: 'warn', code: 'voice-url', message: 'a spoken link is unusable — send the link as text' })
    }
    if (CODE_FENCE_RE.test(body)) {
      findings.push({ severity: 'warn', code: 'voice-code', message: 'code cannot be spoken — send it as text' })
    }
    if (LIST_RE.test(body)) {
      findings.push({ severity: 'warn', code: 'voice-list', message: 'a spoken list is hard to hold — say the one thing that matters, or send text' })
    }
    if (body.length > VOICE_SOFT_LIMIT) {
      findings.push({
        severity: 'warn',
        code: 'voice-long',
        message: `${body.length} chars is a long voice note; one or two sentences is the format`,
      })
    }
  }

  if (!ctx.conversational && ctx.medianLength && ctx.medianLength > 0) {
    const ceiling = ctx.medianLength * LENGTH_FACTOR
    if (body.length > ceiling) {
      findings.push({
        severity: 'warn',
        code: 'long',
        message: `${body.length} chars against a usual ${Math.round(ctx.medianLength)} — unprompted messages earn their length`,
      })
    }
  }

  if (SENT_MAIL_RE.test(body)) {
    findings.push({
      severity: 'warn',
      code: 'mail-claim',
      message: 'this claims mail went out — only true after they approved a draft you showed them',
      match: body.match(SENT_MAIL_RE)![0].trim().slice(0, 80),
    })
  }

  return findings
}

export const blocking = (f: Finding[]): Finding[] => f.filter(x => x.severity === 'block')
export const warnings = (f: Finding[]): Finding[] => f.filter(x => x.severity === 'warn')

export function formatFindings(f: Finding[]): string {
  return f.map(x => (x.match ? `${x.message} ("${x.match}")` : x.message)).join('; ')
}

/**
 * The user’s own median outbound length, for the length rule. Conversation is included
 * deliberately: the bar is "how long does Otto normally talk", not "how long is
 * a digest".
 */
export function medianLength(texts: string[]): number {
  const lens = texts.map(t => t.trim().length).filter(n => n > 0).sort((a, b) => a - b)
  if (!lens.length) return 0
  const mid = lens.length >> 1
  return lens.length % 2 ? lens[mid] : Math.round((lens[mid - 1] + lens[mid]) / 2)
}
