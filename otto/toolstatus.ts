import { basename } from 'path'

/** A tool call as a few words for the typing bubble; '' for calls not worth showing. */
export function statusLabel(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '')
  const file = (k: string) => basename(str(k))
  const cut = (t: string) => (t.length > 60 ? `${t.slice(0, 59)}…` : t)
  switch (tool) {
    case 'Read': return `Reading ${file('file_path')}`
    case 'Edit': case 'MultiEdit': return `Editing ${file('file_path')}`
    case 'Write': return `Writing ${file('file_path')}`
    case 'NotebookEdit': return `Editing ${file('notebook_path')}`
    case 'Bash': return cut(str('description') || `Running ${str('command').split(/\s+/)[0] ?? ''}`)
    case 'Grep': return cut(`Searching for ${str('pattern')}`)
    case 'Glob': return cut(`Looking for ${str('pattern')}`)
    case 'WebSearch': return cut(`Searching the web for ${str('query')}`)
    case 'WebFetch': { try { return `Reading ${new URL(str('url')).hostname}` } catch { return 'Reading a web page' } }
    case 'Agent': case 'Task': return cut(str('description') || 'Handing off a job')
    case 'ToolSearch': case 'TodoWrite': return ''
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (!m) return cut(tool)
  const [, srv, name] = m
  // Its own sends are the reply itself, not a step towards it.
  if (/otto/.test(srv) && /^(reply|react|edit_message|set_email_state)$/.test(name)) return ''
  if (/otto/.test(srv) && name === 'recall') return 'Remembering'
  const where = /gmail/i.test(srv) ? 'mail' : /calendar/i.test(srv) ? 'calendar' : /drive/i.test(srv) ? 'Drive' : ''
  return cut(where ? `Checking ${where}` : name.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()))
}
