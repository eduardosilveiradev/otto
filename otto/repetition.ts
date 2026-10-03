/**
 * The third time the user asks, Otto should offer to stop being asked.
 *
 * CLAUDE.md already says this is the main way Otto is supposed to get more
 * useful over time — "you noticed the user asking for the same thing a third time →
 * offer to absorb it as a trigger, one button tap". It has never once happened,
 * because noticing requires holding four weeks of Telegram in your head and no
 * session holds more than the last six lines of it.
 *
 * history.jsonl holds all of it. This turns the log into candidates.
 *
 * The bar is deliberately high, because the failure mode is not "missed a
 * pattern" — it is arming a trigger off three coincidental messages and then
 * pinging them at 08:00 forever about something they asked twice in March. So:
 * three or more instances, a stable shape (tokens common to *every* instance,
 * not just most), and parameters lifted from what the user actually typed rather than
 * invented. A draft they can read and recognise is a draft they can tap.
 *
 * Clustering is greedy against each cluster's first member, in timestamp order.
 * That is not the best clustering algorithm; it is a deterministic one, which
 * matters more here than optimality — the same transcript must always produce
 * the same proposal, or a fixture test proves nothing and a re-run second-guesses
 * a decision the user already declined.
 */

/** The shape history.jsonl already writes. Read directly; no index. */
export type HistoryLine = {
  ts: string
  dir: 'in' | 'out'
  text: string
  kind?: string
}

export type Instance = { at: number; text: string; tokens: Set<string>; lits: Set<string> }

export type Candidate = {
  /** Stable id for the cluster — the sorted shape tokens and literals, joined. */
  key: string
  /** 8 hex chars of `key`. What a button carries; see formatOffer. */
  id: string
  count: number
  /** Tokens present in every single instance. The "stable shape". */
  shape: string[]
  /** Content terms worth putting in the trigger, lifted from the user’s words. */
  terms: string[]
  /** Quoted phrases and URLs common to every instance, verbatim. */
  literals: string[]
  firstAt: string
  lastAt: string
  /** Local times the user asked, "HH:MM", in ask order. */
  askedAt: string[]
  /** Cron inferred from those times, or undefined when they are scattered. */
  cron?: string
  /** Up to three of their messages, so the proposal quotes them. */
  examples: string[]
  /** Ready-to-install action text, parameters already filled. */
  draftAction: string
}

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

/**
 * Deliberately not the memory.ts tokenizer. That one indexes a corpus of
 * written notes; this one reads texted requests, where "can you", "again",
 * "pls" and an emoji are the majority of the characters and none of them
 * distinguish one request from another.
 */
const CHATTER = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'you', 'me', 'my', 'we', 'he', 'she', 'they', 'them',
  'can', 'could', 'would', 'will', 'shall', 'should', 'do', 'does', 'did', 'please', 'pls',
  'hey', 'hi', 'yo', 'thanks', 'thx', 'ok', 'okay', 'yeah', 'yep', 'sure', 'again', 'also',
  'just', 'now', 'then', 'some', 'any', 'what', 'whats', 'how', 'when', 'where', 'which',
  'give', 'send', 'tell', 'show', 'get', 'got', 'want', 'need', 'like', 'know', 'let',
])

/** Crude, and only enough that "flight"/"flights" collide. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'
  for (const s of ['ing', 'ed', 'es', 's']) {
    if (w.length > s.length + 3 && w.endsWith(s)) return w.slice(0, -s.length)
  }
  return w
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^a-z0-9_+#.-]+/)
    .map(t => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter(t => t.length > 1 && !CHATTER.has(t))
    .map(stem)
}

/** Stable short id for a cluster. FNV-1a — deterministic, and no import. */
export function candidateId(key: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** URLs and "quoted phrases" survive verbatim — they are usually the parameter. */
export function literals(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/https?:\/\/\S+/g)) out.push(m[0].replace(/[.,)]+$/, ''))
  for (const m of text.matchAll(/["“']([^"”']{3,60})["”']/g)) out.push(m[1].trim())
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared / (a.size + b.size - shared)
}

// ---------------------------------------------------------------------------
// Which lines are even requests
// ---------------------------------------------------------------------------

/** Acknowledgements, reactions and one-word replies are not asks. */
const ACK = /^\s*(ok(ay)?|k|yes|no|yep|nope|sure|thanks?|thx|ta|done|cool|nice|great|👍|❤️|🔥|👀|🎉|\.|!+)\s*$/i
const MIN_TOKENS = 2

/**
 * The user said something that was not an acknowledgement.
 *
 * Deliberately weaker than `isRequest`. "which step" is real engagement — it is
 * the user leaning in — but it is two words of context and clustering on it would
 * mine a pattern out of conversational filler. The two predicates answer
 * different questions and conflating them costs accuracy in whichever direction
 * you pick, so they are separate: forge.ts asks "did the user engage", the miner asks
 * "is this a repeatable ask".
 */
export function isEngagement(line: HistoryLine): boolean {
  if (line.dir !== 'in') return false
  if (line.kind && line.kind !== 'text' && line.kind !== 'voice') return false
  return !ACK.test(line.text) && line.text.trim().length > 0
}

export function isRequest(line: HistoryLine): boolean {
  return isEngagement(line) && tokenize(line.text).length >= MIN_TOKENS
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/** Two messages are the same ask above this overlap. Tuned by fixture, not theory. */
const SIMILARITY = 0.45
/** Below this many tokens in common across every instance, the shape is noise. */
const MIN_SHAPE = 2
export const MIN_INSTANCES = 3

type Cluster = { seed: Instance; shape: Set<string>; members: Instance[] }

/**
 * Greedy single-pass clustering in timestamp order, matched against each
 * cluster's FIRST member rather than a moving centroid. A moving centroid drifts
 * — instance 12 can end up in a cluster it shares nothing with instance 1 —
 * and drift is exactly what produces a confident proposal about a pattern that
 * does not exist.
 *
 * A shared literal short-circuits the token overlap. The same URL pasted twice
 * is the same ask even when the sentence around it is completely different
 * ("check X price" / "is X down yet"), and it is the sentence around it that
 * varies most — they do not retype the URL, they retype the request.
 */
export function cluster(instances: Instance[]): Cluster[] {
  const clusters: Cluster[] = []
  for (const inst of instances) {
    let placed = false
    for (const c of clusters) {
      const sharesLiteral = [...inst.lits].some(l => c.seed.lits.has(l))
      if (!sharesLiteral && jaccard(inst.tokens, c.seed.tokens) < SIMILARITY) continue
      c.members.push(inst)
      for (const t of [...c.shape]) if (!inst.tokens.has(t)) c.shape.delete(t)
      placed = true
      break
    }
    if (!placed) clusters.push({ seed: inst, shape: new Set(inst.tokens), members: [inst] })
  }
  return clusters
}

// ---------------------------------------------------------------------------
// Schedule inference
// ---------------------------------------------------------------------------

/** Fire a little before the user would have asked, so the answer is already there. */
const LEAD_MINUTES = 10
/** Asks spread wider than this across the day are not a schedule. */
const SPREAD_MINUTES = 150

function localParts(at: number, tz: string): { h: number; m: number; dow: number } {
  const f = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false, timeZone: tz,
  })
  const parts = Object.fromEntries(f.formatToParts(new Date(at)).map(p => [p.type, p.value]))
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return {
    h: Number(parts.hour) % 24,
    m: Number(parts.minute),
    dow: Math.max(0, dows.indexOf(String(parts.weekday).slice(0, 3))),
  }
}

/**
 * A cron expression, or undefined when the asks are scattered enough that any
 * time would be a guess. Undefined is a fine answer: the proposal then offers
 * a time for the user to pick rather than asserting one.
 */
export function inferCron(times: number[], tz: string): string | undefined {
  if (times.length < MIN_INSTANCES) return undefined
  const parts = times.map(t => localParts(t, tz))
  const minutes = parts.map(p => p.h * 60 + p.m)
  const spread = Math.max(...minutes) - Math.min(...minutes)
  if (spread > SPREAD_MINUTES) return undefined

  const target = Math.max(0, Math.min(...minutes) - LEAD_MINUTES)
  const h = Math.floor(target / 60)
  const m = Math.floor((target % 60) / 5) * 5

  const dows = parts.map(p => p.dow)
  const day = dows.every(d => d === dows[0])
    ? String(dows[0])
    : dows.every(d => d >= 1 && d <= 5)
      ? '1-5'
      : '*'
  return `${m} ${h} * * ${day}`
}

function hhmm(at: number, tz: string): string {
  const { h, m } = localParts(at, tz)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

export type MineOpts = {
  tz: string
  /** Ignore anything older than this. Habits expire. */
  since?: number
  /** Gists of triggers already armed, so nothing is proposed twice. */
  armed?: string[]
  /**
   * Candidate ids the user has already declined. A no is permanent: the cluster
   * stays in the transcript and keeps scoring, so without this the same offer
   * comes back every Sunday until they arm it out of fatigue.
   */
  declined?: string[]
  chatId?: string
}

/**
 * The whole pass, pure over the transcript. No clock, no filesystem: the caller
 * supplies `since` and `tz`, which is what makes a fixture transcript a real
 * test rather than a snapshot that rots at midnight.
 */
export function mineRepetitions(lines: HistoryLine[], opts: MineOpts): Candidate[] {
  const instances: Instance[] = []
  for (const l of lines) {
    if (!isRequest(l)) continue
    const at = Date.parse(l.ts)
    if (Number.isNaN(at)) continue
    if (opts.since && at < opts.since) continue
    instances.push({ at, text: l.text, tokens: new Set(tokenize(l.text)), lits: new Set(literals(l.text)) })
  }
  instances.sort((a, b) => a.at - b.at)

  const out: Candidate[] = []
  for (const c of cluster(instances)) {
    if (c.members.length < MIN_INSTANCES) continue
    const shape = [...c.shape].sort()
    const common = commonLiterals(c.members)
    // A literal counts toward the shape. One shared URL plus one shared word
    // is as specific as two shared words, and rather more legible in an offer.
    if (shape.length + common.length < MIN_SHAPE) continue

    const key = [...shape, ...common].join('+')
    if (alreadyArmed(shape, opts.armed ?? [])) continue
    if ((opts.declined ?? []).includes(candidateId(key))) continue

    const times = c.members.map(m => m.at)
    const terms = shape.filter(t => !common.some(l => l.toLowerCase().includes(t)))

    out.push({
      key,
      id: candidateId(key),
      count: c.members.length,
      shape,
      terms,
      literals: common,
      firstAt: new Date(times[0]).toISOString(),
      lastAt: new Date(times[times.length - 1]).toISOString(),
      askedAt: times.map(t => hhmm(t, opts.tz)),
      ...(inferCron(times, opts.tz) ? { cron: inferCron(times, opts.tz)! } : {}),
      examples: c.members.slice(-3).map(m => m.text.slice(0, 120)),
      draftAction: draftAction({ terms, literals: common, chatId: opts.chatId }),
    })
  }

  // Most-repeated first, then most recent — the order the user should be offered them.
  return out.sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
}

/** Literals present in every instance — a URL the user keeps pasting is the parameter. */
function commonLiterals(members: Instance[]): string[] {
  const sets = members.map(m => new Set(literals(m.text)))
  const first = [...(sets[0] ?? [])]
  return first.filter(l => sets.every(s => s.has(l))).sort()
}

/**
 * A trigger whose gist already covers this shape means the user took the offer once.
 * Re-proposing it is the "never two proactive messages about the same
 * underlying thing" rule, applied across weeks instead of across one turn.
 */
export function alreadyArmed(shape: string[], armed: string[]): boolean {
  return armed.some(g => {
    const t = new Set(tokenize(g))
    const hits = shape.filter(s => t.has(s)).length
    return hits >= Math.max(MIN_SHAPE, Math.ceil(shape.length * 0.6))
  })
}

/**
 * Action text a cold agent can execute three weeks from now, with the terms the user
 * actually used rather than a paraphrase. Written to the same contract as the
 * recipes skill: chat id inline, silence allowed, nothing assumed.
 */
export function draftAction(p: { terms: string[]; literals: string[]; chatId?: string }): string {
  const chat = p.chatId ?? '<chat_id>'
  const subject = p.literals.length ? p.literals.join(', ') : p.terms.join(' ')
  return (
    `Check ${subject}. Compose a short plain-text update for chat ${chat} — same contract as the morning brief: ` +
    `terse, omit empty sections, links only when load-bearing. Nothing genuinely new since last time → send nothing.`
  )
}

/**
 * The one-line offer, plus the two buttons it needs.
 *
 * Telegram caps callback data at 60 UTF-8 bytes and the draft action is ten
 * times that, so the button cannot carry the instruction itself — truncating it
 * would produce a button that does something *different* when tapped, which is
 * worse than one that does nothing. The candidate is therefore persisted first
 * (a `saved` note keyed by `id`) and the button carries the key. Taps still
 * survive restarts and still arrive self-contained; the self-contained part
 * just lives on disk instead of in sixty bytes.
 */
export function formatOffer(c: Candidate): { text: string; buttons: { label: string; data: string }[] } {
  const when = c.cron ? `around ${c.askedAt[0]}` : 'on a schedule you pick'
  const what = c.literals.length ? c.literals[0] : c.terms.slice(0, 3).join(' ')
  return {
    text: `you've asked me about ${what} ${c.count} times — ${c.askedAt.join(', ')}. want me to just do it ${when}?`,
    buttons: [
      { label: 'arm it', data: `arm repetition ${c.id}` },
      { label: 'no', data: `drop repetition ${c.id}; never offer it again` },
    ],
  }
}

/**
 * The note the offer must write before it sends, so the tap resolves later.
 *
 * `repetition:<id>` is the tag the button handler looks the note up by — the
 * bare id is kept alongside it because notes written before that tag existed
 * carry only that, and a decline recorded under the old scheme has to keep
 * counting.
 */
export function persistPayload(c: Candidate): { kind: 'saved'; text: string; tags: string[] } {
  return {
    kind: 'saved',
    text:
      `repetition ${c.id}: asked ${c.count}x (${c.askedAt.join(', ')}). ` +
      `Arming it means create_trigger cron "${c.cron ?? '0 8 * * *'}" with action: ${c.draftAction}`,
    tags: ['repetition', `repetition:${c.id}`, c.id],
  }
}

/**
 * Every candidate id the user has said no to, read out of whatever the notes
 * store happens to hold.
 *
 * Three schemes have written a decline: the button handler's
 * `repetition-declined` fact, the current offer note tagged `repetition:<id>`
 * and closed as dropped, and hand-written session notes tagged
 * `['repetition', '<id>', 'declined']`. All three mean the same thing to the
 * user, so all three are honoured rather than migrated — a missed decline is
 * exactly the failure this function exists to stop.
 */
export function declinedIds(
  notes: { tags?: string[]; status?: string }[],
): string[] {
  const out = new Set<string>()
  for (const n of notes) {
    const tags = n.tags ?? []
    if (!tags.includes('repetition') && !tags.some(t => t === 'repetition-declined')) continue
    const said_no =
      tags.includes('repetition-declined') || tags.includes('declined') || n.status === 'dropped'
    if (!said_no) continue
    for (const t of tags) {
      if (t.startsWith('repetition:')) out.add(t.slice('repetition:'.length))
      else if (/^[0-9a-f]{8}$/.test(t)) out.add(t)
    }
  }
  return [...out]
}
