/**
 * One read-only answer to "is every moving part actually up?"
 *
 * `watchdog_report` answers a narrower question — which probes are failing —
 * and only from inside the server. This reads the evidence each part leaves
 * behind (the heartbeat, email-state.json, runtime.json) and pokes each
 * listener on loopback, so it also works when the session is down, which is
 * exactly when someone asks. `bun otto/status.ts` prints it from a terminal;
 * the `otto_status` tool and `/otto:status` print the same rows.
 *
 * Every row carries the timestamp of the evidence, not of the check, so "email
 * scan: up, last ran 09:02Z" cannot be mistaken for "I checked at 09:02Z".
 * Times are UTC, always marked, because the reader may be in any zone.
 *
 * Nothing here writes, repairs or restarts. Probing is a connect or a GET on
 * 127.0.0.1 and, for gog, the same one-thread read the watchdog already runs.
 * Secrets are never read: the webhook token is only tested for being non-empty.
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { readHeartbeat, STALE_MS } from './heartbeat.ts'
import { omittedSections, OMITTED_REBUILDS, type BriefRebuild, type ProbeName, type ProbeResult } from './watchdog.ts'
import { readEnvKey } from './deadman.ts'

export type Verdict = 'up' | 'degraded' | 'down' | 'off' | 'unknown'

export type StatusRow = {
  id: string
  label: string
  verdict: Verdict
  /** Epoch ms of the evidence, when there is one. */
  at?: number
  detail: string
}

export type StatusDeps = {
  stateDir: string
  now: number
  /** GET a loopback URL. Any HTTP response at all means something is listening. */
  http: (url: string) => Promise<{ status: number } | { error: string }>
  /** Run a command; true on exit 0. */
  run: (argv: string[]) => Promise<boolean>
  pidAlive: (pid: number) => boolean
  account?: string
}

const FRESH_MS = 2 * 60_000

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return null }
}

export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 120) return `${m} min`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`
}

/** Length of the "HH:MM-HH:MM" window, so a night's silence is not read as a stall. */
export function quietSpanMs(spec: string | undefined): number {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec((spec ?? '').trim())
  if (!m) return 0
  const start = Number(m[1]) * 60 + Number(m[2])
  const end = Number(m[3]) * 60 + Number(m[4])
  return (end > start ? end - start : end + 1440 - start) * 60_000
}

type Access = {
  emailScanMinutes?: number
  quietHours?: string
  webhook?: { port?: number; token?: string; host?: string }
  voice?: { enabled?: boolean }
}

type EmailState = { lastScan?: string; lastError?: { at: string; message: string } }

export async function collectStatus(d: StatusDeps): Promise<StatusRow[]> {
  const { now, stateDir } = d
  const rows: StatusRow[] = []
  const access = readJson<Access>(join(stateDir, 'access.json')) ?? {}
  const hb = readHeartbeat(join(stateDir, 'heartbeat.json'))

  // --- MCP server ---------------------------------------------------------
  if (!hb) {
    rows.push({ id: 'mcp-server', label: 'MCP server', verdict: 'unknown', detail: 'no heartbeat has been written — never started as a channel host, or not since this feature shipped' })
  } else {
    const silent = now - hb.at
    const alive = d.pidAlive(hb.pid)
    rows.push({
      id: 'mcp-server', label: 'MCP server', at: hb.at,
      verdict: silent <= FRESH_MS ? 'up' : silent <= STALE_MS ? 'degraded' : 'down',
      detail: silent <= FRESH_MS
        ? `beating, last beat ${ago(silent)} ago`
        : `last beat ${ago(silent)} ago; process ${alive ? 'still running but not responding' : 'is gone'}`,
    })
  }

  // --- Trigger engine + poller (both come from the heartbeat) -------------
  if (hb?.schedulerAt) {
    const silent = now - hb.schedulerAt
    rows.push({
      id: 'trigger-engine', label: 'Trigger engine', at: hb.schedulerAt,
      verdict: silent <= FRESH_MS ? 'up' : silent <= STALE_MS ? 'degraded' : 'down',
      detail: `last tick ${ago(silent)} ago`,
    })
  } else {
    rows.push({ id: 'trigger-engine', label: 'Trigger engine', verdict: 'unknown', detail: 'no tick recorded yet' })
  }
  if (hb?.pollAt) {
    const lag = now - hb.pollAt
    rows.push({
      id: 'telegram-poller', label: 'Telegram poller', at: hb.pollAt,
      verdict: lag < 5 * 60_000 ? 'up' : 'down',
      detail: `last poll ${ago(lag)} ago`,
    })
  }

  // --- Email scan ---------------------------------------------------------
  const cadence = access.emailScanMinutes ?? 60
  const email = readJson<EmailState>(join(stateDir, 'email-state.json')) ?? {}
  const lastScan = Date.parse(email.lastScan ?? '')
  const lastErr = email.lastError ? Date.parse(email.lastError.at) : NaN
  if (cadence <= 0) {
    rows.push({ id: 'email-scan', label: 'Email scan', verdict: 'off', detail: 'disabled (emailScanMinutes is 0)' })
  } else if (Number.isNaN(lastScan)) {
    rows.push({ id: 'email-scan', label: 'Email scan', verdict: 'unknown', detail: 'has not run yet' })
  } else {
    const budget = cadence * 3 * 60_000 + quietSpanMs(access.quietHours)
    const age = now - lastScan
    const errNewer = !Number.isNaN(lastErr) && lastErr >= lastScan
    rows.push({
      id: 'email-scan', label: 'Email scan', at: lastScan,
      verdict: age > budget ? 'down' : errNewer ? 'degraded' : 'up',
      detail:
        `last ran ${ago(age)} ago` +
        (age > budget ? ` (expected every ${cadence} min)` : '') +
        (email.lastError ? `; last error ${iso(lastErr)}: ${email.lastError.message}` : '; no error recorded'),
    })
  }

  // --- Webhook listener ---------------------------------------------------
  if (!access.webhook?.token) {
    rows.push({ id: 'webhook', label: 'Webhook listener', verdict: 'off', detail: 'not configured (no token in access.json)' })
  } else {
    const port = access.webhook.port ?? 4589
    const host = access.webhook.host ?? '127.0.0.1'
    const r = await d.http(`http://${host}:${port}/`)
    rows.push({
      id: 'webhook', label: 'Webhook listener', at: now,
      verdict: 'status' in r ? 'up' : 'down',
      detail: 'status' in r ? `answering on port ${port}` : `nothing answering on port ${port} (${r.error})`,
    })
  }

  // --- Voice daemon -------------------------------------------------------
  if (access.voice?.enabled === false) {
    rows.push({ id: 'voice-daemon', label: 'Voice daemon', verdict: 'off', detail: 'disabled in access.json' })
  } else {
    const info = readJson<{ port?: number }>(join(stateDir, 'voice-daemon.json'))
    if (!info?.port) {
      // Started on demand, so no record is the normal idle state, not a fault.
      rows.push({ id: 'voice-daemon', label: 'Voice daemon', verdict: 'off', detail: 'not running (starts on the first spoken reply)' })
    } else {
      const r = await d.http(`http://127.0.0.1:${info.port}/`)
      rows.push({
        id: 'voice-daemon', label: 'Voice daemon', at: now,
        verdict: 'status' in r ? 'up' : 'down',
        detail: 'status' in r ? `answering on port ${info.port}` : `recorded on port ${info.port} but not answering (${r.error}) — stale record`,
      })
    }
  }

  // --- gog auth -----------------------------------------------------------
  if (!d.account) {
    rows.push({ id: 'gog-auth', label: 'gog auth', verdict: 'off', detail: 'no Google account configured' })
  } else {
    const ok = await d.run(['gog', 'gmail', 'search', 'in:inbox', '-a', d.account, '--max', '1', '--json'])
    rows.push({
      id: 'gog-auth', label: 'gog auth', at: now, verdict: ok ? 'up' : 'down',
      detail: ok ? 'a one-message inbox read succeeded' : 'the read failed — credentials expired or gog is missing (`gog auth login` needs a browser)',
    })
  }

  // --- claude.ai connectors ----------------------------------------------
  // The server cannot call a connector, and a live call would spend a model
  // turn. What it can see is whether the brief still gets calendar and inbox
  // sections, which is what a dead connector looks like from here.
  const rebuilds = (readJson<{ briefRebuilds?: BriefRebuild[] }>(join(stateDir, 'runtime.json'))?.briefRebuilds) ?? []
  if (!rebuilds.length) {
    rows.push({ id: 'connectors', label: 'claude.ai connectors', verdict: 'unknown', detail: 'no brief has been built yet; connectors cannot be probed directly' })
  } else {
    const last = rebuilds[rebuilds.length - 1]
    const gone = omittedSections(rebuilds, OMITTED_REBUILDS).filter(s => s === 'Today' || s === 'Inbox 24h')
    rows.push({
      id: 'connectors', label: 'claude.ai connectors', at: last.at,
      verdict: gone.length ? 'degraded' : 'up',
      detail: gone.length
        ? `${gone.join(' and ')} missing from the last ${OMITTED_REBUILDS} briefs (inferred from the brief, not probed; gog covers reads)`
        : 'calendar and inbox sections are still rendering (inferred from the brief, not probed)',
    })
  }

  return rows
}

const MARK: Record<Verdict, string> = { up: 'UP      ', degraded: 'DEGRADED', down: 'DOWN    ', off: 'off     ', unknown: 'unknown ' }

export function formatStatus(rows: StatusRow[], now: number, recentRepairs: string[] = []): string {
  const count = (v: Verdict) => rows.filter(r => r.verdict === v).length
  const head = count('down') || count('degraded')
    ? `${count('down')} down, ${count('degraded')} degraded, ${count('up')} up`
    : count('up') ? `all ${count('up')} active parts up` : 'nothing has reported yet'
  const lines = [`Otto status as of ${iso(now)} — ${head}`, '']
  for (const r of rows) {
    lines.push(`${MARK[r.verdict]} ${r.label}${r.at ? ` [${iso(r.at)}]` : ''} — ${r.detail}`)
  }
  if (recentRepairs.length) lines.push('', 'Recent automatic repairs:', ...recentRepairs.map(r => `  ${r}`))
  return lines.join('\n')
}

/** Rows the watchdog also cares about, in the shape it already understands. */
export function rowToProbe(row: StatusRow, name: ProbeName): ProbeResult {
  return {
    name,
    ok: row.verdict !== 'down' && row.verdict !== 'degraded',
    ...(row.verdict === 'down' || row.verdict === 'degraded' ? { detail: row.detail.slice(0, 160) } : {}),
  }
}

// ---------------------------------------------------------------------------
// Real dependencies, shared by the tool and the CLI
// ---------------------------------------------------------------------------

export function defaultStatusDeps(over: Partial<StatusDeps> = {}): StatusDeps {
  const stateDir = over.stateDir ?? process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
  return {
    stateDir,
    now: Date.now(),
    http: async url => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
        return { status: res.status }
      } catch (err) {
        return { error: String((err as Error).message ?? err).slice(0, 60) }
      }
    },
    run: async argv => {
      try {
        const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' })
        const timer = setTimeout(() => { try { proc.kill() } catch {} }, 20_000)
        const code = await proc.exited
        clearTimeout(timer)
        return code === 0
      } catch { return false }
    },
    pidAlive: pid => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } },
    account: process.env.OTTO_GOOGLE_ACCOUNT ?? readEnvKey(join(stateDir, '.env'), 'OTTO_GOOGLE_ACCOUNT'),
    ...over,
  }
}

/** Capability-log lines the watchdog wrote, newest first, for the report's tail. */
export function recentRepairLines(stateDir: string, limit = 3): string[] {
  const log = readJson<{ at: string; what: string; by: string; revertedAt?: string }[]>(join(stateDir, 'capability-log.json')) ?? []
  return log
    .filter(e => e.by === 'watchdog')
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map(e => `${e.at.slice(0, 19)}Z ${e.what}`)
}

if (import.meta.main) {
  const deps = defaultStatusDeps()
  const rows = await collectStatus(deps)
  console.log(formatStatus(rows, deps.now, recentRepairLines(deps.stateDir)))
  process.exit(rows.some(r => r.verdict === 'down') ? 1 : 0)
}
