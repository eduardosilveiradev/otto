/**
 * GET /app/jobs/pr?id=<jobId> → {head, commits, files, checks, reviews,
 * reviewThreads, conversation, timeline, council}. Each section is its value OR
 * {error:string}. head uses gh pr view field names (isDraft, headRefOid, etc.).
 * Collections retain GitHub fields except commits/files/checks/timeline, normalized
 * below. Timeline pointers are {section,id}; ids are strings, commit ids are SHAs.
 * Files: {path,status,additions,deletions,patch,binary,patchUnavailable,truncated}.
 * Checks: {entries:[{id,name,status,conclusion,startedAt,completedAt,durationMs,detailsUrl,summary}],
 * runs?:{error},contexts?:{error}}; same shape on each commit. Binary is null if unknown.
 * Commits: {sha,message,author,date,checks}; reviews/comments retain REST fields.
 * Threads retain GraphQL fields including resolved/outdated flags and all comments.
 * Cached for 5 min by repository, PR number and head SHA; concurrent reads coalesce.
 */
import { parseCouncil, type Exec } from './codejobs.ts'
import { github } from './github.ts'
import { PrImages } from './primages.ts'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { loadState, saveState } from './statefile.ts'

type Json = Record<string, any>
type Failure = { error: string }
type Section<T> = T | Failure
export type PrDetail = Record<'head' | 'commits' | 'files' | 'checks' | 'reviews' | 'reviewThreads' | 'conversation' | 'timeline' | 'council', Section<any>>
const fields = 'number,title,body,url,state,isDraft,author,createdAt,updatedAt,mergedAt,closedAt,mergedBy,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,labels,assignees,reviewRequests,milestone,closingIssuesReferences,additions,deletions,changedFiles,isCrossRepository,headRepository,headRepositoryOwner,mergeCommit,autoMergeRequest,maintainerCanModify,baseRefOid,id,projectItems,reactionGroups'
const safe = async <T>(f: () => Promise<T>): Promise<Section<T>> => {
  try { return await f() } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
}
const items = (s: Section<Json[]>): Json[] => Array.isArray(s) ? s : []

export function patchFile(f: Json) {
  const lines = typeof f.patch === 'string' ? f.patch.split('\n') : []
  // GitHub also omits patches for large text files. Never mislabel those as binary.
  return { path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
    previousPath: f.previous_filename ?? null, patch: typeof f.patch === 'string' ? lines.slice(0, 2000).join('\n') : null,
    binary: f.binary ?? (typeof f.patch === 'string' ? false : null), patchUnavailable: typeof f.patch !== 'string', truncated: lines.length > 2000 }
}

export function mergeTimeline(events: Json[], head: Json | undefined, commits: Json[], reviews: Json[], comments: Json[]) {
  const rows = new Map<string, Json>()
  const put = (type: string, id: unknown, actor: any, time: any, text: string, pointer?: Json) => {
    if (!time) return
    rows.set(`${type}:${id}`, { id: String(id), type, actor: actor ?? null, time, text: text.replace(/\s+/g, ' ').slice(0, 240), ...(pointer ? { pointer } : {}) })
  }
  if (head) put('opened', head.number, head.author, head.createdAt, head.title, { section: 'head', id: String(head.number) })
  for (const e of events) {
    const type = e.event ?? 'unknown'
    const id = type === 'committed' ? e.sha : e.id ?? e.node_id ?? e.created_at
    const section = type === 'committed' ? 'commits' : type === 'reviewed' ? 'reviews' : type === 'commented' ? 'conversation' : undefined
    put(type, id, e.actor ?? e.user ?? e.author, e.created_at ?? e.submitted_at ?? e.committer?.date,
      e.body ?? e.message ?? [type.replaceAll('_', ' '), e.label?.name, e.requested_reviewer?.login, e.requested_team?.name, e.rename?.to].filter(Boolean).join(' '),
      section ? { section, id: String(id) } : undefined)
  }
  for (const c of commits) put('committed', c.sha, c.author, c.date, c.message, { section: 'commits', id: c.sha })
  for (const r of reviews) put('reviewed', r.id, r.user, r.submitted_at, `${r.state}: ${r.body ?? ''}`, { section: 'reviews', id: String(r.id) })
  for (const c of comments) put('commented', c.id, c.user, c.created_at, c.body ?? '', { section: 'conversation', id: String(c.id) })
  return [...rows.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`))
}

export class PrDetails {
  private reads = new Map<string, { at: number; value: Promise<PrDetail> }>()
  private cache = new Map<string, { at: number; value: Promise<PrDetail> }>()
  private lastGood = new Map<string, PrDetail>()
  async cached(repo: string, n: number): Promise<PrDetail | undefined> { return this.lastGood.get(`${repo}:${n}`) }
  private images: PrImages
  constructor(private exec: Exec = github.run, private now = Date.now, fetchImage: typeof fetch = fetch, private directory?: string) {
    this.images = new PrImages(this.exec, fetchImage)
  }
  private storedFile(repo: string, n: number): string | undefined {
    return this.directory && Number.isSafeInteger(n) && n > 0 ? join(this.directory, `${encodeURIComponent(repo.toLowerCase())}--${n}.json`) : undefined
  }
  stored(repo: string, n: number): PrDetail | undefined {
    const file = this.storedFile(repo, n)
    if (!file) return undefined
    return loadState<PrDetail | undefined>(file, () => undefined, value => {
      const head = (value as PrDetail | null)?.head
      return !!head && head.number === n && (head.state === 'MERGED' || head.state === 'CLOSED')
    })
  }
  private keep(repo: string, n: number, value: PrDetail) {
    const file = this.storedFile(repo, n)
    if (!file || !['MERGED', 'CLOSED'].includes(value.head?.state)) return
    mkdirSync(this.directory!, { recursive: true })
    saveState(file, value)
  }
  private async json(cmd: string[]): Promise<any> {
    const out = await this.exec(['gh', ...cmd], undefined, 15_000)
    if (!out) throw new Error('GitHub returned no data (command failed or timed out)')
    const value = JSON.parse(out)
    if (value.errors?.length) throw new Error(value.errors.map((e: Json) => e.message).join('; '))
    return value
  }
  private async pages(path: string, key?: string): Promise<Json[]> {
    const pages = await this.json(['api', '--paginate', '--slurp', `${path}${path.includes('?') ? '&' : '?'}per_page=100`])
    return pages.flatMap((p: any) => key ? p[key] : p)
  }
  private async checks(repo: string, sha: string) {
    const [runs, contexts] = await Promise.all([
      safe(() => this.pages(`repos/${repo}/commits/${sha}/check-runs?filter=all`, 'check_runs')),
      safe(() => this.pages(`repos/${repo}/commits/${sha}/statuses`)),
    ])
    const entries = [
      ...items(runs).map(c => ({ id: String(c.id), name: c.name, status: c.status, conclusion: c.conclusion,
        startedAt: c.started_at, completedAt: c.completed_at, detailsUrl: c.details_url, summary: c.output?.summary ?? null })),
      ...items(contexts).map(c => ({ id: String(c.id), name: c.context, status: c.state === 'pending' ? 'in_progress' : 'completed',
        conclusion: c.state === 'pending' ? null : c.state, startedAt: c.created_at, completedAt: c.state === 'pending' ? null : c.updated_at,
        detailsUrl: c.target_url, summary: c.description })),
    ].map(c => ({ ...c, durationMs: c.startedAt && c.completedAt ? Math.max(0, Date.parse(c.completedAt) - Date.parse(c.startedAt)) : null }))
    return { entries, ...(!Array.isArray(runs) ? { runs } : {}), ...(!Array.isArray(contexts) ? { contexts } : {}) }
  }
  private async threads(repo: string, n: number) {
    const [owner, name] = repo.split('/')
    const result: Json[] = []
    let cursor: string | null = null
    do {
      const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id path line originalLine diffSide isResolved isOutdated comments(first:100){pageInfo{hasNextPage endCursor} nodes{id databaseId author{login} body createdAt updatedAt url diffHunk path line originalLine pullRequestReview{id databaseId}}}}}}}}`
      const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${n}`]
      if (cursor) args.push('-f', `cursor=${cursor}`)
      const data = await this.json(args)
      const conn = data.data.repository.pullRequest.reviewThreads
      for (const thread of conn.nodes) {
        let c = thread.comments
        const comments = [...c.nodes]
        while (c.pageInfo.hasNextPage) {
          const q = 'query($id:ID!,$cursor:String!){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id databaseId author{login} body createdAt updatedAt url diffHunk path line originalLine pullRequestReview{id databaseId}}}}}}'
          const next = await this.json(['api', 'graphql', '-f', `query=${q}`, '-f', `id=${thread.id}`, '-f', `cursor=${c.pageInfo.endCursor}`])
          c = next.data.node.comments
          comments.push(...c.nodes)
        }
        result.push({ ...thread, comments })
      }
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null
    } while (cursor)
    return result
  }
  async read(repo: string, ref: number | string, fresh = false): Promise<PrDetail> {
    const key = `${repo}:${ref}`
    const hit = this.reads.get(key)
    if (!fresh && hit && this.now() - hit.at < 5 * 60_000) return hit.value
    for (const [k, v] of this.reads) if (this.now() - v.at >= 5 * 60_000) this.reads.delete(k)
    const value = this.readUncached(repo, ref, fresh)
    this.reads.set(key, { at: this.now(), value })
    return value
  }
  private async readUncached(repo: string, ref: number | string, fresh: boolean): Promise<PrDetail> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some(s => s === '.' || s === '..') || (typeof ref === 'number' ? !Number.isSafeInteger(ref) || ref <= 0 : !ref || ref.startsWith('-'))) throw new Error('Invalid repository or PR reference')
    if (typeof ref === 'number') {
      const stored = this.stored(repo, ref)
      if (stored) return stored
    }
    // Re-read the head after the TTL, or on an explicit fresh read.
    const identity = await safe(() => this.json(['pr', 'view', String(ref), '--repo', repo, '--json', 'number,headRefOid']))
    if ('error' in identity) return Object.fromEntries(['head','commits','files','checks','reviews','reviewThreads','conversation','timeline','council'].map(k => [k, identity])) as PrDetail
    const key = `${repo}:${identity.number}:${identity.headRefOid}`
    const hit = this.cache.get(key)
    if (!fresh && hit && this.now() - hit.at < 5 * 60_000) return hit.value
    for (const [k, v] of this.cache) if (this.now() - v.at >= 5 * 60_000) this.cache.delete(k)
    const value = this.load(repo, identity.number, identity.headRefOid).then(value => {
      this.keep(repo, identity.number, value)
      if (!Object.values(value).some(section => section && typeof section === 'object' && 'error' in section)) this.lastGood.set(`${repo}:${identity.number}`, value)
      return value
    })
    this.cache.set(key, { at: this.now(), value })
    return value
  }
  private async load(repo: string, n: number, sha: string): Promise<PrDetail> {
    const previous = this.lastGood.get(`${repo}:${n}`)
    const sameHead = previous?.head?.headRefOid === sha && Array.isArray(previous?.files)
    const root = `repos/${repo}`
    const checkCache = new Map<string, ReturnType<PrDetails['checks']>>()
    const checks = (s: string) => {
      if (!checkCache.has(s)) checkCache.set(s, this.checks(repo, s))
      return checkCache.get(s)!
    }
    const [head, commits, files, check, reviews, reviewThreads, conversation, events] = await Promise.all([
      safe(() => this.json(['pr', 'view', String(n), '--repo', repo, '--json', fields])),
      safe(async () => Promise.all((await this.pages(`${root}/pulls/${n}/commits`)).map(async c => ({ sha: c.sha, message: c.commit.message,
        author: c.author ?? c.commit.author, date: c.commit.author.date, checks: await safe(() => checks(c.sha)) })))),
      safe(async () => {
        if (sameHead) return previous!.files
        const files = await this.pages(`${root}/pulls/${n}/files`)
        if (files.length >= 3000) throw new Error('GitHub caps PR files at 3000; file list may be incomplete')
        if (files.some(f => typeof f.patch !== 'string')) {
          const diff = await this.exec(['gh', 'pr', 'diff', String(n), '--repo', repo], undefined, 15_000)
          if (diff === undefined) throw new Error('Could not retrieve missing file patches')
          const chunks = diff.split(/(?=^diff --git )/m)
          for (const f of files) {
            if (typeof f.patch === 'string') continue
            const chunk = chunks.find(c => {
              const header = c.split('\n', 1)[0]
              const target = `b/${f.filename}`
              return header?.endsWith(` ${target}`) || header?.endsWith(` ${JSON.stringify(target)}`)
            })
            if (!chunk) continue
            f.binary = /^(Binary files |GIT binary patch)/m.test(chunk)
            const start = chunk.indexOf('\n@@')
            if (start >= 0) f.patch = chunk.slice(start + 1).replace(/\n$/, '')
            else if (!f.binary && f.additions === 0 && f.deletions === 0) f.patch = ''
          }
        }
        return files.map(patchFile)
      }),
      safe(() => checks(sha)),
      safe(() => this.pages(`${root}/pulls/${n}/reviews`)),
      safe(() => this.threads(repo, n)),
      safe(() => this.pages(`${root}/issues/${n}/comments`)),
      safe(() => this.pages(`${root}/issues/${n}/timeline`)),
    ])
    return this.images.inline({ head, commits, files, checks: check, reviews, reviewThreads, conversation,
      timeline: Array.isArray(events) ? mergeTimeline(events, 'error' in head ? undefined : head, items(commits), items(reviews), items(conversation)) : events,
      council: 'error' in head ? head : parseCouncil(head.body ?? '') }, repo, 'error' in head ? { headRefOid: sha } : head)
  }
}
