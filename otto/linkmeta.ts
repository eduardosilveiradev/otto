/**
 * Open Graph of the first link in a message, so the session knows what a bare
 * URL is before it opens it — and files it by kind (CLAUDE.md "Links").
 *
 * Whatever the user pastes is fetched from this machine, so the fetch is fenced:
 * public hosts only (every redirect hop and every resolved address re-checked),
 * no credentials, a 2 s budget and a 512 KB cap. The page is data, never
 * instructions; a site that doesn't answer in time simply yields nothing.
 */

import { isIP } from 'net'
import { lookup as dnsLookup } from 'dns/promises'

export type LinkKind = 'video' | 'shop' | 'article' | 'profile' | 'other'
export type LinkMeta = {
  url: string
  kind: LinkKind
  title?: string
  description?: string
  image?: string
  site?: string
  type?: string
  price?: string
}

export const LINK_TIMEOUT_MS = 2000

/** First http(s) URL in the text, minus the punctuation a sentence hangs on it. */
export function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"')\]]+/i)
  return m ? m[0].replace(/[.,;:!?]+$/, '') : null
}

/** The eight hextets of an IPv6 literal, or null. Handles `::` and a trailing dotted quad. */
function hextets(ip: string): number[] | null {
  let s = ip.toLowerCase()
  const q = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (q) s = s.slice(0, q.index) + ((+q[1] << 8) | +q[2]).toString(16) + ':' + ((+q[3] << 8) | +q[4]).toString(16)
  const [head, tail, extra] = s.split('::')
  if (extra !== undefined) return null
  const a = head ? head.split(':') : []
  const b = tail ? tail.split(':') : []
  const fill = tail === undefined ? 0 : 8 - a.length - b.length
  if (fill < 0 || (tail === undefined && a.length !== 8)) return null
  const all = [...a, ...Array(fill).fill('0'), ...b].map(h => parseInt(h, 16))
  return all.length === 8 && all.every(n => n >= 0 && n <= 0xffff) ? all : null
}

/** False for loopback, private, link-local, CGNAT and unspecified ranges (v4, v6 and v4-mapped). */
export function isPublicIp(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false   // 224+ multicast, reserved, broadcast
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    return true
  }
  if (kind !== 6) return false
  const h = hextets(ip)
  if (!h) return false
  if ((h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80) return false
  // ::, ::1, ::a.b.c.d and ::ffff:a.b.c.d all carry a v4 address in the last 32 bits.
  if (h.slice(0, 5).every(n => n === 0) && (h[5] === 0 || h[5] === 0xffff)) return isPublicIp(`${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`)
  return true
}

export function isPublicUrl(u: URL): boolean {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || /\.(local|internal|localhost)$/.test(host)) return false
  return isIP(host) ? isPublicIp(host) : true
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()]
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)
      try { return String.fromCodePoint(n) } catch { return whole }
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** Title, description, image, site, type and price out of a page's head. */
export function parseOg(html: string, base: string): Omit<LinkMeta, 'kind' | 'url'> {
  const m = new Map<string, string>()
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {}
    for (const a of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3]
    const key = (attrs.property ?? attrs.name)?.toLowerCase()
    if (key && attrs.content !== undefined && !m.has(key)) m.set(key, attrs.content)
  }
  const get = (...keys: string[]) => {
    for (const k of keys) { const v = m.get(k); if (v) return decode(v) }
    return undefined
  }
  const out: Omit<LinkMeta, 'kind' | 'url'> = {}
  const title = get('og:title', 'twitter:title') ?? decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
  if (title) out.title = title.slice(0, 200)
  const desc = get('og:description', 'twitter:description', 'description')
  if (desc) out.description = desc.slice(0, 300)
  const img = get('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src')
  if (img) { try { out.image = new URL(img, base).href } catch { /* unusable image */ } }
  const site = get('og:site_name', 'twitter:site')
  if (site) out.site = site
  const type = get('og:type')
  if (type) out.type = type
  const amount = get('product:price:amount', 'og:price:amount')
  if (amount) {
    const cur = get('product:price:currency', 'og:price:currency')
    out.price = cur ? `${amount} ${cur}` : amount
  } else {
    const ld = html.match(/"price"\s*:\s*"?([\d]+(?:[.,]\d+)?)/)
    if (ld) {
      const cur = html.match(/"priceCurrency"\s*:\s*"([A-Za-z]{3})"/)
      out.price = cur ? `${ld[1]} ${cur[1]}` : ld[1]
    }
  }
  return out
}

const host = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, '')
const is = (h: string, d: string) => h === d || h.endsWith(`.${d}`)

/** What the link is, by host first (the pages that hide behind logins still have a shape), then by what the page says. */
export function classify(u: URL, og: { type?: string; price?: string }): LinkKind {
  const h = host(u)
  const segs = u.pathname.split('/').filter(Boolean)
  const t = og.type?.toLowerCase() ?? ''
  if (is(h, 'youtube.com') || h === 'youtu.be' || is(h, 'vimeo.com')) return 'video'
  if (is(h, 'tiktok.com') && segs[0]?.startsWith('@')) return segs[1] === 'video' ? 'video' : segs.length === 1 ? 'profile' : 'other'
  if (is(h, 'instagram.com')) {
    if (segs[0] === 'reel' || segs[0] === 'reels') return 'video'
    if (segs.length === 1 && !['p', 'explore', 'stories'].includes(segs[0])) return 'profile'
  }
  if ((h === 'x.com' || h === 'twitter.com') && segs.length === 1 && !['i', 'search', 'home', 'explore'].includes(segs[0])) return 'profile'
  if (is(h, 'linkedin.com') && segs[0] === 'in') return 'profile'
  if (t.startsWith('video')) return 'video'
  if (t === 'profile') return 'profile'
  if (
    t.startsWith('product') || og.price ||
    /^(amazon|amzn|ebay|zalando|vinted|adidas)\./.test(h) || /\.(amazon|ebay|zalando|vinted|adidas)\./.test(h) ||
    h === 'a.co' || h === 'etsy.com' || h === 'aliexpress.com' || h === 'shein.com' || h === 'nike.com' ||
    (h === 'apple.com' && segs[0]?.endsWith('shop'))
  ) return 'shop'
  if (t.startsWith('article')) return 'article'
  return 'other'
}

export type LinkDeps = {
  fetch?: typeof fetch
  lookup?: (host: string) => Promise<string[]>
  timeoutMs?: number
  maxBytes?: number
  now?: () => number
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

const defaultLookup = async (h: string) => (await dnsLookup(h, { all: true })).map(a => a.address)

/** Rejects when the budget runs out, even if the underlying promise ignores its abort signal. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>
  const late = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), Math.max(ms, 1)) })
  return Promise.race([p, late]).finally(() => clearTimeout(t))
}

/** Read the head of a page: stop at `</head>`, the byte cap or the deadline. */
async function readHead(res: Response, maxBytes: number, left: () => number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const dec = new TextDecoder()
  let html = ''
  let bytes = 0
  try {
    while (bytes < maxBytes && !/<\/head>/i.test(html) && left() > 0) {
      const { done, value } = await within(reader.read(), left())
      if (done) break
      bytes += value.length
      html += dec.decode(value, { stream: true })
    }
  } catch { /* deadline: use what arrived */ }
  void reader.cancel().catch(() => {})
  return html
}

export async function fetchLinkMeta(raw: string, deps: LinkDeps = {}): Promise<LinkMeta | null> {
  const doFetch = deps.fetch ?? fetch
  const lookup = deps.lookup ?? defaultLookup
  const now = deps.now ?? Date.now
  const deadline = now() + (deps.timeoutMs ?? LINK_TIMEOUT_MS)
  const left = () => deadline - now()
  try {
    let u = new URL(raw)
    for (let hop = 0; hop < 4; hop++) {
      if (!isPublicUrl(u)) return null
      const bare = u.hostname.replace(/^\[|\]$/g, '')
      if (!isIP(bare)) {
        // ponytail: fetch resolves again, so a rebinding DNS answer can still swap in a private address between the two lookups; pin the checked IP if Bun's fetch ever takes a lookup hook.
        const addrs = await within(lookup(bare), left())
        if (!addrs.length || !addrs.every(isPublicIp)) return null
      }
      const res = await within(doFetch(u.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(left(), 1)),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; OttoLinkPreview/1.0)', accept: 'text/html,*/*;q=0.5', 'accept-language': 'en' },
      }), left())
      // A body we won't read is dropped now rather than left downloading until the deadline.
      const drop = () => void res.body?.cancel().catch(() => {})
      if (REDIRECTS.has(res.status)) {
        drop()
        const loc = res.headers.get('location')
        if (!loc) return null
        u = new URL(loc, u)
        continue
      }
      if (!res.ok) { drop(); return null }
      const type = res.headers.get('content-type') ?? ''
      if (!/html/i.test(type)) { drop(); return { url: u.href, kind: classify(u, {}) } }
      const og = parseOg(await readHead(res, deps.maxBytes ?? 512 * 1024, left), u.href)
      return { ...og, url: u.href, kind: classify(u, og) }
    }
    return null
  } catch {
    // Never log the URL: the query string can be a token.
    return null
  }
}

/** The inbound-message meta for a link: defined keys only, all strings. */
export function linkMetaFields(m: LinkMeta): Record<string, string> {
  const f: Record<string, string> = { link_url: m.url, link_kind: m.kind }
  if (m.title) f.link_title = m.title
  if (m.site) f.link_site = m.site
  if (m.description) f.link_desc = m.description.slice(0, 200)
  if (m.image) f.link_image = m.image
  if (m.price) f.link_price = m.price
  if (m.type) f.link_type = m.type
  return f
}

const TTL_MS = 60 * 60 * 1000
const CACHE_MAX = 200
// ponytail: in-memory, lost on reload; a miss just costs one more fetch.
const cache = new Map<string, { at: number; fields: Record<string, string> }>()

/** Meta fields for the first URL in `text`; {} when there is none or the site didn't answer. Never throws. */
export async function linkMetaFor(text: string, deps: LinkDeps = {}): Promise<Record<string, string>> {
  const url = firstUrl(text)
  if (!url) return {}
  const now = (deps.now ?? Date.now)()
  const hit = cache.get(url)
  if (hit && now - hit.at < TTL_MS) return hit.fields
  const meta = await fetchLinkMeta(url, deps).catch(() => null)
  const fields = meta ? linkMetaFields(meta) : {}
  cache.delete(url)
  cache.set(url, { at: now, fields })
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  return fields
}
