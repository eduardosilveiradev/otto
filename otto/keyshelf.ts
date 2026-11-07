/**
 * The shelf of credentials that lapse.
 *
 * A token that expires on a Tuesday breaks something on a Tuesday, usually
 * something nobody is looking at. Once a day from 10:00 this reads expiry
 * metadata where the source exposes it: the header GitHub returns for a
 * fine-grained token (`gh api -i user`), Vercel's token list, Apple signing
 * certificates in the keychain and provisioning profiles on disk. Anything
 * else the user mentions goes on the shelf by hand (`key_expiry`).
 *
 * Only labels, dates and rotation steps are stored, never a value. The Vercel
 * token needed to read its own list is held in memory for that one request.
 * Input that looks like a secret is refused (redact.ts) rather than stored.
 *
 * Items that renew themselves (a lifetime of 30 days or less: a free team's
 * 7-day profiles, short CLI tokens) are skipped. Each item gets one nudge, 14
 * days out, keyed by id and expiry date; a renewal is a new date, so it starts
 * over (the domains.ts pattern).
 *
 * Readers are injected, so the tests run offline.
 */

import { X509Certificate } from 'node:crypto'
import { readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { run } from './workspace.ts'
import { redactSecrets } from './redact.ts'
import { loadState, saveState } from './statefile.ts'

export type Source = 'gh' | 'vercel' | 'apple-cert' | 'apple-profile' | 'manual'
export type ShelfItem = { id: string; source: Source; label: string; expiresAt: string; createdAt?: string; rotate: string }
export type Shelf = { items: ShelfItem[]; nudged: string[]; errors: Partial<Record<Source, string>>; scannedAt?: string }

const emptyShelf = (): Shelf => ({ items: [], nudged: [], errors: {} })
const validShelf = (x: unknown): boolean => !!x && typeof x === 'object' && Array.isArray((x as Shelf).items) && Array.isArray((x as Shelf).nudged)
export function loadShelf(file: string): Shelf {
  const s = loadState(file, emptyShelf, validShelf)
  return { ...s, errors: s.errors ?? {} }
}
export const saveShelf = (file: string, s: Shelf): void => saveState(file, s)

export const LEAD_DAYS = 14
/** A lifetime this short renews itself. */
export const MIN_LIFETIME_DAYS = 30
export const DAY = 86_400_000

export const ROTATE: Record<Exclude<Source, 'manual'>, string> = {
  gh: 'github.com → settings → developer settings → personal access tokens: regenerate it, then gh auth login with the new one.',
  vercel: 'vercel.com → account settings → tokens: make a new one, swap it wherever this one is used, then delete the old.',
  'apple-cert': 'Xcode → Settings → Accounts → Manage Certificates → + makes a new one (or developer.apple.com → certificates).',
  'apple-profile': 'automatic signing regenerates it on the next Xcode build; otherwise developer.apple.com → profiles → edit → generate.',
}

/** The expiry GitHub states for a fine-grained token; an OAuth token carries none. */
export function ghExpiry(headers: string): string | undefined {
  const m = /^github-authentication-token-expiration:\s*(.+)$/im.exec(headers)
  if (!m) return undefined
  const t = Date.parse(m[1]!.trim().replace(' UTC', 'Z').replace(' ', 'T'))
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

export async function readGh(exec: typeof run = run): Promise<ShelfItem[]> {
  const out = await exec(['gh', 'api', '-i', 'user'], undefined, 10_000)
  const expiresAt = out === undefined ? undefined : ghExpiry(out)
  return expiresAt ? [{ id: 'gh:github.com', source: 'gh', label: 'the GitHub token gh uses', expiresAt, rotate: ROTATE.gh }] : []
}

/** Never logged, never returned to anyone but readVercel. */
export function vercelToken(env: Record<string, string | undefined> = process.env, home = homedir()): string | undefined {
  if (env.VERCEL_TOKEN) return env.VERCEL_TOKEN
  try {
    const dir = process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : env.XDG_DATA_HOME || join(home, '.local', 'share')
    const t = JSON.parse(readFileSync(join(dir, 'com.vercel.cli', 'auth.json'), 'utf8')).token
    return typeof t === 'string' && t ? t : undefined
  } catch { return undefined }
}

export async function readVercel(token: string | undefined, doFetch: typeof fetch = fetch): Promise<ShelfItem[]> {
  if (!token) return []
  const res = await doFetch('https://api.vercel.com/v5/user/tokens', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`vercel ${res.status}`)
  const body = await res.json() as { tokens?: { id: string; name?: string; expiresAt?: unknown; createdAt?: unknown }[] }
  return (body.tokens ?? []).filter(t => typeof t.expiresAt === 'number').map(t => ({
    id: `vercel:${t.id}`,
    source: 'vercel' as const,
    label: `Vercel token "${t.name}"`,
    expiresAt: new Date(t.expiresAt as number).toISOString(),
    ...(typeof t.createdAt === 'number' ? { createdAt: new Date(t.createdAt).toISOString() } : {}),
    rotate: ROTATE.vercel,
  }))
}

export const SIGNING_CN = /^(Apple (Development|Distribution)|Developer ID (Application|Installer)|iPhone (Developer|Distribution)|Mac (Developer|App Distribution|Installer Distribution)|3rd Party Mac Developer (Application|Installer))\b/

/** Signing certificates in a PEM bundle; a renewed one supersedes the old one that stays in the keychain. */
export function certItems(pemBundle: string): ShelfItem[] {
  const best = new Map<string, { x: X509Certificate; cn: string }>()
  for (const pem of pemBundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
    try {
      const x = new X509Certificate(pem)
      const cn = /^CN=(.+)$/m.exec(x.subject)?.[1]
      if (!cn || !SIGNING_CN.test(cn)) continue
      const cur = best.get(cn)
      if (!cur || Date.parse(x.validTo) > Date.parse(cur.x.validTo)) best.set(cn, { x, cn })
    } catch {}
  }
  return [...best.values()].map(({ x, cn }) => ({
    id: `cert:${x.fingerprint256.replace(/:/g, '').slice(0, 16)}`,
    source: 'apple-cert' as const,
    label: `signing certificate "${cn}"`,
    expiresAt: new Date(x.validTo).toISOString(),
    createdAt: new Date(x.validFrom).toISOString(),
    rotate: ROTATE['apple-cert'],
  }))
}

/** Public certificates only: no keychain prompt. */
export async function readAppleCerts(exec: typeof run = run): Promise<ShelfItem[]> {
  return certItems(await exec(['security', 'find-certificate', '-a', '-p'], undefined, 10_000) ?? '')
}

export const PROFILE_DIRS = (home: string): string[] => [
  join(home, 'Library', 'MobileDevice', 'Provisioning Profiles'),
  join(home, 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles'),
]

/** From a decoded profile plist. */
export function profileItem(xml: string): ShelfItem | undefined {
  const dates: Record<string, string> = {}
  for (const m of xml.matchAll(/<key>(ExpirationDate|CreationDate)<\/key>\s*<date>([^<]+)<\/date>/g)) dates[m[1]!] = m[2]!
  const strs: Record<string, string> = {}
  for (const m of xml.matchAll(/<key>(Name|UUID)<\/key>\s*<string>([^<]*)<\/string>/g)) strs[m[1]!] = m[2]!
  if (!strs.UUID || !dates.ExpirationDate) return undefined
  const name = (strs.Name ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  return {
    id: `profile:${strs.UUID}`,
    source: 'apple-profile',
    label: `provisioning profile "${name}"`,
    expiresAt: dates.ExpirationDate,
    ...(dates.CreationDate ? { createdAt: dates.CreationDate } : {}),
    rotate: ROTATE['apple-profile'],
  }
}

export async function readProfiles(dirs: string[], decode: (file: string) => Promise<string | undefined> = f => run(['security', 'cms', '-D', '-i', f], undefined, 5000)): Promise<ShelfItem[]> {
  const best = new Map<string, ShelfItem>()
  for (const dir of dirs) {
    let files: string[]
    try { files = readdirSync(dir).filter(f => f.endsWith('.mobileprovision')) } catch { continue }
    for (const f of files) {
      const item = profileItem(await decode(join(dir, f)) ?? '')
      if (!item) continue
      const cur = best.get(item.label)
      if (!cur || Date.parse(item.expiresAt) > Date.parse(cur.expiresAt)) best.set(item.label, item)
    }
  }
  return [...best.values()]
}

export type Readers = Partial<Record<Exclude<Source, 'manual'>, () => Promise<ShelfItem[]>>>

export function defaultReaders(home = homedir()): Readers {
  return {
    gh: () => readGh(),
    vercel: () => readVercel(vercelToken(process.env, home)),
    'apple-cert': () => readAppleCerts(),
    'apple-profile': () => readProfiles(PROFILE_DIRS(home)),
  }
}

/** A source that fails keeps its old items and records why. Manual items are never touched. */
export async function scanShelf(shelf: Shelf, readers: Readers, now: number): Promise<void> {
  for (const [source, read] of Object.entries(readers) as [Exclude<Source, 'manual'>, () => Promise<ShelfItem[]>][]) {
    try {
      const fresh = (await read()).filter(i => !i.createdAt || Date.parse(i.expiresAt) - Date.parse(i.createdAt) > MIN_LIFETIME_DAYS * DAY)
      shelf.items = [...shelf.items.filter(i => i.source !== source), ...fresh]
      delete shelf.errors[source]
    } catch (err) {
      shelf.errors[source] = String(err).slice(0, 120)
    }
  }
  shelf.nudged = shelf.nudged.filter(k => Date.parse(k.slice(k.lastIndexOf('@') + 1)) > now - 30 * DAY)
  shelf.scannedAt = new Date(now).toISOString()
}

export const nudgeKey = (i: ShelfItem): string => `${i.id}@${i.expiresAt.slice(0, 10)}`

/** Inside the lead window and not yet nudged; one already expired is history. */
export function dueNudges(shelf: Shelf, now: number): ShelfItem[] {
  return shelf.items.filter(i => {
    const left = Date.parse(i.expiresAt) - now
    return left > 0 && left <= LEAD_DAYS * DAY && !shelf.nudged.includes(nudgeKey(i))
  })
}

export function markNudged(shelf: Shelf, items: ShelfItem[]): void {
  for (const i of items) shelf.nudged.push(nudgeKey(i))
}

export function formatNudges(items: ShelfItem[], now: number): string {
  return items.map(i => {
    const d = Math.ceil((Date.parse(i.expiresAt) - now) / DAY)
    return `${i.label} expires in ${d} day${d === 1 ? '' : 's'} (${i.expiresAt.slice(0, 10)}).${i.rotate ? ` ${i.rotate}${/[.!?]$/.test(i.rotate) ? '' : '.'}` : ''}`
  }).join('\n')
}

/** Throws on bad input; the tool handler turns that into an error result. */
export function addManual(shelf: Shelf, a: { label: string; expires: string; rotate?: string }, now: number): string {
  const label = a.label.trim()
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (!label || label.length > 80 || !slug) throw new Error('label is required')
  const expiresAt = `${a.expires}T12:00:00.000Z`
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.expires) || !(Date.parse(expiresAt) > 0) || new Date(expiresAt).toISOString() !== expiresAt) throw new Error('expires must be YYYY-MM-DD')
  const rotate = a.rotate?.trim() ?? ''
  if (redactSecrets(`${label} ${rotate}`).hits.length) throw new Error('that looks like the secret itself — give me only a name and the date')
  const item: ShelfItem = { id: `manual:${slug}`, source: 'manual', label, expiresAt, rotate }
  shelf.items = [...shelf.items.filter(i => i.id !== item.id), item]
  if (Date.parse(expiresAt) - now <= LEAD_DAYS * DAY) {
    markNudged(shelf, [item])
    return `on the shelf — already inside 14 days, so there will be no separate nudge: tell them now${rotate ? ' with the steps' : ''}.`
  }
  return `on the shelf — one nudge on ${new Date(Date.parse(expiresAt) - LEAD_DAYS * DAY).toISOString().slice(0, 10)}.`
}

export function removeItem(shelf: Shelf, labelOrId: string): string {
  const x = labelOrId.trim().toLowerCase()
  const hit = shelf.items.find(i => i.id.toLowerCase() === x || i.label.toLowerCase() === x)
  if (!hit) return `nothing on the shelf called "${labelOrId.trim()}"`
  if (hit.source !== 'manual') return `that one is read from ${hit.source} every day — it comes back until it is renewed or deleted there.`
  shelf.items = shelf.items.filter(i => i !== hit)
  return `took ${hit.label} off the shelf.`
}

export function formatShelf(shelf: Shelf, now: number): string {
  const lines = [...shelf.items].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)).map(i => {
    const d = Math.ceil((Date.parse(i.expiresAt) - now) / DAY)
    return `${i.label} — ${i.expiresAt.slice(0, 10)} (${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'}${d < 0 ? ' ago' : ''}) [${i.source}]`
  })
  for (const [source, err] of Object.entries(shelf.errors)) lines.push(`couldn't read ${source}: ${err}`)
  return lines.length ? lines.join('\n') : '(nothing on the shelf)'
}
