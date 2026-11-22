import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { connectionLog } from '../connectionlog.ts'

test('transport events append across invocations with codes and timestamps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-connection-')), file = join(dir, 'events.jsonl')
  try {
    connectionLog(file, 'socket.open', { device: 'placeholder' })
    connectionLog(file, 'socket.close', { code: 1001 })
    connectionLog(file, 'bark.push', { status: 503, attempt: 0 })
    connectionLog(file, 'whatsapp.poll', { status: 'network' })
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(x => JSON.parse(x))
    expect(rows).toHaveLength(4)
    expect(rows[1].code).toBe(1001)
    expect(rows[2].status).toBe(503)
    expect(rows.every(r => Number.isFinite(Date.parse(r.at)))).toBe(true)
  } finally { rmSync(dir, { recursive: true }) }
})
