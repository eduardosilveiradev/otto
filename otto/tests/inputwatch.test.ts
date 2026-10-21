import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  touch, usualGapMs, quietInputs, formatQuietLine, inputsStatus, observeDesk, loadInputs, saveInputs, recordInput,
  type InputsState, type InputRecord, type QuietInput,
} from '../inputwatch.ts'
import { sectionLabels } from '../brief.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-inputwatch-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const NOW = Date.parse('2026-08-12T09:00:00Z')
const h = (n: number) => n * 3_600_000
const empty = (): InputsState => ({ v: 1, inputs: {} })
/** n silences of `ms` each, ending just before NOW. */
const rec = (lastSeen: number, n: number, ms: number, endAt = NOW - h(1)): InputRecord =>
  ({ lastSeen, silences: Array.from({ length: n }, (_, i) => ({ ms, at: endAt - i * h(1) })) })
const withRec = (id: string, r: InputRecord): InputsState => ({ v: 1, inputs: { [id]: r } })

test('a touch inside the minimum gap moves lastSeen and records nothing', () => {
  const t = NOW - h(5)
  const st = touch(touch(empty(), 'desk', t), 'desk', t + 5 * 60_000)
  expect(st.inputs.desk.silences.length).toBe(0)
  expect(st.inputs.desk.lastSeen).toBe(t + 5 * 60_000)
})

test('a gap of at least thirty minutes becomes a silence', () => {
  const t = NOW - h(5)
  const st = touch(touch(empty(), 'desk', t), 'desk', t + h(2))
  expect(st.inputs.desk.silences).toEqual([{ ms: h(2), at: t + h(2) }])
})

test('no history, no flag', () => {
  const st = touch(empty(), 'desk', NOW - h(30))
  expect(usualGapMs(st.inputs.desk, NOW)).toBeUndefined()
  expect(quietInputs(st, NOW)).toEqual([])
  const s = inputsStatus(st, NOW)
  expect(s.verdict).toBe('unknown')
  expect(s.detail).toContain('0/5')
})

test('the usual gap is twice the p90 of recent silences, with a floor', () => {
  expect(usualGapMs(rec(NOW, 10, h(8)), NOW)).toBe(h(16))
  expect(usualGapMs(rec(NOW, 10, 40 * 60_000), NOW)).toBe(h(6))
})

test('quiet past the usual gap is flagged, under it is not', () => {
  expect(quietInputs(withRec('desk', rec(NOW - h(12), 10, h(8))), NOW)).toEqual([])
  expect(quietInputs(withRec('desk', rec(NOW - h(20), 10, h(8))), NOW)).toEqual([
    { id: 'desk', label: 'desk watcher', quietMs: h(20), usualMs: h(16), lastSeen: NOW - h(20) },
  ])
})

test('an outage ending is not learned as rhythm', () => {
  const r = rec(NOW - h(60), 10, h(8), NOW - h(61))
  const st = touch(withRec('desk', r), 'desk', r.lastSeen + h(48))
  expect(st.inputs.desk.silences.length).toBe(10)
  expect(st.inputs.desk.lastSeen).toBe(r.lastSeen + h(48))
})

test('a dead input stays flagged, and its outage is not learned when it ends', () => {
  const r = rec(NOW - 20 * 86_400_000, 10, h(8), NOW - 20 * 86_400_000 - h(1))
  const st = withRec('desk', r)
  expect(quietInputs(st, NOW).map(q => q.id)).toEqual(['desk'])
  expect(touch(st, 'desk', NOW).inputs.desk.silences.length).toBe(10)
})

test('silences older than the window do not count', () => {
  const old = rec(NOW, 10, h(8), NOW - 20 * 86_400_000)
  const r = { lastSeen: NOW, silences: [...old.silences, { ms: h(1), at: NOW - h(2) }, { ms: h(1), at: NOW - h(1) }] }
  expect(usualGapMs(r, NOW)).toBeUndefined()
})

test('the silence list is bounded', () => {
  let st = empty()
  for (let i = 0; i < 70; i++) st = touch(st, 'desk', NOW - h(200) + i * h(1))
  expect(st.inputs.desk.silences.length).toBe(60)
})

test('unknown inputs are capped', () => {
  let st = empty()
  for (let i = 0; i < 32; i++) st = touch(st, `webhook.s${i}`, NOW)
  expect(Object.keys(st.inputs).length).toBe(32)
  expect(touch(st, 'webhook.extra', NOW)).toBe(st)
  expect(touch(st, 'webhook.s3', NOW + 1).inputs['webhook.s3'].lastSeen).toBe(NOW + 1)
})

test('observeDesk reads the file mtime', () => {
  const f = join(tmp, 'desk-state')
  writeFileSync(f, 'present')
  const set = (ms: number) => utimesSync(f, ms / 1000, ms / 1000)
  set(NOW - 60_000)
  expect(observeDesk(empty(), f, NOW).inputs.desk.lastSeen).toBeCloseTo(NOW - 60_000, -1)
  set(NOW - 10 * 60_000)
  expect(observeDesk(empty(), f, NOW).inputs.desk).toBeUndefined()
  const st = empty()
  expect(observeDesk(st, join(tmp, 'nope'), NOW)).toBe(st)
})

test('the brief line is not a section', () => {
  const q: QuietInput[] = [{ id: 'desk', label: 'desk watcher', quietMs: h(20), usualMs: h(16), lastSeen: NOW - h(20) }]
  const line = formatQuietLine(q)!
  expect(line.startsWith('Quiet — ')).toBe(true)
  expect(line).toContain('desk watcher silent 20 h (usual gap under 16 h)')
  expect(formatQuietLine([])).toBeUndefined()
  expect(sectionLabels(line)).toEqual([])
})

test('the line names at most three', () => {
  const q: QuietInput[] = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, label: id, quietMs: h(20 - i), usualMs: h(6), lastSeen: NOW - h(20 - i) }))
  const line = formatQuietLine(q)!
  expect(line).toContain('a silent')
  expect(line).toContain('c silent')
  expect(line).not.toContain('d silent')
  expect(line).toContain('+2 more')
})

test('status verdicts', () => {
  expect(inputsStatus(empty(), NOW).verdict).toBe('unknown')
  const up = inputsStatus(withRec('share', rec(NOW - h(2), 10, h(8))), NOW)
  expect(up.verdict).toBe('up')
  expect(up.detail).toContain('last seen 2 h ago')
  const st: InputsState = { v: 1, inputs: { desk: rec(NOW - h(20), 10, h(8)), share: rec(NOW - h(30), 10, h(8)), other: rec(NOW - h(1), 2, h(8)) } }
  const bad = inputsStatus(st, NOW)
  expect(bad.verdict).toBe('degraded')
  expect(bad.detail).toContain('QUIET')
  expect(bad.detail).toContain('other learning (2/5)')
  expect(bad.at).toBe(NOW - h(20))
})

test('load tolerates a missing or corrupt file', () => {
  const dir = mkdtempSync(join(tmp, 'l-'))
  const f = join(dir, 'inputs.json')
  expect(loadInputs(f)).toEqual({ v: 1, inputs: {} })
  writeFileSync(f, 'garbage')
  expect(loadInputs(f)).toEqual({ v: 1, inputs: {} })
  expect(readdirSync(dir).some(n => n.startsWith('inputs.json.corrupt-'))).toBe(true)
  expect(existsSync(f)).toBe(false)
  const st = withRec('desk', rec(NOW, 2, h(1)))
  saveInputs(f, st)
  expect(loadInputs(f)).toEqual(st)
})

test('recordInput is a safe one-liner', () => {
  const f = join(mkdtempSync(join(tmp, 'r-')), 'inputs.json')
  recordInput(f, 'share', NOW - h(2))
  recordInput(f, 'share', NOW)
  expect(loadInputs(f).inputs.share.silences.length).toBe(1)
  expect(() => recordInput(join(tmp, 'no', 'such', 'dir', 'inputs.json'), 'share')).not.toThrow()
})
