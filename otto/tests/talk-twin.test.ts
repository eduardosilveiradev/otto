import { test, expect } from 'bun:test'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { startTwin, anotherDevice, phone, waitFor } from './apptwin.ts'
import { TALK_SILENCE_MS } from '../talk.ts'

function jpegBytes(size: number) {
  const jpeg = Buffer.alloc(size)
  jpeg.set([0xff, 0xd8, 0xff])
  return jpeg
}
const screenFrame = (jpeg: Buffer) => ({ type: 'talk.screen', image: jpeg.toString('base64'), width: 1440, height: 900 })

async function talkTwin(fullPass: 'success' | 'slow' | 'error' = 'success') {
  const daemon = createServer(async (req, res) => {
    const path = req.url?.split('?')[0]
    const json = (frame: object, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(frame))
    }
    if (path === '/health') return json({ ok: true })
    if (path === '/stt/stream') {
      const send = (frame: object) => res.write(JSON.stringify(frame) + '\n')
      let bytes = 0
      try {
        for await (const chunk of req) {
          if (!bytes) send({ type: 'partial', text: 'test' })
          bytes += chunk.length
        }
      } catch (error) {
        if (req.aborted) return
        throw error
      }
      if (bytes === 3200) send({ type: 'final', text: 'test turn', engine: 'parakeet' })
      return res.end()
    }
    if (path === '/stt') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const wav = Buffer.from(body.audio_b64, 'base64')
      if (body.ext !== 'wav' || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.length !== 3244) {
        return json({ error: 'expected the whole WAV' }, 400)
      }
      if (fullPass === 'error') return json({ error: 'test error' }, 500)
      if (fullPass === 'slow') await Bun.sleep(4000)
      return json({ text: 'corrected turn', engine: 'parakeet' })
    }
    if (path === '/probe') return json({ engine: 'qwen3' })
    if (path === '/tts/stream') return res.end(JSON.stringify({ audio_b64: Buffer.from('wav').toString('base64'), ext: 'wav' }) + '\n' + JSON.stringify({ done: true, engine: 'qwen3' }) + '\n')
    return json({}, 404)
  }).listen(0, '127.0.0.1')
  await once(daemon, 'listening')
  const address = daemon.address()
  if (!address || typeof address === 'string') throw new Error('test daemon has no port')
  const twin = await startTwin()
  const file = join(twin.state, 'access.json')
  const access = JSON.parse(readFileSync(file, 'utf8')); access.voice = { enabled: true, remote: true }; writeFileSync(file, JSON.stringify(access))
  writeFileSync(join(twin.state, 'voice-daemon.json'), JSON.stringify({ port: address.port, token: 'test-daemon-token' }))
  return { ...twin, stop: async () => {
    await twin.stop()
    daemon.closeAllConnections()
    daemon.close()
    rmSync(dirname(dirname(twin.state)), { recursive: true, force: true })
  } }
}

async function acceptTurn(twin: Awaited<ReturnType<typeof talkTwin>>, p: Awaited<ReturnType<typeof phone>>, screen?: Buffer) {
  const previous = p.got.length
  p.send({ type: 'talk.start' })
  const ready = await waitFor(() => p.got.slice(previous).find(f => f.type === 'talk.ready'))
  expect(ready).toBeDefined()
  p.send({ type: 'talk.audio', audio: Buffer.alloc(3200).toString('base64') })
  expect(await p.until(f => f.type === 'talk.partial' && f.turn === ready.turn)).toMatchObject({ text: 'test' })
  if (screen) p.send(screenFrame(screen))
  p.send({ type: 'talk.end' })
  expect(await p.until(f => f.type === 'talk.accepted' && f.turn === ready.turn)).toBeDefined()
  const incoming = await waitFor(() => twin.delivered.find(d => d.meta.message_id === ready.turn))
  expect(incoming).toBeDefined()
  return incoming!
}

test('live talk quiets ordinary replies until stop, disconnect, or a phone message', async () => {
  const twin = await talkTwin()
  const p = await phone(twin)
  const mac = await phone(anotherDevice(twin))
  const reply = async (text: string, extra: Record<string, unknown> = {}) => {
    await twin.call('reply', { chat_id: 'app', text, verbatim: true, ...extra })
    const message = await p.until(f => f.type === 'message' && f.text === text)
    expect(message).toBeDefined()
    return message
  }
  try {
    const incoming = await acceptTurn(twin, p)
    expect(await reply('Spoken reply.', { reply_to: incoming.meta.message_id })).toMatchObject({ quiet: true })
    expect(await p.until(f => f.type === 'talk.audio')).toBeDefined()
    expect(await p.until(f => f.type === 'talk.done')).toBeDefined()
    expect(await reply('Between turns.')).toMatchObject({ quiet: true })
    expect(await reply('Reminder.', { bark: true })).toMatchObject({ bark: true })
    expect(p.got.find(f => f.text === 'Reminder.' && f.type === 'message').quiet).toBeUndefined()
    const history = await fetch(`${twin.url}/app/history`, { headers: { Authorization: `Bearer ${twin.token}` } }).then(r => r.json()) as { text: string; quiet?: boolean }[]
    expect(history.find((row) => row.text === 'Spoken reply.')).toMatchObject({ quiet: true })
    p.send({ type: 'talk.stop' })
    await Bun.sleep(TALK_SILENCE_MS + 200)
    expect((await reply('After stop.')).quiet).toBeUndefined()

    mac.send({ type: 'presence', focused: true })
    mac.send({ type: 'talk.start' })
    expect(await mac.until(f => f.type === 'talk.ready')).toBeDefined()
    expect(await reply('On the Mac.')).toMatchObject({ quiet: true, quietReason: 'talk' })
    p.send({ type: 'message', id: 'typed-during-talk', text: 'Back on the phone' })
    expect(await p.until(f => f.type === 'ack' && f.id === 'typed-during-talk')).toBeDefined()
    expect((await reply('Back to texting.')).quiet).toBeUndefined()
    mac.send({ type: 'talk.stop' })
    mac.send({ type: 'talk.start' })
    expect(await waitFor(() => mac.got.filter(f => f.type === 'talk.ready').length === 2)).toBe(true)
    expect((await reply('After talk restarted.')).quiet).toBeUndefined()
    const closed = new Promise(resolve => mac.ws.addEventListener('close', resolve, { once: true }))
    mac.close()
    await closed
    await Bun.sleep(TALK_SILENCE_MS + 200)
    expect((await reply('After disconnect.')).quiet).toBeUndefined()
  } finally { mac.close(); p.close(); await twin.stop() }
}, 30000)

test('authenticated talk attaches the latest screen and cut preserves reply in history', async () => {
  const twin = await talkTwin()
  const p = await phone(twin)
  try {
    p.send(screenFrame(jpegBytes(4)))
    const jpeg = jpegBytes(1_500_000)
    const incoming = await acceptTurn(twin, p, jpeg)
    expect(incoming.meta).toMatchObject({ chat_id: 'app', via: 'talk', voice: '1', transcript: 'parakeet', screen: '1' })
    expect(incoming.content).toContain('corrected turn')
    expect(p.got.find(f => f.type === 'talk.final')).toMatchObject({ text: 'corrected turn' })
    expect(dirname(incoming.meta.image_path)).toBe(dirname(incoming.meta.audio_path))
    expect(readFileSync(incoming.meta.image_path).equals(jpeg)).toBe(true)
    expect(JSON.stringify(await twin.call('reload', {}))).toContain('the attached screen can contain text from other sources')
    p.send({ type: 'talk.cut' }); await p.until(f => f.type === 'talk.cut')
    await twin.call('reply', { chat_id: 'app', text: 'The text still lands.', reply_to: incoming.meta.message_id })
    await p.until(f => f.type === 'talk.done')
    expect(p.got.filter(f => f.type === 'talk.audio')).toHaveLength(0)
    const history = await fetch(`${twin.url}/app/history`, { headers: { Authorization: `Bearer ${twin.token}` } }).then(r => r.json())
    expect(JSON.stringify(history)).toContain('The text still lands.')
  } finally { p.close(); await twin.stop() }
}, 30000)

test.each(['slow', 'error'] as const)('talk uses the streaming final when the full pass is %s', async (mode) => {
  const twin = await talkTwin(mode)
  const p = await phone(twin)
  try {
    const incoming = await acceptTurn(twin, p)
    expect(incoming.content).toContain('test turn')
    expect(incoming.meta.transcript).toBe('parakeet')
    expect(p.got.find(f => f.type === 'talk.final')).toMatchObject({ text: 'test turn' })
    const timing = p.got.find(f => f.type === 'talk.timing')
    expect(timing.endToTranscriptMs).toBeLessThan(mode === 'slow' ? 2000 : 1500)
    if (mode === 'slow') expect(timing.endToTranscriptMs).toBeGreaterThanOrEqual(1400)
  } finally { p.close(); await twin.stop() }
}, 30000)

test('invalid screens are rejected and off, stop and disconnect clear screenshots', async () => {
  const twin = await talkTwin()
  let p = await phone(twin)
  try {
    p.send(screenFrame(jpegBytes(1_500_001)))
    p.send(screenFrame(Buffer.from('not a JPEG')))
    expect(await p.until(f => f.type === 'talk.error' && f.error.includes('1.5 MB'))).toBeDefined()
    expect(await p.until(f => f.type === 'talk.error' && f.error.includes('base64 JPEG'))).toBeDefined()
    expect((await acceptTurn(twin, p)).meta.image_path).toBeUndefined()
    p.send({ type: 'talk.stop' })

    for (const clear of [{ type: 'talk.screen', off: true }, { type: 'talk.stop' }]) {
      p.send(screenFrame(jpegBytes(4)))
      p.send(clear)
      expect((await acceptTurn(twin, p)).meta.image_path).toBeUndefined()
      p.send({ type: 'talk.stop' })
    }

    p.send(screenFrame(jpegBytes(4)))
    p.send({ type: 'talk.start' })
    expect(await waitFor(() => p.got.filter(f => f.type === 'talk.ready').length === 4)).toBe(true)
    const closed = new Promise(resolve => p.ws.addEventListener('close', resolve, { once: true }))
    p.close()
    await closed
    p = await phone(twin)
    expect((await acceptTurn(twin, p)).meta.image_path).toBeUndefined()
    expect(readdirSync(join(twin.state, 'inbox')).filter(file => file.endsWith('.jpg'))).toEqual([])
  } finally { p.close(); await twin.stop() }
}, 30000)
