import { expect, test } from 'bun:test'
import { gerund, OTTO, statusLabel } from '../toolstatus.ts'
import { TOOLS } from '../tools.ts'

test('file tools name the file, not the path', () => {
  expect(statusLabel('Read', { file_path: '/x/y/ChatView.swift' })).toBe('Reading ChatView.swift')
  expect(statusLabel('Edit', { file_path: '/x/server.ts' })).toBe('Editing server.ts')
})

test('Bash prefers its description', () => {
  expect(statusLabel('Bash', { command: 'xcodebuild -x', description: 'Build the app' })).toBe('Building the app')
  expect(statusLabel('Bash', { command: 'xcodebuild -x' })).toBe('Running xcodebuild')
  expect(statusLabel('Bash', { command: 'cd ~/a && cd "b c"; git status' })).toBe('Running git')
  expect(statusLabel('Bash', { command: "ssh mac 'cd ~/x && ps -A'" })).toBe('Running ps on another device')
  expect(statusLabel('Bash', { command: 'ssh -o ConnectTimeout=5 mac uptime' })).toBe('Running uptime on another device')
  expect(statusLabel('Bash', { command: 'D=/tmp/x/y; rm -rf $D && git clone -q url $D' })).toBe('Running rm')
  expect(statusLabel('Bash', { command: 'FOO=1 BAR="a b" ~/.local/bin/chrome --headless x' })).toBe('Running chrome')
})

test('otto sends are the reply itself, so they show nothing', () => {
  expect(statusLabel('mcp__plugin_otto_otto__reply', { text: 'hi' })).toBe('')
  expect(statusLabel('ToolSearch', {})).toBe('')
  expect(statusLabel('TaskCreate', { subject: 'x' })).toBe('Adding to the to-do list')
  expect(statusLabel('TaskUpdate', { taskId: '1', status: 'completed' })).toBe('Ticking off a to-do')
})

test('connectors read as what they check', () => {
  expect(statusLabel('mcp__claude_ai_Gmail__search_threads', {})).toBe('Checking mail')
  expect(statusLabel('mcp__plugin_otto_otto__recall', {})).toBe('Remembering')
  expect(statusLabel('mcp__plugin_otto_otto__reload', {})).toBe('Restarting with the update')
  expect(statusLabel('Agent', { description: 'iOS app security review' })).toBe('Running a subagent: iOS app security review')
  expect(statusLabel('Agent', {})).toBe('Starting a subagent')
  expect(statusLabel('mcp__thing__do_stuff', {})).toBe('Do stuff')
})

test("otto's own tools say what they do", () => {
  expect(statusLabel('mcp__plugin_otto_otto__who', { name: 'ana' })).toBe('Looking up ana')
  expect(statusLabel('mcp__plugin_otto_otto__who', { drift: true })).toBe("Checking who's gone quiet")
  expect(statusLabel('mcp__plugin_otto_otto__places', {})).toBe('Checking your places')
})

test('long labels arrive whole', () => {
  expect(statusLabel('Grep', { pattern: 'x'.repeat(100) })).toBe(`Searching for ${'x'.repeat(100)}`)
})

test('imperative descriptions read as present continuous', () => {
  const g = (x: string) => statusLabel('Bash', { command: 'x', description: x })
  expect(g('Run the tests')).toBe('Running the tests')
  expect(g('Make the header sticky')).toBe('Making the header sticky')
  expect(g('Commit and push')).toBe('Committing and pushing')
  expect(g('Commit, push, and publish the camera fixes')).toBe('Committing, pushing, and publishing the camera fixes')
  expect(g('Build the app and view the strip')).toBe('Building the app and viewing the strip')
  expect(gerund('Check tests and docs')).toBe('Checking tests and docs')
  expect(g('Copy files')).toBe('Copying files')
  expect(g('Tie the knot')).toBe('Tie the knot')
  expect(g('Git status of the repo')).toBe('Git status of the repo')
  expect(g('Checking already')).toBe('Checking already')
})

test('browser tools say what they do on the page', () => {
  expect(statusLabel('mcp__claude-in-chrome__javascript_tool', { text: 'x' })).toBe('Running JavaScript on a website')
  expect(statusLabel('mcp__claude-in-chrome__navigate', { url: 'https://music.apple.com/library' })).toBe('Opening music.apple.com')
  expect(statusLabel('mcp__claude-in-chrome__navigate', { url: 'not a url' })).toBe('Opening a website')
  expect(statusLabel('mcp__claude-in-chrome__tabs_context_mcp', {})).toBe('')
})

test('every built-in tool has a plain label, bookkeeping shows nothing', () => {
  const rows: [string, Record<string, unknown>, string][] = [
    ['Artifact', { action: 'publish', file_path: '/x/y/board.html' }, 'Publishing board.html'],
    ['Artifact', {}, 'Publishing a page'],
    ['Artifact', { action: 'publish', asset: true }, 'Uploading to a page'],
    ['Artifact', { action: 'read' }, 'Reading a page'],
    ['Artifact', { action: 'list' }, 'Looking through pages'],
    ['Artifact', { action: 'open' }, 'Opening a page'],
    ['Artifact', { action: 'quickstart' }, ''],
    ['Artifact', { action: 'delete' }, 'Deleting a page'],
    ['Artifact', { action: 'pin' }, 'Working on a page'],
    ['ArtifactData', { action: 'get' }, "Reading the page's data"],
    ['ArtifactData', { action: 'query' }, "Reading the page's data"],
    ['ArtifactData', { action: 'set' }, "Updating the page's data"],
    ['ArtifactComments', { action: 'read' }, 'Reading comments'],
    ['ArtifactComments', { action: 'reply' }, 'Replying to a comment'],
    ['Skill', { skill: 'ui' }, ''],
    ['AskUserQuestion', {}, 'Asking you something'],
    ['SendMessage', {}, 'Messaging an agent'],
    ['ListAgents', {}, 'Checking on the agents'],
    ['ReadNotifications', {}, 'Checking notifications'],
    ['Monitor', { description: 'CI on the PR' }, 'Watching CI on the PR'],
    ['Monitor', {}, 'Watching a task'],
    ['TaskStop', {}, 'Stopping a task'],
    ['KillShell', {}, 'Stopping a task'],
    ['TaskOutput', {}, 'Checking on a task'],
    ['BashOutput', {}, 'Checking on a task'],
    ['CronCreate', {}, 'Scheduling a task'],
    ['CronDelete', {}, 'Removing a scheduled task'],
    ['CronList', {}, 'Checking scheduled tasks'],
    ['ScheduleWakeup', {}, 'Scheduling a check-in'],
    ['EnterPlanMode', {}, 'Planning'],
    ['ExitPlanMode', {}, 'Finishing the plan'],
    ['EnterWorktree', {}, 'Setting up a worktree'],
    ['ExitWorktree', {}, 'Leaving the worktree'],
    ['PushNotification', {}, 'Sending a notification'],
    ['RemoteTrigger', {}, 'Triggering a remote run'],
    ['SendUserFile', {}, 'Sending you a file'],
    ['SendToProject', {}, 'Sending to another project'],
    ['SendToProjectContext', {}, 'Sending to another project'],
    ['DesignSync', {}, 'Syncing the design'],
    ['FetchInboxMessage', {}, 'Reading a message'],
    ['ListMcpResourcesTool', {}, 'Looking through resources'],
    ['ReadMcpResourceTool', {}, 'Reading a resource'],
    ['ReadMcpResourceDirTool', {}, 'Reading a resource'],
    ['ReportFindings', {}, 'Reporting findings'],
    ['SendFeedback', {}, 'Sending feedback'],
    ['Workflow', {}, 'Running a workflow'],
    ['EndConversation', {}, ''],
    ['advisor', {}, 'Checking with a reviewer'],
    ['LSP', {}, 'Checking the code'],
  ]
  for (const [tool, input, want] of rows) expect(statusLabel(tool, input)).toBe(want)
})

test('an unknown tool never shows a raw CamelCase name', () => {
  expect(statusLabel('ArtifactDataThing', {})).toBe('Artifact data thing')
  expect(statusLabel('Frobnicate', {})).toBe('Frobnicate')
  expect(statusLabel('some_new-tool', {})).toBe('Some new tool')
  expect(statusLabel('', {})).toBe('')
})

test("every tool Otto's server registers has a label, or '' on purpose", () => {
  const missing = TOOLS.map(t => t.name).filter(n => !(n in OTTO))
  expect(missing).toEqual([])
  expect(statusLabel('mcp__plugin_otto_otto__code_job', {})).toBe('Starting a coding job')
  expect(statusLabel('mcp__plugin_otto_otto__code_jobs', {})).toBe('Checking the coding jobs')
  expect(statusLabel('mcp__plugin_otto_otto__code_job_answer', {})).toBe('Answering the coding job')
  expect(statusLabel('mcp__plugin_otto_otto__set_email_state', {})).toBe('')
})
