import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { digestTranscript, transcriptsSince, renderDigest, prepare, CONSOLIDATION_PROMPT } from '../consolidate.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-cons-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

function jsonl(records: unknown[]): string {
  return records.map(r => JSON.stringify(r)).join('\n')
}

function userTurn(text: string, over: Record<string, unknown> = {}) {
  return { type: 'user', timestamp: '2026-08-11T10:00:00Z', message: { role: 'user', content: text }, ...over }
}
function assistantTurn(blocks: unknown[], over: Record<string, unknown> = {}) {
  return { type: 'assistant', timestamp: '2026-08-11T10:01:00Z', message: { role: 'assistant', content: blocks }, ...over }
}

function write(name: string, records: unknown[]): string {
  const path = join(tmp, name)
  writeFileSync(path, jsonl(records))
  return path
}

test('only prose survives — thinking, tool calls and results are dropped', () => {
  const path = write('a.jsonl', [
    userTurn('fix the login bug'),
    assistantTurn([
      { type: 'thinking', thinking: 'internal monologue that should not survive' },
      { type: 'text', text: 'Looking at the auth handler.' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
    ]),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'A'.repeat(50_000) }] } },
    assistantTurn([{ type: 'text', text: 'Fixed — the token was expiring early.' }]),
  ])
  const d = digestTranscript(path, 'proj')!
  expect(d.turns).toHaveLength(3)
  expect(d.turns.map(t => t.role)).toEqual(['user', 'assistant', 'assistant'])
  const all = d.turns.map(t => t.text).join(' ')
  expect(all).toContain('fix the login bug')
  expect(all).toContain('token was expiring early')
  expect(all).not.toContain('internal monologue')
  expect(all).not.toContain('AAAA')
})

test('sidechain and meta turns are excluded', () => {
  const path = write('b.jsonl', [
    userTurn('real prompt'),
    userTurn('subagent chatter', { isSidechain: true }),
    userTurn('injected meta', { isMeta: true }),
    assistantTurn([{ type: 'text', text: 'real answer' }]),
  ])
  const d = digestTranscript(path, 'proj')!
  expect(d.turns).toHaveLength(2)
  expect(d.turns.map(t => t.text)).toEqual(['real prompt', 'real answer'])
})

test('the channel envelope is unwrapped', () => {
  const path = write('c.jsonl', [
    userTurn('<channel source="plugin:otto:otto" event="trigger">check the flight</channel>'),
    assistantTurn([{ type: 'text', text: 'on time' }]),
  ])
  expect(digestTranscript(path, 'proj')!.turns[0].text).toBe('check the flight')
})

test('long turns are truncated, not dropped', () => {
  const path = write('d.jsonl', [
    userTurn('x'.repeat(5000)),
    assistantTurn([{ type: 'text', text: 'ok' }]),
  ])
  const d = digestTranscript(path, 'proj')!
  expect(d.turns[0].text.length).toBeLessThan(1000)
  expect(d.turns[0].text).toEndWith('…')
})

test('a session with nothing but tool traffic yields no digest', () => {
  const path = write('e.jsonl', [
    assistantTurn([{ type: 'tool_use', name: 'Read', input: {} }]),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
  ])
  expect(digestTranscript(path, 'proj')).toBeNull()
})

test('malformed lines are skipped rather than fatal', () => {
  const path = join(tmp, 'f.jsonl')
  writeFileSync(path, `not json\n${JSON.stringify(userTurn('still works'))}\n{"broken":\n${JSON.stringify(assistantTurn([{ type: 'text', text: 'yes' }]))}`)
  const d = digestTranscript(path, 'proj')!
  expect(d.turns).toHaveLength(2)
})

test('timestamps bound the session', () => {
  const d = digestTranscript(write('g.jsonl', [
    userTurn('a', { timestamp: '2026-08-11T09:00:00Z' }),
    assistantTurn([{ type: 'text', text: 'b' }], { timestamp: '2026-08-11T11:30:00Z' }),
  ]), 'proj')!
  expect(d.started).toBe('2026-08-11T09:00:00Z')
  expect(d.ended).toBe('2026-08-11T11:30:00Z')
})

// The trap that ate the previous system's tail: consolidation runs producing
// transcripts that the next run consolidates.
test('a consolidation run is excluded by its project slug', () => {
  const path = write('h.jsonl', [userTurn('anything'), assistantTurn([{ type: 'text', text: 'ok' }])])
  expect(digestTranscript(path, '-Users-x--claude-channels-otto-digests')).toBeNull()
})

test('a consolidation run is excluded by its prompt even from another cwd', () => {
  const path = write('i.jsonl', [
    userTurn(CONSOLIDATION_PROMPT.slice(0, 400)),
    assistantTurn([{ type: 'text', text: 'wrote 3 memories' }]),
  ])
  expect(digestTranscript(path, 'some-other-project')).toBeNull()
})

test('other machine-started sessions are excluded too', () => {
  const distiller = write('j.jsonl', [
    userTurn('You are distilling DURABLE memories from a coding session transcript.\nReturn ONLY a JSON array.'),
    assistantTurn([{ type: 'text', text: '[]' }]),
  ])
  expect(digestTranscript(distiller, 'proj')).toBeNull()

  const titler = write('k.jsonl', [
    userTurn('Generate a title that will help the user recognize this T3 Code thread weeks later.'),
    assistantTurn([{ type: 'text', text: 'Fixing the auth flow' }]),
  ])
  expect(digestTranscript(titler, 'proj')).toBeNull()
})

// The bug this guards: matching the marker anywhere in the thread would drop
// the very session that built this feature, because it discusses it at length.
test('a real session that merely discusses consolidation is kept', () => {
  const path = write('l.jsonl', [
    userTurn('mnemosyne kinda sucks, build it into yourself instead'),
    assistantTurn([{ type: 'text', text: 'The nightly job prompt opens with "consolidating yesterday" so it can exclude its own runs.' }]),
    userTurn('and make sure distilling DURABLE memories runs are skipped too'),
    assistantTurn([{ type: 'text', text: 'Added both markers.' }]),
  ])
  const d = digestTranscript(path, 'proj')
  expect(d).not.toBeNull()
  expect(d!.turns).toHaveLength(4)
})

test('transcriptsSince respects the cutoff and sorts newest first', () => {
  const root = join(tmp, 'projects')
  mkdirSync(join(root, 'projA'), { recursive: true })
  mkdirSync(join(root, 'projB'), { recursive: true })
  const old = join(root, 'projA', 'old.jsonl')
  const fresh = join(root, 'projB', 'fresh.jsonl')
  writeFileSync(old, jsonl([userTurn('old')]))
  writeFileSync(fresh, jsonl([userTurn('fresh')]))
  // Push one clearly into the past.
  const past = Date.now() - 72 * 60 * 60 * 1000
  Bun.spawnSync(['touch', '-t', new Date(past).toISOString().slice(0, 16).replace(/[-:T]/g, ''), old])

  const since = Date.now() - 24 * 60 * 60 * 1000
  const found = transcriptsSince(since, root)
  expect(found.map(f => f.project)).toContain('projB')
  expect(found.map(f => f.project)).not.toContain('projA')
})

test('renderDigest labels roles and carries provenance', () => {
  const text = renderDigest({
    sessionId: 's1', project: 'p', started: 'T0', ended: 'T1',
    turns: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }],
  })
  expect(text).toContain('# session s1')
  expect(text).toContain('project: p')
  expect(text).toContain('## user\nq')
  expect(text).toContain('## assistant\na')
})

test('prepare clears stale digests so nothing is consolidated twice', () => {
  const root = join(tmp, 'projects2')
  const digests = join(tmp, 'digests')
  mkdirSync(join(root, 'projC'), { recursive: true })
  mkdirSync(digests, { recursive: true })
  writeFileSync(join(digests, 'leftover.md'), 'from a previous run')
  writeFileSync(join(root, 'projC', 's.jsonl'), jsonl([userTurn('hello'), assistantTurn([{ type: 'text', text: 'hi' }])]))

  const plan = prepare(0, digests)
  const files = readdirSync(digests).filter(f => f.endsWith('.md'))
  expect(files).not.toContain('leftover.md')
  expect(plan.digestDir).toBe(digests)
})
