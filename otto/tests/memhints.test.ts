import { test, expect } from 'bun:test'
import { memHints, memHandle, HANDLE_RE, seenFromLog, type Memory } from '../memory.ts'

const mem = (name: string, description: string, body: string, ageDays = 1): Memory => ({
  name, description, body, type: 'reference', scope: 'global', path: `/m/${name}.md`,
  mtimeMs: Date.now() - ageDays * 86_400_000, links: [],
})
const lights = mem('smartthings-cli-home-lights', 'home lights and ACs are controlled with the SmartThings CLI', 'smartthings devices:commands switch off bedroom desk lamp bulbs', 40)
const pool = [lights, mem('bananas', 'banana bread recipe', 'flour sugar oven'), mem('cats', 'the cat', 'meow')]

test('handle is short, stable and recall-shaped', () => {
  expect(memHandle(lights)).toBe(memHandle(lights))
  expect(HANDLE_RE.test(memHandle(lights))).toBe(true)
})

test('a matching message gets a hint, offered once, with age when stale', () => {
  const seen = new Set<string>()
  const msg = 'turn off the bedroom lights with smartthings, desk lamp too'
  // BM25 scores scale with corpus size; the real threshold assumes ~800 memories.
  const h = memHints(pool, msg, seen, Date.now(), 0)
  expect(h.startsWith(memHandle(lights) + ' home lights')).toBe(true)
  expect(h).toContain('(40d)')
  expect(h).not.toContain('banana')
  expect(memHints(pool, msg, seen, Date.now(), 0)).toBe('')
})

test('short or unmatched messages get nothing', () => {
  expect(memHints(pool, 'yeah', new Set())).toBe('')
  expect(memHints(pool, 'what is the weather in tokyo today', new Set(), Date.now(), 0)).toBe('')
})

test('a reload keeps what this session already saw, and only this session', () => {
  const log = [
    JSON.stringify({ ts: 't', sess: 42, offered: ['maaaa', 'mbbbb'], chars: 30 }),
    JSON.stringify({ ts: 't', sess: 42, returned: ['mcccc'] }),
    JSON.stringify({ ts: 't', sess: 420, opened: ['mdddd'] }),
    JSON.stringify({ ts: 't', offered: ['meeee'] }),
    'not json',
  ].join('\n')
  expect([...seenFromLog(log, 42)].sort()).toEqual(['maaaa', 'mbbbb', 'mcccc'])
  const seen = seenFromLog(JSON.stringify({ sess: 7, returned: [memHandle(lights)] }), 7)
  expect(memHints(pool, 'turn off the bedroom lights with smartthings, desk lamp too', seen, Date.now(), 0)).toBe('')
})
