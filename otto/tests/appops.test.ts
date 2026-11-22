import { test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SeenOps } from '../appops.ts'

test('an op is handled once, even across a restart', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ops-')), 'app-ops.json')
  const a = new SeenOps(file)
  expect(a.add('m1')).toBe(true)
  expect(a.add('m1')).toBe(false)
  const b = new SeenOps(file)   // a new process reading the same file
  expect(b.has('m1')).toBe(true)
  expect(b.add('m1')).toBe(false)
})

test('keeps only the newest ids', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ops-')), 'app-ops.json')
  const s = new SeenOps(file, 3)
  for (const id of ['a', 'b', 'c', 'd']) s.add(id)
  expect(s.has('a')).toBe(false)
  expect(new SeenOps(file, 3).has('d')).toBe(true)
})

test('keep reports whether the id reached the disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-'))
  const s = new SeenOps(join(dir, 'app-ops.json'))
  expect(s.keep('a')).toBe(true)
  expect(new SeenOps(join(dir, 'app-ops.json')).has('a')).toBe(true)
  const { mkdirSync } = require('fs')
  mkdirSync(join(dir, 'app-ops.json.tmp'))   // writes now fail
  expect(s.keep('b')).toBe(false)
  expect(s.has('b')).toBe(false)
})
