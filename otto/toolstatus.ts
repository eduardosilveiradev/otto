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

// Otto's own tools by what they do, not their names ("Who", "Places").
// '' for its own sends: they are the reply itself, not a step towards it.
// tests/toolstatus.test.ts fails when a tool in tools.ts has no entry here.
export const OTTO: Record<string, string> = {
  reply: '', react: '', edit_message: '', delete_message: '', set_email_state: '',
  recall: 'Remembering', reload: 'Restarting with the update', who: 'Looking someone up',
  burn: 'Scrubbing that message', download_attachment: 'Saving the attachment',
  route: 'Working out the route', arm_draft_review: 'Lining up the review',
  mac_unreachable: 'Noting your Mac is offline', snooze: 'Quieting things down',
  proactivity_report: 'Checking how often I ping you', memory_audit: 'Auditing my memory', rulebook: 'Checking your rules',
  loop_hygiene: 'Tidying the open loops', consolidate_memory: 'Sorting my memory', self_edit_check: 'Checking what a change needs',
  create_group: 'Starting a group', rename_group: 'Renaming the group', add_to_group: 'Adding a helper to the group',
  overnight: 'Setting up overnight mode', create_pip: 'Creating a helper', list_pips: 'Checking the helpers',
  pip_handoff: 'Asking a helper', pip_activity: "Updating a helper's progress", delegate: 'Handing off slow work',
  jobs: 'Checking the background jobs', code_job: 'Starting a coding job', code_jobs: 'Checking the coding jobs',
  code_job_answer: 'Answering the coding job', restart_check: 'Checking it is safe to restart',
  projects: 'Checking your projects', record_document: 'Saving the document', documents: 'Checking your documents',
  key_expiry: 'Checking what expires', mine_sent: 'Reading what you promised', pulse: 'Checking the overnight research',
  body: 'Checking your health data', forge: 'Building something new', capability_log: 'Checking what changed in me',
  revert_capability: 'Undoing a change', watchdog_report: 'Checking my own health',
  settings: 'Opening your settings', usage: 'Checking your usage',
  places: 'Checking your places', note_place: 'Saving the place', note_contact: 'Noting that down',
  remember: 'Noting that down', forget: 'Forgetting it', brief: 'Checking your day',
  create_trigger: 'Setting that up', update_trigger: 'Changing the schedule', delete_trigger: 'Removing the schedule',
  list_triggers: 'Checking the schedule', record_money: 'Logging the payment', spending: 'Checking your spending', subscriptions: 'Checking what renews',
  splits: 'Working out who owes what', record_split: 'Logging the split', trips: 'Checking your trips',
  record_trip: 'Saving the trip', read_history: 'Rereading the chat', otto_status: 'Checking everything is up',
  ask_approval: 'Asking for your approval', ask_payment: 'Asking you to confirm the payment',
  self_test: 'Testing the change', phishing_check: 'Checking that email', warranty: 'Checking the warranty',
}

// Browser tools by what they do on the page; '' for housekeeping nobody needs to see.
const BROWSER: Record<string, string> = {
  javascript_tool: 'Running JavaScript on a website', computer: 'Using the browser', browser_batch: 'Using the browser',
  read_page: 'Reading a website', get_page_text: 'Reading a website', find: 'Searching a website',
  form_input: 'Filling in a form', file_upload: 'Uploading to a website', upload_image: 'Uploading to a website',
  tabs_create_mcp: 'Opening a browser tab', tabs_close_mcp: 'Closing a browser tab', resize_window: 'Resizing the browser',
  read_console_messages: 'Checking the browser console', read_network_requests: "Checking the website's requests",
  gif_creator: 'Recording the browser', tabs_context_mcp: '', list_connected_browsers: '', select_browser: '', switch_browser: '',
}

// Claude Code's other built-in tools, by what they do; '' for bookkeeping nobody needs to see.
const BUILTIN: Record<string, string> = {
  AskUserQuestion: 'Asking you something', SendMessage: 'Messaging an agent', ListAgents: 'Checking on the agents',
  ReadNotifications: 'Checking notifications', TaskStop: 'Stopping a task', KillShell: 'Stopping a task',
  TaskOutput: 'Checking on a task', BashOutput: 'Checking on a task', CronCreate: 'Scheduling a task',
  CronDelete: 'Removing a scheduled task', CronList: 'Checking scheduled tasks', ScheduleWakeup: 'Scheduling a check-in',
  EnterPlanMode: 'Planning', ExitPlanMode: 'Finishing the plan', EnterWorktree: 'Setting up a worktree',
  ExitWorktree: 'Leaving the worktree', PushNotification: 'Sending a notification', RemoteTrigger: 'Triggering a remote run',
  SendUserFile: 'Sending you a file', SendToProject: 'Sending to another project', SendToProjectContext: 'Sending to another project',
  DesignSync: 'Syncing the design', FetchInboxMessage: 'Reading a message', ListMcpResourcesTool: 'Looking through resources',
  ReadMcpResourceTool: 'Reading a resource', ReadMcpResourceDirTool: 'Reading a resource', ReportFindings: 'Reporting findings',
  SendFeedback: 'Sending feedback', Workflow: 'Running a workflow', advisor: 'Checking with a reviewer', LSP: 'Checking the code',
  Skill: '', EndConversation: '',
}

// Leading `cd dir &&` hops and `NAME=value` assignments (alone or before the command) say nothing about what runs.
const LEAD = /^(\s*(cd\s+("[^"]*"|'[^']*'|\S+)|[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*))\s*(&&|;|\s)\s*)+/
const program = (c: string) => (c.split(/\s+/)[0] ?? '').split('/').pop()!.slice(0, 32)
/** No description: name the program, past any leading `cd dir &&`, variable assignments and an `ssh host` hop. */
export function bashLabel(command: string): string {
  let c = command.replace(LEAD, '').trim(), remote = false
  if (/^ssh\s/.test(c)) {
    const t = c.split(/\s+/)
    let i = 1
    while (t[i]?.startsWith('-')) i += /^-[oipFlJLRDW]$/.test(t[i]) ? 2 : 1
    c = t.slice(i + 1).join(' ').replace(/^['"]/, '').replace(LEAD, '')
    remote = true
  }
  return `Running ${program(c)}${remote ? ' on another device' : ''}`
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
    case 'Bash': return gerund(str('description')) || bashLabel(str('command'))
    case 'Grep': return `Searching for ${str('pattern')}`
    case 'Glob': return `Looking for ${str('pattern')}`
    case 'WebSearch': return `Searching the web for ${str('query')}`
    case 'WebFetch': { try { return `Reading ${new URL(str('url')).hostname}` } catch { return 'Reading a web page' } }
    case 'Agent': case 'Task': return str('description') ? `Running a subagent: ${str('description')}` : 'Starting a subagent'
    case 'TaskCreate': return 'Adding to the to-do list'
    case 'TaskUpdate': return input.status === 'completed' ? 'Ticking off a to-do' : input.status === 'in_progress' ? 'Starting the next to-do' : 'Updating the to-do list'
    case 'ToolSearch': case 'TodoWrite': case 'TaskList': case 'TaskGet': return ''
    case 'Monitor': return str('description') ? `Watching ${str('description')}` : 'Watching a task'
    case 'Artifact': switch (str('action') || 'publish') {
      case 'publish': return input.asset ? 'Uploading to a page' : `Publishing ${file('file_path') || 'a page'}`
      case 'read': return 'Reading a page'
      case 'list': return 'Looking through pages'
      case 'open': return 'Opening a page'
      case 'delete': return 'Deleting a page'
      case 'quickstart': return ''
      default: return 'Working on a page'
    }
    case 'ArtifactData': return /^(get|list|query)$/.test(str('action')) ? "Reading the page's data" : "Updating the page's data"
    case 'ArtifactComments': return /reply|resolve|post|create/.test(str('action')) ? 'Replying to a comment' : 'Reading comments'
  }
  if (tool in BUILTIN) return BUILTIN[tool]
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  // Last resort, so a new tool still reads as words: "ArtifactData" → "Artifact data".
  if (!m) return tool.replace(/[_-]/g, ' ').replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/ [A-Z](?=[a-z])/g, c => c.toLowerCase()).replace(/^./, c => c.toUpperCase())
  const [, srv, name] = m
  if (/otto/.test(srv) && name === 'who') return input.drift === true ? "Checking who's gone quiet" : str('name') ? `Looking up ${str('name')}` : 'Looking someone up'
  // reload restarts the server mid-call, so a Haiku label for it would never arrive.
  if (/otto/.test(srv) && name in OTTO) return OTTO[name]
  if (/claude-in-chrome/.test(srv)) {
    if (name === 'navigate') { try { return `Opening ${new URL(str('url')).hostname}` } catch { return 'Opening a website' } }
    if (name in BROWSER) return BROWSER[name]
  }
  const where = /gmail/i.test(srv) ? 'mail' : /calendar/i.test(srv) ? 'calendar' : /drive/i.test(srv) ? 'Drive' : ''
  return where ? `Checking ${where}` : name.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}
