/**
 * The front desk: a small, fast model that answers in the app while the main session is
 * busy on something else (an experiment, off unless `front.enabled` in access.json, and
 * only until `front.until`).
 *
 * The main session takes every message as usual and does the work. The front only covers
 * the wait: an acknowledgement, or a quick answer straight from the recent thread. It has
 * no tools and writes nothing; anything that needs doing it passes on (PASS), and when it
 * does speak, the main session is told what it said so the two never answer twice.
 */

import { tmpdir } from 'os'

export const FRONT_MODEL = 'claude-sonnet-5-5'

/** `bin`: the Claude Code binary to run it through (default `claude` on PATH). */
export type FrontConfig = { enabled?: boolean; until?: string; busySeconds?: number; bin?: string }
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

const SYSTEM = [
  // Voice: modelled on Poke's conversation agent, which texts very short. In our own words.
  'You are Otto, texting the user like a friend would. Witty and warm, never forced: dry humour only when it fits, never two jokes in a row unless they joked back, never a stock joke. Warmth when it is earned, not by default.',
  'Shorter than you think: most replies are 2 to 6 words, never more than one sentence. '+
  'Match their length: a few words in, a few words out. Lowercase if they write lowercase. No emoji unless they used one first, and never the same one they just used. Never "let me know", "anything else", "happy to help", "no problem", or repeating their request back to them. No preamble.',
  'You are one assistant. Never mention agents, a front desk, models, tools, files or code.',
  'Each message you get stands alone: judge it only by the thread and memory it carries, never by earlier messages in this conversation.',
  '',
  'Right now you are in the middle of something else for them, so this message has to wait for the full version of you. Cover the wait. Reply in exactly one of three forms:',
  'DONE: <text> when your text fully settles it and nothing more needs doing: chat, a joke, a thanks, or a question the thread or the memory below answers outright. The full version of you will never see this message.',
  'ACK: <text> when they want something done, or asked something you cannot fully answer: a few words saying you are on it after what you are doing now. Name that the way they asked for it in the thread, or just say "after this". The full version of you handles it after.',
  'An ACK never answers the question itself, not even partly: no "yes", no guess, just that it is coming.',
  'PASS when a reply adds nothing (a "k", half a thought). The full version of you handles it after.',
  'Never DONE anything that needs an action, a look at mail, calendar or files, or a guess. Never claim you did, checked, sent or saved anything. Never promise a time.',
].join('\n')

/** The system prompt and the turn, kept pure so they can be tested. */
export function frontPrompt(thread: Line[], message: string, now = new Date(), known = ''): { system: string; user: string } {
  const lines = thread.slice(-16).map(l => `${l.dir === 'in' ? 'them' : 'you'}: ${l.text.replace(/\s+/g, ' ').slice(0, 400)}`)
  return {
    system: SYSTEM,
    user: [
      `Now: ${now.toISOString()}`,
      'Recent thread:', ...lines,
      ...(known ? ['', 'From memory (may be stale; only answer from it when it clearly answers):', known.slice(0, 2500)] : []),
      '', `Their new message: ${message}`,
    ].join('\n'),
  }
}

export type Run = (system: string, user: string) => Promise<string>

const RUN_ARGS = ['-p', '--model', FRONT_MODEL, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
  '--no-session-persistence', '--disable-slash-commands']

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
    this.proc = Bun.spawn([this.bin, ...RUN_ARGS, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
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
  const m = /^\s*(DONE|ACK)\s*:\s*([\s\S]+)$/i.exec(raw.trim())
  if (!m) return null
  const text = m[2].trim().replace(/^["“]|["”]$/g, '').trim()
  if (!text || text.length > 280) return null
  return { done: m[1].toUpperCase() === 'DONE', text }
}

export async function askFront(run: Run, thread: Line[], message: string, known = ''): Promise<FrontAnswer | null> {
  try {
    const { system, user } = frontPrompt(thread, message, new Date(), known)
    return frontReply(await run(system, user))
  } catch { return null }
}
