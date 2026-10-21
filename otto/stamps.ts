/**
 * The passport page: one stamp per city the user has been to, from the trips
 * they booked (every airport they landed at, every stay) and the places they
 * told Otto they had been to or loved. Each stamp carries the date of the first
 * visit and the places saved there, so tapping it shows what they thought.
 *
 * Read-only. /app/stamps serves it to app tokens only: place notes are theirs.
 */
import type { Trip, AirportTable } from './trips.ts'
import { type Place, fold } from './places.ts'

export type StampPlace = { name: string; kind: string; status: string; recommendedBy?: string; note?: string }

export type Stamp = {
  id: string
  city?: string
  /** IATA code of the airport landed at, when the stamp came from a flight. */
  code?: string
  /** ISO 3166-1 alpha-2, uppercase, when known. */
  country?: string
  /** YYYY-MM-DD: first and latest arrival. */
  first: string
  last: string
  visits: number
  places: StampPlace[]
}

const BEEN = new Set(['been', 'loved'])

export function stamps(trips: Trip[], airports: AirportTable, places: Place[]): Stamp[] {
  const out = new Map<string, Stamp>()
  const days = new Map<string, Set<string>>()   // a visit is a day: two legs landing the same day are one
  const visit = (key: string, day: string, base: Omit<Stamp, 'id' | 'first' | 'last' | 'visits' | 'places'>) => {
    const seen = days.get(key) ?? days.set(key, new Set()).get(key)!
    const s = out.get(key)
    if (!s) { seen.add(day); out.set(key, { id: key, ...base, first: day, last: day, visits: 1, places: [] }); return }
    if (day < s.first) s.first = day
    if (day > s.last) s.last = day
    if (!seen.has(day)) { seen.add(day); s.visits++ }
    s.code ??= base.code; s.country ??= base.country; s.city ??= base.city
  }
  for (const trip of trips) for (const seg of trip.segments) {
    if (seg.kind === 'flight') {
      if (!seg.to) continue
      const day = (seg.arrive?.local ?? seg.depart.local).slice(0, 10)
      const ap = airports[seg.to]
      // One stamp per city: two airports in one city share it; an airport with no city stands alone.
      visit(ap?.city ? fold(ap.city) : seg.to, day, { code: seg.to, ...(ap?.city ? { city: ap.city } : {}), ...(ap?.country ? { country: ap.country.toUpperCase() } : {}) })
    } else if (seg.city) {
      visit(fold(seg.city), seg.checkIn, { city: seg.city, ...(seg.country ? { country: seg.country.toUpperCase() } : {}) })
    }
  }
  for (const p of places) {
    const key = fold(p.city)
    const s = out.get(key) ?? (BEEN.has(p.status) ? (visit(key, p.createdAt.slice(0, 10), { city: p.city }), out.get(key)!) : undefined)
    if (!s) continue
    const note = p.notes.at(-1)?.text
    s.places.push({ name: p.name, kind: p.kind, status: p.status, ...(p.recommendedBy ? { recommendedBy: p.recommendedBy } : {}), ...(note ? { note } : {}) })
  }
  return [...out.values()].sort((a, b) => a.first.localeCompare(b.first) || a.id.localeCompare(b.id))
}
