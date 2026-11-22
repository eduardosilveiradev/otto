import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LateVoice } from '../latevoice.ts'

test('pending lines resume after restart; completed files survive another restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-latevoice-')), file = join(dir, 'voice.json')
  try {
    new LateVoice(file).start('message', 'say this')
    const resumed = new LateVoice<{ id: string }>(file)
    expect(resumed.pending.get('message')).toBe('say this')
    resumed.finish('message', { id: 'file' })
    const finished = new LateVoice<{ id: string }>(file)
    expect(finished.voices.get('message')).toEqual({ id: 'file' })
    expect(finished.pending.size).toBe(0)
    finished.start('failed', 'line')
    finished.finish('failed', null)
    expect(new LateVoice(file).pending.size).toBe(0)
  } finally { rmSync(dir, { recursive: true }) }
})
