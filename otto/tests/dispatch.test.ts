import { test, expect } from 'bun:test'
import { dispatchTap, runChores, every, gateFor, type Tap, type Gate } from '../dispatch.ts'

type Ctx = { log: string[] }
const taps: Record<string, Tap<Ctx>> = {
  offer: {
    match: /^take offer ([a-f0-9]+)$/,
    offered: { check: m => m[1] === 'abc', stale: 'that offer is gone' },
    run: (m, c) => { c.log.push(`took ${m[1]}`); return 'taken' },
  },
  maybe: {
    match: /^maybe /,
    offered: { inRun: 'returns null when it is not ours' },
    run: (_, c) => { c.log.push('maybe'); return null },
  },
  exact: {
    match: 'exact words',
    offered: { inRun: 'harmless' },
    run: async () => 'exact',
  },
  fallback: {
    match: /^maybe later$/,
    offered: { inRun: 'harmless' },
    run: () => 'later',
  },
}

test('a tap the server did not offer runs nothing and says why', async () => {
  const c = { log: [] as string[] }
  expect(await dispatchTap(taps, 'take offer abc', c)).toBe('taken')
  expect(await dispatchTap(taps, 'take offer def', c)).toBe('that offer is gone')
  expect(c.log).toEqual(['took abc'])
})

test('a row that returns null passes the tap on, and unmatched data goes to the session', async () => {
  const c = { log: [] as string[] }
  expect(await dispatchTap(taps, 'maybe later', c)).toBe('later')
  expect(c.log).toEqual(['maybe'])
  expect(await dispatchTap(taps, 'maybe never', c)).toBeNull()
  expect(await dispatchTap(taps, 'something else', c)).toBeNull()
})

test('a string match is the whole data, not a prefix', async () => {
  expect(await dispatchTap(taps, 'exact words', { log: [] })).toBe('exact')
  expect(await dispatchTap(taps, 'exact words please', { log: [] })).toBeNull()
})

test('chores start in table order, and one that throws or rejects does not stop the rest', async () => {
  const ran: string[] = [], log: string[] = []
  runChores([
    { name: 'first', run: () => { ran.push('first') } },
    { name: 'thrower', run: () => { throw new Error('boom') } },
    { name: 'rejecter', run: async () => { ran.push('rejecter'); throw new Error('later') } },
    { name: 'last', run: now => { ran.push(`last ${now}`) } },
  ], 42, l => log.push(l))
  expect(ran).toEqual(['first', 'rejecter', 'last 42'])
  await Bun.sleep(0)
  expect(log).toEqual(['otto channel: thrower failed: Error: boom\n', 'otto channel: rejecter failed: Error: later\n'])
})

test('every fires once per interval, and again for anyone asking at the same tick', () => {
  const due = every(1000)
  expect(due(5000)).toBe(true)
  expect(due(5000)).toBe(true)   // a second row sharing the gate this tick
  expect(due(5500)).toBe(false)
  expect(due(6000)).toBe(true)
  const late = every(1000, 5000)
  expect(late(5500)).toBe(false)
  expect(late(6000)).toBe(true)
})

test('a gate refuses or throws before the handler; an unlisted tool, or an inherited name, is open', () => {
  const gates: Record<string, Gate<{ ok?: boolean }, string>> = {
    returns: a => (a.ok ? undefined : 'refused'),
    throws: () => { throw new Error('not you') },
  }
  expect(gateFor(gates, 'returns', {})).toBe('refused')
  expect(gateFor(gates, 'returns', { ok: true })).toBeUndefined()
  expect(() => gateFor(gates, 'throws', {})).toThrow('not you')
  expect(gateFor(gates, 'open_tool', {})).toBeUndefined()
  expect(gateFor(gates, 'toString', {})).toBeUndefined()
})
