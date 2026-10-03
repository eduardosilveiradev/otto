import { test, expect } from 'bun:test'
import {
  decideSend,
  recordSend,
  recordSuppressed,
  pruneTopics,
  similarity,
  tokens,
  resolveKey,
  explain,
  type TopicState,
} from '../topics'

const T0 = Date.parse('2026-08-11T09:00:00Z')
const min = (n: number) => n * 60 * 1000
const hr = (n: number) => n * 60 * min(1)

test('tokens keep digits and drop stopwords and urls', () => {
  const t = tokens('The Enel bill is €84.30 due on the 14th https://enel.it/pay')
  expect(t.has('enel')).toBe(true)
  expect(t.has('84')).toBe(true)
  expect(t.has('30')).toBe(true)
  expect(t.has('the')).toBe(false)
  expect(t.has('is')).toBe(false)
  expect([...t].some(x => x.includes('http'))).toBe(false)
})

test('similarity is 1 for identical text and low for unrelated text', () => {
  expect(similarity('bill from Enel due Friday', 'bill from Enel due Friday')).toBe(1)
  expect(similarity('bill from Enel due Friday', 'your flight to Munich is delayed')).toBeLessThan(0.15)
})

test('key falls back to src, then to unattributed', () => {
  expect(resolveKey({ text: 'x', key: 'Bill:Enel' })).toBe('bill:enel')
  expect(resolveKey({ text: 'x', src: 'trigger:bills' })).toBe('trigger:bills')
  expect(resolveKey({ text: 'x' })).toBe('unattributed')
})

test('a new topic always sends', () => {
  const d = decideSend({}, { text: 'Enel bill €84.30 due Friday', src: 'trigger:bills' }, { now: T0 })
  expect(d.action).toBe('send')
  expect(d).toMatchObject({ why: 'new-topic', key: 'trigger:bills' })
})

test('the restart burst collapses to one send', () => {
  // Five triggers come due at once after downtime, all about the same invoice.
  let state: TopicState = {}
  const texts = [
    'Enel bill €84.30 is due Friday',
    'Reminder: Enel bill due Friday, €84.30',
    'The Enel invoice (€84.30) comes due on Friday',
    'Enel: €84.30 due Friday',
    'Heads up, Enel bill €84.30 Friday',
  ]
  const results = texts.map((text, i) => {
    const at = T0 + i * 1000 // all within a couple of seconds
    const d = decideSend(state, { text, src: 'trigger:bills' }, { now: at })
    if (d.action === 'send') state = recordSend(state, d.key, text, { now: at })
    else state = recordSuppressed(state, d.key)
    return d.action
  })
  expect(results[0]).toBe('send')
  expect(results.slice(1)).toEqual(['suppress', 'suppress', 'suppress', 'suppress'])
  expect(state['trigger:bills'].sends).toBe(1)
  expect(state['trigger:bills'].suppressed).toBe(4)
})

test('a burst of genuinely different news is not suppressed', () => {
  let state: TopicState = {}
  const first = 'Enel bill €84.30 is due Friday'
  state = recordSend(state, 'email-scan', first, { now: T0 })
  const d = decideSend(
    state,
    { text: 'Your flight LIS-EZE tomorrow moved to gate 24', src: 'email-scan' },
    { now: T0 + 5000 },
  )
  expect(d.action).toBe('send')
})

test('the same news reworded inside the window is suppressed', () => {
  let state: TopicState = {}
  state = recordSend(state, 'trigger:bills', 'Enel bill €84.30 is due Friday', { now: T0 })
  const d = decideSend(
    state,
    { text: 'The Enel bill of €84.30 is due on Friday', src: 'trigger:bills' },
    { now: T0 + hr(3) },
  )
  expect(d.action).toBe('suppress')
  expect(d).toMatchObject({ why: 'unchanged' })
})

test('a changed amount is material and goes out', () => {
  let state: TopicState = {}
  state = recordSend(state, 'trigger:bills', 'Enel bill €84.30 is due Friday', { now: T0 })
  const d = decideSend(
    state,
    { text: 'Enel bill €112.00 is due Friday', src: 'trigger:bills' },
    { now: T0 + hr(3) },
  )
  expect(d.action).toBe('send')
  expect(d).toMatchObject({ why: 'changed' })
})

test('outside the window the topic is fair game again', () => {
  let state: TopicState = {}
  state = recordSend(state, 'trigger:bills', 'Enel bill €84.30 is due Friday', { now: T0 })
  const d = decideSend(
    state,
    { text: 'Enel bill €84.30 is due Friday', src: 'trigger:bills' },
    { now: T0 + hr(7) },
  )
  expect(d.action).toBe('send')
  expect(d).toMatchObject({ why: 'stale-topic' })
})

test('urgent is never suppressed, even mid-burst', () => {
  let state: TopicState = {}
  state = recordSend(state, 'trigger:bills', 'Enel bill €84.30 is due Friday', { now: T0 })
  const d = decideSend(
    state,
    { text: 'Enel bill €84.30 is due Friday', src: 'trigger:bills', priority: 'urgent' },
    { now: T0 + 1000 },
  )
  expect(d.action).toBe('send')
  expect(d).toMatchObject({ why: 'urgent' })
})

test('changed news can edit the live message in place when allowed', () => {
  let state: TopicState = {}
  state = recordSend(state, 'match:munich', 'Munich 0-0 Inter, 12th minute', { now: T0, messageId: 4242 })
  const d = decideSend(
    state,
    { text: 'Munich 1-0 Inter, Leao 31st minute', key: 'match:munich' },
    { now: T0 + min(20), canReplace: true },
  )
  expect(d.action).toBe('replace')
  expect(d).toMatchObject({ messageId: 4242 })
})

test('replace is not offered when the message id is unknown', () => {
  let state: TopicState = {}
  state = recordSend(state, 'match:munich', 'Munich 0-0 Inter, 12th minute', { now: T0 })
  const d = decideSend(
    state,
    { text: 'Munich 1-0 Inter, Leao 31st minute', key: 'match:munich' },
    { now: T0 + min(20), canReplace: true },
  )
  expect(d.action).toBe('send')
})

test('recordSend keeps a known message id when a later send omits it', () => {
  let state: TopicState = {}
  state = recordSend(state, 'k', 'first', { now: T0, messageId: 7 })
  state = recordSend(state, 'k', 'second', { now: T0 + min(1) })
  expect(state.k.lastMessageId).toBe(7)
  expect(state.k.sends).toBe(2)
})

test('distinct keys never suppress each other', () => {
  let state: TopicState = {}
  const text = 'Something is due on Friday'
  state = recordSend(state, 'trigger:bills', text, { now: T0 })
  const d = decideSend(state, { text, src: 'trigger:permesso' }, { now: T0 + 1000 })
  expect(d.action).toBe('send')
})

test('pruning drops topics older than the retention window', () => {
  let state: TopicState = {}
  state = recordSend(state, 'old', 'x', { now: T0 - hr(24 * 20) })
  state = recordSend(state, 'fresh', 'y', { now: T0 })
  state = pruneTopics(state, T0)
  expect(Object.keys(state)).toEqual(['fresh'])
})

test('explain says why in one line', () => {
  const d = decideSend(
    recordSend({}, 'trigger:bills', 'Enel bill €84.30 due Friday', { now: T0 }),
    { text: 'Enel bill €84.30 due Friday', src: 'trigger:bills' },
    { now: T0 + min(30) },
  )
  expect(explain(d)).toBe('topic trigger:bills: suppressed (unchanged, said 30m ago)')
})
