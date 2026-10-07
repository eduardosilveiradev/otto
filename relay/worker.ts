// Otto's always-on Telegram relay — a Cloudflare Worker with one Durable Object.
//
// Telegram posts every update here (webhook mode). The relay checks Telegram's
// secret header, drops anything not from an allowlisted chat, queues the update,
// and pushes the whole queue, oldest first, to Otto. A 2xx within FORWARD_MS
// empties the queue. Anything else leaves it queued and, once per outage per
// chat, tells the user Otto is away. When Otto comes back it drains the
// queue itself (POST /drain). Deploy steps: README.md next to this file.
//
//   POST /telegram  Telegram's webhook        X-Telegram-Bot-Api-Secret-Token
//   POST /drain     { ack?: update_id } -> queued updates left after the ack
//                                             Authorization: Bearer RELAY_SECRET
//
// Everything is one Durable Object instance, so the queue has one writer and
// a key per update_id: a retried webhook overwrites itself instead of queueing twice.

export type Env = {
  BOT_TOKEN: string
  /** Sent by Telegram on every webhook call; set with setWebhook's secret_token. */
  TELEGRAM_SECRET: string
  /** Shared with Otto (OTTO_RELAY_SECRET), both directions. */
  RELAY_SECRET: string
  /** Otto's POST /telegram route, through Tailscale Funnel. */
  OTTO_URL: string
  /** Comma-separated chat ids that get any response at all. */
  ALLOWED_CHATS: string
}

/** The slice of Durable Object storage the relay uses; tests pass an in-memory one. */
export type Storage = {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string | string[]): Promise<unknown>
  list<T>(opts: { prefix: string }): Promise<Map<string, T>>
}

type Update = { update_id: number; [k: string]: unknown }

export const FORWARD_MS = 5000
export const NOTICE = "otto's offline — got it, i'll answer when it's back"
const NOTIFIED = 'notified'

// Zero-padded so storage's lexical key order is update_id order.
const key = (id: number) => `u:${String(id).padStart(16, '0')}`

/** The chat an update belongs to, for the allowlist and the notice. */
export function chatOf(u: any): string | undefined {
  const id = u?.message?.chat?.id ?? u?.edited_message?.chat?.id ?? u?.callback_query?.from?.id
  return id === undefined ? undefined : String(id)
}

/** Constant-time string compare; an empty expected secret never matches. */
export async function same(got: string, want: string): Promise<boolean> {
  if (!want) return false
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([got, want].map(s => crypto.subtle.digest('SHA-256', enc.encode(s))))
  const x = new Uint8Array(a), y = new Uint8Array(b)
  let d = 0
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]
  return d === 0
}

async function queued(store: Storage): Promise<Update[]> {
  return [...(await store.list<Update>({ prefix: 'u:' })).values()]
}

/** Remove delivered updates. Otto took something, so the outage is over. */
async function settle(store: Storage, done: Update[]): Promise<void> {
  const keys = done.map(u => key(u.update_id))
  for (let i = 0; i < keys.length; i += 128) await store.delete(keys.slice(i, i + 128)) // DO caps a delete at 128 keys
  await store.delete(NOTIFIED)
}

async function forward(env: Env, batch: Update[], fetchFn: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchFn(env.OTTO_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RELAY_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(FORWARD_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function handle(req: Request, env: Env, store: Storage, fetchFn: typeof fetch = fetch): Promise<Response> {
  const path = new URL(req.url).pathname
  if (req.method !== 'POST') return new Response(null, { status: 405 })

  if (path === '/telegram') {
    if (!(await same(req.headers.get('x-telegram-bot-api-secret-token') ?? '', env.TELEGRAM_SECRET))) {
      return new Response(null, { status: 401 })
    }
    let u: Update
    try { u = await req.json() } catch { return new Response(null) }
    const chat = chatOf(u)
    const allowed = new Set((env.ALLOWED_CHATS ?? '').split(',').map(s => s.trim()).filter(Boolean))
    // Always 200 from here on: anything else makes Telegram retry the update.
    if (!Number.isSafeInteger(u?.update_id) || !chat || !allowed.has(chat)) return new Response(null)

    await store.put(key(u.update_id), u)
    const batch = await queued(store)
    if (await forward(env, batch, fetchFn)) {
      await settle(store, batch)
      return new Response(null)
    }
    const notified = (await store.get<string[]>(NOTIFIED)) ?? []
    if (!notified.includes(chat)) {
      await store.put(NOTIFIED, [...notified, chat])
      await fetchFn(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: NOTICE }),
      }).catch(() => {})
    }
    return new Response(null)
  }

  if (path === '/drain') {
    if (!(await same(req.headers.get('authorization') ?? '', `Bearer ${env.RELAY_SECRET}`))) {
      return new Response(null, { status: 401 })
    }
    const body = (await req.json().catch(() => ({}))) as { ack?: unknown }
    let all = await queued(store)
    if (typeof body.ack === 'number') {
      const acked = all.filter(u => u.update_id <= (body.ack as number))
      if (acked.length) await settle(store, acked)
      all = all.filter(u => u.update_id > (body.ack as number))
    }
    return Response.json(all)
  }

  return new Response(null, { status: 404 })
}

export class RelayQueue {
  constructor(private state: { storage: Storage }, private env: Env) {}
  fetch(req: Request): Promise<Response> {
    return handle(req, this.env, this.state.storage)
  }
}

export default {
  fetch(req: Request, env: Env & { RELAY: any }): Promise<Response> {
    return env.RELAY.get(env.RELAY.idFromName('queue')).fetch(req)
  },
}
