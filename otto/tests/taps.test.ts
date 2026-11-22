import { test, expect } from 'bun:test'
import { startTwin, phone } from './apptwin.ts'

// The two TAPS rows whose offered check runs in the table rather than in the handler:
// a tap naming no offer on record is answered and goes no further.
test('a sweep or diet tap the server never offered is refused in the channel', async () => {
  const t = await startTwin()
  try {
    const p = await phone(t)
    await p.until(f => f.type === 'hello')
    for (const [op, data] of [['S1', 'look sweep deadbeef'], ['D1', 'view diet 2020-01']]) {
      p.send({ type: 'tap', op, data, label: data })
      const said = await p.until(f => JSON.stringify(f).includes('that one is already settled'))
      expect(JSON.stringify(said)).toContain('already settled')
    }
  } finally { await t.stop() }
}, 60000)
