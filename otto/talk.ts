/**
 * Live talk on the authenticated /app socket (no separate credentials).
 * Client JSON: {type:"talk.start"} -> talk.ready; then
 * {type:"talk.audio",audio:<base64 PCM s16le mono 16000Hz>} (20–200ms),
 * {type:"talk.end"} (TurnDetector), {type:"talk.cut"}, {type:"talk.stop"}.
 * Optional {type:"talk.screen",image:<base64 JPEG>,width,height} on the same socket.
 * Send at most every 2s while sharing, plus once just before talk.end. At most 1.5 MB decoded.
 * A turn can attach the latest screenshot if it is less than 10s old.
 * {type:"talk.screen",off:true}, talk.stop and disconnect clear the cached picture.
 * Server JSON (all carry turn, except errors before start):
 * talk.ready {turn, sampleRate:16000}; talk.partial {turn,text};
 * talk.ending {turn} (stop mic chunks); talk.final {turn,text}; talk.accepted {turn};
 * talk.text {turn,text} (append); talk.audio {turn,seq,audio,format:"wav"};
 * talk.done {turn}; talk.cut {turn}; talk.error {turn?,error};
 * talk.timing {turn,endToTranscriptMs?,transcriptToFirstReplyMs?,sentenceToAudioMs?}.
 * Each audio frame is an independently playable WAV chunk; sequence spans sentences. Drop buffered audio
 * on cut; text/history still completes. start begins a new turn; send cut before starting during a reply.
 * Stop/disconnect discards unfinished mic input; completed inbound stays in history.
 * Limits: 60s/1.92MB per turn, 6400 bytes/chunk.
 * Silence fallback: 900ms of PCM below RMS 500 after speech, or 2s without chunks.
 * Speech recognition consumes PCM as it arrives. The buffered WAV is kept for inbound audio.
 * Reply adapter currently receives completed MCP reply text, NOT model tokens.
 * delta() supports incremental text when the session transport exposes it; timings
 * measure first available reply text, not an invented upstream token timestamp.
 */
import { randomUUID } from 'crypto'
import { PassThrough } from 'node:stream'
import type { Heard } from './voice-health.ts'

export const TALK_SILENCE_MS = 2000

export function pcmWav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF'); h.writeUInt32LE(pcm.length + 36, 4); h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}
export function talkMeta(device: Record<string, string>, path: string, language?: string, engine = 'whisper') {
  return { ...device, via: 'talk', voice: '1', audio_path: path, transcript: engine, ...(language ? { voice_language: language } : {}) }
}
type Deps = {
  send: (frame: Record<string, unknown>) => void
  stt: (audio: PassThrough, partial: (text: string) => void, signal: AbortSignal, finalWav: () => Buffer | undefined) => Promise<Heard | null>
  fallback?: (wav: Buffer) => Promise<Heard | null>
  inbound: (wav: Buffer, heard: Heard, id: string) => Promise<void>
  tts: (text: string, emit: (wav: Buffer) => void, signal: AbortSignal) => Promise<Buffer | null | void>
  timing: (frame: Record<string, unknown>) => void
}
export class TalkSession {
  private turn = ''
  private phase: 'idle' | 'mic' | 'final' | 'reply' = 'idle'
  private pcm: Buffer[] = []
  private bytes = 0
  private speech = false
  private silentMs = 0
  private lastChunk = 0
  private audio?: PassThrough
  private finalWav?: Buffer
  private heard?: Promise<Heard | null>
  private sttController?: AbortController
  private timer?: ReturnType<typeof setInterval>
  private epoch = 0
  private cut = false
  private controller?: AbortController
  private pending = ''
  private seq = 0
  private queue: Promise<void> = Promise.resolve()
  private ended = 0
  private transcribed = 0
  private firstText = false
  replyStarted = false
  get id() { return this.turn }
  private closed = false
  constructor(private d: Deps, private now = Date.now) {}
  get pendingTurn() { return this.phase === 'final' || this.phase === 'reply' }
  get awaitingReply() { return this.phase === 'reply' }
  private emit(type: string, extra: Record<string, unknown> = {}) { if (!this.closed) this.d.send({ type, turn: this.turn, ...extra }) }
  private timing(extra: Record<string, unknown>) { const f = { type: 'talk.timing', turn: this.turn, ...extra }; this.d.timing(f); this.emit('talk.timing', extra) }
  frame(f: Record<string, unknown>): void {
    try {
      if (f.type === 'talk.cut') { this.cut = true; this.controller?.abort(); this.epoch++; this.emit('talk.cut'); return }
      if (f.type === 'talk.stop') { this.close(); return }
      if (f.type === 'talk.start') {
        if (this.phase === 'final' || this.phase === 'reply') throw new Error('turn still awaiting reply; cut speech or wait for talk.done')
        if (this.phase === 'mic') throw new Error('turn already recording')
        this.closed = false; this.turn = randomUUID(); this.phase = 'mic'; this.pcm = []; this.bytes = 0
        this.speech = false; this.silentMs = 0; this.lastChunk = this.now()
        this.cut = false; this.epoch++; this.seq = 0; this.pending = ''; this.firstText = false
        const turn = this.turn
        this.audio = new PassThrough()
        this.sttController = new AbortController()
        this.heard = this.d.stt(this.audio, text => {
          if (this.phase === 'mic' && this.turn === turn && text) this.emit('talk.partial', { text })
        }, this.sttController.signal, () => this.turn === turn ? this.finalWav : undefined).catch(() => null)
        this.timer = setInterval(() => { if (this.phase === 'mic' && this.now() - this.lastChunk >= TALK_SILENCE_MS && this.bytes) void this.end() }, 200)
        this.timer.unref?.(); this.emit('talk.ready', { sampleRate: 16000 }); return
      }
      if (f.type === 'talk.end') { if (this.phase === 'mic') void this.end(); return }
      if (f.type !== 'talk.audio') throw new Error('unknown talk frame')
      if (this.phase !== 'mic') throw new Error('send talk.start before audio')
      if (typeof f.audio !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.audio)) throw new Error('audio must be base64 PCM')
      const pcm = Buffer.from(f.audio, 'base64')
      if (!pcm.length || pcm.length > 6400 || pcm.length % 2) throw new Error('audio must contain 1–3200 PCM samples')
      if (this.bytes + pcm.length > 1_920_000) { void this.end(); throw new Error('60 second turn limit reached') }
      this.audio?.write(pcm)
      this.pcm.push(pcm); this.bytes += pcm.length; this.lastChunk = this.now()
      let energy = 0
      for (let i = 0; i < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2
      if (Math.sqrt(energy / (pcm.length / 2)) >= 500) { this.speech = true; this.silentMs = 0 }
      else this.silentMs += pcm.length / 32
      if (this.speech && this.silentMs >= 900) { void this.end(); return }
    } catch (e) { this.emit('talk.error', { error: String((e as Error).message) }) }
  }
  private async end() {
    this.phase = 'final'; clearInterval(this.timer); this.ended = this.now(); this.emit('talk.ending')
    const turn = this.turn
    try {
      if (!this.bytes) throw new Error('empty turn; record audio and try again')
      const wav = pcmWav(Buffer.concat(this.pcm)); this.pcm = []
      this.finalWav = wav
      this.audio?.end()
      let heard = await this.heard
      if (this.closed || turn !== this.turn) return
      if (!heard && this.d.fallback) heard = await this.d.fallback(wav)
      if (this.closed || turn !== this.turn) return
      if (!heard?.text.trim()) throw new Error('could not hear that turn; try again')
      this.transcribed = this.now(); this.timing({ endToTranscriptMs: this.transcribed - this.ended })
      this.emit('talk.final', { text: heard.text }); this.phase = 'reply'
      await this.d.inbound(wav, heard, turn)
      this.emit('talk.accepted')
    } catch (e) {
      if (!this.closed && turn === this.turn) {
        this.phase = 'idle'
        this.emit('talk.error', { error: String((e as Error).message) })
      }
    } finally {
      if (turn === this.turn) this.stopStt()
    }
  }
  delta(text: string, done = false) {
    if (!this.awaitingReply || this.closed) return
    if (text && !this.firstText) { this.firstText = true; this.timing({ transcriptToFirstReplyMs: this.now() - this.transcribed }) }
    if (text) this.emit('talk.text', { text })
    this.pending += text
    const pieces = this.pending.split(/(?<=[.!?])\s+|\n+/)
    this.pending = done ? '' : pieces.pop() ?? ''
    for (const line of pieces) if (line.trim()) this.speak(line.trim())
    if (done) {
      const turn = this.turn
      void this.queue.then(() => { if (!this.closed && this.turn === turn) { this.emit('talk.done'); this.phase = 'idle' } })
    }
  }
  private speak(text: string) {
    const epoch = this.epoch, at = this.now(), turn = this.turn
    this.queue = this.queue.then(async () => {
      if (this.cut || this.closed || epoch !== this.epoch) return
      try {
        this.controller = new AbortController()
        let first = true
        const emit = (audio: Buffer) => {
          if (this.cut || this.closed || epoch !== this.epoch || turn !== this.turn) return
          if (first) { this.timing({ sentenceToAudioMs: this.now() - at }); first = false }
          this.emit('talk.audio', { seq: this.seq++, audio: audio.toString('base64'), format: 'wav' })
        }
        const audio = await this.d.tts(text, emit, this.controller.signal)
        if (audio) emit(audio)
      } catch { if (!this.cut && !this.closed) this.emit('talk.error', { error: 'speech unavailable; text reply continues' }) }
    })
  }
  private stopStt() {
    this.sttController?.abort()
    this.audio?.destroy()
    this.audio = undefined
    this.finalWav = undefined
    this.heard = undefined
  }
  close() { this.stopStt(); this.closed = true; this.cut = true; this.controller?.abort(); this.epoch++; clearInterval(this.timer); this.pcm = []; this.phase = 'idle' }
}

/** Active turns only; caller retains a turn through cut so its text still lands. */
export const talkTurns = new Set<TalkSession>()
export function talkReply(text: string, replyTo?: string, speak = true): boolean {
  const turn = [...talkTurns].find(t => t.awaitingReply && !t.replyStarted && (!replyTo || t.id === replyTo))
  if (!turn) return false
  if (!speak) turn.frame({ type: 'talk.cut' })
  turn.replyStarted = true
  turn.delta(text, true)
  return true
}
