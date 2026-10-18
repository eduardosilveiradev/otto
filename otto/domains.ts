/**
 * The domain and TLS expiry sentinel.
 *
 * A lapsed certificate or a lapsed registration is the kind of failure that
 * gives months of warning and is noticed anyway on the morning it breaks, by
 * someone else. Once a day this reads the two dates that matter for each domain
 * in `domains` in access.json — the certificate's notAfter, straight off a TLS
 * handshake, and the registry's expiration event over RDAP — and says something
 * only when a line is crossed.
 *
 * Three lines, each crossed once per domain per expiry date: 30 days (normal
 * priority, so it waits out quiet hours and snoozes), 7 days and expired (both
 * urgent). The alerted set is keyed by the expiry date itself, so a renewal is a
 * new date with nothing alerted against it — no reset step to forget — and a
 * CDN that serves two certificates from different edges cannot make the same
 * warning fire twice by flapping between them.
 *
 * A lookup that fails is recorded and retried tomorrow. It is never messaged:
 * "could not reach rdap.org" is an otto_status line, not something worth waking
 * anyone for, and a stale date from yesterday is not evidence of a crossing.
 *
 * The TLS connect and the fetch are injected so the tests run offline.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { connect } from 'node:tls'

export type DomainKind = 'tls' | 'registration'
export type Stage = '30d' | '7d' | 'expired'

export type Lookup = {
  /** ISO time the thing expires — last known good, kept through a failed lookup. */
  expiresAt?: string
  /** When expiresAt was last read successfully. */
  okAt?: string
  /** When the last attempt ran, whether or not it worked. */
  checkedAt: string
  /** Set when the last attempt failed; cleared by the next success. */
  error?: string
}

export type DomainEntry = {
  tls?: Lookup
  registration?: Lookup
  /** "<kind>:<YYYY-MM-DD expiry>:<stage>" for every warning already sent. */
  alerted: string[]
}

export type DomainsState = {
  lastRunAt?: string
  domains: Record<string, DomainEntry>
}

export type DomainAlert = {
  domain: string
  kind: DomainKind
  stage: Stage
  expiresAt: string
  /** Whole days left, floored; negative once expired. */
  days: number
  priority: 'normal' | 'urgent'
}

export type DomainDeps = {
  /** The certificate's notAfter as an ISO time, for `host` on port 443. */
  tls: (host: string) => Promise<string>
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>
  now: number
}

const DAY_MS = 24 * 60 * 60_000
const FETCH_TIMEOUT_MS = 15_000
const TLS_TIMEOUT_MS = 10_000
/** Keys for an expiry date this far in the past are history; drop them. */
const ALERT_KEEP_MS = 60 * DAY_MS

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function loadDomains(file: string): DomainsState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.domains && typeof parsed.domains === 'object') {
      return parsed as DomainsState
    }
    return { domains: {} }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: domains.json corrupt, moved aside.\n')
    }
    return { domains: {} }
  }
}

/** Read without side effects, for otto_status: a corrupt file is left where it is. */
export function peekDomains(file: string): DomainsState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.domains && typeof parsed.domains === 'object'
      ? parsed as DomainsState
      : { domains: {} }
  } catch { return { domains: {} } }
}

export function saveDomains(file: string, state: DomainsState): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/**
 * "https://Example.com/path", "example.com." and "EXAMPLE.COM" are one domain.
 * Anything that is not a plain hostname afterwards is undefined — an IP or a
 * typo has no registration to look up.
 */
export function normalizeDomain(raw: string): string | undefined {
  const s = String(raw ?? '').trim()
  if (!s) return undefined
  let host: string
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname } catch { return undefined }
  host = host.replace(/\.$/, '').toLowerCase()
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(host)) return undefined
  if (/^[\d.]+$/.test(host)) return undefined
  return host
}

/** Which line `expiresAt` has crossed at `now`, if any. */
export function stageFor(expiresAt: number, now: number): Stage | undefined {
  const left = expiresAt - now
  if (left <= 0) return 'expired'
  if (left <= 7 * DAY_MS) return '7d'
  if (left <= 30 * DAY_MS) return '30d'
  return undefined
}

function alertKey(kind: DomainKind, expiresAt: string, stage: Stage): string {
  return `${kind}:${expiresAt.slice(0, 10)}:${stage}`
}

/**
 * The warning due for one lookup, or nothing. Only the deepest crossed line
 * counts: a domain first seen five days out gets the 7-day warning, never a
 * stale 30-day one followed a minute later by the real one.
 */
export function dueAlert(domain: string, kind: DomainKind, entry: DomainEntry, now: number): DomainAlert | undefined {
  const lookup = entry[kind]
  if (!lookup?.expiresAt || lookup.error) return undefined
  const at = Date.parse(lookup.expiresAt)
  if (Number.isNaN(at)) return undefined
  const stage = stageFor(at, now)
  if (!stage) return undefined
  if (entry.alerted.includes(alertKey(kind, lookup.expiresAt, stage))) return undefined
  return {
    domain, kind, stage,
    expiresAt: lookup.expiresAt,
    days: Math.floor((at - now) / DAY_MS),
    priority: stage === '30d' ? 'normal' : 'urgent',
  }
}

/** Drop alert keys for expiry dates long gone that are no longer current. */
export function pruneAlerted(entry: DomainEntry, now: number): void {
  const current = new Set(
    (['tls', 'registration'] as const)
      .map(k => entry[k]?.expiresAt?.slice(0, 10))
      .filter(Boolean) as string[],
  )
  entry.alerted = entry.alerted.filter(key => {
    const day = key.split(':')[1] ?? ''
    if (current.has(day)) return true
    const t = Date.parse(`${day}T00:00:00Z`)
    return !Number.isNaN(t) && now - t < ALERT_KEEP_MS
  })
}

/** Pull the registry's expiration out of an RDAP domain object. */
export function rdapExpiration(body: unknown): string | undefined {
  const events = (body as { events?: unknown })?.events
  if (!Array.isArray(events)) return undefined
  for (const e of events) {
    const ev = e as { eventAction?: unknown; eventDate?: unknown }
    if (ev?.eventAction === 'expiration' && typeof ev.eventDate === 'string') {
      const t = Date.parse(ev.eventDate)
      if (!Number.isNaN(t)) return new Date(t).toISOString()
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Registration expiry over RDAP. rdap.org redirects to the registry that holds
 * the name. A subdomain has no registration of its own, so a 404 walks one
 * label up ("www.example.com" → "example.com") until two labels are left.
 */
export async function lookupRegistration(domain: string, fetchFn: DomainDeps['fetch']): Promise<string> {
  let name = domain
  for (;;) {
    const res = await fetchFn(`https://rdap.org/domain/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (res.status === 404 && name.split('.').length > 2) {
      name = name.slice(name.indexOf('.') + 1)
      continue
    }
    if (!res.ok) throw new Error(`rdap ${name}: HTTP ${res.status}`)
    const expiry = rdapExpiration(await res.json())
    if (!expiry) throw new Error(`rdap ${name}: the registry publishes no expiration date`)
    return expiry
  }
}

/**
 * notAfter of the certificate `host` serves, with SNI. Verification is off on
 * purpose: an expired or mis-issued certificate is exactly the one whose date
 * this has to be able to read. Nothing is sent over the connection.
 */
export function readCertExpiry(host: string, timeoutMs = TLS_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: false })
    const done = (err: Error | null, value?: string) => {
      clearTimeout(timer)
      socket.destroy()
      if (err) reject(err)
      else resolve(value!)
    }
    const timer = setTimeout(() => done(new Error(`tls ${host}: timed out`)), timeoutMs)
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      const t = Date.parse(cert?.valid_to ?? '')
      if (Number.isNaN(t)) done(new Error(`tls ${host}: no certificate presented`))
      else done(null, new Date(t).toISOString())
    })
    socket.once('error', err => done(new Error(`tls ${host}: ${err.message}`)))
  })
}

async function attempt(prev: Lookup | undefined, checkedAt: string, read: () => Promise<string>): Promise<Lookup> {
  try {
    const expiresAt = await read()
    return { expiresAt, okAt: checkedAt, checkedAt }
  } catch (err) {
    return {
      ...(prev?.expiresAt ? { expiresAt: prev.expiresAt } : {}),
      ...(prev?.okAt ? { okAt: prev.okAt } : {}),
      checkedAt,
      error: String((err as Error)?.message ?? err).slice(0, 160),
    }
  }
}

// ---------------------------------------------------------------------------
// The daily pass
// ---------------------------------------------------------------------------

/**
 * Look every domain up, record what came back, and return the warnings that
 * are now due. The returned alerts are already marked in `state`; the caller
 * saves before sending, so a crash in between loses a message rather than
 * sending it twice.
 */
export async function checkDomains(
  configured: string[],
  state: DomainsState,
  deps: DomainDeps,
): Promise<{ alerts: DomainAlert[]; invalid: string[] }> {
  const checkedAt = new Date(deps.now).toISOString()
  const invalid: string[] = []
  const domains = [...new Set(configured.flatMap(raw => {
    const d = normalizeDomain(raw)
    if (!d) invalid.push(String(raw))
    return d ? [d] : []
  }))]

  // A domain taken out of access.json takes its history with it.
  for (const d of Object.keys(state.domains)) if (!domains.includes(d)) delete state.domains[d]

  await Promise.all(domains.map(async d => {
    const prev = state.domains[d] ?? { alerted: [] }
    const [tls, registration] = await Promise.all([
      attempt(prev.tls, checkedAt, () => deps.tls(d)),
      attempt(prev.registration, checkedAt, () => lookupRegistration(d, deps.fetch)),
    ])
    state.domains[d] = { tls, registration, alerted: Array.isArray(prev.alerted) ? prev.alerted : [] }
  }))

  const alerts: DomainAlert[] = []
  for (const d of domains) {
    const entry = state.domains[d]
    for (const kind of ['tls', 'registration'] as const) {
      const a = dueAlert(d, kind, entry, deps.now)
      if (!a) continue
      entry.alerted.push(alertKey(kind, a.expiresAt, a.stage))
      alerts.push(a)
    }
    pruneAlerted(entry, deps.now)
  }
  state.lastRunAt = checkedAt
  return { alerts, invalid }
}

const WHAT: Record<DomainKind, string> = { tls: 'TLS certificate', registration: 'domain registration' }

export function formatAlert(a: DomainAlert): string {
  const day = `${a.expiresAt.slice(0, 10)} UTC`
  if (a.stage === 'expired') {
    return `${a.domain}: ${WHAT[a.kind]} expired ${day}.` + (a.kind === 'registration' ? ' Renew it at the registrar before the grace period runs out.' : '')
  }
  const when = a.days <= 0 ? 'today' : a.days === 1 ? 'in 1 day' : `in ${a.days} days`
  return `${a.domain}: ${WHAT[a.kind]} expires ${when} (${day}).` + (a.kind === 'registration' ? ' Renew at the registrar.' : '')
}

/** One message per priority, so a batch of 30-day notices never jumps a hold. */
export function groupAlerts(alerts: DomainAlert[]): { urgent: boolean; text: string }[] {
  const out: { urgent: boolean; text: string }[] = []
  const urgent = alerts.filter(a => a.priority === 'urgent')
  const normal = alerts.filter(a => a.priority === 'normal')
  if (urgent.length) out.push({ urgent: true, text: urgent.map(formatAlert).join('\n') })
  if (normal.length) out.push({ urgent: false, text: normal.map(formatAlert).join('\n') })
  return out
}

// ---------------------------------------------------------------------------
// otto_status
// ---------------------------------------------------------------------------

export type DomainStatus = {
  verdict: 'up' | 'degraded' | 'off' | 'unknown'
  at?: number
  detail: string
}

/**
 * The otto_status row. Failures live here and only here. The soonest expiry is
 * shown so "is the cert fine?" has an answer without a lookup.
 */
export function domainStatus(configured: string[] | undefined, state: DomainsState, now: number): DomainStatus {
  const domains = [...new Set((configured ?? []).map(normalizeDomain).filter(Boolean) as string[])]
  if (!domains.length) return { verdict: 'off', detail: 'no domains configured (domains in access.json)' }
  const lastRun = Date.parse(state.lastRunAt ?? '')
  if (Number.isNaN(lastRun)) return { verdict: 'unknown', detail: `${domains.length} domain(s) configured, not checked yet` }

  const failures: string[] = []
  let soonest: { label: string; at: number } | undefined
  for (const d of domains) {
    const entry = state.domains[d]
    if (!entry) { failures.push(`${d}: not checked yet`); continue }
    for (const kind of ['tls', 'registration'] as const) {
      const l = entry[kind]
      if (l?.error) failures.push(`${d} ${kind}: ${l.error}`)
      const at = Date.parse(l?.expiresAt ?? '')
      if (!Number.isNaN(at) && (!soonest || at < soonest.at)) soonest = { label: `${d} ${kind}`, at }
    }
  }
  const stale = now - lastRun > 2 * DAY_MS
  const parts = [
    `${domains.length} domain(s)`,
    soonest ? `soonest: ${soonest.label} ${new Date(soonest.at).toISOString().slice(0, 10)} UTC (${Math.floor((soonest.at - now) / DAY_MS)} d)` : '',
    stale ? `last check over 2 days ago` : '',
    failures.length ? `lookup failed, retried tomorrow — ${failures.join('; ')}` : 'all lookups succeeded',
  ].filter(Boolean)
  return { verdict: failures.length || stale ? 'degraded' : 'up', at: lastRun, detail: parts.join('; ') }
}
