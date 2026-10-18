/**
 * Credentials never leave the Mac by accident.
 *
 * Otto has a shell, and shell output is where secrets live: an `env` dump, a
 * `cat ~/.aws/credentials`, a curl with its Authorization header pasted back.
 * Anything that leaves for a third party (today: the Bark push relay) is
 * scrubbed by a regex that cannot be talked out of firing. Replies to the
 * user's own chats are not: they may be asking for that very key or IBAN, and
 * a draft shown for approval must read exactly as it will be sent.
 *
 * Every pattern here is a format with a recognisable shape: a vendor prefix, a
 * fixed length, a checksum. Shapeless things — a password, a 40-character hex
 * string — are deliberately not matched, because a git SHA, a UUID and the OTP
 * the user just asked for look exactly like that, and a reply mangled for no
 * reason is a cost paid on every message to prevent one that almost never
 * happens.
 *
 * Pure: no I/O, no state. The caller decides what to tell whom.
 */

export type RedactResult = {
  text: string
  /** One entry per secret replaced, by kind. Its length is the count. */
  hits: string[]
}

export type RedactOptions = {
  /** Escape the marker's brackets so a MarkdownV2 send still parses. */
  markdownV2?: boolean
}

type Rule = {
  kind: string
  re: RegExp
  /** Extra check on the match; false leaves it alone. */
  accept?: (m: string) => boolean
  /** Characters at the start of the match to keep in clear (a header name). */
  keep?: (m: string) => number
}

const hasDigit = (s: string) => /\d/.test(s)

// Order matters only where one secret can sit inside another's shape: a JWT is
// usually the bearer token, and an Anthropic key also starts with "sk-". The
// more specific kind runs first, and a marker never matches a later rule.
const RULES: Rule[] = [
  {
    kind: 'private key',
    // An unterminated block is truncated output — the rest of it is still key.
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*$)/g,
  },
  {
    kind: 'JWT',
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}/g,
  },
  { kind: 'Anthropic key', re: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    kind: 'OpenAI key',
    re: /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    // Real keys always carry digits; a long hyphenated phrase never needs to.
    accept: hasDigit,
  },
  { kind: 'Stripe key', re: /(?<![A-Za-z0-9_])(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  {
    kind: 'GitHub token',
    re: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g,
  },
  { kind: 'Slack token', re: /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,}/g, accept: hasDigit },
  { kind: 'AWS access key', re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g },
  { kind: 'Google API key', re: /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  {
    kind: 'Telegram bot token',
    // No word boundary in front: in a URL it follows "/bot".
    re: /(?<![0-9])[0-9]{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
  },
  {
    kind: 'bearer token',
    re: /Authorization["']?\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    keep: m => m.length - (m.match(/[A-Za-z0-9._~+/=-]+$/)?.[0].length ?? 0),
  },
]

// ── IBAN ────────────────────────────────────────────────────────────────────

/** Registry lengths. A country missing here is held to the general 15–34. */
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29,
  CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24,
  FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21,
  HU: 28, IE: 22, IL: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LI: 21,
  LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30,
  NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24,
  SE: 24, SI: 19, SK: 24, SM: 27, TN: 24, TR: 26, UA: 29, VG: 24, XK: 20,
}

/** ISO 13616: move the first four to the end, letters to numbers, mod 97 is 1. */
export function validIban(raw: string): boolean {
  const iban = raw.replace(/ /g, '')
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return false
  const want = IBAN_LENGTH[iban.slice(0, 2)]
  if (want ? iban.length !== want : iban.length < 15 || iban.length > 34) return false
  let rem = 0
  for (const ch of iban.slice(4) + iban.slice(0, 4)) {
    const v = ch >= 'A' ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48
    rem = v >= 10 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97
  }
  return rem === 1
}

// Printed in groups of four, or run together. The grouped form can swallow a
// trailing capitalised word ("… 32 IS"), so it is trimmed a group at a time
// until the checksum agrees or there is nothing left to try.
const IBAN_RE = /(?<![A-Za-z0-9])[A-Z]{2}[0-9]{2}(?:(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?|[A-Z0-9]{11,30})(?![A-Za-z0-9])/g

function matchIban(m: string): { iban: string; rest: string } | null {
  let cand = m
  for (;;) {
    if (validIban(cand)) return { iban: cand, rest: m.slice(cand.length) }
    const cut = cand.lastIndexOf(' ')
    if (cut < 0) return null
    cand = cand.slice(0, cut)
  }
}

// ── entry point ─────────────────────────────────────────────────────────────

export function redactSecrets(input: string, opts: RedactOptions = {}): RedactResult {
  const hits: string[] = []
  const marker = (kind: string) =>
    opts.markdownV2 ? `\\[redacted ${kind}\\]` : `[redacted ${kind}]`

  let text = input
  for (const rule of RULES) {
    text = text.replace(rule.re, m => {
      if (rule.accept && !rule.accept(m)) return m
      hits.push(rule.kind)
      const keep = rule.keep ? rule.keep(m) : 0
      return m.slice(0, keep) + marker(rule.kind)
    })
  }
  text = text.replace(IBAN_RE, m => {
    const found = matchIban(m)
    if (!found) return m
    hits.push('IBAN')
    return marker('IBAN') + found.rest
  })
  return { text, hits }
}

/** The one line the model reads: "redacted 2 secret(s): GitHub token, IBAN". */
export function redactionNote(hits: string[]): string {
  if (!hits.length) return ''
  return `redacted ${hits.length} secret(s): ${[...new Set(hits)].join(', ')}`
}
