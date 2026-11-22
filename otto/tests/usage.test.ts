import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectUsage, formatUsage } from '../usage.ts'
const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const now = new Date(2026, 7, 12, 12).getTime()
const stamp = (month: number, day: number, year = 2026) => new Date(year, month, day, 10).toISOString()
const line = (id: string, timestamp: string, tokens: number) => JSON.stringify({ timestamp, requestId: 'request', message: { id, usage: { input_tokens: tokens, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } }) + '\n'
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'otto-usage-')); homes.push(home)
  const dir = join(home, '.claude', 'projects', 'fixture'); mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl'), cacheFile = join(home, 'cache.json')
  writeFileSync(file, '')
  return { home, file, cacheFile, now }
}
test('local day, month and year boundaries; cache tokens; future and malformed rows', () => {
  const o = setup()
  writeFileSync(o.file, line('today', stamp(7, 12), 10) + line('month', stamp(7, 1), 20) + line('year', stamp(0, 1), 30) + line('old', stamp(11, 31, 2025), 1000) + line('future', stamp(7, 13), 1000) + 'invalid\n')
  expect(collectUsage(o)).toEqual({ claude: { today: 19, month: 48, year: 87 } })
  expect(collectUsage(o).claude.year).toBe(87)
  const cache = JSON.parse(readFileSync(o.cacheFile, 'utf8'))
  expect(cache.files[realpathSync(o.file)].offset).toBe(Buffer.byteLength(readFileSync(o.file, 'utf8')))
})
test('incremental append, partial UTF-8 line, duplicate streaming messages and copied logs', () => {
  const o = setup(), first = line('one', stamp(7, 12), 10)
  writeFileSync(o.file, first)
  expect(collectUsage(o).claude.today).toBe(19)
  const next = line('two', stamp(7, 12), 20)
  appendFileSync(o.file, next.slice(0, 25))
  expect(collectUsage(o).claude.today).toBe(19)
  appendFileSync(o.file, next.slice(25) + line('one', stamp(7, 12), 15))
  expect(collectUsage(o).claude.today).toBe(53)
  writeFileSync(join(o.home, '.claude', 'projects', 'fixture', 'copy.jsonl'), first)
  expect(collectUsage(o).claude.today).toBe(53)
})
test('truncation, deleted logs and corrupt cache recover', () => {
  const o = setup(); writeFileSync(o.file, line('one', stamp(7, 12), 1000)); collectUsage(o)
  writeFileSync(o.file, line('two', stamp(7, 12), 1))
  expect(collectUsage(o).claude.today).toBe(10)
  writeFileSync(o.cacheFile, 'invalid')
  expect(collectUsage(o).claude.today).toBe(10)
  rmSync(o.file)
  expect(collectUsage(o).claude.today).toBe(0)
})
test('Codex cumulative snapshots do not add cached or reasoning subsets twice', () => {
  const o = setup(), dir = join(o.home, '.codex', 'sessions', '2026'); mkdirSync(dir, { recursive: true })
  const file = join(dir, 'rollout.jsonl')
  const event = (n: number) => JSON.stringify({ timestamp: stamp(7, 12), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: n - 10, output_tokens: 10, cached_input_tokens: 20, reasoning_output_tokens: 5, total_tokens: n } } } }) + '\n'
  writeFileSync(file, event(100) + event(100) + event(150))
  expect(collectUsage(o).gpt).toEqual({ today: 150, month: 150, year: 150 })
  appendFileSync(file, event(200))
  expect(collectUsage(o).gpt?.today).toBe(200)
})
test('additional Claude config installs and single-line formatting', () => {
  const o = setup(), extra = join(o.home, 'other'); mkdirSync(join(extra, 'projects'), { recursive: true })
  writeFileSync(join(extra, 'projects', 'extra.jsonl'), line('extra', stamp(7, 12), 100))
  const t = collectUsage({ ...o, claudeDirs: [join(o.home, '.claude'), extra, extra] })
  expect(t.claude.today).toBe(109)
  const text = formatUsage(t, { at: now, five_hour: { used_percentage: 78, resets_at: now / 1000 + 3600 } }, now)
  expect(text).toContain('plan window 78%, resets')
  expect(text).toContain('109 tokens today, 109 this month, 109 this year')
  expect(text).not.toContain('GPT')
  expect(text).not.toContain('\n')
  expect(formatUsage({ ...t, gpt: { today: 1, month: 2, year: 3 } }, null, now)).toContain('GPT: 1 tokens today, 2 this month, 3 this year')
})
test('a truncated file regrown past its old length is rescanned', () => {
  const o = setup()
  writeFileSync(o.file, line('one', stamp(7, 12), 1)); collectUsage(o)
  writeFileSync(o.file, line('two', stamp(7, 12), 100) + line('three', stamp(7, 12), 200))
  expect(collectUsage(o).claude.today).toBe(318)
})
test('Codex deltas belong to their own day and month', () => {
  const o = setup(), dir = join(o.home, '.codex', 'sessions'); mkdirSync(dir, { recursive: true })
  const event = (timestamp: string, n: number) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: n } } } }) + '\n'
  writeFileSync(join(dir, 'session.jsonl'), event(stamp(6, 31), 100) + event(stamp(7, 11), 150) + event(stamp(7, 12), 180))
  expect(collectUsage(o).gpt).toEqual({ today: 30, month: 80, year: 180 })
})
test('period boundaries follow the machine timezone, not UTC', () => {
  const o = setup()
  writeFileSync(o.file, line('before-midnight', '2026-08-12T01:00:00Z', 10) + line('after-midnight', '2026-08-12T06:00:00Z', 20))
  const script = `import { collectUsage } from './otto/usage.ts'; console.log(JSON.stringify(collectUsage(${JSON.stringify({ ...o, now: Date.parse('2026-08-12T16:00:00Z') })})))`
  const child = Bun.spawnSync([process.execPath, '-e', script], { cwd: join(import.meta.dir, '..', '..'), env: { ...process.env, TZ: 'America/New_York' } })
  expect(child.exitCode).toBe(0)
  expect(JSON.parse(child.stdout.toString()).claude).toEqual({ today: 29, month: 48, year: 48 })
})
