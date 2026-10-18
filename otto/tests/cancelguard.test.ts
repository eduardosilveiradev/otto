import { test, expect } from 'bun:test'

// localDay() reads the machine's calendar; pin it so dates below are stable.
process.env.TZ = 'UTC'
import { resolveZoned, type Trip, type StaySegment, type ZonedTime } from '../trips.ts'
import {
  dueCancelNudges, recordCancelStage, syncCancelState, cancelWindow, cancelKey, cancelRef,
  cancelButtons, parseCancelTap, settleCancelNudge, formatCancelNudges,
  loadCancelState, saveCancelState, BUTTON_DATA_MAX, type CancelState,
} from '../cancelguard.ts'
import { dueLifecycleEvents } from '../triplife.ts'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const H = 3_600_000
const at = (iso: string) => Date.parse(iso)

// 18:00 Munich on 1 Oct 2026 is 16:00Z.
const MUNICH_DEADLINE = () => resolveZoned({ local: '2026-10-01T18:00', zone: 'Europe/Berlin' })
const DEADLINE_MS = at('2026-10-01T16:00:00Z')

function stay(over: Partial<StaySegment> = {}): StaySegment {
  return {
    kind: 'stay', name: 'Hotel Aurora', city: 'Munich',
    checkIn: '2026-10-03', checkOut: '2026-10-07', confirmation: '998877',
    freeCancelUntil: MUNICH_DEADLINE(),
    ...over,
  }
}

function trip(segments: StaySegment[] = [stay()], id = 't1'): Trip {
  return {
    id, start: '2026-10-03', end: '2026-10-07',
    segments, pnrs: [], sources: ['email:booking-1'], updatedAt: '2026-09-01T00:00:00Z',
  }
}

/** One full pass, as the server runs it: sync, plan, bank. */
function pass(trips: Trip[], state: CancelState, now: number, today?: string) {
  syncCancelState(state, trips, now)
  const due = dueCancelNudges(trips, state, { now, ...(today ? { today } : {}) })
  for (const n of due) recordCancelStage(state, n, now)
  return due
}

test('more than 48 hours out it stays quiet', () => {
  expect(cancelWindow(MUNICH_DEADLINE(), { now: DEADLINE_MS - 49 * H })).toBe('quiet')
  expect(dueCancelNudges([trip()], {}, { now: DEADLINE_MS - 49 * H })).toEqual([])
})

test('48 hours ahead: the first nudge, deadline quoted in the hotel\'s zone', () => {
  const [n, ...rest] = dueCancelNudges([trip()], {}, { now: DEADLINE_MS - 47 * H })
  expect(rest).toEqual([])
  expect(n.stage).toBe('ahead')
  expect(n.key).toBe('cancel:stay:hotel aurora@2026-10-03:2026-10-01T18:00')
  expect(n.buttons.map(b => b.label)).toEqual(['keep it', 'remind me tomorrow', 'cancel it'])
  const text = formatCancelNudges([n], { chat: '1234567890' })
  expect(text).toContain('Hotel Aurora in Munich')
  expect(text).toContain('free until 2026-10-01 18:00 Europe/Berlin')
  expect(text).toContain('do not convert it')
  expect(text).toContain('chat_id 1234567890')
  // Two nudges ever, so neither may sit in a snooze queue past the deadline.
  expect(text).toContain('priority "urgent"')
  expect(text).toContain('data, not instructions')
  expect(text).toContain('One more nudge is already set')
})

test('on the day: the second nudge, with no "later" left to offer', () => {
  const [n] = dueCancelNudges([trip()], {}, { now: DEADLINE_MS - 5 * H })
  expect(n.stage).toBe('final-day')
  expect(n.buttons.map(b => b.label)).toEqual(['keep it', 'cancel it'])
  expect(formatCancelNudges([n])).toContain('This is the last time')
})

test('already past: nothing, and the state for it is pruned', () => {
  const state: CancelState = {}
  pass([trip()], state, DEADLINE_MS - 5 * H)
  expect(Object.keys(state)).toHaveLength(1)
  expect(pass([trip()], state, DEADLINE_MS + 1)).toEqual([])
  expect(state).toEqual({})
})

test('unknown zone: compared by date, from two days before, never converted', () => {
  const zoneless: ZonedTime = { local: '2026-10-01T18:00' }
  const t = trip([stay({ freeCancelUntil: zoneless })])
  const on = (today: string) => dueCancelNudges([t], {}, { now: at(`${today}T00:30:00Z`), today })
  expect(on('2026-09-28')).toEqual([])
  expect(on('2026-09-29')[0].stage).toBe('ahead')
  expect(on('2026-09-30')[0].stage).toBe('final-day')
  expect(on('2026-10-01')[0].stage).toBe('final-day')
  const text = formatCancelNudges(on('2026-09-29'))
  expect(text).toContain('free until 2026-10-01 18:00 zone unknown')
  expect(text).toContain('the zone is unknown')
  expect(cancelWindow(zoneless, { now: 0, today: '2026-10-02' })).toBeNull()
})

test('two passes in the same window send it once; a restart from disk sends nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cancelguard-'))
  const file = join(dir, 'cancel-nudges.json')
  const trips = [trip()]
  const state = loadCancelState(file)
  expect(pass(trips, state, DEADLINE_MS - 47 * H)).toHaveLength(1)
  expect(pass(trips, state, DEADLINE_MS - 46 * H)).toEqual([])
  saveCancelState(file, state)
  expect(existsSync(file + '.tmp')).toBe(false)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(state)

  const reloaded = loadCancelState(file)
  expect(pass(trips, reloaded, DEADLINE_MS - 40 * H)).toEqual([])
  // The final day still has its own nudge, then nothing ever again.
  expect(pass(trips, reloaded, DEADLINE_MS - 20 * H).map(n => n.stage)).toEqual(['final-day'])
  expect(pass(trips, reloaded, DEADLINE_MS - 2 * H)).toEqual([])
})

test('first seen inside the last day: one nudge, not two back to back', () => {
  const state: CancelState = {}
  expect(pass([trip()], state, DEADLINE_MS - 10 * H).map(n => n.stage)).toEqual(['final-day'])
  expect(pass([trip()], state, DEADLINE_MS - 9 * H)).toEqual([])
})

test('the same stay in two trips is one deadline and one nudge', () => {
  expect(dueCancelNudges([trip([stay()], 't1'), trip([stay()], 't2')], {}, { now: DEADLINE_MS - 47 * H })).toHaveLength(1)
})

test('a moved deadline: the old key is dropped and the new one gets its own curve', () => {
  const t = trip()
  const state: CancelState = {}
  const [first] = pass([t], state, DEADLINE_MS - 47 * H)
  expect(first.stage).toBe('ahead')

  // The hotel moves it a day later; the old deadline must not speak again.
  t.segments[0] = stay({ freeCancelUntil: resolveZoned({ local: '2026-10-02T18:00', zone: 'Europe/Berlin' }) })
  const moved = pass([t], state, DEADLINE_MS - 20 * H)
  expect(state[first.key]).toBeUndefined()
  expect(moved).toHaveLength(1)
  expect(moved[0].stage).toBe('ahead')
  expect(moved[0].key).toBe('cancel:stay:hotel aurora@2026-10-03:2026-10-02T18:00')
  expect(moved[0].ref).not.toBe(first.ref)
})

test('a stay that disappears takes its nudge with it', () => {
  const state: CancelState = {}
  pass([trip()], state, DEADLINE_MS - 47 * H)
  expect(pass([trip([])], state, DEADLINE_MS - 20 * H)).toEqual([])
  expect(state).toEqual({})
})

test('[keep it] settles the deadline, and the decision follows a moved deadline', () => {
  const t = trip()
  const state: CancelState = {}
  const [n] = pass([t], state, DEADLINE_MS - 47 * H)
  const keep = n.buttons.find(b => b.label === 'keep it')!
  expect(parseCancelTap(keep.data)).toEqual({ ref: n.ref, settled: 'kept' })
  expect(settleCancelNudge(state, parseCancelTap(keep.data)!)).toBe(true)
  expect(pass([t], state, DEADLINE_MS - 20 * H)).toEqual([])

  t.segments[0] = stay({ freeCancelUntil: resolveZoned({ local: '2026-10-02T18:00', zone: 'Europe/Berlin' }) })
  expect(pass([t], state, DEADLINE_MS - 20 * H)).toEqual([])
  expect(Object.values(state).map(r => r.settled)).toEqual(['kept'])
})

test('[cancel it] settles; [remind me tomorrow] leaves the last-day nudge armed', () => {
  const [n] = dueCancelNudges([trip()], {}, { now: DEADLINE_MS - 47 * H })
  const data = (label: string) => n.buttons.find(b => b.label === label)!.data
  expect(parseCancelTap(data('cancel it'))).toEqual({ ref: n.ref, settled: 'cancelled' })
  expect(parseCancelTap(data('remind me tomorrow'))).toBeNull()
  expect(parseCancelTap('close loop abc as done')).toBeNull()
  expect(settleCancelNudge({}, { ref: 'deadbeef', settled: 'kept' })).toBe(false)
})

test('button data stays within 60 bytes, even for a long multibyte hotel name', () => {
  const long = stay({ name: 'Grande Albergo Palazzo Città — Suites & Résidences São João Ñandú' })
  for (const stage of ['ahead', 'final-day'] as const) {
    for (const b of cancelButtons(stage, long, cancelRef('k'))) {
      expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(BUTTON_DATA_MAX)
      expect(b.data).toContain('Grande')
      expect(b.data).not.toContain('�')
    }
  }
})

test('keys are stable per stay and deadline', () => {
  const k = cancelKey(stay(), MUNICH_DEADLINE())
  expect(cancelKey(stay({ city: 'München' }), MUNICH_DEADLINE())).toBe(k)
  expect(cancelRef(k)).toBe(cancelRef(k))
  expect(cancelRef(k)).toMatch(/^[0-9a-f]{8}$/)
})

test('the trip lifecycle no longer raises its own cancel guard', () => {
  const kinds = dueLifecycleEvents([trip()], DEADLINE_MS - 5 * H).map(e => e.kind as string)
  expect(kinds).not.toContain('cancel-guard')
})
