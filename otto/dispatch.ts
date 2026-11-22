/**
 * The three tables server.ts and its seams dispatch through, as pure functions.
 *
 * Taps (taps.ts), scheduled chores (chores.ts) and tool provenance gates
 * (toolcalls.ts) each used to be a hand-written chain inside server.ts, where a
 * missing check or a forgotten try/catch was invisible. Here each is a table whose
 * row has to say how it is checked, and one function walks it. The tables live in
 * modules that import server.ts; these walkers do not, so a test can drive them.
 */
import { loadState, saveState } from './statefile.ts'

// ---------------------------------------------------------------------------
// Taps
// ---------------------------------------------------------------------------

/**
 * How the server knows it offered this exact button. Telegram only delivers data
 * from buttons the bot sent, but the app and WhatsApp hand over whatever text the
 * device sends, and a tap can land days after the offer was replaced.
 * - `check`: tested here before `run`; false answers `stale` and runs nothing.
 * - `inRun`: `run` refuses an unoffered tap itself; the string says how.
 * There is no unchecked row: a button the session writes must never run a server action.
 */
export type Offered<C> =
  | { check: (m: RegExpExecArray, ctx: C) => boolean; stale: string }
  | { inRun: string }

/** How long a recorded offer stays tappable. */
const OFFER_MS = 30 * 24 * 60 * 60 * 1000

function loadOffered(file: string): Record<string, number> {
  return loadState<Record<string, number>>(file, () => ({}), x => typeof x === 'object' && x !== null && !Array.isArray(x))
}

/**
 * Remember the exact data of buttons the server itself composed, for rows with no
 * state of their own that says what was offered. Never call it with session-written buttons.
 */
export function recordOffered(file: string, buttons: object[], now = Date.now()): void {
  const data = buttons.flatMap(b => 'data' in b && typeof b.data === 'string' && b.data ? [b.data] : [])
  if (!data.length) return
  // ponytail: one file rewritten per offer and pruned by age; fine at a few offers a day.
  const kept = Object.fromEntries(Object.entries(loadOffered(file)).filter(([, at]) => now - at < OFFER_MS))
  for (const d of data) kept[d] = now
  saveState(file, kept)
}

/** True when the server put this exact data on a button in the last 30 days. */
export function wasOffered(file: string, data: string, now = Date.now()): boolean {
  const offered = loadOffered(file)
  return Object.hasOwn(offered, data) && now - offered[data] < OFFER_MS
}

export type Tap<C> = {
  /** The data this verb answers to: a pattern, or one exact string. */
  match: RegExp | string
  offered: Offered<C>
  /** The line to show the user, or null when the session should handle the tap after all. */
  run: (m: RegExpExecArray, ctx: C) => string | null | Promise<string | null>
}

/** The row's match on this data, or null. */
export function tapMatch<C>(tap: Tap<C>, data: string): RegExpExecArray | null {
  return typeof tap.match === 'string'
    ? (data === tap.match ? Object.assign([data], { index: 0, input: data }) as RegExpExecArray : null)
    : tap.match.exec(data)
}

/** The first row whose `match` fits and whose run returns a line; null hands the tap to the session. */
export async function dispatchTap<C>(taps: Record<string, Tap<C>>, data: string, ctx: C): Promise<string | null> {
  for (const tap of Object.values(taps)) {
    const m = tapMatch(tap, data)
    if (!m) continue
    if ('check' in tap.offered && !tap.offered.check(m, ctx)) return tap.offered.stale
    const line = await tap.run(m, ctx)
    if (line !== null) return line
  }
  return null
}

// ---------------------------------------------------------------------------
// Scheduled chores
// ---------------------------------------------------------------------------

export type Chore = {
  /** Names the chore in the error log: `otto channel: <name> failed: …`. */
  name: string
  /** Starts the chore when it has come due. Called every tick, synchronously, in table order. */
  run: (now: number) => unknown
}

/**
 * One scheduler tick over the table. Each chore starts in order, so a chore that
 * must go before another (pulse before the job scheduler, the flush last) only
 * needs to sit above it. A throw or a rejection is logged under the chore's name
 * and never stops the rest of the tick. Chores guard their own overlap: a runner
 * that skipped a chore with a pending promise would stop it for good on one hang.
 */
export function runChores(chores: Chore[], now: number, log: (line: string) => void): void {
  for (const c of chores) {
    try {
      const out = c.run(now)
      if (out instanceof Promise) out.catch(err => log(`otto channel: ${c.name} failed: ${err}\n`))
    } catch (err) { log(`otto channel: ${c.name} failed: ${err}\n`) }
  }
}

/**
 * The in-memory cadence for the frequent chores: true once per `ms`, and true again
 * for any other row asking at the same `now`, so rows that share one gate fire together.
 */
export function every(ms: number, start = 0): (now: number) => boolean {
  let last = start
  return now => (now === last || now - last >= ms ? ((last = now), true) : false)
}

// ---------------------------------------------------------------------------
// Tool provenance gates
// ---------------------------------------------------------------------------

/** A refusal (returned to the session as the tool's result) or nothing. A gate may also throw. */
export type Gate<A, R> = (args: A) => R | undefined

/** The refusal for this call, from the one table every tool call passes through. */
export function gateFor<A, R>(gates: Record<string, Gate<A, R>>, tool: string, args: A): R | undefined {
  return Object.hasOwn(gates, tool) ? gates[tool](args) : undefined
}
