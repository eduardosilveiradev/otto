/**
 * Document expiry radar.
 *
 * Passports, ID cards, residence permits, licences, health cards and visas all
 * expire, and the cost of noticing late is a missed flight or an irregular
 * stay. Each kind has a lead time: how long before expiry the user must act.
 * `radar` turns a store of documents into "act by" dates; nudges use the same
 * budgeted pattern as due-dated loops (escalation.ts): two, ever, per document.
 *
 * Privacy: only the last 3 characters of a document number are ever stored.
 * `normalizeTail` cuts anything longer, so a full number passed in is never
 * persisted or logged.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { recordStage, type EscalationState } from './escalation.ts'

export const KINDS = ['passport', 'id-card', 'residence-permit', 'driving-licence', 'health-card', 'visa'] as const
export type DocKind = typeof KINDS[number]

export type Doc = {
  id: string
  kind: DocKind
  /** ISO 3166-1 alpha-2, uppercase: the issuing country. */
  country: string
  /** 'me' or a person's name from people.json. */
  holder: string
  /** YYYY-MM-DD */
  expires: string
  /** Last 3 characters of the number, never more. */
  numberTail?: string
  notes?: string
  /** YYYY-MM-DD. Set once replaced; a renewed document leaves the radar. */
  renewedAt?: string
}

export type Status = 'ok' | 'act-soon' | 'act-now' | 'expired'
export type RadarRow = { doc: Doc; actBy: string; daysToAct: number; daysToExpiry: number; status: Status }

type Lead = { months?: number; days?: number }

/**
 * Lead = how long before expiry to act. Sources checked 2026-10; rules change,
 * so these are defaults to be corrected, not law.
 */
export function leadFor(kind: DocKind, country: string): Lead {
  // Passport: many countries require ~6 months' validity on entry (Schengen:
  // 3 months past departure; UAE, Thailand, China, Indonesia: 6 months; IATA
  // Timatic, Oct 2026). Plus ~2 months renewal processing (typical passport
  // office and consulate waits, Oct 2026).
  if (kind === 'passport') return { months: 8 }
  // Italian permesso di soggiorno: the renewal request must be filed within 60
  // days of expiry (Ministero dell'Interno, "Rinnovo del permesso", Oct 2026).
  if (kind === 'residence-permit' && country === 'IT') return { days: 60 }
  // Italian carta d'identita: comuni accept renewal from 180 days before
  // expiry (Ministero dell'Interno guidance, Oct 2026).
  if (kind === 'id-card' && country === 'IT') return { months: 6 }
  // Driving licence: ~4 months for reissue paperwork and medical; a house rule
  // chosen Oct 2026, not a statute.
  if (kind === 'driving-licence') return { months: 4 }
  // Default: 3 months; a house rule chosen Oct 2026.
  return { months: 3 }
}

const DAY = 86400000
const dayNum = (d: string) => Math.floor(Date.parse(d + 'T00:00:00Z') / DAY)
const iso = (n: number) => new Date(n * DAY).toISOString().slice(0, 10)

/** Calendar-month shift (negative subtracts), clamped to month end. */
export function addMonths(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z')
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + n)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d.toISOString().slice(0, 10)
}

export function actByDate(doc: Doc): string {
  const { months = 0, days = 0 } = leadFor(doc.kind, doc.country)
  return iso(dayNum(addMonths(doc.expires, -months)) - days)
}

/** act-soon = act-by falls inside the next 30 days. */
export const SOON_DAYS = 30

export function radar(docs: Doc[], today: string): RadarRow[] {
  return docs
    .filter(d => !d.renewedAt)
    .map(doc => {
      const actBy = actByDate(doc)
      const daysToAct = dayNum(actBy) - dayNum(today)
      const daysToExpiry = dayNum(doc.expires) - dayNum(today)
      const status: Status =
        daysToExpiry < 0 ? 'expired' : daysToAct <= 0 ? 'act-now' : daysToAct <= SOON_DAYS ? 'act-soon' : 'ok'
      return { doc, actBy, daysToAct, daysToExpiry, status }
    })
    .sort((a, b) => a.actBy.localeCompare(b.actBy))
}

/** Keep only the last 3 alphanumerics, uppercased. */
export function normalizeTail(raw: string | undefined): string | undefined {
  const t = (raw ?? '').replace(/[^A-Za-z0-9]/g, '').slice(-3).toUpperCase()
  return t || undefined
}

/** Insert or replace by id; without an id, match the open doc of same kind+country+holder. */
export function upsertDocument(docs: Doc[], input: Omit<Doc, 'id'> & { id?: string }): Doc {
  const country = input.country.toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('country must be an ISO 3166-1 alpha-2 code')
  if (!(KINDS as readonly string[]).includes(input.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expires) || Number.isNaN(Date.parse(input.expires))) {
    throw new Error('expires must be YYYY-MM-DD')
  }
  const holder = input.holder.trim() || 'me'
  const existing = docs.find(d => input.id ? d.id === input.id
    : d.kind === input.kind && d.country === country && d.holder === holder && !d.renewedAt)
  const doc: Doc = {
    ...existing, ...input, country, holder,
    id: existing?.id ?? input.id ?? `${input.kind}-${country}-${holder.toLowerCase().replace(/\W+/g, '')}-${input.expires.slice(0, 4)}`,
    numberTail: normalizeTail(input.numberTail) ?? existing?.numberTail,
  }
  for (const k of Object.keys(doc) as (keyof Doc)[]) if (doc[k] === undefined) delete doc[k]
  if (existing) docs[docs.indexOf(existing)] = doc
  else docs.push(doc)
  return doc
}

export function formatRadar(rows: RadarRow[]): string {
  if (!rows.length) return '(no documents recorded)'
  return rows.map(({ doc: d, actBy, daysToAct, daysToExpiry, status }) =>
    `[${d.id}] ${status}: ${d.holder} ${d.country} ${d.kind}${d.numberTail ? ` ...${d.numberTail}` : ''} expires ${d.expires} ` +
    `(${daysToExpiry}d), act by ${actBy} (${daysToAct}d)`).join('\n')
}

/** Passports the user holds that expire within 6 months after the trip's return date. */
export function passportProblems(tripEnd: string, docs: Doc[]): string[] {
  const limit = addMonths(tripEnd, 6)
  return docs
    .filter(d => d.kind === 'passport' && !d.renewedAt && d.expires < limit)
    .map(d => `${d.holder === 'me' ? '' : d.holder + ' '}passport expires ${d.expires}, under 6 months after return`)
}

// ---------------------------------------------------------------------------
// Nudges: two per document, ever - at act-by and 30 days later if not renewed.
// State lives in its own file (escalation.ts's pruner only knows loop ids).
// ---------------------------------------------------------------------------

export const CHASE_AFTER_DAYS = 30

/** The one nudge a document is entitled to right now, or null. Pure. */
export function planDocNudge(row: RadarRow, state: EscalationState): 'doc-act-by' | 'doc-chase' | null {
  const fired = state[`doc:${row.doc.id}`]?.fired ?? []
  if (fired.includes('doc-chase')) return null
  if (row.daysToAct <= -CHASE_AFTER_DAYS) return 'doc-chase'
  if (row.daysToAct <= 0 && !fired.includes('doc-act-by')) return 'doc-act-by'
  return null
}

/** Nudges due now; stages are banked on the passed state. A doc first seen late gets one message, both stages spent. */
export function dueDocNudges(docs: Doc[], state: EscalationState, today: string, now = Date.now()) {
  const out: { row: RadarRow; stage: 'doc-act-by' | 'doc-chase' }[] = []
  for (const row of radar(docs, today)) {
    const stage = planDocNudge(row, state)
    if (!stage) continue
    if (stage === 'doc-chase') recordStage(state, `doc:${row.doc.id}`, 'doc-act-by', now)
    recordStage(state, `doc:${row.doc.id}`, stage, now)
    out.push({ row, stage })
  }
  return out
}

export function formatDocNudges(batch: { row: RadarRow; stage: string }[], chat = ''): string {
  return [
    'Identity documents have reached their renewal lead time. Each gets at most two nudges, ever; this is one.',
    '',
    ...batch.map(({ row, stage }) => `- ${formatRadar([row])}${stage === 'doc-chase' ? ' (second and last nudge, still not renewed)' : ''}`),
    '',
    chat ? `Send the user one short message covering all of it to chat_id ${chat}. priority "normal".` : '',
    'Say what expires, by when to book the renewal, and what that renewal usually needs. Offer a [done] button that records renewedAt via record_document.',
    'Do not offer to remind them again; this budget is spent by the channel.',
  ].filter(Boolean).join('\n')
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
export const DOCUMENTS_FILE = join(STATE_DIR, 'documents.json')
export const DOC_NUDGES_FILE = join(STATE_DIR, 'document-nudges.json')

export function loadDocuments(file = DOCUMENTS_FILE): Doc[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as Doc[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
    }
    return []
  }
}

export function saveDocuments(file: string, docs: Doc[]): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(docs, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
