/** Read retained history backwards without loading whole logs; fold mutations before paging app rows. */
import { closeSync, openSync, readSync, readdirSync, statSync, fstatSync, renameSync } from 'fs'
import { join } from 'path'

export const HISTORY_ROTATIONS = 26
export const HISTORY_ROTATE_BYTES = 1024 * 1024

export type HistoryEntry = {
  ts: string; dir: 'in' | 'out'; chat_id: string; message_id?: string
  kind: string; text: string; from?: string; src?: string
  extra?: Record<string, unknown>; tz?: string
}

/** Newest file first, including older segments even when a rotation number is missing. */
export function historyFiles(state: string): string[] {
  const rotations = readdirSync(state).filter(f => /^history\.[1-9]\d*\.jsonl$/.test(f))
    .sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
  return ['history.jsonl', ...rotations].map(f => join(state, f))
}

export function rotateHistory(state: string): void {
  const current = join(state, 'history.jsonl')
  try { if (statSync(current).size <= HISTORY_ROTATE_BYTES) return } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  for (let n = HISTORY_ROTATIONS; n >= 1; n--) {
    try { renameSync(n === 1 ? current : join(state, `history.${n - 1}.jsonl`), join(state, `history.${n}.jsonl`)) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}

/** Split bytes before decoding so UTF-8 characters crossing a block stay intact. */
export function* historyEntries(state: string): Generator<HistoryEntry> {
  for (const file of historyFiles(state)) {
    let fd: number
    try { fd = openSync(file, 'r') } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    try {
      let pos = fstatSync(fd).size, tail = Buffer.alloc(0)
      while (pos > 0) {
        const size = Math.min(pos, 64 * 1024), block = Buffer.alloc(size)
        pos -= size
        readSync(fd, block, 0, size, pos)
        const bytes = Buffer.concat([block, tail])
        let end = bytes.length
        for (let i = end - 1; i >= 0; i--) if (bytes[i] === 10) {
          if (i + 1 < end) { try { yield JSON.parse(bytes.subarray(i + 1, end).toString('utf8')) } catch {} }
          end = i
        }
        tail = bytes.subarray(0, end)
      }
      if (tail.length) { try { yield JSON.parse(tail.toString('utf8')) } catch {} }
    } finally { closeSync(fd) }
  }
}

/** Mutations newer than the cursor still apply. The id anchors a row among equal timestamps,
 * whose append order is preserved to match the existing newest-page response. */
export function olderHistory(state: string, chat: string, limit: number, before: string): HistoryEntry[] {
  const split = before.indexOf('|'), ts = new Date(split < 0 ? before : before.slice(0, split)).toISOString()
  const cursorId = split < 0 ? '' : before.slice(split + 1)
  const deleted = new Set<string>(), edits = new Map<string, string>(), reactions = new Map<string, string>()
  const rows: HistoryEntry[] = []
  let passedTie = false
  for (const e of historyEntries(state)) {
    if (e.chat_id !== chat) continue
    const id = e.message_id
    if (id && e.kind === 'delete') { deleted.add(id); continue }
    if (id && e.kind === 'edit') { if (!edits.has(id)) edits.set(id, e.text); continue }
    if (e.kind === 'reaction') { if (id && e.dir === 'out' && !reactions.has(id)) reactions.set(id, e.text); continue }
    if (e.ts > ts) continue
    if (e.ts === ts) {
      if (split < 0) continue
      if (!passedTie) {
        if (id === cursorId) passedTie = true
        continue
      }
    }
    if ((e.kind === 'tap' && !id) || (id && deleted.has(id))) continue
    rows.push({ ...e, ...(id && edits.has(id) ? { text: edits.get(id)! } : {}),
      ...(id && reactions.has(id) ? { extra: { ...e.extra, reaction: reactions.get(id) } } : {}) })
    if (rows.length >= limit) break
  }
  return rows.reverse()
}
