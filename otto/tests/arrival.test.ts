import { test, expect } from 'bun:test'
import {
  parseForecast, formatWeatherLine, coordsFor, pickGeocode, moneyLine, transportLine, arrivalExtras,
  FORECAST_URL, GEOCODE_URL,
} from '../arrival.ts'
import { parseEcbXml } from '../fx.ts'
import type { AirportTable } from '../trips.ts'
import { readFileSync } from 'fs'
import { join } from 'path'

const RATES = parseEcbXml(readFileSync(join(import.meta.dir, 'fixtures', 'fx', 'eurofxref-daily.xml'), 'utf8'))!

const BER_DAY = { daily: { weather_code: [3], temperature_2m_max: [22.3], temperature_2m_min: [16.1], precipitation_probability_max: [3] } }

/** Answers by URL prefix and records every call. */
function fakeFetch(answers: { [prefix: string]: unknown }) {
  const calls: string[] = []
  const fn = async (url: string) => {
    calls.push(url)
    const key = Object.keys(answers).find(k => url.startsWith(k))
    if (!key) throw new TypeError('fetch failed')
    return new Response(JSON.stringify(answers[key]), { status: 200 })
  }
  return { fn, calls }
}
const offline = async () => { throw new TypeError('fetch failed') }

test('a forecast day parses into labelled weather', () => {
  expect(parseForecast(BER_DAY)).toEqual({ code: 3, label: 'overcast', max: 22.3, min: 16.1, rainPct: 3 })
})

test('a forecast without real temperatures is nothing', () => {
  expect(parseForecast({ daily: { weather_code: [3], temperature_2m_max: [null], temperature_2m_min: [16] } })).toBeUndefined()
  expect(parseForecast({ daily: { temperature_2m_max: ['22'], temperature_2m_min: [16] } })).toBeUndefined()
  expect(parseForecast(null)).toBeUndefined()
  expect(parseForecast({})).toBeUndefined()
})

test('the weather line rounds and cites its source; an unknown code drops the label', () => {
  expect(formatWeatherLine(parseForecast(BER_DAY)!, 'Berlin')).toBe('- weather today in Berlin: overcast, 16–22°C, rain 3% (Open-Meteo)')
  const odd = parseForecast({ daily: { weather_code: [1234], temperature_2m_max: [10], temperature_2m_min: [4] } })!
  expect(formatWeatherLine(odd, 'Berlin')).toBe('- weather today in Berlin: 4–10°C (Open-Meteo)')
})

test('coordinates on the airport entry cost no fetch', async () => {
  const f = fakeFetch({})
  expect(await coordsFor('BER', { lat: 52.37, lon: 13.5 }, f.fn)).toEqual({ lat: 52.37, lon: 13.5 })
  expect(f.calls).toEqual([])
})

test('a city is geocoded within its country, first result wins', async () => {
  const f = fakeFetch({ [GEOCODE_URL]: { results: [{ latitude: 52.52, longitude: 13.41, feature_code: 'PPLC' }] } })
  expect(await coordsFor('BER', { city: 'Berlin', country: 'DE' }, f.fn)).toEqual({ lat: 52.52, lon: 13.41 })
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]).toContain('name=Berlin')
  expect(f.calls[0]).toContain('countryCode=DE')
})

test('a bare IATA code only accepts an airport in the right country', async () => {
  const results = [
    { latitude: 1, longitude: 2, feature_code: 'PPL', country_code: 'DE' },
    { latitude: 3, longitude: 4, feature_code: 'AIRP', country_code: 'US' },
    { latitude: 52.37, longitude: 13.5, feature_code: 'AIRP', country_code: 'DE' },
  ]
  const f = fakeFetch({ [GEOCODE_URL]: { results } })
  expect(await coordsFor('BER', { country: 'DE' }, f.fn)).toEqual({ lat: 52.37, lon: 13.5 })
  expect(f.calls[0]).toContain('name=BER')
  expect(pickGeocode({ results: results.slice(0, 1) }, { airportCode: true })).toBeUndefined()
})

test('no geocode match, or a throwing fetch, is no coordinates', async () => {
  const f = fakeFetch({ [GEOCODE_URL]: { results: [] } })
  expect(await coordsFor('BER', { city: 'Berlin' }, f.fn)).toBeUndefined()
  expect(await coordsFor('BER', undefined, offline)).toBeUndefined()
})

test('the exchange line is one home unit in the destination currency, dated', () => {
  expect(moneyLine('EUR', 'BRL', RATES)).toBe('- money: 1 EUR ≈ R$6.19 (ECB 9 Oct)')
  expect(moneyLine('EUR', 'EUR', RATES)).toBeUndefined()
  expect(moneyLine('EUR', undefined, RATES)).toBeUndefined()
  expect(moneyLine('EUR', 'BRL', undefined)).toBeUndefined()
  expect(moneyLine('EUR', 'ARS', RATES)).toBeUndefined()
})

test('transport is the note verbatim, or a ban on inventing one', () => {
  expect(transportLine('BER', { transport: 'FEX to Hauptbahnhof' })).toBe('- transport (your note for BER): FEX to Hauptbahnhof')
  const none = transportLine('BER')
  expect(none).toContain('no transport note on file for BER')
  expect(none).toContain('do not suggest routes')
})

test('arrival extras: only the transport line survives a dead network and no rates', async () => {
  const airports: AirportTable = { BER: { city: 'Berlin', country: 'DE', currency: 'BRL' } }
  const out = await arrivalExtras({ code: 'BER', zone: 'Europe/Berlin', day: '2026-10-03', airports, home: 'EUR', fetch: offline })
  expect(out).toHaveLength(1)
  expect(out[0]).toContain('no transport note')
})

test('arrival extras: weather, money and transport, in that order', async () => {
  const airports: AirportTable = { BER: { city: 'Berlin', country: 'DE', currency: 'BRL', lat: 52.37, lon: 13.5, transport: 'train' } }
  const f = fakeFetch({ [FORECAST_URL]: BER_DAY })
  const out = await arrivalExtras({ code: 'BER', zone: 'Europe/Berlin', day: '2026-10-03', airports, home: 'EUR', rates: RATES, fetch: f.fn })
  expect(out).toEqual([
    '- weather today in Berlin: overcast, 16–22°C, rain 3% (Open-Meteo)',
    '- money: 1 EUR ≈ R$6.19 (ECB 9 Oct)',
    '- transport (your note for BER): train',
  ])
  expect(f.calls[0]).toContain('latitude=52.37&longitude=13.5')
  expect(f.calls[0]).toContain('timezone=Europe%2FBerlin&start_date=2026-10-03&end_date=2026-10-03')
})

test('no airport code, no extras; no zone, no weather call', async () => {
  expect(await arrivalExtras({ airports: {}, home: 'EUR' })).toEqual([])
  const f = fakeFetch({})
  const out = await arrivalExtras({ code: 'BER', airports: { BER: { lat: 1, lon: 2 } }, home: 'EUR', fetch: f.fn })
  expect(out).toHaveLength(1)
  expect(f.calls).toEqual([])
})
