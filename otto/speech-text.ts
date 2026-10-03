/**
 * Turning written text into something worth listening to.
 *
 * Split out of server.ts because it is the only part of the voice path with no
 * models, no network and no state — which makes it the only part worth unit
 * testing. See tests/speech-text.test.ts.
 */

// Digits are where synthesis embarrasses itself: "6:40" comes back as "two
// thousand twenty two four" often enough that it is not a risk worth taking on
// a flight time. Spell them before the model ever sees them.
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

export function numToWords(n: number): string {
  if (n < 20) return ONES[n]
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)]
    return n % 10 ? `${t}-${ONES[n % 10]}` : t
  }
  if (n < 1000) {
    const rest = n % 100
    return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` ${numToWords(rest)}` : ''}`
  }
  if (n < 10000) {
    // Years read as pairs — "twenty twenty-six", not "two thousand twenty-six".
    const lo = n % 100
    if (n >= 1100 && n <= 2999 && lo !== 0) return `${numToWords(Math.floor(n / 100))} ${numToWords(lo)}`
    const rest = n % 1000
    return `${ONES[Math.floor(n / 1000)]} thousand${rest ? ` ${numToWords(rest)}` : ''}`
  }
  return String(n)
}

const ORDINALS: Record<string, string> = {
  one: 'first', two: 'second', three: 'third', five: 'fifth',
  eight: 'eighth', nine: 'ninth', twelve: 'twelfth',
}

function spellTime(h: string, m: string, suffix?: string): string {
  const hour = numToWords(Number(h))
  const min = Number(m)
  const minute = min === 0 ? "o'clock" : min < 10 ? `oh ${numToWords(min)}` : numToWords(min)
  const tail = suffix ? (suffix.toLowerCase().startsWith('a') ? ' in the morning' : ' in the evening') : ''
  return `${hour} ${minute}${tail}`
}

export function spellNumbers(s: string): string {
  return s
    .replace(/(\d),(\d{3})\b/g, '$1$2')
    .replace(/\b(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/gi, (_, h, m, ap) => spellTime(h, m, ap))
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => spellTime(h, m))
    .replace(/\b(\d{1,2})\s*([ap])\.?m\.?/gi, (_, h, ap) => spellTime(h, '00', ap))
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/\b(\d{1,4})(st|nd|rd|th)\b/gi, (_, n) => {
      const w = numToWords(Number(n))
      const last = w.split(/[ -]/).pop()!
      const mapped = ORDINALS[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`)
      return w.slice(0, w.length - last.length) + mapped
    })
    .replace(/\b\d{1,4}\b/g, m => numToWords(Number(m)))
}

/**
 * Markdown, URLs and emoji are for the eye. Read aloud they are noise — "star
 * star flight star star" — so strip them before synthesis. The Telegram caption
 * still carries the original text, so nothing is lost by being aggressive here.
 *
 * Returns '' when there is nothing left to say (a bare emoji, say), which the
 * caller takes as "send this as text instead".
 */
export function speakable(text: string, limit: number): string {
  let s = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, 'that address')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}️]/gu, '')

  s = spellNumbers(s)
    .replace(/[ \t]+/g, ' ')
    .replace(/ ([,.!?;:])/g, '$1')
    // What a stripped code block leaves behind is a blank line, not nothing.
    .replace(/\n[ \t]*(\n[ \t]*)+/g, '\n')
    .replace(/\n /g, '\n')
    .trim()

  if (s.length > limit) {
    const cut = s.slice(0, limit)
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    s = (stop > limit / 2 ? cut.slice(0, stop + 1) : cut).trim()
  }
  return /\p{L}|\p{N}/u.test(s) ? s : ''
}
