/**
 * Plan usage over time, for charts: every few minutes, one row per provider window (T3's bars, plus
 * Claude's status-line reading when T3 has none) appended to state/usage-history.jsonl.
 */
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { liveWindows, type PlanUsage } from './spend.ts'

export type UsageRow = { at: string; provider: string; window: string; usedPercent: number; resetsAt?: string }

/** Rows for one reading. `providers` is T3's server.getConfig providers; `plan` the status line's last post. */
export function usageRows(providers: any[], plan: PlanUsage | null, now = Date.now()): UsageRow[] {
  const at = new Date(now).toISOString()
  const rows: UsageRow[] = providers.flatMap(p => (p?.usageLimits?.windows ?? []).map((w: any) => ({
    at, provider: String(p.instanceId ?? p.id ?? p.driver), window: String(w.id ?? w.kind),
    usedPercent: Number(w.usedPercent), ...(w.resetsAt ? { resetsAt: String(w.resetsAt) } : {}),
  }))).filter(r => Number.isFinite(r.usedPercent))
  if (!rows.some(r => r.provider === 'claudeAgent')) {
    for (const k of liveWindows(plan, now)) rows.push({ at, provider: 'claudeAgent', window: k, usedPercent: plan![k]!.used_percentage, resetsAt: new Date(plan![k]!.resets_at * 1000).toISOString() })
  }
  return rows
}

export function appendUsage(file: string, rows: UsageRow[]): void {
  if (rows.length) appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
}

/** Rows at or after `since` (ISO). shortcut: reads the whole file; rotate it if it ever gets big (~150 KB a week). */
export function readUsage(file: string, since = ''): UsageRow[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').flatMap(l => { try { const r = JSON.parse(l) as UsageRow; return r.at >= since ? [r] : [] } catch { return [] } })
}
