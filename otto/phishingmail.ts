/**
 * Fetch a Gmail message with gog and turn its raw MIME into scoreMail's input.
 * A deliberately small parser: headers, nested multipart, text/plain and
 * text/html parts, base64 and quoted-printable. Attachments are skipped.
 */
import { scoreMail, type MailInput, type PhishResult, type MailLink } from './phishing.ts'

type Headers = Record<string, string | string[]>

function splitMessage(raw: string): { head: string; body: string } {
  const m = raw.match(/\r?\n\r?\n/)
  return m ? { head: raw.slice(0, m.index), body: raw.slice(m.index! + m[0].length) } : { head: raw, body: '' }
}

export function parseHeaders(head: string): Headers {
  const out: Headers = {}
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i < 1) continue
    const k = line.slice(0, i).trim().toLowerCase()
    const v = line.slice(i + 1).trim()
    const cur = out[k]
    out[k] = cur === undefined ? v : ([] as string[]).concat(cur, v)
  }
  return out
}

const one = (h: Headers, k: string) => ([] as string[]).concat(h[k] ?? [])[0] ?? ''

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try { return new TextDecoder(charset || 'utf-8').decode(bytes) } catch { return new TextDecoder().decode(bytes) }
}

export function decodeQP(s: string): Uint8Array {
  const t = s.replace(/=\r?\n/g, '')
  const out: number[] = []
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9a-f]{2}$/i.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2 }
    else out.push(...new TextEncoder().encode(t[i]))
  }
  return Uint8Array.from(out)
}

const decodeB64 = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'base64'))

/** RFC 2047 encoded words in header values: =?utf-8?B?...?= / =?utf-8?Q?...?= */
export function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, cs, enc, txt) =>
    decodeBytes(enc.toLowerCase() === 'b' ? decodeB64(txt) : decodeQP(txt.replace(/_/g, ' ')), cs))
}

type Part = { type: string; text: string }

function leafText(h: Headers, body: string, charset: string): string {
  const cte = one(h, 'content-transfer-encoding').toLowerCase()
  const bytes = cte === 'base64' ? decodeB64(body) : cte === 'quoted-printable' ? decodeQP(body) : new TextEncoder().encode(body)
  return decodeBytes(bytes, charset)
}

function collect(raw: string, out: Part[], depth = 0): Headers {
  const { head, body } = splitMessage(raw)
  const h = parseHeaders(head)
  const ct = one(h, 'content-type') || 'text/plain'
  const type = ct.split(';')[0].trim().toLowerCase()
  const boundary = ct.match(/boundary="?([^";]+)"?/i)?.[1]
  if (type.startsWith('multipart/') && boundary && depth < 8) {
    for (const seg of body.split('--' + boundary).slice(1)) {
      if (seg.startsWith('--')) break
      collect(seg.replace(/^\r?\n/, ''), out, depth + 1)
    }
  } else if ((type === 'text/plain' || type === 'text/html') && !/attachment/i.test(one(h, 'content-disposition'))) {
    out.push({ type, text: leafText(h, body, ct.match(/charset="?([^";]+)"?/i)?.[1] ?? 'utf-8') })
  }
  return h
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const unent = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : m }
  return ENT[e.toLowerCase()] ?? m
})
const stripTags = (s: string) => unent(s.replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

export function htmlLinks(html: string): MailLink[] {
  return [...html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(m => ({ href: unent(m[1] ?? m[2] ?? m[3] ?? '').trim(), text: stripTags(m[4]) }))
    .filter(l => /^https?:/i.test(l.href))
}

export function parseMime(raw: string): MailInput {
  const parts: Part[] = []
  const h = collect(raw, parts)
  const plain = parts.filter(p => p.type === 'text/plain').map(p => p.text).join('\n')
  const htmls = parts.filter(p => p.type === 'text/html').map(p => p.text)
  const links = htmls.flatMap(htmlLinks)
  const text = plain || htmls.map(stripTags).join('\n')
  for (const u of text.match(/https?:\/\/[^\s<>"')]+/g) ?? []) if (!links.some(l => l.href === u)) links.push({ href: u, text: u })
  return {
    headers: h,
    from: decodeWords(one(h, 'from')),
    replyTo: one(h, 'reply-to') ? decodeWords(one(h, 'reply-to')) : undefined,
    subject: decodeWords(one(h, 'subject')),
    text,
    links,
  }
}

/** gog's `--format raw --json` wraps the RFC 822 bytes as base64url `raw`; accept that or plain MIME text. */
export function rawFromGog(out: string): string {
  try {
    const j = JSON.parse(out)
    const r = j?.raw ?? j?.message?.raw ?? j?.data?.raw
    if (typeof r === 'string') return Buffer.from(r.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  } catch {}
  return out
}

export type Runner = (cmd: string[]) => Promise<string | null>

const bunRun: Runner = async cmd => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
  const timer = setTimeout(() => { try { proc.kill() } catch {} }, 30_000)
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  clearTimeout(timer)
  return code === 0 ? out : null
}

export async function checkMessage(id: string, account: string, run: Runner = bunRun): Promise<PhishResult> {
  if (!/^[0-9a-zA-Z_-]+$/.test(id)) throw new Error('bad message id')
  const out = await run(['gog', 'gmail', 'get', id, '-a', account, '--format', 'raw', '--json'])
  if (!out) throw new Error('could not fetch the message')
  return scoreMail(parseMime(rawFromGog(out)))
}
