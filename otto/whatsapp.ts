/**
 * WhatsApp as a chat surface, through the WhatsApp Agent Platform: an agent the
 * user created in WhatsApp (Settings > Agents), which only its creator can talk
 * to, so there is exactly one chat. This file is the wire — one long poll in,
 * serialized sends out, media both ways. What an inbound message means is
 * server.ts's business, the same as for Telegram and the app.
 *
 * State (whatsapp.json): the poll offset and the first sender ever seen. Anyone
 * else is dropped. Participant ids belong to an account and can change (a new
 * phone number does it), so every drop is logged with the fix: delete `owner`
 * and the next message re-pairs.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'
import { chunk } from './chunk.ts'
import { loadState, saveState } from './statefile.ts'

export const WA_CHAT = 'whatsapp'
const API = 'https://api.whatsapp.com/agent/v1'
const TEXT_MAX = 4096
const CAPTION_MAX = 1024
/** 15 polls a minute is the cap; one every 4 s stays under it however busy the chat gets. */
const POLL_GAP_MS = 4_000
const POLL_TIMEOUT_S = 20

export type WaMedia = { id: string; mime_type?: string; caption?: string; filename?: string; voice?: boolean }
export type WaMessage = {
  from: string; id: string; timestamp: string; type: string
  context?: { id: string; from: string }
  text?: { body: string }
  image?: WaMedia; audio?: WaMedia; video?: WaMedia; document?: WaMedia; sticker?: WaMedia
  reaction?: { message_id: string; emoji: string }
}
export type WaState = { offset?: number; owner?: string }

/** GET /updates → its messages and the offset to poll next. Statuses (delivered/read) are dropped. */
export function parseUpdates(body: unknown): { messages: WaMessage[]; nextOffset?: number } {
  const b = body as { entry?: { changes?: { value?: { messages?: unknown[] } }[] }[]; next_offset?: unknown }
  const messages: WaMessage[] = []
  for (const e of b?.entry ?? []) for (const c of e?.changes ?? []) for (const m of c?.value?.messages ?? []) {
    const x = m as WaMessage
    if (typeof x?.from === 'string' && typeof x.id === 'string' && typeof x.type === 'string') messages.push(x)
  }
  return { messages, ...(typeof b?.next_offset === 'number' ? { nextOffset: b.next_offset } : {}) }
}

/** The first sender becomes the owner; anyone else is refused. Mutates `state` on first contact. */
export function gate(state: WaState, from: string): boolean {
  if (!state.owner) state.owner = from
  return state.owner === from
}

export type WaKind = 'text' | 'photo' | 'voice' | 'audio' | 'video' | 'document' | 'reaction'
export type WaInbound = {
  kind: WaKind
  text: string
  meta: Record<string, string>
  media?: { id: string; ext: string }
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'application/pdf': 'pdf', 'text/plain': 'txt',
}
function extFor(m: WaMedia): string {
  const mime = (m.mime_type ?? '').split(';')[0].trim().toLowerCase()
  const fromName = m.filename ? extname(m.filename).slice(1).replace(/[^a-zA-Z0-9]/g, '') : ''
  return EXT[mime] ?? (fromName || 'bin')
}

/** One message as Otto sees it, before any download. null: nothing to deliver (an emoji taken back, an unknown type). */
export function describe(m: WaMessage): WaInbound | null {
  const meta: Record<string, string> = { message_id: m.id }
  if (m.context?.id) {
    meta.reply_to_id = m.context.id
    meta.reply_to_from = m.context.from?.startsWith('agent:') ? 'otto' : 'user'
  }
  const media = (x: WaMedia | undefined) => x?.id ? { id: x.id, ext: extFor(x) } : undefined
  switch (m.type) {
    case 'text':
      return m.text?.body?.trim() ? { kind: 'text', text: m.text.body.trim(), meta } : null
    case 'reaction': {
      const emoji = m.reaction?.emoji?.trim()
      if (!emoji || !m.reaction?.message_id) return null
      // A tapback reads like a one-emoji reply to that message, as in the app.
      return { kind: 'reaction', text: emoji, meta: { ...meta, reaction: '1', reply_to_id: m.reaction.message_id, reply_to_from: 'otto' } }
    }
    case 'image': case 'sticker': {
      const x = m.image ?? m.sticker
      return { kind: 'photo', text: x?.caption?.trim() || (m.type === 'sticker' ? '(sticker)' : '(photo)'), meta, media: media(x) }
    }
    case 'audio':
      return m.audio?.voice
        ? { kind: 'voice', text: '(voice message)', meta, media: media(m.audio) }
        : { kind: 'audio', text: '(audio)', meta: { ...meta, attachment_kind: 'audio', ...(m.audio?.mime_type ? { attachment_mime: m.audio.mime_type } : {}) }, media: media(m.audio) }
    case 'video': case 'document': {
      const x = m.video ?? m.document
      const name = x?.filename ? basename(x.filename).slice(0, 120) : undefined
      return {
        kind: m.type, text: x?.caption?.trim() || `(${m.type}${name ? `: ${name}` : ''})`, media: media(x),
        meta: { ...meta, attachment_kind: m.type, ...(x?.mime_type ? { attachment_mime: x.mime_type } : {}), ...(name ? { attachment_name: name } : {}) },
      }
    }
    default:
      return null
  }
}

export type WaButton = { label: string; data?: string; url?: string; copy?: string }

/** WhatsApp agents get no buttons, so they go under the text: numbered choices, then links and copyable lines. */
export function renderButtons(text: string, buttons: WaButton[]): string {
  if (!buttons.length) return text
  const choices = buttons.filter(b => b.data).map((b, i) => `${i + 1}. ${b.label}`)
  const rest = buttons.filter(b => !b.data).map(b => `${b.label}: ${b.url ?? b.copy}`)
  return [text, [choices.join('   '), ...rest].filter(Boolean).join('\n')].join('\n\n')
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim()
/** A reply that is a choice's number or its label is the tap. */
export function matchButton(buttons: WaButton[], text: string): WaButton | null {
  const choices = buttons.filter(b => b.data)
  const t = text.trim()
  const n = /^\[?(\d)\]?$/.exec(t)
  if (n) return choices[Number(n[1]) - 1] ?? null
  return t && norm(t) ? choices.find(b => norm(b.label) === norm(t)) ?? null : null
}

/** What to send a file as: the API's message type and the MIME type it must be declared with. */
export function mediaKind(path: string): { type: 'image' | 'video' | 'audio' | 'document'; mime: string } {
  const ext = extname(path).slice(1).toLowerCase()
  const mime = Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? (ext === 'jpeg' ? 'image/jpeg' : ext === 'opus' ? 'audio/ogg' : 'application/octet-stream')
  const type = mime.startsWith('image/') && ext !== 'webp' ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document'
  return { type, mime }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const log = (s: string) => process.stderr.write(`otto channel: whatsapp ${s}\n`)

export class WhatsApp {
  private state: WaState
  /** The sender of the latest message, the address the API says to reply to. */
  private to: string | undefined
  /** Sends one at a time: the API does not order concurrent ones. */
  private tail: Promise<unknown> = Promise.resolve()
  /** On the very first start, offset=0 replays up to 30 days; anything older than this is that backlog. */
  private readonly skipBefore: number

  constructor(private token: string, private stateFile: string, private fetchFn: typeof fetch = fetch) {
    this.state = loadState<WaState>(stateFile, () => ({}), x => typeof x === 'object' && x !== null && !Array.isArray(x))
    this.to = this.state.owner
    this.skipBefore = this.state.offset == null ? Date.now() - 60_000 : 0
  }

  private auth(): Record<string, string> { return { Authorization: `Bearer ${this.token}` } }

  /** A send: retried on 429 and on 503 (not accepted, so not sent); never on a 500, which may have landed. */
  private async post(path: string, body: object | FormData): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(`${API}${path}`, {
        method: 'POST',
        headers: body instanceof FormData ? this.auth() : { ...this.auth(), 'Content-Type': 'application/json' },
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
      const json = await res.json().catch(() => ({})) as Record<string, unknown> & { error?: { code?: number; message?: string } }
      if (res.ok) return json
      if ((res.status === 429 || res.status === 503) && attempt < 3) { await sleep(2_000 * 2 ** attempt); continue }
      throw new Error(`${path} HTTP ${res.status}${json.error ? ` (#${json.error.code}) ${json.error.message ?? ''}` : ''}`)
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => {})
    return run
  }

  private recipient(): string {
    if (!this.to) throw new Error('no WhatsApp chat yet — the user has to message the agent once first')
    return this.to
  }

  /** Text, split under the 4096 cap; the quote rides on the first part. Returns the wamids. */
  sendText(text: string, replyTo?: string): Promise<string[]> {
    return this.serial(async () => {
      const ids: string[] = []
      for (const [i, part] of chunk(text, TEXT_MAX, 'newline').entries()) {
        const r = await this.post('/messages', {
          messaging_product: 'whatsapp', to: this.recipient(), type: 'text', text: { body: part },
          ...(i === 0 && replyTo ? { context: { message_id: replyTo } } : {}),
        })
        ids.push(...((r.messages as { id: string }[] | undefined) ?? []).map(m => m.id))
      }
      return ids
    })
  }

  /** Upload then send one file, typed by its extension. Returns the wamid. */
  sendFile(path: string, caption?: string): Promise<string> {
    return this.serial(async () => {
      const { type, mime } = mediaKind(path)
      const form = new FormData()
      form.append('messaging_product', 'whatsapp')
      form.append('type', mime)
      form.append('file', Bun.file(path, { type: mime }), basename(path))
      const { id } = await this.post('/media', form) as { id: string }
      const r = await this.post('/messages', {
        messaging_product: 'whatsapp', to: this.recipient(), type,
        [type]: {
          id,
          ...(caption && type !== 'audio' ? { caption: caption.slice(0, CAPTION_MAX) } : {}),
          ...(type === 'document' ? { filename: basename(path) } : {}),
        },
      })
      return ((r.messages as { id: string }[] | undefined) ?? [])[0]?.id ?? ''
    })
  }

  /** Blue ticks, and the typing dots when a reply is coming (they clear on the reply or after 25 s). */
  async markRead(messageId: string, typing: boolean): Promise<void> {
    await this.post('/statuses', {
      messaging_product: 'whatsapp', status: 'read', message_id: messageId,
      ...(typing ? { typing_indicator: { type: 'text' } } : {}),
    })
  }

  /** Fetch an inbound attachment into `dir`; returns its path. */
  async download(mediaId: string, ext: string, dir: string): Promise<string> {
    const meta = await this.fetchFn(`${API}/media/${encodeURIComponent(mediaId)}`, { headers: this.auth(), signal: AbortSignal.timeout(30_000) })
    if (!meta.ok) throw new Error(`media lookup HTTP ${meta.status}`)
    const { url } = await meta.json() as { url?: string }
    if (!url?.startsWith('https://')) throw new Error('media lookup returned no url')
    const res = await this.fetchFn(url, { headers: this.auth(), signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`media download HTTP ${res.status}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${Date.now()}-wa-${mediaId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40)}.${ext}`)
    writeFileSync(path, Buffer.from(await res.arrayBuffer()))
    return path
  }

  /** One poll; delivers what passes the gate, in order, then saves the offset. Returns the delay before the next. */
  async pollOnce(onMessage: (m: WaMessage) => Promise<void>): Promise<number> {
    const started = Date.now()
    // offset=0 the first time, never "no offset": an offset-less poll re-resolves the head and can
    // skip whatever lands between polls. The backlog that replays is skipped by timestamp below.
    const q = new URLSearchParams({ offset: String(this.state.offset ?? 0), limit: '100', timeout: String(POLL_TIMEOUT_S) })
    const res = await this.fetchFn(`${API}/updates?${q}`, { headers: this.auth(), signal: AbortSignal.timeout((POLL_TIMEOUT_S + 20) * 1000) })
    if (res.status === 204) return Math.max(0, POLL_GAP_MS - (Date.now() - started))
    if (res.status === 409) { log('poll replaced by a newer one — is a second Otto polling?'); return 30_000 }
    if (res.status === 400 || res.status === 401) { log(`token rejected (HTTP ${res.status}) — regenerate the agent's API key`); return 300_000 }
    if (!res.ok) throw new Error(`poll HTTP ${res.status}`)
    const { messages, nextOffset } = parseUpdates(await res.json())
    const ownerBefore = this.state.owner
    for (const m of messages) {
      if (Number(m.timestamp) * 1000 < this.skipBefore) continue
      if (!gate(this.state, m.from)) { log(`dropped a message from an unknown sender — if the user's id changed, delete "owner" in ${basename(this.stateFile)}`); continue }
      this.to = m.from
      try { await onMessage(m) } catch (err) { log(`inbound ${m.id} failed: ${err}`) }
    }
    if ((nextOffset != null && nextOffset !== this.state.offset) || this.state.owner !== ownerBefore) {
      if (nextOffset != null) this.state.offset = nextOffset
      saveState(this.stateFile, this.state)
    }
    return Math.max(0, POLL_GAP_MS - (Date.now() - started))
  }

  /** Poll forever, backing off exponentially (2 s to 1 min) on errors and 429s. */
  async run(onMessage: (m: WaMessage) => Promise<void>): Promise<never> {
    let backoff = 0
    for (;;) {
      try {
        await sleep(await this.pollOnce(onMessage))
        backoff = 0
      } catch (err) {
        backoff = Math.min(60_000, Math.max(2_000, backoff * 2))
        log(`poll failed: ${err} — retrying in ${backoff / 1000}s`)
        await sleep(backoff)
      }
    }
  }
}
