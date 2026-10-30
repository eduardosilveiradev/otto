import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WhatsApp, parseUpdates, describe, gate, renderButtons, matchButton, mediaKind, type WaMessage } from '../whatsapp.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-whatsapp-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const ME = 'user:1234567890'
const now = () => String(Math.floor(Date.now() / 1000))
const msg = (over: Partial<WaMessage> = {}): WaMessage => ({ from: ME, id: 'wamid.A', timestamp: now(), type: 'text', text: { body: 'hi' }, ...over })
const updates = (messages: unknown[], next = 7) => ({
  object: 'whatsapp_agent_platform',
  entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', contacts: [], messages, statuses: [{ id: 'x', status: 'read' }] } }] }],
  next_offset: next,
})

/** A fetch that answers from a queue and records every call. */
function mockFetch(responses: (() => Response)[]) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = responses.shift()
    if (!r) throw new Error(`unexpected fetch ${url}`)
    return r()
  }) as unknown as typeof fetch
  return { fn, calls }
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('parseUpdates keeps well-formed messages and next_offset, drops statuses and junk', () => {
  const r = parseUpdates(updates([msg(), { from: ME }, null], 42))
  expect(r.messages.map(m => m.id)).toEqual(['wamid.A'])
  expect(r.nextOffset).toBe(42)
  expect(parseUpdates(null)).toEqual({ messages: [] })
  expect(parseUpdates({ entry: 'x' }).messages).toEqual([])
})

test('describe turns each message type into what the session sees', () => {
  expect(describe(msg())).toEqual({ kind: 'text', text: 'hi', meta: { message_id: 'wamid.A' } })
  expect(describe(msg({ text: { body: '  ' } }))).toBeNull()
  expect(describe(msg({ type: 'unknown' }))).toBeNull()

  const quoted = describe(msg({ context: { id: 'wamid.Q', from: 'agent:9' } }))!
  expect(quoted.meta).toMatchObject({ reply_to_id: 'wamid.Q', reply_to_from: 'otto' })

  const photo = describe(msg({ type: 'image', image: { id: 'm1', mime_type: 'image/jpeg', caption: 'look' } }))!
  expect(photo).toMatchObject({ kind: 'photo', text: 'look', media: { id: 'm1', ext: 'jpg' } })
  expect(describe(msg({ type: 'image', image: { id: 'm1', mime_type: 'image/png' } }))!.text).toBe('(photo)')

  const voice = describe(msg({ type: 'audio', audio: { id: 'm2', mime_type: 'audio/ogg; codecs=opus', voice: true } }))!
  expect(voice).toMatchObject({ kind: 'voice', text: '(voice message)', media: { id: 'm2', ext: 'ogg' } })
  expect(describe(msg({ type: 'audio', audio: { id: 'm3', mime_type: 'audio/mpeg' } }))!.kind).toBe('audio')

  const doc = describe(msg({ type: 'document', document: { id: 'm4', mime_type: 'application/x-thing', filename: '../../a/report.xyz' } }))!
  expect(doc).toMatchObject({ kind: 'document', text: '(document: report.xyz)', media: { ext: 'xyz' }, meta: { attachment_name: 'report.xyz' } })

  const react = describe(msg({ type: 'reaction', reaction: { message_id: 'wamid.O', emoji: '👍' } }))!
  expect(react).toMatchObject({ kind: 'reaction', text: '👍', meta: { reaction: '1', reply_to_id: 'wamid.O' } })
  expect(describe(msg({ type: 'reaction', reaction: { message_id: 'wamid.O', emoji: '' } }))).toBeNull()
})

test('gate pairs the first sender and refuses everyone after', () => {
  const s: { owner?: string } = {}
  expect(gate(s, ME)).toBe(true)
  expect(s.owner).toBe(ME)
  expect(gate(s, 'user:999')).toBe(false)
  expect(gate(s, ME)).toBe(true)
})

test('buttons render as numbered choices, and a reply naming one is the tap', () => {
  const buttons = [{ label: 'send ✓', data: 'send draft 3' }, { label: 'discard', data: 'discard draft 3' }, { label: 'open', url: 'https://example.com' }]
  expect(renderButtons('draft ready', buttons)).toBe('draft ready\n\n1. send ✓   2. discard\nopen: https://example.com')
  expect(renderButtons('x', [])).toBe('x')
  expect(matchButton(buttons, '1')?.data).toBe('send draft 3')
  expect(matchButton(buttons, 'Send')?.data).toBe('send draft 3')
  expect(matchButton(buttons, 'DISCARD ')?.data).toBe('discard draft 3')
  expect(matchButton(buttons, '3')).toBeNull()
  expect(matchButton(buttons, 'send it now')).toBeNull()
  expect(matchButton(buttons, '👍')).toBeNull()
})

test('mediaKind picks the message type and MIME from the extension', () => {
  expect(mediaKind('/x/a.jpg')).toEqual({ type: 'image', mime: 'image/jpeg' })
  expect(mediaKind('/x/a.ogg')).toEqual({ type: 'audio', mime: 'audio/ogg' })
  expect(mediaKind('/x/a.mp4')).toEqual({ type: 'video', mime: 'video/mp4' })
  expect(mediaKind('/x/a.pdf')).toEqual({ type: 'document', mime: 'application/pdf' })
  expect(mediaKind('/x/a.zip')).toEqual({ type: 'document', mime: 'application/octet-stream' })
})

test('a poll delivers gated messages, skips the first-run backlog, and saves the offset and owner', async () => {
  const file = join(tmp, 'poll.json')
  const old = String(Math.floor(Date.now() / 1000) - 3600)
  const { fn, calls } = mockFetch([
    json(updates([msg({ id: 'wamid.OLD', timestamp: old }), msg({ id: 'wamid.1' }), msg({ id: 'wamid.X', from: 'user:999' })], 10)),
    () => new Response(null, { status: 204 }),
  ])
  const wa = new WhatsApp('tok', file, fn)
  const got: string[] = []
  await wa.pollOnce(async m => { got.push(m.id) })
  expect(got).toEqual(['wamid.1'])
  expect(calls[0].url).toContain('offset=0')
  expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ offset: 10, owner: ME })
  // A 204 carries no offset: the next poll reuses it.
  await wa.pollOnce(async m => { got.push(m.id) })
  expect(calls[1].url).toContain('offset=10')
})

test('a restart resumes from the saved offset and delivers old-but-unseen messages', async () => {
  const file = join(tmp, 'resume.json')
  writeFileSync(file, JSON.stringify({ offset: 5, owner: ME }))
  const old = String(Math.floor(Date.now() / 1000) - 3600)
  const { fn, calls } = mockFetch([json(updates([msg({ id: 'wamid.LATE', timestamp: old })], 6))])
  const got: string[] = []
  await new WhatsApp('tok', file, fn).pollOnce(async m => { got.push(m.id) })
  expect(calls[0].url).toContain('offset=5')
  expect(got).toEqual(['wamid.LATE'])
})

test('sendText chunks under 4096, quotes on the first part only, and replies to the latest sender', async () => {
  const file = join(tmp, 'send.json')
  writeFileSync(file, JSON.stringify({ offset: 1, owner: ME }))
  const { fn, calls } = mockFetch([
    json({ messages: [{ id: 'wamid.o1' }] }),
    json({ messages: [{ id: 'wamid.o2' }] }),
  ])
  const wa = new WhatsApp('tok', file, fn)
  const ids = await wa.sendText('a'.repeat(4000) + '\n\n' + 'b'.repeat(1000), 'wamid.Q')
  expect(ids).toEqual(['wamid.o1', 'wamid.o2'])
  const bodies = calls.map(c => JSON.parse(String(c.init?.body)))
  expect(bodies.map(b => b.text.body.length)).toEqual([4000, 1000])
  expect(bodies[0]).toMatchObject({ messaging_product: 'whatsapp', to: ME, type: 'text', context: { message_id: 'wamid.Q' } })
  expect(bodies[1].context).toBeUndefined()
})

test('a send retries a 429, and refuses without a chat', async () => {
  const file = join(tmp, 'retry.json')
  writeFileSync(file, JSON.stringify({ offset: 1, owner: ME }))
  const { fn, calls } = mockFetch([
    json({ error: { code: 130429, message: 'slow down' } }, 429),
    json({ messages: [{ id: 'wamid.ok' }] }),
  ])
  expect(await new WhatsApp('tok', file, fn).sendText('hi')).toEqual(['wamid.ok'])
  expect(calls.length).toBe(2)
  await expect(new WhatsApp('tok', join(tmp, 'none.json'), mockFetch([]).fn).sendText('hi')).rejects.toThrow('no WhatsApp chat yet')
}, 10_000)

test('a 500 on send is not retried — it may have landed', async () => {
  const file = join(tmp, 'five.json')
  writeFileSync(file, JSON.stringify({ offset: 1, owner: ME }))
  const { fn, calls } = mockFetch([json({ error: { code: 2, message: 'boom' } }, 500)])
  await expect(new WhatsApp('tok', file, fn).sendText('hi')).rejects.toThrow('HTTP 500 (#2) boom')
  expect(calls.length).toBe(1)
})

test('download looks up the media url, then fetches it into the inbox', async () => {
  const file = join(tmp, 'dl.json')
  const { fn, calls } = mockFetch([
    json({ url: 'https://lookaside.example/media/m1/content', mime_type: 'image/jpeg' }),
    () => new Response(new Uint8Array([1, 2, 3])),
  ])
  const path = await new WhatsApp('tok', file, fn).download('m1', 'jpg', join(tmp, 'inbox'))
  expect(path.startsWith(join(tmp, 'inbox'))).toBe(true)
  expect(path.endsWith('.jpg')).toBe(true)
  expect([...readFileSync(path)]).toEqual([1, 2, 3])
  expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok')
})
