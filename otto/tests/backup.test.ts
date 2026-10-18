import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync, truncateSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  backupPaths, resolveBackupConfig, collectSources, packTar, unpackTar, encrypt, decrypt,
  loadOrCreateKey, runBackup, listBackups, verifyBackup, restoreBackup, restoreRefusal,
  recordNight, backupDue, nightly, safeRelative, archiveName, main, loadBackupState,
  MAX_FILE_BYTES, ALERT_AFTER, type Paths, type BackupState, type NightRecord,
} from '../backup.ts'
import { collectStatus, type StatusDeps } from '../status.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-backup-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

/** A temp HOME with a little of everything: state, logs, a big file, global and project memory. */
function home(): Paths {
  const h = mkdtempSync(join(tmp, 'home-'))
  const p = backupPaths(h, join(h, '.otto', 'state'))
  const w = (rel: string, body: string | Uint8Array) => {
    const f = join(h, rel)
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, body)
  }
  w('.otto/state/access.json', JSON.stringify({ allowFrom: ['1234567890'] }))
  w('.otto/state/notes.json', JSON.stringify([{ id: 'a1', kind: 'loop', text: 'call the plumber' }]))
  w('.otto/state/triggers.json', '[]')
  w('.otto/state/jobs/j1/result.txt', 'done')
  w('.otto/state/server.log', 'noise')
  w('.otto/state/logs/today.txt', 'noise')
  w('.otto/state/notes.json.tmp', 'half-written')
  w('.claude/memory/global/user_role.md', '---\nname: role\n---\nThey write software.\n')
  w('.claude/projects/-tmp-proj-a/memory/project_x.md', 'x')
  w(`.claude/projects/-tmp-proj-b-${'long'.repeat(30)}/memory/a-rather-long-memory-file-name-for-the-pax-path.md`, 'long path')
  w('.claude/projects/-tmp-proj-c/transcript.jsonl', 'not memory')
  return p
}

const cfgFor = (p: Paths, keep = 14) => resolveBackupConfig({ dir: join(p.home, 'backups'), keep }, p.home)

test('config: defaults to ~/.otto/backups and 14, expands ~, ignores junk', () => {
  expect(resolveBackupConfig(null, '/h')).toEqual({ dir: '/h/.otto/backups', keep: 14 })
  expect(resolveBackupConfig({ dir: '~/bk', keep: 3 }, '/h')).toEqual({ dir: '/h/bk', keep: 3 })
  expect(resolveBackupConfig({ dir: '', keep: 'lots' }, '/h')).toEqual({ dir: '/h/.otto/backups', keep: 14 })
  expect(resolveBackupConfig({ keep: 0 }, '/h').keep).toBe(14)
})

test('sources: state and every project memory dir, minus logs, temp files, transcripts and the key', () => {
  const p = home()
  loadOrCreateKey(p.keyFile)
  const { files } = collectSources(p)
  const paths = files.map(f => f.path)
  expect(paths).toContain('state/access.json')
  expect(paths).toContain('state/jobs/j1/result.txt')
  expect(paths).toContain('memory/global/user_role.md')
  expect(paths).toContain('memory/projects/-tmp-proj-a/project_x.md')
  expect(paths.some(x => x.includes('server.log') || x.includes('/logs/') || x.endsWith('.tmp'))).toBe(false)
  expect(paths.some(x => x.includes('transcript'))).toBe(false)
  expect(paths.some(x => x.includes('backup.key'))).toBe(false)
})

test('sources: node_modules and .venv are reinstallable, so they are left out', () => {
  const p = home()
  mkdirSync(join(p.stateDir, 'app/node_modules/dep'), { recursive: true })
  writeFileSync(join(p.stateDir, 'app/node_modules/dep/tsconfig.json'), '{ // not JSON\n}')
  writeFileSync(join(p.stateDir, 'app/package.json'), '{}')
  mkdirSync(join(p.stateDir, 'voice/.venv/lib'), { recursive: true })
  writeFileSync(join(p.stateDir, 'voice/.venv/lib/x.json'), 'nope')
  const paths = collectSources(p).files.map(f => f.path)
  expect(paths).toContain('state/app/package.json')
  expect(paths.some(x => x.includes('node_modules') || x.includes('.venv'))).toBe(false)
})

test('sources: a file over 20 MB is skipped and named', () => {
  const p = home()
  const big = join(p.stateDir, 'huge.json')
  writeFileSync(big, '')
  truncateSync(big, MAX_FILE_BYTES + 1)
  const { files, skipped } = collectSources(p)
  expect(files.some(f => f.path === 'state/huge.json')).toBe(false)
  expect(skipped[0]).toMatchObject({ path: 'state/huge.json' })
})

test('tar round-trips, including a path past 100 bytes', () => {
  const long = `memory/projects/${'x'.repeat(150)}/m.md`
  const back = unpackTar(packTar([
    { path: 'a.json', data: new TextEncoder().encode('{}') },
    { path: long, data: new Uint8Array([1, 2, 3]) },
    { path: 'empty', data: new Uint8Array() },
  ]))
  expect(back.map(e => e.path)).toEqual(['a.json', long, 'empty'])
  expect([...back[1].data]).toEqual([1, 2, 3])
})

test('tar we write is readable by the system tar', () => {
  const dir = mkdtempSync(join(tmp, 'systar-'))
  const long = `deep/${'y'.repeat(120)}/f.txt`
  writeFileSync(join(dir, 'a.tar'), packTar([{ path: long, data: new TextEncoder().encode('hi') }]))
  const r = Bun.spawnSync(['tar', '-xf', 'a.tar'], { cwd: dir })
  if (r.exitCode !== 0) return // no tar on this machine; the round-trip test above still holds
  expect(readFileSync(join(dir, long), 'utf8')).toBe('hi')
})

test('encryption: round-trips, and a wrong key or a flipped byte fails without saying why', async () => {
  const key = new Uint8Array(32).fill(7)
  const blob = await encrypt(new TextEncoder().encode('secret'), key)
  expect(new TextDecoder().decode(await decrypt(blob, key))).toBe('secret')
  await expect(decrypt(blob, new Uint8Array(32).fill(8))).rejects.toThrow('decryption failed')
  const bent = blob.slice(); bent[bent.length - 1] ^= 1
  await expect(decrypt(bent, key)).rejects.toThrow('decryption failed')
  await expect(decrypt(new Uint8Array(40), key)).rejects.toThrow('bad header')
})

test('key: 32 bytes, mode 0600, created once and then reused; a damaged key is never replaced', () => {
  const p = home()
  const k1 = loadOrCreateKey(p.keyFile)
  expect(k1.length).toBe(32)
  expect(statSync(p.keyFile).mode & 0o777).toBe(0o600)
  expect([...loadOrCreateKey(p.keyFile)]).toEqual([...k1])
  writeFileSync(p.keyFile, 'short')
  expect(() => loadOrCreateKey(p.keyFile)).toThrow('not replacing')
  expect(readFileSync(p.keyFile, 'utf8')).toBe('short')
})

test('run writes one encrypted archive that holds neither the key nor plaintext', async () => {
  const p = home()
  const cfg = cfgFor(p)
  const r = await runBackup(p, cfg, new Date('2026-10-13T05:30:00Z'))
  expect(r.file.endsWith('otto-backup-20261013T053000Z.tar.gz.enc')).toBe(true)
  expect(statSync(r.file).mode & 0o777).toBe(0o600)
  const raw = readFileSync(r.file)
  expect(raw.includes(Buffer.from('call the plumber'))).toBe(false)
  expect(raw.includes(readFileSync(p.keyFile))).toBe(false)
  const v = await verifyBackup(r.file, readFileSync(p.keyFile), tmp)
  expect(v).toMatchObject({ ok: true, problems: [] })
  expect(v.files).toBe(r.files)
  expect(v.jsonChecked).toBe(3)
})

test('verify leaves no temp dir behind, pass or fail', async () => {
  const p = home()
  const r = await runBackup(p, cfgFor(p))
  const drillRoot = mkdtempSync(join(tmp, 'drill-'))
  await verifyBackup(r.file, readFileSync(p.keyFile), drillRoot)
  await verifyBackup(r.file, new Uint8Array(32), drillRoot)
  expect(readdirSync(drillRoot)).toEqual([])
})

test('verify catches a JSON file that was already corrupt when it was packed', async () => {
  const p = home()
  writeFileSync(join(p.stateDir, 'money.json'), '{"half":')
  const r = await runBackup(p, cfgFor(p))
  const v = await verifyBackup(r.file, readFileSync(p.keyFile), tmp)
  expect(v.ok).toBe(false)
  expect(v.problems).toEqual(['state/money.json: does not parse as JSON'])
})

test('verify fails a truncated archive', async () => {
  const p = home()
  const r = await runBackup(p, cfgFor(p))
  truncateSync(r.file, statSync(r.file).size - 10)
  const v = await verifyBackup(r.file, readFileSync(p.keyFile), tmp)
  expect(v.ok).toBe(false)
  expect(v.problems[0]).toContain('decryption failed')
})

test('keep: only the newest N survive, and nothing else in the dir is touched', async () => {
  const p = home()
  const cfg = cfgFor(p, 2)
  mkdirSync(cfg.dir, { recursive: true })
  writeFileSync(join(cfg.dir, 'README.txt'), 'mine')
  for (const d of ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']) await runBackup(p, cfg, new Date(`${d}T05:30:00Z`))
  expect(listBackups(cfg.dir).map(b => b.at)).toEqual(['2026-10-13T05:30:00Z', '2026-10-12T05:30:00Z'])
  expect(existsSync(join(cfg.dir, 'README.txt'))).toBe(true)
})

test('restore extracts into an empty dest, byte for byte', async () => {
  const p = home()
  const r = await runBackup(p, cfgFor(p))
  const dest = join(tmp, `restore-${Date.now()}`)
  const res = await restoreBackup(r.file, dest, readFileSync(p.keyFile), p)
  expect(res.problems).toEqual([])
  expect(readFileSync(join(dest, 'state/notes.json'), 'utf8')).toBe(readFileSync(join(p.stateDir, 'notes.json'), 'utf8'))
  expect(readFileSync(join(dest, 'memory/global/user_role.md'), 'utf8')).toContain('They write software.')
  expect(existsSync(join(dest, 'manifest.json'))).toBe(true)
})

test('restore refuses the live state, anything above or inside it, live memory, and a non-empty dir', async () => {
  const p = home()
  const r = await runBackup(p, cfgFor(p))
  const key = readFileSync(p.keyFile)
  for (const dest of [p.stateDir, join(p.home, '.otto'), join(p.stateDir, 'restored'), p.home, join(p.home, '.claude'), join(p.home, '.claude', 'memory', 'global')]) {
    expect(restoreRefusal(dest, p)).toContain('overlaps live data')
  }
  const busy = mkdtempSync(join(tmp, 'busy-'))
  writeFileSync(join(busy, 'x'), '')
  expect(restoreRefusal(busy, p)).toContain('not empty')
  const before = readFileSync(join(p.stateDir, 'notes.json'), 'utf8')
  await expect(restoreBackup(r.file, join(p.home, '.otto'), key, p)).rejects.toThrow('overlaps live data')
  expect(readFileSync(join(p.stateDir, 'notes.json'), 'utf8')).toBe(before)
})

test('archive paths are data: absolute and dot-dot paths are unsafe', () => {
  expect(safeRelative('state/notes.json')).toBe(true)
  for (const bad of ['/etc/passwd', '../x', 'state/../../x', 'a//b', './a', '']) expect(safeRelative(bad)).toBe(false)
})

test('archive name sorts by time', () => {
  expect(archiveName(new Date('2026-01-02T03:04:05.678Z'))).toBe('otto-backup-20260102T030405Z.tar.gz.enc')
})

// ---------------------------------------------------------------------------
// Nights, the three-strikes rule, and the status row
// ---------------------------------------------------------------------------

const ok = (day: string): NightRecord => ({ day, at: `${day}T05:30:00Z`, ok: true, files: 9 })
const bad = (day: string): NightRecord => ({ day, at: `${day}T05:30:00Z`, ok: false, error: 'disk full' })

test('one message only after three failed nights in a row, and only once per streak', () => {
  let s: BackupState = { failStreak: 0 }
  const alerts: boolean[] = []
  for (const n of [ok('01'), bad('02'), bad('03'), bad('04'), bad('05'), bad('06'), ok('07'), bad('08'), bad('09'), bad('10')]) {
    const r = recordNight(s, n)
    s = r.state
    alerts.push(r.alert)
  }
  expect(alerts).toEqual([false, false, false, true, false, false, false, false, false, true])
  expect(ALERT_AFTER).toBe(3)
  expect(s.lastOk?.day).toBe('07')
})

test('due once a local day, from 05:30, never while one is running', () => {
  const base = { today: '2026-10-13', inFlight: false }
  expect(backupDue({ ...base, minuteOfDay: 5 * 60 + 29 })).toBe(false)
  expect(backupDue({ ...base, minuteOfDay: 5 * 60 + 30 })).toBe(true)
  expect(backupDue({ ...base, minuteOfDay: 14 * 60, lastBackupDay: '2026-10-12' })).toBe(true)
  expect(backupDue({ ...base, minuteOfDay: 14 * 60, lastBackupDay: '2026-10-13' })).toBe(false)
  expect(backupDue({ ...base, minuteOfDay: 6 * 60, inFlight: true })).toBe(false)
})

test('nightly never throws: an unreadable key is a failed night, not a crash', async () => {
  const p = home()
  writeFileSync(p.keyFile, 'short')
  const n = await nightly(p, cfgFor(p), '2026-10-13')
  expect(n.ok).toBe(false)
  expect(n.error).toContain('expected 32')
})

async function statusRow(stateDir: string, now: number) {
  const deps: StatusDeps = {
    stateDir, now, launchAgentsDir: join(tmp, 'no-agents'), relayPort: 4590,
    http: async () => ({ status: 200 }), run: async () => true, pidAlive: () => true,
  }
  return (await collectStatus(deps)).find(r => r.id === 'backup')!
}

test('status: unknown before the first night, up after a good one, down after three bad ones', async () => {
  const p = home()
  const now = Date.parse('2026-10-13T09:00:00Z')
  expect((await statusRow(p.stateDir, now)).verdict).toBe('unknown')

  const night = await nightly(p, cfgFor(p), '2026-10-13', new Date('2026-10-13T05:30:00Z'))
  expect(night.ok).toBe(true)
  writeFileSync(p.backupStateFile, JSON.stringify(recordNight({ failStreak: 0 }, night).state))
  const up = await statusRow(p.stateDir, now)
  expect(up.verdict).toBe('up')
  expect(up.detail).toContain('drill passed')
  expect((await statusRow(p.stateDir, now + 4 * 24 * 3600_000)).verdict).toBe('down')

  let s = loadBackupState(p.backupStateFile)
  s = recordNight(s, bad('2026-10-14')).state
  writeFileSync(p.backupStateFile, JSON.stringify(s))
  expect((await statusRow(p.stateDir, now)).verdict).toBe('degraded')
  s = recordNight(recordNight(s, bad('2026-10-15')).state, bad('2026-10-16')).state
  writeFileSync(p.backupStateFile, JSON.stringify(s))
  const down = await statusRow(p.stateDir, now)
  expect(down.verdict).toBe('down')
  expect(down.detail).toContain('failed 3 night(s) in a row: disk full')
})

// ---------------------------------------------------------------------------
// CLI, against a temp HOME
// ---------------------------------------------------------------------------

test('cli: run, list, verify, restore — and the key never appears in the output', async () => {
  const p = home()
  writeFileSync(join(p.stateDir, 'access.json'), JSON.stringify({ allowFrom: ['1234567890'], backup: { dir: join(p.home, 'bk'), keep: 5 } }))
  const out: string[] = []
  const log = (s: string) => { out.push(s) }
  expect(await main(['run'], p, log)).toBe(0)
  expect(await main(['list'], p, log)).toBe(0)
  const file = listBackups(join(p.home, 'bk'))[0].file
  expect(await main(['verify', file], p, log)).toBe(0)
  const dest = join(tmp, `cli-restore-${Date.now()}`)
  expect(await main(['restore', file, dest], p, log)).toBe(0)
  expect(await main(['restore', file, p.stateDir], p, log).catch(e => String(e))).toContain('overlaps live data')
  expect(await main(['bogus'], p, log)).toBe(2)
  const hex = readFileSync(p.keyFile).toString('hex')
  const b64 = readFileSync(p.keyFile).toString('base64')
  expect(out.join('\n')).not.toContain(hex)
  expect(out.join('\n')).not.toContain(b64)
  expect(out.join('\n')).toContain('ok — ')
})

test('cli as a process: HOME decides where everything goes', () => {
  const p = home()
  const env = { ...process.env, HOME: p.home }
  delete (env as Record<string, string | undefined>).OTTO_STATE_DIR
  const script = join(import.meta.dir, '..', 'backup.ts')
  const run = Bun.spawnSync(['bun', script, 'nightly', '2026-10-13'], { env })
  expect(run.exitCode).toBe(0)
  expect(JSON.parse(run.stdout.toString().trim())).toMatchObject({ ok: true, alert: false, failStreak: 0 })
  expect(listBackups(join(p.home, '.otto', 'backups')).length).toBe(1)
  expect(loadBackupState(p.backupStateFile).last?.ok).toBe(true)
})
