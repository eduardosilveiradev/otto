/**
 * Pairing a native app by code, end to end against a real server (apptwin.ts): a client with no
 * token starts it, the already-paired app claims the code and taps approve, and the new token
 * opens the app socket. Nothing an unpaired client can do alone gets it a token.
 */
import { test, expect, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { startTwin, phone, type Twin } from './apptwin.ts'

let t: Twin
afterAll(async () => { await t?.stop().catch(() => {}) })
const dash = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${t.url}/app/dash/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const tokens = () => (JSON.parse(readFileSync(join(t.state, 'app-tokens.json'), 'utf8')).tokens as { id: string; name: string; scope?: string; origin?: string; expires?: string }[])

test('a Mac with no token pairs by code: the paired phone approves, the token is collected once and opens the socket', async () => {
  t = await startTwin()
  expect(await (await dash('ping')).json()).toMatchObject({ ok: true, native: true })

  const { device_code, user_code } = await (await dash('pair/start', { client: 'native', label: 'Otto for Mac' })).json()
  expect(tokens()).toHaveLength(1)   // the phone's own; starting mints nothing

  // The owner types the code on the device they already hold; the session never sees it.
  const p = await phone(t)
  p.send({ type: 'message', id: 'pair-claim', text: `pair ${user_code}` })
  const offer = await p.until(f => f.type === 'message' && /^App pairing/.test(f.text))
  expect(offer.text).toContain('a Mac app claiming to be "Otto for Mac"')
  expect(offer.text).toContain('full access')
  expect(offer.buttons.map((b: any) => b.label)).toEqual(['approve full access', 'deny'])
  expect(t.delivered).toHaveLength(0)

  await Bun.sleep(2600)
  expect(await (await dash('pair/poll', { device_code })).json()).toEqual({ status: 'pending' })
  p.send({ type: 'tap', op: 'pair-tap', id: offer.id, data: offer.buttons[0].data, label: offer.buttons[0].label })
  expect(await p.until(f => f.type === 'ack' && f.id === 'pair-tap')).toBeTruthy()
  expect(await p.until(f => f.type === 'message' && f.text.startsWith('paired ✓'))).toBeTruthy()
  expect(t.delivered).toHaveLength(0)   // the nonce and the approval never reach the session
  expect(tokens()).toHaveLength(1)

  await Bun.sleep(2600)
  const got = await (await dash('pair/poll', { device_code })).json()
  expect(Object.keys(got).sort()).toEqual(['id', 'status', 'token'])
  const made = tokens().find(x => x.id === got.id)!
  expect(made).toMatchObject({ name: 'Otto for Mac' })
  expect([made.scope, made.origin, made.expires]).toEqual([undefined, undefined, undefined])

  // It is a native token: the socket and the native routes take it.
  const mac = await phone({ ...t, token: got.token })
  expect(await mac.until(f => f.type === 'hello')).toMatchObject({ acks: true })
  expect((await fetch(`${t.url}/app/history`, { headers: { authorization: `Bearer ${got.token}` } })).status).toBe(200)

  await Bun.sleep(2600)
  expect(await (await dash('pair/poll', { device_code })).json()).toEqual({ status: 'expired' })
  expect(tokens()).toHaveLength(2)
}, 90000)

test('an unpaired client alone gets nothing: no claim without the owner, no native pairing from a page', async () => {
  const { device_code, user_code } = await (await dash('pair/start', { client: 'native' })).json()
  await Bun.sleep(2600)
  expect(await (await dash('pair/poll', { device_code })).json()).toEqual({ status: 'pending' })
  // A request that carries an Origin is a browser's: refused before it can ask for a native token.
  expect((await dash('pair/start', { client: 'native' }, { origin: 'https://app.example.com' })).status).toBe(403)
  // The claim is the owner's message on a paired device; the dashboard's chat door refuses pairing text outright,
  // and there is no unauthenticated way to say `pair <code>` at all.
  expect((await dash('chat', { thread: 'app', id: 'abcdefgh1234', text: `pair ${user_code}` })).status).toBe(401)
  expect((await fetch(`${t.url}/app/ask`, { method: 'POST', body: JSON.stringify({ id: 'x1', text: `pair ${user_code}`, via: 'siri' }) })).status).toBe(401)
  await Bun.sleep(2600)
  expect(await (await dash('pair/poll', { device_code })).json()).toEqual({ status: 'pending' })
  expect(tokens()).toHaveLength(2)
}, 60000)
