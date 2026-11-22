import { expect, test } from 'bun:test'
import { validateCard, type Block, type Card } from '../cards.ts'
import type { Card as DashCard } from '../dash-types.ts'
import { isRich, loadQueue, saveQueue, type QueuedMessage } from '../queue.ts'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const blocks: Block[] = [
  { type: 'stat', value: '42', label: 'Total', delta: '+2', tone: 'up' },
  { type: 'list', items: [{ title: 'Item', detail: 'Detail', trailing: '12', icon: 'star' }] },
  { type: 'table', columns: ['Item', 'Value'], rows: [['One', '12']] },
  { type: 'bars', items: [{ label: 'One', value: 12 }], unit: 'km' },
  { type: 'sparkline', values: [1, 2, 3], label: 'Trend' },
  { type: 'progress', value: 0.5, label: 'Halfway', detail: '1 of 2' },
  { type: 'timeline', items: [{ time: '09:00 UTC', title: 'Start', detail: 'Ready', done: false }] },
  { type: 'keyvalue', items: [{ key: 'Distance', value: '12 km' }] },
  { type: 'checklist', items: [{ text: 'Pack', done: true }] },
  { type: 'image', file: 'file-id', alt: 'A chart' },
  { type: 'text', text: 'Plain text', style: 'caption' },
]
for (const block of blocks) test(`valid ${block.type}`, () => {
  const card: DashCard = { title: 'Overview', blocks: [block] }
  expect(validateCard(card)).toEqual({ ok: true, card })
})
test('all block types and action shapes together', () => {
  const card: Card = { blocks, actions: [{ label: 'Done', data: 'mark done' }, { label: 'Open', url: 'https://example.com' }, { label: 'Copy', copy: '1234567890' }] }
  expect(validateCard(card)).toEqual({ ok: true, card })
  expect(validateCard({ blocks: [{ type: 'image', url: 'https://example.com/image.png', alt: 'Chart' }] }).ok).toBe(true)
})
function errors(x: unknown, expected: string[]) {
  expect(validateCard(x)).toEqual({ ok: false, errors: expected })
}
function bad(block: unknown, expected: string[]) { errors({ blocks: [block] }, expected.map(e => `blocks[0]${e}`)) }

test('objects, required fields, unknown fields and discriminators', () => {
  for (const x of [null, [], 'card', 1]) errors(x, ['card: expected object'])
  errors({}, ['blocks: expected array'])
  errors({ blocks: [], extra: true }, ['extra: unknown field', 'blocks: expected 1–12 items'])
  bad(null, [': expected object'])
  for (const type of ['unknown', 'toString', 42, undefined]) bad({ type }, ['.type: unknown block type'])
  bad({ type: 'stat', value: 12, extra: true }, ['.extra: unknown field', '.value: expected string'])
  bad({ type: 'progress', value: 0.5 }, ['.label: expected string'])
})
test('precise nested paths and multiple errors', () => {
  errors({ blocks: [blocks[0], blocks[0], { type: 'bars', items: Array.from({ length: 6 }, (_, i) => ({ label: 'x', value: i === 5 ? 'bad' : i })) }] }, ['blocks[2].items[5].value: expected number'])
  bad({ type: 'list', items: [{ title: 'x', detail: false }] }, ['.items[0].detail: expected string'])
  bad({ type: 'timeline', items: [{ time: 1, title: 'x', done: 'yes' }] }, ['.items[0].time: expected string', '.items[0].done: expected boolean'])
  bad({ type: 'checklist', items: [{ text: 'x' }] }, ['.items[0].done: expected boolean'])
  bad({ type: 'keyvalue', items: [{ key: 'x', value: 1 }] }, ['.items[0].value: expected string'])
})
test('string limits and enums', () => {
  errors({ title: 'x'.repeat(81), blocks: [blocks[0]] }, ['title: maximum 80 characters'])
  bad({ type: 'stat', value: 'x'.repeat(25), label: 'x'.repeat(121), tone: 'bad' }, ['.value: maximum 24 characters', '.label: maximum 120 characters', '.tone: expected up|down|neutral'])
  bad({ type: 'text', text: 'x'.repeat(401), style: 'bad' }, ['.text: maximum 400 characters', '.style: expected body|caption'])
  expect(validateCard({ title: 'x'.repeat(80), blocks: [{ type: 'text', text: 'x'.repeat(400) }, { type: 'stat', value: 'x'.repeat(24), label: 'x'.repeat(120) }] }).ok).toBe(true)
})
test('array bounds', () => {
  errors({ blocks: Array(13).fill(blocks[0]) }, ['blocks: expected 1–12 items'])
  for (const [type, max, item] of [
    ['list', 20, { title: 'x' }], ['bars', 12, { label: 'x', value: 1 }],
    ['timeline', 20, { time: 'UTC', title: 'x' }], ['keyvalue', 12, { key: 'x', value: 'y' }],
    ['checklist', 20, { text: 'x', done: false }],
  ] as const) {
    bad({ type, items: Array(max + 1).fill(item) }, [`.items: expected 0–${max} items`])
    expect(validateCard({ blocks: [{ type, items: Array(max).fill(item) }] }).ok).toBe(true)
    bad({ type, items: {} }, ['.items: expected array'])
  }
  for (const count of [1, 61]) bad({ type: 'sparkline', values: Array(count).fill(1) }, ['.values: expected 2–60 items'])
  for (const count of [2, 60]) expect(validateCard({ blocks: [{ type: 'sparkline', values: Array(count).fill(1) }] }).ok).toBe(true)
})
test('table dimensions and cell types', () => {
  for (const count of [0, 5]) bad({ type: 'table', columns: Array(count).fill('x'), rows: [] }, ['.columns: expected 1–4 items'])
  bad({ type: 'table', columns: ['x', 'y'], rows: [['a'], [1, 'b'], false] }, ['.rows[0]: expected 2 cells', '.rows[1][0]: expected string', '.rows[2]: expected array'])
  bad({ type: 'table', columns: ['x'], rows: Array(21).fill(['a']) }, ['.rows: expected 0–20 items'])
})
test('finite numbers, progress bounds and optional field types', () => {
  for (const value of [NaN, Infinity, -Infinity, '1', null]) bad({ type: 'progress', value, label: 'x' }, ['.value: expected number'])
  for (const value of [-0.1, 1.1]) bad({ type: 'progress', value, label: 'x' }, ['.value: expected number in 0..1'])
  for (const value of [0, 1]) expect(validateCard({ blocks: [{ type: 'progress', value, label: 'x' }] }).ok).toBe(true)
  bad({ type: 'sparkline', values: [1, Infinity], label: null }, ['.values[1]: expected number', '.label: expected string'])
})
test('image source and action validation', () => {
  bad({ type: 'image', alt: 'x' }, [': expected exactly one of file or url'])
  bad({ type: 'image', file: 'id', url: 'https://example.com', alt: 'x' }, [': expected exactly one of file or url'])
  bad({ type: 'image', url: 'http://example.com', alt: 'x' }, ['.url: expected https URL'])
  const action = (a: unknown, e: string[]) => errors({ blocks: [blocks[0]], actions: [a] }, e.map(s => `actions[0]${s}`))
  action({ label: 'x' }, [': expected exactly one of data, url or copy'])
  action({ label: 'x', data: 'a', copy: 'b' }, [': expected exactly one of data, url or copy'])
  action({ label: 'x', url: 'bad' }, ['.url: expected https URL'])
  action({ label: 'x', data: 'x'.repeat(121) }, ['.data: maximum 120 characters'])
  action({ label: 'x', copy: 1 }, ['.copy: expected string'])
  errors({ blocks: [blocks[0]], actions: Array(5).fill({ label: 'x', data: 'x' }) }, ['actions: expected 0–4 items'])
})
test('queued card persists and is delivered individually', () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-cards-'))
  try {
    const message: QueuedMessage = { id: 'queued', chat_id: 'app', text: 'Halfway.', queuedAt: '2026-01-01T00:00:00Z', reason: 'quiet', card: { blocks: [blocks[5]] } }
    const path = join(dir, 'queue.json')
    saveQueue(path, [message])
    expect(loadQueue(path)).toEqual([message])
    expect(isRich(loadQueue(path)[0])).toBe(true)
  } finally { rmSync(dir, { recursive: true }) }
})

test('reply carries one card on the last bubble and history survives restart; invalid cards lose only the card', async () => {
  const { startTwin, phone } = await import('./apptwin.ts')
  let t = await startTwin()
  try {
    const p = await phone(t)
    const card: Card = { title: 'Progress', blocks: [blocks[5]] }
    const result = await t.call('reply', { chat_id: 'app', text: 'Halfway.\n\nOne of two complete.', card, verbatim: true })
    expect(result).not.toHaveProperty('isError', true)
    const first = await p.until(f => f.type === 'message' && f.text === 'Halfway.')
    expect(first.card).toBeUndefined()
    expect(await p.until(f => f.type === 'message' && f.card)).toMatchObject({ card })
    const readHistory = async () => (await fetch(`${t.url}/app/history`, { headers: { authorization: `Bearer ${t.token}` } })).json() as Promise<any[]>
    expect((await readHistory()).filter(r => r.card).map(r => r.card)).toEqual([card])
    const invalid = await t.call('reply', { chat_id: 'app', text: 'The text still arrives.', card: { blocks: [{ type: 'progress', value: 2, label: 'x' }] }, verbatim: true })
    expect(invalid).not.toHaveProperty('isError', true)
    expect(JSON.stringify(invalid)).toContain('blocks[0].value: expected number in 0..1')
    expect(await p.until(f => f.type === 'message' && f.text === 'The text still arrives.')).not.toHaveProperty('card')
    const unknownFile = await t.call('reply', { chat_id: 'app', text: 'Image unavailable.', card: { blocks: [{ type: 'image', file: 'missing-id', alt: 'Chart' }] }, verbatim: true })
    expect(JSON.stringify(unknownFile)).toContain('blocks[0].file: unknown app file id')
    t = await t.restart()
    expect((await readHistory()).filter(r => r.card).map(r => r.card)).toEqual([card])
    expect((await readHistory()).find(r => r.text === 'The text still arrives.')).not.toHaveProperty('card')
  } finally { await t.stop() }
}, 60000)
