import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseCadence, keepInTouchDue, markKitNudged, formatKitNudge, parseKitTap, applyKitTap,
  loadKitState, saveKitState, type KitPerson, type KeepInTouchState,
} from '../keepintouch.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-kit-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const DAY = 86_400_000
const NOW = Date.parse('2026-10-01T09:00:00Z')
const ago = (d: number) => new Date(NOW - d * DAY).toISOString()
const person = (id: string, o: Partial<KitPerson> = {}): KitPerson & { notes?: { at: string; text: string }[] } =>
  ({ id, name: id, cadenceDays: 30, contacts: [], ...o })

test('cadence words and numbers parse; anything else does not', () => {
  const table: [string, number | 'off' | undefined][] = [
    ['weekly', 7], ['fortnightly', 14], ['every 2 weeks', 14], ['monthly', 30], ['quarterly', 90],
    ['every 6 weeks', 42], ['every 3 months', 90], ['45', 45], ['off', 'off'], ['never', 'off'],
    ['sometimes', undefined], ['', undefined], ['0', undefined],
  ]
  for (const [raw, want] of table) expect(parseCadence(raw)).toBe(want)
})

test('nobody without a cadence is ever due', () => {
  const p = { ...person('marco', { lastTouch: ago(900) }), cadenceDays: undefined, relationship: 'lawyer' }
  expect(keepInTouchDue([p], {}, NOW, { weeklyCap: 5 })).toEqual([])
})

test('the clock restarts at the latest of touch, contact, nudge and snooze', () => {
  const due = (p: KitPerson, s: KeepInTouchState = {}) => keepInTouchDue([p], s, NOW, { weeklyCap: 5 }).length
  expect(due(person('a', { lastTouch: ago(40) }))).toBe(1)
  expect(due(person('a', { lastTouch: ago(40), contacts: [ago(10)] }))).toBe(0)
  expect(due(person('a', { lastTouch: ago(40) }), { a: { nudgedAt: ago(5) } })).toBe(0)
  expect(due(person('a', { lastTouch: ago(40) }), { a: { snoozedUntil: new Date(NOW + DAY).toISOString() } })).toBe(0)
  // A snooze that ran out counts as the restart, not as permission.
  expect(due(person('a', { lastTouch: ago(40) }), { a: { snoozedUntil: ago(3) } })).toBe(0)
  expect(due(person('a', { lastTouch: ago(40) }), { a: { snoozedUntil: ago(31) } })).toBe(1)
  // No anchor at all means the clock never started.
  expect(due(person('a'))).toBe(0)
})

test('after a nudge they are not due until a full period later', () => {
  const p = person('a', { lastTouch: ago(90) })
  const s: KeepInTouchState = {}
  markKitNudged(s, 'a', new Date(NOW).toISOString())
  expect(keepInTouchDue([p], s, NOW + 29 * DAY, { weeklyCap: 5 })).toEqual([])
  expect(keepInTouchDue([p], s, NOW + 30 * DAY, { weeklyCap: 5 })).toHaveLength(1)
})

test('the weekly cap counts recent nudges and sends the most overdue first', () => {
  const people = [person('a', { lastTouch: ago(35) }), person('b', { lastTouch: ago(90) }), person('c', { lastTouch: ago(60) })]
  expect(keepInTouchDue(people, {}, NOW, { weeklyCap: 2 }).map(h => h.person.id)).toEqual(['b', 'c'])
  const s: KeepInTouchState = { z: { nudgedAt: ago(3) } }
  expect(keepInTouchDue(people, s, NOW, { weeklyCap: 2 }).map(h => h.person.id)).toEqual(['b'])
  expect(keepInTouchDue(people, {}, NOW, { weeklyCap: 0 })).toEqual([])
})

test('a cadence shorter than a week still gets one nudge a week, so the cap holds', () => {
  const p = person('a', { cadenceDays: 2, lastTouch: ago(10) })
  const s: KeepInTouchState = {}
  let sent = 0
  for (let d = 0; d < 7; d++) {
    for (const h of keepInTouchDue([p], s, NOW + d * DAY, { weeklyCap: 2 })) { markKitNudged(s, h.person.id, new Date(NOW + d * DAY).toISOString()); sent++ }
  }
  expect(sent).toBe(1)
  expect(keepInTouchDue([p], s, NOW + 7 * DAY, { weeklyCap: 2 })).toHaveLength(1)
})

test('a skipped person is left out', () => {
  const people = [person('a', { lastTouch: ago(40) }), person('b', { lastTouch: ago(40) })]
  expect(keepInTouchDue(people, {}, NOW, { weeklyCap: 5, skip: new Set(['a']) }).map(h => h.person.id)).toEqual(['b'])
})

test('the nudge names the person and the cadence, and its buttons survive a tap', () => {
  const [hit] = keepInTouchDue([person('Marco', { lastTouch: ago(42) })], {}, NOW, { weeklyCap: 2 })
  const n = formatKitNudge(hit, 'Marco')
  expect(n.text).toBe("It's been 6 weeks since you last spoke to Marco — you said monthly.")
  expect(n.buttons.map(b => b.label)).toEqual(['draft a message', 'snooze a month', 'stop for them'])
  expect(n.buttons[0].data).toBe('draft a check-in message to Marco')
  expect(parseKitTap(n.buttons[1].data)).toEqual({ kind: 'snooze', name: 'Marco' })
  expect(parseKitTap(n.buttons[2].data)).toEqual({ kind: 'stop', name: 'Marco' })
  const long = formatKitNudge(hit, 'Alessandro '.repeat(4).trim())
  for (const b of long.buttons) expect(Buffer.byteLength(b.data, 'utf8')).toBeLessThanOrEqual(60)
  expect(parseKitTap('remind me on 03-14: Marco')).toBeUndefined()
})

test('snooze parks the nudge a month and leaves the person alone', () => {
  const p = person('marco', { lastTouch: ago(40) })
  const s: KeepInTouchState = {}
  const r = applyKitTap([p], s, { kind: 'snooze', name: 'marco' }, NOW, () => p)!
  expect(r).toMatchObject({ peopleChanged: false, stateChanged: true })
  expect(r.line).toBe('ok — nothing about marco until 31 Oct')
  expect(Date.parse(s.marco.snoozedUntil!)).toBe(NOW + 30 * DAY)
  expect(p.cadenceDays).toBe(30)
})

test('stop removes the cadence once, notes it, and keeps lastTouch', () => {
  const p = person('marco', { lastTouch: ago(40) })
  const s: KeepInTouchState = { marco: { nudgedAt: ago(1) } }
  const r = applyKitTap([p], s, { kind: 'stop', name: 'marco' }, NOW, () => p)!
  expect(r).toMatchObject({ peopleChanged: true, stateChanged: true })
  expect(p.cadenceDays).toBeUndefined()
  expect(p.lastTouch).toBe(ago(40))
  expect(p.notes).toHaveLength(1)
  expect(p.notes![0].text).toBe('check-ins stopped (was every 30d)')
  // The snooze goes; the nudge they answered still counts toward the week.
  expect(s.marco).toEqual({ nudgedAt: ago(1) })
  p.cadenceDays = 30
  applyKitTap([p], s, { kind: 'stop', name: 'marco' }, NOW, () => p)
  expect(p.notes).toHaveLength(1)
})

test('a name that finds nobody falls through to the session', () => {
  expect(applyKitTap([], {}, { kind: 'stop', name: 'nobody' }, NOW, () => undefined)).toBeUndefined()
})

test('state round-trips and a corrupt file is moved aside', () => {
  const file = join(tmp, 'keepintouch.json')
  expect(loadKitState(file)).toEqual({})
  const s: KeepInTouchState = { marco: { nudgedAt: ago(2), snoozedUntil: ago(-5) } }
  saveKitState(file, s)
  expect(loadKitState(file)).toEqual(s)
  writeFileSync(file, '{not json')
  expect(loadKitState(file)).toEqual({})
  expect(readdirSync(tmp).some(f => f.startsWith('keepintouch.json.corrupt-'))).toBe(true)
})
