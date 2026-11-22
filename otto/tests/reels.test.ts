import { test, expect } from 'bun:test'
import { pendingReels, markReelTried, reelDigestKey, formatReelDigest } from '../reels.ts'
import { loadNotes, saveNotes, type Note } from '../store.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const note = (id: string, tags = ['reel', 'try']): Note => ({ id, tags, kind: 'saved', text: 'Library\nAnimated UI components\nhttps://example.com/reel', createdAt: '2026-08-01T00:00:00Z' })

test('selects only saved untried try reels, retaining old items', () => {
  const notes = [note('00000001'), note('00000002', ['reel', 'song']), note('00000003', ['try']), note('00000004', ['reel', 'try', 'tried']), { ...note('00000005'), kind: 'loop' as const }, { ...note('00000006'), status: 'dropped' as const }]
  expect(pendingReels(notes).map(n => n.id)).toEqual(['00000001'])
  const digest = formatReelDigest(pendingReels(notes))
  expect(digest.text).toContain(notes[0].text)
  expect(digest.buttons).toEqual([{ label: '1. tried it', data: 'reel tried 00000001' }])
  expect(pendingReels([])).toEqual([])
})

test('tried marking survives reload, is idempotent and leaves other notes alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reels-test-'))
  try {
    const file = join(dir, 'notes.json')
    const notes = [note('00000001'), note('00000002'), note('00000003', ['try'])]
    expect(markReelTried(notes, 'missing')).toBe(false)
    expect(markReelTried(notes, '00000003')).toBe(false)
    expect(markReelTried(notes, '00000001')).toBe(true)
    const updated = notes[0].updatedAt
    expect(markReelTried(notes, '00000001')).toBe(true)
    expect(notes[0].updatedAt).toBe(updated)
    saveNotes(file, notes)
    const reloaded = loadNotes(file)
    expect(reloaded[0].tags).toEqual(['reel', 'try', 'tried'])
    expect(reloaded[0].text).toBe(notes[0].text)
    expect(pendingReels(reloaded).map(n => n.id)).toEqual(['00000002'])
  } finally { rmSync(dir, { recursive: true }) }
})

test('Sunday local 10:00, catch-up and persisted deduplication', () => {
  expect(reelDigestKey(new Date(2026, 10, 8, 9, 59))).toBeUndefined()
  const key = reelDigestKey(new Date(2026, 10, 8, 10))
  expect(key).toBe('2026-11-8')
  expect(reelDigestKey(new Date(2026, 10, 8, 23), key)).toBeUndefined()
  expect(reelDigestKey(new Date(2026, 10, 9, 10))).toBeUndefined()
  expect(reelDigestKey(new Date(2026, 10, 15, 10), key)).toBe('2026-11-15')
})
