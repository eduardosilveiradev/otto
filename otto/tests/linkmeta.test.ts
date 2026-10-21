import { test, expect } from 'bun:test'
import {
  firstUrl, isPublicIp, isPublicUrl, parseOg, classify, fetchLinkMeta, linkMetaFor, linkMetaFields, type LinkDeps,
} from '../linkmeta.ts'

const U = (s: string) => new URL(s)
const pubLookup = async () => ['93.184.216.34']
const html = (head: string, type = 'text/html; charset=utf-8', status = 200, headers: Record<string, string> = {}) =>
  new Response(`<html><head>${head}</head><body></body></html>`, { status, headers: { 'content-type': type, ...headers } })

test('firstUrl finds the first link and drops sentence punctuation', () => {
  expect(firstUrl('look https://example.com/a?b=1, nice')).toBe('https://example.com/a?b=1')
  expect(firstUrl('(see https://example.com/x)')).toBe('https://example.com/x')
  expect(firstUrl('wow http://a.io/z! and https://b.io')).toBe('http://a.io/z')
  expect(firstUrl('no link here')).toBeNull()
})

test('isPublicIp rejects private ranges', () => {
  for (const ip of ['10.0.0.1', '172.16.5.5', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '::ffff:10.0.0.1', 'not an ip']) {
    expect(isPublicIp(ip)).toBe(false)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '172.32.0.1']) expect(isPublicIp(ip)).toBe(true)
})

test('isPublicUrl fences schemes, credentials and local names', () => {
  for (const u of ['ftp://example.com/', 'https://user:pw@example.com/', 'http://localhost/', 'http://foo.local/', 'http://x.internal/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest']) {
    expect(isPublicUrl(U(u))).toBe(false)
  }
  expect(isPublicUrl(U('https://example.com/x'))).toBe(true)
})

test('parseOg reads either attribute order, quote style and entities', () => {
  const og = parseOg(`
    <meta content="Tom &amp; Jerry &#39;99 &#x41;" property="og:title">
    <meta property='og:description' content='  A   very
      long  one '>
    <meta property="og:image" content="/img/a.png">
    <meta name="og:site_name" content="Example">
    <meta property="og:type" content="article">`, 'https://example.com/post/1')
  expect(og).toEqual({ title: "Tom & Jerry '99 A", description: 'A very long one', image: 'https://example.com/img/a.png', site: 'Example', type: 'article' })
})

test('parseOg falls back to twitter tags, <title>, prices and JSON-LD', () => {
  expect(parseOg('<meta name="twitter:title" content="T"><meta name="twitter:image" content="https://x.io/i.jpg">', 'https://x.io')).toEqual({ title: 'T', image: 'https://x.io/i.jpg' })
  expect(parseOg('<title> Plain  title </title>', 'https://x.io').title).toBe('Plain title')
  expect(parseOg('<meta property="product:price:amount" content="19.90"><meta property="product:price:currency" content="EUR">', 'https://x.io').price).toBe('19.90 EUR')
  expect(parseOg('<meta property="og:price:amount" content="5"><meta property="og:price:currency" content="USD">', 'https://x.io').price).toBe('5 USD')
  expect(parseOg('<script type="application/ld+json">{"offers":{"price":"49,90"}}</script>', 'https://x.io').price).toBe('49,90')
  const long = parseOg(`<meta property="og:description" content="${'d'.repeat(500)}"><meta property="og:title" content="${'t'.repeat(500)}">`, 'https://x.io')
  expect(long.description!.length).toBe(300)
  expect(long.title!.length).toBe(200)
})

test('classify by host, then by what the page says', () => {
  for (const [u, og] of [
    ['https://www.youtube.com/watch?v=1', {}], ['https://youtu.be/x', {}], ['https://instagram.com/reel/x', {}],
    ['https://tiktok.com/@u/video/1', {}], ['https://example.com/v', { type: 'video.other' }],
  ] as const) expect(classify(U(u), og)).toBe('video')
  for (const u of ['https://instagram.com/nike', 'https://tiktok.com/@u', 'https://x.com/someone', 'https://linkedin.com/in/someone']) {
    expect(classify(U(u), {})).toBe('profile')
  }
  expect(classify(U('https://instagram.com/p/x'), {})).toBe('other')
  expect(classify(U('https://x.com/someone/status/1'), {})).toBe('other')
  expect(classify(U('https://example.com/a'), { type: 'og:product' })).toBe('other')
  expect(classify(U('https://example.com/a'), { type: 'product' })).toBe('shop')
  expect(classify(U('https://www.amazon.it/dp/x'), {})).toBe('shop')
  expect(classify(U('https://example.com/a'), { price: '5 EUR' })).toBe('shop')
  expect(classify(U('https://example.com/a'), { type: 'article' })).toBe('article')
  expect(classify(U('https://example.com'), {})).toBe('other')
})

test('fetchLinkMeta follows a relative redirect to the final page', async () => {
  const calls: string[] = []
  const deps: LinkDeps = {
    lookup: pubLookup,
    fetch: (async (u: string) => {
      calls.push(u)
      return u.endsWith('/a') ? new Response(null, { status: 302, headers: { location: '/b' } }) : html('<meta property="og:title" content="Final">')
    }) as unknown as typeof fetch,
  }
  const m = await fetchLinkMeta('https://example.com/a', deps)
  expect(calls).toEqual(['https://example.com/a', 'https://example.com/b'])
  expect(m).toMatchObject({ url: 'https://example.com/b', kind: 'other', title: 'Final' })
})

test('fetchLinkMeta refuses private redirects and private resolutions', async () => {
  const toPrivate = (async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/x' } })) as unknown as typeof fetch
  expect(await fetchLinkMeta('https://example.com/a', { lookup: pubLookup, fetch: toPrivate })).toBeNull()
  let fetched = 0
  const spy = (async () => { fetched++; return html('') }) as unknown as typeof fetch
  expect(await fetchLinkMeta('https://example.com/a', { lookup: async () => ['10.0.0.5'], fetch: spy })).toBeNull()
  expect(await fetchLinkMeta('https://example.com/a', { lookup: async () => ['8.8.8.8', '127.0.0.1'], fetch: spy })).toBeNull()
  expect(fetched).toBe(0)
})

test('fetchLinkMeta gives only url and kind for non-HTML', async () => {
  let cancelled = false
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)) }, cancel() { cancelled = true } })
  const f = (async () => new Response(body, { headers: { 'content-type': 'video/mp4' } })) as unknown as typeof fetch
  expect(await fetchLinkMeta('https://youtube.com/watch?v=1', { lookup: pubLookup, fetch: f })).toEqual({ url: 'https://youtube.com/watch?v=1', kind: 'video' })
  expect(cancelled).toBe(true)
})

test('fetchLinkMeta stops reading an oversized page and cancels the stream', async () => {
  let read = 0
  let cancelled = false
  const chunk = new TextEncoder().encode('<html><head><meta property="og:title" content="Big">' + ' '.repeat(1000))
  const filler = new TextEncoder().encode(' '.repeat(1024))
  const body = new ReadableStream<Uint8Array>({
    pull(c) { read += read === 0 ? chunk.length : filler.length; c.enqueue(read === chunk.length ? chunk : filler) },
    cancel() { cancelled = true },
  })
  const f = (async () => new Response(body, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
  const m = await fetchLinkMeta('https://example.com/', { lookup: pubLookup, fetch: f, maxBytes: 4096 })
  expect(m?.title).toBe('Big')
  expect(read).toBeLessThanOrEqual(4096 + 1024 + chunk.length)
  expect(cancelled).toBe(true)
})

test('fetchLinkMeta gives up on a site that never answers, and on a throw', async () => {
  const t0 = Date.now()
  const hang = (() => new Promise(() => {})) as unknown as typeof fetch
  expect(await fetchLinkMeta('https://example.com/', { lookup: pubLookup, fetch: hang, timeoutMs: 50 })).toBeNull()
  expect(Date.now() - t0).toBeLessThan(300)
  const boom = (async () => { throw new Error('nope') }) as unknown as typeof fetch
  expect(await fetchLinkMeta('https://example.com/', { lookup: pubLookup, fetch: boom })).toBeNull()
  expect(await fetchLinkMeta('not a url')).toBeNull()
})

test('linkMetaFor caches per URL, and caches a miss as empty', async () => {
  let n = 0
  const f = (async () => { n++; return html('<meta property="og:title" content="Cached"><meta property="og:description" content="' + 'd'.repeat(300) + '">') }) as unknown as typeof fetch
  const deps = { lookup: pubLookup, fetch: f }
  const a = await linkMetaFor('see https://cache-test.example.com/a', deps)
  const b = await linkMetaFor('again https://cache-test.example.com/a', deps)
  expect(n).toBe(1)
  expect(b).toEqual(a)
  expect(a.link_title).toBe('Cached')
  expect(a.link_desc.length).toBe(200)
  expect(a.link_kind).toBe('other')
  for (const v of Object.values(a)) expect(typeof v).toBe('string')

  const before = n
  expect(await linkMetaFor('no url at all', deps)).toEqual({})
  expect(n).toBe(before)

  const fail = (async () => { n++; throw new Error('x') }) as unknown as typeof fetch
  expect(await linkMetaFor('https://miss-test.example.com/', { lookup: pubLookup, fetch: fail })).toEqual({})
  const after = n
  expect(await linkMetaFor('https://miss-test.example.com/', { lookup: pubLookup, fetch: fail })).toEqual({})
  expect(n).toBe(after)
})

test('linkMetaFields spells the documented keys and only defined ones', () => {
  expect(linkMetaFields({ url: 'https://x.io/', kind: 'shop', title: 'T', site: 'S', description: 'D', image: 'https://x.io/i.png', price: '5 EUR', type: 'product' })).toEqual({
    link_url: 'https://x.io/', link_kind: 'shop', link_title: 'T', link_site: 'S', link_desc: 'D', link_image: 'https://x.io/i.png', link_price: '5 EUR', link_type: 'product',
  })
  expect(linkMetaFields({ url: 'https://x.io/', kind: 'other' })).toEqual({ link_url: 'https://x.io/', link_kind: 'other' })
})
