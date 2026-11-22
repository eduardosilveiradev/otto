import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { candidates, due, offer, unsubscribe, applyTap, loadSweep, saveSweep, validateUrl, readMessages, type Message, type SweepState } from '../unsubscribe.ts'
import { validateCard } from '../cards.ts'
const now = Date.parse('2026-11-02T12:00:00Z')
const empty = (): SweepState => ({ offers: {}, outcomes: {} })
const mails = (sender = 'news@example.com', n = 4): Message[] => Array.from({ length: n }, (_, i) => ({ id: `${sender}-${i}`, from: `Newsletter <${sender}>`, at: now - i * 86400000, unread: true, unsubscribe: '<mailto:leave@example.com>, <https://example.com/unsubscribe?token=abc>', post: '' }))
const row = () => candidates(mails(), empty(), now)[0]
test('only senders with at least four recent messages, all unread, and a header qualify', () => {
  expect(candidates(mails(), empty(), now)).toHaveLength(1)
  const read = mails(); read[0].unread = false; read[0].unsubscribe = ''
  expect(candidates(read, empty(), now)).toEqual([])
  expect(candidates(mails('small@example.com', 3), empty(), now)).toEqual([])
  expect(candidates(mails().map(m => ({ ...m, unsubscribe: '' })), empty(), now)).toEqual([])
  expect(candidates(mails().map(m => ({ ...m, at: now - 61 * 86400000 })), empty(), now)).toEqual([])
  expect(candidates([...mails(), ...mails()], empty(), now)[0].count).toBe(4)
})
test('first weekday from 11 local, once per month', () => {
  expect(due(empty(), new Date(2026, 10, 1, 12))).toBe(false)
  expect(due(empty(), new Date(2026, 10, 2, 10, 59))).toBe(false)
  expect(due(empty(), new Date(2026, 10, 2, 11))).toBe(true)
  expect(due({ ...empty(), month: '2026-11' }, new Date(2026, 10, 2, 12))).toBe(false)
  expect(due(empty(), new Date(2026, 10, 3, 12))).toBe(false)
})
test('one-click prefers POST; plain unsubscribe GET; mailto and ambiguous links stay manual', async () => {
  const calls: unknown[] = [], send = async (...args: unknown[]) => { calls.push(args) }
  expect(await unsubscribe({ ...row(), post: 'List-Unsubscribe=One-Click' }, send)).toBe('unsubscribed')
  expect(calls.pop()).toEqual(['https://example.com/unsubscribe?token=abc', 'POST'])
  expect(await unsubscribe(row(), send)).toBe('unsubscribed')
  expect(calls.pop()).toEqual(['https://example.com/unsubscribe?token=abc', 'GET'])
  for (const url of ['mailto:leave@example.com', 'https://example.com/preferences', 'https://example.com/unsubscribe?next=https://example.com']) {
    expect(await unsubscribe({ ...row(), unsubscribe: `<${url}>` }, send)).toBe('manual')
  }
  expect(calls).toEqual([])
})
test('reject non-HTTPS, credentials, private addresses and local hosts before sending', async () => {
  for (const url of ['http://example.com/unsubscribe', 'https://127.0.0.1/unsubscribe', 'https://10.0.0.1/', 'https://192.168.0.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://localhost/', 'https://mail.internal/', 'https://user:pass@example.com/', 'https://example.com:444/']) {
    expect(() => validateUrl(url)).toThrow()
    expect(await unsubscribe({ ...row(), post: 'List-Unsubscribe=One-Click', unsubscribe: `<${url}>` }, async () => { throw new Error('must not send') })).toBe('manual')
  }
  expect(validateUrl('https://example.com/unsubscribe').hostname).toBe('example.com')
})
test('persisted taps survive reloads; outcomes suppress future offers; keep lasts 180 days', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsubscribe-'))
  try {
    for (const action of ['unsubscribe', 'dismiss', 'keep']) {
      const state = empty(), o = offer(state, [row()])!
      saveSweep(dir, state)
      const data = o.buttons.find(b => b.data.includes(` ${action} 0`))!.data
      let sent = 0
      const send = async () => { sent++ }
      await applyTap(dir, data, send, now)
      await applyTap(dir, data, send, now)
      expect(sent).toBe(action === 'unsubscribe' ? 1 : 0)
      const saved = loadSweep(dir)
      expect(candidates(mails(), saved, now)).toEqual([])
      const later = now + 180 * 86400000
      expect(candidates(mails().map(m => ({ ...m, at: later })), saved, later)).toHaveLength(action === 'keep' ? 1 : 0)
    }
    expect(await applyTap(dir, 'newsletter deadbeef unsubscribe all')).toContain('expired')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('unsubscribe all records manual and failed outcomes without email or repeat attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsubscribe-'))
  try {
    const state = empty(), o = offer(state, [row(), { ...row(), sender: 'manual@example.com', unsubscribe: '<mailto:leave@example.com>' }])!
    saveSweep(dir, state)
    const data = o.buttons.at(-1)!.data
    let sent = 0
    const send = async () => { sent++; throw new Error('offline') }
    expect(await applyTap(dir, data, send, now)).toContain('needs a manual unsubscribe')
    await applyTap(dir, data, send, now)
    expect(sent).toBe(1)
    expect(loadSweep(dir).outcomes['manual@example.com'].status).toBe('manual')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('offer caps senders, validates card, bounds labels and callback bytes for long Unicode names', () => {
  const rows = candidates(Array.from({ length: 12 }, (_, i) => mails(`newsletter${i}@example.com`)).flat().map(m => ({ ...m, from: '週刊ニュース '.repeat(30) + m.from })), empty(), now)
  const o = offer(empty(), rows)!
  expect(rows).toHaveLength(8)
  expect(validateCard(o.card).ok).toBe(true)
  expect(o.buttons.every(b => Buffer.byteLength(b.data) <= 60)).toBe(true)
  expect(offer(empty(), [])).toBeNull()
})
test('Gmail path reads every page and metadata without UNREAD filtering or writes; failed metadata aborts', async () => {
  const calls: string[][] = []
  const exec = async (cmd: string[]) => {
    calls.push(cmd)
    if (cmd.includes('search')) return JSON.stringify({ messages: [{ id: 'abc' }] })
    return JSON.stringify({ message: { internalDate: String(now), labelIds: ['UNREAD'], payload: { headers: [{ name: 'From', value: 'news@example.com' }, { name: 'List-Unsubscribe', value: '<https://example.com/unsubscribe>' }] } } })
  }
  expect((await readMessages('you@example.com', exec))[0].unread).toBe(true)
  expect(calls[0]).toContain('--all')
  expect(calls[0]).toContain('newer_than:60d')
  expect(calls[1]).toContain('metadata')
  expect(calls.flat().some(x => /send|draft|modify|is:unread/.test(x))).toBe(false)
  await expect(readMessages('you@example.com', async cmd => cmd.includes('search') ? '{"messages":[{"id":"abc"}]}' : undefined)).rejects.toThrow()
})
test('HTTPS transport sends the one-click body and rejects redirects and private DNS answers', async () => {
  const { fetchUnsubscribe } = await import('../unsubscribe.ts')
  const { EventEmitter } = await import('events')
  const { request } = await import('https')
  let body: unknown, options: any
  let status = 204
  const connect = ((_url: URL, opts: any, callback: Function) => {
    options = opts
    const req = new EventEmitter() as any
    req.destroy = (err: Error) => req.emit('error', err)
    req.end = (data: unknown) => {
      body = data
      callback({ statusCode: status, destroy() {} })
      req.emit('close')
    }
    return req
  }) as unknown as typeof request
  await fetchUnsubscribe('https://example.com/unsubscribe', 'POST', connect)
  expect(body).toBe('List-Unsubscribe=One-Click')
  expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
  await new Promise<void>(resolve => options.lookup('localhost', {}, (error: Error) => { expect(error.message).toContain('Private'); resolve() }))
  await fetchUnsubscribe('https://example.com/unsubscribe', 'GET', connect)
  expect(body).toBeUndefined()
  status = 302
  await expect(fetchUnsubscribe('https://example.com/unsubscribe', 'GET', connect)).rejects.toThrow('manual redirect')
})
