import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  splitEqual, addSplit, settle, removeSplit, balances, netPlan, formatPlans, requestText, resolveFriend,
  loadSplits, saveSplits, type SplitsState, type Balance,
} from '../splits.ts'
import type { Person } from '../people.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-splits-'))
process.env.OTTO_STATE_DIR = tmp
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const person = (id: string, name: string): Person =>
  ({ id, name, addresses: [], aliases: [], offsetSamples: [], inbound: { count: 0 }, outbound: { count: 0 }, contacts: [], updatedAt: '' }) as Person
const base = { currency: 'EUR', what: 'Weekend dinner', date: '2026-10-17', group: 'weekend' }

function moment(): SplitsState {
  const s: SplitsState = { entries: [] }
  addSplit(s, { ...base, paidBy: 'Luca', total: 84, people: ['Luca', 'me', 'Sara', 'Marco'] }, [])
  addSplit(s, { ...base, paidBy: 'me', total: 18, people: ['me', 'Sara'] }, [])
  addSplit(s, { ...base, paidBy: 'Luca', total: 14, people: ['Luca', 'me'] }, [])
  addSplit(s, { ...base, paidBy: 'me', total: 14, people: ['Luca'], what: 'payment' }, [])
  return s
}

test('equal shares sum exactly, remainder to the first', () => {
  expect(splitEqual(8400, 4)).toEqual([2100, 2100, 2100, 2100])
  expect(splitEqual(1000, 3)).toEqual([334, 333, 333])
  const s: SplitsState = { entries: [] }
  const { added } = addSplit(s, { ...base, currency: 'JPY', paidBy: 'me', total: 1000, people: ['me', 'Luca', 'Sara'] }, [])
  expect(added.map(e => e.amount)).toEqual([333, 333])
})

test('the evening: Luca covered, Sara owes, a payment lands', () => {
  const s = moment()
  expect(s.entries.map(e => [e.name, e.amount])).toEqual([['Luca', -21], ['Sara', 9], ['Luca', -7], ['Luca', 14]])
  const bs = balances(s.entries, { group: 'weekend' })
  expect(bs.map(b => [b.name, b.minor])).toEqual([['Luca', -1400], ['Sara', 900]])
  // Luca: -21 -7 +14 = -14 ; Sara +9
  const [plan] = netPlan(bs)
  expect(plan!.netMinor).toBe(-500)
  expect(plan!.redirects).toEqual([{ from: 'Sara', to: 'Luca', minor: 900 }])
  expect(plan!.owe.map(b => [b.name, b.minor])).toEqual([['Luca', -500]])
  expect(plan!.owed).toEqual([])
  const text = formatPlans([plan!], 'weekend')
  expect(text).toContain('send €5.00')
  expect(text).toContain('you owe Luca €14.00 · Sara owes you €9.00')
  expect(text).toContain('request Sara (if not redirecting): Weekend — €9.00 via bank transfer')
})

test('refusals', () => {
  const s: SplitsState = { entries: [] }
  expect(() => addSplit(s, { ...base, paidBy: 'Luca', total: 10, people: ['Luca', 'Sara'] }, [])).toThrow('not your split')
  expect(() => addSplit(s, { ...base, paidBy: 'me', total: 10, people: ['me', 'Luca'], shares: { me: 3, Luca: 3 } }, [])).toThrow('add up')
  expect(() => addSplit(s, { ...base, paidBy: 'me', total: 10, people: ['me'] }, [])).toThrow('nothing owed')
  expect(() => addSplit(s, { ...base, currency: 'EURO', paidBy: 'me', total: 10, people: ['Luca'] }, [])).toThrow('ISO')
  expect(() => addSplit(s, { ...base, paidBy: 'me', total: 0, people: ['Luca'] }, [])).toThrow()
  expect(() => addSplit(s, { ...base, date: 'soon', paidBy: 'me', total: 5, people: ['Luca'] }, [])).toThrow('date')
  expect(() => addSplit(s, { ...base, paidBy: 'me', total: 5, people: ['Luca', 'Sara'], count: 1 }, [])).toThrow('count')
  expect(() => addSplit(s, { ...base, paidBy: '', total: 10, people: ['me', 'Luca'] }, [])).toThrow('say who')
  expect(addSplit(s, { ...base, currency: 'eur ', paidBy: 'me', total: 10, people: ['Luca'] }, []).added[0]!.currency).toBe('EUR')
})

test('count wider than the names, and uneven shares', () => {
  const s: SplitsState = { entries: [] }
  expect(addSplit(s, { ...base, paidBy: 'Luca', total: 84, people: ['Luca', 'me'], count: 4 }, []).added[0]!.amount).toBe(-21)
  const u = addSplit(s, { ...base, paidBy: 'me', total: 30, people: [], shares: { me: 10, Sara: 12, Marco: 8 } }, [])
  expect(u.added.map(e => [e.name, e.amount])).toEqual([['Sara', 12], ['Marco', 8]])
})

test('the same source is counted once per friend', () => {
  const s: SplitsState = { entries: [] }
  const input = { ...base, paidBy: 'me', total: 60, people: ['me', 'Luca', 'Sara'], source: 'telegram:42' }
  expect(addSplit(s, input, []).added.length).toBe(2)
  const again = addSplit(s, input, [])
  expect(again.added).toEqual([])
  expect(again.already.length).toBe(2)
  expect(addSplit(s, { ...input, people: ['me', 'Marco'], total: 20 }, []).added.length).toBe(1)
})

test('currencies never mix', () => {
  const s: SplitsState = { entries: [] }
  addSplit(s, { ...base, paidBy: 'me', total: 20, people: ['me', 'Luca'] }, [])
  addSplit(s, { ...base, currency: 'BRL', paidBy: 'Sara', total: 50, people: ['Sara', 'me'] }, [])
  addSplit(s, { ...base, currency: 'BRL', paidBy: 'me', total: 20, people: ['me', 'Luca'] }, [])
  const plans = netPlan(balances(s.entries))
  expect(plans.map(p => p.currency).sort()).toEqual(['BRL', 'EUR'])
  const brl = plans.find(p => p.currency === 'BRL')!
  expect(brl.redirects).toEqual([{ from: 'Luca', to: 'Sara', minor: 1000 }])
  expect(plans.find(p => p.currency === 'EUR')!.redirects).toEqual([])
  expect(formatPlans(plans, undefined, { apps: { BRL: 'Pix' } })).toContain('Pix')
})

test('settle and remove', () => {
  const s = moment()
  expect(() => settle(s, {}, [])).toThrow()
  expect(settle(s, { group: 'weekend' }, [])).toBe(4)
  expect(balances(s.entries)).toEqual([])
  expect(formatPlans(netPlan(balances(s.entries)), 'weekend')).toBe('(all square)')
  expect(settle(s, { group: 'weekend' }, [])).toBe(0)
  expect(removeSplit(s, s.entries[0]!.id)?.name).toBe('Luca')
  expect(removeSplit(s, 'nope')).toBeUndefined()
})

test('a partial redirect leaves a request for what is left', () => {
  const bs: Balance[] = [
    { friend: 'a', name: 'Sara', currency: 'EUR', minor: 2000 },
    { friend: 'b', name: 'Luca', currency: 'EUR', minor: -500 },
  ]
  const text = formatPlans(netPlan(bs), 'trip')
  expect(text).toContain('net: receive €15.00 (Sara can pay Luca €5.00 directly; Sara sends you €15.00)')
  expect(text).toContain('request Sara: Trip — €15.00 via bank transfer')
})

test('resolveFriend', () => {
  const ppl = [person('marco@a.example', 'Marco Rossi'), person('marco@b.example', 'Marco Bianchi'), person('luca@a.example', 'Luca')]
  expect(() => resolveFriend(ppl, 'Marco')).toThrow('say which')
  expect(resolveFriend(ppl, 'Luca')).toEqual({ id: 'luca@a.example', name: 'Luca' })
  expect(resolveFriend(ppl, 'Sara Neri')).toEqual({ id: 'name:sara-neri', name: 'Sara Neri' })
  expect(resolveFriend(ppl, 'luca').id).toBe('luca@a.example')
})

test('requestText names the app, the handle, and stays under 256', () => {
  const b = (currency: string): Balance => ({ friend: 'x', name: 'Sara', currency, minor: 900 })
  expect(requestText(b('EUR'), 'Weekend')).toBe('Weekend — €9.00 via bank transfer')
  expect(requestText(b('BRL'), undefined, { apps: { BRL: 'Pix' }, handles: { Pix: 'key-123' } })).toContain('via Pix (key-123)')
  expect(requestText(b('USD'), undefined)).toContain('Venmo')
  expect(requestText(b('GBP'), undefined)).toContain('bank transfer')
  expect(requestText(b('EUR'), undefined, { apps: { EUR: 'PayPal' } })).toContain('PayPal')
  const long = requestText(b('EUR'), 'x'.repeat(400))
  expect(long.length).toBeLessThanOrEqual(256)
  expect(long.endsWith('€9.00 via bank transfer')).toBe(true)
})

test('save and load round-trip; a corrupt file is empty', () => {
  const f = join(tmp, 'splits.json')
  const s = moment()
  saveSplits(f, s)
  expect(loadSplits(f)).toEqual(s)
  writeFileSync(f, '{nope')
  expect(loadSplits(f).entries).toEqual([])
})
