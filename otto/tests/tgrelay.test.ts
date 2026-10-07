import { describe, expect, test } from 'bun:test'
import { drainRelay, isUpdateBatch, makeDedupe } from '../tgrelay.ts'

describe('tgrelay', () => {
  test('dedupe passes each update_id once and forgets the oldest past its cap', () => {
    const fresh = makeDedupe(2)
    expect([fresh(1), fresh(1), fresh(2), fresh(3)]).toEqual([true, false, true, true])
    expect(fresh(1)).toBe(true) // evicted
    expect(fresh(3)).toBe(false)
  })

  test('isUpdateBatch wants an array of integer update_ids', () => {
    expect(isUpdateBatch([{ update_id: 1 }])).toBe(true)
    expect(isUpdateBatch([])).toBe(true)
    expect(isUpdateBatch({ update_id: 1 })).toBe(false)
    expect(isUpdateBatch([{ update_id: '1' }])).toBe(false)
  })

  test('drain takes oldest first, acks only what it took, and stops when empty', async () => {
    // A queue that grows once mid-drain, the way a message arriving during a drain would.
    let queue = [{ update_id: 12 }, { update_id: 10 }, { update_id: 11 }]
    const sent: any[] = []
    const fetchFn = (async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe('https://relay.example/drain')
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer s3cret')
      const body = JSON.parse(String(init.body))
      sent.push(body)
      if (typeof body.ack === 'number') queue = queue.filter(u => u.update_id > body.ack)
      if (sent.length === 2) queue.push({ update_id: 13 })
      return Response.json(queue)
    }) as unknown as typeof fetch

    const taken: number[][] = []
    const n = await drainRelay('https://relay.example', 's3cret', async b => { taken.push(b.map(u => u.update_id)) }, fetchFn)
    expect(taken).toEqual([[10, 11, 12], [13]])
    expect(sent).toEqual([{}, { ack: 12 }, { ack: 13 }])
    expect(n).toBe(4)
  })

  test('a failed take is not acked', async () => {
    const sent: any[] = []
    const fetchFn = (async (_u: URL, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)))
      return Response.json([{ update_id: 1 }])
    }) as unknown as typeof fetch
    await expect(drainRelay('https://relay.example', 's', async () => { throw new Error('boom') }, fetchFn)).rejects.toThrow('boom')
    expect(sent).toEqual([{}])
  })

  test('relay errors surface instead of looking like an empty queue', async () => {
    const fetchFn = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch
    await expect(drainRelay('https://relay.example', 's', async () => {}, fetchFn)).rejects.toThrow('HTTP 401')
  })
})
