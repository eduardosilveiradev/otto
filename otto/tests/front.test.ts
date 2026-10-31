import { expect, test } from 'bun:test'
import { frontActive, frontShouldAnswer, frontReply, frontRequest, askFront } from '../front.ts'

const now = Date.parse('2026-11-01T12:00:00Z')

test('off unless enabled, and only until its end date', () => {
  expect(frontActive(undefined, now)).toBe(false)
  expect(frontActive({ enabled: true }, now)).toBe(true)
  expect(frontActive({ enabled: true, until: '2026-11-02T12:00:00Z' }, now)).toBe(true)
  expect(frontActive({ enabled: true, until: '2026-11-01T11:00:00Z' }, now)).toBe(false)
})

test('answers only when a turn has been running a while', () => {
  const cfg = { enabled: true, busySeconds: 20 }
  expect(frontShouldAnswer(cfg, false, now - 60_000, now)).toBe(false)
  expect(frontShouldAnswer(cfg, true, now - 5_000, now)).toBe(false)
  expect(frontShouldAnswer(cfg, true, now - 30_000, now)).toBe(true)
})

test('PASS, empty and overlong replies send nothing', () => {
  expect(frontReply('PASS')).toBeNull()
  expect(frontReply('pass.')).toBeNull()
  expect(frontReply('  ')).toBeNull()
  expect(frontReply('x'.repeat(300))).toBeNull()
  expect(frontReply('"on it after the build"')).toBe('on it after the build')
})

test('the request carries the task, the thread and the new message', () => {
  const body = JSON.stringify(frontRequest([{ dir: 'in', text: 'hey', ts: '' }, { dir: 'out', text: 'yo', ts: '' }], 'you there?', 'Building the app'))
  expect(body).toContain('claude-sonnet-5-5')
  expect(body).toContain('Building the app')
  expect(body).toContain('them: hey')
  expect(body).toContain('you there?')
})

test('no key or a failed call is a silent pass', async () => {
  expect(await askFront(undefined, [], 'hi', '')).toBeNull()
  const failing = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
  expect(await askFront('k', [], 'hi', '', failing)).toBeNull()
  const ok = (async () => Response.json({ content: [{ type: 'text', text: 'mid-build, give me a sec' }] })) as unknown as typeof fetch
  expect(await askFront('k', [], 'hi', '', ok)).toBe('mid-build, give me a sec')
})
