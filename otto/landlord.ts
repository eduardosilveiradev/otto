/**
 * The storage landlord.
 *
 * disk.ts says when the disk is filling; this says who the tenants are. Once a
 * month it walks what developer work leaves behind and lists what nobody has
 * touched in 60 days: simulator devices and runtimes, Xcode DerivedData,
 * ~/Library/Caches entries, T3 worktrees and the clones under ~/.otto/build.
 * One normal-priority card, "21 GB you haven't touched since September", with
 * [evict] / [keep].
 *
 * Never listed: a checkout with uncommitted changes, unpushed commits or a
 * stash; anything that resolves into an iCloud-synced folder; the state dir and
 * the backups; symlinks; a booted simulator. Not sure counts as no.
 *
 * [evict] removes exactly the listed items. Each is re-checked first (touched
 * since, new commits, dirty, a stash), so work started after the offer is left
 * alone. Folders go to the Trash; simulators go through simctl, which has no
 * Trash. [keep] keeps each listed item off the card for 90 days. The server
 * writes one capability-log entry naming where everything went.
 *
 * The filesystem, git, simctl and the clock come in as `Deps`, so the tests run
 * against a fake machine.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { basename, dirname, join } from 'path'
import { loadState, saveState } from './statefile.ts'
import type { Card } from './cards.ts'

export type Kind = 'sim-device' | 'sim-runtime' | 'derived-data' | 'cache' | 'worktree' | 'clone'
export type Item = {
  /** Stable across months: a path, or `simruntime:<id>`. What [keep] remembers. */
  id: string
  kind: Kind
  label: string
  bytes: number
  /** ms since epoch; the re-check refuses anything touched after this. */
  lastUsed: number
  path?: string
  udid?: string
}

export type Deps = {
  home: string
  now: number
  /** Never listed, nor anything inside or containing them: state dir, backups. */
  protect: string[]
  ls: (dir: string) => string[]
  /** Newest mtime of the folder and what sits directly in it; null when it is gone. */
  touched: (path: string) => number | null
  du: (path: string) => Promise<number | null>
  realpath: (path: string) => string
  isLink: (path: string) => boolean
  /** stdout, or undefined when git failed. */
  git: (cwd: string, args: string[]) => string | undefined
  /** xcrun and friends; stdout or undefined. */
  exec: (cmd: string[]) => Promise<string | undefined>
  /** Moves into the Trash; returns where it went, or null. */
  trash: (path: string) => string | null
}

export const IDLE_DAYS = 60
export const KEEP_DAYS = 90
const DAY = 86_400_000
const MIN_ITEM = 100e6
const MIN_TOTAL = 1e9
const MAX_ITEMS = 12

export type LandlordState = {
  lastRunMonth?: string
  lastError?: string
  offer?: { key: string; at: string; items: Item[] }
  /** id -> ISO date the keep runs out. */
  kept: Record<string, string>
  lastEvict?: { at: string; freed: number; evicted: number; leftAlone: string[] }
}

// ---------------------------------------------------------------------------
// What is safe to look at
// ---------------------------------------------------------------------------

const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/')

/** iCloud Drive, CloudStorage providers, and Desktop & Documents (synced when that option is on). */
export const icloudRoots = (home: string) =>
  [join(home, 'Library', 'Mobile Documents'), join(home, 'Library', 'CloudStorage'), join(home, 'Documents'), join(home, 'Desktop')]

export function offLimits(path: string, d: Deps): boolean {
  if (d.isLink(path)) return true
  let real: string
  try { real = d.realpath(path) } catch { return true }
  return [...icloudRoots(d.home), ...d.protect].some(r => inside(real, r) || inside(r, real))
}

/** Why a checkout must stay, or null when it is all pushed and clean. A git error is a reason. */
export function gitHold(dir: string, d: Deps): string | null {
  const status = d.git(dir, ['status', '--porcelain'])
  if (status === undefined) return 'not readable'
  if (status.trim()) return 'uncommitted changes'
  const gitDir = d.git(dir, ['rev-parse', '--absolute-git-dir'])?.trim()
  const common = d.git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim()
  if (!gitDir || !common) return 'not readable'
  const linked = gitDir !== common
  // A clone takes every branch with it; a linked worktree only its own HEAD.
  const unpushed = d.git(dir, ['rev-list', '--count', ...(linked ? ['HEAD'] : ['--branches']), '--not', '--remotes'])
  if (unpushed === undefined) return 'not readable'
  if (Number(unpushed.trim()) > 0) return 'unpushed commits'
  const stashes = d.git(dir, ['stash', 'list', '--format=%gs'])
  if (stashes === undefined) return 'not readable'
  if (linked) {
    // The stash stack is shared by every worktree of the repo; only this branch's entries hold it.
    const branch = d.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim()
    if (stashes.split('\n').some(s => s.includes(` on ${branch}:`) || s.startsWith(`On ${branch}:`))) return 'a stash'
  } else if (stashes.trim()) return 'a stash'
  return null
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

const json = (s: string | undefined): any => { try { return s ? JSON.parse(s) : undefined } catch { return undefined } }
const ms = (iso: unknown) => { const t = Date.parse(String(iso ?? '')); return Number.isNaN(t) ? null : t }

type Found = { items: Item[]; held: number }

async function folders(d: Deps, kind: Kind, parent: string, label: (name: string) => string, git: boolean, f: Found): Promise<void> {
  for (const name of d.ls(parent)) {
    const path = join(parent, name)
    if (offLimits(path, d)) continue
    const lastUsed = d.touched(path)
    if (lastUsed == null || d.now - lastUsed < IDLE_DAYS * DAY) continue
    if (git && gitHold(path, d)) { f.held++; continue }
    const bytes = await d.du(path)
    if (bytes != null) f.items.push({ id: path, kind, label: label(name), bytes, lastUsed, path })
  }
}

async function simulators(d: Deps, f: Found): Promise<void> {
  const cutoff = d.now - IDLE_DAYS * DAY
  const devices = json(await d.exec(['xcrun', 'simctl', 'list', 'devices', '--json']))?.devices ?? {}
  for (const [runtime, list] of Object.entries(devices) as [string, any[]][]) {
    for (const dev of list ?? []) {
      if (!dev?.udid || !dev.dataPath || dev.state === 'Booted') continue
      const path = dirname(dev.dataPath)
      if (offLimits(path, d)) continue
      const lastUsed = ms(dev.lastUsedAt) ?? ms(dev.lastBootedAt) ?? d.touched(path)
      if (lastUsed == null || lastUsed > cutoff) continue
      const bytes = Number(dev.dataPathSize) || await d.du(path)
      const os = /SimRuntime\.(\w+)-([\d-]+)$/.exec(runtime)
      if (bytes) f.items.push({ id: path, kind: 'sim-device', label: `${dev.name}${os ? ` (${os[1]} ${os[2]!.replace(/-/g, '.')})` : ''} simulator`, bytes, lastUsed, path, udid: dev.udid })
    }
  }
  const runtimes = json(await d.exec(['xcrun', 'simctl', 'runtime', 'list', '--json'])) ?? {}
  for (const rt of Object.values(runtimes) as any[]) {
    // No lastUsedAt is "unknown", not "never": left alone.
    const lastUsed = ms(rt?.lastUsedAt)
    if (!rt?.identifier || !rt.deletable || lastUsed == null || lastUsed > cutoff || !(rt.sizeBytes > 0)) continue
    const os = /SimRuntime\.(\w+)-/.exec(rt.runtimeIdentifier ?? '')?.[1] ?? 'simulator'
    f.items.push({ id: `simruntime:${rt.identifier}`, kind: 'sim-runtime', label: `${os} ${rt.version ?? ''} simulator runtime`.replace(/\s+/g, ' '), bytes: rt.sizeBytes, lastUsed, udid: rt.identifier })
  }
}

/** Everything idle for 60+ days, minus what [keep] is holding. Biggest first, capped to a card. */
export async function scan(d: Deps, kept: Record<string, string> = {}): Promise<{ items: Item[]; held: number }> {
  const f: Found = { items: [], held: 0 }
  await simulators(d, f)
  await folders(d, 'derived-data', join(d.home, 'Library', 'Developer', 'Xcode', 'DerivedData'), n => `DerivedData ${n.replace(/-[a-z]{20,}$/, '')}`, false, f)
  await folders(d, 'cache', join(d.home, 'Library', 'Caches'), n => `cache ${n}`, false, f)
  const wtRoot = join(d.home, '.t3', 'worktrees')
  for (const project of d.ls(wtRoot)) await folders(d, 'worktree', join(wtRoot, project), n => `worktree ${project}/${n}`, true, f)
  await folders(d, 'clone', join(d.home, '.otto', 'build'), n => `clone ${n}`, true, f)
  const items = f.items
    .filter(i => i.bytes >= MIN_ITEM && !(Date.parse(kept[i.id] ?? '') > d.now))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, MAX_ITEMS)
  return { items, held: f.held }
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export const gb = (n: number) => (n / 1e9).toFixed(n < 10e9 ? 1 : 0)
const day = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const WHAT: Record<Kind, string> = {
  'sim-device': 'simulator, deleted with simctl',
  'sim-runtime': 'simulator runtime, deleted with simctl',
  'derived-data': 'Xcode build products, rebuilt on demand',
  cache: 'app cache, refilled when needed',
  worktree: 'pushed worktree, branch kept on the remote',
  clone: 'pushed clone, re-cloned when needed',
}

export const offerKey = (items: Item[]) =>
  createHash('sha256').update(items.map(i => `${i.id}@${i.bytes}`).sort().join('\n')).digest('hex').slice(0, 8)

export function formatOffer(items: Item[], held: number, key: string, now: number) {
  const total = items.reduce((n, i) => n + i.bytes, 0)
  const newest = Math.max(...items.map(i => i.lastUsed))
  const sameYear = new Date(newest).getUTCFullYear() === new Date(now).getUTCFullYear()
  const since = new Date(newest).toLocaleDateString('en-GB', { month: 'long', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' })
  const lead = `${gb(total)} GB you haven't touched since ${since}.${held ? ' Unpushed work left alone.' : ''}`
  return {
    text: `${lead}\n${items.map(i => `${i.label}: ${gb(i.bytes)} GB, last touched ${day(i.lastUsed)}`).join('\n')}`,
    card: {
      title: lead,
      blocks: [{ type: 'list' as const, items: items.map(i => ({ title: i.label.slice(0, 120), detail: `${WHAT[i.kind]}; last touched ${day(i.lastUsed)}`, trailing: `${gb(i.bytes)} GB` })) }],
    } satisfies Card,
    buttons: [{ label: 'evict', data: `evict landlord ${key}` }, { label: 'keep', data: `keep landlord ${key}` }],
  }
}

/** The monthly pass. Returns the offer to send, or null. Mutates state (the caller saves). */
export async function checkLandlord(state: LandlordState, d: Deps) {
  for (const [id, until] of Object.entries(state.kept)) if (!(Date.parse(until) > d.now)) delete state.kept[id]
  delete state.offer   // last month's card, untapped, is superseded
  const { items, held } = await scan(d, state.kept)
  if (items.reduce((n, i) => n + i.bytes, 0) < MIN_TOTAL) return null
  const key = offerKey(items)
  state.offer = { key, at: new Date(d.now).toISOString(), items }
  return formatOffer(items, held, key, d.now)
}

// ---------------------------------------------------------------------------
// The tap
// ---------------------------------------------------------------------------

export const TAP_RE = /^(evict|keep) landlord ([a-f0-9]{8})$/

/** Why an offered item must stay now, or null to go ahead. */
async function recheck(i: Item, d: Deps): Promise<string | null> {
  if (i.kind === 'sim-device' || i.kind === 'sim-runtime') {
    const f: Found = { items: [], held: 0 }
    await simulators(d, f)
    const now = f.items.find(x => x.id === i.id)
    return !now ? 'in use since' : now.lastUsed > i.lastUsed ? 'used since' : null
  }
  if (!i.path || d.touched(i.path) == null) return 'gone'
  if (offLimits(i.path, d)) return 'off limits'
  if ((d.touched(i.path) ?? Infinity) > i.lastUsed) return 'touched since'
  if (i.kind === 'worktree' || i.kind === 'clone') return gitHold(i.path, d)
  return null
}

export type Removed = { label: string; bytes: number; from: string; to: string }

/** [evict] / [keep]. Null when the instruction isn't ours. Mutates state. */
export async function landlordTap(state: LandlordState, instruction: string, d: Deps): Promise<{ line: string; removed: Removed[] } | null> {
  const m = TAP_RE.exec(instruction)
  if (!m) return null
  const offer = state.offer
  if (offer?.key !== m[2]) return { line: 'That list is out of date; a fresh one comes next month.', removed: [] }
  delete state.offer
  if (m[1] === 'keep') {
    const until = new Date(d.now + KEEP_DAYS * DAY).toISOString()
    for (const i of offer.items) state.kept[i.id] = until
    return { line: `Kept, off the list for ${KEEP_DAYS} days.`, removed: [] }
  }
  const removed: Removed[] = [], leftAlone: string[] = []
  for (const i of offer.items) {
    const why = await recheck(i, d)
    if (why) { leftAlone.push(`${i.label} (${why})`); continue }
    let to: string | null = null
    if (i.kind === 'sim-device') to = (await d.exec(['xcrun', 'simctl', 'delete', i.udid!])) !== undefined ? 'deleted (simctl)' : null
    else if (i.kind === 'sim-runtime') to = (await d.exec(['xcrun', 'simctl', 'runtime', 'delete', i.udid!])) !== undefined ? 'deleted (simctl)' : null
    else {
      const common = i.kind === 'worktree' ? d.git(i.path!, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim() : undefined
      to = d.trash(i.path!)
      // The repo still lists the worktree until its metadata is pruned; the branch stays.
      if (to && common) d.git(common, ['worktree', 'prune'])
    }
    if (to) removed.push({ label: i.label, bytes: i.bytes, from: i.path ?? i.id, to })
    else leftAlone.push(`${i.label} (couldn't remove)`)
  }
  const freed = removed.reduce((n, r) => n + r.bytes, 0)
  state.lastEvict = { at: new Date(d.now).toISOString(), freed, evicted: removed.length, leftAlone }
  const parts = [removed.length ? `Freed about ${gb(freed)} GB${removed.some(r => !r.to.startsWith('deleted')) ? ', folders in the Trash' : ''}.` : 'Nothing removed.']
  if (leftAlone.length) parts.push(`Left alone: ${leftAlone.join(', ')}.`)
  return { line: parts.join(' '), removed }
}

// ---------------------------------------------------------------------------
// The real machine
// ---------------------------------------------------------------------------

/** Newest mtime of a folder and its direct children. ponytail: one level deep; a deeper walk if edits inside subfolders get evicted. */
function touched(path: string): number | null {
  try {
    let t = statSync(path).mtimeMs
    for (const n of readdirSync(path)) { try { t = Math.max(t, lstatSync(join(path, n)).mtimeMs) } catch {} }
    return t
  } catch { return null }
}

/** Into the Trash (~/.Trash on macOS, the freedesktop one elsewhere) under a name that cannot collide.
 *  Same volume only (rename); anything else stays put. */
function trashTo(home: string, path: string): string | null {
  const trash = process.platform === 'darwin' ? join(home, '.Trash') : join(home, '.local', 'share', 'Trash', 'files')
  const to = join(trash, `${basename(path)} ${new Date().toISOString().replace(/[:.]/g, '-')}`)
  try { mkdirSync(trash, { recursive: true }); renameSync(path, to); return to } catch { return null }
}

export function realDeps(home: string, protect: string[], du: Deps['du']): Deps {
  const exec = async (cmd: string[]) => {
    try {
      const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
      const timer = setTimeout(() => p.kill(), 120_000)
      const out = await new Response(p.stdout).text()
      const code = await p.exited
      clearTimeout(timer)
      return code === 0 ? out : undefined
    } catch { return undefined }
  }
  return {
    home, now: Date.now(), protect: protect.map(p => { try { return realpathSync(p) } catch { return p } }),
    ls: dir => { try { return readdirSync(dir) } catch { return [] } },
    touched, du, realpath: realpathSync,
    isLink: p => { try { return lstatSync(p).isSymbolicLink() } catch { return true } },
    git: (cwd, args) => {
      if (!existsSync(cwd)) return undefined
      const p = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'ignore' })
      return p.exitCode === 0 ? p.stdout.toString() : undefined
    },
    exec,
    trash: p => trashTo(home, p),
  }
}

// ---------------------------------------------------------------------------
// Store and schedule
// ---------------------------------------------------------------------------

/** 8th–10th of the month from 11:00, once a month. */
export const due = (s: LandlordState, now: Date) =>
  now.getDate() >= 8 && now.getDate() <= 10 && now.getHours() >= 11 && s.lastRunMonth !== monthOf(now)
export const monthOf = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

const valid = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x)
export const loadLandlord = (file: string): LandlordState => ({ kept: {}, ...loadState<LandlordState>(file, () => ({ kept: {} }), valid) })
export const saveLandlord = (file: string, s: LandlordState): void => saveState(file, s)
