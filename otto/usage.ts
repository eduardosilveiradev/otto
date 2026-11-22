/** Local token totals, including Claude cache reads/writes, and coding jobs' price tags. No dollar prices. */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { liveWindows, parsePlanUsage, PLAN_WINDOWS, type PlanUsage } from './spend.ts'

type Entry = { at: number; tokens: number }
type FileCache = { offset: number; ino: number; mtime: number; entries: Record<string, Entry>; cumulative: number; tail?: string }
type Cache = { version: 1; files: Record<string, FileCache> }
export type Totals = { today: number; month: number; year: number; week?: number }
export type UsageTotals = { claude: Totals; gpt?: Totals }
export type UsageOptions = { home?: string; claudeDirs?: string[]; codexDirs?: string[]; cacheFile?: string; now?: number; weekStart?: number }
const number = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
const total = (u: any) => number(u?.total_tokens) || number(u?.input_tokens) + number(u?.output_tokens)

function files(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory()
      ? files(join(root, e.name)) : e.isFile() && e.name.endsWith('.jsonl') ? [realpathSync(join(root, e.name))] : [])
  } catch { return [] }
}

function update(file: string, provider: string, old?: FileCache): FileCache {
  const s = statSync(file)
  const fd = openSync(file, 'r')
  const tailAt = (offset: number) => {
    const bytes = Buffer.alloc(Math.min(64, offset))
    readSync(fd, bytes, 0, bytes.length, offset - bytes.length)
    return bytes.toString('base64')
  }
  const c: FileCache = old && old.ino === s.ino && old.offset <= s.size && !(old.offset === s.size && old.mtime !== s.mtimeMs) && old.tail === tailAt(old.offset)
    ? old : { offset: 0, ino: s.ino, mtime: 0, entries: {}, cumulative: 0 }
  if (c.offset === s.size) { closeSync(fd); return c }
  // Stream bounded chunks; retain an unfinished final line for the next call.
  let pending = Buffer.alloc(0), position = c.offset
  try {
    const chunk = Buffer.alloc(64 * 1024)
    while (position < s.size) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, s.size - position), position)
      if (!n) break
      position += n
      pending = Buffer.concat([pending, chunk.subarray(0, n)])
      let end: number
      while ((end = pending.indexOf(10)) >= 0) {
        const start = c.offset
        const line = pending.subarray(0, end).toString('utf8')
        c.offset += end + 1
        pending = pending.subarray(end + 1)
        try {
          const j = JSON.parse(line), at = Date.parse(j.timestamp)
          if (!Number.isFinite(at)) continue
          if (provider === 'claude') {
            const u = j.message?.usage ?? j.usage
            if (!u) continue
            const tokens = number(u.input_tokens) + number(u.output_tokens) + number(u.cache_creation_input_tokens) + number(u.cache_read_input_tokens)
            const id = j.message?.id ? `${j.requestId ?? ''}:${j.message.id}` : j.uuid ?? `${file}:${start}`
            // Streaming chunks repeat the input counters; keep the fullest reading.
            if (!c.entries[id] || tokens > c.entries[id].tokens) c.entries[id] = { at, tokens }
          } else if (j.type === 'event_msg' && j.payload?.type === 'token_count') {
            const info = j.payload.info
            if (!info) continue
            const cumulative = total(info.total_token_usage)
            const tokens = info.total_token_usage ? (cumulative >= c.cumulative ? cumulative - c.cumulative : cumulative) : total(info.last_token_usage)
            if (info.total_token_usage) c.cumulative = cumulative
            if (tokens) c.entries[`${file}:${start}`] = { at, tokens }
          }
        } catch { /* A malformed complete line must not hide subsequent usage. */ }
      }
    }
    c.tail = tailAt(c.offset)
  } finally { closeSync(fd) }
  c.mtime = s.mtimeMs
  return c
}

export function collectUsage(options: UsageOptions = {}): UsageTotals {
  const home = options.home ?? homedir(), now = options.now ?? Date.now()
  const cacheFile = options.cacheFile ?? join(home, '.otto', 'state', 'usage-cache.json')
  let cache: Cache = { version: 1, files: {} }
  try { const saved = JSON.parse(readFileSync(cacheFile, 'utf8')); if (saved.version === 1 && saved.files) cache = saved } catch {}
  let discovered: string[] = []
  try { discovered = readdirSync(home).filter(name => /^\.claude[-_]/.test(name)).map(name => join(home, name)) } catch {}
  const claude = options.claudeDirs ?? [join(home, '.claude'), ...discovered, ...(!options.home && process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR.split(',').filter(Boolean).map(p => resolve(p.trim())) : [])]
  const codex = options.codexDirs ?? [(!options.home && process.env.CODEX_HOME) || join(home, '.codex')]
  const groups = { claude: [...new Set(claude.flatMap(p => files(join(p, 'projects'))))], gpt: [...new Set(codex.flatMap(p => files(join(p, 'sessions'))))] }
  const d = new Date(now), today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime(), year = new Date(d.getFullYear(), 0, 1).getTime()
  const result: UsageTotals = { claude: { today: 0, month: 0, year: 0 } }
  const next: Cache = { version: 1, files: {} }
  let changed = false
  for (const provider of ['claude', 'gpt'] as const) {
    if (provider === 'gpt' && !groups.gpt.length) continue
    const totals: Totals = result[provider] = { today: 0, month: 0, year: 0 }
    if (options.weekStart !== undefined) totals.week = 0
    const entries: Record<string, Entry> = {}
    for (const file of groups[provider]) {
      try {
        const old = cache.files[file], offset = old?.offset, mtime = old?.mtime
        const valid = old && typeof old.offset === 'number' && old.entries && typeof old.cumulative === 'number'
        const c = update(file, provider, valid ? old : undefined); next.files[file] = c
        if (c !== old || c.offset !== offset || c.mtime !== mtime) changed = true
        for (const [id, e] of Object.entries(c.entries)) if (!entries[id] || e.tokens > entries[id].tokens) entries[id] = e
      } catch { /* Logs can disappear during rotation. */ }
    }
    for (const e of Object.values(entries)) {
      if (e.at > now) continue
      if (options.weekStart !== undefined && e.at >= options.weekStart) totals.week! += e.tokens
      if (e.at >= today) totals.today += e.tokens
      if (e.at >= month) totals.month += e.tokens
      if (e.at >= year) totals.year += e.tokens
    }
  }
  if (!changed && Object.keys(next.files).length === Object.keys(cache.files).length) return result
  try {
    mkdirSync(dirname(cacheFile), { recursive: true })
    const temp = `${cacheFile}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 }); renameSync(temp, cacheFile)
  } catch { /* Totals still work with a read-only state directory. */ }
  return result
}

export function formatTokens(n: number): string {
  return n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : String(n)
}
export function formatUsage(totals: UsageTotals, plan: PlanUsage | null, now = Date.now()): string {
  const windows = liveWindows(plan, now).map(k => `${PLAN_WINDOWS[k].label} plan window ${Math.round(plan![k]!.used_percentage)}%, resets ${new Date(plan![k]!.resets_at * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}`)
  const periods = (t: Totals) => `${formatTokens(t.today)} tokens today, ${formatTokens(t.month)} this month, ${formatTokens(t.year)} this year`
  return [...(windows.length ? windows : ['plan window unavailable']), `Claude: ${periods(totals.claude)}`, ...(totals.gpt ? [`GPT: ${periods(totals.gpt)}`] : [])].join(' · ')
}
export function readPlanUsage(stateDir = join(homedir(), '.otto', 'state')): PlanUsage | null {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, 'plan-usage.json'), 'utf8'))
    return typeof raw?.at === 'number' && Number.isFinite(raw.at) ? parsePlanUsage(raw, raw.at) : null
  } catch { return null }
}
export function usageLine(stateDir = join(homedir(), '.otto', 'state')): string {
  const jobs = jobRollup(readJobCosts(stateDir))
  return formatUsage(collectUsage({ cacheFile: join(stateDir, 'usage-cache.json') }), readPlanUsage(stateDir)) + (jobs ? ` · ${jobs}` : '')
}

// ---------------------------------------------------------------------------
// Price tags: what a finished coding job spent
// ---------------------------------------------------------------------------

/** Which plan a model bills against; undefined when the label says neither. */
export const provider = (model?: string): 'Claude' | 'GPT' | undefined =>
  /gpt|codex/i.test(model ?? '') ? 'GPT' : /claude|opus|fable|sonnet|haiku/i.test(model ?? '') ? 'Claude' : undefined

/** The Claude weekly window's reading when a job starts or ends. */
export type WeekMark = { pct: number; resetsAt: number }
export const weekMark = (plan: PlanUsage | null, now: number): WeekMark | undefined =>
  liveWindows(plan, now).includes('seven_day') ? { pct: plan!.seven_day!.used_percentage, resetsAt: plan!.seven_day!.resets_at } : undefined

// ponytail: the weekly % delta over the job's run counts everything else on the plan meanwhile, so
// parallel jobs overlap and each overstates; never sum these. Swap for a per-job reading if the plan API grows one.
export function weekShare(start?: WeekMark, end?: WeekMark): number | undefined {
  if (!start || !end || Math.abs(start.resetsAt - end.resetsAt) > 3600) return undefined // the window reset mid-job
  const d = Math.round(end.pct - start.pct)
  return d >= 1 ? d : undefined
}

/** "2.1M Claude tokens · ~3% of the week"; nothing when no tokens were counted. */
export function priceTag(tokens: number | undefined, model: string | undefined, share?: number): string | undefined {
  if (!tokens) return undefined
  const p = provider(model)
  return `${formatTokens(tokens)} ${p ? `${p} ` : ''}tokens${p === 'Claude' && share ? ` · ~${share}% of the week` : ''}`
}

/** One finished job, appended to job-costs.jsonl: code-jobs.json forgets finished jobs after 14 days. */
export type JobCost = { id: string; at: string; title: string; model?: string; tokens: number; share?: number }
export const jobCostsFile = (stateDir: string) => join(stateDir, 'job-costs.jsonl')
export function appendJobCost(stateDir: string, c: JobCost): void {
  try { appendFileSync(jobCostsFile(stateDir), JSON.stringify(c) + '\n', { mode: 0o600 }) } catch { /* the tag still shows; only the rollup misses it */ }
}
export function readJobCosts(stateDir: string): JobCost[] {
  let text = ''
  try { text = readFileSync(jobCostsFile(stateDir), 'utf8') } catch { return [] }
  const byId = new Map<string, JobCost>()
  for (const line of text.split('\n')) {
    try { const c = JSON.parse(line); if (c?.id && c.tokens > 0) { byId.delete(c.id); byId.set(c.id, c) } } catch {}
  }
  return [...byId.values()] // last wins: a job can be reopened and finish again
}

/** "jobs this month: Opus 5.5 3.1M, GPT 6.1 Sol 1M · priciest: "a" 2.1M, …"; undefined with no jobs. */
export function jobRollup(costs: JobCost[], now = Date.now()): string | undefined {
  const d = new Date(now), month = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const rows = costs.filter(c => Date.parse(c.at) >= month && Date.parse(c.at) <= now)
  if (!rows.length) return undefined
  const byModel = new Map<string, number>()
  for (const c of rows) {
    const m = c.model?.split(' · ')[0] || 'unknown model'
    byModel.set(m, (byModel.get(m) ?? 0) + c.tokens)
  }
  const models = [...byModel].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${formatTokens(n)}`)
  const top = [...rows].sort((a, b) => b.tokens - a.tokens).slice(0, 3).map(c => `"${c.title}" ${formatTokens(c.tokens)}`)
  return `jobs this month: ${models.join(', ')} · priciest: ${top.join(', ')}`
}

if (import.meta.main) console.log(usageLine())
