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

export const FRONT_MODEL = 'claude-sonnet-5-5'

export type FrontConfig = { enabled?: boolean; until?: string; busySeconds?: number }
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
  'Match their length: a few words in, a few words out. Lowercase if they write lowercase. No emoji unless they used one first, and never the same one they just used. Never "let me know", "anything else", "happy to help", "no problem", or repeating their request back to them. No preamble.',
  'You are one assistant. Never mention agents, a front desk, models, tools, files or code.',
  '',
  'Right now you are in the middle of something else for them, so this message has to wait for the full version of you. Cover the wait. Reply in exactly one of three forms:',
  'DONE: <text> when your text fully settles it and nothing more needs doing: chat, a joke, a thanks, or a question the thread or the memory below answers outright. The full version of you will never see this message.',
  'ACK: <text> when they want something done, or asked something you cannot fully answer: a few words saying you are on it after what you are doing now. Name that the way they asked for it in the thread, or just say "after this". The full version of you handles it after.',
  'PASS when a reply adds nothing (a "k", half a thought). The full version of you handles it after.',
  'Never DONE anything that needs an action, a look at mail, calendar or files, or a guess. Never claim you did, checked, sent or saved anything. Never promise a time.',
].join('\n')

/** The request body, kept pure so it can be tested. */
export function frontRequest(thread: Line[], message: string, doing: string, now = new Date(), known = ''): object {
  const lines = thread.slice(-16).map(l => `${l.dir === 'in' ? 'them' : 'you'}: ${l.text.replace(/\s+/g, ' ').slice(0, 400)}`)
  return {
    model: FRONT_MODEL,
    // Sonnet 5.5 opens with a thinking block; a tight budget left no room for the text.
    max_tokens: 1024,
    thinking: { type: 'between_tools' },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        `Now: ${now.toISOString()}`,
        'Recent thread:', ...lines,
        ...(known ? ['', 'From memory (may be stale; only answer from it when it clearly answers):', known.slice(0, 2500)] : []),
        '', `Their new message: ${message}`,
      ].join('\n'),
    }],
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

export async function askFront(key: string | undefined, thread: Line[], message: string, doing: string,
  fetchImpl: typeof fetch = fetch, known = ''): Promise<FrontAnswer | null> {
  if (!key) return null
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(frontRequest(thread, message, doing, new Date(), known)),
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const j = await res.json() as { content?: { type: string; text?: string }[] }
    return frontReply(j.content?.find(c => c.type === 'text')?.text ?? '')
  } catch { return null }
}
