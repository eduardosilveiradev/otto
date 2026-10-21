/**
 * Which inputs have gone quiet, judged against their own rhythm.
 *
 * Every input Otto listens on (the desk watcher, the share sheet, the app's
 * socket and background refresh, each webhook source) is touched when it
 * speaks. A gap of 30 minutes or more between two touches is a "silence" and
 * is remembered for 14 days back from its last touch; what is normal for that input is twice the p90 of
 * its recent silences, never less than 6 hours. Past that, the input is quiet.
 *
 * A silence that ran past its own normal is an outage, not rhythm, so it is not
 * learned: otherwise one long outage would widen the threshold that was meant
 * to catch the next. An input is not judged until it has shown five silences.
 *
 * Nothing here ever sends a message. The result is one line in the brief and
 * one row in otto_status, evidence for when they ask why something seems off.
 * `phone.*` ids are reserved for a future phone self-report.
 */
import { statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { loadState, saveState } from './statefile.ts'

export type Silence = { ms: number; at: number }  // at = epoch ms the silence ended
export type InputRecord = { lastSeen: number; silences: Silence[] }
export type InputsState = { v: 1; inputs: Record<string, InputRecord> }
export type InputConfig = { minGapMs: number; windowMs: number; minSamples: number; multiplier: number; floorMs: number; maxSilences: number; maxInputs: number }

const H = 3_600_000
export const DEFAULTS: InputConfig = {
  minGapMs: 30 * 60_000, windowMs: 14 * 86_400_000, minSamples: 5, multiplier: 2, floorMs: 6 * H, maxSilences: 60, maxInputs: 32,
}
export const LABELS: Record<string, string> = {
  desk: 'desk watcher', share: 'share sheet', 'app.socket': 'app connections',
  'app.refresh': 'app background refresh', 'webhook.gmail': 'gmail push',
}
const label = (id: string) => LABELS[id] ?? id
const DESK_STALE_MS = 5 * 60_000  // desk.ts STALE_MS: older than this the watcher is not writing

// The window ends at the input's last sign of life, not at now: a dead input
// keeps the rhythm it had and stays flagged, and an outage longer than the
// window still ends against that rhythm instead of being learned as one.
const recent = (rec: InputRecord, now: number, cfg: InputConfig) =>
  rec.silences.filter(s => s.at >= Math.min(now, rec.lastSeen) - cfg.windowMs)

export function usualGapMs(rec: InputRecord, now: number, cfg = DEFAULTS): number | undefined {
  const ms = recent(rec, now, cfg).map(s => s.ms).sort((a, b) => a - b)
  if (ms.length < cfg.minSamples) return undefined
  const p90 = ms[Math.ceil(ms.length * 0.9) - 1]
  return Math.max(cfg.floorMs, cfg.multiplier * p90)
}

export function touch(st: InputsState, id: string, at: number, cfg = DEFAULTS): InputsState {
  const rec = st.inputs[id]
  if (!rec) {
    // ponytail: webhook sources are token-gated but external; the cap keeps the file bounded
    if (Object.keys(st.inputs).length >= cfg.maxInputs) return st
    return { ...st, inputs: { ...st.inputs, [id]: { lastSeen: at, silences: [] } } }
  }
  if (at <= rec.lastSeen) return st
  const gap = at - rec.lastSeen
  const usual = usualGapMs(rec, at, cfg)
  const learn = gap >= cfg.minGapMs && !(usual !== undefined && gap > usual)
  const silences = learn ? [...rec.silences, { ms: gap, at }].slice(-cfg.maxSilences) : rec.silences
  return { ...st, inputs: { ...st.inputs, [id]: { lastSeen: at, silences } } }
}

export type QuietInput = { id: string; label: string; quietMs: number; usualMs: number; lastSeen: number }

export function quietInputs(st: InputsState, now: number, cfg = DEFAULTS): QuietInput[] {
  const out: QuietInput[] = []
  for (const [id, rec] of Object.entries(st.inputs)) {
    const usualMs = usualGapMs(rec, now, cfg)
    if (usualMs !== undefined && now - rec.lastSeen > usualMs) out.push({ id, label: label(id), quietMs: now - rec.lastSeen, usualMs, lastSeen: rec.lastSeen })
  }
  return out.sort((a, b) => b.quietMs - a.quietMs)
}

// status.ts imports this module, so it cannot lend us its ago().
export function span(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`
}

/**
 * Deliberately `Quiet — …` and never `Quiet: …`: brief.ts sectionLabels() turns
 * every `Label:` line into a watchdog-tracked section, and a line that appears
 * and then clears would raise "part of my daily picture has gone dark".
 */
export function formatQuietLine(q: QuietInput[]): string | undefined {
  if (!q.length) return undefined
  const named = q.slice(0, 3).map(i => `${i.label} silent ${span(i.quietMs)} (usual gap under ${span(i.usualMs)})`)
  if (q.length > 3) named.push(`+${q.length - 3} more`)
  return `Quiet — ${named.join('; ')}`
}

export function inputsStatus(st: InputsState, now: number, cfg = DEFAULTS): { verdict: 'up' | 'degraded' | 'unknown'; at?: number; detail: string } {
  const entries = Object.entries(st.inputs)
  const judged = entries.filter(([, r]) => usualGapMs(r, now, cfg) !== undefined)
  if (!judged.length) {
    const learning = entries.map(([id, r]) => `${id} ${recent(r, now, cfg).length}/${cfg.minSamples} silences`)
    return { verdict: 'unknown', detail: `learning: ${learning.join(', ') || 'no inputs seen yet'}` }
  }
  const quiet = new Map(quietInputs(st, now, cfg).map(q => [q.id, q]))
  const detail = entries.map(([id, r]) => {
    const q = quiet.get(id)
    if (q) return `${q.label} last seen ${span(now - r.lastSeen)} ago, usual gap under ${span(q.usualMs)} — QUIET`
    if (usualGapMs(r, now, cfg) === undefined) return `${label(id)} learning (${recent(r, now, cfg).length}/${cfg.minSamples})`
    return `${label(id)} last seen ${span(now - r.lastSeen)} ago`
  }).join('; ')
  if (!quiet.size) return { verdict: 'up', detail }
  return { verdict: 'degraded', at: Math.max(...[...quiet.values()].map(q => q.lastSeen)), detail }
}

/** The desk watcher rewrites its state file while it runs; any state word (present, away, paused) counts as seen. */
export function observeDesk(st: InputsState, path: string, now: number, cfg = DEFAULTS): InputsState {
  try {
    const mtime = statSync(path).mtimeMs
    return now - mtime <= DESK_STALE_MS ? touch(st, 'desk', mtime, cfg) : st
  } catch { return st }
}

const valid = (x: unknown) => !!x && typeof x === 'object' && (x as InputsState).v === 1 && !!(x as InputsState).inputs && typeof (x as InputsState).inputs === 'object'
const fresh = (): InputsState => ({ v: 1, inputs: {} })

export const loadInputs = (file: string, peek = false): InputsState => loadState(file, fresh, valid, { peek })
export const saveInputs = (file: string, st: InputsState): void => saveState(file, st)

/** The server's one-liner: note that an input just spoke. Never throws. */
export function recordInput(file: string, id: string, at = Date.now(), cfg = DEFAULTS): void {
  try {
    const st = loadInputs(file)
    const next = touch(st, id, at, cfg)
    if (next !== st) saveInputs(file, next)
  } catch (err) {
    process.stderr.write(`otto channel: inputs.json not updated: ${(err as Error).message}\n`)
  }
}

export function observeInputs(file: string, deskPath: string, now = Date.now()): void {
  try {
    const st = loadInputs(file)
    const next = observeDesk(st, deskPath, now)
    if (next !== st) saveInputs(file, next)
  } catch (err) {
    process.stderr.write(`otto channel: inputs.json not updated: ${(err as Error).message}\n`)
  }
}

export function briefLine(file: string, now = Date.now()): string | undefined {
  try { return formatQuietLine(quietInputs(loadInputs(file, true), now)) } catch { return undefined }
}

if (import.meta.main) {
  const dir = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
  console.log(inputsStatus(loadInputs(join(dir, 'inputs.json'), true), Date.now()).detail)
}
