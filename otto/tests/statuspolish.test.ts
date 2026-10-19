import { test, expect } from 'bun:test'
import { wantsPolish, cleanStatus, polishStatus } from '../statuspolish.ts'
import { LiveSteps } from '../livesteps.ts'

test('only bare labels get polished', () => {
  expect(wantsPolish('mcp__plugin_otto_otto__recall', 'Remembering')).toBe(true)
  expect(wantsPolish('mcp__school__get_agenda', 'Get agenda')).toBe(true)
  expect(wantsPolish('mcp__claude_ai_Gmail__search_threads', 'Checking mail')).toBe(false)
  expect(wantsPolish('Bash', 'Check build status')).toBe(false)
  expect(wantsPolish('mcp__plugin_otto_otto__reply', '')).toBe(false)
})

test('cleanStatus keeps one short line and rejects rambling', () => {
  expect(cleanStatus('"remembering your iPhone order."\n')).toBe('Remembering your iPhone order')
  expect(cleanStatus('I am now going to go and check all of your many different things')).toBe('')
  expect(cleanStatus('')).toBe('')
})

test('polishStatus asks once per call shape and survives failures', async () => {
  let calls = 0
  const ok = (async () => { calls++; return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Setting a reminder for 3:45' }] })) }) as unknown as typeof fetch
  expect(await polishStatus('mcp__x__create_trigger', '{"a":1}', 'k', ok)).toBe('Setting a reminder for 3:45')
  expect(await polishStatus('mcp__x__create_trigger', '{"a":1}', 'k', ok)).toBe('Setting a reminder for 3:45')
  expect(calls).toBe(1)
  const boom = (async () => { throw new Error('offline') }) as unknown as typeof fetch
  expect(await polishStatus('mcp__x__other', '{}', 'k', boom)).toBe('')
  expect(await polishStatus('mcp__x__nokey', '{}', '', ok)).toBe('')
})

test('relabel swaps the latest matching step', () => {
  const frames: string[] = []
  const s = new LiveSteps(f => frames.push(f), () => 0, fn => fn(), 0)
  s.step('Remembering'); s.step('Reading a.md'); s.relabel('Remembering', 'Remembering your iPhone order')
  expect(JSON.parse(frames.at(-1)!).steps.map((x: { label: string }) => x.label)).toEqual(['Remembering your iPhone order', 'Reading a.md'])
})
