import { test, expect } from 'bun:test'
import { upsertNote, searchNotes, dueLoops, formatNote, type Note } from '../store.ts'

function seed(): Note[] {
  const notes: Note[] = []
  upsertNote(notes, { kind: 'fact', text: 'Landlord is Marco, contract renews each October', tags: ['landlord'] })
  upsertNote(notes, { kind: 'loop', text: 'owes Marco the signed contract', due: '2026-08-20T09:00:00Z', tags: ['landlord'] })
  upsertNote(notes, { kind: 'loop', text: 'reply to Jony about Q3', due: '2026-08-12T09:00:00Z' })
  upsertNote(notes, { kind: 'saved', text: 'article on MLX quantization', tags: ['ml'] })
  upsertNote(notes, { kind: 'write', text: 'created calendar event "dentist" 14 Aug 15:00', undo: 'delete the "dentist" event on 14 Aug' })
  return notes
}

test('creating requires kind and text', () => {
  expect(() => upsertNote([], { kind: 'fact' })).toThrow(/text is required/)
  expect(() => upsertNote([], { text: 'x' })).toThrow(/kind is required/)
})

test('loops and writes open by default, facts have no status', () => {
  const notes = seed()
  expect(notes.find(n => n.kind === 'loop')!.status).toBe('open')
  expect(notes.find(n => n.kind === 'write')!.status).toBe('open')
  expect(notes.find(n => n.kind === 'fact')!.status).toBeUndefined()
})

test('upsert by id patches instead of duplicating', () => {
  const notes = seed()
  const loop = notes.find(n => n.kind === 'loop')!
  const before = notes.length
  const { note } = upsertNote(notes, { id: loop.id, status: 'done' })
  expect(notes.length).toBe(before)
  expect(note.status).toBe('done')
  expect(note.updatedAt).toBeDefined()
})

test('upsert on an unknown id throws rather than silently creating', () => {
  expect(() => upsertNote(seed(), { id: 'nope', text: 'x' })).toThrow(/no note nope/)
})

test('all query terms must match', () => {
  const notes = seed()
  expect(searchNotes(notes, { query: 'marco contract' })).toHaveLength(2)
  expect(searchNotes(notes, { query: 'marco unicorn' })).toHaveLength(0)
})

test('closed notes are hidden unless asked for', () => {
  const notes = seed()
  const loop = notes.find(n => n.text.includes('Jony'))!
  upsertNote(notes, { id: loop.id, status: 'done' })
  expect(searchNotes(notes, { kind: 'loop' })).toHaveLength(1)
  expect(searchNotes(notes, { kind: 'loop', includeClosed: true })).toHaveLength(2)
})

test('due notes sort ahead of undated ones, soonest first', () => {
  const notes = seed()
  upsertNote(notes, { kind: 'loop', text: 'someday thing' })
  const loops = searchNotes(notes, { kind: 'loop' })
  expect(loops[0].text).toContain('Jony')
  expect(loops[1].text).toContain('Marco')
  expect(loops[2].text).toBe('someday thing')
})

test('tag filtering is exact', () => {
  const notes = seed()
  expect(searchNotes(notes, { tag: 'landlord' })).toHaveLength(2)
  expect(searchNotes(notes, { tag: 'land' })).toHaveLength(0)
})

test('dueLoops only returns open loops inside the horizon', () => {
  const notes = seed()
  const now = Date.parse('2026-08-11T12:00:00Z')
  const day = 24 * 60 * 60 * 1000
  expect(dueLoops(notes, now, day).map(n => n.text)).toEqual(['reply to Jony about Q3'])
  expect(dueLoops(notes, now, 30 * day)).toHaveLength(2)

  const jony = notes.find(n => n.text.includes('Jony'))!
  upsertNote(notes, { id: jony.id, status: 'done' })
  expect(dueLoops(notes, now, day)).toHaveLength(0)
})

test('formatNote surfaces the undo line for writes', () => {
  const notes = seed()
  const w = notes.find(n => n.kind === 'write')!
  expect(formatNote(w)).toContain('undo: delete the "dentist" event')
})

test('an empty due clears the date and leaves the loop open', () => {
  const notes = seed()
  const loop = notes.find(n => n.text.startsWith('reply to Jony'))!
  const { note } = upsertNote(notes, { id: loop.id, due: '', status: 'open' })
  expect(note.due).toBeUndefined()
  expect(note.status).toBe('open')
  expect(note.deferrals).toBeUndefined()
})
