/**
 * Reply debt — threads where a real person asked the user something and has
 * been waiting days for an answer.
 *
 * The email scan already treats an unanswered thread that wants a reply as an
 * open loop, but only when the model happens to notice it while reading forty
 * other things. This is the deterministic half: given thread summaries, say
 * which ones are owed a reply, so the brief can list them and the scan can
 * record each one once.
 *
 * Everything here is pure. The gog calls that feed it live in brief.ts with the
 * rest of the brief's gathering; this module only turns their JSON into
 * summaries and the summaries into debts.
 *
 * What counts, all of it required:
 *   - the user is not the last to speak
 *   - the ask has been sitting at least `minDays` (default 3)
 *   - something in the unanswered run reads as a question or a request — a
 *     question mark, or a request phrase in English, Italian or Portuguese
 *   - the person asking is a person: not no-reply, newsletter, notification or
 *     info, not List-Unsubscribe mail, not anything marked automated
 */

export type ThreadMessage = {
  from: string
  /** ISO string or anything Date.parse accepts. */
  date: string
  snippet: string
  /** Sent by the user — the SENT label, or their own address on From. */
  fromUser: boolean
  /** The message carried a List-Unsubscribe header. */
  listUnsubscribe?: boolean
  /** Auto-Submitted, Precedence: bulk/list/junk, or a List-Id header. */
  automated?: boolean
}

export type ThreadSummary = {
  id: string
  participants: string[]
  messages: ThreadMessage[]
}

export type Debt = {
  threadId: string
  from: string
  askedAt: string
  daysWaiting: number
  snippet: string
}

export type DebtOpts = { now?: number; minDays?: number }

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Local parts and display names that are never a person. Matched against the
 * whole From value, so `Info <info@shop.example>` and `notifications@forge.example`
 * both go.
 */
const BULK_SENDER =
  /\b(?:no-?reply|do-?not-?reply|donotreply|newsletters?|notifications?|notify|info|news|marketing|mailer-daemon|mailer|postmaster|bounces?|alerts?|updates?|billing|digest)(?:[@+._-]|\b)/i

/** True when the sender reads as a mailbox for bulk mail rather than a person. */
export function isBulkSender(from: string): boolean {
  return BULK_SENDER.test(from)
}

const ASK_PHRASES = [
  // English
  'can you', 'could you', 'would you', 'will you', 'let me know', 'please confirm',
  'can we', 'could we', 'any update', 'any news', 'what do you think', 'are you free',
  'do you have', 'did you get', 'get back to me',
  // Italian
  'puoi', 'potresti', 'potete', 'fammi sapere', 'fatemi sapere', 'mi fai sapere',
  'mi dici', 'riesci a', 'ti va', 'che ne pensi', 'hai tempo', 'mi confermi',
  // Portuguese
  'você pode', 'voce pode', 'vc pode', 'pode me', 'poderia', 'me avisa', 'me avise',
  'me fala', 'me diz', 'consegue', 'o que acha', 'tem como', 'me confirma',
]

// \p{L} lookarounds instead of \b: \b is ASCII-only, so "você" would never end
// on a word boundary and "puoi" would match inside "dopuoi".
const ASK_RE = new RegExp(
  `(?<![\\p{L}])(?:${ASK_PHRASES.map(p => p.replace(/ /g, '\\s+')).join('|')})(?![\\p{L}])`,
  'iu',
)

/**
 * A reply quotes what came before it, and a snippet of a two-word reply is
 * mostly quote. Cut at the attribution line so the user's own earlier question
 * does not read as theirs.
 */
const QUOTE_START =
  /\b(?:On .{1,120}? wrote:|Il .{1,120}? ha scritto:|Em .{1,120}? escreveu:|-{2,} ?Original Message|-{2,} ?Messaggio originale|-{2,} ?Mensagem original)/i

/** The new text of a message: quote cut, entities decoded, links dropped. */
export function ownText(snippet: string): string {
  const decoded = decodeEntities(snippet)
  const m = QUOTE_START.exec(decoded)
  const own = m ? decoded.slice(0, m.index) : decoded
  return own.replace(/^>.*$/gm, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
}

/** Reads as a question or a request — the part that wants an answer. */
export function isAsk(snippet: string): boolean {
  const text = ownText(snippet)
  return text.includes('?') || ASK_RE.test(text)
}

/** fromCodePoint throws past U+10FFFF, and a mail can say &#99999999; — that becomes U+FFFD, not a broken brief. */
const codePoint = (n: number) => (n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd')

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function isPerson(m: ThreadMessage): boolean {
  return !m.fromUser && !m.listUnsubscribe && !m.automated && !isBulkSender(m.from)
}

/** "Marco Rossi <marco@example.com>" → "Marco Rossi"; a bare address stays. */
export function displayName(from: string): string {
  const name = from.replace(/<[^>]*>/, '').replace(/^["'\s]+|["'\s]+$/g, '').trim()
  return name || from.replace(/[<>]/g, '').trim()
}

/**
 * The threads owed a reply, longest wait first.
 *
 * The wait is measured from the first ask in the run of messages since the user
 * last spoke, not from the last message: someone who asked five days ago and
 * nudged yesterday has been waiting five days, and the nudge is exactly the
 * case worth catching.
 */
export function findReplyDebt(threads: ThreadSummary[], o: DebtOpts = {}): Debt[] {
  const now = o.now ?? Date.now()
  const minDays = o.minDays ?? 3
  const debts: Debt[] = []

  for (const t of threads) {
    const msgs = t.messages
      .map(m => ({ m, at: Date.parse(m.date) }))
      .filter(x => !Number.isNaN(x.at))
      .sort((a, b) => a.at - b.at)
    if (!msgs.length || msgs[msgs.length - 1].m.fromUser) continue

    let start = msgs.length
    while (start > 0 && !msgs[start - 1].m.fromUser) start--
    const unanswered = msgs.slice(start)

    // Bulk anywhere in the run spoils it: a person's question with a
    // notification on top is a notification thread.
    if (unanswered.some(x => x.m.listUnsubscribe || x.m.automated)) continue

    const ask = unanswered.find(x => isPerson(x.m) && isAsk(x.m.snippet))
    if (!ask) continue

    const days = Math.floor((now - ask.at) / DAY_MS)
    if (days < minDays) continue

    debts.push({
      threadId: t.id,
      from: ask.m.from,
      askedAt: new Date(ask.at).toISOString(),
      daysWaiting: days,
      snippet: ownText(ask.m.snippet),
    })
  }

  return debts.sort((a, b) => b.daysWaiting - a.daysWaiting || a.askedAt.localeCompare(b.askedAt))
}

// ---------------------------------------------------------------------------
// gog JSON → summaries
// ---------------------------------------------------------------------------

type RawHeader = { name?: string; value?: string }
type RawMessage = {
  id?: string
  labelIds?: string[]
  labels?: string[]
  snippet?: string
  internalDate?: string | number
  date?: string
  from?: string
  headers?: RawHeader[] | Record<string, string>
  payload?: { headers?: RawHeader[] }
}

function headerMap(m: RawMessage): Map<string, string> {
  const out = new Map<string, string>()
  const list = m.payload?.headers ?? (Array.isArray(m.headers) ? m.headers : undefined)
  if (list) {
    for (const h of list) if (h.name) out.set(h.name.toLowerCase(), h.value ?? '')
  } else if (m.headers && typeof m.headers === 'object') {
    for (const [k, v] of Object.entries(m.headers)) out.set(k.toLowerCase(), String(v))
  }
  return out
}

function addressOf(from: string): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase()
}

/**
 * One `gog gmail thread <id> --json` result as a summary. Accepts the Gmail API
 * shape (`payload.headers`, `labelIds`, `internalDate`) wrapped in `thread` or
 * not, and the flattened shape (`from`, `date`, `labels`). Returns null for
 * anything without messages — a thread it cannot read is skipped, not guessed.
 */
export function summarizeThread(raw: unknown, account: string, fallbackId = ''): ThreadSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { thread?: { id?: string; messages?: RawMessage[] }; id?: string; messages?: RawMessage[] }
  const t = r.thread ?? r
  if (!Array.isArray(t.messages) || !t.messages.length) return null
  const me = account.trim().toLowerCase()

  const messages: ThreadMessage[] = []
  for (const m of t.messages) {
    const h = headerMap(m)
    const from = h.get('from') ?? m.from ?? ''
    const labels = m.labelIds ?? m.labels ?? []
    const internal = Number(m.internalDate)
    const date = Number.isFinite(internal) && internal > 0
      ? new Date(internal).toISOString()
      : h.get('date') ?? m.date ?? ''
    const precedence = (h.get('precedence') ?? '').toLowerCase()
    const autoSubmitted = (h.get('auto-submitted') ?? 'no').toLowerCase()
    messages.push({
      from,
      date,
      snippet: m.snippet ?? '',
      fromUser: labels.includes('SENT') || (me !== '' && addressOf(from) === me),
      ...(h.has('list-unsubscribe') ? { listUnsubscribe: true } : {}),
      ...(autoSubmitted !== 'no' || ['bulk', 'list', 'junk'].includes(precedence) || h.has('list-id')
        ? { automated: true }
        : {}),
    })
  }

  const participants = [...new Set(messages.filter(m => !m.fromUser).map(m => m.from).filter(Boolean))]
  return { id: t.id ?? fallbackId, participants, messages }
}

/** Thread ids out of a `gog gmail search --json` result. */
export function threadIds(raw: unknown): string[] {
  const threads = (raw as { threads?: { id?: string }[] } | null)?.threads
  if (!Array.isArray(threads)) return []
  return threads.map(t => t?.id).filter((id): id is string => typeof id === 'string' && id !== '')
}
