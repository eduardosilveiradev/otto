/**
 * Plain-words status lines for the app's typing bubble.
 *
 * toolstatus.ts labels the tools it knows ("Reading notes.md", a Bash call's own
 * description). Everything else falls back to a bare "Remembering" or a tool name
 * with its underscores swapped ("Create trigger"). For those, Haiku turns the call
 * into a few words about what is actually happening ("Remembering your iPhone
 * order"). The bare label shows at once; this one replaces it when it lands, and a
 * slow or failed call just leaves the bare one up.
 */

export const STATUS_MODEL = 'claude-haiku-5-5'

const SYSTEM =
  'You write the status line in a chat app\'s typing bubble while an assistant works for the user. ' +
  'Given one tool call, reply with 2 to 6 words saying what it is doing, starting with a verb in -ing form, ' +
  'sentence case, no period, no quotes, plain words, "your" for the user\'s things. ' +
  'Examples: Remembering your iPhone order · Setting a reminder for 3:45 · Checking tomorrow\'s homework. ' +
  'Never include ids, codes, numbers that look like secrets, or email addresses.'

/** Only the labels toolstatus.ts couldn't phrase itself. */
export function wantsPolish(tool: string, label: string): boolean {
  if (!label) return false
  if (/^mcp__.*otto.*__recall$/.test(tool)) return true
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  // The fallback is the tool's own name, capitalised — nothing a person would write.
  return !!m && label.toLowerCase() === m[2].replace(/_/g, ' ').toLowerCase()
}

/** Haiku's answer as a status line, or "" if it isn't one. */
export function cleanStatus(raw: string): string {
  const line = raw.trim().split('\n')[0].replace(/^["'“‘]+|["'”’.]+$/g, '').trim()
  if (!line || line.length > 48 || line.split(/\s+/).length > 7) return ''
  return line[0].toUpperCase() + line.slice(1)
}

const cache = new Map<string, string>()

export async function polishStatus(
  tool: string,
  input: string,
  key = process.env.ANTHROPIC_API_KEY,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!key) return ''
  const id = `${tool}\n${input}`
  const hit = cache.get(id)
  if (hit !== undefined) return hit
  let out = ''
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: STATUS_MODEL, max_tokens: 24, system: SYSTEM,
        messages: [{ role: 'user', content: [
          `Today: ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`,
          `Tool: ${tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')}`,
          `Input: ${input.slice(0, 600)}`,
          // A memory lookup keeps the bubble's familiar word; the rest is what it's about.
          ...(/__recall$/.test(tool) ? ['Start with "Remembering".'] : []),
        ].join('\n') }],
      }),
      signal: AbortSignal.timeout(4_000),
    })
    if (res.ok) {
      const j = await res.json() as { content?: { type: string; text?: string }[] }
      out = cleanStatus(j.content?.find(c => c.type === 'text')?.text ?? '')
    }
  } catch {}
  if (cache.size > 300) cache.clear() // ponytail: crude cap; an LRU only if the hit rate matters
  if (out) cache.set(id, out) // a timeout or 429 gets another try next time
  return out
}
