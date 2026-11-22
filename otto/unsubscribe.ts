/** Monthly unread-newsletter offers. Only offered taps contact senders; never email. */
import { randomBytes } from 'crypto'
import { lookup } from 'dns/promises'
import { request } from 'https'
import { join } from 'path'
import { isPublicIp, isPublicUrl } from './linkmeta.ts'
import { loadState, saveState } from './statefile.ts'
import { run } from './workspace.ts'
import type { Card } from './cards.ts'
const DAY = 86_400_000
export type Message = { id: string; from: string; at: number; unread: boolean; unsubscribe: string; post: string }
export type Candidate = { sender: string; name: string; count: number; unsubscribe: string; post: string }
type Status = 'unsubscribed' | 'dismissed' | 'kept' | 'manual' | 'failed' | 'pending'
export type SweepState = { month?: string; offers: Record<string, Candidate[]>; outcomes: Record<string, { status: Status; at: number }> }
export const FILE = 'unsubscribe.json'
export const TAP = /^newsletter ([a-f0-9]{8}) (unsubscribe|keep|dismiss) (all|[0-7])$/
export const loadSweep = (dir: string) => loadState<SweepState>(join(dir, FILE), () => ({ offers: {}, outcomes: {} }), x => !!x && typeof x === 'object' && !!(x as SweepState).offers && !!(x as SweepState).outcomes)
export const saveSweep = (dir: string, state: SweepState) => saveState(join(dir, FILE), state)
export const month = (now: Date) => `${now.getFullYear()}-${now.getMonth() + 1}`
export function due(state: SweepState, now: Date): boolean {
  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  while ([0, 6].includes(first.getDay())) first.setDate(first.getDate() + 1)
  return now.getDate() === first.getDate() && now.getHours() >= 11 && state.month !== month(now)
}
function suppressed(state: SweepState, sender: string, now: number): boolean {
  const o = state.outcomes[sender]
  return !!o && (o.status !== 'kept' || now - o.at < 180 * DAY)
}
export function candidates(messages: Message[], state: SweepState, now: number): Candidate[] {
  const groups = new Map<string, Message[]>()
  for (const m of new Map(messages.map(m => [m.id, m])).values()) {
    if (m.at < now - 60 * DAY || m.at > now) continue
    const sender = (/<([^<>]+)>/.exec(m.from)?.[1] ?? m.from).trim().toLowerCase()
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(sender)) continue
    groups.set(sender, [...(groups.get(sender) ?? []), m])
  }
  return [...groups].flatMap(([sender, rows]) => {
    if (rows.length < 4 || rows.some(m => !m.unread) || suppressed(state, sender, now)) return []
    const latest = rows.filter(m => m.unsubscribe).sort((a, b) => b.at - a.at)[0]
    if (!latest) return []
    const name = latest.from.replace(/<[^>]+>/, '').replace(/["\r\n]/g, '').trim() || sender
    return [{ sender, name: Array.from(name).slice(0, 80).join(''), count: rows.length, unsubscribe: latest.unsubscribe, post: latest.post }]
  }).sort((a, b) => b.count - a.count || a.sender.localeCompare(b.sender)).slice(0, 8)
}
/** Search every page, including read mail. Metadata reads never mark mail read. */
export async function readMessages(account: string, exec = run): Promise<Message[]> {
  const json = async (args: string[]) => {
    const out = await exec(['gog', 'gmail', ...args, '-a', account, '--json', '--no-input'], undefined, 120_000)
    if (!out) throw new Error('Newsletter scan could not read mail; check Google access.')
    return JSON.parse(out)
  }
  const found = await json(['messages', 'search', 'newer_than:60d', '--all', '--max', '500'])
  const hits = Array.isArray(found) ? found : found.messages ?? []
  if (!Array.isArray(hits)) throw new Error('Newsletter scan received an unexpected message list.')
  const messages: Message[] = []
  for (let i = 0; i < hits.length; i += 5) {
    messages.push(...await Promise.all(hits.slice(i, i + 5).map(async (hit: { id: string }) => {
      const raw = await json(['get', hit.id, '--format', 'metadata', '--headers', 'From,Date,List-Unsubscribe,List-Unsubscribe-Post'])
      const m = raw.message ?? raw
      const h = new Map<string, string>()
      const headers = m.payload?.headers ?? raw.headers ?? m.headers
      if (Array.isArray(headers)) for (const v of headers) h.set(v.name.toLowerCase(), v.value)
      else if (headers) for (const [k, v] of Object.entries(headers)) h.set(k.toLowerCase(), String(v))
      const labels = m.labelIds ?? m.labels
      const at = Number(m.internalDate) || Date.parse(h.get('date') ?? m.date ?? '')
      const from = h.get('from') ?? m.from
      if (!Array.isArray(labels) || !Number.isFinite(at) || !from) throw new Error('Newsletter metadata is incomplete; scan stopped.')
      return { id: hit.id, from, at, unread: labels.includes('UNREAD'), unsubscribe: h.get('list-unsubscribe') ?? '', post: h.get('list-unsubscribe-post') ?? '' }
    })))
  }
  return messages
}
export function offer(state: SweepState, rows: Candidate[]) {
  if (!rows.length) return null
  const id = randomBytes(4).toString('hex')
  state.offers = { [id]: rows }
  const buttons = rows.flatMap((r, i) => [
    { label: `unsubscribe ${i + 1}`, data: `newsletter ${id} unsubscribe ${i}` },
    { label: `keep ${i + 1}`, data: `newsletter ${id} keep ${i}` },
    { label: `dismiss ${i + 1}`, data: `newsletter ${id} dismiss ${i}` },
  ])
  buttons.push({ label: 'unsubscribe all', data: `newsletter ${id} unsubscribe all` })
  const text = `Newsletters still unread in the last 60 days:\n${rows.map((r, i) => `${i + 1}. ${r.name} — ${r.count}`).join('\n')}`
  const card: Card = { title: 'Unread newsletters', blocks: [{ type: 'list', items: rows.map((r, i) => ({ title: `${i + 1}. ${r.name}`, detail: r.sender.slice(0, 120), trailing: String(r.count) })) }] }
  return { text, card, buttons }
}
export function validateUrl(value: string): URL {
  const u = new URL(value)
  if (u.protocol !== 'https:' || !isPublicUrl(u) || (u.port && u.port !== '443') || !u.hostname.includes('.')) throw new Error('Unsafe unsubscribe URL')
  return u
}
/** Validate the connection's DNS answers, closing the rebinding gap. No redirects. */
export async function fetchUnsubscribe(value: string, method: 'GET' | 'POST', connect = request): Promise<void> {
  const u = validateUrl(value)
  await new Promise<void>((resolve, reject) => {
    const req = connect(u, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
      lookup: (host, options, cb) => {
        lookup(host, { all: true }).then(addresses => {
          if (!addresses.length || !addresses.every(a => isPublicIp(a.address))) return cb(new Error('Private unsubscribe host'), '', 4)
          if (options.all) (cb as Function)(null, addresses)
          else cb(null, addresses[0].address, addresses[0].family)
        }, err => cb(err, '', 4))
      },
    }, res => {
      res.destroy()
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve()
      else reject(new Error('Unsubscribe request failed or requires a manual redirect'))
    })
    const timer = setTimeout(() => req.destroy(new Error('Unsubscribe timed out')), 15_000)
    req.on('close', () => clearTimeout(timer))
    req.on('error', reject)
    req.end(method === 'POST' ? 'List-Unsubscribe=One-Click' : undefined)
  })
}
export async function unsubscribe(row: Candidate, send = fetchUnsubscribe): Promise<'unsubscribed' | 'manual'> {
  const urls = [...row.unsubscribe.matchAll(/<([^<>]+)>/g)].map(m => m[1])
  const url = urls.find(s => { try { validateUrl(s); return true } catch { return false } })
  if (!url) return 'manual'
  if (/^\s*List-Unsubscribe\s*=\s*One-Click\s*$/i.test(row.post)) {
    await send(url, 'POST')
    return 'unsubscribed'
  }
  // ponytail: conservative GET allowlist; preference centres and opaque links stay manual.
  const u = validateUrl(url)
  if (!/(?:^|\/)unsubscribe(?:[/.]|$)/i.test(u.pathname) || [...u.searchParams.keys()].some(k => /url|redirect|return|next|continue/i.test(k))) return 'manual'
  await send(url, 'GET')
  return 'unsubscribed'
}
let tapping = false
export async function applyTap(dir: string, data: string, send = fetchUnsubscribe, now = Date.now()): Promise<string> {
  const m = TAP.exec(data)
  if (!m) return 'Unknown newsletter button.'
  if (tapping) return 'An unsubscribe is already in progress.'
  tapping = true
  try {
    const state = loadSweep(dir), rows = state.offers[m[1]]
    if (!rows) return 'That newsletter offer has expired.'
    const selected = m[3] === 'all' ? rows : rows.slice(Number(m[3]), Number(m[3]) + 1)
    const results: string[] = []
    for (const row of selected) {
      if (suppressed(state, row.sender, now)) { results.push(`${row.name}: already handled`); continue }
      let status: Status = m[2] === 'keep' ? 'kept' : 'dismissed'
      if (m[2] === 'unsubscribe') {
        state.outcomes[row.sender] = { status: 'pending', at: now }
        saveSweep(dir, state) // claim before I/O: repeated taps and reloads cannot send twice
        try { status = await unsubscribe(row, send) } catch { status = 'failed' }
      }
      state.outcomes[row.sender] = { status, at: now }
      saveSweep(dir, state)
      const label = { unsubscribed: 'unsubscribe requested', kept: 'kept for 180 days', dismissed: 'dismissed', manual: 'needs a manual unsubscribe', failed: 'request failed; needs a manual unsubscribe', pending: 'request pending' }[status]
      results.push(`${row.name}: ${label}`)
    }
    return results.join('\n')
  } finally { tapping = false }
}
