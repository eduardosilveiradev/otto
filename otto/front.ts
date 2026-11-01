/**
 * The front desk: a small, fast model that reads every app message first (an experiment,
 * off unless `front.enabled` in access.json, and only until `front.until`).
 *
 * Two modes. While the main session has been busy a while (`cover`), it covers the wait: an
 * acknowledgement, or a quick answer. Otherwise (`triage`, unless `front.triage: false`) it
 * decides who answers: what it can settle outright it settles, and the main session is never
 * woken for it; everything else goes straight through. It has only read-only lookups and
 * writes nothing; when it does speak and passes on, the main session is told what it said so
 * the two never answer twice.
 */

import { tmpdir } from 'os'
import { join } from 'path'

export const FRONT_MODEL = 'claude-sonnet-5-5'

/** `bin`: the Claude Code binary to run it through (default `claude` on PATH). */
/** `voice: false` stops it rewriting the main session's app replies. */
export type FrontConfig = { enabled?: boolean; until?: string; busySeconds?: number; bin?: string; triage?: boolean; voice?: boolean }
export type FrontMode = 'cover' | 'triage'
export type Line = { dir: 'in' | 'out'; text: string; ts: string }

/** On, not past its end date. */
export function frontActive(cfg: FrontConfig | undefined, now = Date.now()): boolean {
  if (!cfg?.enabled) return false
  return !cfg.until || now < Date.parse(cfg.until)
}

/** Busy long enough that a reply from the main session isn't coming soon. */
export function frontShouldAnswer(cfg: FrontConfig | undefined, turnOpen: boolean, turnStartedAt: number, now = Date.now()): boolean {
  return frontActive(cfg, now) && turnOpen && now - turnStartedAt >= (cfg?.busySeconds ?? 20) * 1000
}

/** `cover` while the main session is busy a while, `triage` otherwise, null when it's off. */
export function frontMode(cfg: FrontConfig | undefined, turnOpen: boolean, turnStartedAt: number, now = Date.now()): FrontMode | null {
  if (frontShouldAnswer(cfg, turnOpen, turnStartedAt, now)) return 'cover'
  return frontActive(cfg, now) && cfg?.triage !== false ? 'triage' : null
}

const SYSTEM = [
  // Voice: modelled on Poke's conversation agent, which texts very short. In our own words.
  'You are Otto, texting the user like a friend would. Witty and warm, never forced: dry humour only when it fits, never two jokes in a row unless they joked back, never a stock joke. Warmth when it is earned, not by default.',
  'Shorter than you think: most replies are 2 to 6 words, never more than one sentence. '+
  'Match their length: a few words in, a few words out. Lowercase if they write lowercase. No emoji unless they used one first, and never the same one they just used. Never "let me know", "anything else", "happy to help", "no problem", or repeating their request back to them. No preamble.',
  'You are one assistant. Never mention agents, a front desk, models, tools, files or code.',
  'Each message you get stands alone: judge it only by the thread and memory it carries, never by earlier messages in this conversation.',
  'Each message says which situation you are in and which forms of reply you may use. DONE: <text> means your text fully settles it and the full version of you will never see the message.',
  'You can look things up, read only: memory, reminders, calendar, mail (sender and subject only) and chat history. When a question is about something those hold, look it up and answer it yourself with DONE. Keep it to one or two lookups; you are covering a wait, not doing the work. Plans and times usually live in reminders and memory, not the calendar: check those first.',
  'Never DONE anything that needs an action or a guess. Never claim you did, sent, saved or changed anything. Never promise a time.',
].join('\n')

// Per message rather than in the system prompt: the warm session keeps one system prompt.
const SITUATION: Record<FrontMode, string> = {
  cover: [
    'Right now you are in the middle of something else for them, so this message has to wait for the full version of you. Cover the wait. Reply in exactly one of three forms:',
    'DONE: <text> when your text fully settles it and nothing more needs doing: chat, a joke, a thanks, or a question the thread or the memory below answers outright.',
    'ACK: <text> when they want something done, or asked something you cannot fully answer: a few words saying you are on it after what you are doing now. Name that the way they asked for it in the thread, or just say "after this". The full version of you handles it after.',
    'An ACK never answers the question itself, not even partly: no "yes", no guess, just that it is coming.',
    'PASS when a reply adds nothing (a "k", half a thought). The full version of you handles it after.',
  ].join('\n'),
  triage: [
    'Right now the full version of you is free. You decide who answers. Reply in exactly one of three forms:',
    'DONE: <text> when you can settle it yourself, fully and correctly: chat, a joke, a thanks, a reaction, or a question the thread, the memory below or one or two lookups answer outright.',
    'ACK: <text> when they want something done (change, build, send, book, fix, plan, look into): a few words saying you are on it. It never answers or guesses at the thing itself. The full version of you does it and replies after.',
    'PASS for everything else: a question that needs care, working out or more than a couple of lookups, anything you are unsure of, and anything a reply adds nothing to. When in doubt between DONE and anything else, do not DONE: a wrong DONE is far worse than a slow answer.',
  ].join('\n'),
}

/** The system prompt and the turn, kept pure so they can be tested. */
export function frontPrompt(thread: Line[], message: string, now = new Date(), known = '', mode: FrontMode = 'cover'): { system: string; user: string } {
  const lines = thread.slice(-16).map(l => `${l.dir === 'in' ? 'them' : 'you'}: ${l.text.replace(/\s+/g, ' ').slice(0, 400)}`)
  return {
    system: SYSTEM,
    user: [
      SITUATION[mode], '',
      `Now: ${now.toISOString()}`,
      'Recent thread:', ...lines,
      ...(known ? ['', 'From memory (may be stale; only answer from it when it clearly answers):', known.slice(0, 2500)] : []),
      '', `Their new message: ${message}`,
    ].join('\n'),
  }
}

export type Run = (system: string, user: string) => Promise<string>

/** Its only tools: the read-only lookups in frontmcp.ts. */
const LOOKUPS = ['memory', 'reminders', 'calendar', 'mail', 'history'].map(t => `mcp__front__${t}`)
function runArgs(): string[] {
  const mcp = { mcpServers: { front: { command: process.execPath, args: [join(import.meta.dir, 'frontmcp.ts')],
    env: { OTTO_GOOGLE_ACCOUNT: process.env.OTTO_GOOGLE_ACCOUNT ?? '', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } } } }
  return ['-p', '--model', FRONT_MODEL, '--tools', '', '--mcp-config', JSON.stringify(mcp), '--strict-mcp-config',
    '--allowedTools', LOOKUPS.join(','), '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands']
}

function runEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PROJECT_DIR']) delete env[k]
  return env
}

/**
 * A warm headless Claude Code session, so a reply counts against the user's plan rather than
 * API credits and still lands in about a second (a cold `claude -p` spends two more starting).
 * No tools, no MCP, no settings sources (so no plugins or hooks: a Stop hook from this session
 * would close Otto's own turn), nothing saved, and an API key in the environment is dropped so
 * the plan login is what pays. One request at a time; the session is replaced every
 * `recycle` requests so the context it carries stays small, and on any failure.
 */
export class WarmRun {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private buf = ''
  private served = 0
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private bin = 'claude', private recycle = 10, private timeoutMs = 15_000) {}

  run: Run = (system, user) => {
    const next = this.chain.then(() => this.ask(system, user))
    this.chain = next.catch(() => {})
    return next
  }

  private start(system: string): void {
    this.proc = Bun.spawn([this.bin, ...runArgs(), '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--system-prompt', system], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', cwd: tmpdir(), env: runEnv() })
    this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader()
    this.buf = ''
    this.served = 0
  }

  stop(): void {
    try { this.proc?.kill() } catch {}
    this.proc = null; this.reader = null
  }

  private async ask(system: string, user: string): Promise<string> {
    if (!this.proc || this.served >= this.recycle) { this.stop(); this.start(system) }
    this.served++
    const stdin = this.proc!.stdin as import('bun').FileSink
    stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: user } }) + '\n')
    stdin.flush()
    const timer = setTimeout(() => this.stop(), this.timeoutMs)
    try {
      for (;;) {
        const nl = this.buf.indexOf('\n')
        if (nl >= 0) {
          const line = this.buf.slice(0, nl)
          this.buf = this.buf.slice(nl + 1)
          try { const j = JSON.parse(line); if (j.type === 'result') return String(j.result ?? '') } catch {}
          continue
        }
        const { value, done } = await this.reader!.read()
        if (done) { this.stop(); return '' }
        this.buf += new TextDecoder().decode(value)
      }
    } catch { this.stop(); return '' } finally { clearTimeout(timer) }
  }
}

export type FrontAnswer = { done: boolean; text: string }

/** DONE (settled, don't pass it on) or ACK (send, then pass it on); null for PASS, junk or too long. */
export function frontReply(raw: string): FrontAnswer | null {
  // The last DONE/ACK line wins: after a lookup the model sometimes says a few words first.
  const m = /(?:^|\n)\s*(DONE|ACK)\s*:\s*([\s\S]+)$/i.exec(raw.trim())
  if (!m) return null
  const text = m[2].trim().replace(/^["“]|["”]$/g, '').trim()
  if (!text || text.length > 280) return null
  return { done: m[1].toUpperCase() === 'DONE', text }
}

export async function askFront(run: Run, thread: Line[], message: string, known = '', mode: FrontMode = 'cover'): Promise<FrontAnswer | null> {
  try {
    const { system, user } = frontPrompt(thread, message, new Date(), known, mode)
    return frontReply(await run(system, user))
  } catch { return null }
}

// ---------------------------------------------------------------------------
// The talker's rewrite: the main session's app replies, put the way it texts
// ---------------------------------------------------------------------------

/** What a rewrite may never change: links, emails, `code`, and every token with a digit in it (times, amounts, dates, ids, codes). */
export function lockedTokens(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.]+|`[^`\n]+`/g)) out.add(m[0].replace(/[.,;:!?)]+$/, ''))
  const rest = text.replace(/https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.]+|`[^`\n]+`/g, ' ')
  for (const m of rest.matchAll(/[^\s]*\d[^\s]*/g)) {
    const t = m[0].replace(/^[("'“‘]+|[.,;:!?)"'”’]+$/g, '')
    if (t) out.add(t)
  }
  return [...out]
}

/** Every locked token of the original, still there and unchanged. */
export function keepsFacts(original: string, rewritten: string): boolean {
  return lockedTokens(original).every(t => rewritten.includes(t))
}

/** Already the way it texts, or not text it should touch: short, code, or a list meant to be read whole. */
export function skipRewrite(text: string): boolean {
  return text.length <= 140 || text.includes('```') || /^\s*([-*•]|\d+[.)])\s/m.test(text)
}

const VOICE = [
  'The full version of you just wrote the reply below for them. Rewrite it the way you text: 1 to 3 short messages, one sentence each, separated by a blank line. Keep every fact they need and drop explanation they did not ask for.',
  'Copy exactly, character for character: every number, time, date, amount, code, id, name, link and email. Never add a fact, a promise or an offer that is not in it. If it is already short and plain, return it unchanged.',
  'Answer with TEXT: and then the messages, nothing else.',
].join('\n')

export async function voicePass(run: Run, thread: Line[], reply: string): Promise<string | null> {
  try {
    const lines = thread.slice(-8).map(l => `${l.dir === 'in' ? 'them' : 'you'}: ${l.text.replace(/\s+/g, ' ').slice(0, 300)}`)
    const raw = await run(SYSTEM, [VOICE, '', 'Recent thread:', ...lines, '', 'The reply:', reply].join('\n'))
    const m = /(?:^|\n)\s*TEXT\s*:\s*([\s\S]+)$/i.exec(raw.trim())
    const text = m?.[1].trim()
    return text && text.length <= reply.length + 40 && keepsFacts(reply, text) ? text : null
  } catch { return null }
}
