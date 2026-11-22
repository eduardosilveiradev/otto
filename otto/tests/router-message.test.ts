import { test, expect } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { startTwin, phone, waitFor } from './apptwin.ts'

test('app injection routes enabled hard messages while preserving history and excluding events', async () => {
  const t = await startTwin()
  try {
    const p = await phone(t)
    p.send({ type: 'message', id: 'router-off', text: 'debug this code' })
    await waitFor(() => t.delivered.some(d => d.meta.message_id === 'router-off'))
    expect(t.delivered.find(d => d.meta.message_id === 'router-off')?.content).toBe('debug this code')
    const file = join(t.state, 'access.json')
    const access = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...access, router: { messages: true } }))
    for (const [id, text] of [['router-hard', 'debug the code'], ['router-chat', 'thanks']]) {
      p.send({ type: 'message', id, text })
      await waitFor(() => t.delivered.some(d => d.meta.message_id === id))
      expect(t.delivered.find(d => d.meta.message_id === id)?.content).toBe(text + (id === 'router-hard' ? '\nultrathink' : ''))
    }
    const history = await (await fetch(`${t.url}/app/history`, { headers: { authorization: `Bearer ${t.token}` } })).json() as any[]
    expect(history.find(h => h.id === 'router-hard')?.text).toBe('debug the code')
    const hook = await fetch(`${t.url}/`, {
      method: 'POST', headers: { authorization: 'Bearer twin-webhook-token', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'debug this webhook code', source: 'ci' }),
    })
    expect(hook.ok).toBe(true)
    await waitFor(() => t.delivered.some(d => d.meta.event === 'webhook'))
    expect(t.delivered.find(d => d.meta.event === 'webhook')?.content).not.toContain('ultrathink')
  } finally { await t.stop() }
}, 30000)
