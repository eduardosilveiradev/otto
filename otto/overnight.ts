/** Owner-armed authority is separate from self-edit proof. Never changes origin. */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadState, saveState } from './statefile.ts'
import { effectiveOrigin, assertPipCreation, type OriginState } from './origin.ts'
import { readPlanUsage } from './usage.ts'
import { appendEntry, entryId, type CapEntry } from './changelog.ts'

export const OVERNIGHT_TOOLS = ['code_job', 'code_job_answer', 'reload', 'create_trigger', 'update_trigger', 'delete_trigger', 'pip_handoff', 'ask_approval']
export type OvernightAudit = Pick<CapEntry, 'tier'> & Partial<Pick<CapEntry, 'paths' | 'revert'>>
/** The action's policy tier; this describes the log, never gates an already-allowed tool. */
export function overnightTier(tool: string, args: Record<string, unknown> = {}): CapEntry['tier'] {
  if (tool === 'ask_approval') return 'guarded'
  if (tool === 'create_trigger' || tool === 'delete_trigger') return 'confirmed'
  if (tool === 'update_trigger' && Object.keys(args).some(k => !['id', 'action', 'schedule', 'tz'].includes(k))) return 'confirmed'
  return 'unattended'
}
type Window = { id: string; until: string; reserve: number; stopped?: boolean }
type State = { window?: Window; reserveUntil?: number; held: Record<string, number> }
export class Overnight {
  constructor(private dir: string, private now = Date.now) {}
  private get file() { return join(this.dir, 'overnight.json') }
  private read() { return loadState<State>(this.file, () => ({ held: {} }), x => !!x && !!(x as State).held && typeof (x as State).held === 'object' && !Array.isArray((x as State).held), { peek: true }) }
  active(): Window | undefined {
    const w = this.read().window
    return w && !w.stopped && Date.parse(w.until) > this.now() ? w : undefined
  }
  control(action: string, state: OriginState, insidePip: boolean, until?: unknown, reserve: unknown = 90) {
    if (action === 'status') return this.status()
    assertPipCreation(state, insidePip)
    const s = this.read(), replacedWindowId = action === 'start' ? this.active()?.id : undefined
    if (action === 'start') {
      if (typeof until !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(until) || !(Date.parse(until) > this.now())) throw new Error('until must be a future ISO datetime with timezone')
      if (Date.parse(until) - this.now() > 24 * 3600_000) throw new Error('until must be within 24 hours; choose an earlier deadline')
      if (typeof reserve !== 'number' || !Number.isFinite(reserve) || reserve <= 0 || reserve > 100) throw new Error('reserve must be greater than 0 and at most 100')
      s.window = { id: randomUUID(), until: new Date(until).toISOString(), reserve }
    } else if (action === 'stop') { if (s.window) s.window.stopped = true }
    else throw new Error('action must be start, stop or status')
    saveState(this.file, s)
    return { ...this.status(), ...(replacedWindowId ? { replacedWindowId } : {}) }
  }
  authorized(state: OriginState): string | undefined {
    if (effectiveOrigin(state) === 'external-content') return
    if (state.origin !== 'user-typed' && !['job', 'trigger', 'pr-merged'].includes(state.internalEvent ?? '')) return
    return this.active()?.id
  }
  log(tool: string, windowId: string, origin: ReturnType<typeof effectiveOrigin>, audit: OvernightAudit) {
    if (origin === 'user-typed') return
    appendEntry(join(this.dir, 'capability-log.json'), { id: entryId(), at: new Date(this.now()).toISOString(), by: 'overnight', windowId,
      what: `overnight ${tool}`, paths: audit.paths ?? [], tier: audit.tier, origin, revert: audit.revert ?? { kind: 'none', why: `${tool} completed under overnight window ${windowId}; no automatic undo` } })
  }
  /** A reached reserve latches until the recorded reset, even if the meter goes stale. */
  hold(key: string, model?: string): boolean {
    const s = this.read(), old = s.held[key]
    if (old && old > this.now() && !/gpt|codex/i.test(model ?? '')) return true
    const w = this.active(), meter = readPlanUsage(this.dir)?.five_hour
    if (!/gpt|codex/i.test(model ?? '') && w) {
      if (meter && meter.resets_at * 1000 > this.now() && meter.used_percentage >= w.reserve) s.reserveUntil = meter.resets_at * 1000
      if (s.reserveUntil && s.reserveUntil > this.now()) {
        s.held[key] = s.reserveUntil; saveState(this.file, s); return true
      }
    }
    if (old) { delete s.held[key]; saveState(this.file, s) }
    return false
  }
  status() {
    const s = this.read(), w = this.active()
    const actions = s.window ? loadState<CapEntry[]>(join(this.dir, 'capability-log.json'), () => [], Array.isArray, { peek: true }).filter(e => e.windowId === s.window!.id).length : 0
    const held = Object.values(s.held).filter(reset => reset > this.now()).length
    return { active: !!w, id: s.window?.id, until: s.window?.until, reserve: s.window?.reserve, actions, held }
  }
}
