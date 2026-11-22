import { test, expect } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { startTwin, phone, waitFor } from './apptwin.ts'

test('tainted firing trigger re-arms only itself; owner app messages and taps clear the carry', async () => {
  const t = await startTwin()
  try {
    const webhook = () => fetch(`${t.url}/`, { method: 'POST', headers: { authorization: 'Bearer twin-webhook-token', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'outside content', source: 'test' }) })
    const check = () => t.call('self_edit_check', { paths: ['trigger:test-trigger/schedule'] }) as Promise<any>
    expect((await webhook()).status).toBe(204)
    expect(JSON.stringify(await check())).toContain('external-content')
    writeFileSync(join(t.state, 'triggers.json'), JSON.stringify([
      { id: 'test-trigger', type: 'cron', schedule: '* * * * *', action: 'check the weather', enabled: true, repeating: true, nextRun: Date.now() - 1000 },
      { id: 'other-trigger', type: 'cron', schedule: '0 9 * * *', action: 'other check', enabled: false },
    ]))
    expect(await waitFor(() => t.delivered.find(d => d.meta.trigger_id === 'test-trigger'), 70000)).toBeTruthy()
    expect(JSON.stringify(await check())).toContain('external-content')
    const update = (args: object) => t.call('update_trigger', { id: 'test-trigger', schedule: '0 9 * * *', ...args }) as Promise<any>
    expect((await update({ action: 'check the weather', repeating: true })).isError).not.toBe(true)
    expect((await update({ action: 'changed action' })).isError).toBe(true)
    expect((await update({ id: 'other-trigger' })).isError).toBe(true)
    const p = await phone(t)
    p.send({ type: 'tap', op: 'clear-tap', data: 'approved request', label: 'approve' })
    await waitFor(() => t.delivered.find(d => d.meta.event === 'button'))
    expect(JSON.stringify(await check())).not.toContain('external-content')
    await webhook()
    expect(JSON.stringify(await check())).toContain('external-content')
    p.send({ type: 'message', id: 'clear-message', text: 'new owner request' })
    await waitFor(() => t.delivered.find(d => d.content === 'new owner request'))
    expect(JSON.stringify(await check())).not.toContain('external-content')
    // A later webhook must also discard the previous firing trigger's authority.
    await webhook()
    expect((await update({})).isError).toBe(true)
    p.close()
  } finally { await t.stop() }
}, 90000)
