import { test, expect } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTwin, phone, waitFor } from './apptwin.ts'

test('fallback probe makes an explicit spoken reply arrive as text without calling TTS', async () => {
  const calls: string[] = []
  const daemon = Bun.serve({ port: 0, fetch: req => {
    const path = new URL(req.url).pathname
    calls.push(path)
    return Response.json(path === '/probe' ? { engine: 'system', fallback: true } : { ok: true })
  } })
  let t = await startTwin()
  try {
    const config = JSON.parse(readFileSync(join(t.state, 'access.json'), 'utf8'))
    config.voice = { enabled: true, python: process.execPath }
    writeFileSync(join(t.state, 'access.json'), JSON.stringify(config))
    writeFileSync(join(t.state, 'voice-daemon.json'), JSON.stringify({ pid: process.pid, port: daemon.port, token: 'test-token' }))
    t = await t.restart()
    expect(await waitFor(() => calls.includes('/probe'))).toBe(true)
    const p = await phone(t)
    await t.call('reply', { chat_id: 'app', text: 'The door is closed.', voice: true, verbatim: true })
    const message = await p.until(f => f.type === 'message')
    expect(message.text).toBe('The door is closed.')
    expect(message.voice).toBeNull()
    expect(calls).toContain('/probe')
    expect(calls).not.toContain('/tts')
    expect(JSON.parse(readFileSync(join(t.state, 'voice-health.json'), 'utf8')).problem).toBe('fell back to system voice')
    p.close()
  } finally { await t.stop(); daemon.stop(true) }
}, 60000)
