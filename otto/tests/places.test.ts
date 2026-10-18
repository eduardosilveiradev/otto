import { test, expect, afterAll, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  fold, placeId, findPlace, recordPlace, resolveRecommender, queryPlaces, searchPlaces,
  formatPlace, loadPlaces, readPlaces, savePlaces, type Place,
} from '../places.ts'
import { recordPerson, type Person } from '../people.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-places-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const T1 = '2026-05-01T10:00:00.000Z'
const T2 = '2026-06-01T10:00:00.000Z'
const T3 = '2026-07-01T10:00:00.000Z'

function seed(): Place[] {
  const ps: Place[] = []
  recordPlace(ps, { name: 'Café Lume', city: 'Lisboa', kind: 'cafe', note: 'best pastel in town', tags: ['brunch'], at: T1 })
  recordPlace(ps, { name: 'Taberna Azul', city: 'Lisboa', kind: 'restaurant', status: 'avoid', note: 'cold food, never again', at: T2 })
  recordPlace(ps, { name: 'Nightjar', city: 'London', kind: 'bar', tags: ['cocktails', '#Speakeasy'], at: T3 })
  return ps
}

test('fold drops case, accents and extra spacing, and nothing else', () => {
  expect(fold('  Café   LÚME ')).toBe('cafe lume')
  expect(fold('São Paulo')).toBe('sao paulo')
  expect(placeId('Café Lume', 'Lisboa')).toBe('cafe lume|lisboa')
  expect(placeId('Café Lume', 'Porto')).not.toBe(placeId('Café Lume', 'Lisboa'))
})

test('a new place defaults to want and other, keeps the spelling given, and dates the note', () => {
  const ps: Place[] = []
  const { place, created } = recordPlace(ps, { name: ' Café  Lume ', city: 'Lisboa', note: 'Ana says go early', at: T1 })
  expect(created).toBe(true)
  expect(place).toEqual({
    id: 'cafe lume|lisboa', name: 'Café Lume', city: 'Lisboa', kind: 'other', status: 'want',
    tags: [], notes: [{ at: T1, text: 'Ana says go early' }], createdAt: T1, updatedAt: T1,
  })
})

test('name and city are required; kind and status must be one of the enum', () => {
  expect(() => recordPlace([], { name: '', city: 'Lisboa' })).toThrow(/name/)
  expect(() => recordPlace([], { name: 'Lume', city: ' ' })).toThrow(/city/)
  expect(() => recordPlace([], { name: 'Lume', city: 'Lisboa', kind: 'club' })).toThrow(/kind must be one of/)
  expect(() => recordPlace([], { name: 'Lume', city: 'Lisboa', status: 'maybe' })).toThrow(/status must be one of/)
  // Case is forgiven; a near miss is not.
  expect(recordPlace([], { name: 'Lume', city: 'Lisboa', kind: 'Cafe', status: 'LOVED' }).place).toMatchObject({ kind: 'cafe', status: 'loved' })
})

test('same name in the same city, case and accents aside, merges and keeps what it displaced as dated notes', () => {
  const ps = seed()
  const { place, created } = recordPlace(ps, { name: 'cafe lume', city: 'LISBOA', status: 'loved', kind: 'restaurant', note: 'went with Ana, worth it', tags: ['Brunch', 'pastry'], at: T3 })
  expect(created).toBe(false)
  expect(ps.length).toBe(3)
  expect(place.name).toBe('Café Lume') // first spelling stays
  expect(place.status).toBe('loved')
  expect(place.kind).toBe('restaurant')
  expect(place.tags).toEqual(['brunch', 'pastry'])
  expect(place.notes).toEqual([
    { at: T1, text: 'best pastel in town' },
    { at: T3, text: 'kind was cafe' },
    { at: T3, text: 'status was want' },
    { at: T3, text: 'went with Ana, worth it' },
  ])
  expect(place.createdAt).toBe(T1)
  expect(place.updatedAt).toBe(T3)
})

test('the same name in another city is another place', () => {
  const ps = seed()
  const { created } = recordPlace(ps, { name: 'Café Lume', city: 'Porto', at: T3 })
  expect(created).toBe(true)
  expect(ps.length).toBe(4)
  expect(findPlace(ps, 'CAFE LUME', 'porto')?.city).toBe('Porto')
})

test('an update with nothing new adds no notes, and a repeated note is not stored twice', () => {
  const ps = seed()
  recordPlace(ps, { name: 'Café Lume', city: 'Lisboa', kind: 'cafe', status: 'want', note: 'best pastel in town', at: T3 })
  expect(findPlace(ps, 'Café Lume', 'Lisboa')!.notes).toEqual([{ at: T1, text: 'best pastel in town' }])
})

test('tags are lowercased, de-hashed and unique', () => {
  const ps = seed()
  expect(findPlace(ps, 'Nightjar', 'London')!.tags).toEqual(['cocktails', 'speakeasy'])
})

test('recommender: one match links to the person, none records a mention, two throws', () => {
  const people: Person[] = []
  recordPerson(people, { name: 'Ana Souza', email: 'ana@example.com', city: 'Lisbon' })
  const ana = resolveRecommender(people, 'Ana')
  expect(ana).toEqual({ id: 'ana@example.com', name: 'Ana Souza' })

  const sam = resolveRecommender(people, 'Sam')
  expect(sam.id).toBe('name:sam')
  expect(people.find(p => p.id === 'name:sam')?.mentions).toBe(1)

  recordPerson(people, { name: 'Marco Rossi', email: 'marco.r@example.com' })
  recordPerson(people, { name: 'Marco Bianchi', email: 'marco.b@example.com' })
  const before = people.length
  expect(() => resolveRecommender(people, 'Marco')).toThrow(/more than one Marco: .* — say which/)
  expect(people.length).toBe(before) // no third Marco
  expect(() => resolveRecommender(people, '  ')).toThrow(/empty/)
})

test('a new recommender replaces the old one, which stays as a note; the same one adds nothing', () => {
  const ps: Place[] = []
  recordPlace(ps, { name: 'Lume', city: 'Lisboa', recommendedBy: { id: 'name:sam', name: 'Sam' }, at: T1 })
  recordPlace(ps, { name: 'Lume', city: 'Lisboa', recommendedBy: { id: 'name:sam', name: 'Sam' }, at: T2 })
  expect(ps[0].notes).toEqual([])
  recordPlace(ps, { name: 'Lume', city: 'Lisboa', recommendedBy: { id: 'ana@example.com', name: 'Ana Souza' }, at: T3 })
  expect(ps[0].recommendedBy).toBe('Ana Souza')
  expect(ps[0].recommenderId).toBe('ana@example.com')
  expect(ps[0].notes).toEqual([{ at: T3, text: 'recommended by Sam' }])
})

test('query filters by folded city, kind, status and free text, newest first', () => {
  const ps = seed()
  recordPlace(ps, { name: 'Café Lume', city: 'Lisboa', recommendedBy: { id: 'name:ana', name: 'Ana' }, at: '2026-08-01T00:00:00.000Z' })
  expect(queryPlaces(ps).map(p => p.name)).toEqual(['Café Lume', 'Nightjar', 'Taberna Azul'])
  expect(queryPlaces(ps, { city: 'lisboa' }).map(p => p.name)).toEqual(['Café Lume', 'Taberna Azul'])
  expect(queryPlaces(ps, { kind: 'bar' }).map(p => p.name)).toEqual(['Nightjar'])
  expect(queryPlaces(ps, { status: 'avoid' }).map(p => p.name)).toEqual(['Taberna Azul'])
  expect(queryPlaces(ps, { text: 'PASTEL' }).map(p => p.name)).toEqual(['Café Lume'])
  expect(queryPlaces(ps, { text: 'ana' }).map(p => p.name)).toEqual(['Café Lume'])
  expect(queryPlaces(ps, { text: 'speakeasy' }).map(p => p.name)).toEqual(['Nightjar'])
  expect(queryPlaces(ps, { text: 'cafe lume' }).map(p => p.name)).toEqual(['Café Lume'])
  expect(queryPlaces(ps, { limit: 1 }).length).toBe(1)
  expect(() => queryPlaces(ps, { kind: 'club' })).toThrow()
})

test('recall search: any word of three letters or more, ranked by how many matched', () => {
  const ps = seed()
  expect(searchPlaces(ps, 'brunch lisboa').map(p => p.name)).toEqual(['Café Lume', 'Taberna Azul'])
  expect(searchPlaces(ps, 'cocktails')[0].name).toBe('Nightjar')
  expect(searchPlaces(ps, 'landlord')).toEqual([])
  expect(searchPlaces(ps, 'a of')).toEqual([]) // nothing distinctive to look for
  expect(searchPlaces(ps, 'lisboa', 1).length).toBe(1)
})

test('formatPlace is one line, and quotes what the user said rather than a merge note', () => {
  const ps = seed()
  recordPlace(ps, { name: 'Café Lume', city: 'Lisboa', status: 'loved', recommendedBy: { id: 'name:ana', name: 'Ana' }, at: T3 })
  expect(formatPlace(findPlace(ps, 'Café Lume', 'Lisboa')!)).toBe('Café Lume (Lisboa) · cafe · loved · via Ana · #brunch — "best pastel in town"')
  expect(formatPlace(findPlace(ps, 'Nightjar', 'London')!)).toBe('Nightjar (London) · bar · want · #cocktails #speakeasy')
})

test('store round-trips, writes 0600 through a tmp file, and a missing file is empty', () => {
  const file = join(tmp, 'places.json')
  expect(loadPlaces(file)).toEqual([])
  expect(readPlaces(file)).toEqual([])
  const ps = seed()
  savePlaces(file, ps)
  expect(loadPlaces(file)).toEqual(ps)
  expect(readPlaces(file)).toEqual(ps)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(readdirSync(tmp).some(f => f.endsWith('.tmp'))).toBe(false)
})

test('a corrupt file is moved aside by the store, and left alone by the read-only reader', () => {
  const dir = mkdtempSync(join(tmp, 'corrupt-'))
  const file = join(dir, 'places.json')
  writeFileSync(file, '{ not json')
  expect(() => readPlaces(file)).toThrow()
  expect(readFileSync(file, 'utf8')).toBe('{ not json')
  const err = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    expect(loadPlaces(file)).toEqual([])
  } finally {
    err.mockRestore()
  }
  expect(readdirSync(dir).some(f => f.startsWith('places.json.corrupt-'))).toBe(true)
})
