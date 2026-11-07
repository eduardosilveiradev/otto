import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ghExpiry, readGh, readVercel, vercelToken, certItems, profileItem, readProfiles, scanShelf, dueNudges, markNudged, formatNudges,
  addManual, removeItem, formatShelf, loadShelf, saveShelf, DAY, ROTATE, type Shelf, type ShelfItem,
} from '../keyshelf.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-keyshelf-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const NOW = Date.parse('2026-10-21T10:00:00Z')
const fx = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', 'keyshelf', name), 'utf8')
const empty = (): Shelf => ({ items: [], nudged: [], errors: {} })
const item = (id: string, daysOut: number, o: Partial<ShelfItem> = {}): ShelfItem =>
  ({ id, source: 'gh', label: id, expiresAt: new Date(NOW + daysOut * DAY).toISOString(), rotate: '', ...o })

test('ghExpiry reads the header GitHub sends for a fine-grained token', () => {
  const headers = 'HTTP/2.0 200 OK\ncontent-type: application/json\ngithub-authentication-token-expiration: 2026-11-03 12:00:00 UTC\nx-ratelimit-limit: 5000\n\n{}'
  expect(ghExpiry(headers)).toBe('2026-11-03T12:00:00.000Z')
  expect(ghExpiry('HTTP/2.0 200 OK\ncontent-type: application/json')).toBeUndefined()
})

test('readGh: gh missing or an OAuth token (no header) leaves the shelf empty', async () => {
  expect(await readGh(async () => undefined)).toEqual([])
  expect(await readGh(async () => 'HTTP/2.0 200 OK\n\n{}')).toEqual([])
  const got = await readGh(async cmd => (cmd.join(' ') === 'gh api -i user' ? 'github-authentication-token-expiration: 2026-11-03 12:00:00 UTC' : undefined))
  expect(got).toEqual([{ id: 'gh:github.com', source: 'gh', label: 'the GitHub token gh uses', expiresAt: '2026-11-03T12:00:00.000Z', rotate: ROTATE.gh }])
})

test('readVercel: asks with the bearer token, keeps only dated tokens, throws on a bad status', async () => {
  const seen: { url: string; auth: string }[] = []
  const fake = (status: number) => (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: (init.headers as Record<string, string>).Authorization! })
    return new Response(JSON.stringify({ tokens: [
      { id: 'tok1', name: 'ci', expiresAt: Date.parse('2027-03-01T00:00:00Z'), createdAt: Date.parse('2026-03-01T00:00:00Z') },
      { id: 'tok2', name: 'forever' },
    ] }), { status })
  }) as unknown as typeof fetch
  const got = await readVercel('t', fake(200))
  expect(seen).toEqual([{ url: 'https://api.vercel.com/v5/user/tokens', auth: 'Bearer t' }])
  expect(got).toHaveLength(1)
  expect(got[0]).toMatchObject({ id: 'vercel:tok1', source: 'vercel', label: 'Vercel token "ci"', expiresAt: '2027-03-01T00:00:00.000Z', createdAt: '2026-03-01T00:00:00.000Z' })
  await expect(readVercel('t', fake(401))).rejects.toThrow('vercel 401')
  let called = false
  expect(await readVercel(undefined, (async () => { called = true; return new Response('{}') }) as unknown as typeof fetch)).toEqual([])
  expect(called).toBe(false)
})

test('vercelToken: env first, then the CLI auth file, a malformed file is nothing', () => {
  const home = mkdtempSync(join(tmp, 'home-'))
  expect(vercelToken({}, home)).toBeUndefined()
  const dir = join(home, 'Library', 'Application Support', 'com.vercel.cli')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'auth.json'), '{"token":"from-file"}')
  expect(vercelToken({}, home)).toBe('from-file')
  expect(vercelToken({ VERCEL_TOKEN: 'from-env' }, home)).toBe('from-env')
  writeFileSync(join(dir, 'auth.json'), '{nope')
  expect(vercelToken({}, home)).toBeUndefined()
})

test('certItems: signing certificates only, the latest of a CN wins', () => {
  const got = certItems(fx('dev-cert-old.pem') + fx('root-ca.pem') + fx('dev-cert.pem'))
  expect(got).toHaveLength(1)
  expect(got[0]!.label).toBe('signing certificate "Apple Development: you@example.com (ABCDE12345)"')
  expect(got[0]!.id).toMatch(/^cert:[0-9A-F]{16}$/)
  expect(got[0]!.id).toHaveLength(21)
  const longer = certItems(fx('dev-cert.pem'))[0]!
  expect(got[0]!.expiresAt).toBe(longer.expiresAt)
  expect(Date.parse(longer.expiresAt) - Date.parse(longer.createdAt!)).toBeGreaterThan(300 * DAY)
  expect(certItems('not a pem')).toEqual([])
})

test('profileItem and readProfiles', async () => {
  const p = profileItem(fx('profile.plist'))!
  expect(p).toMatchObject({ id: 'profile:11111111-2222-4333-8444-555555555555', label: 'provisioning profile "Otto Dev"', expiresAt: '2027-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' })
  expect(profileItem('<dict></dict>')).toBeUndefined()
  expect(profileItem(fx('profile.plist').replace('Otto Dev', 'A &amp; B'))!.label).toBe('provisioning profile "A & B"')

  const dir = mkdtempSync(join(tmp, 'prof-'))
  writeFileSync(join(dir, 'a.mobileprovision'), 'a')
  writeFileSync(join(dir, 'b.mobileprovision'), 'b')
  writeFileSync(join(dir, 'c.txt'), 'c')
  const decode = async (f: string) => (f.endsWith('a.mobileprovision') ? fx('profile.plist') : fx('profile.plist').replace('2027-01-01', '2027-06-01'))
  const got = await readProfiles([dir, join(dir, 'missing')], decode)
  expect(got).toHaveLength(1)
  expect(got[0]!.expiresAt).toBe('2027-06-01T00:00:00Z')
  expect(await readProfiles([join(dir, 'missing')], decode)).toEqual([])
})

test('scanShelf: short lifetimes skipped, a failing source keeps its items, manual survives', async () => {
  const shelf = empty()
  addManual(shelf, { label: 'hook token', expires: '2027-01-01' }, NOW)
  const free = profileItem(fx('profile.plist'))!
  const freeShort = profileItem(fx('profile-free.plist'))!
  await scanShelf(shelf, { 'apple-profile': async () => [free, freeShort], gh: async () => [item('gh:github.com', 40)] }, NOW)
  expect(shelf.items.map(i => i.id).sort()).toEqual(['gh:github.com', 'manual:hook-token', free.id].sort())
  await scanShelf(shelf, { gh: async () => { throw new Error('boom') } }, NOW)
  expect(shelf.items.some(i => i.id === 'gh:github.com')).toBe(true)
  expect(shelf.errors.gh).toContain('boom')
  await scanShelf(shelf, { gh: async () => [item('gh:github.com', 90)] }, NOW)
  expect(shelf.errors.gh).toBeUndefined()
  expect(shelf.items.find(i => i.id === 'gh:github.com')!.expiresAt).toBe(new Date(NOW + 90 * DAY).toISOString())
  expect(shelf.items.some(i => i.id === 'manual:hook-token')).toBe(true)
  expect(shelf.scannedAt).toBe(new Date(NOW).toISOString())
})

test('scanShelf prunes nudge keys a month past their date', async () => {
  const shelf = { ...empty(), nudged: ['a@2026-09-01', 'b@2026-10-15'] }
  await scanShelf(shelf, {}, NOW)
  expect(shelf.nudged).toEqual(['b@2026-10-15'])
})

test('dueNudges: 14 days is in, 15 is out, once per expiry date, expired is history', () => {
  const shelf = { ...empty(), items: [item('a', 15)] }
  expect(dueNudges(shelf, NOW)).toEqual([])
  shelf.items = [item('a', 14)]
  const due = dueNudges(shelf, NOW)
  expect(due).toHaveLength(1)
  markNudged(shelf, due)
  expect(dueNudges(shelf, NOW)).toEqual([])
  shelf.items = [item('a', 365)]   // renewed: a new date starts over
  expect(dueNudges(shelf, NOW)).toEqual([])
  shelf.items = [item('a', 10)]
  expect(dueNudges(shelf, NOW)).toHaveLength(1)
  shelf.items = [item('b', -1)]
  expect(dueNudges(shelf, NOW)).toEqual([])
})

test('formatNudges reads like a person', () => {
  const shelf = empty()
  addManual(shelf, { label: 'staging deploy token', expires: '2026-11-03', rotate: 'settings → developer → tokens' }, NOW - 30 * DAY)
  expect(formatNudges(shelf.items, Date.parse('2026-10-21T13:00:00Z'))).toBe('staging deploy token expires in 13 days (2026-11-03). settings → developer → tokens.')
  expect(formatNudges([item('x', 0.5)], NOW)).toContain('expires in 1 day (')
})

test('addManual: secrets, bad dates refused; the same label updates; near expiry is marked nudged', () => {
  const shelf = empty()
  expect(() => addManual(shelf, { label: `token ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`, expires: '2026-12-01' }, NOW)).toThrow('looks like the secret')
  expect(() => addManual(shelf, { label: 'x', expires: '2026-12-01', rotate: `use ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}` }, NOW)).toThrow('looks like the secret')
  expect(() => addManual(shelf, { label: 'x', expires: '2026-13-01' }, NOW)).toThrow('YYYY-MM-DD')
  expect(() => addManual(shelf, { label: 'x', expires: '3 Nov' }, NOW)).toThrow('YYYY-MM-DD')
  expect(() => addManual(shelf, { label: '  ', expires: '2026-12-01' }, NOW)).toThrow('label is required')
  expect(shelf.items).toEqual([])
  expect(addManual(shelf, { label: 'Hook Token', expires: '2026-12-01' }, NOW)).toBe('on the shelf — one nudge on 2026-11-17.')
  addManual(shelf, { label: 'hook token', expires: '2027-01-01' }, NOW)
  expect(shelf.items).toHaveLength(1)
  expect(shelf.items[0]!.expiresAt).toBe('2027-01-01T12:00:00.000Z')
  const msg = addManual(shelf, { label: 'soon', expires: '2026-10-26', rotate: 'do the thing' }, NOW)
  expect(msg).toContain('no separate nudge')
  expect(msg).toContain('with the steps')
  expect(dueNudges(shelf, NOW)).toEqual([])
})

test('removeItem: manual goes, read-from-source stays, unknown says so', () => {
  const shelf = { ...empty(), items: [item('gh:github.com', 30, { source: 'gh', label: 'the GitHub token gh uses' })] }
  addManual(shelf, { label: 'hook token', expires: '2027-01-01' }, NOW)
  expect(removeItem(shelf, 'The GitHub token gh uses')).toContain('read from gh every day')
  expect(shelf.items).toHaveLength(2)
  expect(removeItem(shelf, 'Hook Token')).toBe('took hook token off the shelf.')
  expect(shelf.items).toHaveLength(1)
  expect(removeItem(shelf, 'nope')).toBe('nothing on the shelf called "nope"')
})

test('formatShelf: by date, with days left and unreadable sources', () => {
  expect(formatShelf(empty(), NOW)).toBe('(nothing on the shelf)')
  const shelf = { ...empty(), items: [item('late', 40, { label: 'later' }), item('soon', 3, { label: 'sooner', source: 'vercel' }), item('gone', -2, { label: 'old' })], errors: { vercel: 'vercel 401' } }
  const lines = formatShelf(shelf, NOW).split('\n')
  expect(lines[0]).toBe(`old — ${item('gone', -2).expiresAt.slice(0, 10)} (2 days ago) [gh]`)
  expect(lines[1]).toContain('sooner')
  expect(lines[1]).toContain('(3 days)')
  expect(lines[2]).toContain('later')
  expect(lines[3]).toBe("couldn't read vercel: vercel 401")
})

test('state round-trips; a file without errors loads with {}', () => {
  const f = join(tmp, 'keyshelf.json')
  const shelf = { ...empty(), items: [item('a', 3)], nudged: ['a@2026-10-24'] }
  saveShelf(f, shelf)
  expect(loadShelf(f)).toEqual(shelf)
  writeFileSync(f, JSON.stringify({ items: [], nudged: [] }))
  expect(loadShelf(f).errors).toEqual({})
  expect(loadShelf(join(tmp, 'absent.json'))).toEqual(empty())
})
