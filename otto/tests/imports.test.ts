import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { SERVER_FILES } from '../deadsweep.ts'

// Bun lets a module import the same name from two modules, and the later one
// silently wins: a parked-session formatter once printed every recalled note as
// [object Object], and a key-shelf helper took over birthday nudges.
test.each(SERVER_FILES)('%s never imports one name twice', file => {
  const src = readFileSync(join(import.meta.dir, '..', file), 'utf8')
  const seen = new Map<string, number>()
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const local = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim()
      if (local) seen.set(local, (seen.get(local) ?? 0) + 1)
    }
  }
  expect([...seen].filter(([, n]) => n > 1).map(([name]) => name)).toEqual([])
})
