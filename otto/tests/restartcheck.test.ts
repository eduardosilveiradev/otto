import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildProcesses, readRestartThreads, restartDecision } from '../restartcheck.ts'

test('all clear', () => expect(restartDecision([], [], [])).toBe('yes'))
test('running job', () => expect(restartDecision([{ title: 'Compile app', state: 'running' }], [], [])).toBe('not yet — job: Compile app'))
test('live T3 run', () => {
  for (const status of ['preparing', 'queued', 'starting', 'running', 'waiting']) {
    expect(restartDecision([], [{ id: 't1', title: 'Fix app', status }], [])).toBe('not yet — T3: Fix app')
  }
})
test('build process, only user-owned and actual build commands', () => {
  const builds = buildProcesses('501 42 /usr/bin/xcodebuild -scheme App\n502 43 swift-build\n501 44 dotnet publish\n501 45 dotnet serve\n501 46 swift build', 501)
  expect(builds).toEqual(['build: xcodebuild (PID 42)', 'build: dotnet (PID 44)', 'build: swift (PID 46)'])
  expect(restartDecision([], [], builds)).toStartWith('not yet — build: xcodebuild')
})
test('unreadable T3 blocks a yes', () => {
  expect(readRestartThreads(join(tmpdir(), 'missing-restart-db', 'state.sqlite'))).toBeNull()
  expect(restartDecision([], null, [])).toBe('not yet — T3 unknown')
})
test('latest ordinal wins and deleted threads are excluded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-check-'))
  const file = join(dir, 'state.sqlite')
  try {
    const db = new Database(file)
    db.run('CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT, deleted_at TEXT)')
    db.run('CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, ordinal INTEGER, status TEXT)')
    db.run("INSERT INTO orchestration_v2_projection_threads VALUES ('t1', 'Finished', NULL), ('t2', 'Deleted', 'now'), ('t3', 'New', NULL)")
    db.run("INSERT INTO orchestration_v2_projection_runs VALUES ('t1', 2, 'completed'), ('t1', 1, 'running'), ('t2', 1, 'running')")
    db.close()
    expect(readRestartThreads(file)).toEqual([{ id: 't1', title: 'Finished', status: 'completed' }, { id: 't3', title: 'New', status: null }])
    expect(restartDecision([], readRestartThreads(file), [])).toBe('yes')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
