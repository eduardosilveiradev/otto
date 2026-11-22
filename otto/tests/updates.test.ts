import { test, expect } from 'bun:test'
import {
  updatesConfig, detect, noteLine, checkUpdates, checkDue, updatesTap, applyTick, loadCalm, updatesStatus, listKey,
  type Exec, type Fetch, type UpdatesState,
} from '../updates.ts'
import type { LoadState } from '../runaway.ts'

const NOW = Date.parse('2026-11-10T10:00:00Z')

// A stubbed Mac: codex behind, claude current, bun unreadable, gh and one cask outdated in brew.
const exec: Exec = async cmd => ({
  'codex --version': 'codex-cli 0.50.0',
  'claude --version': '2.1.0 (Claude Code)',
  'brew update --quiet': '',
  'brew outdated --json=v2': JSON.stringify({
    formulae: [{ name: 'gh', installed_versions: ['2.90.0'], current_version: '2.96.0' }],
    casks: [{ name: 'some-app', installed_versions: '1.0', current_version: '1.1' }],
  }),
} as Record<string, string>)[cmd.join(' ')]

const fetchStub: Fetch = async url => ({
  'https://registry.npmjs.org/@openai/codex/latest': '{"version":"0.52.0"}',
  'https://registry.npmjs.org/@anthropic-ai/claude-code/latest': '{"version":"2.1.0"}',
  'https://api.github.com/repos/openai/codex/releases/tags/rust-v0.52.0': JSON.stringify({ body: '## Highlights\n- Tool calls get faster ([#123](https://github.com/x/y/pull/123))\n- Other' }),
} as Record<string, string>)[url]

test('config: absent is off, {} is every tool, tools narrows and drops unknown names', () => {
  expect(updatesConfig(undefined)).toBeUndefined()
  expect(updatesConfig({})!.tools).toEqual(['codex', 'claude', 'bun', 'gh', 'brew'])
  expect(updatesConfig({ tools: ['claude', 'rm'] })!.tools).toEqual(['claude'])
})

test('detect: brew items first, standalone tools only when behind, notes from the changelog or "no notes"', async () => {
  const got = await detect(['codex', 'claude', 'bun', 'gh', 'brew'], { exec, fetch: fetchStub })
  expect(got.map(u => [u.name, u.from, u.to, u.note])).toEqual([
    ['gh', '2.90.0', '2.96.0', 'no notes'],
    ['some-app', '1.0', '1.1', 'no notes'],
    ['codex', '0.50.0', '0.52.0', 'Tool calls get faster.'],
  ])
  expect(got[1]!.apply).toEqual(['brew', 'upgrade', '--cask', 'some-app'])
  expect(got[2]!.apply).toEqual(['npm', 'install', '-g', '@openai/codex@latest'])
})

test('detect throws when nothing at all could be read', async () => {
  await expect(detect(['codex'], { exec: async () => undefined, fetch: async () => undefined })).rejects.toThrow()
})

test('noteLine never invents', () => {
  expect(noteLine(undefined)).toBe('no notes')
  expect(noteLine('To install, run bun upgrade')).toBe('no notes')
  expect(noteLine('* **Faster** startup')).toBe('Faster startup.')
})

test('the card: count, one line each, apply/skip buttons; the same list is not offered twice', async () => {
  const s: UpdatesState = {}
  const offer = (await checkUpdates(s, ['codex', 'brew'], { exec, fetch: fetchStub, now: NOW }))!
  expect(offer.text).toBe('3 updates waiting.\ngh 2.90.0 → 2.96.0: no notes\nsome-app 1.0 → 1.1: no notes\ncodex 0.50.0 → 0.52.0: Tool calls get faster.')
  expect(offer.card.title).toBe('3 updates waiting.')
  const key = s.offer!.key
  expect(offer.buttons).toEqual([{ label: 'apply tonight', data: `apply updates ${key}` }, { label: 'skip', data: `skip updates ${key}` }])
  expect(await checkUpdates(s, ['codex', 'brew'], { exec, fetch: fetchStub, now: NOW })).toBeNull()
  expect(updatesTap(s, `skip updates ${key}`)).toBe('Skipped.')
  expect(await checkUpdates(s, ['codex', 'brew'], { exec, fetch: fetchStub, now: NOW })).toBeNull()
})

test('weekly cadence from 10:00', () => {
  expect(checkDue({}, new Date(2026, 10, 10, 9))).toBe(false)
  expect(checkDue({}, new Date(2026, 10, 10, 10))).toBe(true)
  const last = new Date(2026, 10, 10, 10).toISOString()
  expect(checkDue({ lastCheckAt: last }, new Date(2026, 10, 14, 10))).toBe(false)
  expect(checkDue({ lastCheckAt: last }, new Date(2026, 10, 17, 10))).toBe(true)
})

const items = [
  { name: 'codex', from: '0.50.0', to: '0.52.0', note: 'x.', apply: ['npm', 'install', '-g', '@openai/codex@latest'] },
  { name: 'gh', from: '2.90.0', to: '2.96.0', note: 'no notes', apply: ['brew', 'upgrade', 'gh'] },
]
const tapped = (): UpdatesState => {
  const s: UpdatesState = { offer: { key: listKey(items), items } }
  expect(updatesTap(s, `apply updates ${listKey(items)}`)).toBe('Tonight, once nothing is running.')
  return s
}

test('apply is deferred while a job runs, outside quiet hours, or when the load is not calm', async () => {
  const ran: string[] = []
  const rec: Exec = async cmd => { ran.push(cmd.join(' ')); return '' }
  const s = tapped()
  for (const o of [{ quiet: true, busy: true, calm: true }, { quiet: false, busy: false, calm: true }, { quiet: true, busy: false, calm: false }]) {
    expect(await applyTick(s, { ...o, exec: rec, now: NOW })).toBeNull()
  }
  expect(ran).toEqual([])
  expect(s.pending).toBeDefined()
})

test('apply runs when idle in quiet hours, and says nothing when it all went in', async () => {
  const ran: string[] = []
  const s = tapped()
  expect(await applyTick(s, { quiet: true, busy: false, calm: true, exec: async cmd => { ran.push(cmd.join(' ')); return '' }, now: NOW })).toBeNull()
  expect(ran).toEqual(['npm install -g @openai/codex@latest', 'brew upgrade gh'])
  expect(s.pending).toBeUndefined()
  expect(s.lastApply).toEqual({ at: new Date(NOW).toISOString(), ok: ['codex', 'gh'], failed: [] })
})

test('a failure is reported once', async () => {
  const s = tapped()
  const failing: Exec = async cmd => (cmd[0] === 'brew' ? undefined : '')
  expect(await applyTick(s, { quiet: true, busy: false, calm: true, exec: failing, now: NOW })).toBe("1 update didn't apply last night: gh. 1 went in.")
  expect(await applyTick(s, { quiet: true, busy: false, calm: true, exec: failing, now: NOW })).toBeNull()
  expect(updatesStatus(true, { ...s, lastCheckAt: new Date(NOW).toISOString() }, NOW).verdict).toBe("degraded")
})

test('a tap on a stale list does nothing', () => {
  const s: UpdatesState = {}
  expect(updatesTap(s, 'apply updates deadbeef')).toMatch(/out of date/)
  expect(s.pending).toBeUndefined()
  expect(updatesTap(s, 'something else')).toBeNull()
})

test('calm: fresh sample with nothing over a line', () => {
  const base: LoadState = { at: NOW - 60_000, procs: {}, offered: [], sys: { pressure: 2 } }
  expect(loadCalm(base, NOW)).toBe(true)
  expect(loadCalm({ ...base, at: NOW - 3_600_000 }, NOW)).toBe(false)
  expect(loadCalm({ ...base, swapHotSince: NOW }, NOW)).toBe(false)
  expect(loadCalm({ ...base, procs: { '1:1': { name: 'x', cpuSec: 1, rssKb: 1, at: NOW, hotSince: NOW } } }, NOW)).toBe(false)
})

test('status row: off when unconfigured', () => {
  expect(updatesStatus(false, null, NOW).verdict).toBe('off')
  expect(updatesStatus(true, null, NOW).verdict).toBe('unknown')
})
