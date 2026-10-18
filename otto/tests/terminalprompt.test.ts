import { expect, test } from 'bun:test'
import { promptSnippet } from '../terminalprompt.ts'

test('first six words, an ellipsis only when there were more', () => {
  expect(promptSnippet('fix the  build\nplease')).toBe('fix the build please')
  expect(promptSnippet('one two three four five six')).toBe('one two three four five six')
  expect(promptSnippet('  one two three four five six seven  ')).toBe('one two three four five six…')
})

test('nothing typed, or something injected, gets no line', () => {
  expect(promptSnippet('')).toBeNull()
  expect(promptSnippet(' \n\t ')).toBeNull()
  expect(promptSnippet('<channel source="plugin:otto:otto">hi</channel>')).toBeNull()
  expect(promptSnippet('\n<task-notification>done</task-notification>')).toBeNull()
  expect(promptSnippet('<system-reminder>x</system-reminder>')).toBeNull()
  expect(promptSnippet('<command-name>/mcp</command-name>')).toBeNull()
})
