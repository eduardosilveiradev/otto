import { test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { appendUsage, readUsage, usageRows } from '../usagelog.ts'

const now = Date.parse('2026-11-14T22:00:00Z')
const plan = { at: now, seven_day: { used_percentage: 95, resets_at: now / 1000 + 86_400 } }

test('T3 bars become rows; Claude falls back to the status line only when T3 has none', () => {
  const codex = { instanceId: 'codex', usageLimits: { windows: [{ id: 'weekly', usedPercent: 100, resetsAt: '2026-11-15T21:03:00Z' }] } }
  const rows = usageRows([codex], plan, now)
  expect(rows.map(r => `${r.provider}/${r.window}=${r.usedPercent}`)).toEqual(['codex/weekly=100', 'claudeAgent/seven_day=95'])
  const claude = { instanceId: 'claudeAgent', usageLimits: { windows: [{ id: 'weekly', usedPercent: 94 }] } }
  expect(usageRows([codex, claude], plan, now).filter(r => r.provider === 'claudeAgent').map(r => r.usedPercent)).toEqual([94])
})

test('appended rows read back, filtered by time', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'usage-')), 'usage-history.jsonl')
  appendUsage(file, usageRows([], plan, now))
  appendUsage(file, usageRows([], plan, now + 600_000))
  expect(readUsage(file).length).toBe(2)
  expect(readUsage(file, new Date(now + 1).toISOString()).length).toBe(1)
})
