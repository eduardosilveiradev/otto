import { test, expect } from 'bun:test'
import { applyCategoryTap, categorySweepDue, localDay, sweepCategories } from '../money-category.ts'
import { loadMoney, saveMoney, type MoneyRecord } from '../money.ts'
import { loadNotes, saveNotes, type Note } from '../store.ts'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function charge(id: string, category: string | null = null, merchant = 'Example Shop', date = '2026-11-08'): MoneyRecord {
  return { id, merchant, category, date, amount: 10, currency: 'EUR', createdAt: `${date}T12:00:00Z` }
}
function history(): MoneyRecord[] {
  return [charge('old1', 'food', 'Example Shop', '2026-11-01'), charge('old2', 'food', 'EXAMPLE  SHOP', '2026-11-02'), charge('new')]
}

test('agreement files normalised merchants, leaves categorised charges untouched, and records exact undo', () => {
  const records = history(), notes: Note[] = []
  const before = structuredClone(records.slice(0, 2))
  const offer = sweepCategories(records, notes)
  expect(records[2].category).toBe('food')
  expect(records.slice(0, 2)).toEqual(before)
  expect(offer.text).toContain('Filed:')
  expect(offer.buttons).toEqual([])
  expect(notes[0].kind).toBe('write')
  expect(notes[0].undo).toContain('["new"]')
})

test('disagreement does not file', () => {
  const records = history()
  records[1].category = 'travel'
  expect(sweepCategories(records, []).buttons).toHaveLength(3)
  expect(records[2].category).toBeNull()
})

test('one prior charge does not file; future charges do not count as earlier', () => {
  const records = history()
  records[1].date = '2026-11-09'
  sweepCategories(records, [])
  expect(records[2].category).toBeNull()
  records.splice(1, 1)
  sweepCategories(records, [])
  expect(records[1].category).toBeNull()
})

test('only unfiled charges with two earlier charges are automatically filed', () => {
  const records = [...history(), charge('earlier', null, 'Example Shop', '2026-11-02')]
  sweepCategories(records, [])
  expect(records[2].category).toBe('food')
  expect(records[3].category).toBeNull()
})

test('a persisted tap applies to all uncategorised charges, including later arrivals, without replacing categories', () => {
  const records = [charge('one'), charge('two', undefined, ' example shop '), charge('old', 'travel')]
  delete records[1].category
  const notes: Note[] = []
  const offer = sweepCategories(records, notes)
  const dir = mkdtempSync(join(tmpdir(), 'money-category-'))
  try {
    saveMoney(join(dir, 'money.json'), records)
    saveNotes(join(dir, 'notes.json'), notes)
    const restored = loadMoney(join(dir, 'money.json'))
    restored.push(charge('late'))
    expect(applyCategoryTap(restored, loadNotes(join(dir, 'notes.json')), offer.buttons[0].data)).toContain('Filed 3')
    expect(restored.every(r => r.category === 'travel')).toBe(true)
    expect(applyCategoryTap(restored, notes, offer.buttons[0].data)).toContain('Filed 0')
  } finally { rmSync(dir, { recursive: true }) }
})

test('skip suppresses a normalised merchant for exactly 90 days', () => {
  const records = [charge('one')], notes: Note[] = [], now = Date.UTC(2026, 10, 8)
  const offer = sweepCategories(records, notes, now)
  expect(applyCategoryTap(records, notes, offer.buttons[0].data, now)).toContain('90 days')
  expect(sweepCategories(records, notes, now + 90 * 86400000 - 1)).toEqual({ text: '', buttons: [] })
  expect(sweepCategories(records, notes, now + 90 * 86400000).buttons).toHaveLength(1)
})

test('nothing to do produces no message', () => {
  expect(sweepCategories([], [])).toEqual({ text: '', buttons: [] })
  expect(sweepCategories([charge('done', 'food')], [])).toEqual({ text: '', buttons: [] })
})

test('offers the five largest groups and the three most used categories', () => {
  const records = ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((merchant, i) => Array.from({ length: i + 1 }, (_, j) => charge(`${merchant}${j}`, null, `Example ${merchant}`)))
  for (const [i, category] of ['food', 'food', 'food', 'travel', 'travel', 'home', 'other'].entries()) records.push(charge(`cat${i}`, category, 'Categorised Example'))
  const offer = sweepCategories(records, [])
  expect(offer.text.split('\n')).toHaveLength(7)
  expect(offer.text.split('\n')[1]).toBe('example f · 6')
  expect(offer.text).not.toContain('example a ·')
  expect(offer.buttons.map(b => b.label)).toEqual(['all food', 'all travel', 'all home', 'skip'])
  expect(offer.buttons.every(b => Buffer.byteLength(`btn:${b.data}`) <= 64)).toBe(true)
})

test('weekly timing follows the machine local Sunday from 10:00, including after restart', () => {
  const sunday = new Date(2026, 10, 8, 10)
  expect(categorySweepDue(new Date(2026, 10, 8, 9, 59))).toBe(false)
  expect(categorySweepDue(sunday)).toBe(true)
  expect(categorySweepDue(sunday, localDay(sunday))).toBe(false)
  expect(categorySweepDue(new Date(2026, 10, 9, 10))).toBe(false)
})

test('several merchants get one question: a button per category files them all', () => {
  const records = [charge('cat', 'food', 'Other Place'), charge('a', null, 'Shop A'), charge('b', null, 'Shop B'), charge('b2', null, 'Shop B')]
  const notes: Note[] = []
  const offer = sweepCategories(records, notes)
  expect(offer.buttons.map(b => b.label)).toEqual(['all food', 'skip'])
  expect(offer.text).toContain('shop b · 2')
  expect(applyCategoryTap(records, notes, offer.buttons[0].data)).toContain('Filed 3')
  expect(records.every(r => r.category === 'food')).toBe(true)
})
