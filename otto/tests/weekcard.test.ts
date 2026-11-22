import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { weekCardOffer } from '../weekcard.ts'
import { validateCard } from '../cards.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const now = new Date(2026, 10, 22, 20).getTime()
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'week-card-')); dirs.push(dir)
  return { dir, put: (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value)), offer: (at = now, on = true) => weekCardOffer(dir, at, on, { home: dir }) }
}

test('full week produces one valid card from existing stores, including weekly GPT logs', () => {
  const h = setup(), at = new Date(now).toISOString()
  h.put('code-jobs.json', [{ id: 'a', title: 'Ship the fix', mergedAt: at, tokensUsed: 1000, model: 'claude-opus', weekShare: 2 }, { id: 'old', mergedAt: '2026-11-01' }])
  writeFileSync(join(h.dir, 'job-costs.jsonl'), JSON.stringify({ id: 'a', tokens: 2000, at, share: 3 }) + '\n')
  h.put('money.json', [{ date: '2026-11-20', amount: 15, currency: 'EUR', category: 'food' }])
  h.put('notes.json', [{ kind: 'loop', text: 'Return the book', due: '2026-11-24' }, { kind: 'loop', text: 'Closed', status: 'done', due: '2026-11-24' }])
  h.put('plan-usage.json', { at: now, seven_day: { used_percentage: 51, resets_at: now / 1000 + 86400 } })
  h.put('access.json', { pace: { byDay3: 45 } })
  mkdirSync(join(h.dir, '.codex', 'sessions'), { recursive: true })
  writeFileSync(join(h.dir, '.codex', 'sessions', 'a.jsonl'), JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1234 } } } }) + '\n')
  for (const [name, timestamp] of [['old', new Date(2026, 10, 15).toISOString()], ['future', new Date(now + 86400000).toISOString()]]) {
    writeFileSync(join(h.dir, '.codex', 'sessions', `${name}.jsonl`), JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 9000 } } } }) + '\n')
  }
  const offer = h.offer()!
  expect(validateCard(offer.card).ok).toBe(true)
  const text = JSON.stringify(offer.card)
  for (const expected of ['2K tokens total', '~3% of the week', '51%', '45% target', '1.2K', 'food', 'Return the book']) expect(text).toContain(expected)
  expect(text).not.toContain('Closed')
  expect(h.offer()).toBeNull() // disk stamp, no in-memory singleton
  h.put('notes.json', [{ kind: 'loop', text: 'Next week', due: '2026-12-01' }])
  expect(h.offer(now + 7 * 86400000)).not.toBeNull()
})

test('quiet weeks, including usage alone, send nothing', () => {
  const h = setup()
  h.put('plan-usage.json', { at: now, seven_day: { used_percentage: 70, resets_at: now / 1000 + 86400 } })
  expect(h.offer()).toBeNull()
  h.put('notes.json', [{ kind: 'loop', text: 'Added after the Sunday check', due: '2026-11-24' }])
  expect(h.offer()).toBeNull()
})

test('only Sunday from 20:00 local, off switch does not consume the week', () => {
  const h = setup()
  h.put('notes.json', [{ kind: 'loop', text: 'Due', due: '2026-11-24' }])
  expect(h.offer(now - 1)).toBeNull()
  expect(h.offer(now + 86400000)).toBeNull()
  expect(h.offer(now, false)).toBeNull()
  expect(h.offer()).not.toBeNull()
})

test('missing sources omit their lines; bounded long data remains valid', () => {
  const h = setup()
  h.put('notes.json', Array.from({ length: 100 }, () => ({ kind: 'loop', text: '界'.repeat(500), due: '2026-11-24' })))
  const card = h.offer()!.card
  expect(validateCard(card).ok).toBe(true)
  expect(card.blocks).toHaveLength(1)
  expect(JSON.stringify(card)).toContain('95 more due')
  expect(JSON.stringify(card)).not.toMatch(/Claude|GPT|grades|Spent|merged/)
})

test('no pace block shows the meter percentage without a target; old and future sources stay out', () => {
  const h = setup()
  h.put('notes.json', [{ kind: 'loop', text: 'Due', due: '2026-11-24' }, { kind: 'loop', text: 'Too far', due: '2026-12-01' }])
  h.put('plan-usage.json', { at: now, seven_day: { used_percentage: 20, resets_at: now / 1000 + 86400 } })
  h.put('money.json', [{ date: '2026-11-15', amount: 10, currency: 'EUR' }, { date: '2026-11-23', amount: 10, currency: 'EUR' }])
  const text = JSON.stringify(h.offer()!.card)
  expect(text).toContain('20%')
  expect(text).not.toMatch(/target|Spent|Too far/)
})
