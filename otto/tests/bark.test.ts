import { test, expect } from 'bun:test'
import { BarkPushes } from '../bark.ts'

function setup(results: (number | Error)[]) {
  const calls: string[] = [], statuses: unknown[] = []
  const fn = (async (_url: string, init: RequestInit) => {
    calls.push(String(init.body))
    const result = results.shift()
    if (result instanceof Error) throw result
    return new Response('', { status: result ?? 200 })
  }) as unknown as typeof fetch
  return { pushes: new BarkPushes(fn, (status, attempt) => statuses.push([status, attempt])), calls, statuses }
}

test('Bark retries once on 5xx and network errors, checking HTTP status', async () => {
  for (const failure of [503, new Error('network')]) {
    const { pushes, calls } = setup([failure, 200])
    await pushes.send('https://example.com', { id: 'one', body: 'hello' })
    expect(calls).toHaveLength(2)
  }
  const { pushes, calls, statuses } = setup([500, 502])
  await expect(pushes.send('https://example.com', { id: 'one' })).rejects.toThrow('HTTP 502')
  expect(calls).toHaveLength(2)
  expect(statuses).toEqual([[500, 0], [502, 1]])
})

test('Bark does not retry 4xx and a failed id can be retried later', async () => {
  const { pushes, calls } = setup([400, 200])
  await expect(pushes.send('https://example.com', { id: 'one' })).rejects.toThrow('HTTP 400')
  expect(calls).toHaveLength(1)
  await pushes.send('https://example.com', { id: 'one' })
  expect(calls).toHaveLength(2)
})

test('Bark dedupes ids in flight, not identical bodies with distinct ids', async () => {
  const { pushes, calls } = setup([200, 200])
  await Promise.all(['one', 'one', 'two'].map(id => pushes.send('https://example.com', { id, body: 'same text' })))
  expect(calls).toHaveLength(2)
})
