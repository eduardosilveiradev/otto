import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { route, ownerMessage, type RouterConfig } from '../route.ts'

const dirs: string[] = []
function config(router: RouterConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'otto-router-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ router }))
  return dir
}
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))

test('heuristics use defaults and audit decisions without message text', async () => {
  const dir = config()
  expect(await route('thanks', 'message', dir)).toEqual({ tier: 'trivial', model: 'claude-opus-5-5', effort: 'medium' })
  expect(await route('debug this code', 'job', dir)).toEqual({ tier: 'hard', model: 'claude-fable-5-2', effort: 'xhigh' })
  expect((await route('Could you describe the weather patterns across the seasons in a coastal region compared with inland regions?', 'message', dir)).tier).toBe('normal')
  const log = readFileSync(join(dir, 'router-decisions.json'), 'utf8')
  expect(JSON.parse(log)[0]).toMatchObject({ tier: 'trivial', source: 'heuristic', kind: 'message' })
  expect(log).not.toContain('thanks')
})

test('classifier output selects tier and configured table, not arbitrary models', async () => {
  const dir = config({ classifier: 'cat >/dev/null; printf normal', normal: { model: 'opus', effort: 'low' } })
  expect(await route('thanks', 'message', dir)).toEqual({ tier: 'normal', model: 'claude-opus-5-5', effort: 'low' })
  expect(JSON.parse(readFileSync(join(dir, 'router-decisions.json'), 'utf8'))[0]).toMatchObject({ source: 'model', ms: expect.any(Number) })
})

test('classifier error and malformed output fall back', async () => {
  for (const classifier of ['exit 1', 'printf nonsense']) {
    const dir = config({ classifier })
    expect((await route('design the UI', 'message', dir)).tier).toBe('hard')
    expect(JSON.parse(readFileSync(join(dir, 'router-decisions.json'), 'utf8'))[0].source).toBe('heuristic')
  }
})

test('cold classifier times out inside message budget, then falls back without restarting it', async () => {
  const dir = config({ classifier: 'cat >/dev/null; sleep 10; printf trivial' })
  const start = performance.now()
  expect((await route('debug this code', 'message', dir)).tier).toBe('hard')
  expect(performance.now() - start).toBeLessThan(1500)
  const warm = performance.now()
  await route('thanks', 'message', dir)
  expect(performance.now() - warm).toBeLessThan(100)
})

test('audit stays bounded and automatic routes never choose max', async () => {
  const dir = config()
  writeFileSync(join(dir, 'router-decisions.json'), JSON.stringify(Array(250).fill({ tier: 'normal' })))
  await route('hello', 'message', dir)
  expect(JSON.parse(readFileSync(join(dir, 'router-decisions.json'), 'utf8'))).toHaveLength(200)
  const bad = config({ hard: { model: 'fable', effort: 'max' as any } })
  await expect(route('debug code', 'job', bad)).rejects.toThrow('never max')
  writeFileSync(join(bad, 'access.json'), JSON.stringify({ router: { messages: true, hard: { model: 'fable', effort: 'max' } } }))
  expect(await ownerMessage('debug code', 'app', true, bad)).toBe('debug code')
})

test('ultrathink only on enabled hard owner messages from the three owner surfaces', async () => {
  const off = config(), on = config({ messages: true })
  for (const surface of ['app', 'telegram', 'whatsapp']) {
    expect(await ownerMessage('debug code', surface, true, off)).toBe('debug code')
    expect(await ownerMessage('debug code', surface, true, on)).toBe('debug code\nultrathink')
    expect(await ownerMessage('thanks', surface, true, on)).toBe('thanks')
    expect(await ownerMessage('debug code', surface, false, on)).toBe('debug code')
  }
  for (const surface of ['webhook', 'email', 'email-scan', 'trigger', 'job', 'button']) {
    expect(await ownerMessage('debug code', surface, true, on)).toBe('debug code')
  }
})
