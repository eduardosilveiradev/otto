import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
/**
 * What Otto is allowed to change about Otto.
 *
 * Self-extension hands the assistant a pen and points it at its own source. Everything
 * else in self-extension — the forge, the miner, the changelog, the canary — is a
 * way of producing a diff; this is the only thing standing between a produced
 * diff and a written file.
 *
 * The failure it exists to prevent is not carelessness. Carelessness is a
 * property of one turn, and one turn is exactly what an attacker gets to write:
 * a session that has spent forty minutes reading email is a session whose
 * judgement has been under someone else's influence for forty minutes. So the
 * decision cannot be made by the part of the system that read the email.
 *
 * Hence: the tier is a pure function of the paths touched and the PROVENANCE of
 * the request, and provenance is stamped by server.ts when it wakes the session
 * — never claimed by the model. This is the same trick as `src` in ledger.ts.
 * Attribution the assistant reports is attribution an attacker can forge.
 *
 * Two independent locks, so that neither has to be perfect:
 *
 *   origin ceiling   a fired trigger tops out at `unattended`; no wording in
 *                    its action text raises that, because the ceiling is read
 *                    off the event, not off the sentence.
 *   typed phrase     `guarded` additionally needs the user to type a specific
 *                    sentence, which closes the case where Otto — already
 *                    influenced — offers the user a mislabelled button to tap.
 *
 * SELFEDIT.md is the prose version and the two must agree. Both are `guarded`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Who is really asking. Stamped by the server from the waking event. */
export type Origin =
  /** The user typed it, spoke it, or tapped a button. */
  | 'user-typed'
  /** Otto's own idea mid-conversation; the user is present but has not approved it. */
  | 'model-authored'
  /** A fired trigger or a scheduled scan. Nobody is in the loop this second. */
  | 'triggered'
  /** Contains email (including scans and mail attachments) or a webhook. */
  | 'external-content'

export type Tier =
  /** Write it and say nothing. */
  | 'unattended'
  /** One tapped button, on a change the user was shown. */
  | 'confirmed'
  /** An explicit typed phrase, on a turn the server stamped `user-typed`. */
  | 'guarded'

export type Proof =
  | { kind: 'none' }
  | { kind: 'tapped'; buttonData: string }
  /** `paths`, when set, is all it clears: an app approval covers the files its screen listed and nothing else. */
  | { kind: 'typed'; text: string; paths?: string[] }

export type Decision = {
  /** What this change requires. */
  tier: Tier
  /** The highest tier `origin` can ever reach, proof or no proof. */
  ceiling: Tier | null
  /** Whether the supplied proof actually clears the bar. */
  allowed: boolean
  /** One line, written to be quoted back to the user verbatim. */
  reason: string
  /** The paths that set the tier — the evidence for `reason`. */
  because: string[]
}

const RANK: Record<Tier, number> = { unattended: 0, confirmed: 1, guarded: 2 }

/**
 * The ceiling is the load-bearing half of the design. `triggered` stopping at
 * `unattended` is what makes "a fired trigger can never edit the send path" a
 * property of the system rather than an instruction the model may forget.
 */
const CEILING: Record<Origin, Tier | null> = {
  'user-typed': 'guarded',
  'model-authored': 'confirmed',
  triggered: 'unattended',
  'external-content': null,
}

/**
 * The user types this, exactly, for a `guarded` change. Deliberately a sentence and
 * not a word: "yes" is something the user says twenty times a day and something Otto
 * can talk them into, whereas retyping a sentence they did not compose is an act
 * of authorship that an injected instruction cannot perform on the user’s behalf.
 */
export const TYPED_PHRASE = 'i approve the otto core change'

export function matchesTypedPhrase(text: string): boolean {
  return text.toLowerCase().replace(/[^a-z ]+/g, '').replace(/\s+/g, ' ').trim() === TYPED_PHRASE
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Rules are matched against the NORMALISED, LOWER-CASED path (the Mac's disk is
 * case-insensitive, so `otto/Server.ts` is `otto/server.ts`) and anchored with `(^|/)`, so
 * one rule covers both `otto/server.ts` and the absolute form. Order matters:
 * first match wins, so the narrow guarded rules sit above the broad ones.
 */
type Rule = { re: RegExp; tier: Tier; why: string }

const RULES: Rule[] = [
  // --- guarded: the channel, the rails, the credentials, the boot path ------
  { re: /(^|\/)otto\/server\.ts$/, tier: 'guarded', why: 'the channel and the send path' },
  { re: /(^|\/)otto\/toolcalls\.ts$/, tier: 'guarded', why: 'the tool handlers and their provenance gates' },
  { re: /(^|\/)otto\/http\.ts$/, tier: 'guarded', why: 'the webhook and the app\'s authenticated routes' },
  { re: /(^|\/)otto\/taps\.ts$/, tier: 'guarded', why: 'taps the server carries out with proof of a tap' },
  { re: /(^|\/)otto\/chores\.ts$/, tier: 'guarded', why: 'what the server starts on its own, installs and sweeps included' },
  { re: /(^|\/)otto\/dispatch\.ts$/, tier: 'guarded', why: 'the walkers that apply the gates and offer checks' },
  { re: /(^|\/)otto\/tools\.ts$/, tier: 'guarded', why: 'the tool descriptions the session acts on' },
  { re: /(^|\/)otto\/(queue|send|delivery|buttons)\.ts$/, tier: 'guarded', why: 'the hold policy — what reaches you and when' },
  { re: /(^|\/)otto\/(tests\/)?selfedit\.(ts|test\.ts)$/, tier: 'guarded', why: 'the self-edit rails themselves' },
  { re: /(^|\/)selfedit\.md$/, tier: 'guarded', why: 'the self-edit rails themselves' },
  { re: /(^|\/)access\.json$/, tier: 'guarded', why: 'the Telegram allowlist' },
  { re: /(^|\/)\.env$/, tier: 'guarded', why: 'secrets' },
  { re: /(^|\/)bot\.pid$/, tier: 'guarded', why: 'the poller claim' },
  { re: /(^|\/)run\.sh$/, tier: 'guarded', why: 'the session boot path' },
  { re: /(^|\/)otto\/(session-loop\.sh|tmux\.conf|restart\.ts)$/, tier: 'guarded', why: 'run.sh executes it' },
  { re: /(^|\/)templates\/otto\.(service|plist)\.template$/, tier: 'guarded', why: 'the service definition' },
  { re: /(^|\/)scripts\/(install|uninstall|otto-ctl|migrate-state)\.sh$/, tier: 'guarded', why: 'the install and service path' },
  { re: /(^|\/)scripts\/allow-channel-plugin\.sh$/, tier: 'guarded', why: 'the channel-plugin permission' },
  { re: /(^|\/)\.claude-plugin\//, tier: 'guarded', why: 'the plugin manifest' },
  { re: /(^|\/)otto\/(package\.json|bun\.lock)$/, tier: 'guarded', why: 'the dependency supply chain' },
  { re: /(^|\/)otto\/\.mcp\.json$/, tier: 'guarded', why: 'the MCP server wiring' },
  { re: /(^|\/)\.claude\/settings(\.local)?\.json$/, tier: 'guarded', why: 'harness permissions' },
  // The rest of the rails: who a request is from, how installs run, who holds a token.
  { re: /(^|\/)otto\/(origin|overnight|forge|supervisor|headless|jobs|redact|apptokens|pairing|dash|capability)\.ts$/, tier: 'guarded', why: 'the safety rails and the credentials' },
  { re: /(^|\/)hooks(\/|\.json$)/, tier: 'guarded', why: 'hooks run shell on every tool call' },
  { re: /(^|\/)node_modules\//, tier: 'guarded', why: 'the dependency supply chain' },
  { re: /(^|\/)\.claude\/(agents|commands|plugins|skills)\//, tier: 'guarded', why: 'it changes every Claude session on this machine' },
  { re: /(^|\/)\.claude\/claude\.md$/, tier: 'guarded', why: 'it changes every Claude session on this machine' },

  // --- confirmed: prose, recipes, and the rest of the module tree -----------
  { re: /(^|\/)\.claude\/memory\//, tier: 'confirmed', why: 'durable memory' },
  { re: /(^|\/)(claude|readme|agents)\.md$/, tier: 'confirmed', why: 'standing instructions' },
  { re: /(^|\/)otto\/skills\//, tier: 'confirmed', why: 'a recipe or skill' },
  { re: /(^|\/)otto\/[^/]+\.ts$/, tier: 'confirmed', why: 'an Otto module' },
  { re: /(^|\/)otto\//, tier: 'confirmed', why: 'Otto internals' },
  { re: /(^|\/)scripts\//, tier: 'confirmed', why: 'a repo script' },
  // The /settings page. Pseudo-paths minted only by otto/settings.ts, each
  // naming one field; an id the page does not mint falls through to guarded.
  { re: /^setting:(scan|quiet|voice|busy|trigger-[a-z0-9-]+)$/i, tier: 'confirmed', why: 'a switch on the settings page' },
  { re: /^connector:[^/]+$/, tier: 'confirmed', why: 'an MCP server on/off switch' },

  // --- unattended: the parameter surface -----------------------------------
  // Not files. server.ts passes these pseudo-paths so that a price-watch
  // updating its own remembered value goes through the same one door.
  { re: /^trigger:[a-z0-9]+\/(action|schedule|tz)$/i, tier: 'unattended', why: 'trigger parameters' },
  { re: /^recipe-param:/, tier: 'unattended', why: 'recipe parameters' },
]

/**
 * Collapse `.`, `..`, duplicate separators and a `~` prefix, so that
 * `otto/../otto/server.ts` and `./otto/server.ts` cannot dodge a rule that
 * `otto/server.ts` matches. A path that climbs above its own root keeps the
 * leading `..`, which tierForPath refuses before any rule — which is the point.
 */
export function normalizePath(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/')
  const absolute = p.startsWith('/')
  if (p.startsWith('~/')) p = p.slice(2)
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else out.push('..')
      continue
    }
    out.push(seg)
  }
  return (absolute ? '/' : '') + out.join('/')
}

/** The repo this file lives in. An absolute or ~ path outside it is guarded, whatever it looks like. */
const REPO_ROOT = normalizePath(join(import.meta.dir, '..')).toLowerCase()

/** The tier one path demands, and the sentence explaining why. */
export function tierForPath(raw: string): { tier: Tier; why: string } {
  let p = normalizePath(raw).toLowerCase()
  if (!p) return { tier: 'guarded', why: 'an empty path' }
  const t = raw.trim()
  // Rules see the repo-relative path: on a home like /test-home/otto, `(^|/)otto/` would match the home dir itself.
  if (p.startsWith(REPO_ROOT + '/')) p = p.slice(REPO_ROOT.length + 1)
  else if ((t.startsWith('/') || t.startsWith('~')) && !/(^|\/)\.claude\/memory\//.test(p)) {
    return { tier: 'guarded', why: 'outside the Otto repo' }
  }
  // Before the rules: `../other/scripts/x.sh` is not this repo's scripts/.
  if (p.startsWith('..')) return { tier: 'guarded', why: 'outside every path Otto is supposed to touch' }
  for (const r of RULES) {
    if (r.re.test(p)) return { tier: r.tier, why: r.why }
  }
  // Fail closed. A path nobody has thought about is more likely to be a rename
  // that outran this table than something genuinely harmless, and the cost of
  // being wrong in the two directions is not remotely symmetrical.
  return { tier: 'guarded', why: 'a path no rule names' }
}

/** One spelling per file: relative paths are the repo's, `~` is home, case folded. */
function pathKey(raw: string): string {
  const t = raw.trim().replace(/\\/g, '/')
  return normalizePath(resolve(REPO_ROOT, t.startsWith('~/') ? join(homedir(), t.slice(2)) : t)).toLowerCase()
}

/** The file a Write/Edit/NotebookEdit hook call touches, absolute: a relative one is the session's cwd's, not the repo's. */
export function hookPath(h: { cwd?: unknown; tool_input?: Record<string, unknown> } | undefined): string {
  const p = String(h?.tool_input?.file_path ?? h?.tool_input?.notebook_path ?? '').trim()
  return p && !p.startsWith('/') && !p.startsWith('~') && typeof h?.cwd === 'string' ? join(h.cwd, p) : p
}

/**
 * The state files a session Write may not touch freely: the allowlist, secrets, the poller claim, the origin stamp with its proof,
 * the address the write hook asks, the app's token hashes (a token approves in the app), forge drafts and the capability log
 * (an install tap installs the draft's files as stored, a revert writes an entry's undo bytes back), the T3 tokens (minted by
 * the server) and the app release key (the owner's release script writes it; it keeps the IPA off the open internet).
 * The server writes all of these itself, which this hook never sees.
 */
const STATE_GATED = /^(access\.json|\.env|bot\.pid|origin\.json|status-url|app-tokens\.json|app-token|forge\/.*|capability-log\.json|t3-token|t3-usage-token|app-release\/key)$/

/**
 * How the session's own Write or Edit of `abs` is gated (the PreToolUse hook,
 * hooks/selfedit-gate.ts):
 *
 *   'gated'    classify() decides: anything in the repo, STATE_GATED in the
 *              state dir, and under ~/.claude what a guarded rule names
 *              (settings, hooks, skills, agents, plugins, CLAUDE.md)
 *   'routine'  every other state file (triggers, boards, backups): written
 *              freely, except by a request
 *              that read outside content, since the server re-reads them as
 *              instructions and undo payloads
 *   null       not the gate's business, memory included
 *
 * Rules see the path relative to home, never the absolute one.
 */
export function writeScope(abs: string, stateDir: string, home: string): 'gated' | 'routine' | null {
  const p = pathKey(abs)
  const rel = (root: string) => { const r = pathKey(root) + '/'; return p.startsWith(r) ? p.slice(r.length) : null }
  const s = rel(stateDir)
  if (s !== null) return STATE_GATED.test(s) ? 'gated' : 'routine'
  if (rel(REPO_ROOT) !== null || (process.env.OTTO_HOME && rel(process.env.OTTO_HOME) !== null)) return 'gated'
  const h = rel(home)
  return h !== null && h.startsWith('.claude/') && RULES.some(r => r.tier === 'guarded' && r.re.test(h)) ? 'gated' : null
}

/** The maximum over all touched paths. One guarded file guards the change. */
export function requiredTier(paths: string[]): { tier: Tier; because: string[] } {
  if (!paths.length) return { tier: 'unattended', because: [] }
  let tier: Tier = 'unattended'
  const seen: string[] = []
  for (const p of paths) {
    const hit = tierForPath(p)
    if (RANK[hit.tier] > RANK[tier]) {
      tier = hit.tier
      seen.length = 0
    }
    if (hit.tier === tier) seen.push(`${normalizePath(p)} — ${hit.why}`)
  }
  return { tier, because: seen }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Does this proof actually clear this tier, from this origin?
 *
 * A tap is enough for `confirmed` and never enough for `guarded`. That gap is
 * where the second lock lives: buttons are authored by Otto, and Otto may have
 * been reading something hostile when it wrote the label.
 */
function satisfied(tier: Tier, origin: Origin, proof: Proof, paths: string[]): boolean {
  if (tier === 'unattended') return origin !== 'external-content'
  if (origin !== 'user-typed') return false
  if (!covers(proof, paths)) return false
  if (tier === 'confirmed') return proof.kind === 'tapped' || proof.kind === 'typed'
  return proof.kind === 'typed' && matchesTypedPhrase(proof.text)
}

/** A proof scoped to paths clears only those paths. */
function covers(proof: Proof, paths: string[]): boolean {
  if (proof.kind !== 'typed' || !proof.paths) return true
  const ok = new Set(proof.paths.map(pathKey))
  return paths.every(p => ok.has(pathKey(p)))
}

/**
 * The one entry point. Pure: no clock, no filesystem, no network — so the
 * policy can be exercised exhaustively in tests instead of in production.
 */
export function classify(paths: string[], origin: Origin, proof: Proof = { kind: 'none' }): Decision {
  const { tier, because } = requiredTier(paths)
  const ceiling = CEILING[origin]
  const withinCeiling = ceiling !== null && RANK[tier] <= RANK[ceiling]
  const allowed = withinCeiling && satisfied(tier, origin, proof, paths)

  return { tier, ceiling, allowed, because, reason: explain(tier, origin, ceiling, withinCeiling, proof, because, covers(proof, paths)) }
}

function explain(
  tier: Tier,
  origin: Origin,
  ceiling: Tier | null,
  withinCeiling: boolean,
  proof: Proof,
  because: string[],
  covered: boolean,
): string {
  const head = because[0] ?? 'nothing'
  if (origin === 'external-content') {
    return `refused: this came from outside content, which can propose but never install. Touches ${head}.`
  }
  if (!withinCeiling) {
    return `refused: a ${origin} request tops out at ${ceiling}, and this needs ${tier} — ${head}.`
  }
  if (tier !== 'unattended' && !covered) {
    return `refused: the approval covered other files, not this one. Ask again for ${head}.`
  }
  if (tier === 'guarded' && proof.kind !== 'typed') {
    return `needs the typed phrase "${TYPED_PHRASE}" — ${head}.`
  }
  if (tier === 'guarded') {
    return matchesTypedPhrase((proof as { text: string }).text)
      ? `cleared: typed confirmation for ${head}.`
      : `refused: that is not the phrase. Type "${TYPED_PHRASE}" — ${head}.`
  }
  if (tier === 'confirmed' && proof.kind === 'none') {
    return `needs one tap — ${head}.`
  }
  if (tier === 'confirmed') return `cleared: confirmed change to ${head}.`
  return because.length ? `unattended: ${head}.` : 'unattended: nothing to guard.'
}

/** Shown alongside a draft so the tap is informed rather than reflexive. */
export function describeTier(tier: Tier): string {
  if (tier === 'unattended') return 'parameter change — no confirmation needed'
  if (tier === 'confirmed') return 'needs one tap'
  return `needs you to type "${TYPED_PHRASE}"`
}
