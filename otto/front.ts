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
  'You are Otto, a personal assistant texting the user in a chat app. Right now you are in the middle of another task for them, so this message has to wait for the full version of you.',
  'Your only job: cover the wait. Either send one short text, or reply with exactly PASS.',
  'Send a text when: they are chatting or joking (answer in kind), they ask something the thread below already answers, or they ask for something new (say you will get to it right after what you are doing, naming that task in a few plain words).',
  'Reply PASS when: you would have to guess, look anything up, check their mail, calendar, memory or files, or when a reply adds nothing.',
  'Never claim you did, checked, sent or saved anything. Never promise a time. Never invent facts.',
  'You are one assistant. Never mention a front desk, another agent, a model, or that anything is handing off.',
  'Voice: lowercase if they write lowercase, terse, dry, warm, no emoji unless they used one, no "let me know", no offers of more help. One or two short sentences at most.',
].join('\n')

/** The request body, kept pure so it can be tested. */
export function frontRequest(thread: Line[], message: string, doing: string, now = new Date()): object {
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
        `What you're busy with: ${doing || 'a task for them'}`,
        'Recent thread:', ...lines,
        '', `Their new message: ${message}`,
      ].join('\n'),
    }],
  }
}

/** The model's text as a message to send, or null for PASS / empty / too long. */
export function frontReply(raw: string): string | null {
  const t = raw.trim().replace(/^["“]|["”]$/g, '').trim()
  if (!t || /^pass\b/i.test(t) || t.length > 280) return null
  return t
}

export async function askFront(key: string | undefined, thread: Line[], message: string, doing: string,
  fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!key) return null
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(frontRequest(thread, message, doing)),
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const j = await res.json() as { content?: { type: string; text?: string }[] }
    return frontReply(j.content?.find(c => c.type === 'text')?.text ?? '')
  } catch { return null }
}
