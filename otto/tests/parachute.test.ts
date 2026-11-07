import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parachuteConfig, goalFrom, noteLive, parkWindow, lastFailingTest, snapshot, shouldPark, dueNote, formatNote, transcriptCwd,
  resumeWorkspace, loadParachute, saveParachute, RESUME_RE, REPARK_MS, type ParachuteState, type ParkedNote, type LiveSession,
} from '../parachute.ts'
import type { PlanUsage } from '../spend.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-parachute-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const ID = '11111111-2222-4333-8444-555555555555'
const NOW = Date.parse('2026-10-21T10:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const stateDir = join(tmp, 'state')
const projectsDir = join(tmp, 'projects')
const work = join(tmp, 'work', 'my repo "x"')
mkdirSync(work, { recursive: true })
mkdirSync(join(projectsDir, '-x'), { recursive: true })
const transcript = join(projectsDir, '-x', `${ID}.jsonl`)
writeFileSync(transcript, `{"type":"summary"}\n{"type":"user","cwd":${JSON.stringify(work)},"sessionId":"${ID}"}\n`)
const o = { stateDir, projectsDir }
const hook = (over: Record<string, unknown> = {}) => ({ session_id: ID, cwd: work, transcript_path: transcript, prompt: 'split quaderno.ts into parser and view', ...over })

test('config: defaults, junk, and an app that is a path', () => {
  expect(parachuteConfig()).toEqual({ percent: 95, app: 'Terminal' })
  expect(parachuteConfig({ percent: 'x', app: 7 })).toEqual({ percent: 95, app: 'Terminal' })
  expect(parachuteConfig({ percent: 90, app: 'Warp' })).toEqual({ percent: 90, app: 'Warp' })
  expect(parachuteConfig({ app: '../x' }).app).toBe('Terminal')
})

test('goalFrom: injected text, short replies and secrets', () => {
  expect(goalFrom('<channel source="x">hello there you all</channel>')).toBeUndefined()
  expect(goalFrom('yes do it')).toBeUndefined()
  const twenty = Array.from({ length: 20 }, (_, i) => `w${i + 1}`).join(' ')
  expect(goalFrom(twenty)).toBe(Array.from({ length: 14 }, (_, i) => `w${i + 1}`).join(' ') + '…')
  expect(goalFrom(`use this token ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)} for the push now`)).not.toContain('ghp_')
})

test('noteLive stores a real session and refuses the rest', () => {
  const st: ParachuteState = {}
  expect(noteLive(st, hook(), 4242, NOW, o)).toBe(true)
  expect(st.live).toEqual({ sessionId: ID, cwd: work, transcript, pid: 4242, goal: 'split quaderno.ts into parser and view', at: NOW })
  const none: ParachuteState = {}
  expect(noteLive(none, hook({ cwd: join(stateDir, 'selftest', 'x') }), 1, NOW, o)).toBe(false)
  expect(noteLive(none, hook({ transcript_path: '/elsewhere/t.jsonl' }), 1, NOW, o)).toBe(false)
  expect(noteLive(none, hook({ session_id: 'nope' }), 1, NOW, o)).toBe(false)
  expect(noteLive(none, hook({ cwd: 'relative' }), 1, NOW, o)).toBe(false)
  expect(noteLive(none, null, 1, NOW, o)).toBe(false)
  expect(none).toEqual({})
  // "continue" keeps the goal in the same session, drops it in another
  noteLive(st, hook({ prompt: 'continue' }), 4242, NOW + MIN, o)
  expect(st.live!.goal).toBe('split quaderno.ts into parser and view')
  noteLive(st, hook({ prompt: 'continue', session_id: '99999999-2222-4333-8444-555555555555' }), 4242, NOW + 2 * MIN, o)
  expect(st.live!.goal).toBeUndefined()
})

const usage = (w: Partial<PlanUsage>, at = NOW): PlanUsage => ({ at, ...w })
test('parkWindow picks the blocking window at or over the line', () => {
  const u = usage({ five_hour: { used_percentage: 96, resets_at: (NOW + HOUR) / 1000 }, seven_day: { used_percentage: 97, resets_at: (NOW + 72 * HOUR) / 1000 } })
  expect(parkWindow(u, 95, NOW)).toBe(NOW + 72 * HOUR)
  expect(parkWindow(usage({ five_hour: { used_percentage: 94, resets_at: (NOW + HOUR) / 1000 } }), 95, NOW)).toBeUndefined()
  expect(parkWindow(usage({ five_hour: { used_percentage: 99, resets_at: (NOW + HOUR) / 1000 } }, NOW - 31 * MIN), 95, NOW)).toBeUndefined()
  expect(parkWindow(u, 101, NOW)).toBeUndefined()
  expect(parkWindow(null, 95, NOW)).toBeUndefined()
})

const esc = (s: string) => JSON.stringify(s).slice(1, -1)
test('lastFailingTest reads the last bun summary in an escaped transcript tail', () => {
  const red = esc('bun test v1.3\n(fail) quaderno > parseItems [1.20ms]\n\n 3 pass\n 1 fail\nRan 4 tests\n')
  const green = esc('bun test v1.3\n\n 4 pass\n 0 fail\nRan 4 tests\n')
  const line = (s: string) => `{"type":"user","message":{"content":[{"type":"tool_result","content":"${s}"}]}}\n`
  expect(lastFailingTest(line(red))).toBe('quaderno > parseItems')
  expect(lastFailingTest(line(red) + line(green))).toBeUndefined()
  expect(lastFailingTest(line('nothing here'))).toBeUndefined()
})

test('snapshot gathers the repo, branch, dirt, red test, goal and pid', async () => {
  const live: LiveSession = { sessionId: ID, cwd: work, transcript, pid: 7, goal: 'g g g g', at: NOW }
  const n = await snapshot(live, NOW + HOUR, NOW, {
    gitTop: async () => join(tmp, 'work', 'otto-app'),
    repoState: async () => ({ name: 'otto-app', branch: 'feat/x', dirty: 3 }),
    readTail: () => esc('(fail) quaderno > parseItems [1ms]\n 1 fail\n'),
  })
  expect(n).toEqual({ sessionId: ID, cwd: work, repo: 'otto-app', branch: 'feat/x', dirty: 3, goal: 'g g g g', failing: 'quaderno > parseItems', pid: 7, resetAt: NOW + HOUR, parkedAt: NOW })
  const bare = await snapshot({ ...live, goal: undefined, pid: undefined }, 1, 2, { gitTop: async () => undefined, repoState: async () => undefined, readTail: () => '' })
  expect(bare).toEqual({ sessionId: ID, cwd: work, repo: 'my repo "x"', dirty: 0, resetAt: 1, parkedAt: 2 })
})

const note = (over: Partial<ParkedNote> = {}): ParkedNote => ({ sessionId: ID, cwd: work, repo: 'otto-app', dirty: 0, resetAt: NOW + HOUR, parkedAt: NOW, ...over })
const live = (at: number): LiveSession => ({ sessionId: ID, cwd: work, transcript, at })

test('shouldPark', () => {
  const reset = NOW + HOUR
  expect(shouldPark({}, reset, NOW)).toBe(false)
  expect(shouldPark({ live: live(NOW - 3 * HOUR) }, reset, NOW)).toBe(false)
  expect(shouldPark({ live: live(NOW - 10 * MIN) }, reset, NOW)).toBe(true)
  const parked = { live: live(NOW - MIN), note: note({ resetAt: reset, parkedAt: NOW }) }
  expect(shouldPark(parked, reset, NOW + MIN)).toBe(false)
  expect(shouldPark(parked, reset, NOW + REPARK_MS + 1)).toBe(true)
  expect(shouldPark({ live: live(NOW), note: note({ resetAt: reset, parkedAt: NOW }) }, reset + 48 * HOUR, NOW + MIN)).toBe(true)
  expect(shouldPark({ live: live(NOW), sent: note({ resetAt: reset + MIN }) }, reset, NOW)).toBe(false)
})

test('dueNote', () => {
  const n = note()
  expect(dueNote({}, NOW)).toBe('wait')
  expect(dueNote({ note: n }, n.resetAt - 1)).toBe('wait')
  expect(dueNote({ note: n }, n.resetAt)).toBe('send')
  expect(dueNote({ note: n }, n.resetAt + 13 * HOUR)).toBe('drop')
  expect(dueNote({ note: n, live: live(n.resetAt + MIN) }, n.resetAt + 5 * MIN)).toBe('drop')
  expect(dueNote({ note: n, live: live(n.resetAt - MIN) }, n.resetAt + 5 * MIN)).toBe('send')
})

test('formatNote', () => {
  const m = formatNote(note({ branch: 'feat/x', dirty: 3, goal: 'split quaderno.ts into parser and view', failing: 'quaderno > parseItems' }))
  expect(m.text).toBe('limit\'s reset. you were on "split quaderno.ts into parser and view" — otto-app (feat/x), 3 files dirty, quaderno > parseItems red.')
  expect(m.buttons).toEqual([{ label: 'resume', data: `resume session ${ID}` }])
  expect(RESUME_RE.exec(m.buttons[0]!.data)![1]).toBe(ID)
  expect(Buffer.byteLength(m.buttons[0]!.data)).toBeLessThanOrEqual(60)
  expect(formatNote(note({ branch: 'main', dirty: 1 })).text).toBe("limit's reset. you were in otto-app, 1 file dirty.")
  expect(formatNote(note({ failing: 'x'.repeat(80) })).text).toContain('x'.repeat(49) + '… red')
})

test('transcriptCwd finds the recorded cwd and nothing that is missing', () => {
  expect(transcriptCwd(projectsDir, ID)).toBe(work)
  expect(transcriptCwd(projectsDir, '99999999-2222-4333-8444-555555555555')).toBeUndefined()
  const gone = '22222222-2222-4333-8444-555555555555'
  writeFileSync(join(projectsDir, '-x', `${gone}.jsonl`), `{"cwd":"${join(tmp, 'deleted')}"}\n`)
  expect(transcriptCwd(projectsDir, gone)).toBeUndefined()
  expect(transcriptCwd(projectsDir, '../etc')).toBeUndefined()
})

function fakes(isClaude = false) {
  const execs: string[][] = []
  const copied: string[] = []
  return {
    execs, copied,
    exec: (async (cmd: string[]) => { execs.push(cmd); return '' }) as never,
    copy: async (t: string) => { copied.push(t) },
    isClaude: async () => isClaude,
    platform: 'darwin',
  }
}

test('resumeWorkspace: a live session is brought forward, Terminal runs claude --resume, others get the clipboard', async () => {
  let f = fakes(true)
  expect(await resumeWorkspace(ID, { projectsDir, app: 'Terminal', sent: note({ pid: 99 }), ...f })).toBe("it's still open in Terminal — say continue there.")
  expect(f.execs).toEqual([['open', '-a', 'Terminal']])

  f = fakes()
  expect(await resumeWorkspace(ID, { projectsDir, app: 'Terminal', sent: note({ pid: 99 }), ...f })).toContain('resuming the session')
  expect(f.execs).toHaveLength(1)
  expect(f.execs[0]![0]).toBe('osascript')
  expect(f.execs[0]!.slice(-2)).toEqual([work, ID])

  f = fakes()
  expect(await resumeWorkspace(ID, { projectsDir, app: 'Warp', ...f })).toContain('clipboard')
  expect(f.execs).toEqual([['open', '-a', 'Warp', work]])
  expect(f.copied).toEqual([`claude --resume ${ID}`])

  f = fakes()
  expect(await resumeWorkspace('x; rm -rf /', { projectsDir, app: 'Terminal', ...f })).toBe('not a session id')
  expect(await resumeWorkspace('99999999-2222-4333-8444-555555555555', { projectsDir, app: 'Terminal', ...f })).toContain("can't find")
  expect(f.execs).toEqual([])
})

test('resumeWorkspace off macOS: hands back the command, runs nothing', async () => {
  const f = fakes()
  expect(await resumeWorkspace(ID, { projectsDir, app: 'Terminal', ...f, platform: 'linux' })).toBe(`to pick it up: cd ${work} && claude --resume ${ID}`)
  expect(f.execs).toEqual([])
})

test('state round-trips', () => {
  const f = join(tmp, 'parachute.json')
  expect(loadParachute(f)).toEqual({})
  const st: ParachuteState = { live: live(NOW), note: note() }
  saveParachute(f, st)
  expect(loadParachute(f)).toEqual(st)
})
