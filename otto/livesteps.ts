import { randomBytes } from 'crypto'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * The app's live view of a reply in the works: each tool call's label, in order,
 * plus the latest screenshot if one was taken. One task at a time, in memory only;
 * a new task replaces the finished one. Frames go out at most every `gap` ms, each
 * a full snapshot, so a dropped one costs nothing.
 *
 *   { type: "steps", taskId, steps: [{ label, ts }], screenshot?: <base64 JPEG>, done }
 *
 * `screenshot` rides only the first frame after it changes (and `snapshot()`, for a
 * socket that just connected); the app keeps the last one it got.
 *
 * The frames are live only, but the steps outlive them: each reply to the app takes the
 * steps made since the one before it (`take`) and /app/history serves them on its row.
 */

export type Step = { label: string; ts: string; subagent?: Subagent }
type Task = { taskId: string; steps: Step[]; screenshot?: string; done: boolean }

const MAX_STEPS = 100

export class LiveSteps {
  private task: Task | null = null
  private shotSent = true
  private dirty = false
  private pending = false
  private lastSent = -Infinity
  /** How many of the task's steps have already gone into history with a reply (take). */
  private taken = 0

  constructor(
    private send: (frame: string) => void,
    private now: () => number = Date.now,
    private schedule: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms) },
    private gap = 500,
  ) {}

  /** A tool call. Starts a task when none is running. */
  step(label: string, subagent?: Subagent): void {
    if (!label) return
    if (!this.task || this.task.done) {
      this.task = { taskId: randomBytes(4).toString('hex'), steps: [], done: false }
      this.shotSent = true
      this.taken = 0
    }
    this.task.steps.push({ label, ts: new Date(this.now()).toISOString(), ...(subagent ? { subagent } : {}) })
    if (this.task.steps.length > MAX_STEPS) { this.task.steps.shift(); if (this.taken) this.taken-- }
    this.changed()
  }

  /** A late, better label for a step already shown (the most recent one with `from`). */
  relabel(from: string, to: string): void {
    if (!this.task || !to) return
    for (let i = this.task.steps.length - 1; i >= 0; i--) {
      if (this.task.steps[i].label === from) { this.task.steps[i].label = to; this.changed(); return }
    }
  }

  /** The latest screenshot, base64 JPEG. Dropped when no task is running. */
  screenshot(jpeg: string): void {
    if (!this.task || this.task.done) return
    this.task.screenshot = jpeg
    this.shotSent = false
    this.changed()
  }

  /**
   * The steps since the last call (or the task's start): the ones that led to the reply now
   * going out, which history keeps with it so a device that wasn't watching can still show them.
   */
  take(): Step[] {
    if (!this.task) return []
    const out = this.task.steps.slice(this.taken).map(s => ({ ...s }))
    this.taken = this.task.steps.length
    return out
  }

  finish(): void {
    if (!this.task || this.task.done) return
    this.task.done = true
    this.taken = this.task.steps.length   // a turn that ended without a reply keeps its steps to itself
    this.changed()
  }

  /** The running task in full, for a socket that just connected; null when idle. */
  snapshot(): string | null {
    return this.task && !this.task.done ? this.frame(true) : null
  }

  private frame(withShot: boolean): string {
    const t = this.task!
    return JSON.stringify({ type: 'steps', taskId: t.taskId, steps: t.steps, ...(withShot && t.screenshot ? { screenshot: t.screenshot } : {}), done: t.done })
  }

  private changed(): void {
    this.dirty = true
    if (this.pending) return
    this.pending = true
    this.schedule(() => this.flush(), Math.max(0, this.lastSent + this.gap - this.now()))
  }

  private flush(): void {
    this.pending = false
    if (!this.dirty || !this.task) return
    this.dirty = false
    this.lastSent = this.now()
    this.send(this.frame(!this.shotSent))
    this.shotSent = true
  }
}

export type Subagent = { id: string; label: string }
const subagents = new Map<string, Subagent>()

/**
 * Who made a tool call, when a subagent did: hook payloads from inside one carry its
 * agent_id and agent_type. The parent's description for it isn't in the payload; Claude
 * Code keeps it in `<transcript>/subagents/agent-<id>.meta.json`, written before the
 * subagent's first tool call. Undocumented, so the agent_type stands in when it's missing.
 */
export function subagentOf(h: { agent_id?: string; agent_type?: string; transcript_path?: string }): Subagent | undefined {
  const id = h.agent_id
  if (!id || !/^[\w-]+$/.test(id)) return undefined
  const known = subagents.get(id)
  if (known) return known
  let label = ''
  try {
    const meta = JSON.parse(readFileSync(`${String(h.transcript_path).replace(/\.jsonl$/, '')}/subagents/agent-${id}.meta.json`, 'utf8'))
    label = String(meta.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
  } catch {}
  if (!label) return { id, label: String(h.agent_type || 'Subagent').slice(0, 40) } // not cached: the file may turn up
  if (subagents.size >= 50) subagents.clear()
  subagents.set(id, { id, label })
  return { id, label }
}

/**
 * The last image in a PostToolUse hook's tool_response, as base64: in a batch, the latest
 * screenshot. MCP results carry { type: "image", data } and API-shaped ones
 * { type: "image", source: { data } }; which one the hook sees isn't documented, so either will do.
 */
export function findImage(v: unknown, depth = 0): string | null {
  if (depth > 6 || v === null || typeof v !== 'object') return null
  if (Array.isArray(v)) {
    for (const x of [...v].reverse()) { const hit = findImage(x, depth + 1); if (hit) return hit }
    return null
  }
  const o = v as Record<string, unknown>
  if (o.type === 'image') {
    const src = o.source as Record<string, unknown> | undefined
    const data = typeof o.data === 'string' ? o.data : typeof src?.data === 'string' ? src.data : null
    if (data && data.length > 100) return data
  }
  for (const x of Object.values(o)) { const hit = findImage(x, depth + 1); if (hit) return hit }
  return null
}

/**
 * A screenshot shrunk to a small JPEG (base64) with macOS `sips` or `ffmpeg` elsewhere,
 * so it fits a socket frame. Null when conversion fails. The temp files are gone on return.
 */
export async function shrinkScreenshot(b64: string, maxPx = 480): Promise<string | null> {
  const base = join(tmpdir(), `otto-shot-${randomBytes(4).toString('hex')}`)
  const [src, out] = [`${base}.img`, `${base}.jpg`]
  try {
    writeFileSync(src, Buffer.from(b64, 'base64'))
    const args = process.platform === 'darwin'
      ? ['sips', '-Z', String(maxPx), '-s', 'format', 'jpeg', '-s', 'formatOptions', '55', src, '--out', out]
      : ['ffmpeg', '-y', '-i', src, '-vf', `scale=w='min(iw,${maxPx})':h='min(ih,${maxPx})':force_original_aspect_ratio=decrease`, '-frames:v', '1', '-q:v', '8', out]
    const p = Bun.spawn(args, { stdout: 'ignore', stderr: 'ignore', timeout: 5000 })
    return (await p.exited) === 0 ? readFileSync(out).toString('base64') : null
  } catch {
    return null
  } finally {
    rmSync(src, { force: true })
    rmSync(out, { force: true })
  }
}

/** One line of the to-do list the model keeps while it works (Claude Code's TodoWrite). */
export type TodoItem = { text: string; status: 'pending' | 'in_progress' | 'completed' }

const TODO_STATUS = new Set(['pending', 'in_progress', 'completed'])

/**
 * The list a to-do tool call sets, or null when the call isn't one. TodoWrite sends the
 * whole list each time, so this is the list as it now stands; the item in progress reads
 * in its present-tense form ("Running the tests") when the call gives one.
 */
export function todoItems(tool: string, input: Record<string, unknown>): TodoItem[] | null {
  if (tool !== 'TodoWrite' || !Array.isArray(input.todos)) return null
  const out: TodoItem[] = []
  for (const t of input.todos.slice(0, 30)) {
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    const status = TODO_STATUS.has(String(o.status)) ? (o.status as TodoItem['status']) : 'pending'
    const raw = status === 'in_progress' && typeof o.activeForm === 'string' && o.activeForm.trim() ? o.activeForm : o.content
    const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
    if (text) out.push({ text, status })
  }
  return out
}

/**
 * The list the newer task tools (TaskCreate / TaskUpdate) keep: one `<id>.json` per task
 * in the session's own folder under ~/.claude/tasks, written by the tool as it runs.
 */
export function readTaskList(dir: string): TodoItem[] {
  let files: string[]
  try { files = readdirSync(dir).filter(f => /^\d+\.json$/.test(f)) } catch { return [] }
  const out: { n: number; item: TodoItem }[] = []
  for (const f of files) {
    try {
      const o = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>
      const status = TODO_STATUS.has(String(o.status)) ? (o.status as TodoItem['status']) : 'pending'
      const raw = status === 'in_progress' && typeof o.activeForm === 'string' && o.activeForm.trim() ? o.activeForm : o.subject
      const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
      if (text) out.push({ n: parseInt(f), item: { text, status } })
    } catch {} // a file mid-write: the next call reads it
  }
  return out.sort((x, y) => x.n - y.n).slice(0, 30).map(x => x.item)
}
