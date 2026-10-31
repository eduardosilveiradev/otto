import { expect, test } from 'bun:test'
import { bubbles } from '../chunk.ts'

test('blank lines start a new bubble', () => {
  expect(bubbles('sure you did bro\n\nwhat, did it hallucinate?\n \nor inspect element')).toEqual(['sure you did bro', 'what, did it hallucinate?', 'or inspect element'])
  expect(bubbles('one line\nstill one bubble')).toEqual(['one line\nstill one bubble'])
})

test('code blocks and empty text stay whole', () => {
  expect(bubbles('look:\n\n```\na\n\nb\n```')).toEqual(['look:\n\n```\na\n\nb\n```'])
  expect(bubbles('')).toEqual([''])
})
