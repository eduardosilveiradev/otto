import { test, expect } from 'bun:test'
import {
  radar, actByDate, normalizeTail, upsertDocument, passportProblems, dueDocNudges, addMonths, type Doc,
} from '../documents'
import { tripProblems, type Trip } from '../trips'
import type { EscalationState } from '../escalation'

const doc = (o: Partial<Doc> = {}): Doc => ({
  id: 'd1', kind: 'passport', country: 'BR', holder: 'me', expires: '2027-06-30', ...o,
})

test('lead times per kind and country', () => {
  expect(actByDate(doc())).toBe('2026-10-30') // 8 months
  expect(actByDate(doc({ kind: 'residence-permit', country: 'IT', expires: '2027-03-01' }))).toBe('2026-12-31') // 60 days
  expect(actByDate(doc({ kind: 'id-card', country: 'IT', expires: '2027-06-30' }))).toBe('2026-12-30')
  expect(actByDate(doc({ kind: 'driving-licence', country: 'IT', expires: '2027-06-30' }))).toBe('2027-02-28')
  expect(actByDate(doc({ kind: 'health-card', country: 'IT', expires: '2027-06-30' }))).toBe('2027-03-30')
  expect(actByDate(doc({ kind: 'residence-permit', country: 'ES', expires: '2027-06-30' }))).toBe('2027-03-30') // default
})

test('month arithmetic clamps to month end', () => {
  expect(addMonths('2027-08-31', -6)).toBe('2027-02-28')
})

test('status boundaries', () => {
  const d = doc() // act by 2026-10-30
  const s = (today: string) => radar([d], today)[0]!
  expect(s('2026-09-29').status).toBe('ok') // 31 days out
  expect(s('2026-09-30').status).toBe('act-soon') // 30 days out
  expect(s('2026-10-29').status).toBe('act-soon')
  expect(s('2026-10-30').status).toBe('act-now')
  expect(s('2027-06-30').status).toBe('act-now') // expiry day is not yet expired
  expect(s('2027-07-01').status).toBe('expired')
  expect(s('2026-10-13').daysToAct).toBe(17)
})

test('radar sorts by act-by and drops renewed documents', () => {
  const rows = radar([
    doc({ id: 'late', expires: '2030-01-01' }),
    doc({ id: 'soon', expires: '2027-01-01' }),
    doc({ id: 'old', renewedAt: '2026-01-01' }),
  ], '2026-10-13')
  expect(rows.map(r => r.doc.id)).toEqual(['soon', 'late'])
})

test('a full number is cut to its last 3 characters', () => {
  expect(normalizeTail('YA 1234567')).toBe('567')
  expect(normalizeTail('ab')).toBe('AB')
  expect(normalizeTail('')).toBeUndefined()
  const docs: Doc[] = []
  const d = upsertDocument(docs, { kind: 'passport', country: 'br', holder: 'me', expires: '2027-06-30', numberTail: 'FAKE9876543' })
  expect(d.numberTail).toBe('543')
  expect(JSON.stringify(docs)).not.toContain('9876')
  expect(d.country).toBe('BR')
})

test('upsert matches the open doc of the same kind, country and holder', () => {
  const docs: Doc[] = []
  upsertDocument(docs, { kind: 'passport', country: 'BR', holder: 'me', expires: '2027-06-30', numberTail: '123' })
  upsertDocument(docs, { kind: 'passport', country: 'BR', holder: 'me', expires: '2028-01-01' })
  expect(docs).toHaveLength(1)
  expect(docs[0]!.expires).toBe('2028-01-01')
  expect(docs[0]!.numberTail).toBe('123')
  expect(() => upsertDocument(docs, { kind: 'passport', country: 'BR', holder: 'me', expires: 'soon' })).toThrow()
})

const trip = (end: string): Trip => ({ id: 't', start: '2026-12-01', end, segments: [], pnrs: [], sources: [] } as unknown as Trip)

test('trip check flags a passport under 6 months past return', () => {
  const docs = [doc({ expires: '2027-06-30' })]
  expect(tripProblems(trip('2026-12-20'), docs)).toEqual([]) // 6 months -> 2027-06-20, ok
  expect(tripProblems(trip('2027-01-05'), docs)).toEqual(['passport expires 2027-06-30, under 6 months after return'])
  expect(tripProblems(trip('2027-01-05'), [doc({ expires: '2027-06-30', renewedAt: '2026-11-01' })])).toEqual([])
  expect(tripProblems(trip('2027-01-05'), [doc({ kind: 'id-card', expires: '2027-01-01' })])).toEqual([])
  expect(passportProblems('2026-12-31', [])).toEqual([])
})

test('nudges: two per document, never more', () => {
  const d = doc() // act by 2026-10-30
  const state: EscalationState = {}
  expect(dueDocNudges([d], state, '2026-10-29')).toHaveLength(0)
  expect(dueDocNudges([d], state, '2026-10-30').map(n => n.stage)).toEqual(['doc-act-by'])
  expect(dueDocNudges([d], state, '2026-10-31')).toHaveLength(0) // deduped
  expect(dueDocNudges([d], state, '2026-11-28')).toHaveLength(0)
  expect(dueDocNudges([d], state, '2026-11-29').map(n => n.stage)).toEqual(['doc-chase'])
  expect(dueDocNudges([d], state, '2027-03-01')).toHaveLength(0)
  expect(state['doc:d1']!.fired).toEqual(['doc-act-by', 'doc-chase'])
})

test('nudges: renewed docs stay quiet; a doc found late gets one message, not two', () => {
  expect(dueDocNudges([doc({ renewedAt: '2026-10-01' })], {}, '2027-01-01')).toHaveLength(0)
  const state: EscalationState = {}
  expect(dueDocNudges([doc()], state, '2027-02-01')).toHaveLength(1)
  expect(dueDocNudges([doc()], state, '2027-02-02')).toHaveLength(0)
})
