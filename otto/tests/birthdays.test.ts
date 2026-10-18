import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseBirthday, birthdayInYear, isLeap, localDate, nextBirthday, ageOn, describeBirthday,
  upcomingBirthdays, birthdaysToNudge, markNudged, pruneBirthdayState, formatNudge,
  formatBirthdayLine, loadBirthdayState, saveBirthdayState,
  type BirthdayPerson, type BirthdayState,
} from '../birthdays.ts'
import { sectionLabels, formatBrief } from '../brief.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-birthdays-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const USER = 'America/Argentina/Buenos_Aires'
const at = (iso: string) => new Date(iso)
const name = (p: BirthdayPerson) => p.name ?? p.id

test('only MM-DD and YYYY-MM-DD parse', () => {
  expect(parseBirthday('03-14')).toEqual({ month: 3, day: 14 })
  expect(parseBirthday('1986-10-16')).toEqual({ year: 1986, month: 10, day: 16 })
  expect(parseBirthday(' 12-31 ')).toEqual({ month: 12, day: 31 })
  for (const bad of ['3-14', '03/14', '14-03-1986', '13-01', '00-10', '04-31', '02-30', 'march 14', '']) {
    expect(parseBirthday(bad)).toBeUndefined()
  }
})

test('a yearless Feb 29 is fine; a Feb 29 in a common year is a typo', () => {
  expect(parseBirthday('02-29')).toEqual({ month: 2, day: 29 })
  expect(parseBirthday('1992-02-29')).toEqual({ year: 1992, month: 2, day: 29 })
  expect(parseBirthday('1993-02-29')).toBeUndefined()
  expect(parseBirthday('1900-02-29')).toBeUndefined()
})

test('Feb 29 falls on Feb 28 in a common year', () => {
  expect(isLeap(2028)).toBe(true)
  expect(isLeap(2100)).toBe(false)
  expect(isLeap(2000)).toBe(true)
  expect(birthdayInYear({ month: 2, day: 29 }, 2027)).toEqual({ year: 2027, month: 2, day: 28 })
  expect(birthdayInYear({ month: 2, day: 29 }, 2028)).toEqual({ year: 2028, month: 2, day: 29 })
  expect(birthdayInYear({ month: 3, day: 1 }, 2027)).toEqual({ year: 2027, month: 3, day: 1 })
})

test('the next birthday rolls over the year end and counts calendar days', () => {
  expect(nextBirthday({ month: 1, day: 2 }, { year: 2026, month: 12, day: 30 }))
    .toEqual({ on: { year: 2027, month: 1, day: 2 }, days: 3 })
  expect(nextBirthday({ month: 10, day: 13 }, { year: 2026, month: 10, day: 13 }).days).toBe(0)
  // Yesterday's is a year away, not minus one.
  expect(nextBirthday({ month: 10, day: 12 }, { year: 2026, month: 10, day: 13 }).on.year).toBe(2027)
  expect(nextBirthday({ year: 1986, month: 10, day: 16 }, { year: 2026, month: 10, day: 13 }).turns).toBe(40)
})

test('age is only ever computed from a stated year, and Feb 29 people age on Feb 28', () => {
  expect(ageOn({ month: 10, day: 16 }, { year: 2026, month: 10, day: 13 })).toBeUndefined()
  expect(ageOn({ year: 1986, month: 10, day: 16 }, { year: 2026, month: 10, day: 15 })).toBe(39)
  expect(ageOn({ year: 1986, month: 10, day: 16 }, { year: 2026, month: 10, day: 16 })).toBe(40)
  expect(ageOn({ year: 2000, month: 2, day: 29 }, { year: 2027, month: 2, day: 27 })).toBe(26)
  expect(ageOn({ year: 2000, month: 2, day: 29 }, { year: 2027, month: 2, day: 28 })).toBe(27)
})

test('the wall calendar is read in the zone asked for', () => {
  // 00:30 in Tokyo, still the previous lunchtime in Buenos Aires.
  const t = at('2026-10-12T15:30:00Z')
  expect(localDate('Asia/Tokyo', t)).toEqual({ year: 2026, month: 10, day: 13 })
  expect(localDate(USER, t)).toEqual({ year: 2026, month: 10, day: 12 })
  expect(localDate('Not/AZone', t)).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Who gets nudged
// ---------------------------------------------------------------------------

const tokyo: BirthdayPerson = { id: 'kenji', name: 'Kenji', birthday: '10-16', timezone: 'Asia/Tokyo' }
const unplaced: BirthdayPerson = { id: 'ana', name: 'Ana', birthday: '10-16' }

test('three days out is counted in the person\'s own calendar, just after their midnight', () => {
  const justAfter = at('2026-10-12T15:01:00Z') // 00:01 13 Oct in Tokyo, 12:01 12 Oct for the user
  const due = birthdaysToNudge([tokyo, unplaced], {}, justAfter, { userZone: USER, leadDays: 3 })
  expect(due.map(h => h.person.id)).toEqual(['kenji'])
  expect(due[0].zone).toBe('Asia/Tokyo')
  expect(due[0].days).toBe(3)
})

test('one minute before their midnight it is still four days', () => {
  const justBefore = at('2026-10-12T14:59:00Z') // 23:59 12 Oct in Tokyo
  expect(birthdaysToNudge([tokyo], {}, justBefore, { userZone: USER, leadDays: 3 })).toEqual([])
})

test('someone never placed is counted in the user\'s zone, midnight edges included', () => {
  expect(birthdaysToNudge([unplaced], {}, at('2026-10-13T02:59:00Z'), { userZone: USER, leadDays: 3 })).toEqual([])
  const due = birthdaysToNudge([unplaced], {}, at('2026-10-13T03:00:00Z'), { userZone: USER, leadDays: 3 })
  expect(due.map(h => [h.person.id, h.zone, h.days])).toEqual([['ana', USER, 3]])
})

test('an unrecognised zone on the record falls back to the user\'s rather than to UTC', () => {
  const bad = { ...tokyo, timezone: 'Atlantis/Capital' }
  const due = birthdaysToNudge([bad], {}, at('2026-10-13T03:00:00Z'), { userZone: USER, leadDays: 3 })
  expect(due[0].zone).toBe(USER)
})

test('one nudge per person per year', () => {
  const state: BirthdayState = {}
  const t = at('2026-10-13T12:00:00Z')
  const [hit] = birthdaysToNudge([unplaced], state, t, { userZone: USER, leadDays: 3 })
  markNudged(state, hit.person.id, hit.on.year, t.toISOString())
  // Later the same day, and the next two days: silence.
  for (const iso of ['2026-10-13T20:00:00Z', '2026-10-14T12:00:00Z', '2026-10-15T12:00:00Z']) {
    expect(birthdaysToNudge([unplaced], state, at(iso), { userZone: USER, leadDays: 3 })).toEqual([])
  }
  // Next year it speaks again.
  expect(birthdaysToNudge([unplaced], state, at('2027-10-13T12:00:00Z'), { userZone: USER, leadDays: 3 })).toHaveLength(1)
})

test('a December nudge for a January birthday is that January\'s, and does not block the next', () => {
  const jan = { id: 'leo', name: 'Leo', birthday: '01-01' }
  const state: BirthdayState = {}
  const [hit] = birthdaysToNudge([jan], state, at('2026-12-29T15:00:00Z'), { userZone: USER, leadDays: 3 })
  expect(hit.on.year).toBe(2027)
  markNudged(state, 'leo', hit.on.year)
  expect(birthdaysToNudge([jan], state, at('2027-12-29T15:00:00Z'), { userZone: USER, leadDays: 3 })).toHaveLength(1)
})

test('a missed third day is caught on the second; the day itself is never a nudge', () => {
  expect(birthdaysToNudge([unplaced], {}, at('2026-10-14T15:00:00Z'), { userZone: USER, leadDays: 3 })[0].days).toBe(2)
  expect(birthdaysToNudge([unplaced], {}, at('2026-10-16T15:00:00Z'), { userZone: USER, leadDays: 3 })).toEqual([])
  expect(birthdaysToNudge([unplaced], {}, at('2026-10-12T15:00:00Z'), { userZone: USER, leadDays: 3 })).toEqual([])
})

test('leadDays 0 turns nudges off, and a different lead moves the window', () => {
  expect(birthdaysToNudge([unplaced], {}, at('2026-10-15T15:00:00Z'), { userZone: USER, leadDays: 0 })).toEqual([])
  expect(birthdaysToNudge([unplaced], {}, at('2026-10-09T15:00:00Z'), { userZone: USER, leadDays: 7 })[0].days).toBe(7)
})

test('a Feb 29 birthday is nudged three days before Feb 28 in a common year, Feb 29 in a leap one', () => {
  const leap = { id: 'lia', name: 'Lia', birthday: '2000-02-29' }
  const common = birthdaysToNudge([leap], {}, at('2027-02-25T15:00:00Z'), { userZone: USER, leadDays: 3 })
  expect(common[0].on).toEqual({ year: 2027, month: 2, day: 28 })
  expect(common[0].turns).toBe(27)
  expect(birthdaysToNudge([leap], {}, at('2028-02-25T15:00:00Z'), { userZone: USER, leadDays: 3 })).toEqual([])
  const leapYear = birthdaysToNudge([leap], {}, at('2028-02-26T15:00:00Z'), { userZone: USER, leadDays: 3 })
  expect(leapYear[0].on).toEqual({ year: 2028, month: 2, day: 29 })
})

test('a malformed birthday on disk is skipped, not thrown', () => {
  const junk = { id: 'x', birthday: 'sometime in spring' }
  expect(upcomingBirthdays([junk, unplaced], at('2026-10-16T15:00:00Z'), { userZone: USER, withinDays: 0 }))
    .toHaveLength(1)
})

test('state for people who are gone is pruned', () => {
  const state: BirthdayState = { ana: { year: 2026, at: 'x' }, gone: { year: 2026, at: 'x' } }
  expect(pruneBirthdayState(state, ['ana'])).toBe(true)
  expect(Object.keys(state)).toEqual(['ana'])
  expect(pruneBirthdayState(state, ['ana'])).toBe(false)
})

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

test('the nudge names the day, the age when known, and carries both buttons', () => {
  const [hit] = birthdaysToNudge([{ id: 'm', name: 'Marco', birthday: '1986-10-16' }], {}, at('2026-10-13T15:00:00Z'), { userZone: USER, leadDays: 3 })
  const n = formatNudge(hit, 'Marco')
  expect(n.text).toBe("Marco's birthday is Friday 16 Oct — turns 40.")
  expect(n.buttons.map(b => b.label)).toEqual(['remind me on the day', 'draft a message'])
  expect(n.buttons[0].data).toBe("remind me on 16 Oct: Marco's birthday")
  expect(n.buttons[1].data).toBe('draft a birthday message to Marco')
})

test('the day before says tomorrow, and a yearless birthday never states an age', () => {
  const [hit] = birthdaysToNudge([unplaced], {}, at('2026-10-15T15:00:00Z'), { userZone: USER, leadDays: 3 })
  expect(formatNudge(hit, 'Ana').text).toBe("Ana's birthday is tomorrow, Friday 16 Oct.")
})

test('button data stays inside 60 bytes whatever the name', () => {
  const [hit] = birthdaysToNudge([unplaced], {}, at('2026-10-13T15:00:00Z'), { userZone: USER, leadDays: 3 })
  for (const long of ['Maria Fernanda de Albuquerque Cavalcanti', 'Bartholomewwwwwwwwwwwwwwwwwwwwwwwwwwwwww', 'Zoë Ñúñez-Østergård Björklund']) {
    for (const b of formatNudge(hit, long).buttons) expect(Buffer.byteLength(b.data, 'utf8')).toBeLessThanOrEqual(60)
  }
  // Too long whole, so the first name carries it rather than a name cut mid-word.
  expect(formatNudge(hit, 'Maria Fernanda de Albuquerque Cavalcanti').buttons[1].data).toBe('draft a birthday message to Maria')
})

test('the brief line lists only today, and is not a section the watchdog would miss', () => {
  const people = [
    { id: 'm', name: 'Marco', birthday: '1986-10-16' },
    { id: 'a', name: 'Ana', birthday: '10-16' },
    { id: 'k', name: 'Kenji', birthday: '10-17', timezone: 'Asia/Tokyo' },
  ]
  // 16 Oct 13:00 in Buenos Aires is already 17 Oct 01:00 in Tokyo: Kenji's day too.
  const hits = upcomingBirthdays(people, at('2026-10-16T16:00:00Z'), { userZone: USER, withinDays: 3 })
  const line = formatBirthdayLine(hits, name)!
  expect(line).toBe('Birthday today — Marco (40), Ana, Kenji.')
  expect(sectionLabels(line)).toEqual([])
  expect(formatBirthdayLine(upcomingBirthdays(people, at('2026-10-14T16:00:00Z'), { userZone: USER, withinDays: 3 }), name)).toBeUndefined()
})

test('the brief carries the line straight after the calendar', () => {
  const text = formatBrief({
    now: at('2026-10-16T16:00:00Z'), tz: USER, events: [], mail: null, loops: [], facts: [], triggers: [], history: [],
    birthdays: 'Birthday today — Ana.',
  })
  const lines = text.split('\n')
  expect(lines[lines.findIndex(l => l.startsWith('Today')) + 1]).toBe('Birthday today — Ana.')
})

test('who reads the birthday back with an age only when the year is known', () => {
  const today = { year: 2026, month: 10, day: 13 }
  expect(describeBirthday('1986-10-16', today)).toBe('birthday 16 Oct 1986 (age 39, in 3 days)')
  expect(describeBirthday('10-16', today)).toBe('birthday 16 Oct (in 3 days)')
  expect(describeBirthday('10-14', today)).toBe('birthday 14 Oct (tomorrow)')
  expect(describeBirthday('1986-10-13', today)).toBe('birthday 13 Oct 1986 (40 today)')
  expect(describeBirthday('03-01', today)).toBe('birthday 1 Mar')
  expect(describeBirthday('nonsense', today)).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

test('state round-trips and a corrupt file is moved aside', () => {
  const file = join(tmp, 'birthdays.json')
  expect(loadBirthdayState(file)).toEqual({})
  const state: BirthdayState = {}
  markNudged(state, 'ana', 2026, '2026-10-13T12:00:00.000Z')
  saveBirthdayState(file, state)
  expect(loadBirthdayState(file)).toEqual({ ana: { year: 2026, at: '2026-10-13T12:00:00.000Z' } })

  writeFileSync(file, '{not json')
  expect(loadBirthdayState(file)).toEqual({})
  expect(readdirSync(tmp).some(f => f.startsWith('birthdays.json.corrupt-'))).toBe(true)
})
