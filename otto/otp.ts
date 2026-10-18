/**
 * The OTP fast lane.
 *
 * A verification code is the one message whose value falls to zero on a
 * timer. Waking the session, letting it read the brief, decide, and reply
 * costs most of a minute; a hold for quiet hours or a calendar event can cost
 * an hour. By then the login page has given up. So when the Gmail push carries
 * a code, the channel itself lifts it out and sends `<sender>: <code>` before
 * the model has seen anything, and deletes that message a few minutes later
 * so a code does not sit in the chat for good.
 *
 * The extractor is deliberately narrow. A false positive is a stranger's order
 * number pushed through quiet hours at full priority, which is worse than a
 * code that took the slow path, so every candidate has to sit near a word
 * that means "code" and clear a list of things that merely look like one:
 * years, dates, times, money, phone numbers, order and tracking numbers.
 * Matching runs on text with accents stripped, so "código" and "codigo",
 * "verificação" and "verificacao" are the same word.
 *
 * Email content is data: the sender's display name is written by whoever sent
 * the mail, so it is cleaned and capped before it reaches the user, and the
 * store keeps only a hash of sender and code — the code itself never touches
 * disk.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'

export type Otp = { code: string; sender: string }

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Words that mean "this is a code", in English, Italian and Portuguese. */
const KEYWORD = /\b(otp|2fa|one[- ]?time|passcode|pass code|verif\w*|codes?|codice|codici|codigo|accesso|acesso|senha|two[- ]factor|autentica\w*|authenticat\w*|monouso)\b/g

/** Things a code-looking number usually is instead. Checked in the few words
 * around the keyword ("tracking code", "codice ordine", "código de rastreio")
 * and just before the candidate ("Order 482913", "pedido 482913"). Narrow on
 * purpose: OTP mails say "we will never call you" and "your account", so a
 * word only belongs here if it names the number itself. */
const NEGATIVE = new RegExp(
  '\\b(' + [
    'orders?', 'ordine', 'ordini', 'pedidos?', 'encomenda',
    'tracking', 'track', 'rastreio', 'rastreamento', 'spedizione', 'shipment', 'parcel', 'pacco',
    'invoice', 'fattura', 'nota fiscal', 'receipt', 'ricevuta', 'recibo',
    'booking', 'prenotazione', 'reserva', 'reservation', 'pnr', 'ticket', 'biglietto', 'bilhete',
    'promo\\w*', 'promocional', 'discount', 'sconto', 'desconto', 'coupon', 'cupom', 'voucher', 'gift',
    'postal', 'zip', 'postcode', 'cap', 'cep', 'fiscale',
    'cliente', 'customer', 'protocol\\w*', 'reference', 'riferimento', 'referencia', 'ref',
    'phone', 'telefono', 'telefone', 'tel', 'call', 'chiama\\w*', 'ligue', 'ligar', 'whatsapp', 'celular', 'cellulare',
    'serial', 'seriale', 'flight', 'volo', 'voo', 'seat', 'gate',
    // "account ending 4821", "carta terminante 4821", "cartão final 4821"
    'ending', 'ends', 'final', 'finale', 'terminante', 'terminada', 'terminado', 'card', 'carta', 'cartao',
  ].join('|') + ')\\b',
)

/** A run of digit groups: "482913", "482-913", "12/03/2025", "1.234,56". */
const RUN = /\+?\d+(?:[.,/-]\d+)*/g
/** "482 913" — a code printed in halves for reading aloud — but not a stretch
 * of a phone number like "+44 20 7946 012". */
const HALVES = /(?<![\d.,/+-]|\d )(\d{3}) (\d{3})(?![\d]|[.,/-]\d| \d)/g
const ALNUM = /\b[A-Za-z0-9]{6}\b/g
const MONEY_BEFORE = /(r\$|us\$|\$|€|£|\beur|\busd|\bbrl|\bgbp|\bchf)\s*$/i
const AFTER_NOT_CODE = /^\s*(%|€|£|\$|eur\b|euros?\b|usd\b|brl\b|reais\b|real\b|dollars?\b|dolares\b|am\b|pm\b|h\b|hrs?\b|utc\b|gmt\b|min\b|minut)/i

/** Before the keyword, a code can sit this far away ("your code is below:\n\n482913"). */
const BEFORE_REACH = 80
/** After it, less: "482913 is your verification code". */
const AFTER_REACH = 40

/** Strip accents, keep length stable enough for proximity — combining marks
 * are dropped after NFD, so "código" becomes "codigo". */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function isYear(d: string): boolean {
  if (d.length !== 4) return false
  const n = Number(d)
  return n >= 1900 && n <= 2099
}

function isCompactDate(d: string): boolean {
  return d.length === 8 && /^(19|20)\d\d(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(d)
}

function lastWords(s: string, n: number): string {
  return s.split(/\s+/).filter(Boolean).slice(-n).join(' ')
}

function firstWords(s: string, n: number): string {
  return s.split(/\s+/).filter(Boolean).slice(0, n).join(' ')
}

type Candidate = { code: string; start: number; end: number; numeric: boolean }

function candidates(t: string): Candidate[] {
  const out: Candidate[] = []
  for (const m of t.matchAll(RUN)) {
    const raw = m[0]
    const start = m.index!
    const end = start + raw.length
    const before = t.slice(0, start)
    const after = t.slice(end)
    // Glued to a word ("AB123456", "x2") or an id ("#482913", "nº 4829").
    if (/[A-Za-z0-9_#]$/.test(before) || /^[A-Za-z0-9_]/.test(after)) continue
    if (/(n[º°o.]|#)\s*$/i.test(before)) continue
    if (raw.startsWith('+')) continue
    if (MONEY_BEFORE.test(before) || AFTER_NOT_CODE.test(after)) continue
    // Digits a single space away are a phone number or an account number
    // printed in groups ("4004 0001", "+44 20 79460123").
    if (/\d $/.test(before) || /^ \d{3}/.test(after)) continue
    // ":" isn't a run separator, so "10:30" arrives as two short runs; this
    // keeps "1030" out of "10:30" if it ever reaches four digits either side.
    if (/:\d*$/.test(before) || /^:\d/.test(after)) continue

    const groups = raw.split(/\D+/).filter(Boolean)
    let code: string
    if (groups.length === 1) {
      code = groups[0]
    } else if (groups.length === 2 && groups[0].length === 3 && groups[1].length === 3 && /^\d{3}-\d{3}$/.test(raw)) {
      // "482-913": a code printed in halves for reading aloud.
      code = groups.join('')
    } else {
      // Dates, decimals, phone numbers, account numbers: several groups is
      // never a code we can tell apart from them.
      continue
    }
    if (code.length < 4 || code.length > 8) continue
    if (isYear(code) || isCompactDate(code)) continue
    out.push({ code, start, end, numeric: true })
  }
  for (const m of t.matchAll(ALNUM)) {
    const raw = m[0]
    // Six letters is a word; six digits was handled above. Codes in the wild
    // are uppercase, which also keeps "mp3abc"-style tokens out.
    if (!/\d/.test(raw) || !/[A-Za-z]/.test(raw) || /[a-z]/.test(raw)) continue
    const start = m.index!
    const end = start + raw.length
    const before = t.slice(0, start)
    const after = t.slice(end)
    if (/[#/-]$/.test(before) || /^[/-][A-Za-z0-9]/.test(after)) continue
    out.push({ code: raw, start, end, numeric: false })
  }
  return out
}

type Keyword = { start: number; end: number }

function keywords(t: string): Keyword[] {
  const lower = t.toLowerCase()
  const out: Keyword[] = []
  for (const m of lower.matchAll(KEYWORD)) {
    const start = m.index!
    const end = start + m[0].length
    // "tracking code", "codice ordine", "código de rastreio", "codice fiscale":
    // the keyword is about something else.
    // Only within the clause: "Your code: 482913. Call us if…" is not a phone code.
    const before = lower.slice(Math.max(0, start - 40), start).split(/[.:;!?\n]/).pop() ?? ''
    const after = lower.slice(end, end + 40).split(/[.:;!?\n]/)[0]
    const around = `${lastWords(before, 3)} ${firstWords(after, 3)}`
    if (NEGATIVE.test(around)) continue
    out.push({ start, end })
  }
  return out
}

/** Find the code in one stretch of mail text: subject plus snippet. */
export function findCode(text: string): string | null {
  const t = fold(text)
    .replace(/\[id [^\]]*\]/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\S+@\S+/g, ' ')
    .replace(HALVES, '$1$2')
  const kws = keywords(t)
  if (!kws.length) return null

  let best: { code: string; d: number; numeric: boolean; start: number } | null = null
  for (const c of candidates(t)) {
    // "Order 482913" — the words right before the number name it.
    if (NEGATIVE.test(lastWords(t.slice(Math.max(0, c.start - 40), c.start).toLowerCase(), 3))) continue
    let d = Infinity
    for (const k of kws) {
      if (k.end <= c.start && c.start - k.end <= BEFORE_REACH) d = Math.min(d, c.start - k.end)
      else if (k.start >= c.end && k.start - c.end <= AFTER_REACH) d = Math.min(d, k.start - c.end)
    }
    if (d === Infinity) continue
    const better = !best
      || d < best.d
      || (d === best.d && c.numeric && !best.numeric)
    if (better) best = { code: c.code, d, numeric: c.numeric, start: c.start }
  }
  return best?.code ?? null
}

/** A display name is written by whoever sent the mail: no control characters,
 * no markup brackets, short enough that it cannot carry a paragraph. */
export function cleanSender(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f<>`*_[\]]/g, ' ')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim()
}

/** "noreply@accounts.bank.example" → "Bank". The best name an address alone gives. */
export function senderFromAddress(addr: string): string {
  const domain = addr.split('@')[1]?.toLowerCase() ?? ''
  const labels = domain.split('.').filter(Boolean)
  if (labels.length < 2) return cleanSender(addr)
  let i = labels.length - 2
  // "bank.co.uk", "banco.com.br": the second-level label is the suffix, not the name.
  if (i > 0 && labels[labels.length - 1].length === 2 && /^(co|com|gov|org|net|ac|edu)$/.test(labels[i])) i--
  const name = labels[i]
  return cleanSender(name.charAt(0).toUpperCase() + name.slice(1))
}

const LINE = /^\s*-\s+(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*(?:—|–|--?)\s*(.*)$/
const BARE_LINE = /^\s*-\s+([^\s<>]+@[^\s<>]+)\s*(?:—|–|--?)\s*(.*)$/

/**
 * Every code in a Gmail push, one per mail line:
 * `- Bank <noreply@bank.example> — Your code — Your verification code is 482913 [id abc]`.
 * Text that isn't in that shape is scanned whole, with no sender.
 */
export function extractOtps(text: string): Otp[] {
  const out: Otp[] = []
  let sawLine = false
  for (const line of text.split('\n')) {
    const m = LINE.exec(line)
    const b = m ? null : BARE_LINE.exec(line)
    if (!m && !b) continue
    sawLine = true
    const body = m ? m[3] : b![2]
    const code = findCode(body)
    if (!code) continue
    const sender = m ? (cleanSender(m[1]) || senderFromAddress(m[2])) : senderFromAddress(b![1])
    out.push({ code, sender })
  }
  if (!sawLine) {
    const code = findCode(text)
    if (code) out.push({ code, sender: '' })
  }
  return out
}

/** The first code in the text, or null. */
export function extractOtp(text: string): Otp | null {
  return extractOtps(text)[0] ?? null
}

/** What the user sees. No markup: the sender name is not ours. */
export function formatOtp(o: Otp): string {
  return o.sender ? `${o.sender}: ${o.code}` : o.code
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type OtpConfig = {
  /** Default true. */
  enabled?: boolean
  /** Delete the Telegram message after this long. Default 10; 0 keeps it. */
  deleteAfterMinutes?: number
}

export const OTP_DEDUPE_MS = 10 * 60_000
/** A burst of mails that all look like codes is someone else's doing; past
 * this many in the dedupe window the rest take the ordinary path. */
export const OTP_BURST_MAX = 5
/** Telegram refuses to delete a bot's message older than 48h. */
export const OTP_DELETE_GIVE_UP_MS = 48 * 3_600_000

export function otpSettings(cfg: OtpConfig | undefined): { enabled: boolean; deleteAfterMs: number } {
  const mins = cfg?.deleteAfterMinutes
  const valid = typeof mins === 'number' && Number.isFinite(mins) && mins >= 0
  return {
    enabled: cfg?.enabled !== false,
    deleteAfterMs: (valid ? mins : 10) * 60_000,
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type OtpState = {
  /** Hash of sender + code, and when it went out. Never the code itself. */
  sent: { key: string; at: number }[]
  /** Telegram messages to delete once due. */
  deletes: { chat_id: string; message_id: number; dueAt: number }[]
}

export function emptyOtpState(): OtpState {
  return { sent: [], deletes: [] }
}

export function otpKey(o: Otp): string {
  return createHash('sha256').update(`${o.sender.toLowerCase()}\u0000${o.code}`).digest('hex').slice(0, 16)
}

/** What to do with a code: send it, skip it as a repeat the user already has,
 * or leave it to the session because the burst cap is spent. */
export function otpVerdict(s: OtpState, o: Otp, now: number): 'send' | 'duplicate' | 'burst' {
  const live = s.sent.filter(e => now - e.at < OTP_DEDUPE_MS)
  const key = otpKey(o)
  if (live.some(e => e.key === key)) return 'duplicate'
  return live.length >= OTP_BURST_MAX ? 'burst' : 'send'
}

export function recordSent(s: OtpState, o: Otp, now: number): void {
  s.sent.push({ key: otpKey(o), at: now })
}

export function scheduleDelete(s: OtpState, chat_id: string, message_id: number, dueAt: number): void {
  s.deletes.push({ chat_id, message_id, dueAt })
}

/** Deletes whose time has come. They stay in the state until `settleDelete`. */
export function dueDeletes(s: OtpState, now: number): OtpState['deletes'] {
  return s.deletes.filter(d => d.dueAt <= now)
}

/** Drop a delete that succeeded, or that Telegram will never accept now. */
export function settleDelete(s: OtpState, chat_id: string, message_id: number): void {
  s.deletes = s.deletes.filter(d => !(d.chat_id === chat_id && d.message_id === message_id))
}

export function pruneOtp(s: OtpState, now: number): void {
  s.sent = s.sent.filter(e => now - e.at < OTP_DEDUPE_MS)
  s.deletes = s.deletes.filter(d => now - d.dueAt < OTP_DELETE_GIVE_UP_MS)
}

export function loadOtp(file: string): OtpState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<OtpState>
    return {
      sent: Array.isArray(parsed?.sent) ? parsed.sent : [],
      deletes: Array.isArray(parsed?.deletes) ? parsed.deletes : [],
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: otp.json corrupt, moved aside.\n')
    }
    return emptyOtpState()
  }
}

export function saveOtp(file: string, s: OtpState): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export const OTP_FILE = join(
  process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'),
  'otp.json',
)
