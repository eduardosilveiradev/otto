import { slotSnapshot, type SlotWaiter } from './slots.ts'
import { activityLine, jobWaiters, currentSlotWait, jobSpans } from './job-overview.ts'
import type { SlotWait, JobSpan, MacLoad } from './dash-types.ts'
import { Overnight } from './overnight.ts'
/**
 * Coding jobs — work Otto hands to a coding agent and then looks after.
 *
 * Otto does not write the code. It starts a T3 Code thread (a project, a worktree branch, a
 * model, a brief), remembers which job that thread is, and from then on reads three things
 * to say how the job is doing: the thread (running, idle, asking something), the pull request
 * on its branch (diff stats, checks, a small diff preview) and the council table in the PR
 * body. The user merges on their word, from the app; the merge runs here with `gh`.
 *
 * `code-jobs.json` keeps only what no source can tell us: which thread and repo a job is,
 * what it was asked, its display title and project, and what the user did to it. Everything else
 * is read fresh, so the file can't drift from T3 or GitHub. (`jobs.json` and `jobs.ts` are the
 * headless `delegate` runner's, a different thing, so this lives beside them.)
 *
 * The wire shape is the app's ("GET /app/jobs"). The readers are
 * injected, so the tests run against a fake T3 and a fake gh.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join } from 'path'
import { homedir } from 'os'
import { createHash, randomBytes } from 'crypto'
import { loadState, saveState } from './statefile.ts'
import { run, runChecked, CommandError } from './workspace.ts'
import { t3ThreadUrl, modelLabel, t3Host, sshCmd } from './t3.ts'
import { route, routerConfig, paceConfig, isUIWork, type Effort } from './route.ts'
import { markOtto, Transcripts, normalizeTranscript, type TranscriptSource } from './transcript.ts'
import { PrDetails } from './prdetail.ts'
import { Github, github, type GithubStatus } from './github.ts'
import { DEFAULT_GPT_MODEL } from './jobs.ts'
import { liveWindows, PLAN_WINDOWS } from './spend.ts'
import { readPlanUsage, weekMark, weekShare, priceTag, provider, appendJobCost, type WeekMark } from './usage.ts'
import type { Origin } from './selfedit.ts'
import { icloudRoots } from './landlord.ts'

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export type Exec = (cmd: string[], cwd?: string, timeoutMs?: number) => Promise<string | undefined>

export type WirePr = {
  n: number; title: string; url: string; add: number; del: number; files: number
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'; base: string
  checks: string; draft: boolean; diff: { file: string; hunk: string; lines: [' ' | '+' | '-', string][] }[]
}
export type PrInfo = { repo: string; headBranch: string; pr: WirePr; state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefOid?: string; createdAt?: string; mergedAt?: string; body: string }

type Check = { __typename?: string; status?: string | null; conclusion?: string | null; state?: string | null }

/** One line for the job card, from gh's statusCheckRollup (CheckRuns and commit StatusContexts). */
export function checksLine(rollup: Check[] | undefined): string {
  const all = rollup ?? []
  if (!all.length) return 'No checks'
  const verdict = (c: Check) => {
    const v = (c.conclusion ?? c.state ?? '').toUpperCase()
    if (c.status && c.status.toUpperCase() !== 'COMPLETED') return 'running'
    if (v === 'PENDING' || v === 'EXPECTED' || v === '') return 'running'
    if (v === 'SUCCESS' || v === 'NEUTRAL' || v === 'SKIPPED') return 'pass'
    return 'fail'
  }
  const n = { pass: 0, fail: 0, running: 0 }
  for (const c of all) n[verdict(c)]++
  const of = (k: number) => (k === all.length ? `${k === 1 ? 'Check' : `All ${k} checks`}` : `${k} of ${all.length} checks`)
  if (n.fail) return `${of(n.fail)} failing`
  if (n.running) return `${of(n.running)} running`
  return `${of(n.pass)} passing`
}

/** The first few hunks of a unified diff, a dozen lines each: a preview, never the whole diff. */
export function diffPreview(diff: string, maxHunks = 3, maxLines = 12): WirePr['diff'] {
  const out: WirePr['diff'] = []
  let file = ''
  let cur: WirePr['diff'][number] | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { file = line.replace(/^diff --git a\/.* b\//, ''); cur = undefined; continue }
    if (line.startsWith('+++ ') || line.startsWith('--- ') || /^(index|new file|deleted file|similarity|rename|old mode|new mode|Binary) /.test(line)) continue
    if (line.startsWith('@@')) {
      if (out.length >= maxHunks) break
      cur = { file, hunk: line.slice(0, 120), lines: [] }
      out.push(cur)
      continue
    }
    if (!cur || cur.lines.length >= maxLines) continue
    const mark = line[0]
    if (mark === ' ' || mark === '+' || mark === '-') cur.lines.push([mark, line.slice(1, 201)])
  }
  return out
}

const PR_FIELDS = 'number,title,url,state,isDraft,additions,deletions,changedFiles,statusCheckRollup,createdAt,mergedAt,body,headRefName,headRefOid,mergeable,baseRefName'

/** The PR on a branch (open first, then the newest merged or closed), or by number. */
export async function readPr(repo: string, ref: { n?: number; branch?: string }, exec: Exec = github.run, previous?: PrInfo): Promise<PrInfo | undefined> {
  let raw: Record<string, any> | undefined
  if (ref.n) {
    const out = await exec(['gh', 'pr', 'view', String(ref.n), '--repo', repo, '--json', PR_FIELDS], undefined, 15_000)
    raw = out ? JSON.parse(out) : undefined
  } else if (ref.branch) {
    const out = await exec(['gh', 'pr', 'list', '--repo', repo, '--head', ref.branch, '--state', 'all', '--limit', '5', '--json', PR_FIELDS], undefined, 15_000)
    const list = out ? (JSON.parse(out) as Record<string, any>[]) : []
    raw = list.find(p => p.state === 'OPEN') ?? list[0]
  }
  if (!raw?.number) return undefined
  const sameHead = !!raw.headRefOid && previous?.repo === repo && previous.pr.n === raw.number && previous.headRefOid === raw.headRefOid
  const diff = raw.state === 'OPEN' && !sameHead ? await exec(['gh', 'pr', 'diff', String(raw.number), '--repo', repo], undefined, 15_000) : undefined
  return {
    repo, headBranch: String(raw.headRefName ?? ''),
    state: raw.state, headRefOid: raw.headRefOid,
    ...(raw.mergedAt ? { mergedAt: raw.mergedAt } : {}),
    createdAt: raw.createdAt,
    body: String(raw.body ?? ''),
    pr: {
      mergeable: raw.mergeable === 'MERGEABLE' || raw.mergeable === 'CONFLICTING' ? raw.mergeable : 'UNKNOWN',
      base: String(raw.baseRefName ?? ''),
      n: raw.number, title: String(raw.title ?? ''), url: String(raw.url ?? ''),
      add: raw.additions ?? 0, del: raw.deletions ?? 0, files: raw.changedFiles ?? 0,
      checks: checksLine(raw.statusCheckRollup), draft: !!raw.isDraft, diff: sameHead ? previous!.pr.diff : diff ? diffPreview(diff) : [],
    },
  }
}

// ---------------------------------------------------------------------------
// Council
// ---------------------------------------------------------------------------

export type Council = { round: number; scores: Record<string, number | null>; fixes: string[] }[]

/** "Claude Opus 5.5" → Opus, "GPT-6.1-Sol" → Sol: the last word that isn't a version. */
export function memberName(s: string): string {
  const words = s.replace(/[*_`]/g, '').split(/[\s-]+/).filter(w => /^[A-Za-z][\w.]*$/.test(w) && !/^v?\d/.test(w))
  return words.at(-1) ?? s.trim()
}

/** "7/10" → 7, "8 / 9" (two axes) → 9, the last one, "no score" → null. */
export function cellScore(cell: string): number | null {
  const last = cell.replace(/\/\s*10\b/g, '').split('/').at(-1)!.trim()
  const n = Number(last.match(/^\d+(\.\d+)?/)?.[0])
  return last && Number.isFinite(n) && /^\d/.test(last) ? n : null
}

/**
 * The council table a PR body carries (the council skill's format):
 *   | Delegate | Round 1 | Round 2 |
 *   | --- | --- | --- |
 *   | Claude Opus | 7/10 | 9/10 |
 * Fix lists aren't in that table, so `fixes` stays empty; the PR body has them in prose.
 */
export function parseCouncil(body: string): Council {
  const lines = body.split('\n').map(l => l.trim())
  const head = lines.findIndex(l => /^\|\s*(delegate|member|reviewer)s?\s*\|.*round\s*\d/i.test(l))
  if (head < 0) return []
  const cells = (l: string) => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim())
  const rounds = cells(lines[head]!).slice(1).map(c => Number(c.match(/\d+/)?.[0]))
  const council: Council = rounds.map(round => ({ round, scores: {}, fixes: [] }))
  for (const l of lines.slice(head + 1)) {
    if (!l.startsWith('|')) break
    const row = cells(l)
    if (row.every(c => /^:?-+:?$/.test(c))) continue
    const name = memberName(row[0]!)
    row.slice(1, rounds.length + 1).forEach((c, i) => { council[i]!.scores[name] = cellScore(c) })
  }
  return council.filter(r => Number.isFinite(r.round))
}

// ---------------------------------------------------------------------------
// The job record (code-jobs.json)
// ---------------------------------------------------------------------------

export type Step = { ts: string; text: string; note?: string }

export type CodeJob = {
  reserveHeld?: boolean
  pipId?: string
  origin?: Origin
  after?: string
  afterTitle?: string
  afterBlockedAt?: string
  launchClaimedAt?: string
  launchError?: string
  /** The launch request may have reached T3 (it timed out or lost its socket): T3 may have the thread. */
  launchUncertain?: boolean
  /** Hash of everything asked but the note: the same ask again within SAME_REQUEST_MS is this job. */
  requestKey?: string
  id: string
  title: string
  /** The brief the agent was handed, verbatim. */
  brief: string
  /** Display grouping; projectId stays the original T3 project when this name changes. */
  project: string
  projectId?: string
  /** owner/name, for gh. Absent: not known yet; see CodeJobs.target for how it's found. */
  repo?: string
  /** True when code_job was told the repo outright; then nothing re-reads it. */
  repoGiven?: boolean
  /** The folder the work happens in, when code_job was told one: its git remote names the repo. */
  path?: string
  branch?: string
  threadId?: string
  agent: 'T3 Code' | 'Codex Cloud'
  where: 'local' | 'cloud'
  model?: string
  effort?: Effort
  createdAt: string
  startedAt?: string
  endedAt?: string
  tokenBudget: number
  pendingPr?: { title: string; bodyPath: string; branch: string; base: string; error?: string }
  base?: string
  slotWaits?: SlotWaiter[]
  reviewAt?: string
  worktreePath?: string
  /** Once known; lookups by branch stop after that. */
  prNumber?: number
  /** Last verified PR fields, also available after a restart or an API outage. */
  prInfo?: PrInfo
  /** T3 confirmed this thread created the pinned PR, even if its branch was renamed. */
  prOpenedByThread?: boolean
  /** Last count read off the thread, kept so a finished job still shows what it spent. */
  tokensUsed?: number
  /** Claude's weekly window when the thread launched, and the estimated share of it the job took, frozen when it ends. */
  weekStart?: WeekMark
  weekShare?: number
  mergedAt?: string
  stoppedAt?: string
  /** What Otto and the user did to it. What the agent did comes from the thread. */
  steps: Step[]
  /** Client photo ids already dispatched, retained across upload retries and restarts. */
  photoReplies?: string[]
  /** Messages Otto wrote and sent the agent after the brief (the resolve task), so the transcript shows them as Otto's. */
  ottoSent?: string[]
}

export const DEFAULT_JOB_TOKEN_BUDGET = 400_000
/** How long the same code_job request counts as a retry of the job it made. */
export const SAME_REQUEST_MS = 15 * 60_000
export const JOB_START_STALE_MS = 15 * 60_000
// ponytail: one fixed daily budget for the usage strip; move it to access.json when someone wants another number.
export const DAILY_TOKEN_BUDGET = 4_000_000

const STATE_DIR = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
export const CODE_JOBS_FILE = join(STATE_DIR, 'code-jobs.json')

const validJobs = (x: unknown) => Array.isArray(x) && x.every(j => j && typeof j === 'object' && typeof (j as CodeJob).id === 'string')
// A snapshot looks jobs up hundreds of times and the store runs to megabytes (PR bodies, briefs):
// parse it once per version of the file. saveState renames a new file in, so the inode changes on every write.
let parsed: { file: string; key: string; jobs: CodeJob[] } | undefined
export const loadCodeJobs = (file = CODE_JOBS_FILE): CodeJob[] => {
  let key = ''
  try { const s = statSync(file); key = `${s.ino}:${s.mtimeMs}:${s.size}` } catch {}
  const jobs = key && parsed?.file === file && parsed.key === key ? parsed.jobs : loadState<CodeJob[]>(file, () => [], validJobs)
  parsed = key ? { file, key, jobs } : undefined
  // Callers reassign top-level fields on what they get; nested values are only ever replaced, never edited.
  return jobs.map(j => ({ ...j }))
}
export const saveCodeJobs = (file: string, jobs: CodeJob[]): void => saveState(file, jobs)

export function updateCodeJob(file: string, id: string, patch: (j: CodeJob) => CodeJob): CodeJob | undefined {
  const jobs = loadCodeJobs(file)
  const i = jobs.findIndex(j => j.id === id)
  if (i < 0) return undefined
  jobs[i] = patch(jobs[i]!)
  saveCodeJobs(file, jobs)
  return jobs[i]
}

export const newJobId = () => `j${randomBytes(3).toString('hex')}`
const step = (text: string, note?: string, at = Date.now()): Step => ({ ts: new Date(at).toISOString(), text, ...(note ? { note } : {}) })
export const addStep = (j: CodeJob, text: string, note?: string, at?: number): CodeJob => ({ ...j, steps: [...j.steps, step(text, note, at)] })

/** Finished jobs older than this drop off the list. */
export const RETAIN_MS = 14 * 86_400_000
export function pruneCodeJobs(jobs: CodeJob[], now: number): CodeJob[] {
  const predecessors = new Set(jobs.filter(j => j.after && !j.stoppedAt).map(j => j.after))
  return jobs.filter(j => predecessors.has(j.id) || !(j.mergedAt || j.stoppedAt) || now - Date.parse(j.mergedAt ?? j.stoppedAt!) < RETAIN_MS)
}

// ---------------------------------------------------------------------------
// The wire (GET /app/jobs)
// ---------------------------------------------------------------------------

export type ThreadPr = { repo: string; n: number; openedByThread?: boolean }

/** What a source says about a thread right now. Every field optional but id and status. */
export type ThreadSnap = {
  id: string
  /** running: a turn is going. input: it asked something. idle: its turn ended. gone: T3 doesn't have it. */
  status: 'running' | 'input' | 'idle' | 'error' | 'gone'
  /** T3's own status, verbatim (`activityRunStatus ?? status`); see T3_STATUS_LABELS. */
  t3Status?: string
  /** A pending question can pause a turn without ending it. */
  activeTurn?: boolean
  now?: string
  /** T3's pending commands, subagents or monitors, independent of the active turn. */
  backgroundWork?: string
  question?: { text: string; answers: string[]; askedAt: string }
  tokensUsed?: number
  model?: string
  branch?: string
  /** The agent's last words, used when T3 has no explicit request or pending work. */
  lastMessage?: string
  updatedAt?: string
  /** Latest T3 run request, independent of thread edits and completion timestamps. */
  runRequestedAt?: string
  /** The PR T3 has linked to the thread: its repo (owner/name) and number. */
  pr?: ThreadPr
  /** All linked PRs, newest first, so a foreign link cannot hide the job's own PR. */
  prs?: ThreadPr[]
  /** The thread's own checkout, once T3 has made it. */
  worktreePath?: string
}

/** owner/name of a GitHub remote URL (https, ssh:// or scp-style), else undefined. */
export function githubRepo(url: string): string | undefined {
  const m = url.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git:\/\/|[^@/\s]+@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
  return m ? `${m[1]}/${m[2]}` : undefined
}

/**
 * The repo a checkout belongs to, from `git remote -v`, picked the way T3 Code picks a
 * project's (RepositoryIdentityResolver): fetch URLs only, upstream first, then origin, then
 * the first by name. Only GitHub remotes count, since gh is what reads and merges the PR.
 */
export function repoFromRemotes(out: string | undefined): string | undefined {
  const remotes = new Map<string, string>()
  for (const line of (out ?? '').split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(\S+)\s+\(fetch\)/)
    const repo = m && githubRepo(m[2]!)
    if (repo && !remotes.has(m[1]!)) remotes.set(m[1]!, repo)
  }
  const name = ['upstream', 'origin'].find(n => remotes.has(n)) ?? [...remotes.keys()].sort()[0]
  return name ? remotes.get(name) : undefined
}

export const REPO_RE = /^[\w.-]+\/[\w.-]+$/

/** The first GitHub PR a message names by URL. */
export function prFromText(text: string | undefined): { repo: string; n: number } | undefined {
  const m = text?.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)
  return m ? { repo: m[1]!, n: Number(m[2]) } : undefined
}

/** Whether an agent's last words ask something, judged by its last paragraph. A report doesn't. */
export function asksSomething(text: string): boolean {
  const last = text.trim().split(/\n\s*\n/).at(-1) ?? ''
  return /[?？]|\b(?:please\s+(?:confirm|approve|choose|decide)|waiting for your (?:approval|confirmation|answer))\b/i.test(last)
}

/**
 * Every thread status T3 Code reports (its OrchestrationV2RunStatus plus idle), labelled for the apps.
 * T3 has no needs-input status: a question is its pendingRuntimeRequest, which reads as state 'input'.
 */
export const T3_STATUS_LABELS: Record<string, string> = {
  idle: 'Idle', queued: 'Queued', preparing: 'Preparing', starting: 'Starting', running: 'Running',
  waiting: 'Waiting on background work', completed: 'Completed', interrupted: 'Interrupted',
  failed: 'Failed', cancelled: 'Cancelled', rolled_back: 'Rolled back',
}
export const t3Label = (status: string): string => T3_STATUS_LABELS[status] ?? status

/** The job state a T3 status settles on its own. idle and completed defer to the agent's last words and the PR. */
const T3_STATE: Record<string, WireJob['state']> = {
  queued: 'queued', preparing: 'running', starting: 'running', running: 'running', waiting: 'waiting',
  interrupted: 'stopped', cancelled: 'stopped', rolled_back: 'stopped', failed: 'failed',
}

export type WireJob = {
  activity: string | null; slotWait: SlotWait | null; spans: JobSpan[]
  id: string; state: 'queued' | 'running' | 'waiting' | 'review' | 'done' | 'input' | 'merged' | 'stopped' | 'failed'
  /** T3's raw thread status and its label; `state` is derived from it first. Absent when T3 didn't say. */
  t3Status?: string; t3Label?: string
  afterTitle?: string
  threadId: string | null; threadUrl: string | null
  title: string; project: string; branch: string | null; agent: string; where: 'local' | 'cloud'; model: string | null
  createdAt: string; startedAt: string | null; endedAt: string | null; tokensUsed: number; tokenBudget: number
  now: string | null; question: { text: string; answers: string[]; askedAt: string } | null
  council: Council; steps: Step[]; pr: WirePr | null; prStale?: boolean
  /** Finished jobs only: "2.1M Claude tokens · ~3% of the week". */
  cost?: string
}
export type WireJobs = { mac: MacLoad | null; github: GithubStatus; usage: { jobsToday: number; tokensToday: number; tokenBudget: number }; jobs: WireJob[] }

/** A narrow fallback for older T3 snapshots; any question or request for action wins. */
export function waitingLine(text: string | undefined): string | undefined {
  const line = text?.trim()
  if (!line || /[?？]|\b(?:you|your|please|let me know|confirm|approve|choose|decide)\b/i.test(line)) return undefined
  if (!/^(?:(?:I(?:'m| am)|We(?:'re| are))\s+)?waiting (?:on|for)\s+\S|^(?:(?:It(?:'s| is)|The [^.!\n]+ is)\s+)?running in the background\b|^(?:I(?:'ll| will)|We(?:'ll| will)) check back\b/i.test(line)) return undefined
  return line.replace(/\s+/g, ' ').slice(0, 120)
}

export function wireJob(j: CodeJob, t: ThreadSnap | undefined, p: PrInfo | undefined, now = Date.now()): WireJob {
  const active = t?.status === 'running' || t?.activeTurn
  const merged = !j.stoppedAt && (!!j.mergedAt || (!active && p?.state === 'MERGED'))
  const stopped = !merged && (!!j.stoppedAt || (!active && p?.state === 'CLOSED'))
  const waiting = t?.t3Status === 'waiting' ? t.backgroundWork ?? t3Label('waiting')
    : t?.status === 'idle' ? t.backgroundWork || waitingLine(t.lastMessage) : undefined
  const missingThread = !j.threadId || (t?.status === 'gone' && !p && !j.pendingPr)
  const held = !j.launchClaimedAt && (j.after || j.reserveHeld)
  const stale = missingThread && !held && now - Date.parse(j.launchClaimedAt ?? j.createdAt) >= JOB_START_STALE_MS
  // A launch that failed has nothing to answer: it dies as failed instead of waiting on input.
  const launchFailed = !j.threadId && !!j.launchError
  const launchQuestion = !j.threadId && !j.launchError && j.afterBlockedAt ? {
    text: `“${j.afterTitle}” stopped or its PR closed without merging. Start this job anyway or drop it?`,
    answers: ['Start anyway', 'Drop it'], askedAt: j.afterBlockedAt,
  } : undefined
  const state: WireJob['state'] =
    merged ? 'merged'
      : stopped ? 'stopped'
        : launchFailed || stale ? 'failed'
        : launchQuestion ? 'input'
        : missingThread ? 'queued'
          : j.pendingPr && !active ? 'done'
          : t?.status === 'input' || t?.question || (t?.status === 'idle' && asksSomething(t.lastMessage ?? '')) ? 'input'
            // T3 first: PR data never overrides what T3 says the thread is doing.
            : t?.t3Status && T3_STATE[t.t3Status] ? T3_STATE[t.t3Status]!
            : t?.status === 'running' ? 'running'
              : p?.state === 'OPEN' ? 'review'
                : waiting ? 'waiting'
                : t?.status === 'idle' ? 'done'
                  : t?.status === 'error' ? 'failed'
                    : 'running'
  const question = state !== 'input' ? null
    : launchQuestion ?? t?.question ?? { text: t?.lastMessage?.trim() || (t?.status === 'error' ? 'The thread stopped on an error.' : 'It stopped without opening a PR.'), answers: [], askedAt: t?.updatedAt ?? j.createdAt }
  const cost = state === 'merged' || state === 'stopped' || state === 'failed' ? priceTag(t?.tokensUsed ?? j.tokensUsed, j.model, j.weekShare) : undefined
  const endedAt = j.stoppedAt ?? j.mergedAt ?? (state === 'merged' ? p?.mergedAt : undefined) ?? (state === 'review' || state === 'done' ? j.endedAt ?? t?.updatedAt : undefined) ?? null
  return {
    activity: state === 'running' ? activityLine(t?.lastMessage) : null, slotWait: null,
    spans: jobSpans({ ...j, mergedAt: j.mergedAt ?? p?.mergedAt, reviewAt: j.reviewAt ?? p?.createdAt ?? (p ? j.endedAt : undefined) }, state, now),
    threadId: j.threadId ?? null, threadUrl: t3ThreadUrl(j.threadId),
    ...(j.after ? { afterTitle: j.afterTitle } : {}),
    id: j.id, state, ...(t?.t3Status ? { t3Status: t.t3Status, t3Label: t3Label(t.t3Status) } : {}), title: j.title, project: j.project, branch: t?.branch ?? j.branch ?? null,
    agent: j.agent, where: j.where, model: modelLabel(t?.model ?? j.model, j.effort) ?? null,
    createdAt: j.createdAt, startedAt: j.startedAt ?? null, endedAt,
    tokensUsed: t?.tokensUsed ?? j.tokensUsed ?? 0, tokenBudget: j.tokenBudget,
    now: launchFailed ? `Launch failed: ${j.launchError}` : state === 'failed' && stale ? 'Failed to start: no live T3 thread. Check T3 before retrying.' : state === 'failed' ? t?.lastMessage ?? 'The thread stopped on an error.' : state === 'waiting' ? waiting! : state === 'done' && j.pendingPr ? `Review pending GitHub${j.pendingPr.error ? ': ' + j.pendingPr.error : ''}` : state === 'running' ? t?.now ?? 'Working' : state === 'queued' ? j.after ? `After ${j.afterTitle}` : j.reserveHeld ? 'Waiting for plan reset' : 'Starting' : null,
    question, council: p ? parseCouncil(p.body) : [], steps: j.steps,
    // A merged PR's preview is history; the card shows it merged, not its diff.
    pr: p && state !== 'merged' ? p.pr : null,
    ...(cost ? { cost } : {}),
  }
}

const dayStart = (now: number) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime() }

/** Newest first; "today" is the machine's local day. */
export function wireJobs(jobs: WireJob[], now = Date.now()): WireJobs {
  const today = dayStart(now)
  const touchedToday = jobs.filter(j => Date.parse(j.createdAt) >= today || !j.endedAt || Date.parse(j.endedAt) >= today)
  return {
    mac: null,
    github: { reachable: true },
    usage: {
      jobsToday: jobs.filter(j => Date.parse(j.createdAt) >= today).length,
      tokensToday: touchedToday.reduce((n, j) => n + j.tokensUsed, 0),
      tokenBudget: DAILY_TOKEN_BUDGET,
    },
    jobs: [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }
}

// ---------------------------------------------------------------------------
// Runtime: the sources, the actions, the routes, the live push
// ---------------------------------------------------------------------------

export type T3Project = { id: string; name: string; root: string; model?: string }
export type LaunchInput = { projectId: string; title: string; brief: string; branch: string; baseRef?: string; model?: string; effort?: Effort }

/** T3 message.dispatch accepts inline image uploads. */
export type PhotoAttachment = { type: 'image'; name: string; mimeType: string; sizeBytes: number; dataUrl: string }

/** What Otto needs from T3 Code. t3.ts is the real one; the tests pass a fake. */
export type T3 = {
  transcriptRead?: TranscriptSource['transcriptRead']
  transcriptItem?: TranscriptSource['transcriptItem']
  projects(): Promise<T3Project[]>
  /** Snapshots for these threads; one T3 doesn't know comes back `gone`. */
  threads(ids: string[]): Promise<Map<string, ThreadSnap>>
  launch(o: LaunchInput): Promise<{ threadId: string; branch?: string; model?: string; worktreePath?: string }>
  /** Moves a project's folder: its next worktrees come from `root`. */
  repoint(projectId: string, root: string): Promise<void>
  /** A message into the thread: queued behind a running turn, or starts the next one. */
  send(threadId: string, text: string, attachments?: PhotoAttachment[]): Promise<void>
  /** Answers the thread's open question, if it has one T3 tracks as a request. False: it had none. */
  answer(threadId: string, text: string, attachments?: PhotoAttachment[]): Promise<boolean>
  interrupt(threadId: string): Promise<void>
}

export type StartInput = {
  after?: string
  origin?: Origin
  pipId?: string
  project: string; title: string; brief: string; branch?: string; baseRef?: string; model?: string; effort?: Effort; tokenBudget?: number; note?: string; override_low_limit?: boolean
  /** owner/name the work targets, when the caller knows it. */
  repo?: string
  /** The folder the work happens in; its git remote names the repo. */
  path?: string
}

/** iCloud (and other file-provider) folders, unless a `.nosync` folder on the way opts out: git can't write there reliably. */
export function inICloud(dir: string, home = homedir()): boolean {
  let real = dir
  try { real = realpathSync(dir) } catch {}
  if (real.split('/').some(s => s.endsWith('.nosync'))) return false
  return icloudRoots(home).some(r => real === r || real.startsWith(r + '/'))
}

const FETCH_MS = 30_000

/** Runs commands on the T3 machine over ssh; a cwd becomes `git -C`, since only git runs inside a T3 folder. */
export function overSsh(exec: Exec, host: string): Exec {
  return (cmd, cwd, timeoutMs) => exec(sshCmd(host, cwd ? ['git', '-C', cwd, ...cmd.slice(1)] : cmd), undefined, timeoutMs)
}

/** Whether a path exists on the T3 machine: this disk, or `test -e` over ssh. */
const exists = async (p: string, exec: Exec, remote: boolean) => remote ? await exec(['test', '-e', p], undefined, 10_000) !== undefined : existsSync(p)

/**
 * The folder a job's worktree can safely come from, checked before T3 is asked: T3 would
 * otherwise sit in "Preparing" or fail minutes in. An iCloud checkout gets a plain clone
 * under ~/.otto/build instead; anything else wrong is refused in one line.
 */
export async function preflight(root: string, base: string, exec: Exec, home = homedir(), remote = false): Promise<string> {
  let dir = root
  const url = await exec(['git', 'remote', 'get-url', 'origin'], root, 10_000)
  if (inICloud(root, home)) {
    if (!url) throw new Error(`${root} is in iCloud and has no origin to clone outside it`)
    dir = join(home, '.otto', 'build', `${basename(root)}-clone`)
    if (!await exists(join(dir, '.git'), exec, remote)) {
      if (await exec(['git', 'clone', '--quiet', url, dir], undefined, 300_000) === undefined) throw new Error(`${root} is in iCloud and cloning ${url} to ${dir} failed`)
    } else if (await exec(['git', 'remote', 'get-url', 'origin'], dir, 10_000) !== url) throw new Error(`${root} is in iCloud and ${dir} is a clone of something else`)
  }
  // No origin is a local-only repo: T3 skips the fetch for those too.
  if (url && await exec(['git', 'fetch', '--quiet', 'origin'], dir, FETCH_MS) === undefined) throw new Error(`git fetch in ${dir} failed or took over ${FETCH_MS / 1000}s`)
  // T3 also takes a local branch or a commit as the base, so only refuse when neither is there.
  for (const ref of [`refs/remotes/origin/${base}`, `${base}^{commit}`]) {
    if (await exec(['git', 'rev-parse', '--verify', '--quiet', ref], dir, 10_000) !== undefined) return dir
  }
  throw new Error(`base branch "${base}" isn't in ${dir} or on its origin`)
}

const PR_TTL_MS = 5 * 60_000
const PR_MISS_MS = [1, 2, 5, 15, 30].map(n => n * 60_000)

export class CodeJobs {
  private transcripts = new Transcripts({ transcriptRead: (id, version, lazy) => {
    if (!this.o.t3.transcriptRead) throw new Error('T3 transcript API unavailable')
    return this.o.t3.transcriptRead(id, version, lazy)
  } }, () => this.now())
  private github: Github
  private gh: Exec = (...args) => this.github.run(...args)
  private details: PrDetails
  private prs = new Map<string, { at: number; info: PrInfo | undefined; misses: number }>()
  /** Thread id → the last token count read, written onto the job when it finishes. */
  private tokens = new Map<string, number>()
  private deferred = new Map<string, Promise<void>>()
  private statuses = new Map<string, ThreadSnap['status']>()
  private last = ''
  private latest: WireJobs | undefined

  constructor(private o: {
    slots?: () => ReturnType<typeof slotSnapshot>
    file?: string; t3: T3; exec?: Exec
    /** Hands a changed list to every open app socket. */
    push?: (payload: WireJobs) => void
    attention?: (jobs: WireJob[], records: CodeJob[]) => Promise<void>
    now?: () => number
    /** Where ~/.otto/build and the iCloud folders are; the tests' fake home. */
    home?: string
    /** ssh alias of the machine T3 runs on; defaults to OTTO_T3_HOST. */
    t3Host?: string
  }) {
    this.github = o.exec ? new Github(o.exec, () => this.now()) : github
    this.details = new PrDetails((...args) => this.gh(...args), () => this.now(), fetch, join(dirname(this.file), 'pr-details'))
  }

  private get file() { return this.o.file ?? CODE_JOBS_FILE }
  private get host() { return this.o.t3Host ?? t3Host() }
  /** Runs where T3's checkouts are: here, or over ssh when T3 is on another machine. */
  private get exec(): Exec { const e = this.o.exec ?? run; return this.host ? overSsh(e, this.host) : e }
  private now() { return this.o.now?.() ?? Date.now() }

  list(): CodeJob[] { return loadCodeJobs(this.file) }
  projects(): Promise<T3Project[]> { return this.o.t3.projects() }

  /**
   * The repo and PR a job really targets. The repo read at start comes from the T3 project's
   * folder, which can be a different repo than the one the agent worked in (or none), so the
   * checkout is read again until its own PR pins it. Linked PRs are checked separately.
   */
  private async target(j: CodeJob, t: ThreadSnap | undefined): Promise<{ repo?: string; n?: number }> {
    if (j.prNumber && j.repo) return { repo: j.repo }
    // Re-read each time: the agent may add or change a remote while it works.
    const dir = j.repoGiven ? undefined : j.path ?? t?.worktreePath
    const repo = (dir && await this.remoteRepo(dir)) || j.repo
    if (repo || !j.branch) return { repo }
    const out = await this.gh(['gh', 'search', 'prs', '--head', j.branch, '--author', '@me', '--state', 'open', '--json', 'repository,number'], undefined, 15_000)
    let hits: { repository?: { nameWithOwner?: string }; number?: number }[] = []
    try { hits = out ? JSON.parse(out) : [] } catch {}
    const repos = new Set(hits.map(h => h.repository?.nameWithOwner).filter(Boolean))
    // ponytail: only a lone repo counts; two repos with an open PR on the same branch name stay unknown.
    return repos.size === 1 ? { repo: [...repos][0]!, ...(hits.length === 1 ? { n: hits[0]!.number } : {}) } : {}
  }

  /** owner/name from a checkout's remotes; undefined when it's gone or has no GitHub remote. */
  private async remoteRepo(dir: string): Promise<string | undefined> {
    if (!await exists(join(dir, '.git'), this.exec, !!this.host)) return undefined // a worktree folder can outlive its .git
    return repoFromRemotes(await this.exec(['git', 'remote', '-v'], dir, 10_000))
  }

  /** A linked or mentioned PR is evidence only after its ownership is checked. */
  private ownsPr(j: CodeJob, t: ThreadSnap | undefined, info: PrInfo): boolean {
    if (!info.headBranch) return false
    const sameRepo = (repo: string | undefined) => repo?.toLowerCase() === info.repo.toLowerCase()
    // Continuations can share the original branch; it is still their own PR.
    if ([j.branch, t?.branch].includes(info.headBranch)) return true
    // Another job's branch wins over a foreign T3 link claiming creation here.
    if (this.list().some(other => other.id !== j.id && (!other.repo || sameRepo(other.repo)) && other.branch === info.headBranch)) return false
    return !!(j.prOpenedByThread && j.prNumber === info.pr.n && sameRepo(j.repo))
      || (t?.prs ?? (t?.pr ? [t.pr] : [])).some(link => link.openedByThread && link.n === info.pr.n && sameRepo(link.repo))
  }

  private async pr(j: CodeJob, fresh = false, t?: ThreadSnap): Promise<PrInfo | undefined> {
    if (!j.prNumber && !j.branch && !t?.pr && !t?.prs?.length && !t?.lastMessage) return undefined
    // A merged PR the job recorded stays as recorded (a closed one can reopen); after each restart every one was read again.
    const hit = this.prs.get(j.id) ?? (j.prInfo?.state === 'MERGED' && j.prInfo.pr.n === j.prNumber ? { at: this.now(), info: j.prInfo, misses: 0 } : undefined)
    const previous = hit?.info ?? j.prInfo
    const endedAt = (t?.status === 'idle' || t?.status === 'gone' ? t.updatedAt : undefined) ?? j.endedAt
    if (!previous && !j.prNumber && t?.status !== 'running' && endedAt && this.now() - Date.parse(endedAt) >= 24 * 3_600_000) return undefined
    if (!fresh && hit && !hit.info && this.now() - hit.at < PR_MISS_MS[Math.min(hit.misses - 1, PR_MISS_MS.length - 1)]!) return undefined
    let info: PrInfo | undefined
    if (hit && !fresh && (hit.info && hit.info.state !== 'OPEN' && this.github.status.reachable || !!hit.info && this.now() - hit.at < PR_TTL_MS)
      && (!hit.info || this.ownsPr(j, t, hit.info))) {
      info = hit.info
    } else {
      const target = await this.target(j, t).catch(() => ({ repo: j.repo, n: undefined }))
      const candidates = [
        ...(j.prNumber && j.repo ? [{ repo: j.repo, n: j.prNumber }] : []),
        ...(t?.prs ?? (t?.pr ? [t.pr] : [])),
        prFromText(t?.lastMessage),
        ...(target.repo && target.n ? [{ repo: target.repo, n: target.n }] : []),
      ].filter((ref): ref is { repo: string; n: number } => !!ref)
      let rejectedPinned = false
      const seen = new Set<string>()
      for (const ref of candidates) {
        const key = `${ref.repo.toLowerCase()}#${ref.n}`
        if (seen.has(key)) continue
        seen.add(key)
        const candidate = await readPr(ref.repo, ref, this.gh, previous).catch(() => undefined)
        if (candidate && this.ownsPr(j, t, candidate)) { info = candidate; break }
        if (candidate && ref.n === j.prNumber && ref.repo === j.repo) rejectedPinned = true
        if (!this.github.status.reachable) break
      }
      // Rejected links must not prevent discovering the job's own branch PR.
      if (!info && target.repo && this.github.status.reachable) {
        for (const branch of new Set([t?.branch, j.branch].filter((b): b is string => !!b))) {
          const candidate = await readPr(target.repo, { branch }, this.gh, previous).catch(() => undefined)
          if (candidate && this.ownsPr(j, t, candidate)) { info = candidate; break }
          if (!this.github.status.reachable) break
        }
      }
      // A PR this job already had doesn't vanish: an empty answer is a failed lookup (GitHub down),
      // so keep the last one rather than flip the job to done and back to review on every poll.
      if (!info && !rejectedPinned && previous && previous.pr.n === j.prNumber) info = previous
      this.prs.set(j.id, { at: this.now(), info, misses: info ? 0 : fresh ? 1 : (hit?.misses ?? 0) + 1 })
      if (!info && rejectedPinned) updateCodeJob(this.file, j.id, x => ({ ...x, prNumber: undefined, prInfo: undefined, prOpenedByThread: undefined }))
      const repo = info?.repo ?? target.repo
      if (repo && repo !== j.repo) updateCodeJob(this.file, j.id, x => ({ ...x, repo }))
    }
    if (info && (j.prNumber !== info.pr.n || j.repo !== info.repo)) {
      const openedByThread = (t?.prs ?? (t?.pr ? [t.pr] : [])).some(link => link.openedByThread && link.n === info.pr.n && link.repo.toLowerCase() === info.repo.toLowerCase())
      // Against the stored job, not this read's copy: overlapping reads each saw no PR yet (#57 was recorded 15 times).
      updateCodeJob(this.file, j.id, x => {
        const y = { ...x, repo: info.repo, prNumber: info.pr.n, prOpenedByThread: openedByThread }
        return x.prNumber === info.pr.n ? y : addStep(y, `Opened PR #${info.pr.n}`, info.pr.checks)
      })
    }
    // PR closure alone cannot finish a thread that is still taking a turn.
    if (this.github.status.reachable && t?.status !== 'running' && !t?.activeTurn) {
      if (info?.state === 'MERGED' && !j.mergedAt) {
        const at = info.mergedAt ?? new Date(this.now()).toISOString()
        updateCodeJob(this.file, j.id, x => x.mergedAt ? x : addStep({ ...x, ...this.finish(x, at), mergedAt: at, endedAt: at }, `Merged PR #${info.pr.n}`, 'on GitHub', Date.parse(at)))
      } else if (info?.state === 'CLOSED' && !j.stoppedAt && !j.mergedAt) {
        updateCodeJob(this.file, j.id, x => x.stoppedAt || x.mergedAt ? x : addStep({ ...x, ...this.finish(x), stoppedAt: new Date(this.now()).toISOString() }, `PR #${info.pr.n} closed`, 'on GitHub'))
      }
    }
    if (info && this.github.status.reachable && JSON.stringify(j.prInfo) !== JSON.stringify(info)) {
      updateCodeJob(this.file, j.id, x => ({ ...x, prInfo: info }))
    }
    return info
  }

  /** A merged job remains readable even before its full detail has ever been fetched. */
  private terminalFallback(job: CodeJob, info?: PrInfo) {
    const n = info?.pr.n ?? job.prNumber
    return { head: {
      number: n, title: info?.pr.title ?? job.title,
      url: info?.pr.url ?? (job.repo ? `https://github.com/${job.repo}/pull/${n}` : ''),
      state: job.mergedAt ? 'MERGED' : info?.state ?? 'MERGED', mergedAt: job.mergedAt ?? info?.mergedAt ?? null,
      body: info?.body ?? '', additions: info?.pr.add ?? 0, deletions: info?.pr.del ?? 0,
      changedFiles: info?.pr.files ?? 0,
    }, stale: true }
  }

  /**
   * Every job as the app draws it, read fresh from T3 and GitHub. Plain reads (the app, the poll,
   * code_jobs) share the one in flight unless a write came after it started: overlapping reads each
   * re-ran T3 and gh, spent GitHub's hourly budget and recorded the same step over and over.
   */
  snapshot(o: { fresh?: string } = {}): Promise<WireJobs> {
    if (o.fresh) return this.read(o)
    if (this.reading?.gen !== this.gen) {
      const r = { gen: this.gen, at: this.read({}).finally(() => { if (this.reading === r) this.reading = undefined }) }
      this.reading = r
    }
    return this.reading.at
  }
  private reading?: { gen: number; at: Promise<WireJobs> }
  private threadsSeen = new Map<string, ThreadSnap>()
  /** Bumped on a write a reader must see; a read started before it isn't shared after it. */
  private gen = 0

  private async read(o: { fresh?: string }): Promise<WireJobs> {
    await this.github.refresh()
    const all = this.list()
    const jobs = pruneCodeJobs(all, this.now())
    if (jobs.length < all.length) saveCodeJobs(this.file, jobs)
    const autoFinished = (j: CodeJob) => {
      const last = j.steps.findLast(s => /^(?:Merged PR #|PR #\d+ closed$|Stopped$)/.test(s.text))
      return last?.note === 'on GitHub' && (!j.stoppedAt || /^PR #\d+ closed$/.test(last.text))
    }
    const done = (j: CodeJob) => !!(j.mergedAt || j.stoppedAt) && !autoFinished(j)
    // Merges are final; stopped threads are still read so a newer run can reopen them.
    // A failed T3 read (the tunnel to the Mac blinking) keeps the last threads seen: an empty map flipped
    // every job to its no-T3 state and back, and each flip back raised its attention event again.
    let threadsRead = false
    const threads = await this.o.t3.threads(jobs.flatMap(j => (j.threadId && (!done(j) || j.stoppedAt) ? [j.threadId] : []))).then(m => { threadsRead = true; return this.threadsSeen = m }).catch(() => this.threadsSeen)
    for (const j of jobs) {
      const t = j.threadId ? threads.get(j.threadId) : undefined
      if (j.stoppedAt && !j.mergedAt && Date.parse(t?.runRequestedAt ?? '') > Date.parse(j.stoppedAt)) {
        updateCodeJob(this.file, j.id, x => ({ ...x, stoppedAt: undefined, endedAt: undefined, weekShare: undefined }))
        j.stoppedAt = undefined
        j.endedAt = undefined
        this.prs.delete(j.id)
      }
    }
    // A turn that just ended is when a PR appears: re-read it then instead of waiting out the cache.
    const changed = new Set<string>()
    for (const [id, t] of threads) {
      if (t.tokensUsed) this.tokens.set(id, t.tokensUsed)
      if (this.statuses.get(id) !== t.status) changed.add(id)
      this.statuses.set(id, t.status)
    }
    const slots = await (this.o.slots?.() ?? slotSnapshot(dirname(this.file))).catch(() => null)
    const wire = await Promise.all(jobs.map(async j => {
      if (!j.threadId) return wireJob(j, undefined, undefined, this.now())
      const t = !done(j) ? threads.get(j.threadId) ?? (threadsRead ? { id: j.threadId, status: 'gone' as const } : undefined) : undefined
      if (t?.status === 'running' && j.endedAt && !done(j)) {
        updateCodeJob(this.file, j.id, x => ({ ...x, endedAt: undefined }))
        j.endedAt = undefined
      }
      // A merge is final: a thread seen for the first time since boot is no reason to read its PR again.
      const p = done(j) && !j.prNumber ? undefined : await this.pr(j, o.fresh === j.id || (changed.has(j.threadId ?? '') && !j.mergedAt), t)
      if (!p && !done(j) && this.list().some(x => x.id === j.id)) await this.deferPr(j, t)
      else if (p && this.list().find(x => x.id === j.id)?.pendingPr) updateCodeJob(this.file, j.id, x => ({ ...x, pendingPr: undefined }))
      // Revalidate old PR-derived completion too: #42 could pin another job's PR.
      if ((j.mergedAt || j.stoppedAt) && autoFinished(j) && ((!p && !this.list().find(x => x.id === j.id)?.prNumber) || t?.status === 'running' || t?.activeTurn)) {
        updateCodeJob(this.file, j.id, x => ({ ...x, mergedAt: undefined, stoppedAt: undefined, endedAt: undefined, weekShare: undefined }))
      }
      // pr() may have just found it merged or closed on GitHub.
      const now = this.list().find(x => x.id === j.id) ?? j
      // A failed GitHub lookup keeps the last known PR facts rather than changing the job's state.
      const matched = slots ? jobWaiters(slots.waiters, t?.worktreePath ?? now.worktreePath) : []
      const waits = new Map((now.slotWaits ?? []).map(w => [w.token, w]))
      for (const w of matched) waits.set(w.token, w)
      const slotWaits = [...waits.values()]
      const reviewAt = now.reviewAt ?? p?.createdAt
      if (JSON.stringify(slotWaits) !== JSON.stringify(now.slotWaits ?? []) || reviewAt !== now.reviewAt) {
        updateCodeJob(this.file, j.id, x => ({ ...x, slotWaits, reviewAt }))
      }
      now.slotWaits = slotWaits
      now.reviewAt = reviewAt
      const result = wireJob(now, done(now) ? undefined : t, p ?? (this.github.status.reachable ? undefined : now.prInfo), this.now())
      if (!result.endedAt && ['done', 'review', 'failed', 'stopped'].includes(result.state)) result.endedAt = new Date(this.now()).toISOString()
      if (result.endedAt && !now.endedAt) updateCodeJob(this.file, j.id, x => ({ ...x, endedAt: result.endedAt! }))
      result.spans = jobSpans({ ...now, endedAt: result.endedAt }, result.state, this.now())
      result.slotWait = slots ? currentSlotWait(matched, slots.waiters, slots.mac) : null
      return result
    }))
    if (!this.github.status.reachable) for (const j of wire) if (j.pr) j.prStale = true
    // A read can overlap an app edit while awaiting T3 or GitHub. Never publish the old display fields or a deleted job.
    const current = new Map(this.list().map(j => [j.id, j]))
    const visible = wire.flatMap(j => {
      const stored = current.get(j.id)
      return stored ? [{ ...j, title: stored.title, project: stored.project }] : []
    })
    this.latest = { ...wireJobs(visible, this.now()), mac: slots?.mac ?? null, github: { ...this.github.status } }
    return this.latest
  }

  private async deferPr(j: CodeJob, t: ThreadSnap | undefined): Promise<void> {
    if (this.deferred.has(j.id)) return this.deferred.get(j.id)
    const work = this.finishDeferredPr(j, t).finally(() => this.deferred.delete(j.id))
    this.deferred.set(j.id, work)
    return work
  }

  private async finishDeferredPr(j: CodeJob, t: ThreadSnap | undefined): Promise<void> {
    j = this.need(j.id)
    if (j.prNumber || j.stoppedAt || j.mergedAt || t?.activeTurn || t?.status === 'running' || t?.status === 'input' || t?.question) return
    const dir = t?.worktreePath ?? j.worktreePath ?? j.path
    const draft = dir && join(dir, 'PR.md')
    if (!j.pendingPr) {
      // Only a job that asked for a PR (PR.md, per its brief) and ended in the last day; old or PR-less branches are left alone.
      const ended = (t?.status === 'idle' || t?.status === 'error' || t?.status === 'gone' ? t.updatedAt : undefined) ?? j.endedAt
      if (!t || !['idle', 'error', 'gone'].includes(t.status) || !draft
        || (ended && this.now() - Date.parse(ended) >= 24 * 3_600_000)) return
      const raw = this.host ? await this.exec(['cat', draft], undefined, 10_000) : existsSync(draft) ? readFileSync(draft, 'utf8') : undefined
      if (raw === undefined) return
      const text = raw.trim()
      const [title, ...body] = text.split('\n')
      const bodyPath = join(dirname(this.file), 'pending-prs', `${j.id}.md`)
      mkdirSync(dirname(bodyPath), { recursive: true })
      writeFileSync(bodyPath, text ? body.join('\n').trim() : t.lastMessage || j.brief)
      j = updateCodeJob(this.file, j.id, x => addStep({ ...x,
        worktreePath: dir, branch: t.branch ?? x.branch,
        pendingPr: { title: title || x.title, bodyPath, branch: t.branch ?? x.branch ?? '', base: x.base ?? 'main' },
      }, 'Review pending GitHub'))!
    }
    const pending = j.pendingPr!
    try {
      if (!pending.branch || !j.repo) throw new Error('Branch or GitHub repository is unknown')
      // Git transport still works when api.github.com is down.
      if (!dir) throw new Error('Worktree is unavailable; cannot check or push the branch')
      const remote = await this.exec(['git', 'ls-remote', '--heads', 'origin', `refs/heads/${pending.branch}`], dir, 15_000)
      if (remote === undefined) throw new Error('Could not check the remote branch')
      if (!remote.trim()) {
        const pushed = await this.exec(['git', 'push', '-u', 'origin', `refs/heads/${pending.branch}:refs/heads/${pending.branch}`], dir, 60_000)
        if (pushed === undefined) throw new Error('Could not push the branch')
      }
      if (!this.github.status.reachable) return
      const out = await this.gh(['gh', 'pr', 'list', '--repo', j.repo, '--head', pending.branch, '--state', 'all', '--json', 'number'], dir, 15_000)
      const found = JSON.parse(out!)
      if (!Array.isArray(found)) throw new Error('Could not read PRs for the head branch')
      let number = found[0]?.number
      if (!number) {
        const created = await this.gh(['gh', 'pr', 'create', '--repo', j.repo, '--head', pending.branch, '--base', pending.base, '--title', pending.title, '--body-file', pending.bodyPath], dir, 30_000)
        number = Number(created?.trim().match(/\/pull\/(\d+)$/)?.[1])
        if (!number) throw new Error('PR creation returned no PR number; will look up the head again')
      }
      // Keep waiting until pr() reads metadata; a created PR is never a done-without-PR event.
      updateCodeJob(this.file, j.id, x => x.prNumber === number ? x : addStep({ ...x, prNumber: number }, `Opened PR #${number}`, 'deferred PR'))
      this.prs.delete(j.id)
    } catch (e) {
      updateCodeJob(this.file, j.id, x => ({ ...x, pendingPr: { ...pending, error: e instanceof Error ? e.message : String(e) } }))
    }
  }

  /** Re-read and push to the app if anything changed. The server calls it on a timer even without an app socket. */
  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try { await this.pollOnce() } finally { this.polling = false }
  }
  private polling = false
  private async pollOnce(): Promise<void> {
    let w = await this.snapshot()
    let changed = false
    for (const j of this.list()) {
      if (j.threadId || j.stoppedAt || j.launchClaimedAt || j.afterBlockedAt) continue
      if (!j.after) {
        if (j.reserveHeld) { await this.launch(j).catch(() => {}); changed = true }
        continue
      }
      const predecessor = this.list().find(x => x.id === j.after)
      if (predecessor?.stoppedAt || predecessor?.prInfo?.state === 'CLOSED') {
        updateCodeJob(this.file, j.id, x => ({ ...x, afterBlockedAt: new Date(this.now()).toISOString() }))
      } else if (predecessor?.mergedAt) {
        await this.launch(j).catch(() => {}) // The durable launch error is raised through JobEvents.
        changed = true
      }
    }
    if (changed) w = await this.snapshot()
    // An outage blinds only PR states: a question, a failure or a finish without a PR still has to
    // reach the session (on 10 Nov a finished job sat unnoticed for hours behind a GitHub outage).
    const seen = w.github.reachable ? w.jobs : w.jobs.filter(j => !j.pr)
    if (w.github.reachable || seen.length) await this.o.attention?.(seen, this.list())
    const s = JSON.stringify(w)
    if (s === this.last) return
    this.last = s
    this.o.push?.(w)
  }

  /** The last list read, for a socket that just opened. */
  cached(): WireJobs | undefined { return this.latest }

  private async one(id: string, fresh = false): Promise<WireJob | undefined> {
    this.gen++
    const w = await this.snapshot(fresh ? { fresh: id } : {})
    this.last = JSON.stringify(w)
    this.o.push?.(w)
    return w.jobs.find(j => j.id === id)
  }

  /** Start a T3 thread on a new worktree branch and record it as a job. */
  async start(input: StartInput): Promise<WireJob & { existing?: true }> {
    const title = input.title.trim().slice(0, 120), brief = input.brief.trim()
    if (!title || !brief) throw new Error('title and brief are required')
    const predecessor = input.after ? this.list().find(j => j.id === input.after) : undefined
    if (input.after !== undefined && !predecessor) throw new Error(`unknown predecessor job "${input.after}"`)
    if (input.origin === 'external-content') throw new Error('cannot start a coding job from external content')
    const projects = await this.o.t3.projects()
    const p = projects.find(x => x.id === input.project) ?? projects.find(x => x.name.toLowerCase() === input.project.trim().toLowerCase())
    if (!p) throw new Error(`no T3 project "${input.project}" — known: ${projects.map(x => x.name).join(', ') || 'none'}`)
    // A reload that cut off the reply left the session told to "try again" with the job already made:
    // the same ask again soon after is that job, never a second thread.
    const requestKey = createHash('sha256').update(JSON.stringify([p.id, title, brief, input.after, input.branch?.trim(), input.baseRef, input.model?.trim(), input.effort, input.repo?.trim(), input.path?.trim(), input.pipId])).digest('hex').slice(0, 16)
    // The newest: an older one may have failed and been asked for again already.
    const same = this.list().findLast(j => j.requestKey === requestKey && !j.stoppedAt && !j.mergedAt && (!j.launchError || j.launchUncertain)
      && this.now() - Date.parse(j.createdAt) < SAME_REQUEST_MS)
    if (same?.launchClaimedAt && !same.threadId) throw new Error(`job [${same.id}] for this same request may already have a T3 Code thread (its launch never confirmed); check T3 for branch ${same.branch} before starting it again, or change the title to start a separate job`)
    if (same) {
      // Read now, not from the last poll (none yet after a boot): a job that failed, stopped or finished is fair to
      // ask for again. "Done" in its first minute may be a thread T3 hasn't started running yet.
      const w = (await this.one(same.id))!
      const over = ['failed', 'stopped', 'merged'].includes(w.state) || (w.state === 'done' && this.now() - Date.parse(same.startedAt ?? same.createdAt) > 60_000)
      if (!over) return { ...w, existing: true }
    }
    const given = input.repo?.trim()
    if (given && !REPO_RE.test(given)) throw new Error(`repo must be owner/name, not "${given}"`)
    const path = input.path?.trim()
    if (path && !isAbsolute(path)) throw new Error(`path must be absolute, not "${path}"`)
    let model = input.model?.trim()
    let effort = input.effort
    const ui = isUIWork(`${title}\n${brief}`)
    if ((!model || !effort) && routerConfig(dirname(this.file)).jobs === true) {
      const routed = await route(brief, 'job', dirname(this.file))
      model ||= routed.model
      effort ??= routed.effort
    }
    const plan = readPlanUsage(dirname(this.file))
    const pace = paceConfig(dirname(this.file)), week = plan?.seven_day, now = this.now()
    let paceNote: string | undefined
    // Pace: days 0-2 after the weekly reset run no Fable and no hillclimb; day 3 allows one Opus hillclimb while the
    // week is under `byDay3`. An explicit model still wins, except Fable or a hillclimb on those days.
    // ponytail: picked at start(), so a job queued with `after` keeps the pick from when it was queued.
    if (pace && week && week.resets_at * 1000 > now) {
      const DAY = 86_400_000, from = week.resets_at * 1000 - PLAN_WINDOWS.seven_day.lengthMs
      const day = Math.floor((now - from) / DAY), hill = /hillclimb/i.test(title), fable = /fable/i.test(input.model ?? '')
      const wd = (t: number) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short' })
      const days = `${wd(from)}–${wd(from + 2 * DAY)}`
      const refuse = (why: string) => { if (!input.override_low_limit || input.pipId) throw new Error(`pace: ${why}; pass override_low_limit: true to launch anyway.`) }
      if (day < 3) {
        if (hill) refuse(`no hillclimb ${days}`)
        else if (fable) refuse(`no Fable ${days}`)
        if (!input.model?.trim()) {
          if (ui) { model = 'claude-opus-5-5'; effort = input.effort ?? 'high'; paceNote = `pace: no Fable ${days} → Opus ${effort}` }
          else { model = DEFAULT_GPT_MODEL; paceNote = `pace: ${days} non-UI → ${modelLabel(model)}` }
        }
      } else if (day === 3 && hill) {
        const used = liveWindows(plan, now).includes('seven_day') ? week.used_percentage : NaN
        if (!(used < pace.byDay3)) refuse(Number.isNaN(used) ? 'no fresh weekly reading for a day-3 hillclimb' : `the week is at ${Math.round(used)}%, a day-3 hillclimb needs under ${pace.byDay3}%`)
        else if (this.list().some(j => /hillclimb/i.test(j.title) && Date.parse(j.createdAt) >= from + 3 * DAY && !j.launchError)) refuse('day 3 already had its one hillclimb')
        else if (fable) refuse('a day-3 hillclimb runs on Opus, not Fable')
        if (!input.model?.trim()) { model = 'claude-opus-5-5'; paceNote = `pace: day-3 hillclimb under ${pace.byDay3}% → Opus` }
      }
    }
    const left = liveWindows(plan, now).includes('seven_day') ? 100 - plan!.seven_day!.used_percentage : NaN
    if (left < 25) {
      if (!input.model?.trim() && !ui) model = DEFAULT_GPT_MODEL
      else if ((model ? /claude|opus|fable|sonnet|haiku/i.test(model) : ui) && (!input.override_low_limit || !!input.pipId)) {
        throw new Error(`Claude has ${+left.toFixed(1)}% of its weekly window left; pass override_low_limit: true to launch anyway.`)
      }
    }
    if (ui && model && /gpt|codex/i.test(model)) throw new Error('UI/design work must use Claude, never GPT; choose a Claude model.')
    if (ui && !model) model = 'claude-fable-5-2'
    const id = newJobId()
    const branch = input.branch?.trim() || `otto/${slug(title)}-${id.slice(1)}`
    const at = this.now()
    // The project's folder last: it can sit in a different repo than the one the work lands in.
    let repo = given
    for (const dir of [path, p.root]) if (!repo && dir) repo = await this.remoteRepo(dir)
    const jobBrief = `${brief}

Testing: when the repo has test:changed, run bun run test:changed from its package directory while iterating, without a build slot. Before opening the PR, run the full suite once through bun ${process.env.OTTO_HOME ?? join(homedir(), '.otto')}/otto/slots.ts run --name ${id} -- <full-test-command>. Release builds also use the slot. If GitHub's API is unavailable, commit, push the branch, write the PR title on the first line and body below it in PR.md at the worktree root, and stop without retrying gh pr create.`
    const job: CodeJob = {
      origin: input.origin, requestKey, ...(predecessor ? { after: predecessor.id, afterTitle: predecessor.title } : {}),
      pipId: input.pipId, id, title, brief: jobBrief, project: p.name, projectId: p.id, ...(repo ? { repo } : {}), ...(given ? { repoGiven: true } : {}), ...(path ? { path } : {}),
      branch, base: input.baseRef ?? 'main',
      agent: 'T3 Code', where: 'local', ...(model ?? p.model ? { model: model ?? p.model } : {}),
      ...(effort ? { effort } : {}),
      createdAt: new Date(at).toISOString(),
      tokenBudget: input.tokenBudget && input.tokenBudget > 0 ? Math.round(input.tokenBudget) : DEFAULT_JOB_TOKEN_BUDGET,
      steps: [step(predecessor ? 'Queued' : 'Handed off to T3 Code', [paceNote, input.note].filter(Boolean).join(' · ') || undefined, at)],
    }
    saveCodeJobs(this.file, [...this.list(), job])
    this.gen++
    if (!predecessor) await this.launch(job, p.root)
    return (await this.one(id))!
  }

  private async launch(job: CodeJob, knownRoot?: string): Promise<void> {
    const j = this.need(job.id)
    if (j.threadId || j.launchClaimedAt || j.stoppedAt) return
    if (new Overnight(dirname(this.file), () => this.now()).hold(`code:${j.id}`, j.model)) {
      if (!j.reserveHeld) updateCodeJob(this.file, j.id, x => ({ ...x, reserveHeld: true }))
      return
    }
    // Claim before the RPC: a restart after T3 accepts it must never launch a second thread.
    updateCodeJob(this.file, j.id, x => ({ ...x, launchClaimedAt: new Date(this.now()).toISOString() }))
    try {
      const root = knownRoot ?? (await this.o.t3.projects()).find(p => p.id === j.projectId)?.root
      // T3 elsewhere: its iCloud folders and ~/.otto/build hang off that machine's home, not this one's.
      const home = this.o.home ?? (this.host ? await this.exec(['printenv', 'HOME'], undefined, 10_000) : undefined)
      if (this.host && !home) throw new Error(`can't reach ${this.host} over ssh to check ${root ?? 'the project'}`)
      const dir = root && await preflight(root, j.base ?? 'main', this.exec, home, !!this.host)
      if (root && dir && dir !== root) {
        await this.o.t3.repoint(j.projectId!, dir)
        updateCodeJob(this.file, j.id, x => addStep(x, 'Moved the project out of iCloud', `${root} → ${dir}`))
      }
      const launched = await this.o.t3.launch({ projectId: j.projectId!, title: j.title, brief: j.brief,
        branch: j.branch!, baseRef: j.base ?? 'main', model: j.model, effort: j.effort })
      const repo = !j.repoGiven ? (j.path && await this.remoteRepo(j.path)) || (launched.worktreePath && await this.remoteRepo(launched.worktreePath)) || undefined : undefined
      const at = this.now()
      const weekStart = weekMark(readPlanUsage(dirname(this.file)), at)
      updateCodeJob(this.file, j.id, x => addStep({ ...x, ...launched, repo: repo ?? x.repo, ...(weekStart ? { weekStart } : {}),
        reserveHeld: undefined, after: undefined, afterTitle: undefined, startedAt: new Date(at).toISOString(),
      }, 'Created worktree', `${launched.branch ?? j.branch} from ${j.base ?? 'main'}`, at))
      this.gen++
    } catch (e) {
      let why = e instanceof Error ? e.message : String(e)
      // A launch that timed out or lost its socket isn't a refusal: T3 may have started the thread.
      const uncertain = /launchThread (?:timed out|lost its connection)/.test(why)
      if (uncertain) why += `; T3 may still have started it, so check T3 for branch ${j.branch} before trying again`
      updateCodeJob(this.file, j.id, x => ({ ...x, launchError: why, ...(uncertain ? { launchUncertain: true } : {}) }))
      throw new Error(`job [${j.id}] didn't launch: ${why}`)
    }
  }

  /** Squash-merge the job's PR, server-side. Only ever on the user's word. */
  async merge(id: string): Promise<WireJob> {
    const j = this.need(id)
    if (!j.repo) throw new JobError(409, 'this project has no GitHub repo to merge on')
    const info = await this.pr(j, true)
    if (!info) throw new JobError(409, 'no PR on this branch yet')
    if (info.state === 'MERGED') return (await this.one(id))!
    if (info.state !== 'OPEN') throw new JobError(409, `PR #${info.pr.n} is closed`)
    if (info.pr.mergeable === 'CONFLICTING') throw conflictError(info)
    if (info.pr.draft) throw new JobError(409, `PR #${info.pr.n} is still a draft`)
    const repo = this.need(id).repo! // pr() may have corrected the repository from the checkout.
    let failure: string | undefined
    let conflicts = false
    try {
      const exec: Exec = this.o.exec ?? ((cmd, cwd, timeout) => runChecked(cmd, cwd, timeout, { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }))
      const out = await exec(['gh', 'pr', 'merge', String(info.pr.n), '--repo', repo, '--squash'], undefined, 60_000)
      if (out === undefined) failure = 'gh exited unsuccessfully (no diagnostics provided)'
    } catch (err) {
      const stderr = err instanceof CommandError ? err.stderr : err instanceof Error ? err.message : String(err)
      conflicts = /not mergeable|conflicts?\b|conflicting/i.test(stderr)
      const detail = err instanceof CommandError
        ? `${err.timedOut ? 'timed out after 60000 ms; ' : ''}exit ${err.exitCode ?? 'unavailable'}: ${err.stderr.trim() || 'no stderr'}`
        : err instanceof Error ? err.message : String(err)
      failure = mergeDiagnostic(detail)
    }
    if (failure) {
      console.error(`[codejobs] merge ${repo}#${info.pr.n}: ${failure}`)
      // A timeout or lost response may follow a successful merge: check before failing.
      const after = await this.pr(j, true)
      if (after?.state !== 'MERGED') {
        if (conflicts) throw conflictError(after ?? info)
        throw new JobError(502, `gh could not merge PR #${info.pr.n}: ${failure}`)
      }
    }
    const at = this.now()
    updateCodeJob(this.file, id, x => addStep({ ...x, ...this.finish(x), prNumber: info.pr.n, mergedAt: new Date(at).toISOString(), endedAt: new Date(at).toISOString() }, `Merged PR #${info.pr.n}`, 'you, from the app', at))
    this.prs.delete(id)
    return (await this.one(id, true))!
  }

  /** The user's answer to what it asked: a pending T3 request if there is one, else a message. */
  async answer(id: string, text: string): Promise<WireJob> {
    const queued = this.need(id)
    if (queued.after && !queued.threadId && !queued.stoppedAt) {
      if (/^drop(?: it)?$/i.test(text.trim())) return this.stop(id)
      if (!/^start anyway$/i.test(text.trim()) || !queued.afterBlockedAt) throw new JobError(409, 'this job is waiting for its predecessor')
      await this.launch(queued)
      return (await this.one(id))!
    }
    const j = this.live(id)
    const t = text.trim()
    if (!t) throw new JobError(400, 'text is required')
    if (!(await this.o.t3.answer(j.threadId!, t))) await this.o.t3.send(j.threadId!, t)
    updateCodeJob(this.file, id, x => addStep(x, 'You answered', t.slice(0, 80)))
    return (await this.one(id))!
  }

  /** A photo answers an open question, or steers the thread with its caption and image. */
  async answerPhoto(id: string, caption: string, path: string, messageId?: string): Promise<void> {
    const saved = this.need(id)
    if (messageId && saved.photoReplies?.includes(messageId)) return
    const j = this.live(id)
    const bytes = readFileSync(path)
    const attachments: PhotoAttachment[] = [{ type: 'image', name: basename(path), mimeType: 'image/jpeg', sizeBytes: bytes.length, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` }]
    const text = caption.trim() || '(photo)'
    const question = (await this.one(id))?.question
    const answered = await this.o.t3.answer(j.threadId!, text, attachments)
    if (!answered) await this.o.t3.send(j.threadId!, text, attachments)
    updateCodeJob(this.file, id, x => addStep({ ...x, ...(messageId ? { photoReplies: [...(x.photoReplies ?? []), messageId] } : {}) }, answered || question ? 'You answered it (photo)' : 'You steered it (photo)', text.slice(0, 80)))
    this.gen++
  }

  /** Answer a pending request first; otherwise queue a course correction behind the turn. */
  async steer(id: string, text: string): Promise<WireJob> {
    const j = this.live(id)
    const t = text.trim()
    if (!t) throw new JobError(400, 'text is required')
    const answered = await this.o.t3.answer(j.threadId!, t)
    if (!answered) await this.o.t3.send(j.threadId!, t)
    updateCodeJob(this.file, id, x => addStep(x, answered ? 'You answered it' : 'You steered it', t.slice(0, 80)))
    return (await this.one(id))!
  }

  /** Send conflict repair to the same thread, including when its review turn has ended. */
  async resolve(id: string): Promise<WireJob> {
    const j = this.live(id)
    const info = await this.pr(j, true)
    if (!info || info.state !== 'OPEN' || info.pr.mergeable !== 'CONFLICTING') {
      throw new JobError(409, 'the PR does not have merge conflicts')
    }
    const text = `Resolve the merge conflicts in PR #${info.pr.n} (${info.pr.url}) in ${info.repo}. ` +
      `Fetch origin and merge origin/${info.pr.base} into the PR branch ${info.headBranch}. ` +
      `Resolve the conflicts keeping the intent of both sides, run the project's tests, and push to the same branch. ` +
      `Do not merge the PR.`
    if (!(await this.o.t3.answer(j.threadId!, text))) await this.o.t3.send(j.threadId!, text)
    updateCodeJob(this.file, id, x => addStep({ ...x, ottoSent: [...(x.ottoSent ?? []), text].slice(-20) }, 'You asked it to resolve the conflicts'))
    return (await this.one(id))!
  }

  /** Interrupt the running turn and take the job off the board. The branch and thread stay. */
  async stop(id: string): Promise<WireJob> {
    const j = this.need(id)
    if (j.mergedAt) throw new JobError(409, 'already merged')
    if (!j.stoppedAt) {
      if (j.threadId) await this.o.t3.interrupt(j.threadId).catch(() => {})
      const at = this.now()
      updateCodeJob(this.file, id, x => addStep({ ...x, ...this.finish(x), stoppedAt: new Date(at).toISOString(), endedAt: new Date(at).toISOString() }, 'Stopped', 'you, from the app; the branch is kept', at))
    }
    return (await this.one(id))!
  }

  /** Rename Otto's job without changing its T3 thread or PR. */
  async rename(id: string, title: string): Promise<WireJob> {
    this.need(id)
    title = title.trim()
    if (!title || title.length > 200) throw new JobError(400, 'title must be between 1 and 200 characters')
    saveCodeJobs(this.file, this.list().map(j => j.id === id ? { ...j, title } : j.after === id ? { ...j, afterTitle: title } : j))
    return (await this.one(id))!
  }

  /** Regroup the job in the app; its original T3 project and checkout stay put. */
  async move(id: string, project: string): Promise<WireJob> {
    this.need(id)
    project = project.trim()
    if (!project) throw new JobError(400, 'project is required')
    updateCodeJob(this.file, id, j => ({ ...j, project }))
    return (await this.one(id))!
  }

  /** How long a delete waits for its stop. Tests shorten it. */
  stopWaitMs = 5000

  /** Forget the job, stopping unfinished work through the same path as the app's stop action. */
  async delete(id: string): Promise<{ ok: true }> {
    const j = this.need(id)
    // A job that already ended has nothing to stop, and a dead T3 thread can leave the interrupt hanging:
    // the delete goes through either way.
    if (!j.mergedAt && !j.stoppedAt && !j.endedAt) await Promise.race([this.stop(id).catch(() => {}), new Promise(r => setTimeout(r, this.stopWaitMs))])
    saveCodeJobs(this.file, this.list().filter(j => j.id !== id))
    this.prs.delete(id)
    await this.one(id)
    return { ok: true }
  }

  private spent(j: CodeJob): { tokensUsed?: number; weekShare?: number } {
    const n = (j.threadId && this.tokens.get(j.threadId)) || j.tokensUsed
    if (!n) return {}
    const share = provider(j.model) !== 'Claude' ? undefined
      : j.weekShare ?? weekShare(j.weekStart, weekMark(readPlanUsage(dirname(this.file)), this.now()))
    return { tokensUsed: n, ...(share ? { weekShare: share } : {}) }
  }

  /** Freezes what an ending job spent and logs it for the monthly rollup. */
  private finish(j: CodeJob, at = new Date(this.now()).toISOString()): { tokensUsed?: number; weekShare?: number } {
    const s = this.spent(j)
    if (s.tokensUsed) appendJobCost(dirname(this.file), { id: j.id, at, title: j.title, ...(j.model ? { model: j.model } : {}), tokens: s.tokensUsed, ...(s.weekShare ? { share: s.weekShare } : {}) })
    return s
  }

  /** The price tag of a job as it stands, for the merge message (which can beat the poll that freezes it). */
  cost(j: CodeJob): string | undefined {
    const s = this.spent(j)
    return priceTag(s.tokensUsed, j.model, s.weekShare)
  }

  private need(id: string): CodeJob {
    const j = this.list().find(x => x.id === id)
    if (!j) throw new JobError(404, 'no such job')
    return j
  }
  private live(id: string): CodeJob {
    const j = this.need(id)
    if (j.mergedAt || j.stoppedAt) throw new JobError(409, 'that job is finished')
    if (!j.threadId) throw new JobError(409, 'that job has no thread yet')
    return j
  }

  /**
   * GET /app/jobs, POST /app/jobs/{merge,resolve,answer,steer,stop,rename,move,delete}. The caller has already checked the
   * app token; anything else under /app/jobs is a 404.
   */
  async handle(req: Request, path: string): Promise<Response> {
    try {
      if (path === '/app/jobs/transcript' || path === '/app/jobs/transcript/item') {
        if (req.method !== 'GET') return new Response(null, { status: 405 })
        const q = new URL(req.url).searchParams
        const id = q.get('id')
        if (!id) throw new JobError(400, 'id is required')
        const job = this.list().find(j => j.id === id)
        if (!job) throw new JobError(404, 'Job not found')
        if (!job.threadId) throw new JobError(409, 'Job has no T3 thread')
        if (path.endsWith('/item')) {
          const item = q.get('item')
          const prefix = `item:${job.threadId}:`
          if (!item?.startsWith(prefix) || item.length === prefix.length) throw new JobError(400, 'Invalid item id')
          if (!this.o.t3.transcriptItem) throw new JobError(503, 'T3 item API unavailable')
          const full = await this.o.t3.transcriptItem(job.threadId, item.slice(prefix.length))
          const row = normalizeTranscript({ thread: { id: job.threadId }, turnItems: [full] })[0]
          if (!row || row.id !== item) throw new JobError(404, 'Item not found')
          return Response.json({ item: row })
        }
        const out = await this.transcripts.read(job.threadId, q.get('after'), q.get('lazy') === '1')
        return Response.json({ ...out, items: markOtto(out.items, [job.brief, ...(job.ottoSent ?? [])]) })
      }
      if (path === '/app/jobs/pr') {
        if (req.method !== 'GET') return new Response(null, { status: 405 })
        const id = new URL(req.url).searchParams.get('id')
        if (!id) throw new JobError(400, 'id is required')
        const job = this.list().find(j => j.id === id)
        if (!job) throw new JobError(404, 'Job not found')
        const known = this.prs.get(job.id)?.info ?? job.prInfo
        const repo = job.repo ?? known?.repo
        const n = job.prNumber ?? known?.pr.n
        if (repo && n) {
          const stored = this.details.stored(repo, n)
          if (stored) return Response.json(stored)
        }
        if (n && (job.mergedAt || known?.state === 'MERGED' || known?.state === 'CLOSED')) {
          const fallback = () => Response.json(this.terminalFallback(job, known))
          if (!repo || !this.github.status.reachable) return fallback()
          const detail = await this.details.read(repo, n)
          return detail.head?.number ? Response.json({ ...detail, ...(!this.github.status.reachable ? { stale: true } : {}) }) : fallback()
        }
        const threads = job.threadId ? await this.o.t3.threads([job.threadId]).catch(() => new Map<string, ThreadSnap>()) : new Map<string, ThreadSnap>()
        const info = await this.pr(job, false, job.threadId ? threads.get(job.threadId) : undefined)
        const unavailable = () => Response.json({ error: 'GitHub is unreachable', code: 'github_unreachable' }, { status: 503 })
        if (!this.github.status.reachable) {
          const cached = info && await this.details.cached(info.repo, info.pr.n)
          return cached ? Response.json({ ...cached, stale: true }) : unavailable()
        }
        if (!info) throw new JobError(404, 'Job has no owned PR')
        const detail = await this.details.read(info.repo, info.pr.n)
        if (!this.github.status.reachable) {
          const cached = await this.details.cached(info.repo, info.pr.n)
          return cached ? Response.json({ ...cached, stale: true }) : unavailable()
        }
        return Response.json(detail)
      }
      if (path === '/app/jobs') {
        if (req.method !== 'GET') return new Response(null, { status: 405 })
        return Response.json(await this.snapshot())
      }
      const action = /^\/app\/jobs\/(merge|resolve|answer|steer|stop|rename|move|delete)$/.exec(path)?.[1]
      if (!action) return new Response(null, { status: 404 })
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      const body = (await req.json().catch(() => ({}))) as { id?: unknown; text?: unknown; title?: unknown; project?: unknown }
      const id = typeof body.id === 'string' ? body.id : ''
      const text = typeof body.text === 'string' ? body.text.slice(0, 8000) : ''
      if (!id) return Response.json({ error: 'id is required' }, { status: 400 })
      const out = action === 'merge' ? await this.merge(id)
        : action === 'resolve' ? await this.resolve(id)
        : action === 'stop' ? await this.stop(id)
        : action === 'rename' ? await this.rename(id, typeof body.title === 'string' ? body.title : '')
        : action === 'move' ? await this.move(id, typeof body.project === 'string' ? body.project : '')
        : action === 'delete' ? await this.delete(id)
          : action === 'answer' ? await this.answer(id, text)
            : await this.steer(id, text)
      return Response.json(out)
    } catch (err) {
      const status = err instanceof JobError ? err.status : 502
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status })
    }
  }
}

/** Redact before truncation so neither the response nor the log can expose a partial token. */
function mergeDiagnostic(text: string): string {
  let safe = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/(\b(?:authorization\s*:\s*(?:bearer|token|basic)|(?:gh_token|github_token|token|access_token)\s*[=:])\s*)[^\s"'&]+/gi, '$1[redacted]')
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /token|secret|password|api_?key/i.test(key)) safe = safe.split(value).join('[redacted]')
  }
  return safe.trim().slice(0, 1200) || 'unknown gh failure'
}

function conflictError(info: PrInfo): JobError {
  return new JobError(409, `PR #${info.pr.n} has merge conflicts with ${info.pr.base}`)
}

export class JobError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'job'

/** One line per job, for Otto's own `code_jobs` tool. */
export function formatCodeJob(j: WireJob): string {
  const bits = [`[${j.id}] ${j.state}${j.t3Status && j.t3Status !== j.state ? ` (T3: ${j.t3Label})` : ''}`, j.project, j.branch ?? '']
  if (j.model) bits.push(j.model)
  if (j.pr) bits.push(`PR #${j.pr.n} +${j.pr.add} −${j.pr.del}, ${j.pr.checks}`)
  if (j.now) bits.push(j.now)
  const head = bits.filter(Boolean).join(' · ')
  return `${head} — ${j.title}${j.question ? `\n    asks: ${j.question.text.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`
}
