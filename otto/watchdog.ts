/**
 * The things that break without breaking anything.
 *
 * A dead calendar source looks exactly like an empty calendar. Both produce a
 * brief with no events in it and a cheerful "calendar clear", and the second
 * one is correct roughly six days a week, so nothing ever looks wrong. The user finds
 * out at the meeting the user missed. Same shape for an expired auth token (inbox
 * quiet), a dead voice daemon (replies silently arrive as text), a poller that
 * stopped long-polling (the user texts and nothing happens), a webhook that never
 * rebound after a restart (an integration stops arriving), and a brief section
 * that quietly stopped rendering.
 *
 * brief.ts already refuses to fake a section whose source errored — omitting it
 * rather than inventing one. That is the right call and it is exactly what
 * makes the degradation invisible: a missing section reads as a quiet day.
 * This watches for sections that go missing and stay missing.
 *
 * Two rules keep it from becoming its own noise source:
 *
 *   repair first    every probe that has an unattended fix gets it tried before
 *                   anyone is told. Most of these are a stale pid or a socket
 *                   nobody released.
 *   tell only what  a connector failing while `gog` covers it is not something
 *   they would notice   they would ever have seen. It is not worth a message.
 *
 * The probing itself is I/O and lives at the edges; what is here is which
 * evidence justifies which action.
 */

import { homedir } from 'os'
import { join } from 'path'

/**
 * The command that restarts Otto's own session, whichever supervisor keeps it
 * up (systemd, launchd or a plain pidfile): otto-ctl.sh already knows which.
 * OTTO_HOME is exported by run.sh; the plugin itself may be running from a
 * cache copy that has no scripts/ next to it.
 */
export function restartArgv(home = process.env.OTTO_HOME ?? join(homedir(), '.otto')): string[] {
  return ['bash', join(home, 'scripts', 'otto-ctl.sh'), 'restart']
}

export type ProbeName =
  | 'google-auth'
  | 'calendar-connector'
  | 'gmail-connector'
  | 'voice-daemon'
  | 'poller-lag'
  | 'webhook'
  | 'launchd'
  | 'brief-sections'
  | 'email-scan'

export type ProbeResult = {
  name: ProbeName
  ok: boolean
  /** One clause. Ends up in the message when it is worth sending. */
  detail?: string
  /**
   * Another path already covers this failure, so the user would not notice it.
   * The connector falling back to `gog` is the canonical case.
   */
  covered?: boolean
}

/** Per-probe memory across ticks. Lives in runtime.json; written by the caller. */
export type ProbeState = {
  name: ProbeName
  /** Epoch ms of the first consecutive failure. Cleared on any success. */
  failingSince?: number
  /** Repairs attempted for this failing streak. */
  repairs?: number
  /** Last time the user was told about this probe, so it is not told twice. */
  toldAt?: number
}

// ---------------------------------------------------------------------------
// Repairs
// ---------------------------------------------------------------------------

export type Repair = {
  argv: string[]
  /**
   * False when the fix needs a human — an OAuth consent screen cannot be
   * clicked by a cron job. Marking it honestly is what stops the watchdog from
   * "repairing" in a loop and never telling the user.
   */
  unattended: boolean
  why: string
}

/**
 * The scripted fix, or null when there is nothing safe to try.
 *
 * Deliberately narrow. A repair that restarts the session is the loudest thing
 * this file can do — it drops the process the user talks through — so it is reserved
 * for the two probes that mean the session is already not working.
 */
export function repairFor(name: ProbeName, ctx: { home?: string; account?: string; port?: number } = {}): Repair | null {
  switch (name) {
    case 'voice-daemon':
      // Killing it is the repair: server.ts respawns it on the next reply that
      // needs speech, and a wedged daemon is worse than an absent one.
      return { argv: ['pkill', '-f', 'voiced.py'], unattended: true, why: 'stale voice daemon; it respawns on demand' }
    case 'webhook':
      return {
        argv: ['sh', '-c', `lsof -ti tcp:${ctx.port ?? 4589} -sTCP:LISTEN | xargs -r kill`],
        unattended: true,
        why: 'the loopback port was still held by a dead process',
      }
    case 'poller-lag':
    case 'launchd':
      return {
        argv: restartArgv(ctx.home),
        unattended: true,
        why: 'the session is not talking to Telegram; restart it',
      }
    case 'google-auth':
      return {
        argv: ['gog', 'auth', 'login', '-a', ctx.account ?? 'you@example.com'],
        unattended: false,
        why: 'refreshing Google credentials needs a browser',
      }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Brief sections
// ---------------------------------------------------------------------------

export type BriefRebuild = { at: number; sections: string[] }

/** Below this it is a blip; at it, the source is gone. */
export const OMITTED_REBUILDS = 4

/**
 * Sections that used to render and have been missing for the last N rebuilds.
 *
 * The "used to render" half is what makes this safe: a section that has never
 * appeared is a section for a source the user does not use, and reporting those would
 * mean telling them weekly that they have no tasks configured.
 */
export function omittedSections(rebuilds: BriefRebuild[], n = OMITTED_REBUILDS): string[] {
  if (rebuilds.length < n + 1) return []
  const ordered = [...rebuilds].sort((a, b) => a.at - b.at)
  const tail = ordered.slice(-n)
  const earlier = ordered.slice(0, -n)

  const everSeen = new Set<string>()
  for (const r of earlier) for (const s of r.sections) everSeen.add(s)
  const inTail = new Set<string>()
  for (const r of tail) for (const s of r.sections) inTail.add(s)

  return [...everSeen].filter(s => !inTail.has(s)).sort()
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

/** Failures on these are things the user would eventually notice themselves. */
const NOTICEABLE: ProbeName[] = ['google-auth', 'poller-lag', 'launchd', 'brief-sections', 'webhook', 'email-scan']

/** A probe must be failing this long before anyone is told. Networks blip. */
export const GRACE_MS = 15 * 60_000
/** And it is told about at most this often, however long it stays broken. */
export const TELL_COOLDOWN_MS = 12 * 60 * 60_000

export type Action =
  | { kind: 'repair'; probe: ProbeName; repair: Repair }
  | { kind: 'tell'; probe: ProbeName; text: string }
  | { kind: 'wait'; probe: ProbeName; why: string }

export type Verdict = {
  actions: Action[]
  /** The states as they should be persisted after this tick. */
  states: ProbeState[]
  /** The single message to send, or null. */
  message: string | null
}

function stateFor(states: ProbeState[], name: ProbeName): ProbeState {
  return states.find(s => s.name === name) ?? { name }
}

/**
 * One tick. `results` is what the probes just said; `previous` is what they
 * said before. Pure — the caller runs the repairs it is handed and persists the
 * states it gets back, which keeps the "have we already tried this" bookkeeping
 * out of the plumbing and inside the tested part.
 *
 * `repairedThisTick` is how a two-phase tick reports back: probe, repair, probe
 * again, then call this a second time with the repaired names so a fix that
 * worked never becomes a message.
 */
export function decide(
  results: ProbeResult[],
  previous: ProbeState[],
  now: number,
  opts: { repairedThisTick?: ProbeName[]; graceMs?: number; cooldownMs?: number; maxRepairs?: number } = {},
): Verdict {
  const graceMs = opts.graceMs ?? GRACE_MS
  const cooldownMs = opts.cooldownMs ?? TELL_COOLDOWN_MS
  const maxRepairs = opts.maxRepairs ?? 2
  const repaired = new Set(opts.repairedThisTick ?? [])

  const actions: Action[] = []
  const states: ProbeState[] = []
  const tells: string[] = []

  for (const r of results) {
    const prev = stateFor(previous, r.name)

    if (r.ok) {
      // Success clears the streak entirely, including the told-at stamp: the
      // next failure is a new incident and deserves to be reported as one.
      states.push({ name: r.name })
      continue
    }

    const failingSince = prev.failingSince ?? now
    const repairs = prev.repairs ?? 0
    const next: ProbeState = { name: r.name, failingSince, repairs }

    // Before anything is attempted: a covered probe is not a fault. It is a
    // feature the user never switched on, and the only correct response is to leave
    // it alone. Checking this after the repair block meant the watchdog ran a
    // kill command on behalf of a disabled feature — twice, until the budget ran
    // out — against a port nobody had asked it to open.
    if (r.covered) {
      if (prev.toldAt) next.toldAt = prev.toldAt
      actions.push({ kind: 'wait', probe: r.name, why: 'another path covers it' })
      states.push(next)
      continue
    }

    const fix = repairFor(r.name)
    if (fix?.unattended && repairs < maxRepairs && !repaired.has(r.name)) {
      next.repairs = repairs + 1
      if (prev.toldAt) next.toldAt = prev.toldAt
      actions.push({ kind: 'repair', probe: r.name, repair: fix })
      states.push(next)
      continue
    }

    // Repair is impossible, exhausted, or was already tried and did not take.
    if (prev.toldAt) next.toldAt = prev.toldAt

    if (!NOTICEABLE.includes(r.name)) {
      actions.push({ kind: 'wait', probe: r.name, why: 'the user would not notice this one' })
      states.push(next)
      continue
    }
    if (now - failingSince < graceMs) {
      actions.push({ kind: 'wait', probe: r.name, why: 'inside the grace window' })
      states.push(next)
      continue
    }
    if (prev.toldAt && now - prev.toldAt < cooldownMs) {
      actions.push({ kind: 'wait', probe: r.name, why: 'already told the user' })
      states.push(next)
      continue
    }

    const text = describe(r, fix)
    next.toldAt = now
    actions.push({ kind: 'tell', probe: r.name, text })
    tells.push(text)
    states.push(next)
  }

  // Never two proactive messages about the same underlying thing: several dead
  // probes on one tick are usually one dead machine, and arrive as one message.
  return { actions, states, message: tells.length ? tells.join(' ') : null }
}

function describe(r: ProbeResult, fix: Repair | null): string {
  const what: Record<ProbeName, string> = {
    'google-auth': 'my google access stopped working',
    'calendar-connector': 'the calendar connector is down',
    'gmail-connector': 'the gmail connector is down',
    'voice-daemon': 'voice notes are text-only right now',
    'poller-lag': "I stopped receiving your messages for a while",
    launchd: 'my process kept dying',
    webhook: 'the local webhook stopped listening',
    'brief-sections': 'part of my daily picture has gone dark',
    'email-scan': 'my inbox checks have stalled',
  }
  const head = what[r.name]
  const detail = r.detail ? ` (${r.detail})` : ''
  const ask = fix && !fix.unattended ? ` — needs you: ${fix.argv.join(' ')}` : " — couldn't fix it myself"
  return `${head}${detail}${ask}.`
}

/** Turn omitted sections into the probe result the decision function expects. */
export function briefSectionsProbe(rebuilds: BriefRebuild[], n = OMITTED_REBUILDS): ProbeResult {
  const gone = omittedSections(rebuilds, n)
  return gone.length
    ? { name: 'brief-sections', ok: false, detail: `${gone.join(' and ')} missing ${n} rebuilds running` }
    : { name: 'brief-sections', ok: true }
}

// ---------------------------------------------------------------------------
// The repair guard and the record
// ---------------------------------------------------------------------------

/**
 * The only commands the watchdog may ever run unattended. Everything it does
 * must match one of these exactly; the docs list the same set (README,
 * "Watchdog repairs"), and a test keeps the two in step.
 *
 * The list is deliberately not derived from `repairFor`: a guard built from the
 * thing it guards approves whatever that thing grows into.
 */
const SAFE_REPAIRS: { argv: RegExp[]; }[] = [
  { argv: [/^pkill$/, /^-f$/, /^voiced\.py$/] },
  { argv: [/^sh$/, /^-c$/, /^lsof -ti tcp:\d{2,5} -sTCP:LISTEN \| xargs -r kill$/] },
  { argv: [/^bash$/, /^\/[^\s;&|`$]*\/scripts\/otto-ctl\.sh$/, /^restart$/] },
]

/** Config, secrets and the allowlist. Nothing the watchdog runs may name them. */
const PROTECTED = /access\.json|\.env\b|\.mcp\.json|settings(\.local)?\.json|telegram\.env|\.claude-plugin|\/launchd\/|LaunchAgents|\.plist\b|otto\.service|systemd/i

export function isSafeRepair(r: Repair): { ok: boolean; why: string } {
  if (!r.unattended) return { ok: false, why: 'needs a human' }
  if (r.argv.some(a => PROTECTED.test(a))) return { ok: false, why: 'names a config or secret file' }
  const hit = SAFE_REPAIRS.some(s => s.argv.length === r.argv.length && s.argv.every((re, i) => re.test(r.argv[i])))
  return hit ? { ok: true, why: 'a documented repair' } : { ok: false, why: 'not one of the documented repairs' }
}

/**
 * Run the repairs a verdict asks for, in the order that survives the process
 * dying halfway.
 *
 * The session-restart repairs kill the very process executing this, so
 * everything that must outlive them is written first: the repair budget (or the
 * cap never holds and a wedged poller is restarted every tick) and, per repair,
 * its capability-log entry (or the most drastic repair is the one never
 * recorded). Returns the probes whose repair command was actually run.
 */
export async function executeRepairs(
  verdict: Verdict,
  ctx: { home?: string; account?: string; port?: number },
  io: {
    save: (states: ProbeState[]) => void
    log: (entry: import('./changelog.ts').CapEntry) => void
    run: (argv: string[]) => Promise<boolean>
    now: () => string
    id: () => string
  },
): Promise<ProbeName[]> {
  io.save(verdict.states)
  const ran: ProbeName[] = []
  for (const a of verdict.actions) {
    if (a.kind !== 'repair') continue
    const repair = repairFor(a.probe, ctx)
    if (!repair) continue
    const safe = isSafeRepair(repair)
    try { io.log(repairLogEntry(a.probe, repair, { ran: safe.ok }, io.now(), io.id())) } catch {}
    if (!safe.ok) continue
    try { await io.run(repair.argv); ran.push(a.probe) } catch {}
  }
  return ran
}

/**
 * What to write in capability-log.json for a repair, before it runs. Restarting a
 * component has no byte-level inverse, so the entry says what the inverse would
 * be instead of pretending to carry one: the state before was "down", and
 * putting it back is a matter of stopping the process, which nobody wants.
 * Recorded with the ceiling of a fired trigger — the watchdog writes no files,
 * so its `paths` are empty and the tier is `unattended`.
 */
export function repairLogEntry(
  probe: ProbeName,
  repair: Repair,
  outcome: { ran: boolean },
  at: string,
  id: string,
): import('./changelog.ts').CapEntry {
  const cmd = repair.argv.join(' ')
  return {
    id,
    at,
    what: `watchdog: ${probe} was failing — ${outcome.ran ? 'running' : 'declined to run'} \`${cmd}\` (${repair.why})`,
    paths: [],
    tier: 'unattended',
    origin: 'triggered',
    by: 'watchdog',
    revert: {
      kind: 'none',
      why: `a restart has no inverse; the component was already ${probe === 'voice-daemon' ? 'wedged' : 'down'}. To undo, stop it again: ${
        probe === 'voice-daemon' ? 'pkill -f voiced.py (it respawns on demand)' : 'restart the session'
      }`,
    },
  }
}
