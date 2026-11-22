import { expect, test } from 'bun:test'
import { assertNoPairingCode, buttonKeyboard, validateButtons } from '../buttons.ts'
import { startPairing } from '../pairing.ts'

test('validateButtons accepts empty, data, url and copy buttons', () => {
  expect(validateButtons([])).toEqual([])
  const buttons = [
    { label: 'Run', data: 'run it' },
    { label: 'Open', url: 'https://example.com' },
    { label: 'Copy', copy: 'some text' },
  ]
  expect(validateButtons(buttons)).toEqual(buttons)
})

test('validateButtons rejects invalid buttons', () => {
  expect(() => validateButtons(Array(7).fill({ label: 'Run', data: 'run' }))).toThrow('too many buttons')
  expect(() => validateButtons([{ label: 'Run', data: 'run', copy: 'text' }])).toThrow('exactly one')
  expect(() => validateButtons([{ data: 'run' }])).toThrow('label')
  expect(() => validateButtons([{ label: 'Pair', data: ' pair ok x' }])).toThrow('reserved button')
  for (const data of ['merge PR demo#1', 'merge stack demo#3..#4', ' close PR demo#1']) expect(() => validateButtons([{ label: 'ok', data }])).toThrow('reserved button')
  expect(validateButtons([{ label: 'ok', data: 'merge the two lists' }])).toHaveLength(1)
  expect(() => validateButtons([{ label: 'Run', data: 'é'.repeat(31) }])).toThrow('62 bytes (max 60)')
  expect(() => validateButtons([{ label: 'Open', url: 'http://example.com' }])).toThrow('https://')
  expect(() => validateButtons([{ label: 'Copy', copy: 'x'.repeat(257) }])).toThrow('1–256')
})

test('assertNoPairingCode refuses a pending code and accepts plain text', () => {
  const context = { origin: 'https://app.example.com', ip: '203.0.113.42', via: 'funnel' as const }
  const pairing = startPairing({}, context)
  expect(pairing.status).toBe(200)
  expect(() => assertNoPairingCode('plain text', `send pair ${pairing.body.user_code} to re-verify`)).toThrow('pairing code')
  expect(() => assertNoPairingCode('plain text')).not.toThrow()
})

test('buttonKeyboard lays out four buttons as 3 + 1 and prefixes callback data', () => {
  const keyboard = buttonKeyboard([
    { label: 'Run', data: 'run it' },
    { label: 'Open', url: 'https://example.com' },
    { label: 'Copy', copy: 'some text' },
    { label: 'Done', data: 'done' },
  ])
  expect(keyboard.inline_keyboard).toEqual([
    [
      { text: 'Run', callback_data: 'btn:run it' },
      { text: 'Open', url: 'https://example.com' },
      { text: 'Copy', copy_text: { text: 'some text' } },
    ],
    [{ text: 'Done', callback_data: 'btn:done' }],
  ])
})
