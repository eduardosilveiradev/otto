// What the app shows when the user types into Otto's terminal: a system line with
// the prompt's first words, not a bubble. Anything that arrives wrapped in a tag
// (<channel …>, <task-notification>, <system-reminder>, <command-…>) was injected,
// not typed, so it gets no line.

const WORDS = 6

export function promptSnippet(prompt: string): string | null {
  const t = prompt.trim()
  if (!t || t.startsWith('<')) return null
  const words = t.split(/\s+/)
  return words.slice(0, WORDS).join(' ') + (words.length > WORDS ? '…' : '')
}
