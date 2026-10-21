/**
 * The disk-space sentinel.
 *
 * A full disk does not announce itself: the nightly backup fails, mail stops
 * syncing, state files stop saving, and the first symptom is a session that
 * cannot write. Once an hour this reads free space on the boot volume (and the
 * backup volume, when the backups live on a different one) and says something
 * only when a line is crossed.
 *
 * Three lines per volume, from `disk` in access.json: warn (normal priority, so
 * it waits out quiet hours and snoozes), critical (urgent) and a recovery line
 * above warn. A line is crossed with hysteresis: after a warning the volume has
 * to climb back past warn × 1.25 before it can warn again, so a disk sitting at
 * the line, or a Trash that is emptied and refilled, cannot repeat itself. Going
 * from ok straight to critical sends the one critical message, not two.
 *
 * `du` runs only when a message is about to go out, to name what could be
 * cleared. Nothing is ever deleted here: the message lists, the user decides.
 *
 * statfs, du and the clock are parameters, so the tests run without a disk.
 */

import { statfsSync } from 'fs'
import { join } from 'path'
import { listBackups } from './backup.ts'
import { loadState, saveState } from './statefile.ts'

export type DiskConfig = { warnGb: number; warnPercent: number; criticalGb: number; criticalPercent: number }

export const DEFAULT_DISK_CONFIG: DiskConfig = { warnGb: 15, warnPercent: 10, criticalGb: 5, criticalPercent: 3 }

/** Config comes from a hand-edited JSON file: anything unusable falls back to the default. */
export function resolveDiskConfig(raw?: Partial<Record<keyof DiskConfig, unknown>> | null): DiskConfig {
  const pick = (k: keyof DiskConfig): number => {
    const v = Number(raw?.[k])
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_DISK_CONFIG[k]
  }
  return { warnGb: pick('warnGb'), warnPercent: pick('warnPercent'), criticalGb: pick('criticalGb'), criticalPercent: pick('criticalPercent') }
}

/** Recovery line = warn line × this; fixed, not a knob. */
const RECOVER_FACTOR = 1.25

export type Role = 'boot' | 'backup' | 'boot+backup'
export type Level = 'ok' | 'warn' | 'critical'
export type Volume = { path: string; totalBytes: number; freeBytes: number; role: Role }
export type VolumeState = { role: Role; totalBytes: number; freeBytes: number; checkedAt: string; level: Level; alertedAt?: string }
export type DiskState = { lastCheckedAt?: string; volumes: Record<string, VolumeState> }
export type DiskAlert = { path: string; role: Role; level: 'warn' | 'critical'; freeBytes: number; totalBytes: number; priority: 'normal' | 'urgent' }

type StatFs = (p: string) => { bsize: number; blocks: number; bavail: number }

/** The boot volume, plus the backup directory's when it is on another one (an unmounted disk is skipped, quietly). */
export function readVolumes(paths: { boot: string; backupDir: string }, statfs: StatFs = statfsSync as unknown as StatFs): Volume[] {
  const boot = statfs(paths.boot)
  const mk = (path: string, s: ReturnType<StatFs>, role: Role): Volume => ({ path, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize, role })
  let backup: ReturnType<StatFs> | undefined
  try { backup = statfs(paths.backupDir) } catch {}
  if (!backup) return [mk(paths.boot, boot, 'boot')]
  // Same container: same size and the same free space give or take what a few writes between the two calls move.
  if (backup.blocks === boot.blocks && Math.abs(backup.bavail - boot.bavail) * 1000 < boot.blocks) return [mk(paths.boot, boot, 'boot+backup')]
  return [mk(paths.boot, boot, 'boot'), mk(paths.backupDir, backup, 'backup')]
}

export function lines(total: number, cfg: DiskConfig): { warn: number; critical: number; recover: number } {
  const warn = Math.max(total * cfg.warnPercent / 100, cfg.warnGb * 1e9)
  return { warn, critical: Math.max(total * cfg.criticalPercent / 100, cfg.criticalGb * 1e9), recover: warn * RECOVER_FACTOR }
}

/** Mutates `state` (the caller saves it) and returns the alerts to send, at most one per volume. */
export function assessDisk(volumes: Volume[], state: DiskState, cfg: DiskConfig, now: number): DiskAlert[] {
  const at = new Date(now).toISOString()
  const alerts: DiskAlert[] = []
  const next: Record<string, VolumeState> = {}
  for (const v of volumes) {
    const prev = state.volumes[v.path]
    const { warn, critical, recover } = lines(v.totalBytes, cfg)
    let level: Level = prev?.level ?? 'ok'
    let alerted: DiskAlert['level'] | undefined
    if (v.freeBytes < critical) { if (level !== 'critical') alerted = 'critical'; level = 'critical' }
    else if (level === 'ok') { if (v.freeBytes < warn) { alerted = 'warn'; level = 'warn' } }
    else if (v.freeBytes >= recover) level = 'ok'
    next[v.path] = { role: v.role, totalBytes: v.totalBytes, freeBytes: v.freeBytes, checkedAt: at, level, ...(prev?.alertedAt ? { alertedAt: prev.alertedAt } : {}) }
    if (alerted) {
      next[v.path]!.alertedAt = at
      alerts.push({ path: v.path, role: v.role, level: alerted, freeBytes: v.freeBytes, totalBytes: v.totalBytes, priority: alerted === 'critical' ? 'urgent' : 'normal' })
    }
  }
  // A volume that is gone (an unplugged backup disk) drops out: coming back still full is a fresh event.
  state.volumes = next
  state.lastCheckedAt = at
  return alerts
}

// ---------------------------------------------------------------------------
// What could be cleared
// ---------------------------------------------------------------------------

export type Reclaimable = { label: string; bytes: number }

export function reclaimCandidates(home: string): { label: string; path: string }[] {
  return [
    { label: 'Xcode DerivedData', path: join(home, 'Library', 'Developer', 'Xcode', 'DerivedData') },
    { label: '~/Library/Caches', path: join(home, 'Library', 'Caches') },
    { label: 'Trash', path: join(home, '.Trash') },
    // Linux: whichever set is absent just measures as nothing.
    { label: '~/.cache', path: join(home, '.cache') },
    { label: 'Trash', path: join(home, '.local', 'share', 'Trash') },
  ]
}

/** The biggest few things worth clearing, 1 GB or more each. Only measures; never touches. */
export async function reclaimables(home: string, backupDir: string, du: (path: string) => Promise<number | null>): Promise<Reclaimable[]> {
  const sized = await Promise.all(reclaimCandidates(home).map(async c => ({ label: c.label, bytes: await du(c.path) })))
  // The newest three archives are the restore points; the rest are what `keep` would have pruned.
  const old = listBackups(backupDir).slice(3).reduce((n, b) => n + b.bytes, 0)
  return [...sized.filter((r): r is Reclaimable => r.bytes != null), { label: 'old Otto backups (bun otto/backup.ts list)', bytes: old }]
    .filter(r => r.bytes >= 1e9)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
}

/** `du -sk`, bytes; null when it fails or runs past the timeout (a huge Caches folder). */
export async function duBytes(path: string, timeoutMs = 30_000): Promise<number | null> {
  try {
    const p = Bun.spawn(['du', '-sk', path], { stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => p.kill(), timeoutMs)
    const out = await new Response(p.stdout).text()
    await p.exited
    clearTimeout(timer)
    // Not the exit code: du exits 1 on any unreadable subfolder (on macOS TCC guards
    // parts of Caches and the Trash) yet still prints the total of the rest, a fair lower bound.
    // A killed du prints nothing, so the timeout still comes back null.
    const kb = Number(/^(\d+)/.exec(out)?.[1])
    return Number.isFinite(kb) ? kb * 1024 : null
  } catch { return null }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const gb = (n: number) => (n / 1e9).toFixed(n < 20e9 ? 1 : 0)
const pct = (free: number, total: number) => Math.round(free / total * 100)

/** Final text, no model in the loop. */
export function formatDiskAlert(a: DiskAlert, reclaim: Reclaimable[]): string {
  const where = a.role === 'boot' ? 'boot volume' : a.role === 'backup' ? `backup volume (${a.path})` : 'boot volume (backups live there too)'
  const clear = reclaim.length ? `could clear: ${reclaim.map(r => `${r.label} ${gb(r.bytes)} GB`).join(', ')}. ` : ''
  return (a.level === 'critical'
    ? `disk critical: ${gb(a.freeBytes)} GB free on the ${where} — the system gets flaky under this. ${clear}`
    : `disk: ${gb(a.freeBytes)} GB free of ${gb(a.totalBytes)} GB (${pct(a.freeBytes, a.totalBytes)}%) on the ${where}. ${clear}i'll only say so again if it gets critical.`
  ).trim()
}

// ---------------------------------------------------------------------------
// otto_status
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000

export function diskStatus(state: DiskState, now: number): { verdict: 'up' | 'degraded' | 'down' | 'unknown'; at?: number; detail: string } {
  const at = Date.parse(state.lastCheckedAt ?? '')
  if (Number.isNaN(at)) return { verdict: 'unknown', detail: 'not sampled yet (hourly)' }
  const vols = Object.entries(state.volumes)
  const stale = now - at > 3 * HOUR_MS
  const verdict = vols.some(([, v]) => v.level === 'critical') ? 'down' : vols.some(([, v]) => v.level === 'warn') || stale ? 'degraded' : 'up'
  const detail = vols.map(([path, v]) => {
    const label = v.role === 'boot' ? 'boot' : v.role === 'backup' ? `backup ${path}` : 'boot (backups on it)'
    return `${label} ${gb(v.freeBytes)} GB free of ${gb(v.totalBytes)} GB (${pct(v.freeBytes, v.totalBytes)}%)${v.alertedAt ? `, warned ${v.alertedAt.slice(0, 10)}` : ''}`
  })
  if (stale) detail.push(`last sample ${Math.floor((now - at) / HOUR_MS)} h ago`)
  return { verdict, at, detail: detail.join('; ') }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const empty = (): DiskState => ({ volumes: {} })
const valid = (v: unknown) => !!v && typeof v === 'object' && !!(v as DiskState).volumes && typeof (v as DiskState).volumes === 'object'

export const loadDiskState = (file: string): DiskState => loadState(file, empty, valid)
export const peekDiskState = (file: string): DiskState => loadState(file, empty, valid, { peek: true })
export const saveDiskState = (file: string, s: DiskState): void => saveState(file, s)
