import { test, expect } from 'bun:test'
import { TOOLS } from '../tools.ts'

/** Every description in a tool, its parameters and nested item schemas included. */
function descriptions(node: unknown): string[] {
  if (!node || typeof node !== 'object') return []
  return Object.entries(node).flatMap(([k, v]) => k === 'description' && typeof v === 'string' ? [v] : descriptions(v))
}

// Other people run Otto too: a description says "the user" or "they", never he or she.
// Quoted examples are the user's own words about someone else, so they are left alone.
test('tool descriptions call the user "the user" or "they"', () => {
  const unquoted = (s: string) => s.replace(/"[^"]*"/g, '')
  const texts = TOOLS.flatMap(t => [t.description ?? '', ...descriptions(t.inputSchema)])
  expect(texts.length).toBeGreaterThan(TOOLS.length * 2)
  expect(texts.filter(d => /\b(he|him|his|she|her)\b/i.test(unquoted(d)))).toEqual([])
  expect(TOOLS.filter(t => !t.description).map(t => t.name)).toEqual([])
})
