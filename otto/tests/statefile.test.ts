import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadState, saveState } from '../statefile.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'statefile-'))
const empty = () => ({ n: 0 })
const valid = (x: unknown) => typeof (x as { n?: unknown })?.n === 'number'

test('round-trips', () => {
  const f = join(dir(), 's.json')
  saveState(f, { n: 3 })
  expect(loadState(f, empty, valid)).toEqual({ n: 3 })
})

test('a missing file is empty and nothing gets created', () => {
  const f = join(dir(), 's.json')
  expect(loadState(f, empty, valid)).toEqual({ n: 0 })
  expect(existsSync(f)).toBe(false)
})

test('a corrupt file is moved aside', () => {
  const d = dir(), f = join(d, 's.json')
  writeFileSync(f, '{nope')
  expect(loadState(f, empty, valid)).toEqual({ n: 0 })
  expect(readdirSync(d).some(n => n.startsWith('s.json.corrupt-'))).toBe(true)
})

test('peek leaves a corrupt file alone', () => {
  const f = join(dir(), 's.json')
  writeFileSync(f, '{nope')
  expect(loadState(f, empty, valid, { peek: true })).toEqual({ n: 0 })
  expect(readFileSync(f, 'utf8')).toBe('{nope')
})

test('the wrong shape is empty', () => {
  const f = join(dir(), 's.json')
  writeFileSync(f, '{"n":"x"}')
  expect(loadState(f, empty, valid)).toEqual({ n: 0 })
})
