/** Split text under a surface's length cap, preferring paragraph, then line, then word breaks. */
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/** A reply as chat bubbles: one per blank-line-separated paragraph. A code block keeps it whole. */
export function bubbles(text: string): string[] {
  if (text.includes('```')) return [text]
  const parts = text.split(/\n[ \t]*\n/).map(s => s.trim()).filter(Boolean)
  return parts.length ? parts : [text]
}

/** How long the typing dots show before a follow-up bubble: a beat, plus a little per character, capped. */
export function typingDelay(text: string): number {
  return Math.min(2200, 450 + 22 * text.length)
}
