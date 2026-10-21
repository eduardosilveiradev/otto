import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, mkdirSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resolveDiskConfig, DEFAULT_DISK_CONFIG, lines, assessDisk, readVolumes, reclaimables, duBytes, formatDiskAlert, diskStatus,
  loadDiskState, saveDiskState, peekDiskState, type Volume, type DiskState, type DiskAlert,
} from '../disk.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-disk-'))
const locked = join(tmp, 'du', 'locked')
afterAll(() => { try { chmodSync(locked, 0o755); rmSync(tmp, { recursive: true }) } catch {} })

const T0 = Date.parse('2026-10-13T10:00:00Z')
const HOUR = 3_600_000
const cfg = DEFAULT_DISK_CONFIG
const vol = (freeBytes: number, totalBytes = 1e12, role: Volume['role'] = 'boot'): Volume => ({ path: '/', totalBytes, freeBytes, role })

test('config: unusable values fall back to the default', () => {
  expect(resolveDiskConfig()).toEqual(cfg)
  expect(resolveDiskConfig({ warnGb: '40', criticalPercent: 0, warnPercent: 'x' })).toEqual({ warnGb: 40, warnPercent: 10, criticalGb: 5, criticalPercent: 3 })
})

test('lines: the larger of the percentage and the gigabytes', () => {
  expect(lines(1e12, cfg)).toMatchObject({ warn: 1e11, critical: 3e10, recover: 1.25e11 })
  expect(lines(1e11, cfg).warn).toBe(1.5e10)
})

test('hysteresis: one warning, one critical, silence until well recovered', () => {
  const state: DiskState = { volumes: {} }
  const step = (free: number, i: number) => assessDisk([vol(free)], state, cfg, T0 + i * HOUR)
  expect(step(2e11, 0)).toEqual([]); expect(state.volumes['/']!.level).toBe('ok')
  const warn = step(9e10, 1)
  expect(warn).toMatchObject([{ level: 'warn', priority: 'normal', path: '/' }])
  expect(state.volumes['/']!.alertedAt).toBe(new Date(T0 + HOUR).toISOString())
  expect(step(8e10, 2)).toEqual([])
  expect(step(2e10, 3)).toMatchObject([{ level: 'critical', priority: 'urgent' }])
  expect(step(5e10, 4)).toEqual([]); expect(state.volumes['/']!.level).toBe('critical')
  expect(step(1.1e11, 5)).toEqual([]); expect(state.volumes['/']!.level).toBe('critical')
  expect(step(1.3e11, 6)).toEqual([]); expect(state.volumes['/']!.level).toBe('ok')
  expect(step(9e10, 7)).toMatchObject([{ level: 'warn', priority: 'normal' }])
})

test('ok straight to critical sends the critical message only', () => {
  const alerts = assessDisk([vol(2e10)], { volumes: {} }, cfg, T0)
  expect(alerts).toHaveLength(1)
  expect(alerts[0]).toMatchObject({ level: 'critical', priority: 'urgent' })
})

test('a volume that disappears drops out of the state', () => {
  const state: DiskState = { volumes: {} }
  assessDisk([vol(9e10), { ...vol(9e10), path: '/Volumes/Backup', role: 'backup' }], state, cfg, T0)
  assessDisk([vol(9e10)], state, cfg, T0 + HOUR)
  expect(Object.keys(state.volumes)).toEqual(['/'])
})

test('readVolumes: one container is one volume, two are two, an absent backup disk is skipped', () => {
  const s = (blocks: number, bavail: number) => ({ bsize: 4096, blocks, bavail })
  const boot = s(1_000_000, 400_000)
  expect(readVolumes({ boot: '/', backupDir: '/b' }, () => boot)).toEqual([{ path: '/', totalBytes: 4096e6, freeBytes: 4096 * 400_000, role: 'boot+backup' }])
  expect(readVolumes({ boot: '/', backupDir: '/b' }, p => p === '/' ? boot : s(2_000_000, 100_000)).map(v => v.role)).toEqual(['boot', 'backup'])
  expect(readVolumes({ boot: '/', backupDir: '/b' }, p => { if (p === '/') return boot; throw new Error('ENOENT') }).map(v => v.role)).toEqual(['boot'])
})

test('reclaimables: the big ones, largest first, three at most; old backups count past the newest three', async () => {
  const dir = mkdtempSync(join(tmp, 'bk-'))
  for (let d = 1; d <= 5; d++) writeFileSync(join(dir, `otto-backup-2026100${d}T050000Z.tar.gz.enc`), '')
  const du = async (p: string) => p.endsWith('DerivedData') ? 7e9 : p.endsWith('Caches') ? 1.7e10 : null
  expect(await reclaimables('/home', dir, du)).toEqual([{ label: '~/Library/Caches', bytes: 1.7e10 }, { label: 'Xcode DerivedData', bytes: 7e9 }])
})

test('duBytes: an unreadable subfolder still yields the rest; a missing path is null', async () => {
  mkdirSync(locked, { recursive: true })
  writeFileSync(join(tmp, 'du', 'f'), Buffer.alloc(64 * 1024))
  chmodSync(locked, 0)
  expect(await duBytes(join(tmp, 'du'))).toBeGreaterThanOrEqual(64 * 1024)
  expect(await duBytes(join(tmp, 'nope'))).toBeNull()
})

test('the messages: lowercase, with the numbers and what could be cleared', () => {
  const a: DiskAlert = { path: '/', role: 'boot', level: 'warn', freeBytes: 9e10, totalBytes: 1e12, priority: 'normal' }
  const w = formatDiskAlert(a, [{ label: 'Trash', bytes: 3e9 }])
  expect(w).toContain('90 GB free of 1000 GB (9%) on the boot volume')
  expect(w).toContain('could clear: Trash 3.0 GB.')
  expect(formatDiskAlert(a, [])).not.toContain('could clear')
  expect(formatDiskAlert({ ...a, role: 'backup', path: '/Volumes/B' }, [])).toContain('backup volume (/Volumes/B)')
  const c = formatDiskAlert({ ...a, level: 'critical', freeBytes: 4e9, priority: 'urgent', role: 'boot+backup' }, [])
  expect(c).toStartWith('disk critical: 4.0 GB free on the boot volume (backups live there too)')
  expect(c.endsWith(' ')).toBe(false)
})

test('otto_status: unknown until sampled, then the worst level, and stale is degraded', () => {
  const at = (ms: number) => new Date(ms).toISOString()
  const mk = (level: 'ok' | 'warn' | 'critical', checked: number, free = 4e9): DiskState => ({
    lastCheckedAt: at(checked),
    volumes: { '/': { role: 'boot', totalBytes: 1e12, freeBytes: free, checkedAt: at(checked), level } },
  })
  expect(diskStatus({ volumes: {} }, T0)).toMatchObject({ verdict: 'unknown', detail: 'not sampled yet (hourly)' })
  expect(diskStatus(mk('ok', T0 - 600_000), T0).verdict).toBe('up')
  expect(diskStatus(mk('warn', T0 - 600_000), T0).verdict).toBe('degraded')
  expect(diskStatus(mk('critical', T0 - 600_000), T0)).toMatchObject({ verdict: 'down', at: T0 - 600_000 })
  const old = diskStatus(mk('ok', T0 - 4 * HOUR), T0)
  expect(old.verdict).toBe('degraded')
  expect(old.detail).toContain('last sample 4 h ago')
})

test('the state file round-trips; a corrupt one is moved aside by load and left by peek', () => {
  const f = join(tmp, 'disk.json')
  expect(loadDiskState(f)).toEqual({ volumes: {} })
  expect(existsSync(f)).toBe(false)
  const s: DiskState = { lastCheckedAt: new Date(T0).toISOString(), volumes: {} }
  saveDiskState(f, s)
  expect(loadDiskState(f)).toEqual(s)
  writeFileSync(f, '{nope')
  expect(peekDiskState(f)).toEqual({ volumes: {} })
  expect(existsSync(f)).toBe(true)
  expect(loadDiskState(f)).toEqual({ volumes: {} })
  expect(readdirSync(tmp).some(n => n.startsWith('disk.json.corrupt-'))).toBe(true)
})
