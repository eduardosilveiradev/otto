import { basename } from 'path'

// Bash descriptions are imperative ("Build the app"); the bubble reads as what's happening now.
// ponytail: a known-verb list, not a grammar; an unknown first word is left as written.
const VERBS = new Set(('add apply ask build bump calculate change check clean clear clone close commit compare compile convert copy count ' +
  'create decode delete deploy diff download dump edit extract fetch filter find fix format generate get grep inspect install ' +
  'kill launch list load locate look make measure merge move open parse patch pause ping play post print publish pull push query ' +
  'read rebuild record reload remove rename render replace reset resize restart restore resume revert run save scan search send ' +
  'set show sort start stop switch sync tag tally test trim turn type uninstall unzip update upload verify view wait watch write zip').split(' '))
const DOUBLE = new Set(['commit', 'drop', 'get', 'put', 'run', 'scan', 'set', 'ship', 'stop', 'tag', 'trim', 'zip', 'plan', 'cut'])
function ing(word: string): string {
  const w = word.toLowerCase()
  const out = DOUBLE.has(w) ? w + w.at(-1) + 'ing'
    : w.endsWith('ie') ? w.slice(0, -2) + 'ying'
    : /[^aeiouy]e$/.test(w) || w.endsWith('ue') ? w.slice(0, -1) + 'ing'
    : w + 'ing'
  return word[0] === word[0].toUpperCase() ? out[0].toUpperCase() + out.slice(1) : out
}
/** The leading verb, and each one right after a comma, "and" or "then": "Commit, push and reload" → "Committing, pushing and reloading". */
export function gerund(phrase: string): string {
  const first = /^[A-Za-z]+/.exec(phrase)?.[0]
  if (!first || !VERBS.has(first.toLowerCase())) return phrase
  return ing(first) + phrase.slice(first.length)
    .replace(/(,\s*(?:and\s+|then\s+)?|\s(?:and|then)\s+)([a-z]+)\b/g, (all, sep: string, w: string) => VERBS.has(w) ? sep + ing(w) : all)
}

/** A tool call as a few words for the typing bubble; '' for calls not worth showing. Never cut: the app wraps it. */
export function statusLabel(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '')
  const file = (k: string) => basename(str(k))
  switch (tool) {
    case 'Read': return `Reading ${file('file_path')}`
    case 'Edit': case 'MultiEdit': return `Editing ${file('file_path')}`
    case 'Write': return `Writing ${file('file_path')}`
    case 'NotebookEdit': return `Editing ${file('notebook_path')}`
    case 'Bash': return gerund(str('description')) || `Running ${str('command').split(/\s+/)[0] ?? ''}`
    case 'Grep': return `Searching for ${str('pattern')}`
    case 'Glob': return `Looking for ${str('pattern')}`
    case 'WebSearch': return `Searching the web for ${str('query')}`
    case 'WebFetch': { try { return `Reading ${new URL(str('url')).hostname}` } catch { return 'Reading a web page' } }
    case 'Agent': case 'Task': return str('description') ? `Running a subagent: ${str('description')}` : 'Starting a subagent'
    // The to-do bubble already shows the list these change.
    case 'ToolSearch': case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': case 'TaskList': case 'TaskGet': return ''
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (!m) return tool
  const [, srv, name] = m
  // Its own sends are the reply itself, not a step towards it.
  if (/otto/.test(srv) && /^(reply|react|edit_message|set_email_state)$/.test(name)) return ''
  if (/otto/.test(srv) && name === 'recall') return 'Remembering'
  // The server restarts mid-call, so a Haiku label for it would never arrive.
  if (/otto/.test(srv) && name === 'reload') return 'Restarting with the update'
  const where = /gmail/i.test(srv) ? 'mail' : /calendar/i.test(srv) ? 'calendar' : /drive/i.test(srv) ? 'Drive' : ''
  return where ? `Checking ${where}` : name.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}
