import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectStatus, formatStatus, quietSpanMs, ago, rowToProbe, type StatusDeps } from '../status.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-status-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const NOW = Date.parse('2026-08-12T09:00:00Z')
const min = (n: number) => n * 60_000

function setup(files: Record<string, unknown>, over: Partial<StatusDeps> = {}) {
  const dir = mkdtempSync(join(tmp, 's-'))
  for (const [name, v] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(v))
  const deps: StatusDeps = {
    stateDir: dir, usageHome: dir, now: NOW,
    http: async () => ({ status: 405 }),
    run: async () => true,
    pidAlive: () => true,
    account: 'you@example.com',
    ...over,
  }
  return { deps, dir }
}

const row = (rows: Awaited<ReturnType<typeof collectStatus>>, id: string) => rows.find(r => r.id === id)!

test('a healthy install reads up, with timestamps on the evidence', async () => {
  const { deps } = setup({
    'heartbeat.json': { v: 1, pid: 1, at: NOW - 10_000, schedulerAt: NOW - 20_000, pollAt: NOW - 5_000 },
    'access.json': { emailScanMinutes: 60, webhook: { port: 4589, token: 'x' } },
    'email-state.json': { lastScan: new Date(NOW - min(20)).toISOString() },
    'voice-daemon.json': { port: 5000, token: 't' },
    'runtime.json': { briefRebuilds: [{ at: NOW - min(5), sections: ['Today', 'Inbox 24h'] }] },
  })
  const rows = await collectStatus(deps)
  for (const id of ['mcp-server', 'trigger-engine', 'telegram-poller', 'email-scan', 'webhook', 'voice-daemon', 'gog-auth', 'connectors']) {
    expect(row(rows, id).verdict).toBe('up')
  }
  expect(row(rows, 'mcp-server').at).toBe(NOW - 10_000)
  const text = formatStatus(rows, NOW)
  expect(text).toContain('as of 2026-08-12T09:00:00Z')
  expect(text).toContain('[2026-08-12T08:59:50Z]')
  expect(text).toMatch(/all \d+ active parts up/)
})

test('a stale heartbeat is down, and says whether the process is gone', async () => {
  const hb = { v: 1, pid: 1, at: NOW - min(30) }
  const gone = await collectStatus(setup({ 'heartbeat.json': hb }, { pidAlive: () => false }).deps)
  expect(row(gone, 'mcp-server')).toMatchObject({ verdict: 'down' })
  expect(row(gone, 'mcp-server').detail).toContain('gone')
  const wedged = await collectStatus(setup({ 'heartbeat.json': hb }, { pidAlive: () => true }).deps)
  expect(row(wedged, 'mcp-server').detail).toContain('not responding')
})

test('no heartbeat is unknown, not down', async () => {
  const rows = await collectStatus(setup({}).deps)
  expect(row(rows, 'mcp-server').verdict).toBe('unknown')
})

test('dependency advisories: unknown until the first run, up after a clean one', async () => {
  expect(row(await collectStatus(setup({}).deps), 'depwatch').verdict).toBe('unknown')
  const clean = { lastRunAt: new Date(NOW - min(60)).toISOString(), told: {}, open: [], deps: 10 }
  expect(row(await collectStatus(setup({ 'depwatch.json': clean }).deps), 'depwatch').verdict).toBe('up')
})

test('nightly reset: unknown until it runs, then the last clear or why it skipped; off when disabled', async () => {
  expect(row(await collectStatus(setup({}).deps), 'nightly-reset').verdict).toBe('unknown')
  const skipped = { nightlyReset: { at: new Date(NOW - min(300)).toISOString(), reset: false, reason: 'a turn is in progress' } }
  expect(row(await collectStatus(setup({ 'runtime.json': skipped }).deps), 'nightly-reset').detail).toBe('skipped 5 h ago: a turn is in progress')
  const cleared = { nightlyReset: { at: new Date(NOW - min(300)).toISOString(), reset: true, reason: 'cleared' } }
  expect(row(await collectStatus(setup({ 'runtime.json': cleared }).deps), 'nightly-reset').detail).toBe('last cleared 5 h ago')
  expect(row(await collectStatus(setup({ 'access.json': { nightlyReset: false } }).deps), 'nightly-reset').verdict).toBe('off')
})

test('email scan: last error newer than last run degrades; overdue is down; disabled is off', async () => {
  const errored = await collectStatus(setup({
    'access.json': { emailScanMinutes: 60 },
    'email-state.json': { lastScan: new Date(NOW - min(30)).toISOString(), lastError: { at: new Date(NOW - min(10)).toISOString(), message: 'gog pre-check exited 1' } },
  }).deps)
  expect(row(errored, 'email-scan').verdict).toBe('degraded')
  expect(row(errored, 'email-scan').detail).toContain('gog pre-check exited 1')

  const overdue = await collectStatus(setup({
    'access.json': { emailScanMinutes: 60 },
    'email-state.json': { lastScan: new Date(NOW - min(60 * 6)).toISOString() },
  }).deps)
  expect(row(overdue, 'email-scan').verdict).toBe('down')

  const off = await collectStatus(setup({ 'access.json': { emailScanMinutes: 0 } }).deps)
  expect(row(off, 'email-scan').verdict).toBe('off')
})

test('a night of quiet hours is not read as a stalled scan', async () => {
  const rows = await collectStatus(setup({
    'access.json': { emailScanMinutes: 60, quietHours: '23:30-08:00' },
    'email-state.json': { lastScan: new Date(NOW - min(60 * 9)).toISOString() },
  }).deps)
  expect(row(rows, 'email-scan').verdict).toBe('up')
  expect(quietSpanMs('23:30-08:00')).toBe(min(510))
})

test('listeners: refused connection is down, unconfigured is off, and no token is never read out', async () => {
  const refused = { http: async () => ({ error: 'ConnectionRefused' }) }
  const { deps } = setup({ 'access.json': { webhook: { port: 4589, token: 'secret-token-value' } } }, refused)
  const rows = await collectStatus(deps)
  expect(row(rows, 'webhook').verdict).toBe('down')
  expect(formatStatus(rows, NOW)).not.toContain('secret-token-value')

  const none = await collectStatus(setup({}).deps)
  expect(row(none, 'webhook').verdict).toBe('off')
})

test('voice: a recorded port nobody answers is a stale record; no record is just idle', async () => {
  const stale = await collectStatus(setup({ 'voice-daemon.json': { port: 5000 } }, { http: async () => ({ error: 'refused' }) }).deps)
  expect(row(stale, 'voice-daemon').verdict).toBe('down')
  const idle = await collectStatus(setup({}).deps)
  expect(row(idle, 'voice-daemon').verdict).toBe('off')
})

test('gog: failing read is down; no account is off', async () => {
  const bad = await collectStatus(setup({}, { run: async () => false }).deps)
  expect(row(bad, 'gog-auth').verdict).toBe('down')
  const none = await collectStatus(setup({}, { account: undefined }).deps)
  expect(row(none, 'gog-auth').verdict).toBe('off')
})

test('connectors: inferred from the brief, and honest that it is an inference', async () => {
  const r = (sections: string[], at: number) => ({ at, sections })
  const rebuilds = [
    r(['Today', 'Inbox 24h'], NOW - min(60)),
    ...[4, 3, 2, 1].map(i => r(['Inbox 24h'], NOW - min(i))),
  ]
  const rows = await collectStatus(setup({ 'runtime.json': { briefRebuilds: rebuilds } }).deps)
  expect(row(rows, 'connectors').verdict).toBe('degraded')
  expect(row(rows, 'connectors').detail).toContain('inferred')
})

test('summary line counts, and repairs are listed when there are any', async () => {
  const { deps } = setup({}, { run: async () => false })
  const rows = await collectStatus(deps)
  const text = formatStatus(rows, NOW, ['2026-08-12T08:00:00Z watchdog: webhook was failing'])
  expect(text).toMatch(/1 down/)
  expect(text).toContain('Recent automatic repairs:')
})

test('helpers', () => {
  expect(ago(30_000)).toBe('30s')
  expect(ago(min(10))).toBe('10 min')
  expect(rowToProbe({ id: 'webhook', label: 'w', verdict: 'down', detail: 'x' }, 'webhook')).toMatchObject({ ok: false })
  expect(rowToProbe({ id: 'webhook', label: 'w', verdict: 'off', detail: 'x' }, 'webhook')).toEqual({ name: 'webhook', ok: true })
})

test('disk space: unknown until sampled, down when a volume is critical', async () => {
  expect(row(await collectStatus(setup({}).deps), 'disk').verdict).toBe('unknown')
  const checkedAt = new Date(NOW - min(10)).toISOString()
  const { deps } = setup({
    'disk.json': { lastCheckedAt: checkedAt, volumes: { '/': { role: 'boot', totalBytes: 1e12, freeBytes: 4e9, checkedAt, level: 'critical' } } },
  })
  const r = row(await collectStatus(deps), 'disk')
  expect(r.verdict).toBe('down')
  expect(r.detail).toContain('4.0 GB free')
})

test('domain expiry: off without domains, failures shown here and nowhere else', async () => {
  expect(row(await collectStatus(setup({}).deps), 'domains').verdict).toBe('off')
  const { deps } = setup({
    'access.json': { domains: ['example.com'] },
    'domains.json': {
      lastRunAt: new Date(NOW - min(60)).toISOString(),
      domains: { 'example.com': {
        tls: { expiresAt: '2026-12-01T00:00:00.000Z', okAt: new Date(NOW - min(60)).toISOString(), checkedAt: new Date(NOW - min(60)).toISOString() },
        registration: { checkedAt: new Date(NOW - min(60)).toISOString(), error: 'rdap example.com: HTTP 503' },
        alerted: [],
      } },
    },
  })
  const r = row(await collectStatus(deps), 'domains')
  expect(r.verdict).toBe('degraded')
  expect(r.at).toBe(NOW - min(60))
  expect(r.detail).toContain('HTTP 503')
  expect(r.detail).toContain('2026-12-01 UTC')
})

const iso = (ms: number) => new Date(ms).toISOString()

test('inputs row is unknown with nothing learned', async () => {
  expect(row(await collectStatus(setup({}).deps), 'inputs').verdict).toBe('unknown')
})

test('an input quiet past its rhythm degrades the inputs row', async () => {
  const silences = Array.from({ length: 6 }, (_, i) => ({ ms: 8 * 3_600_000, at: NOW - (40 + i) * 3_600_000 }))
  const { deps } = setup({ 'inputs.json': { v: 1, inputs: { desk: { lastSeen: NOW - 30 * 3_600_000, silences } } } })
  const r = row(await collectStatus(deps), 'inputs')
  expect(r.verdict).toBe('degraded')
  expect(r.detail).toContain('desk watcher')
  expect(r.detail).toContain('QUIET')
})

test('the phone row appears only once a device has reported', async () => {
  expect((await collectStatus(setup({}).deps)).some(r => r.id.startsWith('phone:'))).toBe(false)
  const { deps } = setup({
    'app-health.json': { abc: { at: iso(NOW - min(5)), notifications: 'denied', backgroundRefresh: 'available', keepAwake: true, shareConfigured: true, build: '1', version: '0.1', ios: '26.0' } },
    'app-tokens.json': { tokens: [{ id: 'abc', name: 'phone', hash: '', created: '' }] },
  })
  const rows = await collectStatus(deps)
  expect(row(rows, 'phone:abc')).toMatchObject({ verdict: 'down', label: 'Phone (phone)' })
  expect(formatStatus(rows, NOW)).toMatch(/DOWN\s+Phone \(phone\)/)
})


test('PR merges reports last check, delivery and error, with quiet-hours allowance', async () => {
  expect(row(await collectStatus(setup({}).deps), 'prmerges').verdict).toBe('unknown')
  const state = {
    delivered: {}, cursor: new Date(NOW).toISOString(),
    lastCheck: new Date(NOW - min(2)).toISOString(), lastDelivered: new Date(NOW - min(10)).toISOString(),
  }
  const good = row(await collectStatus(setup({ 'prmerges.json': state }).deps), 'prmerges')
  expect(good.verdict).toBe('up')
  expect(good.detail).toContain(state.lastCheck)
  expect(good.detail).toContain(state.lastDelivered)
  const failed = row(await collectStatus(setup({ 'prmerges.json': {
    ...state, lastError: { at: state.lastCheck, message: 'gh offline' },
  } }).deps), 'prmerges')
  expect(failed.verdict).toBe('degraded')
  expect(failed.detail).toContain('gh offline')
  const old = { ...state, lastCheck: new Date(NOW - min(60)).toISOString() }
  expect(row(await collectStatus(setup({ 'prmerges.json': old }).deps), 'prmerges').verdict).toBe('down')
  expect(row(await collectStatus(setup({ 'prmerges.json': old, 'access.json': { quietHours: '23:00-08:00' } }).deps), 'prmerges').verdict).toBe('up')
})

test('voice fallback status includes the onset and recovery clears it', async () => {
  const checkedAt = new Date(NOW).toISOString()
  const bad = await collectStatus(setup({ 'voice-health.json': { checkedAt, since: checkedAt, problem: 'fell back to system voice' } }).deps)
  expect(row(bad, 'voice').verdict).toBe('down')
  expect(row(bad, 'voice').detail).toContain('fell back to system voice since ')
  expect(row(bad, 'voice').at).toBe(NOW)
  expect(formatStatus(bad, NOW)).toContain('Voice')
  const good = await collectStatus(setup({ 'voice-health.json': { checkedAt } }).deps)
  expect(row(good, 'voice').verdict).toBe('up')
})

test('plan row includes local month tokens even without a plan reading', async () => {
  const { deps, dir } = setup({})
  const logs = join(dir, '.claude', 'projects', 'fixture')
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, 'session.jsonl'), JSON.stringify({ timestamp: new Date(NOW).toISOString(), message: { id: 'fixture', usage: { input_tokens: 1234 } } }) + '\n')
  const r = row(await collectStatus(deps), 'plan-usage')
  expect(r.detail).toContain('1.2K tokens this month')
  expect(r.verdict).toBe('unknown')
})

test('GitHub calls shows the rolling hour and excludes expired and future evidence', async () => {
  const { deps } = setup({ 'github-calls.json': { calls: [NOW - min(61), NOW - min(60), NOW - min(59), NOW, NOW + 1] } })
  expect(row(await collectStatus(deps), 'github-calls')).toMatchObject({ label: 'GitHub calls', verdict: 'up', at: NOW, detail: '2 in the past hour (cap 300 / 10 min)' })
})
