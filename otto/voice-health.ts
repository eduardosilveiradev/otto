import { request } from 'node:http'
import type { Readable } from 'node:stream'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { extname, join } from 'path'

export type VoiceState = { checkedAt: string; since?: string; problem?: string }
type Engine = { engine?: string; fallback?: boolean }
export class VoiceHealth {
  state: VoiceState = { checkedAt: '' }
  private pending?: Promise<boolean>
  constructor(private save: (state: VoiceState) => void, private log: (message: string) => void) {}
  private update(problem?: string) {
    const now = new Date().toISOString()
    if (problem && problem !== this.state.problem) this.log(`Voice: ${problem}`)
    this.state = { checkedAt: now, ...(problem ? { problem, since: this.state.problem === problem ? this.state.since : now } : {}) }
    this.save(this.state)
    return !problem
  }
  fail() { return this.update('configured voice unavailable') }
  accept(result: Engine) {
    return this.update(result.fallback || result.engine === 'system' ? 'fell back to system voice' : result.engine !== 'qwen3' ? 'configured engine could not be verified' : undefined)
  }
  probe(call: () => Promise<Engine>): Promise<boolean> {
    if (this.pending) return this.pending
    this.pending = (async () => {
      try { return this.accept(await call()) }
      catch { return this.fail() }
    })().finally(() => { this.pending = undefined })
    return this.pending
  }
}
export function ownerVoiceChat(chat: string, owner?: string): boolean {
  return !!owner && /^[1-9]\d*$/.test(chat) && chat === owner
}
export async function transcribeOrResend<T extends { text: string }>(stt: () => Promise<T | null>, reply: (text: string) => Promise<unknown>): Promise<T | null> {
  let result: T | null = null
  try { result = await stt() } catch {}
  if (result?.text.trim()) return result
  await reply("couldn't hear that one, mind sending it again?")
  return null
}

/** POST to the voice daemon. remote: it runs on another machine (an SSH tunnel to
 * 127.0.0.1:port), so neither side can read the other's files and the audio rides
 * in the JSON both ways; the reply comes back as a local temp file all the same. */
export async function voicePost<T>(info: { port: number; token: string }, path: string, body: Record<string, unknown>, timeout: number | AbortSignal, remote = false): Promise<T> {
  if (remote && path === '/stt' && typeof body.path === 'string') {
    const { path: file, ...rest } = body
    body = { ...rest, audio_b64: readFileSync(file).toString('base64'), ext: extname(file).slice(1) || 'ogg' }
  }
  if (remote && path === '/tts') body = { ...body, inline: true }
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: typeof timeout === 'number' ? AbortSignal.timeout(timeout) : timeout,
  })
  const json = (await res.json()) as T & { error?: string; audio_b64?: string; ext?: string }
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
  if (typeof json.audio_b64 !== 'string') return json
  const { audio_b64, ext, ...rest } = json
  const dir = join(tmpdir(), 'otto-voice')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `otto-${Date.now()}.${ext || 'ogg'}`)
  writeFileSync(out, Buffer.from(audio_b64, 'base64'))
  return { ...rest, path: out } as T
}

/** Streaming WAV chunks over the same authenticated loopback/tunnel as voicePost. */
export async function voiceStreamPost(info: { port: number; token: string }, body: Record<string, unknown>, emit: (wav: Buffer) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${info.port}/tts/stream`, {
    method: 'POST', headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  })
  if (!res.ok || !res.body) throw new Error('streaming voice daemon unavailable; update the daemon and try again')
  let pending = '', done = false
  const decoder = new TextDecoder()
  for await (const bytes of res.body) {
    pending += decoder.decode(bytes, { stream: true })
    if (pending.length > 4_000_000) throw new Error('voice chunk exceeds limit')
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const f = JSON.parse(pending.slice(0, nl)); pending = pending.slice(nl + 1)
      if (f.error) throw new Error('configured speech unavailable')
      if (f.audio_b64 && !signal.aborted) emit(Buffer.from(f.audio_b64, 'base64'))
      if (f.done) { if (f.engine !== 'qwen3' || f.fallback) throw new Error('configured speech engine unavailable'); done = true }
    }
  }
  if (!done) throw new Error('speech stream ended early')
}

export type Heard = { text: string; language?: string; engine?: string }

/** Node's HTTP request can send PCM and read captions at the same time. */
export function voiceSttPost(
  info: { port: number; token: string }, settings: Record<string, string>, audio: Readable,
  partial: (text: string) => void, signal: AbortSignal,
): Promise<Heard> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: info.port, path: `/stt/stream?${new URLSearchParams(settings)}`,
      method: 'POST', headers: { Authorization: `Bearer ${info.token}`, 'Transfer-Encoding': 'chunked' },
      signal, agent: false,
    }, res => {
      void (async () => {
        if (res.statusCode !== 200) throw new Error(`voice stream HTTP ${res.statusCode}`)
        res.setEncoding('utf8')
        let pending = ''
        for await (const chunk of res) {
          pending += chunk
          if (pending.length > 1_000_000) throw new Error('transcript exceeds limit')
          let nl: number
          while ((nl = pending.indexOf('\n')) >= 0) {
            const frame = JSON.parse(pending.slice(0, nl))
            pending = pending.slice(nl + 1)
            if (frame.error) throw new Error(frame.error)
            if (frame.type === 'partial') partial(frame.text)
            if (frame.type === 'final') return frame as Heard
          }
        }
        throw new Error('transcription stream ended early')
      })().finally(cleanup).then(resolve, reject)
    })
    const cleanup = () => { audio.unpipe(req); req.destroy() }
    req.on('error', err => { cleanup(); reject(err) })
    req.flushHeaders() // Load STT on talk.start, before the first audio chunk.
    audio.pipe(req)
  })
}
