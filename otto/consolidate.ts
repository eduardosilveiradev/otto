#!/usr/bin/env bun
/**
 * Nightly memory consolidation.
 *
 * Claude Code writes a transcript per session and then forgets it. claude.ai
 * distils conversations into memory on its own; Claude Code never has. The
 * previous answer here was a Stop hook that fired after every single turn,
 * paying an indexing cost 200 times a day to capture facts that were often not
 * yet true — mid-task guesses, abandoned approaches, things the user corrected
 * two turns later.
 *
 * Doing it once a night instead is strictly better: a whole thread has an
 * ending, so what mattered is legible in a way it never is mid-conversation,
 * and the per-turn cost is zero.
 *
 * Shape:
 *   1. Find transcripts touched since the last run.
 *   2. Extract the conversational spine — user text and assistant prose only.
 *      Tool calls and their results are 90%+ of the bytes and almost none of
 *      the meaning.
 *   3. Write those digests to a scratch dir.
 *   4. Spawn ONE fresh headless session pointed at them, with a tight tool
 *      allowlist, to write durable memories.
 *
 * The spawned session is deliberately blank: no channel, no queue, no inherited
 * conversation. It gets the digests and the memory tools and nothing else.
 *
 * CLI: `bun otto/consolidate.ts [--dry-run] [--since <ISO>]`
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { claudeBin, headlessMcpArgs } from './headless.ts'
import { loadBurned, burnedMatcher } from './burn.ts'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
/** Hashes of messages the user burned; any entry containing one never reaches a digest. */
const BURNED_FILE = join(process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'), 'burned.json')

export type Turn = { role: 'user' | 'assistant'; text: string }
export type Digest = {
  sessionId: string
  project: string
  started?: string
  ended?: string
  turns: Turn[]
}

/** Per-turn and per-session caps. A thread's meaning survives truncation; a
 * 5MB transcript in the context window does not. */
const TURN_MAX = 700
const SESSION_MAX_TURNS = 120
const SESSION_MAX_CHARS = 14_000

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as { type?: string; text?: string }[]) {
    // Prose only. thinking is internal, tool_use is mechanism, and tool_result
    // is where the megabytes live.
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Channel events arrive as a tagged envelope; keep the payload, drop the XML. */
function unwrapChannel(text: string): string {
  const m = /^<channel[^>]*>([\s\S]*?)<\/channel>$/.exec(text.trim())
  return m ? m[1].trim() : text
}

/**
 * Sessions that a machine started, not a person.
 *
 * Two reasons to drop these. The first is self-preservation: without it the job
 * eats its own tail — last night's consolidation leaves a transcript, tonight's
 * run finds it, and it distils memories out of the act of distilling memories.
 * The second is cost. The first real pass read 32 digests and found 22 of them
 * were machine chatter: 16 mnemosyne distiller runs, 5 title generators, and
 * one of its own. Two thirds of the tokens bought nothing.
 *
 * Matched against the FIRST user turn only, never against the whole thread. A
 * genuine session that merely *discusses* consolidation — the one that built
 * this file, for instance — must not be mistaken for a run of it.
 */
const META_MARKERS = [
  'consolidating yesterday',                              // this job
  'distilling DURABLE memories',                          // mnemosyne's distiller
  'Generate a title that will help the user recognize',   // thread title generation
]
/** cwd of a spawned run, and therefore its transcript's project slug. */
const SELF_SLUG = 'channels-otto-digests'

function isMachineSession(turns: Turn[]): boolean {
  const firstUser = turns.find(t => t.role === 'user')
  if (!firstUser) return false
  const head = firstUser.text.slice(0, 300)
  return META_MARKERS.some(m => head.includes(m))
}

export function digestTranscript(path: string, project: string, isBurned: (text: string) => boolean = () => false): Digest | null {
  if (project.includes(SELF_SLUG)) return null
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return null }

  const turns: Turn[] = []
  let started: string | undefined
  let ended: string | undefined
  let chars = 0

  for (const line of raw.split('\n')) {
    if (!line) continue
    let d: Record<string, unknown>
    try { d = JSON.parse(line) } catch { continue }

    const type = d.type as string | undefined
    if (type !== 'user' && type !== 'assistant') continue
    // Subagent chatter is not the user's conversation.
    if (d.isSidechain === true) continue
    if (d.isMeta === true) continue

    const ts = d.timestamp as string | undefined
    if (ts) { started ??= ts; ended = ts }

    const message = d.message as { content?: unknown } | undefined
    let text = textOf(message?.content).trim()
    if (!text) continue
    // Before unwrapping and truncation: the secret may sit past the cut.
    if (isBurned(text)) continue
    text = unwrapChannel(text)
    if (!text) continue
    if (text.length > TURN_MAX) text = text.slice(0, TURN_MAX) + '…'

    turns.push({ role: type, text })
    chars += text.length
    if (turns.length >= SESSION_MAX_TURNS || chars >= SESSION_MAX_CHARS) break
  }

  // A session with nothing but tool traffic has nothing to remember.
  if (turns.length < 2) return null
  // Belt and braces on the self-exclusion: a run started from another cwd would
  // slip past the slug check, but its opening prompt still gives it away.
  if (isMachineSession(turns)) return null
  return {
    sessionId: basename(path, '.jsonl'),
    project,
    ...(started ? { started } : {}),
    ...(ended ? { ended } : {}),
    turns,
  }
}

/** Transcripts whose file changed since `since`, newest first. */
export function transcriptsSince(since: number, root = PROJECTS_DIR): { path: string; project: string; mtimeMs: number }[] {
  const out: { path: string; project: string; mtimeMs: number }[] = []
  let slugs: string[]
  try { slugs = readdirSync(root) } catch { return out }
  for (const slug of slugs) {
    const dir = join(root, slug)
    let files: string[]
    try { files = readdirSync(dir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const path = join(dir, f)
      try {
        const st = statSync(path)
        if (st.mtimeMs > since) out.push({ path, project: slug, mtimeMs: st.mtimeMs })
      } catch {}
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export function renderDigest(d: Digest): string {
  const head = [
    `# session ${d.sessionId}`,
    `project: ${d.project}`,
    ...(d.started ? [`started: ${d.started}`] : []),
    ...(d.ended ? [`ended: ${d.ended}`] : []),
    '',
  ]
  const body = d.turns.map(t => `## ${t.role}\n${t.text}`)
  return [...head, ...body].join('\n')
}

export const CONSOLIDATION_PROMPT = `You are consolidating yesterday's Claude Code sessions into durable memory. Nobody is watching this run; there is no one to report to and no message to send.

Digests of every session touched since the last run are in the directory named below. Each file is one session, stripped to the conversation — user prompts and assistant prose, no tool traffic.

Do this:

1. Read every digest file in that directory. They are already truncated; read them whole.
2. For each session, ask what a competent colleague would still need to know in a month. Durable things only:
   - who they are, how they work, what they have decided (type "user")
   - corrections they gave, preferences they stated, ways of working they confirmed (type "feedback")
   - ongoing work, goals, constraints not derivable from the code or git history (type "project")
   - pointers to external resources — URLs, dashboards, tickets (type "reference")
3. Before writing anything, call recall with a distinctive word from the candidate fact. If a memory already covers it, UPDATE it by writing to the same name rather than adding a near-duplicate. The corpus already carries duplicate pairs from an old rename; do not add more.
4. Write with remember, one fact per memory, description as a single line that reads like an index entry. Set scope to the project slug the session belonged to, unless the fact is true of the user everywhere, which is scope "global".

Do NOT record:
- anything the code, git history or CLAUDE.md already states
- what happened mechanically in a session ("fixed a bug in server.ts") — that is what git is for
- anything the user corrected or abandoned later in the same thread
- transient state: what was running, what was mid-edit, what the date was

If you check the machine's current state to corroborate something, hold that to a higher bar than the transcripts, because a confident claim about the filesystem gets believed later without being rechecked. In particular: absence from an expected path is NOT evidence of deletion. A directory that is missing was renamed at least as often as it was lost, and the content usually still exists under another name. Search for it before writing anything down, and never record work as lost, deleted or vanished on the strength of a path that did not resolve. A memory asserting they lost work they still have is worse than no memory at all — it will be repeated back to them as fact.

Silence is a valid outcome. A night where nothing durable happened should produce no memories. Ten thoughtful memories beat a hundred mechanical ones, and a wrong memory is worse than a missing one because it will be believed later.

When you are done, print one line: how many memories you wrote and how many you updated.`

export type ConsolidationPlan = {
  digestDir: string
  files: string[]
  sessions: number
  since: number
}

/** Extract and stage digests. Separated from spawning so it can be inspected. */
export function prepare(since: number, digestRoot: string, maxSessions = 40, burnedFile = BURNED_FILE): ConsolidationPlan {
  const found = transcriptsSince(since).slice(0, maxSessions)
  const isBurned = burnedMatcher(loadBurned(burnedFile))
  mkdirSync(digestRoot, { recursive: true })
  // Fresh dir each run — a leftover digest would be re-consolidated forever.
  for (const f of readdirSync(digestRoot)) {
    if (f.endsWith('.md')) { try { rmSync(join(digestRoot, f)) } catch {} }
  }
  const files: string[] = []
  for (const t of found) {
    const d = digestTranscript(t.path, t.project, isBurned)
    if (!d) continue
    const out = join(digestRoot, `${d.project}--${d.sessionId}.md`)
    writeFileSync(out, renderDigest(d))
    files.push(out)
  }
  return { digestDir: digestRoot, files, sessions: files.length, since }
}

const ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob',
  'mcp__plugin_otto_otto__recall',
  'mcp__plugin_otto_otto__remember',
].join(',')

/**
 * Spawn the consolidating session.
 *
 * OTTO_CHANNEL_HOST is scrubbed deliberately and this is the single most
 * important line in the file. run.sh exports it for the whole live session, so
 * a naively inherited environment would tell the child it is the channel host —
 * it would reap the parent's poller, seize the Telegram token, and leave the
 * real assistant deaf while a headless batch job held the bot.
 *
 * headlessMcpArgs is the same lesson for every other channel plugin: without it
 * the child loads them all, and the Discord one kills the live gateway on start.
 */
export async function spawnConsolidation(plan: ConsolidationPlan, timeoutMs = 20 * 60_000): Promise<{ ok: boolean; output: string }> {
  const claude = claudeBin()
  if (!existsSync(claude)) return { ok: false, output: 'claude CLI not found' }

  const env = { ...process.env }
  delete env.OTTO_CHANNEL_HOST

  const prompt = `${CONSOLIDATION_PROMPT}\n\nDigest directory: ${plan.digestDir}\nSessions to review: ${plan.sessions}`

  try {
    const proc = Bun.spawn([claude, '-p', prompt, '--permission-mode', 'auto', '--allowedTools', ALLOWED_TOOLS, ...headlessMcpArgs({ otto: true })], {
      env,
      cwd: plan.digestDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => { try { proc.kill() } catch {} }, timeoutMs)
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    clearTimeout(timer)
    return { ok: code === 0, output: out.trim().slice(-2000) }
  } catch (err) {
    return { ok: false, output: String(err) }
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const sinceArg = argv.includes('--since') ? Date.parse(argv[argv.indexOf('--since') + 1]) : NaN
  const since = Number.isNaN(sinceArg) ? Date.now() - 24 * 60 * 60 * 1000 : sinceArg
  const dir = join(process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'), 'digests')
  const plan = prepare(since, dir)
  console.log(`${plan.sessions} session(s) digested into ${plan.digestDir}`)
  if (argv.includes('--dry-run')) {
    for (const f of plan.files) console.log(`  ${basename(f)} (${statSync(f).size} bytes)`)
    process.exit(0)
  }
  const res = await spawnConsolidation(plan)
  console.log(res.ok ? res.output : `failed: ${res.output}`)
}
