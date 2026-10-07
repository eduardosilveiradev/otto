import { describe, expect, test } from 'bun:test'
import { handle, chatOf, same, NOTICE, type Env, type Storage } from './worker.ts'

const env: Env = {
  BOT_TOKEN: 'bot-token',
  TELEGRAM_SECRET: 'tg-secret',
  RELAY_SECRET: 'relay-secret',
  OTTO_URL: 'https://otto.example/telegram',
  ALLOWED_CHATS: '1234567890, 42',
}

function memStore(): Storage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>()
  return {
    map,
    async get(k) { return map.get(k) as any },
    async put(k, v) { map.set(k, structuredClone(v)) },
    async delete(k) { for (const x of [k].flat()) map.delete(x) },
    async list({ prefix }) {
      return new Map([...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))) as any
    },
  }
}

/** A fake network: Otto answers `otto()`, every call is recorded. */
function net(otto: () => Response | Promise<Response>) {
  const calls: { url: string; body: any }[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return String(url) === env.OTTO_URL ? otto() : new Response('{}')
  }) as unknown as typeof fetch
  return { calls, fetchFn, otto: () => calls.filter(c => c.url === env.OTTO_URL), notices: () => calls.filter(c => c.url.includes('sendMessage')) }
}

const msg = (update_id: number, chat = 1234567890) => ({ update_id, message: { chat: { id: chat }, text: `m${update_id}` } })

const tg = (u: unknown, secret = env.TELEGRAM_SECRET) =>
  new Request('https://relay.example/telegram', {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(u),
  })

const drain = (body: unknown, secret = env.RELAY_SECRET) =>
  new Request('https://relay.example/drain', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  })

describe('relay', () => {
  test('auth: wrong Telegram secret is refused before anything is stored', async () => {
    const s = memStore()
    const n = net(() => new Response(null, { status: 204 }))
    expect((await handle(tg(msg(1), 'nope'), env, s, n.fetchFn)).status).toBe(401)
    expect((await handle(tg(msg(1), ''), { ...env, TELEGRAM_SECRET: '' }, s, n.fetchFn)).status).toBe(401)
    expect(s.map.size).toBe(0)
    expect(n.calls).toHaveLength(0)
  })

  test('auth: drain needs the relay secret', async () => {
    const s = memStore()
    expect((await handle(drain({}, 'nope'), env, s)).status).toBe(401)
  })

  test('chats off the allowlist are dropped silently, with a 200', async () => {
    const s = memStore()
    const n = net(() => new Response(null, { status: 503 }))
    const res = await handle(tg(msg(1, 999)), env, s, n.fetchFn)
    expect(res.status).toBe(200)
    expect(n.calls).toHaveLength(0)
    expect(s.map.size).toBe(0)
  })

  test('Otto up: forwarded and nothing stays queued', async () => {
    const s = memStore()
    const n = net(() => new Response(null, { status: 204 }))
    expect((await handle(tg(msg(7)), env, s, n.fetchFn)).status).toBe(200)
    expect(n.otto()[0].body.map((u: any) => u.update_id)).toEqual([7])
    expect([...s.map.keys()].filter(k => k.startsWith('u:'))).toHaveLength(0)
    expect(n.notices()).toHaveLength(0)
  })

  test('Otto down: queued, one notice per outage per chat, retries deduped', async () => {
    const s = memStore()
    const n = net(() => new Response(null, { status: 502 }))
    await handle(tg(msg(10)), env, s, n.fetchFn)
    await handle(tg(msg(10)), env, s, n.fetchFn) // Telegram retry: same update_id
    await handle(tg(msg(11)), env, s, n.fetchFn)
    await handle(tg(msg(12, 42)), env, s, n.fetchFn)
    expect(n.notices().map(c => c.body)).toEqual([
      { chat_id: '1234567890', text: NOTICE },
      { chat_id: '42', text: NOTICE },
    ])
    const left = await (await handle(drain({}), env, s)).json()
    expect(left.map((u: any) => u.update_id)).toEqual([10, 11, 12])
  })

  test('queue forwards oldest first, across digit-count boundaries', async () => {
    const s = memStore()
    let up = false
    const n = net(() => new Response(null, { status: up ? 204 : 502 }))
    for (const id of [100, 99, 1000]) await handle(tg(msg(id)), env, s, n.fetchFn)
    up = true
    await handle(tg(msg(1001)), env, s, n.fetchFn)
    expect(n.otto().at(-1)!.body.map((u: any) => u.update_id)).toEqual([99, 100, 1000, 1001])
  })

  test('a hung Otto counts as down', async () => {
    const s = memStore()
    const n = net(() => Promise.reject(new DOMException('timeout', 'TimeoutError')))
    await handle(tg(msg(5)), env, s, n.fetchFn)
    expect(n.notices()).toHaveLength(1)
  })

  test('drain acks in order and ends the outage', async () => {
    const s = memStore()
    const n = net(() => new Response(null, { status: 502 }))
    for (const id of [1, 2, 3]) await handle(tg(msg(id)), env, s, n.fetchFn)
    expect((await (await handle(drain({ ack: 2 }), env, s)).json()).map((u: any) => u.update_id)).toEqual([3])
    // The outage ended with the ack, so the next failure notifies again.
    await handle(tg(msg(4)), env, s, n.fetchFn)
    expect(n.notices()).toHaveLength(2)
    // An empty drain acks nothing and leaves the notice flag alone.
    await handle(drain({}), env, s)
    await handle(tg(msg(5)), env, s, n.fetchFn)
    expect(n.notices()).toHaveLength(2)
  })

  test('chatOf covers messages, edits and button taps', () => {
    expect(chatOf(msg(1))).toBe('1234567890')
    expect(chatOf({ update_id: 1, edited_message: { chat: { id: 5 } } })).toBe('5')
    expect(chatOf({ update_id: 1, callback_query: { from: { id: 6 } } })).toBe('6')
    expect(chatOf({ update_id: 1, my_chat_member: {} })).toBeUndefined()
  })

  test('same() compares exactly', async () => {
    expect(await same('a', 'a')).toBe(true)
    expect(await same('a', 'ab')).toBe(false)
    expect(await same('', '')).toBe(false)
  })
})
