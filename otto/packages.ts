/**
 * The package tracker.
 *
 * Every parcel the user is waiting on announces itself by email, several times:
 * the order confirmation, the dispatch notice with a tracking number, "out for
 * delivery", "delivered". Otto reads each of those every hour and, until now,
 * kept none of it — so "where's my package" meant re-reading the inbox.
 *
 * A package record is deliberately dumb: who carries it, its tracking number,
 * what it is, where it has got to, and the mail each step came from. Nothing
 * here talks to a carrier; the status is only ever what an email (or the user)
 * said, and `trackingUrl` hands the live answer to the carrier's own page.
 *
 * Two rules, both forced by the hourly re-read:
 *
 *   The source is the dedupe key. The same "shipped" mail is offered to
 *   recordPackage on every scan; a source already applied to a record is
 *   ignored, so a re-read never adds an event or moves anything.
 *
 *   Status only moves forward. Mail arrives out of order — a late "in transit"
 *   after "delivered" is common — and a parcel that walks backwards reads as a
 *   lost one. The one exception is 'exception', which can happen at any point.
 *
 * Usage (how the assistant records packages; the CLI writes the same file the
 * dashboard reads):
 *   bun otto/packages.ts parse --source email:<messageId> < mail.txt   # From:/Subject: lines, blank line, body → PackageInput JSON
 *   bun otto/packages.ts record '{"carrier":"DHL","tracking":"JD000000000000000000","status":"shipped","source":"email:<messageId>"}'
 *     prints "notify: <why>" on a second line only when the step is worth a message
 *   bun otto/packages.ts list [--json]
 *   bun otto/packages.ts done <id>
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { toDateKey } from './money.ts'

export type PackageStatus = 'ordered' | 'shipped' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception'

export const STATUSES: PackageStatus[] = ['ordered', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'exception']

export type PackageEvent = {
  at: string
  status: PackageStatus
  text: string
  /** "email:<messageId>", "manual". Never leaves the Mac. */
  source?: string
}

export type PackageRecord = {
  id: string
  /** A carrier key ('dhl', 'poste', …) when recognised, else as written; '' until a notice names one. */
  carrier: string
  /** Uppercase, no spaces. */
  tracking?: string
  merchant?: string
  item?: string
  /** The shop's order number, when the mail gave one: links the parcel to its receipt (returns.ts). */
  orderRef?: string
  status: PackageStatus
  /** YYYY-MM-DD. With etaLatest, the window's first day. */
  eta?: string
  etaLatest?: string
  /** Oldest first. */
  events: PackageEvent[]
  /** Every source already applied: the dedupe set. */
  sources: string[]
  createdAt: string
  updatedAt: string
  deliveredAt?: string
}

export type PackageInput = {
  carrier?: string
  tracking?: string
  merchant?: string
  item?: string
  orderRef?: string
  status?: PackageStatus
  eta?: string
  etaLatest?: string
  /** One line for the event list; defaults to the status. */
  text?: string
  /** When the step happened, per the mail. Defaults to now. */
  at?: string
  source?: string
}

/** A delivered package stays listed this long, and an untracked one merges by merchant+item within it. */
export const RECENT_DAYS = 30
const DAY_MS = 86_400_000

const RANK: Record<PackageStatus, number> = { ordered: 0, shipped: 1, in_transit: 2, out_for_delivery: 3, delivered: 4, exception: -1 }

const LABEL: Record<PackageStatus, string> = {
  ordered: 'Ordered', shipped: 'Shipped', in_transit: 'In transit',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered', exception: 'Delivery problem',
}

export function packageId(): string {
  return randomBytes(4).toString('hex')
}

export const normTracking = (t: string) => t.toUpperCase().replace(/\s+/g, '')

// ---------------------------------------------------------------------------
// Carriers
// ---------------------------------------------------------------------------

const ALIASES: Record<string, string> = {
  dhl: 'dhl', dhlexpress: 'dhl', dhlparcel: 'dhl',
  ups: 'ups',
  fedex: 'fedex',
  gls: 'gls', glsitaly: 'gls',
  brt: 'brt', bartolini: 'brt',
  poste: 'poste', posteitaliane: 'poste', sda: 'poste', sdaexpress: 'poste',
  inpost: 'inpost',
  amazon: 'amazon', amazonlogistics: 'amazon', amzl: 'amazon',
  usps: 'usps',
  correios: 'correios',
}

const NAMES: Record<string, string> = {
  dhl: 'DHL', ups: 'UPS', fedex: 'FedEx', gls: 'GLS', brt: 'BRT', poste: 'Poste Italiane',
  inpost: 'InPost', amazon: 'Amazon', usps: 'USPS', correios: 'Correios',
}

const URLS: Partial<Record<string, (t: string) => string>> = {
  dhl: t => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${t}&submit=1`,
  ups: t => `https://www.ups.com/track?tracknum=${t}`,
  fedex: t => `https://www.fedex.com/fedextrack/?trknbr=${t}`,
  gls: t => `https://gls-group.com/GROUP/en/parcel-tracking?match=${t}`,
  brt: t => `https://vas.brt.it/vas/sped_det_show.hsm?referer=sped_numspe_par.htm&Nspediz=${t}`,
  poste: t => `https://www.poste.it/cerca/index.html#/risultati-spedizioni/${t}`,
  inpost: t => `https://inpost.it/trova-il-tuo-pacco?number=${t}`,
  usps: t => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`,
  // Amazon Logistics has no public tracking page: the order page is behind a login.
}

/** "Poste Italiane", "SDA", "dhl express" → the key the store keeps. Unknown carriers pass through trimmed. */
export function carrierKey(name: string): string {
  return ALIASES[name.toLowerCase().replace(/[^a-z0-9]/g, '')] ?? name.trim()
}

export function carrierName(carrier: string): string {
  return NAMES[carrierKey(carrier)] ?? carrier.trim()
}

/** The carrier's own tracking page, or undefined when it has none (Amazon) or isn't known. */
export function trackingUrl(carrier: string, tracking?: string): string | undefined {
  const url = URLS[carrierKey(carrier)]
  return url && tracking ? url(encodeURIComponent(normTracking(tracking))) : undefined
}

// ---------------------------------------------------------------------------
// Reading courier mail
// ---------------------------------------------------------------------------
// One mail in, one PackageInput out (or null when it is not about a parcel), so
// the assistant records what the mail actually says instead of retyping it.
// it/en/pt house styles of GLS, Poste/SDA, BRT, DHL, UPS, Amazon, InPost and
// Correios, plus a generic fallback. Pure: the clock is a parameter.

const MONTHS: string[][] = [
  ['january', 'gennaio', 'janeiro', 'jan', 'gen'],
  ['february', 'febbraio', 'fevereiro', 'feb', 'fev'],
  ['march', 'marzo', 'março', 'marco', 'mar'],
  ['april', 'aprile', 'abril', 'apr', 'abr'],
  ['may', 'maggio', 'maio', 'mag', 'mai'],
  ['june', 'giugno', 'junho', 'jun', 'giu'],
  ['july', 'luglio', 'julho', 'jul', 'lug'],
  ['august', 'agosto', 'aug', 'ago'],
  ['september', 'settembre', 'setembro', 'sept', 'sep', 'sett', 'set'],
  ['october', 'ottobre', 'outubro', 'oct', 'ott', 'out'],
  ['november', 'novembre', 'novembro', 'nov'],
  ['december', 'dicembre', 'dezembro', 'dec', 'dic', 'dez'],
]
const MONTH_NUM = new Map<string, number>()
MONTHS.forEach((names, i) => names.forEach(n => MONTH_NUM.set(n, i + 1)))
const MONTH_ALT = [...MONTH_NUM.keys()].sort((a, b) => b.length - a.length).join('|')

const pad = (n: number) => String(n).padStart(2, '0')

/** A missing year is the nearest sensible one: this year, or next if that would be long past. */
function iso(y: number | undefined, m: number, d: number, now: Date): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
  let year = y
  if (year === undefined) {
    year = now.getUTCFullYear()
    if (Date.UTC(year, m - 1, d) < now.getTime() - 60 * DAY_MS) year++
  } else if (year < 100) year += 2000
  return `${year}-${pad(m)}-${pad(d)}`
}

type DateHit = { date: string; index: number; end: number }

/** Earliest date written in a string: dd/mm/yyyy, yyyy-mm-dd, "15 ottobre", "October 15th", "20 de outubro". */
export function findDate(s: string, now: Date): DateHit | undefined {
  const hits: DateHit[] = []
  const add = (m: RegExpExecArray | null, date: string | null | undefined) => {
    if (m && date) hits.push({ date, index: m.index, end: m.index + m[0].length })
  }
  let m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/.exec(s)
  add(m, m && iso(Number(m[3]), Number(m[2]), Number(m[1]), now))
  m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s)
  add(m, m && iso(Number(m[1]), Number(m[2]), Number(m[3]), now))
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|º|°)?\\s+(?:de\\s+)?(${MONTH_ALT})\\b\\.?(?:,?\\s+(?:de\\s+)?(\\d{4}))?`, 'i').exec(s)
  add(m, m && iso(m[3] ? Number(m[3]) : undefined, MONTH_NUM.get(m[2]!.toLowerCase())!, Number(m[1]), now))
  m = new RegExp(`\\b(${MONTH_ALT})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'i').exec(s)
  add(m, m && iso(m[3] ? Number(m[3]) : undefined, MONTH_NUM.get(m[1]!.toLowerCase())!, Number(m[2]), now))
  return hits.sort((a, b) => a.index - b.index)[0]
}

const hhmm = (h: string, m?: string) => `${pad(Number(h))}:${m ?? '00'}`

function findWindow(s: string): string | undefined {
  let m = /(\d{1,2})[:.h](\d{2})\s*(?:h\s*)?(?:-|–|—|to|e le|e as|and|e|a|alle)\s*(?:le |as |alle )?(\d{1,2})[:.h](\d{2})/i.exec(s)
  if (m) return `${hhmm(m[1]!, m[2])}-${hhmm(m[3]!, m[4])}`
  m = /(?:tra le|between|dalle|entre as|entre|from)\s*(\d{1,2})(?:[:.h](\d{2}))?\s*h?\s*(?:e le|e as|and|alle|a|to|e|-|–)\s*(?:le |as |alle )?(\d{1,2})(?:[:.h](\d{2}))?/i.exec(s)
  return m ? `${hhmm(m[1]!, m[2])}-${hhmm(m[3]!, m[4])}` : undefined
}

const ETA_CUE = new RegExp(
  '(?:consegna (?:prevista|stimata|entro|programmata)|consegnat[oa] il|(?:sarà|verrà) consegnat\\w+|data di consegna|prevista per|' +
  'estimated delivery|expected delivery|delivery (?:date|expected|estimated)|arriving|arrives|will arrive|delivered by|scheduled for|' +
  'previs[aã]o de entrega|entrega (?:prevista|estimada)|chegar[aá]|previsto para|il giorno)',
  'gi',
)

function findEta(text: string, now: Date): { date: string; window?: string } | undefined {
  for (const cue of text.matchAll(ETA_CUE)) {
    const from = cue.index! + cue[0].length
    const tail = text.slice(from, from + 110)
    const hit = findDate(tail, now)
    if (!hit) continue
    const around = text.slice(Math.max(0, from + hit.index - 50), from + hit.index) + ' ' + tail.slice(hit.end, hit.end + 70)
    const window = findWindow(around)
    return { date: hit.date, ...(window ? { window } : {}) }
  }
}

/** What a mail says happened. The four problems all land on 'exception'; the event text keeps which one. */
type MailState = 'ordered' | 'shipped' | 'in_transit' | 'out_for_delivery' | 'delivered'
  | 'attempted' | 'customs' | 'ready_for_pickup' | 'returned'

/** Clauses about the future ("when it is delivered", "sarà consegnato") must not read as the event itself. */
const FUTURE = /\b(?:will be|to be|when it(?:'s| is)|once it(?:'s| is)|if it(?:'s| is)|verrà|sarà|quando sarà|será|quando for|irá)\b[^.\n]{0,80}/gi
const HANDOFF = /consegnat[oa] (?:al|a) (?:corriere|vettore)|delivered to (?:the )?(?:carrier|courier)|entregue (?:à|a)s? transportadora/gi
/** Carrier slogans in every footer ("DHL Express – Excellence. Simply delivered.") say nothing about the parcel. */
const SLOGAN = /simply delivered/gi

// Priority order matters: the strongest, most specific event wins.
const STATE_RULES: [MailState, RegExp][] = [
  ['returned', /rispedit|reso al mittente|return(?:ed)? to sender|devolvido ao remetente|devolu[cç][aã]o ao remetente|in restituzione/],
  ['attempted', /tentativo di consegna|mancata consegna|consegna non riuscita|non (?:è stato possibile consegnare|consegnat)|destinatario assente|(?:failed|unsuccessful|missed) delivery|delivery attempt (?:failed|unsuccessful)|attempted delivery|unable to deliver|could not be delivered|couldn.t deliver|\bundeliver|tentativa de entrega|n[aã]o foi poss[ií]vel entregar|destinat[aá]rio ausente|entrega n[aã]o realizada/],
  ['customs', /dogana|sdoganamento|customs|fiscaliza[cç][aã]o|aduan|taxa[cç][aã]o|import(?:ação)? (?:duties|tax)|imposto de importa/],
  ['ready_for_pickup', /giacenza|pronto per il ritiro|disponibile per il ritiro|da ritirare|ritira(?:re)? (?:il |la )?(?:tuo |suo )?(?:pacco|ordine|spedizione)|ready (?:for|to be) (?:pick-?up|collect)|ready to collect|awaiting collection|available for (?:pick-?up|collection)|collect (?:it |your parcel )?(?:from|within)|aguardando retirada|dispon[ií]vel para retirada|retire (?:seu|o) objeto|pronto para retirada|held at/],
  ['delivered', /\bconsegnat[oa]\b|\bdelivered\b|\bentregue\b|zugestellt/],
  ['out_for_delivery', /in consegna|out for delivery|saiu para (?:a )?entrega|partito per la consegna|notifica partenza|in arrivo oggi|arriving today|arrives today|with (?:the |your )?driver|em rota de entrega|na rota de entrega|chega hoje/],
  ['in_transit', /in transito|in transit|in viaggio|en route|arrivat[oa] (?:al|presso|in) (?:centro|hub|filiale|deposito|sede)|arrived at|departed from|left (?:the |our )?(?:facility|depot)|em tr[aâ]nsito|objeto encaminhado|smistamento|processed at|partito da/],
  ['shipped', /\bshipped\b|\bspedit[oa]\b|affidat[oa] al corriere|presa in carico|ritirat[oa] dal corriere|picked up|label created|etichetta creata|objeto postado|\bpostado\b|\benviado\b|despachado|dispatched|on (?:its|the) way|è partito|è stato spedito/],
  ['ordered', /ordine (?:confermato|ricevuto)|(?:thanks|thank you) for your order|grazie per il (?:tuo )?ordine|order (?:confirmation|received|placed)|\bordered:|pedido (?:confirmado|recebido)|obrigad[oa] pelo (?:seu )?pedido/],
]

function stateOf(s: string): MailState | undefined {
  const t = s.toLowerCase().replace(HANDOFF, ' ').replace(SLOGAN, ' ').replace(FUTURE, ' ')
  return STATE_RULES.find(([, re]) => re.test(t))?.[0]
}

const SENDERS: [string, RegExp][] = [
  ['amazon', /amazon\./i], ['inpost', /inpost/i], ['gls', /\bgls\b|gls-/i],
  ['poste', /\bsda\b|sda\.it/i], ['poste', /poste\.it|postemail|poste ?italiane/i],
  ['brt', /\bbrt\b|bartolini/i], ['dhl', /\bdhl\b/i], ['ups', /\bups\b|ups\.com/i],
  ['correios', /correios/i],
]

/** A carrier key, or '' when neither the sender nor the number says which. */
function carrierOf(from: string, subject: string, text: string, tracking?: string): string {
  for (const hay of [from, subject, text.slice(0, 300)]) {
    const hit = SENDERS.find(([, re]) => re.test(hay))
    if (hit) return hit[0]
  }
  if (tracking?.startsWith('1Z')) return 'ups'
  if (tracking?.endsWith('BR')) return 'correios'
  if (tracking?.endsWith('IT')) return 'poste'
  return ''
}

const LABELLED = /(?:tracking|track id|track|spedizione|segnacollo|waybill|lettera di vettura|parcel|sendungsnummer|rastreio|rastreamento|objeto|numero|number|nr)\b[^\d\n]{0,25}?(\d{8,24})\b/i

function trackingOf(s: string): string | undefined {
  const m =
    /\b(1Z[0-9A-Z]{16})\b/i.exec(s) ??
    /\b([A-Z]{2}\d{9}(?:IT|BR))\b/.exec(s) ??
    /\b(TBA\d{9,})\b/.exec(s) ??
    /\b(JJD\d{16,18}|JVGL\d{16,})\b/.exec(s) ??
    /\b(\d{24})\b/.exec(s) ??
    LABELLED.exec(s)
  return m?.[1]?.toUpperCase()
}

const AMAZON_ORDER = /\b(\d{3}-\d{7}-\d{7})\b/
const ORDER_LABEL = /(?:order|ordine|pedido)\b\s*(?:n\.?|no\.?|number|numero|#|nº)?\s*[:#]?\s*(?=[A-Z0-9-]*\d)([A-Z0-9-]{5,24})\b/i

function pickupOf(s: string): string | undefined {
  const m =
    /(?:punto di ritiro|pick-?up point|pickup point|collection point|locker|ritira(?:re)? presso|ritiro presso|collect from|retire em|retirar em|ponto de retirada|ag[eê]ncia)\s*[:\-]\s*([^\n]{3,80})/i.exec(s)
  if (m) return m[1]!.trim().replace(/[.,;]+$/, '')
  return /Paczkomat\S*\s+([A-Z]{3}\d{2,3}[A-Z]?)/.exec(s)?.[0]
}

function merchantOf(carrier: string, s: string): string | undefined {
  if (carrier === 'amazon') return 'Amazon'
  const m = /(?:mittente|sender|shipper|remetente|spedito da|shipped by|ordine da|order from)(?!['’]s\s+ref)\s*[:\-]?\s*([^\n]{2,60})/i.exec(s)
  const name = m?.[1]?.trim().replace(/[.,;]+$/, '')
  // "Shipper's Reference N/A" is an empty form field, not a shop.
  return name && !/^n\/?a\b/i.test(name) ? name : undefined
}

const PROBLEM_TEXT: Record<'attempted' | 'customs' | 'ready_for_pickup' | 'returned', string> = {
  attempted: 'Delivery attempt failed', customs: 'Held at customs', ready_for_pickup: 'Ready for pickup', returned: 'Returned to sender',
}

/**
 * Read one courier or retailer mail into a PackageInput. Null when it is not
 * about a parcel, or says nothing about where the parcel is: nothing to record.
 */
export function parsePackageMail(
  mail: { from?: string; subject?: string; text?: string },
  now: Date = new Date(),
): PackageInput | null {
  const from = mail.from ?? '', subject = mail.subject ?? '', text = mail.text ?? ''
  const all = `${subject}\n${text}`
  // The subject is the headline; the body is full of history and boilerplate.
  const state = stateOf(subject) ?? stateOf(text)
  if (!state) return null
  const tracking = trackingOf(all)
  let orderRef = AMAZON_ORDER.exec(all)?.[1] ?? ORDER_LABEL.exec(all)?.[1]
  if (orderRef === tracking) orderRef = undefined
  if (!tracking && !orderRef) return null
  const carrier = carrierOf(from, subject, text, tracking)
  const merchant = merchantOf(carrier, all)
  if (!tracking && !merchant) return null

  const eta = state === 'delivered' || state === 'returned' ? undefined : findEta(all, now)
  const pickup = state === 'ready_for_pickup' ? pickupOf(all) : undefined
  const status: PackageStatus = state in PROBLEM_TEXT ? 'exception' : (state as PackageStatus)
  let line = state in PROBLEM_TEXT ? PROBLEM_TEXT[state as keyof typeof PROBLEM_TEXT] : LABEL[status]
  if (pickup) line += ` at ${pickup}`
  if (eta?.window) line += `, ${eta.window}`
  return {
    status,
    ...(carrier ? { carrier } : {}),
    ...(tracking ? { tracking } : {}),
    ...(orderRef ? { orderRef } : {}),
    ...(merchant ? { merchant } : {}),
    ...(eta ? { eta: eta.date } : {}),
    text: line,
  }
}

/** "From:"/"Subject:" lines up to the first blank line, then the body; plain text is all body. */
export function splitMail(raw: string): { from?: string; subject?: string; text: string } {
  const s = raw.replace(/\r\n?/g, '\n')
  const m = /^((?:(?:from|subject|to|date):[^\n]*\n)+)\n/i.exec(s)
  if (!m) return { text: s }
  const head = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'im').exec(m[1])?.[1]?.trim()
  return { from: head('from'), subject: head('subject'), text: s.slice(m[0].length) }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function loadPackages(file: string): PackageRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as PackageRecord[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: packages.json corrupt, moved aside.\n')
    }
    return []
  }
}

export function savePackages(file: string, records: PackageRecord[]): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

const normRef = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * The record this notice is about: same carrier+tracking; else the same order
 * number when one side has no tracking yet (the order mail, then the courier's);
 * else same merchant+item within 30 days when one side has no tracking.
 */
function findPackage(records: PackageRecord[], input: PackageInput, carrier: string, tracking: string | undefined, now: number): PackageRecord | undefined {
  if (tracking) {
    const hit = records.find(r => r.tracking === tracking && (!carrier || !r.carrier || r.carrier === carrier))
    if (hit) return hit
  }
  const ref = input.orderRef?.trim() ? normRef(input.orderRef) : ''
  if (ref) {
    const hit = records.find(r => r.orderRef && normRef(r.orderRef) === ref && (!tracking || !r.tracking))
    if (hit) return hit
  }
  return records.find(r =>
    same(r.merchant, input.merchant) && same(r.item, input.item) && (!tracking || !r.tracking) &&
    now - Date.parse(r.createdAt) <= RECENT_DAYS * DAY_MS)
}

/** One step onto a record: the event always, the status only forward (or to 'exception'). */
function applyEvent(r: PackageRecord, ev: PackageEvent, now: Date): void {
  // The furthest it has been, not where it is: after an exception it may resume, never regress.
  const reached = Math.max(RANK[r.status], ...r.events.map(e => RANK[e.status]))
  if (ev.status === 'exception' || RANK[ev.status] >= reached) {
    r.status = ev.status
    if (ev.status === 'delivered') r.deliveredAt ??= ev.at
  }
  r.events.push(ev)
  r.events.sort((a, b) => a.at.localeCompare(b.at))
  if (ev.source) r.sources.push(ev.source)
  r.updatedAt = now.toISOString()
}

/** The steps worth a message: out for delivery, delivered, and every kind of problem. */
const NOTIFY: PackageStatus[] = ['out_for_delivery', 'delivered', 'exception']

/**
 * Record a shipping notice: a new package, a step on a known one, or nothing
 * when this source was already applied. `applied` is false only for that last case.
 *
 * `notify` is the one bit the assistant needs to stay quiet correctly: true only
 * when the parcel reached a NOTIFY step it was not already at, or its ETA moved
 * later. A re-read, a plain shipped or in-transit step, or a late mail repeating
 * old news never sets it.
 */
export function recordPackage(
  file: string,
  input: PackageInput,
  now = new Date(),
): { record: PackageRecord; created: boolean; applied: boolean; notify: boolean; why: string } {
  const status = input.status ?? 'ordered'
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`)
  const tracking = input.tracking?.trim() ? normTracking(input.tracking) : undefined
  const carrier = input.carrier?.trim() ? carrierKey(input.carrier) : ''
  if (!tracking && !input.merchant?.trim()) throw new Error('tracking or merchant is required')
  const eta = input.eta ? toDateKey(input.eta) : undefined
  const etaLatest = input.etaLatest ? toDateKey(input.etaLatest) : undefined
  if ((input.eta && !eta) || (input.etaLatest && !etaLatest)) throw new Error('eta and etaLatest must be dates (YYYY-MM-DD)')
  const at = input.at && !Number.isNaN(Date.parse(input.at)) ? new Date(input.at).toISOString() : now.toISOString()

  const records = loadPackages(file)
  let record = findPackage(records, input, carrier, tracking, now.getTime())
  if (record && input.source && record.sources.includes(input.source)) return { record, created: false, applied: false, notify: false, why: 'already recorded' }

  const created = !record
  if (!record) {
    record = { id: packageId(), carrier, status: 'ordered', events: [], sources: [], createdAt: now.toISOString(), updatedAt: now.toISOString() }
    records.push(record)
  }
  if (!record.carrier && carrier) record.carrier = carrier
  if (!record.tracking && tracking) record.tracking = tracking
  if (!record.merchant && input.merchant?.trim()) record.merchant = input.merchant.trim()
  if (!record.item && input.item?.trim()) record.item = input.item.trim()
  if (!record.orderRef && input.orderRef?.trim()) record.orderRef = input.orderRef.trim()
  const before = { status: record.status, eta: record.eta }
  // A new estimate replaces the whole window: a stale etaLatest would widen it into a lie.
  // Only from a mail at least as new as the newest step: an old mail's estimate is old news.
  const newest = record.events.at(-1)?.at
  if (eta && (!newest || at >= newest)) { record.eta = eta; if (etaLatest) record.etaLatest = etaLatest; else delete record.etaLatest }

  applyEvent(record, { at, status, text: input.text?.trim() || LABEL[status], ...(input.source ? { source: input.source } : {}) }, now)
  savePackages(file, records)
  const notes: string[] = []
  if (record.status !== before.status || created) {
    if (NOTIFY.includes(record.status)) notes.push(created ? `new package, already ${LABEL[record.status].toLowerCase()}` : `${LABEL[before.status].toLowerCase()} → ${LABEL[record.status].toLowerCase()}`)
  } else if (record.status === 'exception' && status === 'exception' && !created) {
    // A second, different problem (a failed attempt, then a pickup hold) is news too.
    if (record.events.at(-1)?.source === input.source && record.events.at(-1)?.text !== record.events.at(-2)?.text) notes.push(record.events.at(-1)!.text)
  }
  if (before.eta && record.eta && record.eta > before.eta && record.status !== 'delivered') notes.push(`eta ${before.eta} → ${record.eta}`)
  return { record, created, applied: true, notify: notes.length > 0, why: notes.join(', ') || 'no change worth a message' }
}

/** The user said it arrived. Undefined when no such package. */
export function markDelivered(file: string, id: string, now = new Date()): PackageRecord | undefined {
  const records = loadPackages(file)
  const r = records.find(p => p.id === id)
  if (!r) return undefined
  if (r.status !== 'delivered') {
    applyEvent(r, { at: now.toISOString(), status: 'delivered', text: 'Marked delivered' }, now)
    savePackages(file, records)
  }
  return r
}

/** Still coming first, soonest eta first (none last); then delivered in the last 30 days, newest first. Older ones stay in the file, unlisted. */
export function activePackages(records: PackageRecord[], now = Date.now()): PackageRecord[] {
  const open = records.filter(r => r.status !== 'delivered')
    .sort((a, b) => (a.eta ?? '9999').localeCompare(b.eta ?? '9999') || b.updatedAt.localeCompare(a.updatedAt))
  const done = records.filter(r => r.status === 'delivered' && now - Date.parse(r.deliveredAt ?? r.updatedAt) <= RECENT_DAYS * DAY_MS)
    .sort((a, b) => (b.deliveredAt ?? b.updatedAt).localeCompare(a.deliveredAt ?? a.updatedAt))
  return [...open, ...done]
}

export function formatPackage(r: PackageRecord): string {
  const bits = [r.id, LABEL[r.status]]
  const what = [r.item, r.merchant].filter(Boolean).join(' from ')
  if (what) bits.push(what)
  if (r.carrier || r.tracking) bits.push([carrierName(r.carrier), r.tracking].filter(Boolean).join(' '))
  if (r.status === 'delivered' && r.deliveredAt) bits.push(`delivered ${r.deliveredAt.slice(0, 10)}`)
  else if (r.eta) bits.push(`eta ${r.eta}${r.etaLatest ? `–${r.etaLatest}` : ''}`)
  return bits.join(' · ')
}

export const PACKAGES_FILE = join(
  process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'),
  'packages.json',
)

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2)
  try {
    if (cmd === 'parse') {
      const i = process.argv.indexOf('--source')
      const source = i > 0 ? process.argv[i + 1] : undefined
      const parsed = parsePackageMail(splitMail(await Bun.stdin.text()))
      if (!parsed) { console.log('null'); process.exitCode = 1 } else console.log(JSON.stringify({ ...parsed, ...(source ? { source } : {}) }))
    } else if (cmd === 'record' && arg) {
      const { record, created, applied, notify, why } = recordPackage(PACKAGES_FILE, JSON.parse(arg))
      console.log(`${created ? 'new' : applied ? 'updated' : 'already recorded'}: ${formatPackage(record)}${notify ? `\nnotify: ${why}` : ''}`)
    } else if (cmd === 'list') {
      const rows = activePackages(loadPackages(PACKAGES_FILE))
      console.log(process.argv.includes('--json') ? JSON.stringify(rows, null, 2) : rows.map(formatPackage).join('\n') || 'no packages')
    } else if (cmd === 'done' && arg) {
      const r = markDelivered(PACKAGES_FILE, arg)
      if (!r) { console.error(`no package ${arg}`); process.exitCode = 1 } else console.log(formatPackage(r))
    } else {
      console.log("usage: bun otto/packages.ts parse [--source email:<id>] < mail | record '<json>' | list [--json] | done <id>")
      process.exitCode = 2
    }
  } catch (err) {
    console.error(String((err as Error).message ?? err))
    process.exitCode = 2
  }
}
