import { test, expect } from 'bun:test'
import { parseAsk, waitForReply, settleReply } from '../appask.ts'

const ID = '0D0D0D0D-0000-4000-8000-000000000001'

test('parseAsk siri trims and slices', () => {
  expect(parseAsk({ id: ID, text: '  what is due monday ', via: 'siri' })).toEqual({ id: ID, text: 'what is due monday', meta: { via: 'siri' } })
  expect(parseAsk({ id: ID, text: 'x'.repeat(3000), via: 'siri' })!.text).toHaveLength(2000)
})

test('parseAsk rejects bad bodies', () => {
  for (const b of [null, [], 'hi', { text: 'a', via: 'siri' }, { id: 'a b', text: 'a', via: 'siri' },
    { id: 'a'.repeat(65), text: 'a', via: 'siri' }, { id: ID, text: 'a', via: 'other' }, { id: ID, text: '   ', via: 'siri' }])
    expect(parseAsk(b)).toBeUndefined()
})

test('parseAsk keyboard carries the field text', () => {
  expect(parseAsk({ id: ID, text: 'reply yes', via: 'keyboard', field: ' are you coming? ' }))
    .toEqual({ id: ID, text: 'reply yes\n\nText in the field:\nare you coming?', meta: { via: 'keyboard' } })
  expect(parseAsk({ id: ID, text: '', via: 'keyboard', field: 'hey there' })!.text).toBe('(continue this)\n\nText in the field:\nhey there')
  expect(parseAsk({ id: ID, text: 'hi', via: 'keyboard' })!.text).toBe('hi')
  expect(parseAsk({ id: ID, text: ' ', via: 'keyboard', field: ' ' })).toBeUndefined()
  expect(parseAsk({ id: ID, text: 'x', via: 'keyboard', field: 'y'.repeat(3000) })!.text.endsWith('y'.repeat(2000))).toBe(true)
})

test('parseAsk here builds the place meta', () => {
  const r = parseAsk({ id: 'a1', text: 'good pão de queijo', via: 'here',
    place: { lat: 38.7223, lon: -9.1393, accuracy: 12.6, name: ' Café Exemplo ', city: 'Lisboa', country: 'Portugal', address: '' } })
  expect(r?.text).toBe('good pão de queijo')
  expect(r?.meta).toEqual({ via: 'here', here_lat: '38.72230', here_lon: '-9.13930', here_accuracy: '13', here_name: 'Café Exemplo', here_city: 'Lisboa', here_country: 'Portugal' })
  expect(parseAsk({ id: 'a1', text: '', via: 'here', place: { lat: 1, lon: 2 } })?.text).toBe('(save this place)')
})

test('parseAsk here validates the place', () => {
  const p = (place: unknown) => parseAsk({ id: 'a1', text: 'x', via: 'here', place })
  expect(p(undefined)).toBeUndefined()
  expect(p({ lat: 91, lon: 0 })).toBeUndefined()
  expect(p({ lat: '38', lon: 0 })).toBeUndefined()
  expect(p({ lat: 38, lon: null })).toBeUndefined()
  expect(p({ lat: 1, lon: 2, name: 'n'.repeat(300) })!.meta.here_name).toHaveLength(120)
  expect(p({ lat: 1, lon: 2, city: 5 })!.meta.here_city).toBeUndefined()
})

test('waitForReply and settleReply', async () => {
  const r1 = { id: 'r1', text: 'one', buttons: [] }
  const r2 = { id: 'r2', text: 'two', buttons: [] }
  settleReply(r1)   // nobody waiting: no-op
  expect(await waitForReply(20)).toBeUndefined()
  settleReply(r1)   // after a timeout: doesn't throw
  const later = waitForReply(1000)
  settleReply(r2)
  expect(await later).toEqual(r2)
})

test('two asks at once each get their own answer, oldest first', async () => {
  const a = waitForReply(1000), b = waitForReply(1000)
  settleReply({ id: 'A', text: 'answer to a', buttons: [] })
  settleReply({ id: 'B', text: 'answer to b', buttons: [] })
  expect((await a)!.id).toBe('A')
  expect((await b)!.id).toBe('B')
})

test('a reply sent before the session has read the ask is not its answer', async () => {
  let read = false
  const a = waitForReply(1000, () => read)
  settleReply({ id: 'old', text: 'answer to an earlier message', buttons: [] })
  read = true
  settleReply({ id: 'new', text: 'the answer', buttons: [] })
  expect((await a)!.id).toBe('new')
})

test('parseAsk wallet carries the payment fields', () => {
  expect(parseAsk({ id: ID, via: 'wallet', amount: ' $4.50 ', merchant: 'Starbucks', card: 'Apple Cash' }))
    .toEqual({ id: ID, text: 'paid $4.50 at Starbucks with Apple Cash',
      meta: { via: 'wallet', wallet_amount: '$4.50', wallet_merchant: 'Starbucks', wallet_card: 'Apple Cash' } })
  expect(parseAsk({ id: ID, via: 'wallet', amount: '€3' })).toEqual({ id: ID, text: 'paid €3', meta: { via: 'wallet', wallet_amount: '€3' } })
  expect(parseAsk({ id: ID, via: 'wallet', merchant: 'Starbucks' })).toBeUndefined()
})
