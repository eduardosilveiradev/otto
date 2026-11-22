import { Database } from 'bun:sqlite'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { CODE_JOBS_FILE, wireJob, type CodeJob } from './codejobs.ts'

const LIVE = new Set(['preparing', 'queued', 'starting', 'running', 'waiting'])
type Thread = { id: string; title: string; status: string | null }
type Job = { title: string; state: string }

export function restartDecision(jobs: Job[] | null, threads: Thread[] | null, builds: string[] | null): string {
  const blockers = [
    ...(jobs === null ? ['coding jobs unknown'] : jobs.filter(j => j.state === 'running').map(j => `job: ${j.title}`)),
    ...(threads === null ? ['T3 unknown'] : threads.filter(t => LIVE.has(t.status ?? '')).map(t => `T3: ${t.title}`)),
    ...(builds === null ? ['build processes unknown'] : builds),
  ]
  return blockers.length ? `not yet — ${blockers.map(s => s.replace(/[\r\n]+/g, ' ')).join('; ')}` : 'yes'
}

export function readRestartThreads(file = join(homedir(), '.t3', 'userdata', 'statev2.sqlite')): Thread[] | null {
  let db: Database | undefined
  try {
    db = new Database(file, { readonly: true })
    return db.query(`SELECT t.thread_id AS id, t.title, r.status
      FROM orchestration_v2_projection_threads t
      LEFT JOIN orchestration_v2_projection_runs r ON r.thread_id = t.thread_id
        AND r.ordinal = (SELECT MAX(ordinal) FROM orchestration_v2_projection_runs WHERE thread_id = t.thread_id)
      WHERE t.deleted_at IS NULL`).all() as Thread[]
  } catch { return null } finally { db?.close() }
}

export function buildProcesses(output: string, uid: number): string[] {
  return output.split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)(.*)$/)
    if (!m || Number(m[1]) !== uid) return []
    const name = basename(m[3]!)
    const heavy = /^(xcodebuild|swift-build|clang|clang\+\+|gcc|g\+\+|cc1|ld|ninja|make|cmake|msbuild)$/.test(name)
      || (name === 'dotnet' && /^\s+(publish|build|msbuild)\b/.test(m[4]!))
      || (name === 'swift' && /^\s+build\b/.test(m[4]!))
      || (name === 'cargo' && /^\s+(build|test|rustc)\b/.test(m[4]!))
    return heavy ? [`build: ${name} (PID ${m[2]})`] : []
  })
}

export function restartCheck(): string {
  const threads = readRestartThreads()
  let jobs: Job[] | null = null
  try {
    // Do not use loadCodeJobs: its corrupt-file recovery renames the store.
    const stored = JSON.parse(readFileSync(CODE_JOBS_FILE, 'utf8')) as CodeJob[]
    jobs = stored.map(j => {
      const t = threads?.find(t => t.id === j.threadId)
      return wireJob(j, t ? { id: t.id, status: LIVE.has(t.status ?? '') ? 'running' : 'idle' } : undefined, undefined)
    })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') jobs = []
  }
  let builds: string[] | null = null
  try {
    builds = buildProcesses(execFileSync('ps', ['-axo', 'uid=,pid=,command='], { encoding: 'utf8', timeout: 5000 }), process.getuid!())
  } catch {}
  return restartDecision(jobs, threads, builds)
}
