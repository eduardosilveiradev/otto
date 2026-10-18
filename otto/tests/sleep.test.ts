import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  findNights, inferWindow, planProposal, markProposed, formatOffer, applyTap, localClock,
  loadSleep, saveSleep, clockDiff, DEFAULTS, type Inbound, type SleepState,
} from '../sleep.ts'
import { setQuietWindow, accessToggles } from '../settings.ts'
import { classify } from '../selfedit.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-sleep-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const DAY = 24 * 60 * 60 * 1000

/** The instant a local wall-clock time names in a zone. */
function zoned(date: string, hm: string, tz: string): number {
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = hm.split(':').map(Number)
  const want = Date.UTC(y, mo - 1, d, h, mi)
  let guess = want
  for (let i = 0; i < 3; i++) {
    const c = localClock(guess, tz)
    const [cy, cm, cd] = c.date.split('-').map(Number)
    guess += want - Date.UTC(cy, cm - 1, cd, Math.floor(c.min / 60), c.min % 60)
  }
  return guess
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10)
}

const hm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))

/**
 * One evening-night-morning of texting: a few messages leading up to bed, none
 * while asleep, a few after waking, and some through the following day so the
 * daytime holds no gap that could pass for a night. `day` is the evening's
 * date; a bedtime before noon falls on the next calendar day.
 */
function night(day: string, bed: string, wake: string, tz: string, opts: { before?: number; after?: number } = {}): Inbound[] {
  const out: Inbound[] = []
  const at = (date: string, t: string) => ({ ts: new Date(zoned(date, t, tz)).toISOString(), tz })
  const bedDay = toMin(bed) < 12 * 60 ? addDays(day, 1) : day
  const bedMin = toMin(bed)
  for (let i = (opts.before ?? 3) - 1; i >= 0; i--) {
    const m = bedMin - i * 50
    out.push(at(m < 0 ? day : bedDay, hm((m + 1440) % 1440)))
  }
  const next = addDays(day, 1)
  const wakeMin = toMin(wake)
  for (let i = 0; i < (opts.after ?? 3); i++) out.push(at(next, hm(wakeMin + i * 40)))
  // Through the day, every two hours, stopping well short of the next bedtime.
  const stop = (toMin(bed) < 12 * 60 ? toMin(bed) + 1440 : toMin(bed)) - 3 * 60
  for (let m = wakeMin + 3 * 60; m <= stop; m += 120) out.push(at(m >= 1440 ? addDays(next, 1) : next, hm(m % 1440)))
  return out
}

function nightsFrom(start: string, n: number, bed: string, wake: string, tz: string, opts: Parameters<typeof night>[4] = {}): Inbound[] {
  const out: Inbound[] = []
  for (let i = 0; i < n; i++) out.push(...night(addDays(start, i), bed, wake, tz, opts))
  return out
}

const BERLIN = 'Europe/Berlin'
const BA = 'America/Argentina/Buenos_Aires'
const fresh = (): SleepState => ({ proposed: [] })

// ---------------------------------------------------------------------------

test('a steady late sleeper is offered the window they actually sleep, with real times', () => {
  const msgs = nightsFrom('2026-09-01', 12, '01:30', '09:30', BERLIN)
  const now = zoned('2026-09-13', '12:00', BERLIN)
  const nights = findNights(msgs, now, BERLIN)
  expect(nights.length).toBeGreaterThanOrEqual(10)
  for (const n of nights) { expect(n.bed).toBe(90); expect(n.wake).toBe(570) }

  const p = planProposal({ nights, quietHours: '23:00-08:00', state: fresh(), now })
  expect(p).not.toBeNull()
  const offer = formatOffer(p!, BERLIN)
  expect(offer.buttons.map(b => b.label)).toEqual(['use 01:30–09:30', 'keep 23:00–08:00'])
  expect(offer.buttons.map(b => b.data)).toEqual(['sleep use 01:30-09:30', 'sleep keep 23:00-08:00'])
  expect(offer.text).toContain('01:30–09:30')
  expect(offer.text).toContain(BERLIN)
  // Telegram's callback_data cap, less the "btn:" prefix.
  for (const b of offer.buttons) expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(60)
})

test('nights that already fit the configured window propose nothing', () => {
  const msgs = nightsFrom('2026-09-01', 12, '23:20', '07:40', BERLIN)
  const now = zoned('2026-09-13', '12:00', BERLIN)
  expect(planProposal({ nights: findNights(msgs, now, BERLIN), quietHours: '23:00-08:00', state: fresh(), now })).toBeNull()
})

test('a bedtime either side of midnight has a median near midnight, not noon', () => {
  const msgs = [
    ...nightsFrom('2026-09-01', 3, '23:30', '08:00', BERLIN),
    ...nightsFrom('2026-09-04', 3, '00:30', '08:00', BERLIN),
  ]
  const now = zoned('2026-09-08', '12:00', BERLIN)
  const w = inferWindow(findNights(msgs, now, BERLIN))!
  expect(clockDiff(w.startMin, 0)).toBeLessThanOrEqual(30)
  expect(w.endMin).toBe(480)
})

test('a timezone jump after a flight: each night reads on the clock it was slept on', () => {
  // Nine nights in one zone, a flight east, then four nights in the new zone —
  // the same 01:30–09:30 on the local clock throughout.
  const before = nightsFrom('2026-09-01', 9, '01:30', '09:30', BA)
  // Flight day: last message at the gate, first one off the plane, a zone apart.
  const flight: Inbound[] = [
    { ts: new Date(zoned('2026-09-10', '18:00', BA)).toISOString(), tz: BA },
    { ts: new Date(zoned('2026-09-10', '19:00', BA)).toISOString(), tz: BA },
    { ts: new Date(zoned('2026-09-10', '20:30', BA)).toISOString(), tz: BA },
    { ts: new Date(zoned('2026-09-11', '13:00', BERLIN)).toISOString(), tz: BERLIN },
    { ts: new Date(zoned('2026-09-11', '14:00', BERLIN)).toISOString(), tz: BERLIN },
    { ts: new Date(zoned('2026-09-11', '16:00', BERLIN)).toISOString(), tz: BERLIN },
    { ts: new Date(zoned('2026-09-11', '20:00', BERLIN)).toISOString(), tz: BERLIN },
  ]
  const after = nightsFrom('2026-09-11', 4, '01:30', '09:30', BERLIN)
  const msgs = [...before, ...flight, ...after]
  const now = zoned('2026-09-15', '12:00', BERLIN)

  const nights = findNights(msgs, now, BERLIN)
  // The night spanning the flight is not a night anyone slept normally.
  expect(nights.some(n => n.key === '2026-09-11')).toBe(false)
  expect(nights.filter(n => n.tz === BA).length).toBeGreaterThanOrEqual(8)
  expect(nights.filter(n => n.tz === BERLIN).length).toBe(4)
  for (const n of nights) { expect(n.bed).toBe(90); expect(n.wake).toBe(570) }

  const p = planProposal({ nights, quietHours: '23:00-08:00', state: fresh(), now })
  expect(p).not.toBeNull()
  expect(formatOffer(p!, BERLIN).buttons[0].data).toBe('sleep use 01:30-09:30')

  // Read entirely in today's zone — what it would be without the per-message
  // stamp — the pre-flight nights start at 06:30 and stop looking like nights.
  const unstamped = msgs.map(({ ts }) => ({ ts }))
  expect(findNights(unstamped, now, BERLIN).length).toBeLessThan(6)
})

test('flying west: without the stamp the old nights smear into a window nobody sleeps', () => {
  const before = nightsFrom('2026-09-01', 9, '01:30', '09:30', BERLIN)
  const flight: Inbound[] = [
    { ts: new Date(zoned('2026-09-10', '18:00', BERLIN)).toISOString(), tz: BERLIN },
    { ts: new Date(zoned('2026-09-10', '19:00', BERLIN)).toISOString(), tz: BERLIN },
    { ts: new Date(zoned('2026-09-10', '20:00', BERLIN)).toISOString(), tz: BERLIN },
    { ts: new Date(zoned('2026-09-11', '09:00', BA)).toISOString(), tz: BA },
    { ts: new Date(zoned('2026-09-11', '10:00', BA)).toISOString(), tz: BA },
    { ts: new Date(zoned('2026-09-11', '13:00', BA)).toISOString(), tz: BA },
    { ts: new Date(zoned('2026-09-11', '18:00', BA)).toISOString(), tz: BA },
    { ts: new Date(zoned('2026-09-11', '22:00', BA)).toISOString(), tz: BA },
  ]
  const after = nightsFrom('2026-09-11', 4, '01:30', '09:30', BA)
  const msgs = [...before, ...flight, ...after]
  const now = zoned('2026-09-15', '12:00', BA)

  const nights = findNights(msgs, now, BA)
  expect(nights.length).toBeGreaterThanOrEqual(12)
  for (const n of nights) { expect(n.bed).toBe(90); expect(n.wake).toBe(570) }
  const p = planProposal({ nights, quietHours: '23:00-08:00', state: fresh(), now })
  expect(formatOffer(p!, BA).buttons[0].data).toBe('sleep use 01:30-09:30')

  // The same instants read in today's zone: the Berlin nights become 20:30–04:30.
  const smeared = findNights(msgs.map(({ ts }) => ({ ts })), now, BA)
  expect(smeared.filter(n => n.bed === 20 * 60 + 30).length).toBeGreaterThanOrEqual(8)
  expect(inferWindow(smeared)).not.toEqual({ startMin: 90, endMin: 570 })
})

test('nights with too little data are ignored', () => {
  const now = zoned('2026-09-13', '12:00', BERLIN)
  // Only one message either side of each gap: bedtime and waking are not seen.
  const thin: Inbound[] = []
  for (let i = 0; i < 12; i++) {
    const d = addDays('2026-09-01', i)
    thin.push(
      { ts: new Date(zoned(addDays(d, 1), '01:30', BERLIN)).toISOString(), tz: BERLIN },
      { ts: new Date(zoned(addDays(d, 1), '09:30', BERLIN)).toISOString(), tz: BERLIN },
    )
  }
  expect(findNights(thin, now, BERLIN)).toEqual([])

  // Three good nights is not enough for a median.
  const few = nightsFrom('2026-09-09', 3, '01:30', '09:30', BERLIN)
  expect(findNights(few, now, BERLIN).length).toBe(3)
  expect(inferWindow(findNights(few, now, BERLIN))).toBeNull()
  expect(planProposal({ nights: findNights(few, now, BERLIN), quietHours: '23:00-08:00', state: fresh(), now })).toBeNull()

  // A whole silent day between two evenings is a gap too long to be a night.
  const gappy: Inbound[] = [
    ...night('2026-09-01', '01:30', '09:30', BERLIN),
    { ts: new Date(zoned('2026-09-02', '21:00', BERLIN)).toISOString(), tz: BERLIN },
    { ts: new Date(zoned('2026-09-03', '22:00', BERLIN)).toISOString(), tz: BERLIN },
  ]
  expect(findNights(gappy, now, BERLIN).map(n => n.key)).toEqual(['2026-09-02'])
})

test('history older than fourteen days is not read', () => {
  const old = nightsFrom('2026-08-01', 10, '01:30', '09:30', BERLIN)
  const now = zoned('2026-09-13', '12:00', BERLIN)
  expect(findNights(old, now, BERLIN)).toEqual([])
})

test('fewer than three of the last four nights off the window proposes nothing', () => {
  const now = zoned('2026-09-13', '12:00', BERLIN)
  const msgs = [
    ...nightsFrom('2026-09-01', 8, '01:30', '09:30', BERLIN),
    ...nightsFrom('2026-09-09', 2, '23:00', '08:00', BERLIN),
    ...nightsFrom('2026-09-11', 2, '01:30', '09:30', BERLIN),
  ]
  const nights = findNights(msgs, now, BERLIN)
  expect(nights.slice(-4).length).toBe(4)
  expect(planProposal({ nights, quietHours: '23:00-08:00', state: fresh(), now })).toBeNull()

  // Three of the last four is enough.
  const msgs3 = [
    ...nightsFrom('2026-09-01', 8, '01:30', '09:30', BERLIN),
    ...nightsFrom('2026-09-09', 1, '23:00', '08:00', BERLIN),
    ...nightsFrom('2026-09-10', 3, '01:30', '09:30', BERLIN),
  ]
  expect(planProposal({ nights: findNights(msgs3, now, BERLIN), quietHours: '23:00-08:00', state: fresh(), now })).not.toBeNull()
})

test('no configured window, or one switched off, is nothing to correct', () => {
  const now = zoned('2026-09-13', '12:00', BERLIN)
  const nights = findNights(nightsFrom('2026-09-01', 12, '01:30', '09:30', BERLIN), now, BERLIN)
  expect(planProposal({ nights, state: fresh(), now })).toBeNull()
  expect(planProposal({ nights, quietHours: 'garbage', state: fresh(), now })).toBeNull()
})

test('the same window is never proposed twice, and an unanswered offer quiets the next for two weeks', () => {
  const now = zoned('2026-09-13', '12:00', BERLIN)
  const nights = findNights(nightsFrom('2026-09-01', 12, '01:30', '09:30', BERLIN), now, BERLIN)
  const p = planProposal({ nights, quietHours: '23:00-08:00', state: fresh(), now })!
  const st = markProposed(fresh(), p, now)
  expect(st.pending).toEqual({ window: '01:30-09:30', keep: '23:00-08:00', at: new Date(now).toISOString() })

  // Tomorrow: inside the cooldown.
  expect(planProposal({ nights, quietHours: '23:00-08:00', state: st, now: now + DAY })).toBeNull()
  // A month on, the same nights: that window was offered already.
  expect(planProposal({ nights, quietHours: '23:00-08:00', state: st, now: now + 30 * DAY })).toBeNull()
  // A month on, a different window is a new offer.
  const later = findNights(nightsFrom('2026-09-30', 12, '02:30', '10:30', BERLIN), now + 30 * DAY, BERLIN)
  const p2 = planProposal({ nights: later, quietHours: '23:00-08:00', state: st, now: now + 30 * DAY })
  expect(p2).not.toBeNull()
  expect(formatOffer(p2!, BERLIN).buttons[0].data).toBe('sleep use 02:30-10:30')
})

test('[keep] mutes proposals for fourteen days', () => {
  const now = zoned('2026-09-13', '12:00', BERLIN)
  const nights = findNights(nightsFrom('2026-09-01', 12, '01:30', '09:30', BERLIN), now, BERLIN)
  const st = markProposed(fresh(), planProposal({ nights, quietHours: '23:00-08:00', state: fresh(), now })!, now)
  const r = applyTap(st, 'sleep keep 23:00-08:00', now + 60_000)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.quietHours).toBeUndefined()
  expect(r.state.pending).toBeUndefined()
  expect(Date.parse(r.state.mutedUntil!)).toBe(now + 60_000 + 14 * DAY)

  // The mute on its own, without the never-twice record, still holds for 14 days.
  const muteOnly: SleepState = { proposed: [], mutedUntil: r.state.mutedUntil }
  expect(planProposal({ nights, quietHours: '23:00-08:00', state: muteOnly, now: now + 13 * DAY })).toBeNull()
  expect(planProposal({ nights, quietHours: '23:00-08:00', state: muteOnly, now: now + 15 * DAY })).not.toBeNull()
})

test('[use] sets the window once; a second or forged tap changes nothing', () => {
  const now = zoned('2026-09-13', '12:00', BERLIN)
  const nights = findNights(nightsFrom('2026-09-01', 12, '01:30', '09:30', BERLIN), now, BERLIN)
  const st = markProposed(fresh(), planProposal({ nights, quietHours: '23:00-08:00', state: fresh(), now })!, now)

  // A button the reply tool could mint, naming a window the server never offered.
  expect(applyTap(st, 'sleep use 03:00-04:00', now).ok).toBe(false)
  expect(applyTap(st, 'sleep keep 01:30-09:30', now).ok).toBe(false)
  expect(applyTap(st, 'something else', now).ok).toBe(false)

  const r = applyTap(st, 'sleep use 01:30-09:30', now)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.quietHours).toBe('01:30-09:30')
  expect(r.line).toBe('quiet hours now 01:30–09:30')
  expect(r.state.decisions).toEqual([{ choice: 'use', window: '01:30-09:30', at: new Date(now).toISOString() }])
  expect(applyTap(r.state, 'sleep use 01:30-09:30', now).ok).toBe(false)
  expect(applyTap(r.state, 'sleep keep 23:00-08:00', now).ok).toBe(false)

  // After switching, the same nights fit the new window: nothing more to say.
  expect(planProposal({ nights, quietHours: '01:30-09:30', state: r.state, now: now + 30 * DAY })).toBeNull()
})

test('a [use] tap writes through the settings door: one field, on, and a tap clears it', () => {
  const a = { quietHoursOff: '22:00-07:00', emailScanMinutes: 30, allowFrom: ['1234567890'] }
  const b = setQuietWindow(a, '01:30-09:30')
  expect(b).toEqual({ quietHours: '01:30-09:30', emailScanMinutes: 30, allowFrom: ['1234567890'] })
  expect(a.quietHoursOff).toBe('22:00-07:00')   // a copy, never the original
  expect(accessToggles(b).find(t => t.id === 'setting:quiet')).toMatchObject({ on: true, label: 'quiet hours 01:30-09:30' })
  expect(() => setQuietWindow(a, '1:30-9:30; rm')).toThrow()

  expect(classify(['setting:quiet'], 'user-typed', { kind: 'tapped', buttonData: 'sleep use 01:30-09:30' }).allowed).toBe(true)
  expect(classify(['setting:quiet'], 'external-content', { kind: 'tapped', buttonData: 'sleep use 01:30-09:30' }).allowed).toBe(false)
})

test('the store: missing is empty, corrupt is moved aside, a save reads back', () => {
  const f = join(tmp, 'sleep.json')
  expect(loadSleep(f)).toEqual({ proposed: [] })
  writeFileSync(f, '{nope')
  expect(loadSleep(f)).toEqual({ proposed: [] })
  expect(existsSync(f)).toBe(false)
  expect(readdirSync(tmp).some(n => n.startsWith('sleep.json.corrupt-'))).toBe(true)

  const st: SleepState = { proposed: [{ window: '01:30-09:30', at: '2026-09-13T10:00:00.000Z' }], mutedUntil: '2026-09-27T10:00:00.000Z' }
  saveSleep(f, st)
  expect(loadSleep(f)).toEqual(st)
  expect(readdirSync(tmp).some(n => n.endsWith('.tmp'))).toBe(false)
})

test('defaults match the spec: five-hour gaps, fourteen days, 90 minutes, three of four', () => {
  expect(DEFAULTS).toMatchObject({ minGapHours: 5, days: 14, toleranceMin: 90, recentNights: 4, recentHits: 3, muteDays: 14 })
})
