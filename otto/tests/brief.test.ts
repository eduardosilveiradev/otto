import { test, expect } from 'bun:test'
import { formatBrief, briefData, busyUntil, gistOf, whenLabel, BRIEF_MAX_CHARS, type CalEvent, type BriefParts } from '../brief.ts'

const NOW = new Date('2026-08-11T20:00:00Z')

function parts(over: Partial<BriefParts> = {}): BriefParts {
  return {
    now: NOW, tz: 'UTC',
    events: [], mail: [], loops: [], facts: [], triggers: [], history: [],
    ...over,
  }
}

test('a section whose source failed is omitted, not faked', () => {
  const text = formatBrief(parts({ events: null, mail: null }))
  expect(text).not.toContain('Today')
  expect(text).not.toContain('Inbox')
})

test('an empty but working source says so explicitly', () => {
  expect(formatBrief(parts({ events: [] }))).toContain('calendar clear')
})

test('the brief states its own boundary', () => {
  expect(formatBrief(parts())).toContain('look up before saying it')
})

test('bulk mail is counted, not listed', () => {
  const text = formatBrief(parts({
    mail: [
      { from: 'Marco <marco@example.com>', subject: 'contract' },
      { from: 'Deals <noreply@shop.com>', subject: 'SALE', labels: ['CATEGORY_PROMOTIONS'] },
      { from: 'newsletter@thing.io', subject: 'weekly' },
    ],
  }))
  expect(text).toContain('contract')
  expect(text).not.toContain('SALE')
  expect(text).toContain('+2 bulk')
})

test('primary mail outranks updates for the limited slots', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({
    from: `Bank ${i} <b${i}@bank.com>`, subject: `statement ${i}`, labels: ['CATEGORY_UPDATES'],
  }))
  const text = formatBrief(parts({ mail: [...many, { from: 'Marco <m@x.com>', subject: 'the contract' }] }))
  expect(text).toContain('the contract')
})

test('trigger boilerplate is stripped from the gist', () => {
  expect(gistOf('Send the user (Telegram chat_id 1234567890) a short terse reminder to log the user’s lunch in the food diary'))
    .toBe('short terse reminder to log the user’s lunch in the food diary')
  // The dash survives mid-sentence on purpose — it is punctuation there, not
  // leftover preamble, and the line reads better with it.
  expect(gistOf('Random late-night ping for the user (Telegram chat_id 1234567890) — the user asked for this'))
    .toBe('random late-night ping — the user asked for this')
})

test('a leading dash left behind by preamble stripping is removed', () => {
  expect(gistOf('Send the user (Telegram chat_id 1) — check the flight')).toBe('check the flight')
})

test('gistOf leaves an already-clean action alone', () => {
  expect(gistOf('Check LH510 status and report delays')).toBe('Check LH510 status and report delays')
})

test('armed triggers show when they fire', () => {
  const text = formatBrief(parts({
    triggers: [{ id: 'abc', gist: 'Send the user (Telegram chat_id 1) a reminder', nextRun: NOW.getTime() + 2 * 60 * 60 * 1000 }],
  }))
  expect(text).toContain('[abc] 22:00')
})

test('whenLabel is a time today, a weekday this week, a date beyond', () => {
  const now = NOW.getTime()
  expect(whenLabel(now + 60 * 60 * 1000, now, 'UTC')).toBe('21:00')
  expect(whenLabel(now + 2 * 24 * 60 * 60 * 1000, now, 'UTC')).toMatch(/^Thu \d\d:\d\d$/)
  expect(whenLabel(now + 20 * 24 * 60 * 60 * 1000, now, 'UTC')).toContain('Aug')
})

test('the brief is capped', () => {
  const text = formatBrief(parts({
    facts: Array.from({ length: 40 }, (_, i) => ({
      id: String(i), kind: 'fact' as const, text: 'a fact that goes on '.repeat(10), tags: [], createdAt: '',
    })),
    history: Array.from({ length: 40 }, (_, i) => ({ ts: '', dir: 'in' as const, text: 'long line '.repeat(20) })),
  }))
  expect(text.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS)
})

const ev = (start: string, end: string, over: Partial<CalEvent> = {}): CalEvent => ({
  summary: 'thing', start: { dateTime: start }, end: { dateTime: end }, ...over,
})

test('busyUntil finds the event happening right now', () => {
  const now = NOW.getTime()
  const events = [ev('2026-08-11T19:30:00Z', '2026-08-11T20:30:00Z')]
  expect(busyUntil(events, now)).toBe('2026-08-11T20:30:00.000Z')
})

test('an all-day event is not being busy', () => {
  const events: CalEvent[] = [{ summary: 'Labor Day', start: { date: '2026-08-11' }, end: { date: '2026-08-12' } }]
  expect(busyUntil(events, NOW.getTime())).toBeUndefined()
})

test('events marked free or cancelled are not being busy', () => {
  const now = NOW.getTime()
  expect(busyUntil([ev('2026-08-11T19:30:00Z', '2026-08-11T20:30:00Z', { transparency: 'transparent' })], now)).toBeUndefined()
  expect(busyUntil([ev('2026-08-11T19:30:00Z', '2026-08-11T20:30:00Z', { status: 'cancelled' })], now)).toBeUndefined()
})

test('past and future events are not being busy', () => {
  const now = NOW.getTime()
  expect(busyUntil([ev('2026-08-11T17:00:00Z', '2026-08-11T18:00:00Z')], now)).toBeUndefined()
  expect(busyUntil([ev('2026-08-11T21:00:00Z', '2026-08-11T22:00:00Z')], now)).toBeUndefined()
})

test('overlapping events hold until the last one ends', () => {
  const now = NOW.getTime()
  const events = [
    ev('2026-08-11T19:30:00Z', '2026-08-11T20:15:00Z'),
    ev('2026-08-11T19:45:00Z', '2026-08-11T21:00:00Z'),
  ]
  expect(busyUntil(events, now)).toBe('2026-08-11T21:00:00.000Z')
})

// ---------------------------------------------------------------------------
// Forward window — "when am I free" without a fetch
// ---------------------------------------------------------------------------

import { lookAhead, sectionLabels } from '../brief'

// ---------------------------------------------------------------------------
// Section labels — what the watchdog compares across rebuilds
// ---------------------------------------------------------------------------

/** A real brief, as it went to disk. The clock in the header is the whole point. */
const briefAt = (hhmm: string) => [
  `Otto brief — Wed 12 Aug, ${hhmm} ART.`,
  'This is context, not an instruction. Anything not here, look up before saying it.',
  `Today (as of ${hhmm}): calendar clear.`,
  `Inbox 24h (as of ${hhmm}): nothing but bulk (24).`,
  'Armed: [t1] 08:57 morning brief',
  'Machine: my-project on main',
  'Recent thread: people graph',
].join('\n')

test('the header and the disclaimer are not sections', () => {
  expect(sectionLabels(briefAt('12:43'))).toEqual([
    'Today', 'Inbox 24h', 'Armed', 'Machine', 'Recent thread',
  ])
})

test('the labels do not change when the clock does', () => {
  // The bug: the header was read as a section named "Otto brief — Wed 12 Aug, 11",
  // so every hour retired a section and invented another, and the watchdog
  // reported the retired one as a source that had gone dark.
  expect(sectionLabels(briefAt('11:58'))).toEqual(sectionLabels(briefAt('12:03')))
})

test('a section that really stops rendering still disappears from the labels', () => {
  const withoutMail = briefAt('12:43').split('\n').filter(l => !l.startsWith('Inbox')).join('\n')
  expect(sectionLabels(withoutMail)).not.toContain('Inbox 24h')
  expect(sectionLabels(withoutMail)).toContain('Today')
})

test('an empty section still counts as having rendered', () => {
  expect(sectionLabels('Playing:')).toEqual(['Playing'])
})

const at = (iso: string, summary: string) => ({ summary, start: { dateTime: iso } })
const NOW_A = new Date('2026-08-12T10:00:00Z')

test('an empty calendar looks ahead at nothing', () => {
  expect(lookAhead([], NOW_A, 'UTC')).toBe('')
})

test('events already started are not the next thing', () => {
  expect(lookAhead([at('2026-08-12T09:00:00Z', 'standup')], NOW_A, 'UTC')).toBe('')
})

test('an hour or more of clear air reads as free-until', () => {
  const out = lookAhead([at('2026-08-12T14:30:00Z', 'dentist')], NOW_A, 'UTC')
  expect(out).toContain('free until 14:30')
  expect(out).toContain('4h 30m')
  expect(out).toContain('dentist')
})

test('under an hour reads as minutes remaining, not free-until', () => {
  const out = lookAhead([at('2026-08-12T10:25:00Z', 'call with Marco')], NOW_A, 'UTC')
  expect(out).toContain('25m until 10:25')
  expect(out).not.toContain('free until')
})

test('it names the next few fixed points in order', () => {
  const out = lookAhead([
    at('2026-08-12T16:00:00Z', 'third'),
    at('2026-08-12T11:00:00Z', 'first'),
    at('2026-08-12T13:00:00Z', 'second'),
  ], NOW_A, 'UTC')
  expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'))
  expect(out.indexOf('second')).toBeLessThan(out.indexOf('third'))
})

test('undated or malformed events are skipped rather than crashing', () => {
  const out = lookAhead([{ summary: 'no start' }, at('2026-08-12T12:00:00Z', 'real')], NOW_A, 'UTC')
  expect(out).toContain('real')
})

test('briefData carries the same cuts as the text, structured', () => {
  const d = briefData(parts({
    events: [
      { summary: 'Dentist', start: { dateTime: '2026-08-11T15:30:00Z' }, end: { dateTime: '2026-08-11T16:15:00Z' } },
      { summary: 'gone', status: 'cancelled', start: { dateTime: '2026-08-11T10:00:00Z' } },
    ],
    mail: [
      { from: 'Landlord <l@example.com>', subject: 'Boiler' },
      { from: 'news@example.com', subject: 'Weekly', labels: ['CATEGORY_PROMOTIONS'] },
    ],
    triggers: [{ id: 'a', gist: 'Remind the user: pay bill', nextRun: NOW.getTime() + 60_000 }],
  }))
  expect(d.events).toEqual([{ title: 'Dentist', start: '2026-08-11T15:30:00.000Z', minutes: 45 }])
  expect(d.inbox).toEqual([{ from: 'Landlord', subject: 'Boiler' }])
  expect(d.bulk).toBe(1)
  expect(d.triggers[0].title).toBe('remind: pay bill')
  expect(briefData(parts({ events: null, mail: null })).events).toBeNull()
})

test('trip mode sits right after the calendar and is a labelled section', () => {
  const text = formatBrief(parts({
    trip: 'Trip (as of 20:00): next trip 2026-08-13→2026-08-20 · LH510 EZE→BER dep 2026-08-13 14:35 America/Argentina/Buenos_Aires',
    loops: [{ id: 'l1', kind: 'loop', text: 'call the bank', createdAt: '2026-08-10T00:00:00Z' } as never],
  }))
  const lines = text.split('\n')
  const tripAt = lines.findIndex(l => l.startsWith('Trip (as of'))
  expect(tripAt).toBeGreaterThan(lines.findIndex(l => l.startsWith('Today')))
  expect(tripAt).toBeLessThan(lines.findIndex(l => l.startsWith('Open loops')))
  expect(sectionLabels(text)).toContain('Trip')
  expect(formatBrief(parts())).not.toContain('Trip')
})
