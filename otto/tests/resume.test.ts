import { test, expect } from 'bun:test'
import {
  parseLastCommit, parseShortstat, parseDiffNotes, parseFailingTest,
  isInteresting, formatResume, type RepoState,
} from '../resume'

const HOUR = 3_600_000
const NOW = Date.parse('2026-08-12T09:00:00Z')

const repo = (over: Partial<RepoState> = {}): RepoState => ({
  path: '/p/my-project', name: 'my-project', branch: 'main',
  filesChanged: 0, insertions: 0, deletions: 0, notes: [],
  ...over,
})

test('the last commit parses subject and time', () => {
  const r = parseLastCommit('wire the calendar feed\x001786500000')
  expect(r.subject).toBe('wire the calendar feed')
  expect(r.at).toBe(1786500000000)
})

test('an empty log yields nothing rather than a fake commit', () => {
  expect(parseLastCommit('')).toEqual({})
  expect(parseLastCommit('   ')).toEqual({})
})

test('shortstat parses, including the singular and partial forms', () => {
  expect(parseShortstat(' 3 files changed, 42 insertions(+), 7 deletions(-)'))
    .toEqual({ filesChanged: 3, insertions: 42, deletions: 7 })
  expect(parseShortstat(' 1 file changed, 2 insertions(+)'))
    .toEqual({ filesChanged: 1, insertions: 2, deletions: 0 })
  expect(parseShortstat('')).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 })
})

test('only TODOs added in the diff count, not ones already in the file', () => {
  const diff = [
    '+++ b/otto/topics.ts',
    '-// TODO: this one was already here and is being removed',
    ' // TODO: context line, untouched',
    '+// TODO: handle the burst window properly',
    '+const x = 1',
    '+// FIXME: the timezone here is wrong',
  ].join('\n')
  expect(parseDiffNotes(diff)).toEqual([
    'handle the burst window properly',
    'the timezone here is wrong',
  ])
})

test('the +++ header is never mistaken for an added line', () => {
  expect(parseDiffNotes('+++ b/TODO.md\n+const ok = 1')).toEqual([])
})

test('diff notes are capped so the card stays three lines', () => {
  const diff = Array.from({ length: 9 }, (_, i) => `+// TODO: thing ${i}`).join('\n')
  expect(parseDiffNotes(diff)).toHaveLength(3)
})

test('the last failing test wins, and a clean run reports none', () => {
  const out = [
    '(fail) topic suppression collapses a burst [1.20ms]',
    ' 40 pass',
    '(fail) the morning nudge does not repeat later the same day [0.30ms]',
  ].join('\n')
  expect(parseFailingTest(out)).toBe('the morning nudge does not repeat later the same day')
  expect(parseFailingTest(' 522 pass\n 0 fail')).toBeUndefined()
})

test('a clean repo with nothing failing is not interesting', () => {
  expect(isInteresting(repo({ lastCommit: 'ship it' }))).toBe(false)
})

test('uncommitted work, a note, or a failing test each make it interesting', () => {
  expect(isInteresting(repo({ filesChanged: 1 }))).toBe(true)
  expect(isInteresting(repo({ notes: ['finish the parser'] }))).toBe(true)
  expect(isInteresting(repo({ failingTest: 'x' }))).toBe(true)
})

test('nothing in flight renders as nothing at all', () => {
  expect(formatResume([repo(), repo({ name: 'other' })], NOW)).toBe('')
})

test('the card names the repo, the diff, the last commit and the failure', () => {
  const text = formatResume([
    repo({
      filesChanged: 3, insertions: 42, deletions: 7,
      lastCommit: 'wire the calendar feed', lastCommitAt: NOW - 14 * HOUR,
      failingTest: 'the morning nudge does not repeat',
      notes: ['handle the burst window'],
    }),
  ], NOW)
  expect(text).toContain('my-project (main)')
  expect(text).toContain('3 files uncommitted, +42/-7')
  expect(text).toContain('"wire the calendar feed"')
  expect(text).toContain('14h ago')
  expect(text).toContain('failing: the morning nudge does not repeat')
  expect(text).toContain('left a note: handle the burst window')
})

test('clean repos are omitted from a mixed list rather than listed as clean', () => {
  const text = formatResume([repo({ name: 'quiet' }), repo({ name: 'busy', filesChanged: 2 })], NOW)
  expect(text).toContain('busy')
  expect(text).not.toContain('quiet')
})

test('one file reads as singular', () => {
  expect(formatResume([repo({ filesChanged: 1, insertions: 1, deletions: 0 })], NOW))
    .toContain('1 file uncommitted')
})
