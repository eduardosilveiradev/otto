import { test, expect } from 'bun:test'
import { VoiceHealth, ownerVoiceChat, transcribeOrResend } from '../voice-health.ts'

test('probe detects fallback, logs once, preserves onset and recovers', async () => {
  const logs: string[] = [], saved: unknown[] = []
  const health = new VoiceHealth(s => saved.push(s), s => logs.push(s))
  expect(await health.probe(async () => ({ engine: 'system', fallback: true }))).toBe(false)
  const since = health.state.since
  expect(await health.probe(async () => ({ engine: 'system' }))).toBe(false)
  expect(health.state.since).toBe(since)
  expect(logs).toHaveLength(1)
  expect(await health.probe(async () => ({ engine: 'qwen3' }))).toBe(true)
  expect(health.state.problem).toBeUndefined()
  expect(saved).toHaveLength(3)
})
test('unknown and failing engines fail closed; synthesis fallback is refused', async () => {
  const h = new VoiceHealth(() => {}, () => {})
  expect(await h.probe(async () => { throw Error('load failed') })).toBe(false)
  expect(h.accept({})).toBe(false)
  expect(h.accept({ engine: 'system', fallback: true })).toBe(false)
})
test('only the owner private chat can receive Telegram voice, including explicit requests', () => {
  expect(ownerVoiceChat('1234567890', '1234567890')).toBe(true)
  for (const id of ['-1234567890', '-1000000000000', '2345678901', '']) expect(ownerVoiceChat(id, '1234567890')).toBe(false)
  expect(ownerVoiceChat('1234567890')).toBe(false)
})
test('failed, empty and throwing STT ask once to resend; successful STT does not', async () => {
  const replies: string[] = []
  const reply = async (s: string) => { replies.push(s) }
  for (const stt of [async () => null, async () => ({ text: ' ' }), async () => { throw Error('STT failed') }]) {
    expect(await transcribeOrResend(stt, reply)).toBeNull()
  }
  expect(replies).toEqual(Array(3).fill("couldn't hear that one, mind sending it again?"))
  expect(await transcribeOrResend(async () => ({ text: 'hello' }), reply)).toEqual({ text: 'hello' })
  expect(replies).toHaveLength(3)
})

test('daemon probes configured engines with Python engine stubs', async () => {
  const proc = Bun.spawn(['python3', new URL('../voice/test_probe.py', import.meta.url).pathname], { stdout: 'pipe', stderr: 'pipe' })
  const stderr = await new Response(proc.stderr).text()
  expect(await proc.exited, stderr).toBe(0)
})

test('daemon takes STT audio inline and inlines TTS audio', async () => {
  const proc = Bun.spawn(['python3', new URL('../voice/test_inline.py', import.meta.url).pathname], { stdout: 'pipe', stderr: 'pipe' })
  const stderr = await new Response(proc.stderr).text()
  expect(await proc.exited, stderr).toBe(0)
})

test('overlapping startup, periodic and reply probes share one engine load', async () => {
  const h = new VoiceHealth(() => {}, () => {})
  let finish!: (value: { engine: string }) => void
  let calls = 0
  const load = () => { calls++; return new Promise<{ engine: string }>(resolve => { finish = resolve }) }
  const startup = h.probe(load)
  const periodic = h.probe(load)
  finish({ engine: 'qwen3' })
  expect(await startup).toBe(true)
  expect(await periodic).toBe(true)
  expect(calls).toBe(1)
})

test('voicePost sends audio inline to a remote daemon and lands its reply in a local file', async () => {
  const { voicePost } = await import('../voice-health.ts')
  const { mkdtempSync, writeFileSync, readFileSync } = await import('fs')
  const { join } = await import('path')
  const { tmpdir } = await import('os')
  const note = join(mkdtempSync(join(tmpdir(), 'otto-vp-')), 'note.m4a')
  writeFileSync(note, 'heard')
  const sent: Record<string, unknown>[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    sent.push(body)
    return Response.json(body.inline ? { audio_b64: Buffer.from('spoken').toString('base64'), ext: 'ogg', seconds: 1 } : { text: 'hi' })
  }) as typeof fetch
  try {
    const info = { port: 1, token: 't' }
    expect(await voicePost(info, '/stt', { path: note, language: 'en' }, 1000, true)).toEqual({ text: 'hi' })
    expect(sent[0]).toEqual({ language: 'en', audio_b64: Buffer.from('heard').toString('base64'), ext: 'm4a' })
    const tts = await voicePost<{ path: string; seconds: number }>(info, '/tts', { text: 'yo' }, 1000, true)
    expect(sent[1]).toEqual({ text: 'yo', inline: true })
    expect(tts.path.endsWith('.ogg') && readFileSync(tts.path, 'utf8')).toBe('spoken')
    expect(tts.seconds).toBe(1)
    await voicePost(info, '/stt', { path: note }, 1000)
    expect(sent[2]).toEqual({ path: note })
  } finally {
    globalThis.fetch = real
  }
})

test('voice stream forwards chunks before EOF and abort closes the request', async () => {
  const { voiceStreamPost } = await import('../voice-health.ts')
  const frames: Buffer[] = []
  const abort = new AbortController()
  const server = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(JSON.stringify({ audio_b64: Buffer.from('first').toString('base64') }) + '\n'))
  } }), { headers: { 'content-type': 'application/x-ndjson' } }) })
  try {
    await expect(voiceStreamPost({ port: server.port!, token: 'test' }, { text: 'hello' }, b => { frames.push(b); abort.abort() }, abort.signal)).rejects.toThrow()
    expect(frames.map(b => b.toString())).toEqual(['first'])
  } finally { server.stop(true) }
})
test('incremental Qwen daemon emits before generation completes (Python stubs)', () => {
  const r = Bun.spawnSync(['python3', 'voice/test_stream.py'], { cwd: new URL('..', import.meta.url).pathname })
  expect(r.exitCode).toBe(0)
})

test('STT daemon streams partials before end, flushes the tail, and honors engine settings', async () => {
  const { voiceSttPost } = await import('../voice-health.ts')
  const { PassThrough } = await import('node:stream')
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'otto-stt-test-'))
  const infoPath = join(dir, 'info.json')
  const proc = Bun.spawn(['python3', 'voice/test_stt.py'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, OTTO_VOICE_TOKEN: 'test', OTTO_VOICE_INFO: infoPath, OTTO_VOICE_PORT: '0',
      OTTO_VOICE_CONFIG: '{}', OTTO_VOICE_LOG: join(dir, 'log'), OTTO_VOICE_PARENT: String(process.pid), PYTHONDONTWRITEBYTECODE: '1' },
  })
  try {
    let info: { port: number; token: string } | undefined
    for (let i = 0; i < 100 && !info; i++) {
      try { info = JSON.parse(readFileSync(infoPath, 'utf8')) } catch { await Bun.sleep(20) }
    }
    expect(info).toBeDefined()
    const signal = AbortSignal.timeout(4000)
    const audio = new PassThrough()
    const partials: string[] = []
    const final = voiceSttPost(info!, {}, audio, text => {
      partials.push(text)
      audio.end(Buffer.alloc(3200, 1))
    }, signal)
    for (let i = 0; i < 5; i++) audio.write(Buffer.alloc(3200, 1))
    expect(await final).toMatchObject({ type: 'final', text: 'speech speech', engine: 'parakeet' })
    expect(partials).toEqual(['speech'])

    const whisper = 'mlx-community/whisper-large-v3-turbo'
    for (const settings of [{ model: whisper, language: 'it' }, { language: 'ja' }]) {
      const audio = new PassThrough()
      const final = voiceSttPost(info!, settings, audio, () => { throw new Error('unexpected Whisper partial') }, signal)
      audio.end(Buffer.alloc(3200, 1))
      expect(await final).toMatchObject({ type: 'final', text: whisper, language: settings.language, engine: 'whisper' })
    }
  } catch (err) {
    throw new Error(readFileSync(join(dir, 'log'), 'utf8'), { cause: err })
  } finally {
    proc.kill()
    await proc.exited
    rmSync(dir, { recursive: true, force: true })
  }
}, 10_000)
