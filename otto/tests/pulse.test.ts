import { test, expect } from 'bun:test'
import { validateCard } from '../cards.ts'
import {
  emptyPulse, addTopic, dropTopic, applyTap, topTopics, shouldRun, ingest, takeCards,
  normUrl, resultJobId, researchTask, DEFAULT_WEIGHT, MAX_WEIGHT, type PulseState,
} from '../pulse.ts'

const NOW = new Date('2026-03-04T23:30:00Z')
const withTopics = (...texts: string[]): PulseState =>
  texts.reduce((s, t) => addTopic(s, t, NOW).state, emptyPulse())

test('topics: add dedupes case-insensitively, drop by text or id', () => {
  let s = withTopics('Topic Alpha', 'topic beta')
  expect(addTopic(s, '  TOPIC   alpha ').state.topics.length).toBe(2)
  expect(s.topics[0].weight).toBe(DEFAULT_WEIGHT)
  s = dropTopic(s, 'TOPIC BETA').state
  expect(s.topics.map(t => t.text)).toEqual(['Topic Alpha'])
  expect(dropTopic(s, s.topics[0].id).state.topics).toEqual([])
  expect(dropTopic(s, 'nope').dropped).toBeUndefined()
})

test('weighting: more raises to a cap, less lowers and drops below the floor', () => {
  let s = withTopics('Topic Alpha', 'Topic Beta')
  const [a, b] = s.topics
  for (let i = 0; i < 20; i++) s = applyTap(s, `pulse more ${a.id}`)!.state
  expect(s.topics.find(t => t.id === a.id)!.weight).toBe(MAX_WEIGHT)
  expect(topTopics(s, 1)[0].id).toBe(a.id)
  s = applyTap(s, `pulse less ${b.id}`)!.state
  s = applyTap(s, `pulse less ${b.id}`)!.state
  expect(s.topics.find(t => t.id === b.id)!.weight).toBe(1)
  const last = applyTap(s, `pulse less ${b.id}`)!
  expect(last.line).toContain('Dropped')
  expect(last.state.topics.map(t => t.id)).toEqual([a.id])
  expect(applyTap(last.state, `pulse less ${b.id}`)!.line).toContain('gone')
  expect(applyTap(s, 'snooze 1h')).toBeNull()
})

test('ties go to the older topic', () => {
  const s = addTopic(addTopic(emptyPulse(), 'Newer', new Date('2026-03-02')).state, 'Older', new Date('2026-03-01')).state
  expect(topTopics(s).map(t => t.text)).toEqual(['Older', 'Newer'])
})

test('shouldRun: quiet hours, once a day, one at a time, topics needed', () => {
  const s = withTopics('Topic Alpha')
  const o = { today: '2026-03-04', quiet: true, jobActive: false }
  expect(shouldRun(s, o)).toBe(true)
  expect(shouldRun(s, { ...o, quiet: false })).toBe(false)
  expect(shouldRun(s, { ...o, jobActive: true })).toBe(false)
  expect(shouldRun({ ...s, lastRunDay: '2026-03-04' }, o)).toBe(false)
  expect(shouldRun(emptyPulse(), o)).toBe(false)
})

test('task names topic ids and recently seen urls', () => {
  const s = { ...withTopics('Topic Alpha'), seen: ['https://example.com/old'] }
  const t = researchTask(s, NOW)
  expect(t).toContain(`[${s.topics[0].id}] Topic Alpha`)
  expect(t).toContain('https://example.com/old')
})

const item = (topic: string, url: string, extra: Record<string, unknown> = {}) =>
  ({ topic, title: 'A thing happened', gist: 'It happened. It matters a little.', url, date: '2026-03-04', ...extra })
const jobText = (id: string, items: unknown[]) => `Background job [${id}] finished.\nTask: x\n\n${JSON.stringify(items)}`

test('ingest dedupes seen urls (tracking params ignored), caps at two, drops junk', () => {
  let s = { ...withTopics('Topic Alpha'), jobId: 'j1' }
  const id = s.topics[0].id
  const out = jobText('j1', [
    item(id, 'https://example.com/a?utm_source=x#top'),
    item(id, 'http://example.com/insecure'),
    item('zzzzzz', 'https://example.com/unknown-topic'),
    item(id, 'https://example.com/bad-date', { date: 'yesterday' }),
    item(id, 'https://example.com/b/'),
    item(id, 'https://example.com/c'),
  ])
  expect(resultJobId(out)).toBe('j1')
  const r = ingest(s, out)
  expect(r.added.map(a => a.url)).toEqual(['https://example.com/a', 'https://example.com/b'])
  expect(r.state.jobId).toBeUndefined()
  s = r.state
  // Next night: same story again, under a different tracking tag, is not new.
  const again = ingest(s, jobText('j2', [item(id, 'https://EXAMPLE.com/a?utm_medium=y')]))
  expect(again.added).toEqual([])
  expect(normUrl('https://example.com/a/')).toBe('https://example.com/a')
})

test('empty case: no items, bad output, no cards', () => {
  const s = withTopics('Topic Alpha')
  expect(ingest(s, jobText('j1', [])).added).toEqual([])
  expect(ingest(s, 'Background job [j1] failed (timeout).').added).toEqual([])
  expect(ingest(s, 'not json [at all').state.pending).toEqual([])
  expect(takeCards(s)).toBeNull()
})

test('takeCards: valid card, one more/less pair per item, clears pending', () => {
  const s = withTopics('Topic Alpha', 'Topic Beta')
  const [a, b] = s.topics
  const { state } = ingest(s, jobText('j', [item(a.id, 'https://example.com/a'), item(b.id, 'https://example.com/b')]))
  const c = takeCards(state)!
  expect(validateCard(c.card).ok).toBe(true)
  expect(c.buttons.map(x => x.data)).toEqual([`pulse more ${a.id}`, `pulse less ${a.id}`, `pulse more ${b.id}`, `pulse less ${b.id}`])
  for (const x of c.buttons) expect(new TextEncoder().encode(x.data).length).toBeLessThanOrEqual(60)
  expect(c.text).toContain('https://example.com/a')
  expect(c.state.pending).toEqual([])
  expect(takeCards(c.state)).toBeNull()
})
