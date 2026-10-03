import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  diffSnapshots, formatChange, formatChanges, worthTelling, fetchSnapshot,
  pollCalendar, loadSnapshot, saveSnapshot,
  type CalSnapshot, type CalEventSnap,
} from '../calfeed.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-calfeed-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const NOW = '2026-08-12T12:00:00Z'
const NOW_MS = Date.parse(NOW)

function ev(id: string, over: Partial<CalEventSnap> = {}): CalEventSnap {
  return {
    id,
    summary: `event ${id}`,
    start: { dateTime: '2026-08-14T14:00:00Z' },
    end: { dateTime: '2026-08-14T15:00:00Z' },
    ...over,
  }
}

function snap(events: CalEventSnap[], takenAt = NOW): CalSnapshot {
  return { takenAt, horizonDays: 14, events }
}

// The introduction problem: on the first run everything is new, and forty
// "new invite" messages is exactly what this feature exists not to do.
test('the first snapshot produces no changes', () => {
  expect(diffSnapshots(null, snap([ev('a'), ev('b')]))).toEqual([])
})

test('an identical snapshot produces nothing', () => {
  const s = snap([ev('a'), ev('b')])
  expect(diffSnapshots(snap([ev('a'), ev('b')]), s)).toEqual([])
})

test('a new event is an invite', () => {
  const changes = diffSnapshots(snap([ev('a')]), snap([ev('a'), ev('b')]))
  expect(changes).toHaveLength(1)
  expect(changes[0].kind).toBe('invited')
})

test('a new event in the past is not news', () => {
  const past = ev('old', { start: { dateTime: '2026-08-01T09:00:00Z' }, end: { dateTime: '2026-08-01T10:00:00Z' } })
  expect(diffSnapshots(snap([]), snap([past]))).toEqual([])
})

test('a moved event reports both times', () => {
  const before = snap([ev('a')])
  const after = snap([ev('a', { start: { dateTime: '2026-08-14T09:00:00Z' }, end: { dateTime: '2026-08-14T10:00:00Z' } })])
  const [c] = diffSnapshots(before, after)
  expect(c.kind).toBe('moved')
  expect(c).toMatchObject({ from: '2026-08-14T14:00:00Z', to: '2026-08-14T09:00:00Z' })
})

// Google rewrites records constantly; second-level jitter is not a reschedule.
test('a few seconds of drift is not a move', () => {
  const after = snap([ev('a', { start: { dateTime: '2026-08-14T14:00:30Z' }, end: { dateTime: '2026-08-14T15:00:00Z' } })])
  expect(diffSnapshots(snap([ev('a')]), after)).toEqual([])
})

test('metadata churn on an otherwise unchanged event is ignored', () => {
  const after = snap([ev('a', { htmlLink: 'https://cal/x?v=2', organizer: { email: 'x@y.z' } })])
  expect(diffSnapshots(snap([ev('a')]), after)).toEqual([])
})

test('a location change is reported with both sides', () => {
  const before = snap([ev('a', { location: 'Hauptstrasse 1' })])
  const after = snap([ev('a', { location: 'Main Street 200' })])
  const [c] = diffSnapshots(before, after)
  expect(c.kind).toBe('location')
  expect(c).toMatchObject({ from: 'Hauptstrasse 1', to: 'Main Street 200' })
})

test('whitespace and case are not a location change', () => {
  const before = snap([ev('a', { location: 'Hauptstrasse 1' })])
  const after = snap([ev('a', { location: '  hauptstrasse   1 ' })])
  expect(diffSnapshots(before, after)).toEqual([])
})

test('a disappeared event inside the horizon is a cancellation', () => {
  const [c] = diffSnapshots(snap([ev('a'), ev('b')]), snap([ev('a')]))
  expect(c.kind).toBe('cancelled')
  expect(c.event.id).toBe('b')
})

test('an event marked cancelled is a cancellation too, once', () => {
  const before = snap([ev('a')])
  const mid = snap([ev('a', { status: 'cancelled' })])
  expect(diffSnapshots(before, mid)[0].kind).toBe('cancelled')
  // Still cancelled tomorrow is not news tomorrow.
  expect(diffSnapshots(mid, snap([ev('a', { status: 'cancelled' })]))).toEqual([])
})

// The bug this exists to prevent: shorten the horizon (or hit the fetch's row
// cap) and every event past the new edge vanishes from the snapshot while
// sitting untouched on the user’s calendar. "Your September is cancelled" is the
// single worst message this feature could send.
test('an event beyond the new horizon is not cancelled, it is out of view', () => {
  const far = ev('far', { start: { dateTime: '2026-09-05T10:00:00Z' }, end: { dateTime: '2026-09-05T11:00:00Z' } })
  const wide: CalSnapshot = { takenAt: NOW, horizonDays: 30, events: [far, ev('a')] }
  const narrow: CalSnapshot = { takenAt: NOW, horizonDays: 14, events: [ev('a')] }
  expect(diffSnapshots(wide, narrow)).toEqual([])
})

test('an event that has already happened is not cancelled when it drops out', () => {
  const past = ev('p', { start: { dateTime: '2026-08-10T10:00:00Z' }, end: { dateTime: '2026-08-10T11:00:00Z' } })
  expect(diffSnapshots(snap([past]), snap([]))).toEqual([])
})

test('an attendee declining is reported by name, only on the transition', () => {
  const before = snap([ev('a', { attendees: [{ email: 'jony@x.com', displayName: 'Jony', responseStatus: 'needsAction' }] })])
  const after = snap([ev('a', { attendees: [{ email: 'jony@x.com', displayName: 'Jony', responseStatus: 'declined' }] })])
  const [c] = diffSnapshots(before, after)
  expect(c.kind).toBe('declined')
  expect(c).toMatchObject({ who: 'Jony' })
  expect(diffSnapshots(after, after)).toEqual([])
})

test('the user’s own decline and a room decline are not attendee news', () => {
  const before = snap([ev('a', {
    attendees: [
      { email: 'me@x.com', self: true, responseStatus: 'needsAction' },
      { email: 'room4@x.com', resource: true, responseStatus: 'needsAction' },
    ],
  })])
  const after = snap([ev('a', {
    attendees: [
      { email: 'me@x.com', self: true, responseStatus: 'declined' },
      { email: 'room4@x.com', resource: true, responseStatus: 'declined' },
    ],
  })])
  expect(diffSnapshots(before, after)).toEqual([])
})

test('cancellations and moves sort ahead of new invites', () => {
  const before = snap([ev('a'), ev('b')])
  const after = snap([
    ev('a', { start: { dateTime: '2026-08-14T18:00:00Z' }, end: { dateTime: '2026-08-14T19:00:00Z' } }),
    ev('c'),
  ])
  expect(diffSnapshots(before, after).map(c => c.kind)).toEqual(['cancelled', 'moved', 'invited'])
})

test('one event can both move and change venue', () => {
  const before = snap([ev('a', { location: 'Office' })])
  const after = snap([ev('a', {
    location: 'Zoom',
    start: { dateTime: '2026-08-14T16:00:00Z' }, end: { dateTime: '2026-08-14T17:00:00Z' },
  })])
  expect(diffSnapshots(before, after).map(c => c.kind).sort()).toEqual(['location', 'moved'])
})

test('formatting always names the timezone', () => {
  const [c] = diffSnapshots(snap([ev('a')]), snap([
    ev('a', { start: { dateTime: '2026-08-14T09:00:00Z' }, end: { dateTime: '2026-08-14T10:00:00Z' } }),
  ]))
  const line = formatChange(c, 'America/Argentina/Buenos_Aires')
  expect(line).toContain('America/Argentina/Buenos_Aires')
  expect(line).toContain('→')
  // 14:00Z is 11:00 in Buenos Aires — the point of carrying the zone at all.
  expect(line).toContain('11:00')
})

test('an all-day event is formatted without an invented midnight', () => {
  const allDay = ev('h', { summary: 'Ferragosto', start: { date: '2026-08-15' }, end: { date: '2026-08-16' } })
  const [c] = diffSnapshots(snap([]), snap([allDay]))
  expect(formatChange(c, 'UTC')).not.toContain('00:00')
  expect(formatChanges([c], 'UTC')).toContain('Ferragosto')
})

test('far-off location tweaks are not worth interrupting, cancellations are', () => {
  const far = ev('f', { start: { dateTime: '2026-08-30T10:00:00Z' }, end: { dateTime: '2026-08-30T11:00:00Z' } })
  expect(worthTelling({ kind: 'location', event: far, to: 'x' }, NOW_MS)).toBe(false)
  expect(worthTelling({ kind: 'cancelled', event: far }, NOW_MS)).toBe(true)
  const soon = ev('s', { start: { dateTime: '2026-08-12T18:00:00Z' }, end: { dateTime: '2026-08-12T19:00:00Z' } })
  expect(worthTelling({ kind: 'location', event: soon, to: 'x' }, NOW_MS)).toBe(true)
})

test('the fetch keeps only the fields the diff reads', async () => {
  const raw = JSON.stringify({
    events: [{
      id: 'a', summary: 'standup', etag: '"123"', updated: '2026-08-12T11:59:00Z',
      conferenceData: { entryPoints: [{ uri: 'https://meet' }] },
      start: { dateTime: '2026-08-14T14:00:00Z' }, end: { dateTime: '2026-08-14T15:00:00Z' },
      attendees: [{ email: 'a@b.c', responseStatus: 'accepted', comment: 'hi' }],
    }, { summary: 'no id at all' }],
  })
  const s = (await fetchSnapshot('me@x.com', { now: new Date(NOW), fetcher: async () => raw }))!
  expect(s.events).toHaveLength(1)
  expect(JSON.stringify(s)).not.toContain('etag')
  expect(JSON.stringify(s)).not.toContain('conferenceData')
  expect(s.events[0].attendees![0]).toEqual({ email: 'a@b.c', responseStatus: 'accepted' })
})

// Storing an empty snapshot after a failed fetch would report the user’s whole
// fortnight as cancelled on the next pass.
test('a failed fetch yields null, never an empty snapshot', async () => {
  expect(await fetchSnapshot('me@x.com', { fetcher: async () => null })).toBeNull()
  expect(await fetchSnapshot('me@x.com', { fetcher: async () => 'not json' })).toBeNull()
  expect(await fetchSnapshot('me@x.com', { fetcher: async () => '{"events":"nope"}' })).toBeNull()
})

test('a poll stores the baseline and the next one diffs against it', async () => {
  const file = join(tmp, 'calfeed.json')
  const first = JSON.stringify({ events: [{ id: 'a', summary: 'standup', start: { dateTime: '2026-08-14T14:00:00Z' } }] })
  const second = JSON.stringify({ events: [{ id: 'a', summary: 'standup', start: { dateTime: '2026-08-14T09:00:00Z' } }] })

  expect(await pollCalendar('me@x.com', { file, now: new Date(NOW), fetcher: async () => first })).toEqual([])
  const changes = await pollCalendar('me@x.com', { file, now: new Date(NOW), fetcher: async () => second })
  expect(changes.map(c => c.kind)).toEqual(['moved'])
  expect(loadSnapshot(file)!.events[0].start!.dateTime).toBe('2026-08-14T09:00:00Z')
})

test('a failed poll leaves the stored baseline alone', async () => {
  const file = join(tmp, 'calfeed2.json')
  const s = snap([ev('a')])
  saveSnapshot(file, s)
  expect(await pollCalendar('me@x.com', { file, fetcher: async () => null })).toEqual([])
  expect(loadSnapshot(file)).toEqual(s)
})

test('a missing snapshot file is null, not a crash', () => {
  expect(loadSnapshot(join(tmp, 'nope.json'))).toBeNull()
})
