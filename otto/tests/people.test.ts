import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  normalizeEmail, normalizePhone, normalizeHandle,
  dominantOffset, formatOffset, ingestAttendees, mentionPerson,
  recordPerson, offsetForZone, displayName, describePerson,
  findPerson, medianGapDays, cadenceDrift, callWindow, goodHourToCall,
  formatPerson, formatDrift, loadPeople, savePeople,
  type Person,
} from '../people.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-people-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const DAY = 24 * 60 * 60 * 1000

test('plus tags merge, gmail dots do not', () => {
  expect(normalizeEmail('Alex+shopping@X.com')).toBe('alex@x.com')
  // first.last@ is two different people at a company that uses that scheme.
  expect(normalizeEmail('first.last@example.org')).toBe('first.last@example.org')
  expect(normalizeEmail('not an address')).toBe('')
})

test('offsets are formatted with a sign and both fields', () => {
  expect(formatOffset(-180)).toBe('UTC−03:00')
  expect(formatOffset(330)).toBe('UTC+05:30')
})

// One email from an airport must not relocate a person.
test('the dominant offset outvotes a single outlier', () => {
  expect(dominantOffset([-180, -180, -180, 480, -180])).toBe(-180)
  expect(dominantOffset([])).toBeUndefined()
})

test('a second address for a known name folds into one person', () => {
  const people: Person[] = []
  ingestAttendees(people, [{ email: 'alex@example.com', displayName: 'Alex Taylor', at: '2026-08-11T09:00:00Z' }])
  ingestAttendees(people, [{ email: 'alex.taylor@example.com', displayName: 'Alex Taylor', at: '2026-08-12T09:00:00Z' }])
  expect(people).toHaveLength(1)
  expect(people[0].addresses.sort()).toEqual(['alex.taylor@example.com', 'alex@example.com'])
})

test('a name the user mentioned is claimed by the first meeting with their address', () => {
  const people: Person[] = []
  mentionPerson(people, 'Alex')
  mentionPerson(people, 'Alex')
  expect(people[0].mentions).toBe(2)
  ingestAttendees(people, [{ email: 'alex@example.com', displayName: 'Alex', at: '2026-08-11T09:00:00Z' }])
  expect(people).toHaveLength(1)
  expect(people[0].id).toBe('alex@example.com')
  expect(people[0].mentions).toBe(2)
})

test('calendar attendees are contact without a direction', () => {
  const people: Person[] = []
  ingestAttendees(people, [
    { email: 'user@example.com', displayName: 'Jony', at: '2026-08-11T14:00:00Z' },
    { email: 'me@x.com', self: true, at: '2026-08-11T14:00:00Z' },
    { email: 'room4@x.com', resource: true, at: '2026-08-11T14:00:00Z' },
  ])
  expect(people).toHaveLength(1)
  expect(people[0].contacts).toHaveLength(1)
  expect(people[0].inbound.count).toBe(0)
})

// One long silence in an otherwise daily correspondence must not become the
// rhythm — the mean of these gaps is ten days, which describes nobody.
test('the median gap is the middle gap, not the average', () => {
  const contacts = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-09-01'].map(d => `${d}T09:00:00Z`)
  expect(medianGapDays(contacts)).toBe(1)
  expect(medianGapDays(['2026-08-01T09:00:00Z', '2026-08-03T09:00:00Z', '2026-08-09T09:00:00Z'])).toBe(4)
  expect(medianGapDays(['2026-08-01T09:00:00Z'])).toBeUndefined()
})

function weekly(person: Person, weeks: number, endMs: number): Person {
  for (let i = weeks - 1; i >= 0; i--) person.contacts.push(new Date(endMs - i * 7 * DAY).toISOString())
  return person
}

test('drift is measured against the person\'s own rhythm', () => {
  const now = Date.parse('2026-08-12T12:00:00Z')
  const weeklyGuy: Person = {
    id: 'a@x.com', name: 'Weekly', addresses: ['a@x.com'], aliases: [], offsetSamples: [],
    inbound: { count: 5 }, outbound: { count: 5 }, contacts: [], updatedAt: '',
  }
  // Six weekly contacts, then a month of silence: 4x the user’s own gap.
  weekly(weeklyGuy, 6, now - 28 * DAY)

  const rareGuy: Person = {
    ...weeklyGuy, id: 'b@x.com', name: 'Rare', addresses: ['b@x.com'],
    contacts: [0, 120, 240, 360].map(d => new Date(now - (d + 30) * DAY).toISOString()),
  }

  const drift = cadenceDrift([weeklyGuy, rareGuy], now)
  expect(drift.map(d => d.person.name)).toEqual(['Weekly'])
  expect(drift[0].ratio).toBeGreaterThan(2.5)
  expect(formatDrift(drift[0])).toContain('silent 28d')
})

test('someone with almost no history is never drifting', () => {
  const now = Date.parse('2026-08-12T12:00:00Z')
  const thin: Person = {
    id: 'c@x.com', addresses: ['c@x.com'], aliases: [], offsetSamples: [],
    inbound: { count: 1 }, outbound: { count: 0 },
    contacts: [new Date(now - 400 * DAY).toISOString(), new Date(now - 399 * DAY).toISOString()],
    updatedAt: '',
  }
  expect(cadenceDrift([thin], now)).toEqual([])
})

test('a daily correspondent is not overdue by lunchtime', () => {
  const now = Date.parse('2026-08-12T12:00:00Z')
  const daily: Person = {
    id: 'd@x.com', addresses: ['d@x.com'], aliases: [], offsetSamples: [],
    inbound: { count: 9 }, outbound: { count: 0 },
    contacts: Array.from({ length: 9 }, (_, i) => new Date(now - (i + 3) * DAY).toISOString()),
    updatedAt: '',
  }
  expect(cadenceDrift([daily], now)).toEqual([])
})

test('the call window is the overlap of both working days', () => {
  // Berlin (UTC+2) and Buenos Aires (UTC-3): five hours apart.
  const w = callWindow(120, -180)!
  expect(w.theirStart).toBe('14:00')
  expect(w.theirEnd).toBe('18:00')
  expect(w.yourStart).toBe('09:00')
  expect(w.yourEnd).toBe('13:00')
  expect(w.minutes).toBe(4 * 60)
})

test('the same zone overlaps completely', () => {
  const w = callWindow(-180, -180)!
  expect(w.theirStart).toBe('09:00')
  expect(w.yourEnd).toBe('18:00')
})

// The wrap case: their morning and the user’s afternoon land on different UTC days,
// so without the ±24h shift this overlap is invisible.
test('a window that spans a UTC day boundary is still found', () => {
  const w = callWindow(12 * 60, -8 * 60, { yourDay: [12 * 60, 16 * 60] })!
  expect(w.minutes).toBe(180)
  expect(w.theirStart).toBe('09:00')
  expect(w.yourStart).toBe('13:00')
})

test('no overlap says so rather than inventing an hour', () => {
  expect(callWindow(-180, 660)).toBeNull()
})

test('a person with no observed offset has no call window', () => {
  const people: Person[] = []
  recordPerson(people, { email: 'user@example.com' })
  expect(goodHourToCall(people[0], -180)).toBeNull()
})

// offsetSamples are no longer collected, but records on disk still carry them.
test('the call window comes from offsets already on record', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Alex', email: 'alex@example.com' }).offsetSamples = [120, 120, 120]
  const w = goodHourToCall(people[0], -180)!
  expect(w.theirStart).toBe('14:00')
  expect(w.yourStart).toBe('09:00')
})

test('a person summarises to one line with their rhythm and zone', () => {
  const people: Person[] = []
  const p = recordPerson(people, { name: 'Alex Taylor', email: 'alex@example.com' })
  Object.assign(p, { org: 'Acme S.r.l.', offsetSamples: [120], inbound: { count: 1 }, contacts: ['2026-08-11T07:00:00.000Z'] })
  const line = formatPerson(people[0], Date.parse('2026-08-12T09:00:00Z'))
  expect(line).toContain('Alex Taylor')
  expect(line).toContain('Acme S.r.l.')
  expect(line).toContain('UTC+02:00')
  expect(line).toContain('1 in / 0 out')
})

// ---------------------------------------------------------------------------
// What the user said
// ---------------------------------------------------------------------------

test('a phone keeps its country code and refuses to invent one', () => {
  expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958')
  expect(normalizePhone('(11) 98765-4321')).toBe('11987654321')
  expect(normalizePhone('12345')).toBe('')
  expect(normalizePhone('not a phone')).toBe('')
})

test('a handle is the same handle however it was typed', () => {
  expect(normalizeHandle('@Jony')).toBe('jony')
  expect(normalizeHandle(' jony ')).toBe('jony')
})

test('what the user says about someone becomes their record', () => {
  const people: Person[] = []
  recordPerson(people, {
    name: 'Alex Taylor', email: 'Alex@Example.com', relationship: 'lawyer',
    city: 'Munich', timezone: 'Europe/Berlin', note: 'handling the visa',
    at: '2026-08-01T10:00:00.000Z',
  })
  const p = findPerson(people, 'alex@example.com')!
  expect(p.id).toBe('alex@example.com')
  expect(p.relationship).toBe('lawyer')
  expect(p.city).toBe('Munich')
  expect(p.timezone).toBe('Europe/Berlin')
  expect(p.notes).toEqual([{ at: '2026-08-01T10:00:00.000Z', text: 'handling the visa' }])
})

test('recording needs somebody to record it about', () => {
  expect(() => recordPerson([], { note: 'nice guy' })).toThrow(/name, email, phone or handle/)
})

test('a new stated value wins and the old one survives as a note', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Alex', org: 'Acme', at: '2026-01-01T00:00:00.000Z' })
  recordPerson(people, { name: 'Alex', org: 'Globex', at: '2026-08-01T00:00:00.000Z' })
  const p = findPerson(people, 'Alex')!
  expect(p.org).toBe('Globex')
  expect(p.notes?.map(n => n.text)).toEqual(['org was Acme'])
  expect(people).toHaveLength(1)
})

test('restating the same fact is not a change', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Alex', city: 'Munich' })
  recordPerson(people, { name: 'Alex', city: 'Munich' })
  expect(findPerson(people, 'Alex')!.notes).toBeUndefined()
})

test('the same note said twice is kept once', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Alex', note: 'allergic to shellfish' })
  recordPerson(people, { name: 'Alex', note: 'allergic to shellfish' })
  expect(findPerson(people, 'Alex')!.notes).toHaveLength(1)
})

test('a name-only record is promoted when an address finally turns up', () => {
  const people: Person[] = []
  mentionPerson(people, 'Alex')
  recordPerson(people, { name: 'Alex', note: 'my lawyer' })
  recordPerson(people, { name: 'Alex', email: 'alex@example.com' })
  expect(people).toHaveLength(1)
  expect(people[0].id).toBe('alex@example.com')
  expect(people[0].mentions).toBe(1)
  expect(people[0].notes?.[0].text).toBe('my lawyer')
})

test('the short name the user actually uses finds the person they gave a full name to', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Alex Taylor', email: 'alex@example.com', relationship: 'lawyer' })
  recordPerson(people, { name: 'Alex', note: 'wants the signed copy by Friday' })
  expect(people).toHaveLength(1)
  expect(people[0].relationship).toBe('lawyer')
  expect(people[0].name).toBe('Alex Taylor')
  expect(people[0].notes).toHaveLength(1)
  expect(findPerson(people, 'alex')).toBe(people[0])
})

test('a full name finds the person recorded under just their first', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Alex', note: 'my lawyer' })
  recordPerson(people, { name: 'Alex Taylor', city: 'Munich' })
  expect(people).toHaveLength(1)
  expect(people[0].city).toBe('Munich')
})

test('two people sharing a first name are never merged', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Alex Taylor', email: 'alex.t@example.com' })
  recordPerson(people, { name: 'Alex Brown', email: 'brown@example.net' })
  expect(people).toHaveLength(2)
  expect(() => recordPerson(people, { name: 'Alex', note: 'called today' }))
    .toThrow(/more than one Alex: Alex Taylor, Alex Brown/)
  expect(findPerson(people, 'Alex')).toBeUndefined()
  // Naming which one still works, and nobody gained a note they did not earn.
  recordPerson(people, { name: 'Alex Brown', note: 'called today' })
  expect(findPerson(people, 'alex.t@example.com')!.notes).toBeUndefined()
})

test('a truncated name is not a match', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Alex Taylor' })
  recordPerson(people, { name: 'Marc' })
  expect(people).toHaveLength(2)
})

test('a handle and a phone each find the person again', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Sam', handle: '@samb', phone: '+1 555 010-4321' })
  recordPerson(people, { handle: 'SamB', note: 'moving to Berlin' })
  recordPerson(people, { phone: '+15550104321', city: 'Berlin' })
  expect(people).toHaveLength(1)
  expect(people[0].city).toBe('Berlin')
  expect(people[0].notes?.[0].text).toBe('moving to Berlin')
})

test('a zone resolves to the offset in force that day, not a cached one', () => {
  expect(offsetForZone('Europe/Berlin', new Date('2026-01-15T12:00:00Z'))).toBe(60)
  expect(offsetForZone('Europe/Berlin', new Date('2026-07-15T12:00:00Z'))).toBe(120)
  expect(offsetForZone('America/Argentina/Buenos_Aires', new Date('2026-07-15T12:00:00Z'))).toBe(-180)
  expect(offsetForZone('Mars/Olympus')).toBeUndefined()
})

test('a stated zone beats offsets sampled off the wire', () => {
  const people: Person[] = []
  // Their old mail was stamped +0000 by a server that is nowhere near them.
  recordPerson(people, { name: 'Alex', email: 'alex@example.com' }).offsetSamples = [0, 0, 0]
  expect(goodHourToCall(people[0], -180, new Date('2026-08-12T12:00:00Z'))!.theirStart).toBe('12:00')
  recordPerson(people, { email: 'alex@example.com', timezone: 'Europe/Berlin' })
  const w = goodHourToCall(people[0], -180, new Date('2026-08-12T12:00:00Z'))!
  expect(w.theirStart).toBe('14:00')
  expect(w.yourStart).toBe('09:00')
})

test('a person reads back with the newest thing said about them first', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Alex Taylor', email: 'alex@example.com', relationship: 'lawyer', city: 'Munich', timezone: 'Europe/Berlin', at: '2026-01-05T00:00:00.000Z', note: 'met at the Hamburg thing' })
  recordPerson(people, { name: 'Alex Taylor', note: 'wants the signed copy by Friday', at: '2026-08-10T00:00:00.000Z' })
  const text = describePerson(people[0], { now: Date.parse('2026-08-12T09:00:00Z'), yourOffsetMinutes: -180 })
  const lines = text.split('\n')
  expect(lines[0]).toContain('Alex Taylor')
  expect(lines[0]).toContain('lawyer')
  expect(lines[0]).toContain('Munich')
  expect(text).toContain('alex@example.com')
  expect(text).toContain('Europe/Berlin')
  expect(text).toContain('good hour to call: their 14:00–18:00, your 09:00–13:00')
  expect(text.indexOf('wants the signed copy')).toBeLessThan(text.indexOf('met at the Hamburg thing'))
  expect(text).toContain('2026-08-10  wants the signed copy by Friday')
})

test('someone with no zone is asked about rather than guessed at', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Alex' })
  const text = describePerson(people[0], { yourOffsetMinutes: -180 })
  expect(text).toContain('no timezone on record')
})

test('a person nobody named still displays as something', () => {
  const people: Person[] = []
  recordPerson(people, { handle: '@jony' })
  expect(displayName(people[0])).toBe('jony')
  expect(describePerson(people[0])).toContain('@jony')
})

test('notes are capped without losing the newest', () => {
  const people: Person[] = []
  for (let i = 0; i < 45; i++) recordPerson(people, { name: 'Alex', note: `thing ${i}` })
  const notes = people[0].notes!
  expect(notes).toHaveLength(40)
  expect(notes[notes.length - 1].text).toBe('thing 44')
  expect(notes[0].text).toBe('thing 5')
})

test('people round-trip through disk', () => {
  const file = join(tmp, 'people.json')
  const people: Person[] = []
  recordPerson(people, { email: 'a@example.com', note: 'met at the conference' })
  savePeople(file, people)
  expect(loadPeople(file)).toEqual(people)
  expect(loadPeople(join(tmp, 'nope.json'))).toEqual([])
})

// ---------------------------------------------------------------------------
// Birthdays
// ---------------------------------------------------------------------------

test('a birthday is stored exactly as the user gave it', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Sam', birthday: '03-14' })
  recordPerson(people, { name: 'Alex', birthday: ' 1986-10-16 ' })
  expect(people.map(p => p.birthday)).toEqual(['03-14', '1986-10-16'])
})

test('a malformed birthday is refused before anything is recorded', () => {
  const people: Person[] = []
  expect(() => recordPerson(people, { name: 'Sam', birthday: '14/03' })).toThrow(/MM-DD or YYYY-MM-DD/)
  expect(() => recordPerson(people, { name: 'Sam', birthday: '2023-02-29' })).toThrow(/MM-DD or YYYY-MM-DD/)
  expect(people).toEqual([])
})

test('a corrected birthday replaces the old one and keeps it as a note', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Sam', birthday: '03-14', at: '2026-01-01T00:00:00.000Z' })
  recordPerson(people, { name: 'Sam', birthday: '1990-03-15', at: '2026-02-01T00:00:00.000Z' })
  expect(people[0].birthday).toBe('1990-03-15')
  expect(people[0].notes).toEqual([{ at: '2026-02-01T00:00:00.000Z', text: 'birthday was 03-14' }])
})

test('who shows the birthday, with an age only when the year is known', () => {
  const now = Date.parse('2026-10-13T15:00:00Z')
  const people: Person[] = []
  const alex = recordPerson(people, { name: 'Alex', birthday: '1986-10-16' })
  const ana = recordPerson(people, { name: 'Sam', birthday: '10-16' })
  expect(describePerson(alex, { now, userZone: 'America/Argentina/Buenos_Aires' })).toContain('birthday 16 Oct 1986 (age 39, in 3 days)')
  const anaText = describePerson(ana, { now, userZone: 'America/Argentina/Buenos_Aires' })
  expect(anaText).toContain('birthday 16 Oct (in 3 days)')
  expect(anaText).not.toMatch(/age|turns/)
})

test('who counts "today" in the person\'s own zone', () => {
  // 01:00 on the 16th in Tokyo, still the 15th for a user in Buenos Aires.
  const now = Date.parse('2026-10-15T16:00:00Z')
  const people: Person[] = []
  const kenji = recordPerson(people, { name: 'Kenji', birthday: '1990-10-16', timezone: 'Asia/Tokyo' })
  expect(describePerson(kenji, { now, userZone: 'America/Argentina/Buenos_Aires' })).toContain('birthday 16 Oct 1990 (36 today)')
  delete kenji.timezone
  expect(describePerson(kenji, { now, userZone: 'America/Argentina/Buenos_Aires' })).toContain('(age 35, tomorrow)')
})

test('a stated cadence starts the clock only when none is running', () => {
  const people: Person[] = []
  const p = recordPerson(people, { name: 'Alex', cadenceDays: 30, at: '2026-08-01T10:00:00Z' })
  expect(p.cadenceDays).toBe(30)
  expect(p.lastTouch).toBe('2026-08-01T10:00:00Z')
  recordPerson(people, { name: 'Alex', cadenceDays: 7, at: '2026-08-20T10:00:00Z' })
  expect(p.cadenceDays).toBe(7)
  expect(p.lastTouch).toBe('2026-08-01T10:00:00Z')
  expect(p.notes!.map(n => n.text)).toContain('cadence was every 30d')
})

test('cadence null turns check-ins off and says so', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Alex', cadenceDays: 30, at: '2026-08-01T10:00:00Z' })
  const p = recordPerson(people, { name: 'Alex', cadenceDays: null, at: '2026-08-05T10:00:00Z' })
  expect(p.cadenceDays).toBeUndefined()
  expect(p.notes!.map(n => n.text)).toContain('check-ins stopped (was every 30d)')
})

test('touched moves lastTouch forward and never backward', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Alex', cadenceDays: 30, at: '2026-08-10T10:00:00Z' })
  const p = recordPerson(people, { name: 'Alex', touched: true, at: '2026-08-20T10:00:00Z' })
  expect(p.lastTouch).toBe('2026-08-20T10:00:00Z')
  recordPerson(people, { name: 'Alex', touched: true, at: '2026-08-15T10:00:00Z' })
  expect(p.lastTouch).toBe('2026-08-20T10:00:00Z')
})

test('who shows the check-in cadence', () => {
  const people: Person[] = []
  const p = recordPerson(people, { name: 'Alex', cadenceDays: 30, at: '2026-08-01T10:00:00Z' })
  expect(formatPerson(p, Date.parse('2026-08-11T10:00:00Z'))).toContain('check in every 30d, last spoke 10d ago')
})
