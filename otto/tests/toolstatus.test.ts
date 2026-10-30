import { expect, test } from 'bun:test'
import { gerund, statusLabel } from '../toolstatus.ts'

test('file tools name the file, not the path', () => {
  expect(statusLabel('Read', { file_path: '/x/y/ChatView.swift' })).toBe('Reading ChatView.swift')
  expect(statusLabel('Edit', { file_path: '/x/server.ts' })).toBe('Editing server.ts')
})

test('Bash prefers its description', () => {
  expect(statusLabel('Bash', { command: 'xcodebuild -x', description: 'Build the app' })).toBe('Building the app')
  expect(statusLabel('Bash', { command: 'xcodebuild -x' })).toBe('Running xcodebuild')
})

test('otto sends are the reply itself, so they show nothing', () => {
  expect(statusLabel('mcp__plugin_otto_otto__reply', { text: 'hi' })).toBe('')
  expect(statusLabel('ToolSearch', {})).toBe('')
  expect(statusLabel('TaskCreate', { subject: 'x' })).toBe('')   // the to-do bubble shows it
})

test('connectors read as what they check', () => {
  expect(statusLabel('mcp__claude_ai_Gmail__search_threads', {})).toBe('Checking mail')
  expect(statusLabel('mcp__plugin_otto_otto__recall', {})).toBe('Remembering')
  expect(statusLabel('mcp__plugin_otto_otto__reload', {})).toBe('Restarting with the update')
  expect(statusLabel('Agent', { description: 'iOS app security review' })).toBe('Running a subagent: iOS app security review')
  expect(statusLabel('Agent', {})).toBe('Starting a subagent')
  expect(statusLabel('mcp__thing__do_stuff', {})).toBe('Do stuff')
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
