import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { startTwin, phone, waitFor } from './apptwin.ts'
import { offerRouteReminder, type RouteOption } from '../travelroute.ts'

test('route tap arms one persisted trigger across duplicate taps', async () => {
  const t = await startTwin()
  try {
    const at = new Date(Date.now() + 3600_000).toISOString()
    const option = { reminder: { at, text: 'Time to leave in 5 minutes. Example Lane to Fiction Square, 18:00 UTC.' } } as RouteOption
    const button = offerRouteReminder(option, join(t.state, 'route-offers.json'))!
    const p = await phone(t)
    await p.until(f => f.type === 'hello')
    p.send({ type: 'tap', op: 'R1', ...button })
    const triggers = () => { try { return JSON.parse(readFileSync(join(t.state, 'triggers.json'), 'utf8')) as any[] } catch { return [] } }
    await waitFor(() => triggers().some(x => x.id.startsWith('route-')))
    p.send({ type: 'tap', op: 'R2', ...button })
    await p.until(f => f.type === 'ack' && f.id === 'R2')
    const routes = triggers().filter(x => x.id.startsWith('route-'))
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ schedule: at, repeating: false, enabled: true, type: 'cron' })
    expect(routes[0].action).toContain(option.reminder!.text)
  } finally { await t.stop() }
}, 60000)
