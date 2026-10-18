import { expect, test } from 'bun:test'
import { ChatFeed, type ChatEntry } from '../chatfeed.ts'

const e = (chat_id: string, text = 'x'): ChatEntry => ({ ts: '2026-03-15T11:00:00.000Z', dir: 'out', chat_id, kind: 'text', text })
const settled = (p: Promise<void>) => Promise.race([p.then(() => true), Bun.sleep(100).then(() => false)])

test('push numbers entries and since filters by cursor and chat', () => {
  const f = new ChatFeed()
  f.push(e('app', 'a')); f.push(e('1234567890')); f.push(e('app', 'c'))
  expect(f.seq).toBe(3)
  expect(f.since(0, 'app').map(x => x.text)).toEqual(['a', 'c'])
  expect(f.since(1, 'app').map(x => x.text)).toEqual(['c'])
  expect(f.since(3, 'app')).toEqual([])
})

test('the ring keeps the newest 200', () => {
  const f = new ChatFeed()
  for (let i = 1; i <= 250; i++) f.push(e('app', String(i)))
  const kept = f.since(0, 'app')
  expect(kept.length).toBe(200)
  expect(kept[0].text).toBe('51')
})

test('wait resolves on a push', async () => {
  const f = new ChatFeed()
  const w = f.wait(5000)
  f.push(e('app'))
  expect(await settled(w)).toBe(true)
})

test('wait resolves on a typing change, not on the same state', async () => {
  const f = new ChatFeed()
  const w = f.wait(5000)
  f.setTyping(false)
  expect(await settled(w)).toBe(false)
  f.setTyping(true)
  expect(await settled(w)).toBe(true)
})

test('wait resolves on timeout and on abort', async () => {
  const f = new ChatFeed()
  expect(await settled(f.wait(10))).toBe(true)
  const ac = new AbortController()
  const w = f.wait(5000, ac.signal)
  ac.abort()
  expect(await settled(w)).toBe(true)
})

test('claim is true once per id and forgets after 500', () => {
  const f = new ChatFeed()
  expect(f.claim('a')).toBe(true)
  expect(f.claim('a')).toBe(false)
  for (let i = 0; i < 500; i++) f.claim(`id${i}`)
  expect(f.claim('a')).toBe(true)
})
