/**
 * The extra lines on an arrival note: the day's weather, what 1 unit of home
 * money buys there, and the user's own note on getting into town.
 *
 * Weather is Open-Meteo: free, keyless. Coordinates come from `lat`/`lon` on
 * the airports.json entry, else a geocode of its city, else of the IATA code.
 * The exchange line comes from the ECB cache in fx.ts and is a label like every
 * other converted figure. Transport is never generated: the line is the user's
 * words verbatim, or an instruction to the session not to make one up.
 *
 * Every part is best-effort and bounded by a timeout. A failure drops its line
 * and never the note; fetch is injected so the tests run offline.
 */

import type { AirportEntry, AirportTable } from './trips.ts'
import { formatMoney, minorDigits } from './money.ts'
import { convert, rateDateLabel, type FxRates } from './fx.ts'

export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
export const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

/** WMO weather interpretation codes, grouped the way Open-Meteo documents them. */
export const WMO_LABELS: Record<number, string> = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'fog',
  51: 'drizzle', 53: 'drizzle', 55: 'drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'rain', 63: 'rain', 65: 'rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'snow', 73: 'snow', 75: 'snow', 77: 'snow grains',
  80: 'showers', 81: 'showers', 82: 'showers',
  85: 'snow showers', 86: 'snow showers',
  95: 'thunderstorm', 96: 'thunderstorm', 99: 'thunderstorm',
}

export type DayWeather = { code: number; label?: string; max: number; min: number; rainPct?: number }

/** The first (only) day of an Open-Meteo daily block; undefined unless both temperatures are real numbers. */
export function parseForecast(json: unknown): DayWeather | undefined {
  const d = (json as { daily?: Record<string, unknown> } | null)?.daily
  const first = (k: string) => (Array.isArray(d?.[k]) ? (d![k] as unknown[])[0] : undefined)
  const max = first('temperature_2m_max'), min = first('temperature_2m_min')
  if (typeof max !== 'number' || typeof min !== 'number' || !Number.isFinite(max) || !Number.isFinite(min)) return undefined
  const code = first('weather_code'), rain = first('precipitation_probability_max')
  const c = typeof code === 'number' ? code : -1
  return {
    code: c, label: WMO_LABELS[c], max, min,
    ...(typeof rain === 'number' && Number.isFinite(rain) ? { rainPct: rain } : {}),
  }
}

export function formatWeatherLine(w: DayWeather, place: string): string {
  const rain = w.rainPct != null ? `, rain ${w.rainPct}%` : ''
  return `- weather today in ${place}: ${w.label ? `${w.label}, ` : ''}${Math.round(w.min)}–${Math.round(w.max)}°C${rain} (Open-Meteo)`
}

export type Coords = { lat: number; lon: number }

/** A geocoding answer to coordinates. An airport lookup accepts only airports, in the right country. */
export function pickGeocode(json: unknown, o: { airportCode?: boolean; country?: string }): Coords | undefined {
  const results = (json as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) return undefined
  const hit = o.airportCode
    ? results.find(r => r?.feature_code === 'AIRP' && (!o.country || String(r.country_code).toUpperCase() === o.country.toUpperCase()))
    : results[0]
  return typeof hit?.latitude === 'number' && typeof hit?.longitude === 'number'
    ? { lat: hit.latitude, lon: hit.longitude }
    : undefined
}

export async function coordsFor(code: string, ap: AirportEntry | undefined, fetch: Fetch, timeoutMs = 5000): Promise<Coords | undefined> {
  if (typeof ap?.lat === 'number' && typeof ap?.lon === 'number') return { lat: ap.lat, lon: ap.lon }
  const get = (q: string) => fetch(`${GEOCODE_URL}?${q}&format=json`, { signal: AbortSignal.timeout(timeoutMs) })
    .then(r => r.json(), () => undefined).catch(() => undefined)
  if (ap?.city) {
    const cc = ap.country ? `&countryCode=${encodeURIComponent(ap.country)}` : ''
    const c = pickGeocode(await get(`name=${encodeURIComponent(ap.city)}&count=1${cc}`), {})
    if (c) return c
  }
  return pickGeocode(await get(`name=${encodeURIComponent(code)}&count=5`), { airportCode: true, country: ap?.country })
}

export async function weatherLine(o: {
  code: string; airport?: AirportEntry; zone: string; day: string; fetch?: Fetch; timeoutMs?: number
}): Promise<string | undefined> {
  const f = o.fetch ?? fetch
  const c = await coordsFor(o.code, o.airport, f, o.timeoutMs)
  if (!c) return undefined
  const url = `${FORECAST_URL}?latitude=${c.lat}&longitude=${c.lon}`
    + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`
    + `&timezone=${encodeURIComponent(o.zone)}&start_date=${o.day}&end_date=${o.day}`
  const res = await f(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 5000) })
  if (!res.ok) return undefined
  const w = parseForecast(await res.json())
  return w ? formatWeatherLine(w, o.airport?.city ?? o.code) : undefined
}

export function moneyLine(home: string, dest: string | undefined, rates: FxRates | undefined): string | undefined {
  if (!dest || !rates || dest.toUpperCase() === home.toUpperCase()) return undefined
  const minor = convert(10 ** minorDigits(home), home, dest, rates)
  if (minor === undefined) return undefined
  return `- money: 1 ${home} ≈ ${formatMoney(minor / 10 ** minorDigits(dest), dest.toUpperCase())} (ECB ${rateDateLabel(rates.date)})`
}

export function transportLine(code: string, ap?: AirportEntry): string {
  return ap?.transport
    ? `- transport (your note for ${code}): ${ap.transport}`
    : `- no transport note on file for ${code}: do not suggest routes, lines or fares. If they mention how they got into town, offer once to save it (record_trip airport_zones {"${code}":{"transport":"…"}})`
}

/** [weather?, money?, transport], each part failing alone. */
export async function arrivalExtras(o: {
  code?: string; zone?: string; day?: string; airports: AirportTable; home: string; rates?: FxRates; fetch?: Fetch
}): Promise<string[]> {
  if (!o.code) return []
  const ap = o.airports[o.code]
  const weather = o.zone && o.day
    // ponytail: a landing after ~20:00 local still reads the arrival day's forecast; use tomorrow's if that ever matters.
    ? await weatherLine({ code: o.code, airport: ap, zone: o.zone, day: o.day, fetch: o.fetch }).catch(() => undefined)
    : undefined
  let money: string | undefined
  try { money = moneyLine(o.home, ap?.currency, o.rates) } catch {}
  return [weather, money, transportLine(o.code, ap)].filter((l): l is string => !!l)
}
