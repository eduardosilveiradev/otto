import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { olderHistory, rotateHistory, HISTORY_ROTATE_BYTES, HISTORY_ROTATIONS, type HistoryEntry } from '../history.ts'
const row = (i: number, extra = {}): HistoryEntry => ({ ts: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 7))).toISOString(), dir: i % 2 ? 'in' : 'out', chat_id: 'app', message_id: `m${String(i).padStart(4, '0')}`, kind: 'text', text: `row ${i} 雪`, ...extra })
test('pages exhaust sparse rotated history exactly once with folded mutations', () => {
  const state = mkdtempSync(join(tmpdir(), 'otto-history-'))
  try {
    const all = Array.from({ length: 1200 }, (_, i) => row(i))
    const log = all.flatMap(e => [e, ...Array.from({ length: 8 }, () => ({ ...e, chat_id: 'other' }))])
    const patches = [row(1300, { kind: 'edit', message_id: 'm0002', text: 'edited' }), row(1301, { kind: 'edit', message_id: 'm0002', text: 'latest' }), row(1302, { kind: 'reaction', dir: 'out', message_id: 'm0002', text: '👍' }), row(1303, { kind: 'delete', message_id: 'm0003' }), row(1304, { kind: 'tap', message_id: 'tap-op', text: 'done' })]
    const jsonl = (rows: HistoryEntry[]) => rows.map(e => JSON.stringify(e)).join('\n') + '\n'
    writeFileSync(join(state, 'history.3.jsonl'), jsonl(log.slice(0, 5410)))
    writeFileSync(join(state, 'history.jsonl'), jsonl([...log.slice(5410), ...patches]) + '{unfinished')
    for (const size of [13, 50, 500]) {
      let before = '2027-01-01T00:00:00.000Z', got: HistoryEntry[] = []
      for (;;) {
        const page = olderHistory(state, 'app', size, before)
        if (!page.length) break
        expect(page.length).toBeLessThanOrEqual(size)
        got = [...page, ...got]; before = `${page[0].ts}|${page[0].message_id}`
      }
      expect(got.map(e => e.message_id)).toEqual([...all.filter(e => e.message_id !== 'm0003'), patches.at(-1)!].map(e => e.message_id))
      expect(got.find(e => e.message_id === 'm0002')).toMatchObject({ text: 'latest', extra: { reaction: '👍' } })
    }
    expect(olderHistory(state, 'app', 1, `${all[700].ts}|${all[700].message_id}`)[0].message_id).toBe(all[699].message_id)
    expect(olderHistory(state, 'app', 500, all[7].ts).map(e => e.message_id)).toEqual(all.slice(0, 7).filter(e => e.message_id !== 'm0003').map(e => e.message_id))
  } finally { rmSync(state, { recursive: true, force: true }) }
}, 30000)
test('rotation preserves previous segments, bounded to 26 archives', () => {
  const state = mkdtempSync(join(tmpdir(), 'otto-history-'))
  try {
    for (let n = 0; n < HISTORY_ROTATIONS + 3; n++) {
      writeFileSync(join(state, 'history.jsonl'), `${n}`.padEnd(HISTORY_ROTATE_BYTES + 1, ' ')); rotateHistory(state)
      expect(readFileSync(join(state, 'history.1.jsonl'), 'utf8').trim()).toBe(String(n))
    }
    expect(readFileSync(join(state, `history.${HISTORY_ROTATIONS}.jsonl`), 'utf8').trim()).toBe('3')
    expect(existsSync(join(state, `history.${HISTORY_ROTATIONS + 1}.jsonl`))).toBe(false)
  } finally { rmSync(state, { recursive: true, force: true }) }
})
