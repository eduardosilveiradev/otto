/**
 * What the iOS app says about itself, for otto_status.
 *
 * The phone POSTs /app/health on every connect and after each background
 * refresh: notification permission, background app refresh, keep-awake, whether
 * the share sheet is configured, build and iOS version. The server keeps the
 * latest report per device token and turns it into one Phone row. Pure: no
 * value import from status.ts (it imports this module), `ago` is passed in.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadState, saveState } from './statefile.ts'
import type { StatusRow, Verdict } from './status.ts'

export type AppHealth = {
  at: string                 // ISO, server clock, stamped by parseAppHealth
  reason?: string            // 'connect' | 'refresh'
  notifications: string      // 'authorized' | 'denied' | 'notDetermined' | 'provisional' | 'ephemeral' | 'unknown'
  backgroundRefresh: string  // 'available' | 'denied' | 'restricted' | 'unknown'
  keepAwake: boolean
  shareConfigured: boolean
  lastRefresh?: string       // ISO, phone clock; absent until the first BG refresh ran
  build: string; version: string; ios: string
}
export type AppHealthState = Record<string, AppHealth>   // tokenId -> latest report

const STR = 40  // every string field clipped to this
const clip = (s: string) => s.slice(0, STR)

export function parseAppHealth(body: unknown, now: number): AppHealth | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const { notifications, backgroundRefresh, build, version, ios, keepAwake, shareConfigured, lastRefresh, reason } = b
  if (typeof notifications !== 'string' || typeof backgroundRefresh !== 'string' || typeof build !== 'string'
    || typeof version !== 'string' || typeof ios !== 'string') return null
  if (typeof keepAwake !== 'boolean' || typeof shareConfigured !== 'boolean') return null
  return {
    at: new Date(now).toISOString(),
    ...(typeof reason === 'string' ? { reason: clip(reason) } : {}),
    notifications: clip(notifications), backgroundRefresh: clip(backgroundRefresh),
    keepAwake, shareConfigured,
    ...(typeof lastRefresh === 'string' && !Number.isNaN(Date.parse(lastRefresh)) ? { lastRefresh: clip(lastRefresh) } : {}),
    build: clip(build), version: clip(version), ios: clip(ios),
  }
}

const valid = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x)

export const peekAppHealth = (file: string): AppHealthState => loadState<AppHealthState>(file, () => ({}), valid, { peek: true })

export function recordAppHealth(file: string, tokenId: string, h: AppHealth): void {
  saveState(file, { ...loadState<AppHealthState>(file, () => ({}), valid), [tokenId]: h })
}

/** Device names from app-tokens.json ({ tokens: [{ id, name, … }] }); {} on any failure. */
export function tokenNames(stateDir: string): Record<string, string> {
  try {
    const { tokens } = JSON.parse(readFileSync(join(stateDir, 'app-tokens.json'), 'utf8')) as { tokens: { id: string; name: string }[] }
    return Object.fromEntries(tokens.map(t => [t.id, t.name]))
  } catch { return {} }
}

const SILENT_MS = 36 * 3600_000, REFRESH_STALE_MS = 48 * 3600_000

export function appHealthVerdict(h: AppHealth, now: number, ago: (ms: number) => string): { verdict: Verdict; detail: string } {
  const at = Date.parse(h.at)
  const summary = `iOS ${h.ios}, build ${h.build} (${h.version}), notifications ${h.notifications}, background refresh ${h.backgroundRefresh}, keep-awake ${h.keepAwake ? 'on' : 'off'}, share sheet ${h.shareConfigured ? 'set up' : 'missing'}${h.lastRefresh ? `, last background refresh ${ago(now - Date.parse(h.lastRefresh))} ago` : ''}`
  // keep-awake off is a choice, never a verdict.
  let verdict: Verdict = 'degraded', first: string
  if (h.notifications === 'denied') { verdict = 'down'; first = 'notifications denied — replies cannot reach the lock screen; Settings > Otto > Notifications' }
  else if (now - at > SILENT_MS) first = `nothing from the phone for ${ago(now - at)}`
  else if (h.notifications === 'notDetermined') first = 'notifications never allowed — open the app and accept the prompt'
  else if (h.backgroundRefresh !== 'available') first = 'background app refresh off — replies arrive only while the app is open'
  else if (!h.shareConfigured) first = 'share sheet not set up — save the server in the app’s settings once'
  else if (h.lastRefresh && at - Date.parse(h.lastRefresh) > REFRESH_STALE_MS) first = `background refresh has not run for ${ago(at - Date.parse(h.lastRefresh))}`
  else return { verdict: 'up', detail: summary }
  return { verdict, detail: `${first}. ${summary}` }
}

/** One row per device whose token still exists: a revoked or re-paired phone's last report is history, not a phone that went silent. */
export function appHealthStatus(state: AppHealthState, names: Record<string, string>, now: number, ago: (ms: number) => string): StatusRow[] {
  return Object.entries(state).filter(([id]) => id in names).map(([id, h]) => ({
    id: `phone:${id}`, label: `Phone${names[id] ? ` (${names[id]})` : ''}`, at: Date.parse(h.at), ...appHealthVerdict(h, now, ago),
  }))
}
