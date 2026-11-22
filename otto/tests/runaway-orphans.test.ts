import { test, expect } from 'bun:test'
import { parsePs, assessLoad, clearOrphans, loadStatus, DEFAULT_RUNAWAY, type LoadState } from '../runaway.ts'

const start = Math.floor(Date.parse('Mon Nov  9 09:00:00 2026') / 1000)
const now = (start + 3600) * 1000
const me = { uid: 501, protect: [] as number[] }
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const row = (pid: number, args = '--headless', ppid = 1, uid = 501, comm = chrome) =>
  `${pid} ${uid} 100000 0:00.00 Mon Nov  9 09:00:00 2026 ${comm} ${ppid} ${comm} ${args}`
const procs = () => parsePs([row(10), row(11), row(12)].join('\n'))
const fresh = (): LoadState => ({ procs: {}, offered: [] })
const assess = (out: string, at = now, cfg = DEFAULT_RUNAWAY, state = fresh()) =>
  assessLoad(parsePs(out), {}, state, cfg, at, me)

test('fake ps: only old, user-owned top-level automation orphans count', () => {
  const lines = [row(10), row(11), row(12), row(13, ''), row(14, '--headless', 20),
    row(15, '--headless --type=renderer'), row(16, '--headless', 1, 0), row(17, '--headless', 1, 501, '/usr/bin/echo')]
  const state = fresh()
  const alerts = assess(lines.join('\n'), now, DEFAULT_RUNAWAY, state)
  expect(alerts).toHaveLength(1)
  expect(alerts[0]!.kind).toBe('orphan')
  expect(alerts[0]!.text).toBe('3 orphaned automation browsers using 0.3 GB RAM.')
  expect(state.orphans!.keys).toEqual([`10:${start}`, `11:${start}`, `12:${start}`])
  expect(assess(lines.join('\n'), now - 1)).toEqual([])
  expect(assess(lines.join('\n'), now, { ...DEFAULT_RUNAWAY, ignore: ['chrome'] })).toEqual([])
  expect(loadStatus(state, now).detail).toContain('3 automation orphans')
  expect(loadStatus(state, now).verdict).toBe('degraded')
})

test('temporary automation profiles match without headless, normal profiles do not', () => {
  for (const dir of ['/tmp/playwright_chromiumdev_profile-abc', '/private/var/folders/xx/T/puppeteer_dev_chrome_profile-abc', '/tmp/agent-browser-abc']) {
    expect(assess([10, 11, 12].map(pid => row(pid, `--user-data-dir=${dir}`)).join('\n'))).toHaveLength(1)
  }
  expect(assess([10, 11, 12].map(pid => row(pid, '--user-data-dir="__HOME__/Library/Application Support/Google/Chrome"')).join('\n'))).toEqual([])
})

test('same set is never re-sent, changed set waits a day, order and restarts do not matter', () => {
  let state = fresh()
  expect(assessLoad(procs(), {}, state, DEFAULT_RUNAWAY, now, me)).toHaveLength(1)
  state = JSON.parse(JSON.stringify(state))
  expect(assessLoad(procs().reverse(), {}, state, DEFAULT_RUNAWAY, now + 86400000, me)).toEqual([])
  const changed = [...procs(), ...parsePs(row(13))]
  expect(assessLoad(changed, {}, state, DEFAULT_RUNAWAY, now + 1000, me)).toEqual([])
  expect(assessLoad(changed, {}, state, DEFAULT_RUNAWAY, now + 86400000, me)).toHaveLength(1)
})

test('clear tap kills only the offered snapshot; changed start time and foreign uid are spared', async () => {
  const state = fresh()
  const alert = assessLoad(procs(), {}, state, DEFAULT_RUNAWAY, now, me)[0]!
  const set = alert.buttons[0]!.data.split(' ')[2]!
  expect(Buffer.byteLength(alert.buttons[0]!.data)).toBeLessThanOrEqual(60)
  const killed: number[] = []
  const options = {
    ...me,
    read: async (pid: number) => ({ uid: pid === 12 ? 0 : 501, start: pid === 11 ? start + 1 : start, comm: chrome }),
    kill: (pid: number) => { killed.push(pid) }, alive: () => false, wait: async () => {},
  }
  assessLoad([...procs(), ...parsePs(row(13))], {}, state, DEFAULT_RUNAWAY, now + 86400000, me)
  await clearOrphans(set, state, options)
  expect(killed).toEqual([10])
  await clearOrphans('unknown', state, options)
  expect(killed).toEqual([10])
})
