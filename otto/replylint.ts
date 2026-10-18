/**
 * The last check before reply() lets text out. Pure: no state, no I/O.
 *
 * lint.ts blocks only the self-referential phrasings ("my trigger fired") and
 * merely warns about bare machinery nouns and spoken-form problems, because a
 * false positive there holds a real message hostage. This module is the
 * stricter gate the voice rules in CLAUDE.md actually call for:
 *
 *   voice  a spoken reply carries no link, no code, no table, no list, and
 *          stays under VOICE_MAX characters. Each of those is fixable by
 *          resending as text, so blocking costs one retry.
 *   words  the machinery words never appear as standalone words, with the
 *          exemptions ordinary English needs ("trigger a rebuild", "CT scan",
 *          "jam session", anything inside quotation marks, a capitalised title).
 *   ids    no raw tool or chat ids: a hex run next to "trigger" or "loop", or a
 *          chat_id= style key.
 *
 * Every failure says which rule fired and how to fix it, phrased as the fix.
 *
 * The words and ids rules guard what Otto says unprompted — a trigger or a scan
 * narrating its own plumbing. Inside a conversation the user may be the one
 * talking about webhooks and sessions (they build Otto from this chat), so
 * there those two rules only warn; the voice rules block either way.
 */

import { URL_RE, CODE_FENCE_RE, LIST_RE } from './lint.ts'

export type ReplyLint = { ok: true; warning?: string } | { ok: false; reason: string }

/** One or two spoken sentences; past this it should have gone as text. */
export const VOICE_MAX = 350

const BARE_URL_RE = /\bwww\.\S+/i
const TABLE_RE = /^\s*\|.*\|\s*$|^\s*\|?\s*:?-{3,}:?\s*\|/m

const DETERMINER = new Set([
  'a', 'an', 'the', 'it', 'this', 'that', 'these', 'those', 'them', 'my', 'your',
  'his', 'her', 'their', 'our', 'some', 'any', 'every', 'each', 'off', 'me', 'him', 'us',
])
const POSSESSIVE_OR_ARTICLE = new Set([
  'a', 'an', 'the', 'my', 'this', 'that', 'another', 'each', 'every', 'one', 'new', 'hourly', 'daily', 'email',
])

type Ctx = { before: string; after: string }

/** "trigger a rebuild", "it triggers my migraines": a verb with an object, not Otto's plumbing. */
const verbWithObject = ({ before, after }: Ctx) => DETERMINER.has(after) && !POSSESSIVE_OR_ARTICLE.has(before)

const MACHINERY: { re: RegExp; allow?: (c: Ctx) => boolean }[] = [
  {
    re: /\btriggers?\b/gi,
    allow: c =>
      /^(?:warnings?|points?|finger|happy)$/.test(c.after) ||
      c.before === 'hair' ||
      verbWithObject(c),
  },
  {
    re: /\bscans?\b/gi,
    allow: c =>
      /^(?:ct|cat|mri|pet|dexa|body|full-body|brain|bone|medical|ultrasound|qr|barcode|passport|document|security|your|their|his|her)$/.test(c.before) ||
      verbWithObject(c),
  },
  {
    re: /\bsessions?\b/gi,
    allow: c =>
      /^(?:jam|studio|recording|live|acoustic|practice|rehearsal|listening|therapy|training|gym|coaching|tutoring|study|photo|q&a|qa|poster|plenary|breakout|court|parliamentary|your|their|his|her)$/.test(c.before) ||
      /^(?:musicians?|players?|drummers?|guitarists?|bassists?|band)$/.test(c.after),
  },
  { re: /\bwebhooks?\b/gi },
  { re: /\bsub-?agents?\b/gi },
  { re: /\bvoice daemon\b/gi },
  { re: /\btranscri(?:ption|bed|bing|ber)s?\b/gi, allow: c => /^(?:your|their|his|her)$/.test(c.before) },
]

/** Quoted text is someone else's words — a book title, a "trigger warning" they wrote. */
const QUOTED_RE = /"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g

function contextAt(text: string, start: number, end: number): Ctx {
  const before = text.slice(0, start).match(/([\w&'-]+)[^\w&'-]*$/)?.[1]?.toLowerCase() ?? ''
  const after = text.slice(end).match(/^[^\w-]*([\w-]+)/)?.[1]?.toLowerCase() ?? ''
  return { before, after }
}

/** Capitalised mid-sentence reads as a title ("Session" by a band), never as plumbing. */
function isTitleCase(text: string, start: number, word: string): boolean {
  // Shouting ("WEBHOOK") is not a title.
  if (!/^[A-Z][a-z]/.test(word)) return false
  const prev = text.slice(0, start).trimEnd()
  return prev.length > 0 && !/[.!?:\n]$/.test(prev)
}

function machineryWord(text: string): string | undefined {
  const scrubbed = text.replace(QUOTED_RE, m => ' '.repeat(m.length))
  for (const { re, allow } of MACHINERY) {
    for (const m of scrubbed.matchAll(re)) {
      const start = m.index!
      const end = start + m[0].length
      if (isTitleCase(scrubbed, start, m[0])) continue
      if (allow?.(contextAt(scrubbed, start, end))) continue
      return m[0]
    }
  }
  return undefined
}

// A hex run with at least one digit, so "deadbeef"-shaped English never counts.
const HEX = String.raw`\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b`
const ID_NEAR_RE = new RegExp(
  String.raw`\b(?:trigger|loop)s?\b[\s:#=_-]*(?:id[\s:#=]*)?${HEX}|${HEX}[\s:#=_-]*\b(?:trigger|loop)s?\b`,
  'i',
)
const ID_KEY_RE = /\b(?:chat|message|user)_id\s*[=:]/i

export function lintReply(text: string, opts: { voice?: boolean; conversational?: boolean } = {}): ReplyLint {
  const body = text.trim()
  if (!body) return { ok: true }
  const reasons: string[] = []
  const soft: string[] = []
  const words = opts.conversational ? soft : reasons

  if (opts.voice) {
    if (URL_RE.test(body) || BARE_URL_RE.test(body)) reasons.push('voice reply has a link — send links as text (voice:false)')
    if (CODE_FENCE_RE.test(body)) reasons.push('voice reply has code — send code as text (voice:false)')
    if (TABLE_RE.test(body)) reasons.push('voice reply has a table — say the one figure that matters, or send it as text (voice:false)')
    else if (LIST_RE.test(body)) reasons.push('voice reply has a bullet list — say the one thing that matters, or send it as text (voice:false)')
    if (body.length > VOICE_MAX) {
      reasons.push(`voice reply is ${body.length} chars (max ${VOICE_MAX}) — cut it to one or two sentences, or send it as text (voice:false)`)
    }
  }

  const word = machineryWord(body)
  if (word) words.push(`reply says "${word}" — they should never see the machinery; say what it is about, not how you got it`)

  const id = body.match(ID_NEAR_RE) ?? body.match(ID_KEY_RE)
  if (id) words.push(`reply carries a raw id ("${id[0].trim()}") — describe the thing; ids are for tools, not for them`)

  if (reasons.length) return { ok: false, reason: reasons.join('; ') }
  return soft.length ? { ok: true, warning: soft.join('; ') } : { ok: true }
}
