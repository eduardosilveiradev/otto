/**
 * Project boards — a Kanban board per T3 project for the desktop app.
 *
 * `boards.json` holds the cards, keyed by project name. A card dragged to "in progress" starts a
 * coding job through `CodeJobs.start`, the same path `code_job` takes, and from then on its column
 * follows the job: every job list the app is pushed also passes through `follow`, so the card moves
 * on the job's own state and never needs a poll of its own. Stopped or failed sends it back to the
 * backlog with its jobId kept, so the app can still show what happened.
 *
 * Rewrite turns a rough card into a brief for the job it will start, on a cheap model, with the
 * project's README or AGENTS.md and file list as context. It returns the draft without saving, so the
 * app can show it next to the original and save it only when the user keeps it.
 */
import { randomBytes } from 'crypto'
import { join } from 'path'
import { loadState, saveState } from './statefile.ts'
import { overSsh, type Exec, type WireJob } from './codejobs.ts'
import { t3Host } from './t3.ts'
import { run } from './workspace.ts'
import type { Effort } from './route.ts'

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const COLUMNS = ['backlog', 'progress', 'review', 'done'] as const
export type Column = typeof COLUMNS[number]
/** `archivedAt` is set only on a done card; the card stays in `done` and in every list, so the client decides where to show it. */
export type Card = { id: string; title: string; notes: string; column: Column; jobId?: string; createdAt: string; order: number; archivedAt?: string }
export type BoardsFile = Record<string, Card[]>
export type Board = { project: string; cards: Card[] }

/** The column a card with this job belongs in. */
export function columnFor(state: WireJob['state']): Column {
  return state === 'merged' ? 'done'
    : state === 'stopped' || state === 'failed' ? 'backlog'
      : state === 'review' || state === 'done' ? 'review'
        : 'progress'
}

/** Puts `card` at `order` in `column` and renumbers that column (and the one it left) 0..n. Leaving done unarchives it. */
export function place(cards: Card[], card: Card, column: Column, order = Infinity): void {
  const from = card.column
  const rest = cards.filter(c => c !== card && c.column === column).sort((a, b) => a.order - b.order)
  rest.splice(Math.max(0, Math.min(order, rest.length)), 0, card)
  card.column = column
  if (column !== 'done') delete card.archivedAt
  rest.forEach((c, i) => { c.order = i })
  if (from !== column) cards.filter(c => c.column === from).sort((a, b) => a.order - b.order).forEach((c, i) => { c.order = i })
}

export class BoardError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/** One cheap model call: the system prompt and the user turn in, the reply's text out. */
export type Ask = (system: string, user: string) => Promise<string>

export const REWRITE_MODEL = 'claude-haiku-5-5'

// A title can be a whole rant: the rewrite turns it into a short one, so keep all of it until then.
const TITLE_MAX = 4000

const REWRITE_SYSTEM = [
  'You turn a rough Kanban card into a clear brief for a coding agent that will work on the project described below.',
  'Keep every requirement the user wrote, in their meaning. Add no new requirements, features or constraints of your own.',
  'Use the project context only to say where the work happens: name a file or folder only if it appears in the context, and say "likely" when unsure.',
  'Reply in plain text, no markdown, no code fences. The first line is the title: under 80 characters, imperative, no trailing period.',
  'Then a blank line, then these four sections, each a label on its own line followed by short lines starting with "- ":',
  'Goal:', 'What to build:', 'Done when:', 'How to check:',
  'Keep it short. If the card is too vague to say what done looks like, say what to confirm with the user under "Done when:" instead of guessing.',
].join('\n')

/**
 * The prompt's project context: README.md (or AGENTS.md) and the tracked files, both capped.
 * Read where T3's checkouts are: this disk, or over ssh when T3 runs on another machine.
 */
export async function projectContext(root: string | undefined, host = t3Host(), exec: Exec = run): Promise<string> {
  if (!root) return ''
  const x = host ? overSsh(exec, host) : exec
  const doc = (await Promise.all(['AGENTS.md', 'README.md'].map(f => x(['cat', join(root, f)], undefined, 10_000))))
    .filter(Boolean).map(t => t!.slice(0, 6000)).join('\n\n')
  const ls = await x(['git', 'ls-files'], root, 10_000)
  const files = ls ? ls.split('\n').filter(Boolean).slice(0, 400).join('\n') : ''
  return [doc && `Project docs:\n${doc}`, files && `Files in the project:\n${files}`].filter(Boolean).join('\n\n')
}

/** The model's reply as a card: first line the title, the rest the notes. Fences and markdown markers dropped. */
export function parseRewrite(raw: string): { title: string; notes: string } {
  const text = raw.replace(/^```\w*\n?|```\s*$/gm, '').trim()
  const [first = '', ...rest] = text.split('\n')
  return { title: first.replace(/^#+\s*|^title:\s*/i, '').replace(/^\*\*|\*\*$/g, '').trim().slice(0, 200), notes: rest.join('\n').trim().slice(0, 8000) }
}

/** Haiku over the Messages API. Aborts at 25 s, inside the app's 30 s wait. */
export function haiku(key: () => string | undefined, fetchImpl: typeof fetch = fetch): Ask {
  return async (system, user) => {
    const k = key()
    if (!k) throw new BoardError(503, 'rewrite needs ANTHROPIC_API_KEY in the server’s .env')
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: REWRITE_MODEL, max_tokens: 1200, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(25_000),
    })
    if (!res.ok) throw new BoardError(502, `the model said ${res.status}`)
    const j = await res.json() as { content?: { type: string; text?: string }[] }
    return j.content?.find(c => c.type === 'text')?.text ?? ''
  }
}

type Jobs = {
  projects(): Promise<{ name: string; root?: string }[]>
  start(input: { project: string; title: string; brief: string; origin: 'user-typed'; model: string; effort?: Effort; override_low_limit?: boolean }): Promise<WireJob>
  /** The job as it is now, for a start that finds one already running. */
  job(id: string): Promise<WireJob | undefined>
}

export class Boards {
  private starting = new Map<string, Promise<WireJob>>()
  constructor(private o: { file: string; jobs: Jobs; push?: (boards: Board[]) => void; now?: () => number; ask?: Ask }) {}

  private load(): BoardsFile {
    return loadState<BoardsFile>(this.o.file, () => ({}), x => !!x && typeof x === 'object' && !Array.isArray(x))
  }
  private save(b: BoardsFile): void {
    saveState(this.o.file, b)
    this.o.push?.(this.list(b))
  }
  private list(b: BoardsFile, names: string[] = []): Board[] {
    return [...new Set([...names, ...Object.keys(b)])].map(project => ({ project, cards: (b[project] ?? []).sort((x, y) => COLUMNS.indexOf(x.column) - COLUMNS.indexOf(y.column) || x.order - y.order) }))
  }
  private find(b: BoardsFile, project: string, id: string): Card {
    const card = b[project]?.find(c => c.id === id)
    if (!card) throw new BoardError(404, 'no such card')
    return card
  }

  /** Every T3 project's board, empty ones too; the stored ones alone when T3 can't be read. */
  async boards(): Promise<Board[]> {
    const names = await this.o.jobs.projects().then(ps => ps.map(p => p.name), () => [])
    return this.list(this.load(), names)
  }

  /** Create (no id) or edit/move a card. Only the fields given change. */
  upsert(input: { project?: unknown; id?: unknown; title?: unknown; notes?: unknown; column?: unknown; order?: unknown }): Card {
    const project = typeof input.project === 'string' ? input.project.trim() : ''
    if (!project) throw new BoardError(400, 'project is required')
    if (input.column !== undefined && !COLUMNS.includes(input.column as Column)) throw new BoardError(400, `column must be one of ${COLUMNS.join(', ')}`)
    const b = this.load()
    const cards = (b[project] ??= [])
    let card: Card
    if (input.id === undefined) {
      const title = typeof input.title === 'string' ? input.title.trim().slice(0, TITLE_MAX) : ''
      if (!title) throw new BoardError(400, 'title is required')
      card = { id: 'c' + randomBytes(4).toString('hex'), title, notes: '', column: 'backlog', createdAt: new Date(this.o.now?.() ?? Date.now()).toISOString(), order: 0 }
      cards.push(card)
      place(cards, card, card.column)
    } else {
      card = this.find(b, project, String(input.id))
      if (typeof input.title === 'string' && input.title.trim()) card.title = input.title.trim().slice(0, TITLE_MAX)
    }
    if (typeof input.notes === 'string') card.notes = input.notes.slice(0, 8000)
    if (input.column !== undefined || typeof input.order === 'number') place(cards, card, (input.column as Column | undefined) ?? card.column, typeof input.order === 'number' ? input.order : Infinity)
    this.save(b)
    return card
  }

  remove(project: unknown, id: unknown): void {
    const b = this.load(), name = String(project)
    const card = this.find(b, name, String(id))
    b[name] = b[name]!.filter(c => c !== card)
    b[name].filter(c => c.column === card.column).sort((x, y) => x.order - y.order).forEach((c, i) => { c.order = i })
    this.save(b)
  }

  /**
   * Archives (`on`) or unarchives the cards named in `ids`. Archive with no `ids` takes every done card;
   * only done cards can be archived. Every id is checked before anything is written.
   */
  archive(input: { project?: unknown; ids?: unknown }, on: boolean): void {
    const project = typeof input.project === 'string' ? input.project.trim() : ''
    if (!project) throw new BoardError(400, 'project is required')
    const ids = Array.isArray(input.ids) && input.ids.every(i => typeof i === 'string') ? input.ids as string[] : undefined
    if (!ids && (input.ids !== undefined || !on)) throw new BoardError(400, 'ids must be a list of card ids')
    const b = this.load()
    const cards = ids === undefined ? (b[project] ?? []).filter(c => c.column === 'done') : ids.map(id => this.find(b, project, id))
    const open = on ? cards.find(c => c.column !== 'done') : undefined
    if (open) throw new BoardError(409, `card ${open.id} is in ${open.column}, not done: only done cards can be archived`)
    const at = new Date(this.o.now?.() ?? Date.now()).toISOString()
    let changed = false
    for (const c of cards) {
      if (on === !!c.archivedAt) continue
      if (on) c.archivedAt = at
      else delete c.archivedAt
      changed = true
    }
    if (changed) this.save(b)
  }

  /** Starts the card's job, or returns the live one it already has. Two calls at once share one start. */
  start(input: { project?: unknown; cardId?: unknown; title?: unknown; brief?: unknown; model?: unknown; effort?: unknown; override_low_limit?: unknown }): Promise<WireJob> {
    const project = String(input.project ?? ''), cardId = String(input.cardId ?? '')
    const key = `${project}\0${cardId}`
    const running = this.starting.get(key)
    if (running) return running
    const p = this.startOnce(project, cardId, input).finally(() => this.starting.delete(key))
    this.starting.set(key, p)
    return p
  }

  private async startOnce(project: string, cardId: string, input: { title?: unknown; brief?: unknown; model?: unknown; effort?: unknown; override_low_limit?: unknown }): Promise<WireJob> {
    const card = this.find(this.load(), project, cardId)
    if (card.jobId) {
      const job = await this.o.jobs.job(card.jobId)
      if (job && !['merged', 'stopped', 'failed'].includes(job.state)) return job
    }
    // No default model for a board job: the card's start names one, so a job never lands on a model the user didn't pick.
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    if (!model) throw new BoardError(400, 'pick a model for this card')
    const effort = EFFORTS.includes(input.effort as Effort) ? input.effort as Effort : undefined
    const title = (typeof input.title === 'string' && input.title.trim()) || card.title
    const brief = (typeof input.brief === 'string' && input.brief.trim()) || [card.title, card.notes].filter(Boolean).join('\n\n')
    const job = await this.o.jobs.start({ project, title, brief, origin: 'user-typed', model, ...(effort ? { effort } : {}), ...(input.override_low_limit === true ? { override_low_limit: true } : {}) })
    const b = this.load()
    const c = this.find(b, project, cardId)
    c.jobId = job.id
    place(b[project]!, c, columnFor(job.state), c.column === columnFor(job.state) ? c.order : Infinity)
    this.save(b)
    return job
  }

  /** A clearer title and notes for the card, written by a cheap model with the project's context. Saves nothing. */
  async rewrite(input: { project?: unknown; id?: unknown }): Promise<{ title: string; notes: string }> {
    const project = String(input.project ?? '')
    const card = this.find(this.load(), project, String(input.id ?? ''))
    if (!this.o.ask) throw new BoardError(503, 'rewrite is not set up on this server')
    // The root comes from T3's own list, never from the request.
    const root = await this.o.jobs.projects().then(ps => ps.find(p => p.name === project)?.root, () => undefined)
    const user = [await projectContext(root), `Project: ${project}`, `Card title: ${card.title}`, `Card notes:\n${card.notes || '(none)'}`].filter(Boolean).join('\n\n')
    const out = parseRewrite(await this.o.ask(REWRITE_SYSTEM, user).catch(e => {
      throw e instanceof BoardError ? e : new BoardError(502, `the model didn’t answer: ${e instanceof Error ? e.message : e}`)
    }))
    if (!out.title) throw new BoardError(502, 'the model sent back nothing')
    return out
  }

  /** Moves each card with a job to the column its job's state says. Writes and pushes only on a change. */
  // ponytail: in memory, so after a restart a card dragged off its job's column snaps back once; persist per card if that bites.
  private seen = new Map<string, WireJob['state']>()
  follow(jobs: WireJob[]): void {
    // Only a job's change moves its card: a card the user dragged elsewhere stays put until the job moves on.
    const states = new Map(jobs.filter(j => this.seen.get(j.id) !== j.state).map(j => [j.id, j.state]))
    for (const j of jobs) this.seen.set(j.id, j.state)
    if (!states.size) return
    const b = this.load()
    let changed = false
    for (const cards of Object.values(b)) {
      for (const c of cards) {
        const state = c.jobId && states.get(c.jobId)
        if (!state || columnFor(state) === c.column) continue
        place(cards, c, columnFor(state))
        changed = true
      }
    }
    if (changed) this.save(b)
  }

  /** GET /app/boards, POST /app/boards/card, /delete, /rewrite, /archive and /unarchive. The caller has checked the app token. */
  async handle(req: Request, path: string): Promise<Response> {
    try {
      if (path === '/app/boards') {
        if (req.method !== 'GET') return new Response(null, { status: 405 })
        return Response.json({ boards: await this.boards() })
      }
      if (!['/app/boards/card', '/app/boards/delete', '/app/boards/rewrite', '/app/boards/archive', '/app/boards/unarchive'].includes(path)) return new Response(null, { status: 404 })
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      if (path === '/app/boards/rewrite') return Response.json(await this.rewrite(body))
      if (path === '/app/boards/archive' || path === '/app/boards/unarchive') {
        this.archive(body, path === '/app/boards/archive')
        return Response.json({ boards: await this.boards() })
      }
      if (path === '/app/boards/delete') {
        this.remove(body.project, body.id)
        return Response.json({ ok: true })
      }
      return Response.json({ card: this.upsert(body) })
    } catch (err) {
      const status = err instanceof BoardError ? err.status : 500
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status })
    }
  }
}
