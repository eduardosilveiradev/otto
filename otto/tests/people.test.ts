import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseAddress, normalizeEmail, normalizePhone, normalizeHandle,
  orgFromDomain, orgFromSignature, parseDateHeader,
  dominantOffset, formatOffset, ingestMessage, ingestAttendees, mentionPerson,
  recordPerson, offsetForZone, displayName, describePerson,
  findPerson, medianGapDays, cadenceDrift, callWindow, goodHourToCall,
  formatPerson, formatDrift, loadPeople, savePeople,
  type Person,
} from '../people.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-people-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const DAY = 24 * 60 * 60 * 1000

test('addresses parse in every shape a header uses', () => {
  expect(parseAddress('Marco Rossi <m@x.com>')).toEqual({ name: 'Marco Rossi', email: 'm@x.com' })
  expect(parseAddress('<m@x.com>')).toEqual({ email: 'm@x.com' })
  expect(parseAddress('m@x.com')).toEqual({ email: 'm@x.com' })
  expect(parseAddress('"Rossi, Marco" <M@X.com>')).toEqual({ name: 'Rossi, Marco', email: 'm@x.com' })
  expect(parseAddress('   ')).toBeUndefined()
})

test('plus tags merge, gmail dots do not', () => {
  expect(normalizeEmail('Marco+shopping@X.com')).toBe('marco@x.com')
  // first.last@ is two different people at a company that uses that scheme.
  expect(normalizeEmail('first.last@acme.it')).toBe('first.last@acme.it')
  expect(normalizeEmail('not an address')).toBe('')
})

test('a freemail domain is not an org', () => {
  expect(orgFromDomain('m@gmail.com')).toBeUndefined()
  expect(orgFromDomain('m@libero.it')).toBeUndefined()
  expect(orgFromDomain('m@acme-consulting.it')).toBe('acme-consulting.it')
})

test('a signature block with a legal suffix names the company', () => {
  const body = 'Ci sentiamo domani.\n\n--\nMarco Rossi\nCTO\nAcme Consulting S.r.l.\nHauptstrasse 1\nm@acme.it'
  expect(orgFromSignature(body)).toBe('Acme Consulting S.r.l.')
})

test('a signature without a suffix falls back to the title line', () => {
  expect(orgFromSignature('thanks\n\n--\nJony\nHead of Design, Fictional Studio\njony@x.com'))
    .toBe('Fictional Studio')
})

test('a body that mentions a company is not a signature', () => {
  expect(orgFromSignature('We are pitching to Globex Inc next week and I think we win it.\nSee you.')).toBeUndefined()
})

// The half of the Date header that Date.parse discards.
test('the Date header keeps the sender\'s own offset', () => {
  const d = parseDateHeader('Tue, 11 Aug 2026 09:14:32 -0300')!
  expect(d.at).toBe('2026-08-11T12:14:32.000Z')
  expect(d.offsetMinutes).toBe(-180)
  expect(parseDateHeader('Tue, 11 Aug 2026 14:14:32 +0200')!.offsetMinutes).toBe(120)
  expect(parseDateHeader('2026-08-11T09:14:32+05:30')!.offsetMinutes).toBe(330)
})

test('a header with no wall clock behind it reports no offset rather than zero', () => {
  expect(parseDateHeader('2026-08-11T12:00:00Z')!.offsetMinutes).toBeUndefined()
  expect(parseDateHeader('not a date')).toBeUndefined()
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

test('inbound mail builds the person and learns their zone', () => {
  const people: Person[] = []
  ingestMessage(people, {
    direction: 'in',
    from: 'Jony <jony@studio.com>',
    to: ['me@gmail.com'],
    date: 'Tue, 11 Aug 2026 09:14:32 -0300',
    body: 'later\n\n--\nJony\nHead of Design, Fictional Studio\n',
  })
  const p = findPerson(people, 'jony@studio.com')!
  expect(p.name).toBe('Jony')
  expect(p.inbound.count).toBe(1)
  expect(p.outbound.count).toBe(0)
  expect(p.offsetSamples).toEqual([-180])
  expect(p.org).toBe('Fictional Studio')
})

// Getting this backwards would file every contact in the user’s own timezone.
test('an outbound Date header teaches nothing about the recipient\'s zone', () => {
  const people: Person[] = []
  ingestMessage(people, {
    direction: 'out',
    from: 'the user <me@gmail.com>',
    to: ['Jony <jony@studio.com>'],
    date: 'Tue, 11 Aug 2026 09:14:32 -0300',
  })
  const p = findPerson(people, 'jony@studio.com')!
  expect(p.outbound.count).toBe(1)
  expect(p.offsetSamples).toEqual([])
})

test('first and last are kept per direction', () => {
  const people: Person[] = []
  const send = (date: string) => ingestMessage(people, {
    direction: 'out', from: 'me@gmail.com', to: ['jony@studio.com'], date,
  })
  send('Mon, 03 Aug 2026 09:00:00 +0000')
  send('Fri, 07 Aug 2026 09:00:00 +0000')
  const p = findPerson(people, 'jony@studio.com')!
  expect(p.outbound.first).toBe('2026-08-03T09:00:00.000Z')
  expect(p.outbound.last).toBe('2026-08-07T09:00:00.000Z')
  expect(p.outbound.count).toBe(2)
})

test('everyone on the thread becomes a contact, only the sender gets a zone', () => {
  const people: Person[] = []
  ingestMessage(people, {
    direction: 'in',
    from: 'Jony <jony@studio.com>',
    to: ['me@gmail.com'],
    cc: ['Ana <ana@studio.com>'],
    date: 'Tue, 11 Aug 2026 09:14:32 -0300',
  })
  const ana = findPerson(people, 'ana@studio.com')!
  expect(ana.name).toBe('Ana')
  expect(ana.contacts).toHaveLength(1)
  expect(ana.offsetSamples).toEqual([])
  expect(ana.inbound.count).toBe(0)
})

test('a second address for a known name folds into one person', () => {
  const people: Person[] = []
  ingestMessage(people, { direction: 'in', from: 'Marco Rossi <marco@acme.it>', date: 'Tue, 11 Aug 2026 09:00:00 +0200' })
  ingestMessage(people, { direction: 'in', from: 'Marco Rossi <m.rossi@gmail.com>', date: 'Wed, 12 Aug 2026 09:00:00 +0200' })
  expect(people).toHaveLength(1)
  expect(people[0].addresses.sort()).toEqual(['m.rossi@gmail.com', 'marco@acme.it'])
})

test('a name the user mentioned is claimed by the first email that arrives', () => {
  const people: Person[] = []
  mentionPerson(people, 'Marco')
  mentionPerson(people, 'Marco')
  expect(people[0].mentions).toBe(2)
  ingestMessage(people, { direction: 'in', from: 'Marco <marco@acme.it>', date: 'Tue, 11 Aug 2026 09:00:00 +0200' })
  expect(people).toHaveLength(1)
  expect(people[0].id).toBe('marco@acme.it')
  expect(people[0].mentions).toBe(2)
})

test('calendar attendees are contact without a direction', () => {
  const people: Person[] = []
  ingestAttendees(people, [
    { email: 'jony@studio.com', displayName: 'Jony', at: '2026-08-11T14:00:00Z' },
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
  ingestMessage(people, { direction: 'out', from: 'me@x.com', to: ['jony@studio.com'], date: 'Tue, 11 Aug 2026 09:00:00 -0300' })
  expect(goodHourToCall(people[0], -180)).toBeNull()
})

test('the call window comes from the offsets their mail arrived with', () => {
  const people: Person[] = []
  for (const day of ['10', '11', '12']) {
    ingestMessage(people, {
      direction: 'in', from: 'Marco <marco@acme.it>', date: `Tue, ${day} Aug 2026 09:00:00 +0200`,
    })
  }
  const w = goodHourToCall(people[0], -180)!
  expect(w.theirStart).toBe('14:00')
  expect(w.yourStart).toBe('09:00')
})

test('a person summarises to one line with their rhythm and zone', () => {
  const people: Person[] = []
  ingestMessage(people, {
    direction: 'in', from: 'Marco Rossi <marco@acme.it>',
    date: 'Tue, 11 Aug 2026 09:00:00 +0200', body: '--\nMarco\nAcme S.r.l.\n',
  })
  const line = formatPerson(people[0], Date.parse('2026-08-12T09:00:00Z'))
  expect(line).toContain('Marco Rossi')
  expect(line).toContain('Acme S.r.l.')
  expect(line).toContain('UTC+02:00')
  expect(line).toContain('1 in / 0 out')
})

// ---------------------------------------------------------------------------
// What the user said
// ---------------------------------------------------------------------------

test('a phone keeps its country code and refuses to invent one', () => {
  expect(normalizePhone('+39 335 123 4567')).toBe('+393351234567')
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
    name: 'Marco Rossi', email: 'Marco@Acme.it', relationship: 'lawyer',
    city: 'Munich', timezone: 'Europe/Berlin', note: 'handling the visa',
    at: '2026-08-01T10:00:00.000Z',
  })
  const p = findPerson(people, 'marco@acme.it')!
  expect(p.id).toBe('marco@acme.it')
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
  recordPerson(people, { name: 'Marco', org: 'Acme', at: '2026-01-01T00:00:00.000Z' })
  recordPerson(people, { name: 'Marco', org: 'Globex', at: '2026-08-01T00:00:00.000Z' })
  const p = findPerson(people, 'Marco')!
  expect(p.org).toBe('Globex')
  expect(p.notes?.map(n => n.text)).toEqual(['org was Acme'])
  expect(people).toHaveLength(1)
})

test('restating the same fact is not a change', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Marco', city: 'Munich' })
  recordPerson(people, { name: 'Marco', city: 'Munich' })
  expect(findPerson(people, 'Marco')!.notes).toBeUndefined()
})

test('the same note said twice is kept once', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Marco', note: 'allergic to shellfish' })
  recordPerson(people, { name: 'Marco', note: 'allergic to shellfish' })
  expect(findPerson(people, 'Marco')!.notes).toHaveLength(1)
})

test('a name-only record is promoted when an address finally turns up', () => {
  const people: Person[] = []
  mentionPerson(people, 'Marco')
  recordPerson(people, { name: 'Marco', note: 'my lawyer' })
  recordPerson(people, { name: 'Marco', email: 'marco@acme.it' })
  expect(people).toHaveLength(1)
  expect(people[0].id).toBe('marco@acme.it')
  expect(people[0].mentions).toBe(1)
  expect(people[0].notes?.[0].text).toBe('my lawyer')
})

test('the short name the user actually uses finds the person they gave a full name to', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Marco Rossi', email: 'marco@acme.it', relationship: 'lawyer' })
  recordPerson(people, { name: 'Marco', note: 'wants the signed copy by Friday' })
  expect(people).toHaveLength(1)
  expect(people[0].relationship).toBe('lawyer')
  expect(people[0].name).toBe('Marco Rossi')
  expect(people[0].notes).toHaveLength(1)
  expect(findPerson(people, 'marco')).toBe(people[0])
})

test('a full name finds the person recorded under just their first', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Marco', note: 'my lawyer' })
  recordPerson(people, { name: 'Marco Rossi', city: 'Munich' })
  expect(people).toHaveLength(1)
  expect(people[0].city).toBe('Munich')
})

test('two people sharing a first name are never merged', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Marco Rossi', email: 'rossi@acme.it' })
  recordPerson(people, { name: 'Marco Bianchi', email: 'bianchi@globex.it' })
  expect(people).toHaveLength(2)
  expect(() => recordPerson(people, { name: 'Marco', note: 'called today' }))
    .toThrow(/more than one Marco: Marco Rossi, Marco Bianchi/)
  expect(findPerson(people, 'Marco')).toBeUndefined()
  // Naming which one still works, and nobody gained a note they did not earn.
  recordPerson(people, { name: 'Marco Bianchi', note: 'called today' })
  expect(findPerson(people, 'rossi@acme.it')!.notes).toBeUndefined()
})

test('a truncated name is not a match', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Marco Rossi' })
  recordPerson(people, { name: 'Marc' })
  expect(people).toHaveLength(2)
})

test('a handle and a phone each find the person again', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Ana', handle: '@anab', phone: '+55 11 98765-4321' })
  recordPerson(people, { handle: 'AnaB', note: 'moving to Lisbon' })
  recordPerson(people, { phone: '+5511987654321', city: 'Lisbon' })
  expect(people).toHaveLength(1)
  expect(people[0].city).toBe('Lisbon')
  expect(people[0].notes?.[0].text).toBe('moving to Lisbon')
})

test('a zone resolves to the offset in force that day, not a cached one', () => {
  expect(offsetForZone('Europe/Berlin', new Date('2026-01-15T12:00:00Z'))).toBe(60)
  expect(offsetForZone('Europe/Berlin', new Date('2026-07-15T12:00:00Z'))).toBe(120)
  expect(offsetForZone('America/Argentina/Buenos_Aires', new Date('2026-07-15T12:00:00Z'))).toBe(-180)
  expect(offsetForZone('Mars/Olympus')).toBeUndefined()
})

test('a stated zone beats offsets sampled off the wire', () => {
  const people: Person[] = []
  // His mail is stamped +0000 by a server that is nowhere near him.
  for (const day of ['10', '11', '12']) {
    ingestMessage(people, { direction: 'in', from: 'Marco <marco@acme.it>', date: `Tue, ${day} Aug 2026 09:00:00 +0000` })
  }
  expect(goodHourToCall(people[0], -180, new Date('2026-08-12T12:00:00Z'))!.theirStart).toBe('12:00')
  recordPerson(people, { email: 'marco@acme.it', timezone: 'Europe/Berlin' })
  const w = goodHourToCall(people[0], -180, new Date('2026-08-12T12:00:00Z'))!
  expect(w.theirStart).toBe('14:00')
  expect(w.yourStart).toBe('09:00')
})

test('a person reads back with the newest thing said about them first', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Marco Rossi', email: 'marco@acme.it', relationship: 'lawyer', city: 'Munich', timezone: 'Europe/Berlin', at: '2026-01-05T00:00:00.000Z', note: 'met at the Hamburg thing' })
  recordPerson(people, { name: 'Marco Rossi', note: 'wants the signed copy by Friday', at: '2026-08-10T00:00:00.000Z' })
  const text = describePerson(people[0], { now: Date.parse('2026-08-12T09:00:00Z'), yourOffsetMinutes: -180 })
  const lines = text.split('\n')
  expect(lines[0]).toContain('Marco Rossi')
  expect(lines[0]).toContain('lawyer')
  expect(lines[0]).toContain('Munich')
  expect(text).toContain('marco@acme.it')
  expect(text).toContain('Europe/Berlin')
  expect(text).toContain('good hour to call: their 14:00–18:00, your 09:00–13:00')
  expect(text.indexOf('wants the signed copy')).toBeLessThan(text.indexOf('met at the Hamburg thing'))
  expect(text).toContain('2026-08-10  wants the signed copy by Friday')
})

test('someone with no zone is asked about rather than guessed at', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Marco' })
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
  for (let i = 0; i < 45; i++) recordPerson(people, { name: 'Marco', note: `thing ${i}` })
  const notes = people[0].notes!
  expect(notes).toHaveLength(40)
  expect(notes[notes.length - 1].text).toBe('thing 44')
  expect(notes[0].text).toBe('thing 5')
})

test('people round-trip through disk', () => {
  const file = join(tmp, 'people.json')
  const people: Person[] = []
  ingestMessage(people, { direction: 'in', from: 'a@x.com', date: 'Tue, 11 Aug 2026 09:00:00 +0000' })
  savePeople(file, people)
  expect(loadPeople(file)).toEqual(people)
  expect(loadPeople(join(tmp, 'nope.json'))).toEqual([])
})
