import { test, expect } from 'bun:test'
import {
  schengenUsage, yearDays, tripDays, stayAlerts, stayLimitsConfig, formatLimits, SCHENGEN, type Day,
} from '../staylimits.ts'
import type { Trip, AirportTable, FlightSegment } from '../trips.ts'

const run = (country: string, from: string, to: string): Day[] => {
  const out: Day[] = []
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) out.push({ country, date: new Date(t).toISOString().slice(0, 10) })
  return out
}

test('window rolls across a year boundary', () => {
  const days = run('IT', '2025-11-01', '2025-12-10') // 40 days
  expect(schengenUsage(days, '2026-01-05').used).toBe(40)
  // the 180-day window ending 2026-04-30 starts 2025-11-02, so day 1 has dropped out
  expect(schengenUsage(days, '2026-04-30').used).toBe(39)
  expect(schengenUsage(days, '2026-06-30').used).toBe(0)
})

test('entry and exit days both count, and a day in two Schengen states counts once', () => {
  const days = [...run('FR', '2026-03-01', '2026-03-05'), ...run('IT', '2026-03-05', '2026-03-10')]
  expect(schengenUsage(days, '2026-03-31').used).toBe(10)
})

test('non-Schengen countries are not counted', () => {
  const days = [...run('GB', '2026-03-01', '2026-03-30'), ...run('BR', '2026-04-01', '2026-04-30'), ...run('IT', '2026-05-01', '2026-05-03')]
  expect(schengenUsage(days, '2026-05-10').used).toBe(3)
  expect(SCHENGEN.has('GB')).toBe(false)
})

test('left and stay-until', () => {
  const u = schengenUsage(run('DE', '2026-03-01', '2026-03-30'), '2026-04-01')
  expect(u.left).toBe(60)
  expect(u.stayUntil).toBe('2026-05-30') // 30 used + today + 59 more = 90
  expect(schengenUsage(run('DE', '2026-03-01', '2026-05-29'), '2026-06-01').stayUntil).toBeNull()
})

test('183: distinct days per country in the calendar year only', () => {
  const days = [...run('PT', '2025-12-20', '2026-01-10'), ...run('PT', '2026-01-05', '2026-01-12'), ...run('BR', '2026-02-01', '2026-08-02')]
  const y = yearDays(days, 2026)
  expect(y.find(r => r.country === 'PT')).toEqual({ country: 'PT', days: 12, left: 171 })
  expect(y.find(r => r.country === 'BR')).toEqual({ country: 'BR', days: 183, left: 0 })
})

test('thresholds fire once, clear, and can fire again', () => {
  const cfg = { schengen: true, taxCountries: ['BR'] }
  const days = run('IT', '2026-03-01', '2026-05-20') // 81 used, 9 left
  let r = stayAlerts(days, cfg, '2026-05-25', [])
  expect(r.messages).toHaveLength(1)
  r = stayAlerts(days, cfg, '2026-05-26', r.fired)
  expect(r.messages).toHaveLength(0)
  r = stayAlerts([], cfg, '2026-12-01', r.fired) // breach cleared
  expect(r.fired).toEqual([])
  expect(stayAlerts(days, cfg, '2026-05-25', r.fired).messages).toHaveLength(1)
  const br = run('BR', '2026-01-01', '2026-06-01') // 152 days
  r = stayAlerts(br, cfg, '2026-06-02', [])
  expect(r.messages[0]).toContain('BR')
  expect(stayAlerts(br, cfg, '2026-06-03', r.fired).messages).toHaveLength(0)
})

test('off by default, and trips feed the day list', () => {
  expect(stayLimitsConfig(undefined)).toEqual({ schengen: false, taxCountries: [] })
  expect(stayLimitsConfig({ schengen: 'yes' }).schengen).toBe(false)
  const airports: AirportTable = { FCO: { country: 'IT' } }
  const flight: FlightSegment = { kind: 'flight', flight: 'XX1', carrier: 'XX', from: 'AAA', to: 'FCO', depart: { local: '2026-03-01T08:00' }, arrive: { local: '2026-03-01T10:00' } }
  const trip = { id: 't', start: '2026-03-01', end: '2026-03-04', segments: [flight], pnrs: [], sources: [], updatedAt: '' } as Trip
  const days = tripDays([trip], airports)
  expect(days).toHaveLength(4)
  expect(formatLimits(days, { schengen: true, taxCountries: ['IT'] }, '2026-03-04')).toContain('Schengen: 4/90 used, 86 left')
})
