import { randomBytes } from 'crypto'
import { readFileSync, rmSync, writeFileSync } from 'fs'
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
 */

export type Step = { label: string; ts: string }
type Task = { taskId: string; steps: Step[]; screenshot?: string; done: boolean }

const MAX_STEPS = 100

export class LiveSteps {
  private task: Task | null = null
  private shotSent = true
  private dirty = false
  private pending = false
  private lastSent = -Infinity

  constructor(
    private send: (frame: string) => void,
    private now: () => number = Date.now,
    private schedule: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms) },
    private gap = 500,
  ) {}

  /** A tool call. Starts a task when none is running. */
  step(label: string): void {
    if (!label) return
    if (!this.task || this.task.done) {
      this.task = { taskId: randomBytes(4).toString('hex'), steps: [], done: false }
      this.shotSent = true
    }
    this.task.steps.push({ label, ts: new Date(this.now()).toISOString() })
    if (this.task.steps.length > MAX_STEPS) this.task.steps.shift()
    this.changed()
  }

  /** The latest screenshot, base64 JPEG. Dropped when no task is running. */
  screenshot(jpeg: string): void {
    if (!this.task || this.task.done) return
    this.task.screenshot = jpeg
    this.shotSent = false
    this.changed()
  }

  finish(): void {
    if (!this.task || this.task.done) return
    this.task.done = true
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

/**
 * The first image in a PostToolUse hook's tool_response, as base64. MCP results carry
 * { type: "image", data } and API-shaped ones { type: "image", source: { data } };
 * which one the hook sees isn't documented, so either will do.
 */
export function findImage(v: unknown, depth = 0): string | null {
  if (depth > 6 || v === null || typeof v !== 'object') return null
  if (Array.isArray(v)) {
    for (const x of v) { const hit = findImage(x, depth + 1); if (hit) return hit }
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
 * A screenshot shrunk to a small JPEG (base64) with macOS `sips`, so it fits a
 * socket frame. Null when sips isn't there (Linux) or fails, and the step list
 * simply goes without the image. The temp files are gone on return.
 */
export async function shrinkScreenshot(b64: string, maxPx = 480): Promise<string | null> {
  const base = join(tmpdir(), `otto-shot-${randomBytes(4).toString('hex')}`)
  const [src, out] = [`${base}.img`, `${base}.jpg`]
  try {
    writeFileSync(src, Buffer.from(b64, 'base64'))
    const p = Bun.spawn(['sips', '-Z', String(maxPx), '-s', 'format', 'jpeg', '-s', 'formatOptions', '55', src, '--out', out], { stdout: 'ignore', stderr: 'ignore', timeout: 5000 })
    return (await p.exited) === 0 ? readFileSync(out).toString('base64') : null
  } catch {
    return null
  } finally {
    rmSync(src, { force: true })
    rmSync(out, { force: true })
  }
}
