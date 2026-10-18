/**
 * Encrypted backup, and a restore drill that proves it.
 *
 * Every loop, trigger, receipt and memory Otto holds lives in dotfiles nobody
 * versions: ~/.otto/state and the durable markdown under ~/.claude. A dead disk
 * or one bad `rm` and the assistant wakes up with amnesia, and a backup nobody
 * has ever restored is a hope rather than a backup. So this does two things:
 *
 *   run     packs the state and the memory markdown into one tar.gz with a
 *           manifest (sha256 per file), encrypts it with AES-256-GCM, and keeps
 *           the newest `backup.keep` of them in `backup.dir`.
 *   verify  is the drill: decrypt into a temp dir, check every hash in the
 *           manifest, check every .json still parses, then delete the temp dir.
 *
 * The server runs both nightly at 05:30 (`nightly`, after the 05:00 hygiene
 * pass) and records the outcome in backup-state.json, which `otto_status`
 * reads. One failed night is a status row; three in a row is one message.
 *
 * The key is 32 random bytes in ~/.otto/state/backup.key, created 0600 on the
 * first run. It is never logged, never printed and never packed — an archive
 * that carries its own key is not encrypted. It is also the one thing worth
 * copying somewhere else by hand: lose it and every archive is noise.
 *
 * `restore` only ever extracts into the directory it is given, and refuses one
 * that overlaps the live state or memory. Putting files back is a person's
 * decision, made after looking at what came out.
 *
 * Everything takes `home` (and the state dir) as arguments, so tests run against
 * a temp HOME. Crypto is WebCrypto, gzip is Bun's, tar is the ~80 lines below:
 * no new dependencies on the supply chain this is meant to protect.
 *
 *   bun otto/backup.ts run | list | verify <file> | restore <file> <dest>
 */

import {
  readFileSync, writeFileSync, renameSync, readdirSync, statSync, lstatSync, mkdirSync,
  mkdtempSync, rmSync, unlinkSync, existsSync, realpathSync,
} from 'fs'
import { createHash, randomBytes } from 'crypto'
import { homedir, tmpdir } from 'os'
import { join, dirname, resolve, sep, isAbsolute } from 'path'

export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const KEY_FILE_NAME = 'backup.key'
export const STATE_FILE_NAME = 'backup-state.json'
/** Nights in a row that must fail before the user hears about it. */
export const ALERT_AFTER = 3
/** 05:30 local, half an hour after the hygiene pass. */
export const BACKUP_MINUTE_OF_DAY = 5 * 60 + 30

const MAGIC = new TextEncoder().encode('OTTOBAK1')
const IV_BYTES = 12
const ARCHIVE_RE = /^otto-backup-\d{8}T\d{6}Z\.tar\.gz\.enc$/

export type Paths = {
  home: string
  stateDir: string
  /** ~/.claude/memory/global */
  memoryGlobal: string
  /** ~/.claude/projects — each <slug>/memory under it is packed. */
  projectsDir: string
  keyFile: string
  backupStateFile: string
}

export function backupPaths(home = homedir(), stateDir?: string): Paths {
  const state = stateDir ?? process.env.OTTO_STATE_DIR ?? join(home, '.otto', 'state')
  return {
    home,
    stateDir: state,
    memoryGlobal: join(home, '.claude', 'memory', 'global'),
    projectsDir: join(home, '.claude', 'projects'),
    keyFile: join(state, KEY_FILE_NAME),
    backupStateFile: join(state, STATE_FILE_NAME),
  }
}

export type BackupConfig = { dir: string; keep: number }

/** `backup` from access.json; anything unusable falls back to the default. */
export function resolveBackupConfig(raw: { dir?: unknown; keep?: unknown } | null | undefined, home = homedir()): BackupConfig {
  const keep = Number(raw?.keep)
  let dir = typeof raw?.dir === 'string' && raw.dir.trim() ? raw.dir.trim() : join(home, '.otto', 'backups')
  if (dir === '~' || dir.startsWith('~/')) dir = join(home, dir.slice(1))
  return { dir: resolve(dir), keep: Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : 14 }
}

export function readBackupConfig(p: Paths): BackupConfig {
  try {
    const access = JSON.parse(readFileSync(join(p.stateDir, 'access.json'), 'utf8')) as { backup?: { dir?: unknown; keep?: unknown } }
    return resolveBackupConfig(access.backup, p.home)
  } catch {
    return resolveBackupConfig(null, p.home)
  }
}

// ---------------------------------------------------------------------------
// What goes in
// ---------------------------------------------------------------------------

export type Source = { abs: string; path: string }
export type Skipped = { path: string; why: string }

function isLogName(name: string): boolean {
  return name === 'logs' || name.endsWith('.log')
}

/** Regular files under `root`, as archive paths under `prefix`. Symlinks are not followed. */
function walk(root: string, prefix: string, out: Source[], skipped: Skipped[], skip: (abs: string, name: string) => boolean): void {
  let names: string[]
  try { names = readdirSync(root).sort() } catch { return }
  for (const name of names) {
    const abs = join(root, name)
    const path = `${prefix}/${name}`
    if (skip(abs, name)) continue
    let st
    try { st = lstatSync(abs) } catch { continue }
    if (st.isDirectory()) walk(abs, path, out, skipped, skip)
    else if (st.isFile()) {
      if (st.size > MAX_FILE_BYTES) skipped.push({ path, why: `${Math.round(st.size / 1024 / 1024)} MB, over the 20 MB cap` })
      else out.push({ abs, path })
    }
  }
}

/**
 * Everything a backup would pack, in archive paths:
 *   state/…                         ~/.otto/state, minus logs, the key, node_modules/.venv and big files
 *   memory/global/…                 ~/.claude/memory/global
 *   memory/projects/<slug>/…        every ~/.claude/projects/<slug>/memory
 */
export function collectSources(p: Paths, backupDir?: string): { files: Source[]; skipped: Skipped[] } {
  const files: Source[] = []
  const skipped: Skipped[] = []
  const keyAbs = resolve(p.keyFile)
  const outDir = backupDir ? resolve(backupDir) : ''
  walk(p.stateDir, 'state', files, skipped, (abs, name) =>
    resolve(abs) === keyAbs || isLogName(name) || name.endsWith('.tmp') || name === 'node_modules' || name === '.venv' || (outDir !== '' && resolve(abs) === outDir))
  walk(p.memoryGlobal, 'memory/global', files, skipped, () => false)
  let slugs: string[] = []
  try { slugs = readdirSync(p.projectsDir).sort() } catch {}
  for (const slug of slugs) {
    const mem = join(p.projectsDir, slug, 'memory')
    try { if (!statSync(mem).isDirectory()) continue } catch { continue }
    walk(mem, `memory/projects/${slug}`, files, skipped, () => false)
  }
  return { files, skipped }
}

// ---------------------------------------------------------------------------
// tar (ustar, with a pax header for long paths) — only what we write and read
// ---------------------------------------------------------------------------

const BLOCK = 512
const enc = new TextEncoder()
const dec = new TextDecoder()

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0'
}

function header(name: string, size: number, mode: number, mtime: number, type: '0' | 'x'): Uint8Array {
  const h = new Uint8Array(BLOCK)
  const put = (s: string, at: number, len: number) => h.set(enc.encode(s).slice(0, len), at)
  put(name, 0, 100)
  put(octal(mode & 0o7777, 8), 100, 8)
  put(octal(0, 8), 108, 8)
  put(octal(0, 8), 116, 8)
  put(octal(size, 12), 124, 12)
  put(octal(Math.floor(mtime / 1000), 12), 136, 12)
  put('        ', 148, 8)
  put(type, 156, 1)
  put('ustar\0', 257, 6)
  put('00', 263, 2)
  let sum = 0
  for (const b of h) sum += b
  put(octal(sum, 7) + ' ', 148, 8)
  return h
}

function padded(data: Uint8Array): Uint8Array[] {
  const rem = data.length % BLOCK
  return rem ? [data, new Uint8Array(BLOCK - rem)] : [data]
}

function paxRecord(key: string, value: string): string {
  // "<len> key=value\n", where len counts itself.
  const body = ` ${key}=${value}\n`
  let len = body.length + 1
  while (`${len}${body}`.length !== len) len = `${len}${body}`.length
  return `${len}${body}`
}

export type TarEntry = { path: string; data: Uint8Array; mode?: number; mtime?: number }

export function packTar(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const e of entries) {
    const mode = e.mode ?? 0o600
    const mtime = e.mtime ?? Date.now()
    if (enc.encode(e.path).length > 100) {
      const pax = enc.encode(paxRecord('path', e.path))
      parts.push(header('PaxHeader', pax.length, 0o644, mtime, 'x'), ...padded(pax))
    }
    parts.push(header(e.path, e.data.length, mode, mtime, '0'), ...padded(e.data))
  }
  parts.push(new Uint8Array(BLOCK * 2))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

function field(h: Uint8Array, at: number, len: number): string {
  const raw = h.subarray(at, at + len)
  const end = raw.indexOf(0)
  return dec.decode(end >= 0 ? raw.subarray(0, end) : raw)
}

export function unpackTar(buf: Uint8Array): TarEntry[] {
  const out: TarEntry[] = []
  let at = 0
  let longPath: string | undefined
  while (at + BLOCK <= buf.length) {
    const h = buf.subarray(at, at + BLOCK)
    if (h.every(b => b === 0)) break
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]
    if (sum !== parseInt(field(h, 148, 8).trim(), 8)) throw new Error(`tar header checksum mismatch at byte ${at}`)
    const size = parseInt(field(h, 124, 12).trim() || '0', 8)
    const type = field(h, 156, 1) || '0'
    const data = buf.slice(at + BLOCK, at + BLOCK + size)
    if (data.length !== size) throw new Error('tar entry truncated')
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(dec.decode(data))
      if (m) longPath = m[1]
      continue
    }
    const name = longPath ?? field(h, 0, 100)
    longPath = undefined
    if (type !== '0') continue // we only ever write regular files
    out.push({ path: name, data, mode: parseInt(field(h, 100, 8).trim() || '600', 8), mtime: parseInt(field(h, 136, 12).trim() || '0', 8) * 1000 })
  }
  return out
}

// ---------------------------------------------------------------------------
// Key and envelope
// ---------------------------------------------------------------------------

/**
 * The key, created on first use. An existing key that is not 32 bytes is an
 * error, never a reason to write a new one: replacing it would silently make
 * every archive already on disk unreadable.
 */
export function loadOrCreateKey(keyFile: string): Uint8Array {
  try {
    const k = new Uint8Array(readFileSync(keyFile))
    if (k.length !== 32) throw new Error(`${keyFile} is ${k.length} bytes, expected 32 — not replacing it`)
    return k
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  mkdirSync(dirname(keyFile), { recursive: true })
  const k = new Uint8Array(randomBytes(32))
  // 'wx': if two runs race, the loser reads the winner's key instead of clobbering it.
  try { writeFileSync(keyFile, k, { mode: 0o600, flag: 'wx' }) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return loadOrCreateKey(keyFile)
    throw err
  }
  return k
}

/** The key, if there is one. Verify and restore never create one. */
export function loadKey(keyFile: string): Uint8Array {
  let k: Uint8Array
  try { k = new Uint8Array(readFileSync(keyFile)) } catch {
    throw new Error(`no backup key at ${keyFile} — without it the archives cannot be read`)
  }
  if (k.length !== 32) throw new Error(`${keyFile} is ${k.length} bytes, expected 32`)
  return k
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** MAGIC ‖ 12-byte IV ‖ AES-256-GCM ciphertext+tag. The magic is the AAD, so a relabelled file fails too. */
export async function encrypt(plain: Uint8Array, rawKey: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(randomBytes(IV_BYTES))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: MAGIC }, await aesKey(rawKey), plain))
  const out = new Uint8Array(MAGIC.length + IV_BYTES + ct.length)
  out.set(MAGIC, 0)
  out.set(iv, MAGIC.length)
  out.set(ct, MAGIC.length + IV_BYTES)
  return out
}

export async function decrypt(blob: Uint8Array, rawKey: Uint8Array): Promise<Uint8Array> {
  if (blob.length < MAGIC.length + IV_BYTES + 16 || !MAGIC.every((b, i) => blob[i] === b)) {
    throw new Error('not an otto backup (bad header)')
  }
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_BYTES)
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: MAGIC }, await aesKey(rawKey), blob.subarray(MAGIC.length + IV_BYTES),
    ))
  } catch {
    // Never echo anything about the key: wrong key and tampering look the same.
    throw new Error('decryption failed — wrong key, or the archive was altered or truncated')
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export type ManifestFile = { path: string; size: number; sha256: string }
export type Manifest = { v: 1; createdAt: string; files: ManifestFile[]; skipped: Skipped[] }

export const MANIFEST = 'manifest.json'

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function archiveName(now: Date): string {
  const s = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')
  return `otto-backup-${s}.tar.gz.enc`
}

export type RunResult = { file: string; files: number; bytes: number; skipped: Skipped[]; pruned: string[] }

export async function runBackup(p: Paths, cfg: BackupConfig, now = new Date()): Promise<RunResult> {
  const key = loadOrCreateKey(p.keyFile)
  const { files, skipped } = collectSources(p, cfg.dir)
  const entries: TarEntry[] = []
  const manifest: Manifest = { v: 1, createdAt: now.toISOString(), files: [], skipped }
  for (const f of files) {
    let data: Uint8Array, st
    try { data = new Uint8Array(readFileSync(f.abs)); st = statSync(f.abs) } catch {
      // Gone between listing and reading — a .tmp renamed into place, say.
      continue
    }
    entries.push({ path: f.path, data, mode: st.mode, mtime: st.mtimeMs })
    manifest.files.push({ path: f.path, size: data.length, sha256: sha256(data) })
  }
  entries.unshift({ path: MANIFEST, data: enc.encode(JSON.stringify(manifest, null, 2) + '\n'), mode: 0o600, mtime: now.getTime() })

  const blob = await encrypt(Bun.gzipSync(packTar(entries)), key)
  mkdirSync(cfg.dir, { recursive: true, mode: 0o700 })
  const file = join(cfg.dir, archiveName(now))
  const tmp = file + '.tmp'
  writeFileSync(tmp, blob, { mode: 0o600 })
  renameSync(tmp, file)
  return { file, files: manifest.files.length, bytes: blob.length, skipped, pruned: prune(cfg) }
}

/** Archives in the backup dir, newest first. */
export function listBackups(dir: string): { file: string; bytes: number; at: string }[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  return names
    .filter(n => ARCHIVE_RE.test(n))
    .sort()
    .reverse()
    .map(n => {
      const s = n.slice('otto-backup-'.length, 'otto-backup-'.length + 16)
      const at = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`
      let bytes = 0
      try { bytes = statSync(join(dir, n)).size } catch {}
      return { file: join(dir, n), bytes, at }
    })
}

/** Keep the newest `keep`. Only ever touches files with our own name pattern. */
export function prune(cfg: BackupConfig): string[] {
  const gone: string[] = []
  for (const b of listBackups(cfg.dir).slice(cfg.keep)) {
    try { unlinkSync(b.file); gone.push(b.file) } catch {}
  }
  return gone
}

// ---------------------------------------------------------------------------
// verify and restore
// ---------------------------------------------------------------------------

/** A path from inside an archive is data: no absolute paths, no "..". */
export function safeRelative(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0')) return false
  return path.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..')
}

async function openArchive(file: string, key: Uint8Array): Promise<{ manifest: Manifest; entries: TarEntry[] }> {
  const plain = await decrypt(new Uint8Array(readFileSync(file)), key)
  let tar: Uint8Array
  try { tar = Bun.gunzipSync(plain) } catch { throw new Error('archive decrypted but is not valid gzip') }
  const entries = unpackTar(tar)
  const m = entries.find(e => e.path === MANIFEST)
  if (!m) throw new Error('archive has no manifest')
  const manifest = JSON.parse(dec.decode(m.data)) as Manifest
  if (!Array.isArray(manifest.files)) throw new Error('manifest has no file list')
  for (const e of entries) if (!safeRelative(e.path)) throw new Error(`archive holds an unsafe path: ${JSON.stringify(e.path)}`)
  return { manifest, entries: entries.filter(e => e !== m) }
}

/** Write entries under `root`, which must already exist. */
function extract(root: string, entries: TarEntry[]): void {
  for (const e of entries) {
    const target = join(root, e.path)
    if (!target.startsWith(root + sep)) throw new Error(`refusing to write outside ${root}: ${e.path}`)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    writeFileSync(target, e.data, { mode: (e.mode ?? 0o600) & 0o777 | 0o600 })
  }
}

export type VerifyResult = { ok: boolean; files: number; jsonChecked: number; createdAt?: string; problems: string[] }

/**
 * The drill. Decrypts and extracts into a fresh temp dir, then reads the files
 * back off disk — not from memory — so it proves the bytes survive the round
 * trip a real restore would take. The temp dir is removed whatever happens.
 */
export async function verifyBackup(file: string, key: Uint8Array, tmpRoot = tmpdir()): Promise<VerifyResult> {
  const problems: string[] = []
  const work = mkdtempSync(join(tmpRoot, 'otto-drill-'))
  try {
    let opened
    try { opened = await openArchive(file, key) } catch (err) {
      return { ok: false, files: 0, jsonChecked: 0, problems: [(err as Error).message] }
    }
    const { manifest, entries } = opened
    extract(work, entries)
    const listed = new Set(manifest.files.map(f => f.path))
    for (const e of entries) if (!listed.has(e.path)) problems.push(`${e.path}: in the archive but not in the manifest`)
    let jsonChecked = 0
    for (const f of manifest.files) {
      if (!safeRelative(f.path)) { problems.push(`${f.path}: unsafe path in manifest`); continue }
      let data: Uint8Array
      try { data = new Uint8Array(readFileSync(join(work, f.path))) } catch {
        problems.push(`${f.path}: listed in the manifest, missing from the archive`)
        continue
      }
      if (sha256(data) !== f.sha256) { problems.push(`${f.path}: sha256 mismatch`); continue }
      if (f.path.endsWith('.json')) {
        jsonChecked++
        try { JSON.parse(dec.decode(data)) } catch { problems.push(`${f.path}: does not parse as JSON`) }
      }
    }
    return { ok: problems.length === 0, files: manifest.files.length, jsonChecked, createdAt: manifest.createdAt, problems }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function real(path: string): string {
  // Resolve as much of the path as exists, so a not-yet-created dest still compares correctly.
  const abs = resolve(path)
  if (existsSync(abs)) return realpathSync(abs)
  const parent = dirname(abs)
  return parent === abs ? abs : join(real(parent), abs.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep)
}

/**
 * Why `dest` is not an acceptable restore target, or null. It may not be, sit
 * inside, or contain the live state or memory: `restore <f> ~/.otto` would
 * otherwise write state/… straight over ~/.otto/state. And it must be empty,
 * so a restore never merges into something half-written.
 */
export function restoreRefusal(dest: string, p: Paths): string | null {
  const d = real(dest)
  const live = [p.stateDir, join(p.home, '.claude', 'memory'), p.projectsDir].map(real)
  for (const l of live) if (overlaps(d, l)) return `${dest} overlaps live data at ${l} — restore into an empty directory elsewhere`
  if (existsSync(d)) {
    if (!statSync(d).isDirectory()) return `${dest} exists and is not a directory`
    if (readdirSync(d).length) return `${dest} is not empty`
  }
  return null
}

export type RestoreResult = { dest: string; files: number; problems: string[] }

export async function restoreBackup(file: string, dest: string, key: Uint8Array, p: Paths): Promise<RestoreResult> {
  const refusal = restoreRefusal(dest, p)
  if (refusal) throw new Error(refusal)
  const { manifest, entries } = await openArchive(file, key)
  const want = new Map(manifest.files.map(f => [f.path, f.sha256]))
  const problems: string[] = []
  for (const e of entries) {
    const h = want.get(e.path)
    if (!h) problems.push(`${e.path}: not in the manifest`)
    else if (sha256(e.data) !== h) problems.push(`${e.path}: sha256 mismatch`)
  }
  // Extract even with problems: a partial restore beats none, and the list says what to distrust.
  const root = resolve(dest)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  extract(realpathSync(root), entries)
  writeFileSync(join(root, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  return { dest: root, files: entries.length, problems }
}

// ---------------------------------------------------------------------------
// Nightly bookkeeping — pure, so the three-strikes rule is testable
// ---------------------------------------------------------------------------

export type NightRecord = {
  /** Local calendar day the night belongs to. */
  day: string
  at: string
  ok: boolean
  file?: string
  files?: number
  bytes?: number
  /** First problem, or the error, when !ok. */
  error?: string
}

export type BackupState = {
  last?: NightRecord
  lastOk?: NightRecord
  /** Failed nights in a row; 0 after any success. */
  failStreak: number
  /** The streak has already been told about. Cleared by the next success. */
  alerted?: boolean
}

export function loadBackupState(file: string): BackupState {
  try {
    const p = JSON.parse(readFileSync(file, 'utf8')) as Partial<BackupState>
    return { ...p, failStreak: Number(p.failStreak) || 0 }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: backup-state.json corrupt, moved aside.\n')
    }
    return { failStreak: 0 }
  }
}

export function saveBackupState(file: string, s: BackupState): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

/** Fold one night in. `alert` is true exactly once per run of ALERT_AFTER failures. */
export function recordNight(s: BackupState, night: NightRecord): { state: BackupState; alert: boolean } {
  if (night.ok) return { state: { last: night, lastOk: night, failStreak: 0 }, alert: false }
  const failStreak = s.failStreak + 1
  const alert = failStreak >= ALERT_AFTER && !s.alerted
  return {
    state: { ...(s.lastOk ? { lastOk: s.lastOk } : {}), last: night, failStreak, ...(alert || s.alerted ? { alerted: true } : {}) },
    alert,
  }
}

/** Run tonight? Once per local day, from 05:30, never twice at once. */
export function backupDue(o: { minuteOfDay: number; today: string; lastBackupDay?: string; inFlight: boolean }): boolean {
  return !o.inFlight && o.minuteOfDay >= BACKUP_MINUTE_OF_DAY && o.lastBackupDay !== o.today
}

/** run + verify the archive just written, as one night. Never throws. */
export async function nightly(p: Paths, cfg: BackupConfig, day: string, now = new Date()): Promise<NightRecord> {
  const at = now.toISOString()
  try {
    const r = await runBackup(p, cfg, now)
    const v = await verifyBackup(r.file, loadKey(p.keyFile))
    return v.ok
      ? { day, at, ok: true, file: r.file, files: r.files, bytes: r.bytes }
      : { day, at, ok: false, file: r.file, files: r.files, bytes: r.bytes, error: `drill failed: ${v.problems[0]}${v.problems.length > 1 ? ` (+${v.problems.length - 1} more)` : ''}` }
  } catch (err) {
    return { day, at, ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) }
  }
}

/** The message for the user, written for the session to relay in its own voice. */
export function formatBackupAlert(s: BackupState, chat?: string): string {
  return [
    `The nightly backup has failed ${s.failStreak} nights in a row. Last error (${s.last?.at ?? '?'}): ${s.last?.error ?? 'unknown'}.`,
    s.lastOk ? `Last good backup: ${s.lastOk.at} (${s.lastOk.file ?? ''}).` : 'There has never been a good backup.',
    `Tell the user once, in one short message${chat ? ` to chat ${chat}` : ''}, priority "normal". ` +
    'Say what failed in plain words and that `bun otto/backup.ts run` then `verify <file>` retries it by hand. ' +
    'This is the only message about this streak; do not raise it again.',
  ].join('\n')
}

export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function todayStamp(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

const USAGE = 'usage: bun otto/backup.ts run | list | verify <file> | restore <file> <dest>'

export async function main(argv: string[], p = backupPaths(), log = console.log): Promise<number> {
  const cfg = readBackupConfig(p)
  const [cmd, a, b] = argv
  switch (cmd) {
    case 'run': {
      const r = await runBackup(p, cfg)
      log(`wrote ${r.file} — ${r.files} files, ${formatBytes(r.bytes)}`)
      for (const s of r.skipped) log(`skipped ${s.path}: ${s.why}`)
      if (r.pruned.length) log(`pruned ${r.pruned.length} old backup(s)`)
      return 0
    }
    case 'list': {
      const all = listBackups(cfg.dir)
      if (!all.length) { log(`no backups in ${cfg.dir}`); return 0 }
      for (const x of all) log(`${x.at}  ${formatBytes(x.bytes).padStart(9)}  ${x.file}`)
      return 0
    }
    case 'verify': {
      if (!a) { log(USAGE); return 2 }
      const v = await verifyBackup(resolve(a), loadKey(p.keyFile))
      if (v.ok) log(`ok — ${v.files} files match their hashes, ${v.jsonChecked} JSON files parse (made ${v.createdAt})`)
      else { log(`FAILED — ${v.problems.length} problem(s)`); for (const x of v.problems.slice(0, 50)) log(`  ${x}`) }
      return v.ok ? 0 : 1
    }
    case 'restore': {
      if (!a || !b) { log(USAGE); return 2 }
      const r = await restoreBackup(resolve(a), b, loadKey(p.keyFile), p)
      log(`restored ${r.files} files into ${r.dest}`)
      for (const x of r.problems) log(`  ${x}`)
      log('nothing live was touched — copy back what you need by hand')
      return r.problems.length ? 1 : 0
    }
    case 'nightly': {
      // What the server spawns at 05:30. Prints one JSON line for it to read.
      const night = await nightly(p, cfg, a || todayStamp())
      const { state, alert } = recordNight(loadBackupState(p.backupStateFile), night)
      saveBackupState(p.backupStateFile, state)
      log(JSON.stringify({ ok: night.ok, alert, failStreak: state.failStreak, error: night.error ?? null }))
      return night.ok ? 0 : 1
    }
    default:
      log(USAGE)
      return 2
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)))
  } catch (err) {
    console.error(`backup: ${(err as Error)?.message ?? err}`)
    process.exit(1)
  }
}
