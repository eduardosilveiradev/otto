/**
 * What changed about Otto, and how to put it back.
 *
 * Self-extension lets Otto install things. Installing without a written record is how
 * you get a Tuesday where the user asks why the morning brief now mentions the
 * weather and nobody — the user, Otto, git — can say when that started or what it
 * replaced. `git log` is the wrong record: it captures the diff and loses the
 * why, the provenance, and the fact that the change was Otto's idea.
 *
 * The load-bearing decision here is what a revert payload contains. A git sha
 * is the obvious answer and the wrong one: three weeks later the branch may
 * have been rebased, the worktree pruned, the object gc'd, or the file renamed
 * out from under the path — and the failure is silent, arriving exactly when the user
 * says "undo that" and expects it to work. So the payload carries the previous
 * bytes inline whenever they are small enough to carry, and falls back to a sha
 * only when they are not, and says so when it falls back. An entry that cannot
 * describe its own inverse is an entry that should not have been installed.
 *
 * Same shape as the `write` note kind in store.ts, one level up: that records
 * "I made you a calendar event, here is how to delete it", this records "I
 * changed myself, here is how to change back".
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { randomBytes } from 'crypto'
import type { Origin, Tier } from './selfedit.ts'

export type FileBefore = {
  path: string
  /** The bytes as they were. null means the file did not exist — revert deletes it. */
  before: string | null
}

export type RevertPayload =
  /** Fully self-contained: the previous bytes travel with the entry. */
  | { kind: 'restore-files'; files: FileBefore[] }
  /** Depends on the object still existing. Used only when the diff is too big. */
  | { kind: 'git-revert'; sha: string; paths: string[]; why: string }
  | { kind: 'delete-trigger'; triggerId: string }
  /** The whole trigger as it was, so an edit can be undone without git at all. */
  | { kind: 'restore-trigger'; trigger: Record<string, unknown> }
  /** A memory file's old bytes, and its old MEMORY.md line, put back without touching the rest of the index. */
  | { kind: 'restore-memory'; path: string; before: string; indexLine?: string }
  /** Honest about being irreversible. Rare, and worth seeing in the log. */
  | { kind: 'none'; why: string }

export type CapEntry = {
  windowId?: string
  id: string
  at: string
  /** One line, plain language, written for the user and not for a diff viewer. */
  what: string
  /** Repo sha at install time. Provenance, not the revert mechanism. */
  sha?: string
  paths: string[]
  tier: Tier
  origin: Origin
  /** Which self-extension module installed it — forge, repetition, canary, watchdog. */
  by: string
  revert: RevertPayload
  /** Set once the entry has been reverted, so the log can say so. */
  revertedAt?: string
}

export function entryId(): string {
  return randomBytes(4).toString('hex')
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function loadLog(file: string): CapEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as CapEntry[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Same policy as triggers.json and notes.json: a corrupt file must never
      // wedge an install, and must never be silently destroyed either — this
      // one especially, since it is the only copy of every revert payload.
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: capability-log corrupt, moved aside.\n')
    }
    return []
  }
}

export function saveLog(file: string, entries: CapEntry[]): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function appendEntry(file: string, entry: CapEntry): CapEntry[] {
  const entries = loadLog(file)
  entries.push(entry)
  saveLog(file, entries)
  return entries
}

export function markReverted(file: string, id: string, at: string): CapEntry | null {
  const entries = loadLog(file)
  const hit = entries.find(e => e.id === id)
  if (!hit) return null
  hit.revertedAt = at
  saveLog(file, entries)
  return hit
}

// ---------------------------------------------------------------------------
// Building a revert that survives
// ---------------------------------------------------------------------------

/** Per-file and per-entry inline caps. Beyond these the log stops being a log. */
export const INLINE_FILE_MAX = 64 * 1024
export const INLINE_TOTAL_MAX = 256 * 1024

/**
 * Choose the payload. Inline if it fits, sha if it does not, and never
 * pretend: the `why` on a git-revert payload is what gets shown to the user three
 * weeks later when the fallback is the reason the undo is best-effort.
 */
export function buildRevert(files: FileBefore[], sha?: string): RevertPayload {
  if (!files.length) return { kind: 'none', why: 'nothing was written' }

  const total = files.reduce((n, f) => n + (f.before?.length ?? 0), 0)
  const oversize = files.find(f => (f.before?.length ?? 0) > INLINE_FILE_MAX)

  if (!oversize && total <= INLINE_TOTAL_MAX) return { kind: 'restore-files', files }

  const why = oversize
    ? `${oversize.path} is ${oversize.before!.length} bytes — too big to carry inline`
    : `${total} bytes across ${files.length} files — too big to carry inline`
  if (!sha) return { kind: 'none', why: `${why}, and no sha was recorded` }
  return { kind: 'git-revert', sha, paths: files.map(f => f.path), why }
}

export type Resolution = {
  /** Concrete steps. Executable by a cold agent with no other context. */
  plan: string[]
  /** False when the plan depends on git objects that may not survive. */
  selfContained: boolean
  /** Shown to the user when the undo is best-effort or impossible. */
  caveat?: string
}

/**
 * Turn a payload into steps. Deliberately produces prose rather than running
 * anything: the revert path is the one path that must still work when the code
 * that would have run it is the thing being reverted.
 */
export function resolveRevert(entry: CapEntry): Resolution {
  const r = entry.revert
  if (entry.revertedAt) {
    return { plan: [], selfContained: true, caveat: `already reverted ${entry.revertedAt}` }
  }
  switch (r.kind) {
    case 'restore-files':
      return {
        selfContained: true,
        plan: r.files.map(f =>
          f.before === null
            ? `delete ${f.path} (it did not exist before this change)`
            : `write ${f.before.length} bytes back to ${f.path} (contents carried in capability-log entry ${entry.id})`,
        ),
      }
    case 'git-revert':
      return {
        selfContained: false,
        caveat: `best-effort: ${r.why}, so this needs commit ${r.sha.slice(0, 8)} to still exist`,
        plan: [`git checkout ${r.sha} -- ${r.paths.join(' ')}`],
      }
    case 'delete-trigger':
      return { selfContained: true, plan: [`delete trigger ${r.triggerId}`] }
    case 'restore-trigger':
      return {
        selfContained: true,
        plan: [`restore trigger ${String(r.trigger.id ?? '?')} to: ${JSON.stringify(r.trigger)}`],
      }
    case 'restore-memory':
      return { selfContained: true, plan: [`write ${r.before.length} bytes back to ${r.path}${r.indexLine ? ' and put its MEMORY.md line back' : ''}`] }
    case 'none':
      return { plan: [], selfContained: false, caveat: `cannot be undone automatically — ${r.why}` }
  }
}

/** One entry, for when the user asks about a specific id. */
export function formatEntry(e: CapEntry): string {
  const r = resolveRevert(e)
  const head = `[${e.id}] ${e.at.slice(0, 16).replace('T', ' ')} — ${e.what}`
  const meta = `  ${e.by}, ${e.tier} (${e.origin}), touched ${e.paths.join(', ')}`
  const undo = r.plan.length ? `  undo: ${r.plan.join('; ')}` : `  undo: ${r.caveat ?? 'nothing to do'}`
  return [head, meta, undo, ...(r.caveat && r.plan.length ? [`  note: ${r.caveat}`] : [])].join('\n')
}
