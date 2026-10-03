#!/usr/bin/env bun
/**
 * delegate — work that outlives the turn it was asked for.
 *
 * Otto is one conversation on one thread. Anything slow the user asks for is paid for
 * in silence: "read these forty threads and tell me what I owe" takes minutes,
 * and for those minutes the assistant the user is talking to simply stops answering.
 * The only escapes available were to do it badly and fast, or to not do it.
 *
 * So push it off the thread. A job is a detached headless `claude -p` with its
 * own scratch dir, its own tool allowlist, a wall clock and a token budget. The
 * tool call returns an id immediately; the result comes back through the
 * loopback webhook as a normal event, minutes or hours later, and is handled
 * like any other incoming thing.
 *
 * Four things this file exists to get right, none of which are the spawn:
 *
 *   Budget. A headless session with no ceiling can spend all night. Tokens are
 *   counted off the stream as they arrive and the job is killed the moment it
 *   crosses, not after the fact when the money is gone.
 *
 *   Partial returns. A job killed at the wall clock is not a failure with
 *   nothing in it — it is 9 minutes of work plus an interruption. Whatever text
 *   it had produced is kept and marked partial. Throwing that away and saying
 *   "timed out" is the behaviour that makes a runner useless.
 *
 *   Overnight. Some work is worth doing but not worth spending on while the user is
 *   awake and might change the user’s mind. `overnight` parks the job until quiet
 *   hours and starts it then.
 *
 *   Lifecycle on disk. queued/running/parked/done/failed/killed in jobs.json,
 *   so a restart mid-job leaves a record that says what happened rather than a
 *   process nobody remembers starting.
 *
 * The state machine and the scheduler are pure and tested. The spawn is fifteen
 * lines at the bottom.
 *
 * CLI: `bun otto/jobs.ts --list`
 *      `bun otto/jobs.ts --run <id>`   (the detached supervisor; not for humans)
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { headlessMcpArgs } from './headless.ts'

export type JobState = 'queued' | 'running' | 'parked' | 'done' | 'failed' | 'killed'

export type Job = {
  id: string
  /** The prompt handed to the headless session, verbatim. */
  task: string
  state: JobState
  createdAt: string
  startedAt?: string
  endedAt?: string
  /** Per-job working directory. The job may write here and nowhere else. */
  scratchDir: string
  /** Claude Code tool names. Empty means the caller wanted the default set,
   * which we refuse — see createJob. */
  tools: string[]
  wallClockMs: number
  tokenBudget: number
  tokensUsed: number
  costUsd?: number
  pid?: number
  /** "overnight" defers to quiet hours; everything else is free-form labelling. */
  tags: string[]
  /** Where to report back. Carried on the job because the tap that started it
   * may be hours dead by the time it finishes. */
  chatId?: string
  /** Whatever it produced. Present on done AND on killed. */
  result?: string
  /** true when `result` is only what it had got to when the axe fell. */
  partial?: boolean
  error?: string
  /** Parked jobs do not start before this. */
  notBefore?: string
}

/** Ten minutes is long enough for real research and short enough that a stuck
 * job is noticed the same morning. */
export const DEFAULT_WALL_CLOCK_MS = 10 * 60_000
export const MAX_WALL_CLOCK_MS = 2 * 60 * 60_000
export const DEFAULT_TOKEN_BUDGET = 150_000
export const MAX_TOKEN_BUDGET = 2_000_000
/** Two at once. The Mac is also the user’s desktop; three headless sessions plus the
 * live one is audible in the fans. */
export const DEFAULT_MAX_RUNNING = 2

export function jobId(): string {
  return randomBytes(4).toString('hex')
}

export function isTerminal(state: JobState): boolean {
  return state === 'done' || state === 'failed' || state === 'killed'
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function loadJobs(file: string): Job[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as Job[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: jobs.json corrupt, moved aside.\n')
    }
    return []
  }
}

export function saveJobs(file: string, jobs: Job[]): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(jobs, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * Read-modify-write one record.
 *
 * The scheduler in the channel process and each job's own supervisor both write
 * this file. Re-reading immediately before writing keeps the window to
 * microseconds; at two jobs an hour that is the right amount of machinery. A
 * lock file would be more correct and would also be the only lock in Otto.
 */
export function updateJob(file: string, id: string, patch: (j: Job) => Job): Job | null {
  const jobs = loadJobs(file)
  const i = jobs.findIndex(j => j.id === id)
  if (i < 0) return null
  jobs[i] = patch(jobs[i])
  saveJobs(file, jobs)
  return jobs[i]
}

/** Finished jobs older than this are dropped on the next save. */
export const RETAIN_MS = 7 * 24 * 60 * 60 * 1000

export function pruneJobs(jobs: Job[], now: number, retainMs = RETAIN_MS): Job[] {
  return jobs.filter(j => {
    if (!isTerminal(j.state)) return true
    const at = Date.parse(j.endedAt ?? j.createdAt)
    return Number.isNaN(at) || now - at < retainMs
  })
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export type JobInput = {
  task: string
  tools: string[]
  wallClockMs?: number
  tokenBudget?: number
  tags?: string[]
  chatId?: string
  /** Quiet-hours window "HH:MM-HH:MM", needed only to place an overnight job. */
  quietHours?: string
}

/**
 * Build the record. Nothing is spawned here.
 *
 * The tool allowlist is required rather than defaulted. A delegated job runs
 * with nobody watching it; inheriting the full tool set by omission is how a
 * "summarise these emails" job ends up able to send them.
 */
export function createJob(
  input: JobInput,
  o: { now?: number; scratchRoot: string; id?: string } ,
): Job {
  const task = input.task?.trim()
  if (!task) throw new Error('task is required')
  if (!input.tools?.length) throw new Error('tools allowlist is required — a job with nobody watching it does not get the default set')

  const now = o.now ?? Date.now()
  const id = o.id ?? jobId()
  const tags = (input.tags ?? []).map(t => t.trim().toLowerCase()).filter(Boolean)
  const overnight = tags.includes('overnight')
  const notBefore = overnight ? nextQuietStart(parseQuietHours(input.quietHours), new Date(now)) : undefined

  return {
    id,
    task,
    // An overnight job is parked from birth; everything else queues and the next
    // scheduler tick picks it up.
    state: overnight ? 'parked' : 'queued',
    createdAt: new Date(now).toISOString(),
    scratchDir: join(o.scratchRoot, id),
    tools: [...input.tools],
    wallClockMs: clamp(input.wallClockMs ?? DEFAULT_WALL_CLOCK_MS, 10_000, MAX_WALL_CLOCK_MS),
    tokenBudget: clamp(input.tokenBudget ?? DEFAULT_TOKEN_BUDGET, 1_000, MAX_TOKEN_BUDGET),
    tokensUsed: 0,
    tags,
    ...(input.chatId ? { chatId: input.chatId } : {}),
    ...(notBefore ? { notBefore: new Date(notBefore).toISOString() } : {}),
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.min(Math.max(n, lo), hi)
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type JobEvent =
  | { type: 'start'; at: number; pid?: number }
  | { type: 'progress'; tokens?: number; costUsd?: number; text?: string }
  | { type: 'finish'; at: number; result: string }
  | { type: 'fail'; at: number; error: string }
  | { type: 'kill'; at: number; reason: 'wall-clock' | 'budget' | 'asked'; partial?: string }
  | { type: 'park'; until: string }
  | { type: 'wake' }

const LEGAL: Record<JobState, JobState[]> = {
  queued: ['running', 'parked', 'killed'],
  parked: ['queued', 'killed'],
  running: ['running', 'done', 'failed', 'killed'],
  done: [],
  failed: [],
  killed: [],
}

/**
 * Pure transition. Returns a new record; throws on an illegal move.
 *
 * Throwing matters: the alternative is a job that quietly goes from killed back
 * to running because a late tick from its own dying supervisor arrived after
 * the scheduler had already given up on it.
 */
export function applyEvent(job: Job, ev: JobEvent): Job {
  const to = targetState(job, ev)
  if (!LEGAL[job.state].includes(to)) {
    throw new Error(`job ${job.id}: illegal ${job.state} -> ${to} on ${ev.type}`)
  }
  switch (ev.type) {
    case 'start':
      return { ...job, state: 'running', startedAt: new Date(ev.at).toISOString(), ...(ev.pid ? { pid: ev.pid } : {}) }
    case 'progress':
      return {
        ...job,
        tokensUsed: job.tokensUsed + (ev.tokens ?? 0),
        ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}),
        ...(ev.text ? { result: ev.text } : {}),
      }
    case 'finish':
      return { ...job, state: 'done', endedAt: new Date(ev.at).toISOString(), result: ev.result, partial: false }
    case 'fail':
      return { ...job, state: 'failed', endedAt: new Date(ev.at).toISOString(), error: ev.error }
    case 'kill': {
      // Everything it managed to say before the axe. Reported as partial so the
      // session never presents nine minutes of work as a finished answer.
      const text = ev.partial ?? job.result
      return {
        ...job,
        state: 'killed',
        endedAt: new Date(ev.at).toISOString(),
        error: `killed: ${ev.reason}`,
        ...(text ? { result: text, partial: true } : {}),
      }
    }
    case 'park':
      return { ...job, state: 'parked', notBefore: ev.until }
    case 'wake': {
      const { notBefore, ...rest } = job
      return { ...rest, state: 'queued' }
    }
  }
}

function targetState(job: Job, ev: JobEvent): JobState {
  switch (ev.type) {
    case 'start': return 'running'
    case 'progress': return job.state
    case 'finish': return 'done'
    case 'fail': return 'failed'
    case 'kill': return 'killed'
    case 'park': return 'parked'
    case 'wake': return 'queued'
  }
}

export function budgetExceeded(job: Job): boolean {
  return job.tokensUsed > job.tokenBudget
}

export function overWallClock(job: Job, now: number): boolean {
  if (job.state !== 'running' || !job.startedAt) return false
  const started = Date.parse(job.startedAt)
  return !Number.isNaN(started) && now - started > job.wallClockMs
}

// ---------------------------------------------------------------------------
// Quiet hours — where overnight jobs go
// ---------------------------------------------------------------------------

export type QuietWindow = { startMin: number; endMin: number }

/** "23:00-08:00", local wall clock, wrapping past midnight. */
export function parseQuietHours(spec?: string): QuietWindow | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(spec ?? '')
  if (!m) return null
  const startMin = Number(m[1]) * 60 + Number(m[2])
  const endMin = Number(m[3]) * 60 + Number(m[4])
  if (startMin > 1439 || endMin > 1439 || startMin === endMin) return null
  return { startMin, endMin }
}

export function inQuietHours(w: QuietWindow | null, at: Date): boolean {
  if (!w) return false
  const mins = at.getHours() * 60 + at.getMinutes()
  return w.startMin < w.endMin
    ? mins >= w.startMin && mins < w.endMin
    : mins >= w.startMin || mins < w.endMin
}

/**
 * When the next quiet window opens, as an epoch ms.
 *
 * Already inside one returns now: an overnight job created at 02:00 should run
 * at 02:00, not wait 21 hours for the window to come round again. With no quiet
 * hours configured there is no overnight to defer to, so it returns undefined
 * and the job just queues.
 */
export function nextQuietStart(w: QuietWindow | null, now: Date): number | undefined {
  if (!w) return undefined
  if (inQuietHours(w, now)) return now.getTime()
  const start = new Date(now)
  start.setHours(Math.floor(w.startMin / 60), w.startMin % 60, 0, 0)
  if (start.getTime() <= now.getTime()) start.setDate(start.getDate() + 1)
  return start.getTime()
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export type ScheduleDecision = {
  /** parked -> queued: their hour has come. */
  wake: Job[]
  /** queued -> running: hand these to spawnJob. */
  start: Job[]
  /** running -> killed, with the reason to record. */
  kill: { job: Job; reason: 'wall-clock' | 'budget' }[]
}

/**
 * What the next tick should do. No I/O, no clock of its own.
 *
 * Overnight jobs are woken only while quiet hours are actually running, not
 * merely because their notBefore passed — otherwise a Mac asleep through the
 * whole window comes back at 09:00 and starts the night's work over breakfast.
 */
export function scheduleJobs(
  jobs: Job[],
  o: { now: number; maxRunning?: number; quiet?: QuietWindow | null },
): ScheduleDecision {
  const maxRunning = o.maxRunning ?? DEFAULT_MAX_RUNNING
  const quietNow = inQuietHours(o.quiet ?? null, new Date(o.now))

  const kill = jobs
    .filter(j => j.state === 'running')
    .filter(j => overWallClock(j, o.now) || budgetExceeded(j))
    .map(j => ({ job: j, reason: (budgetExceeded(j) ? 'budget' : 'wall-clock') as 'budget' | 'wall-clock' }))

  const wake = jobs.filter(j => {
    if (j.state !== 'parked') return false
    const at = Date.parse(j.notBefore ?? '')
    if (!Number.isNaN(at) && at > o.now) return false
    return j.tags.includes('overnight') ? quietNow : true
  })

  const runningAfter = jobs.filter(j => j.state === 'running').length - kill.length
  const slots = Math.max(0, maxRunning - runningAfter)
  const start = [...jobs.filter(j => j.state === 'queued'), ...wake]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, slots)

  return { wake, start, kill }
}

// ---------------------------------------------------------------------------
// Reading the stream
// ---------------------------------------------------------------------------

export type StreamTally = {
  tokens: number
  costUsd?: number
  /** Assistant prose so far — the partial return if this job gets killed. */
  text: string
  /** The final result block, once the CLI emits one. */
  result?: string
  ok?: boolean
}

export const EMPTY_TALLY: StreamTally = { tokens: 0, text: '' }

/**
 * Fold one `--output-format stream-json` line into the tally.
 *
 * Counting as the stream arrives rather than reading usage off the final result
 * is the whole reason the budget can be enforced at all: the result block only
 * shows up on a run that finished, which is exactly the run that did not need
 * stopping. Cache reads are counted at full price here — deliberately
 * pessimistic, because a budget that under-counts is not a budget.
 */
export function tallyStream(prev: StreamTally, line: string): StreamTally {
  const trimmed = line.trim()
  if (!trimmed) return prev
  let d: Record<string, unknown>
  try { d = JSON.parse(trimmed) } catch { return prev }

  const type = d.type as string | undefined
  if (type === 'assistant') {
    const message = d.message as { content?: unknown; usage?: Record<string, number> } | undefined
    const u = message?.usage ?? {}
    const tokens =
      (u.input_tokens ?? 0) + (u.output_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    const parts: string[] = []
    if (Array.isArray(message?.content)) {
      for (const b of message!.content as { type?: string; text?: string }[]) {
        if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      }
    }
    const text = parts.join('\n').trim()
    return {
      ...prev,
      tokens: prev.tokens + tokens,
      text: text ? (prev.text ? `${prev.text}\n${text}` : text) : prev.text,
    }
  }

  if (type === 'result') {
    const u = (d.usage as Record<string, number> | undefined) ?? {}
    const total =
      (u.input_tokens ?? 0) + (u.output_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    return {
      ...prev,
      // The result block restates the whole run's usage, so it replaces the
      // running count rather than adding to it.
      tokens: total || prev.tokens,
      ...(typeof d.total_cost_usd === 'number' ? { costUsd: d.total_cost_usd } : {}),
      ...(typeof d.result === 'string' ? { result: d.result } : {}),
      ok: d.is_error !== true && d.subtype === 'success',
    }
  }

  return prev
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatJob(j: Job, now = Date.now()): string {
  const bits = [`[${j.id}] ${j.state}`]
  if (j.state === 'running' && j.startedAt) {
    bits.push(`${Math.round((now - Date.parse(j.startedAt)) / 60_000)}m`)
  }
  if (j.state === 'parked' && j.notBefore) bits.push(`until ${j.notBefore.slice(11, 16)}`)
  if (j.tokensUsed) bits.push(`${Math.round(j.tokensUsed / 1000)}k/${Math.round(j.tokenBudget / 1000)}k tok`)
  if (j.partial) bits.push('partial')
  const head = bits.join(' ')
  const task = j.task.replace(/\s+/g, ' ').slice(0, 70)
  return `${head} — ${task}${j.task.length > 70 ? '…' : ''}`
}

export function formatJobs(jobs: Job[], now = Date.now()): string {
  if (!jobs.length) return '(no jobs)'
  const order: JobState[] = ['running', 'queued', 'parked', 'done', 'failed', 'killed']
  return [...jobs]
    .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || b.createdAt.localeCompare(a.createdAt))
    .map(j => formatJob(j, now))
    .join('\n')
}

/**
 * The message that goes back through the webhook.
 *
 * Framed as data with its own provenance, because by the time it lands the
 * session has no memory of asking, and a job's output is exactly as untrusted
 * as an email's — it is text a model wrote after reading the open internet.
 */
export function resultPayload(job: Job): { text: string; source: string } {
  const head =
    job.state === 'done' ? 'finished'
      : job.state === 'killed' ? `stopped early (${job.error ?? 'killed'})`
        : `failed (${job.error ?? 'unknown'})`
  const body = job.result?.trim() || '(no output)'
  return {
    source: 'otto-job',
    text: [
      `Background job [${job.id}] ${head}.`,
      `Task: ${job.task.replace(/\s+/g, ' ').slice(0, 300)}`,
      job.partial ? 'The output below is partial — it is what it had produced when it was stopped.' : '',
      job.chatId ? `Report to chat_id ${job.chatId} if it is worth telling the user; silence is valid.` : '',
      '',
      body.slice(0, 8000),
    ].filter(Boolean).join('\n'),
  }
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
export const JOBS_FILE = join(STATE_DIR, 'jobs.json')
export const SCRATCH_ROOT = join(STATE_DIR, 'jobs')

/**
 * Start the detached supervisor for one job and return.
 *
 * The supervisor is this same file re-invoked with --run: it owns the claude
 * process, the wall clock, the token count and the webhook post, and it holds
 * none of the channel's state. Detaching matters — the channel session restarts
 * often, and a job tied to its lifetime would die every time the user edits a trigger.
 *
 * OTTO_CHANNEL_HOST is scrubbed for the same reason consolidate.ts scrubs it: a
 * child that believes it is the channel host reaps the poller and takes the
 * Telegram token, leaving the real assistant deaf.
 */
export function spawnJob(job: Job, o: { jobsFile?: string } = {}): number | undefined {
  mkdirSync(job.scratchDir, { recursive: true, mode: 0o700 })
  // Typed loosely on purpose: a narrowed literal type would make the delete
  // below a compile error, and that delete is the line that matters most here.
  const env: Record<string, string | undefined> = { ...process.env, OTTO_JOBS_FILE: o.jobsFile ?? JOBS_FILE }
  delete env.OTTO_CHANNEL_HOST
  try {
    const proc = Bun.spawn(['bun', import.meta.path, '--run', job.id], {
      env,
      cwd: job.scratchDir,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    proc.unref()
    return proc.pid
  } catch (err) {
    process.stderr.write(`otto jobs: failed to spawn ${job.id}: ${err}\n`)
    return undefined
  }
}

export async function postResult(job: Job, o: { port: number; token: string }): Promise<boolean> {
  const { text, source } = resultPayload(job)
  try {
    const res = await fetch(`http://127.0.0.1:${o.port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ text, source }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** The supervisor. One job, from spawn to webhook, in its own process. */
async function runJob(id: string): Promise<void> {
  const file = process.env.OTTO_JOBS_FILE ?? JOBS_FILE
  const job = loadJobs(file).find(j => j.id === id)
  if (!job) { process.stderr.write(`otto jobs: no job ${id}\n`); return }

  const claude = join(homedir(), '.local', 'bin', 'claude')
  if (!existsSync(claude)) {
    updateJob(file, id, j => applyEvent(j, { type: 'fail', at: Date.now(), error: 'claude CLI not found' }))
    return
  }

  const env = { ...process.env }
  delete env.OTTO_CHANNEL_HOST

  const proc = Bun.spawn(
    [claude, '-p', job.task, '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'auto', '--allowedTools', job.tools.join(','), ...headlessMcpArgs({ otto: true })],
    { env, cwd: job.scratchDir, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
  )
  updateJob(file, id, j => applyEvent(j, { type: 'start', at: Date.now(), pid: proc.pid }))

  let killedFor: 'wall-clock' | 'budget' | null = null
  const timer = setTimeout(() => { killedFor = 'wall-clock'; try { proc.kill() } catch {} }, job.wallClockMs)

  let tally = EMPTY_TALLY
  let buffer = ''
  try {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += new TextDecoder().decode(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        tally = tallyStream(tally, line)
        if (tally.tokens > job.tokenBudget && !killedFor) {
          killedFor = 'budget'
          try { proc.kill() } catch {}
        }
      }
    }
    if (buffer) tally = tallyStream(tally, buffer)
  } catch {}
  clearTimeout(timer)
  const code = await proc.exited

  const at = Date.now()
  const finished = updateJob(file, id, j => {
    const withUsage = applyEvent(j, { type: 'progress', tokens: tally.tokens - j.tokensUsed, ...(tally.costUsd !== undefined ? { costUsd: tally.costUsd } : {}) })
    if (killedFor) return applyEvent(withUsage, { type: 'kill', at, reason: killedFor, partial: tally.text })
    if (code !== 0 && !tally.result) return applyEvent(withUsage, { type: 'fail', at, error: `exit ${code}` })
    return applyEvent(withUsage, { type: 'finish', at, result: tally.result ?? tally.text })
  })

  if (!finished) return
  try {
    const access = JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8')) as {
      webhook?: { port?: number; token: string }
    }
    if (access.webhook?.token) {
      await postResult(finished, { port: access.webhook.port ?? 4589, token: access.webhook.token })
    }
  } catch {}
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const runIdx = argv.indexOf('--run')
  if (runIdx >= 0) {
    await runJob(argv[runIdx + 1] ?? '')
  } else {
    console.log(formatJobs(loadJobs(process.env.OTTO_JOBS_FILE ?? JOBS_FILE)))
  }
}
