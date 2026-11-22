/** Owned-repo merges, including PRs opened outside coding jobs. No user messages. */
import { loadState, saveState } from './statefile.ts'
import { loadJournal } from './redeliver.ts'
import { Github, github } from './github.ts'
import type { Exec } from './codejobs.ts'
import { runChecked } from './workspace.ts'
import { parseGitRemote } from './projects.ts'
import { appendEntry, entryId } from './changelog.ts'

export const PR_MERGES_MS = 2 * 60_000
const WINDOW_MS = 24 * 3_600_000
const OVERLAP_MS = 10 * 60_000
export const MAX_DELIVERED = 10_000

type Scan = { since: string; until: string; after?: string }
export type PrMergesState = {
  startedAt?: string
  cursor?: string
  delivered: Record<string, string>
  scan?: Scan
  lastCheck?: string
  lastDelivered?: string
  lastError?: { at: string; message: string }
}
type Job = { id: string; repo?: string; branch?: string; prNumber?: number; /** Its price tag, e.g. "2.1M Claude tokens · ~3% of the week". */ cost?: string }
type Merge = {
  repository: { nameWithOwner: string }; number: number; title: string; url: string
  mergedAt: string; mergedBy: { login: string } | null; baseRefName: string; headRefName: string
}
export type PrMergesDeps = {
  file: string
  isHost?: () => boolean
  exec?: Exec
  now?: () => number
  checkout?: {
    cwd: string
    log: string
    /** Shared with the reload tool. Returns a refusal, or schedules the restart. */
    reload: (beforeRestart: () => void) => Promise<string | undefined>
    /** False leaves Otto's own checkout alone (self-edit off): a merge there is never pulled or reloaded. */
    enabled?: () => boolean
  }
  jobs: () => Job[]
  /** True means accepted durably. The stable id also dedupes journal recovery. */
  injectEvent: (event: string, content: string, meta: Record<string, string>, id: string) => Promise<boolean>
}

/** The journal owns transport recovery; the watcher only needs durable acceptance. */
export function journalMergeDelivery(
  file: string,
  inject: PrMergesDeps['injectEvent'],
): PrMergesDeps['injectEvent'] {
  return async (event, content, meta, id) => {
    if (loadJournal(file).some(e => e.message_id === id)) return true
    await inject(event, content, meta, id)
    return loadJournal(file).some(e => e.message_id === id)
  }
}

export function loadPrMerges(file: string, peek = false): PrMergesState {
  return loadState(file, () => ({ delivered: {} }), x => {
    const s = x as PrMergesState | null
    return !!s && typeof s.delivered === 'object' && s.delivered !== null && !Array.isArray(s.delivered)
      && Object.values(s.delivered).every(v => typeof v === 'string' && Number.isFinite(Date.parse(v)))
      && (!s.cursor || Number.isFinite(Date.parse(s.cursor)))
      && (!s.scan || (Number.isFinite(Date.parse(s.scan.since)) && Number.isFinite(Date.parse(s.scan.until))))
  }, { peek })
}

// Search returns full PR nodes, unlike REST search/issues or gh search prs (which lack merge details).
const QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      repository { nameWithOwner } number title url mergedAt mergedBy { login } baseRefName headRefName
    } }
  }
}`
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const line = (s: string) => s.replace(/\s+/g, ' ')

export class PrMerges {
  private running = false
  private login?: string
  private github: Github
  constructor(private d: PrMergesDeps) { this.github = d.exec ? new Github(d.exec, d.now) : github }

  async tick(): Promise<void> {
    if (this.d.isHost && !this.d.isHost()) return
    if (this.running) return
    this.running = true
    try { await this.check() } finally { this.running = false }
  }

  private async updateCheckout(p: Merge): Promise<{ error?: string } | undefined> {
    const checkout = this.d.checkout
    if (!checkout || checkout.enabled?.() === false) return
    const git = (...args: string[]) => runChecked(['git', ...args], checkout.cwd, 60_000)
    let stash: string | undefined
    let error: string | undefined
    try {
      const remote = parseGitRemote(await git('config', '--get', 'remote.origin.url'))
      if (remote?.host.toLowerCase() !== 'github.com'
        || `${remote.owner}/${remote.repo}`.toLowerCase() !== p.repository.nameWithOwner.toLowerCase()
        || await git('branch', '--show-current') !== p.baseRefName) return
      const from = await git('rev-parse', 'HEAD')
      if (await git('status', '--porcelain')) {
        const previous = await git('stash', 'list', '--format=%H')
        await git('stash', 'push', '--include-untracked', '-m', `pr-merged #${p.number}`)
        const saved = await git('rev-parse', 'refs/stash')
        if (previous.split('\n')[0] === saved) throw new Error('git stash did not save the dirty tree; not pulling')
        stash = saved
      }
      try { await git('pull', '--ff-only', 'origin', p.baseRefName) }
      catch (err) { error = `git pull --ff-only failed: ${err instanceof Error ? err.message : err}` }
      if (stash) {
        try { await git('stash', 'pop', 'stash@{0}') }
        catch { return { error: `${error ? error + '; ' : ''}stash pop failed or conflicted; edits preserved in stash@{0} (${stash}). Resolve before reloading.` } }
      }
      if (error) return { error }
      const to = await git('rev-parse', 'HEAD')
      const paths = (await git('diff', '--name-only', '--no-renames', from, to)).split('\n').filter(Boolean)
      if (paths.some(path => path === 'otto/supervisor.ts' || path === '.mcp.json')) {
        return { error: 'Pulled changes to otto/supervisor.ts or .mcp.json; manual reconnect required, not reloading.' }
      }
      // Undo touches only what the PR changed; '.' would also overwrite uncommitted edits elsewhere.
      const undo = (await git('diff', '--name-only', '--no-renames', '--diff-filter=MD', from, to)).split('\n').filter(Boolean)
      const refused = await checkout.reload(() => appendEntry(checkout.log, {
        id: entryId(), at: new Date((this.d.now ?? Date.now)()).toISOString(),
        what: `Auto-reloaded PR #${p.number}: ${from} → ${to}`, sha: to, paths,
        tier: 'guarded', origin: 'triggered', by: 'prmerges',
        revert: { kind: 'git-revert', sha: from, paths: undo, why: 'restore the files the merged PR changed' },
      }))
      if (refused) return { error: `Reload refused: ${refused}` }
      return {}
    } catch (err) {
      return { error: `Automatic update failed: ${String(err instanceof Error ? err.message : err)}${stash ? `; saved edits: ${stash}` : ''}` }
    }
  }

  private async check(): Promise<void> {
    const now = (this.d.now ?? Date.now)()
    const state = loadPrMerges(this.d.file)
    state.lastCheck = iso(now)
    // Establish a baseline before any network request, even on an offline first boot.
    if (!state.cursor) {
      state.cursor = iso(now)
      state.startedAt = new Date(now).toISOString()
      saveState(this.d.file, state)
      return
    }
    const exec = this.github.run
    try {
      if (!this.login) {
        const user = JSON.parse(await exec(['gh', 'api', 'user'], undefined, 15_000) ?? 'null')
        if (!user?.login || !/^[\w-]+$/.test(user.login)) throw new Error('gh api user returned no login')
        this.login = user.login
      }
      // A fixed upper bound makes pagination safe while newer merges arrive. One search per tick.
      const scan = state.scan ?? {
        since: iso(Math.max(Date.parse(state.cursor) - OVERLAP_MS, now - WINDOW_MS, Date.parse(state.startedAt ?? state.cursor))), until: iso(now),
      }
      const q = `owner:${this.login} is:pr is:merged merged:${scan.since}..${scan.until} sort:updated-asc`
      const args = ['gh', 'api', 'graphql', '-f', `query=${QUERY}`, '-f', `q=${q}`]
      if (scan.after) args.push('-f', `after=${scan.after}`)
      const response = JSON.parse(await exec(args, undefined, 30_000) ?? 'null')
      const page = response?.data?.search
      if (response?.errors?.length || !Array.isArray(page?.nodes) || !page.pageInfo
        || (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)) throw new Error('GitHub merge search failed or returned an incomplete page')
      const merges = page.nodes as Merge[]
      // Validate the whole page before advancing or delivering any of it.
      for (const p of merges) {
        if (!p?.repository?.nameWithOwner || !Number.isInteger(p.number) || !p.url || typeof p.title !== 'string'
          || !Number.isFinite(Date.parse(p.mergedAt)) || typeof p.baseRefName !== 'string') throw new Error('GitHub merge search returned an invalid PR')
      }
      for (const p of merges) {
        const repo = p.repository.nameWithOwner
        if (repo.split('/')[0]!.toLowerCase() !== this.login!.toLowerCase()) continue
        const key = `${repo.toLowerCase()}#${p.number}`
        if (Date.parse(p.mergedAt) <= Date.parse(state.startedAt ?? '') || Date.parse(p.mergedAt) < now - WINDOW_MS) continue
        if (state.delivered[key]) continue
        // Never evict an in-window key: that would replay it on the next overlapping search.
        for (const [id, at] of Object.entries(state.delivered)) {
          if (Date.parse(at) < now - WINDOW_MS) delete state.delivered[id]
        }
        if (Object.keys(state.delivered).length >= MAX_DELIVERED) throw new Error('Merge dedupe capacity reached; retrying after old entries expire')
        const job = this.d.jobs().find(j => j.repo?.toLowerCase() === repo.toLowerCase()
          && (j.prNumber === p.number || (!!j.branch && j.branch === p.headRefName)))
        const meta: Record<string, string> = {
          repo, pr: String(p.number), title: p.title, url: p.url, merged_at: p.mergedAt, base: p.baseRefName,
          ...(p.mergedBy?.login ? { merged_by: p.mergedBy.login } : {}), ...(job ? { job: job.id } : {}),
        }
        const update = await this.updateCheckout(p)
        if (!update || update.error) {
          const ok = await this.d.injectEvent('pr-merged', line(`${repo}#${p.number} merged: ${p.title} (${p.url})${job?.cost ? ` · ${job.cost}` : ''}${update?.error ? ` — ${update.error}` : ''}`), meta, `pr-merged:${key}`)
          if (!ok) throw new Error(`Could not journal merge ${key}`)
        }
        state.delivered[key] = p.mergedAt
        state.lastDelivered = iso(now)
        delete state.lastError
        saveState(this.d.file, state)
        // A restart is scheduled: leave the rest of the page for the next process.
        if (update && !update.error) return
      }
      if (page.pageInfo.hasNextPage) state.scan = { ...scan, after: page.pageInfo.endCursor }
      else { state.cursor = scan.until; delete state.scan }
      delete state.lastError
    } catch (err) {
      state.lastError = { at: iso(now), message: String(err instanceof Error ? err.message : err).slice(0, 240) }
    }
    saveState(this.d.file, state)
  }
}
