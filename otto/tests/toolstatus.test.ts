import { expect, test } from 'bun:test'
import { statusLabel } from '../toolstatus.ts'

test('file tools name the file, not the path', () => {
  expect(statusLabel('Read', { file_path: '/x/y/ChatView.swift' })).toBe('Reading ChatView.swift')
  expect(statusLabel('Edit', { file_path: '/x/server.ts' })).toBe('Editing server.ts')
})

test('Bash prefers its description', () => {
  expect(statusLabel('Bash', { command: 'xcodebuild -x', description: 'Build the app' })).toBe('Build the app')
  expect(statusLabel('Bash', { command: 'xcodebuild -x' })).toBe('Running xcodebuild')
})

test('otto sends are the reply itself, so they show nothing', () => {
  expect(statusLabel('mcp__plugin_otto_otto__reply', { text: 'hi' })).toBe('')
  expect(statusLabel('ToolSearch', {})).toBe('')
})

test('connectors read as what they check', () => {
  expect(statusLabel('mcp__claude_ai_Gmail__search_threads', {})).toBe('Checking mail')
  expect(statusLabel('mcp__plugin_otto_otto__recall', {})).toBe('Remembering')
  expect(statusLabel('mcp__thing__do_stuff', {})).toBe('Do stuff')
})

test('long labels are cut', () => {
  expect(statusLabel('Grep', { pattern: 'x'.repeat(100) }).length).toBe(60)
})
