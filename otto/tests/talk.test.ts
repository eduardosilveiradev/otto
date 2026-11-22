import { test, expect } from 'bun:test'
import { TalkSession, pcmWav, talkMeta } from '../talk.ts'
const tick = () => new Promise(r => setTimeout(r, 5))
function rig() {
  let now = 0, resolve!: (b: Buffer) => void
  const frames: any[] = [], inputs: any[] = [], spoken: string[] = []
  const t = new TalkSession({ send: f => frames.push(f), timing: () => {}, stt: async (audio, partial) => {
    for await (const _ of audio) partial('hel')
    return { text: 'hello', language: 'en', engine: 'parakeet' }
  }, inbound: async (...a) => { inputs.push(a) }, tts: async text => { spoken.push(text); return new Promise(r => resolve = r) } }, () => now)
  const pcm = Buffer.alloc(3200); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i)
  return { t, frames, inputs, spoken, pcm, advance: () => now += 900, resolve: () => resolve(Buffer.from('wav')), audio: () => t.frame({ type: 'talk.audio', audio: pcm.toString('base64') }) }
}
test('WAV and inbound voice metadata', () => {
  const w = pcmWav(Buffer.alloc(3200)); expect(w.readUInt32LE(24)).toBe(16000); expect(w.readUInt32LE(40)).toBe(3200)
  expect(talkMeta({ device: 'phone' }, '/tmp/test.wav', 'en', 'parakeet')).toEqual({ device: 'phone', via: 'talk', voice: '1', audio_path: '/tmp/test.wav', transcript: 'parakeet', voice_language: 'en' })
})
test('partial, explicit end, duplicate end, invalid protocol', async () => {
  const r = rig(); r.t.frame({ type: 'talk.start' }); r.t.frame({ type: 'talk.audio', audio: '!' }); expect(r.frames.at(-1).type).toBe('talk.error')
  r.audio(); await tick(); expect(r.frames.at(-1).type).toBe('talk.partial')
  r.t.frame({ type: 'talk.end' }); r.t.frame({ type: 'talk.end' }); await tick(); expect(r.inputs.length).toBe(1); expect(r.frames.some(f => f.type === 'talk.final')).toBe(true); r.t.close()
})
test('silence end, cut suppresses speech while text completes', async () => {
  const r = rig(); r.t.frame({ type: 'talk.start' }); r.audio()
  for (let i = 0; i < 9; i++) r.t.frame({ type: 'talk.audio', audio: Buffer.alloc(3200).toString('base64') })
  await tick(); expect(r.inputs.length).toBe(1)
  r.t.delta('First. '); await tick(); r.t.frame({ type: 'talk.cut' }); r.t.delta('Second.', true); r.resolve(); await tick()
  expect(r.frames.filter(f => f.type === 'talk.audio')).toHaveLength(0)
  expect(r.frames.filter(f => f.type === 'talk.text').map(f => f.text).join('')).toBe('First. Second.')
  expect(r.spoken).toEqual(['First.']); expect(r.frames.at(-1).type).toBe('talk.done'); r.t.close()
})
test('ordered sentence WAVs, final text flushed', async () => {
  const r = rig(); r.t.frame({ type: 'talk.start' }); r.audio(); r.t.frame({ type: 'talk.end' }); await tick()
  r.t.delta('One. Tail', true); await tick(); r.resolve(); await tick(); r.resolve(); await tick()
  expect(r.spoken).toEqual(['One.', 'Tail']); expect(r.frames.filter(f => f.type === 'talk.audio').map(f => f.seq)).toEqual([0, 1]); r.t.close()
})
test('disconnect suppresses late transcription and inbound', async () => {
  const r = rig(); r.t.frame({ type: 'talk.start' }); r.audio(); r.t.frame({ type: 'talk.end' }); r.t.close(); await tick(); expect(r.inputs).toHaveLength(0)
})
test('network silence fallback ends once and closes cleanly', async () => {
  const r = rig(); r.t.frame({ type: 'talk.start' }); r.audio(); r.advance(); r.advance(); r.advance()
  await new Promise(r => setTimeout(r, 230)); expect(r.inputs).toHaveLength(1); r.t.close()
})
test('cut aborts incremental TTS and drops late chunks', async () => {
  const frames: any[] = []
  let send!: (b: Buffer) => void, signal!: AbortSignal, finish!: () => void
  const t = new TalkSession({ send: f => frames.push(f), timing: () => {}, stt: async () => ({ text: 'hello' }), inbound: async () => {}, tts: async (_text, emit, s) => {
    send = emit; signal = s; emit(Buffer.from('first')); await new Promise<void>(r => finish = r)
  } })
  t.frame({ type: 'talk.start' }); t.frame({ type: 'talk.audio', audio: Buffer.alloc(3200).toString('base64') }); t.frame({ type: 'talk.end' }); await tick()
  t.delta('Reply.', true); await tick(); expect(frames.filter(f => f.type === 'talk.audio')).toHaveLength(1)
  t.frame({ type: 'talk.cut' }); expect(signal.aborted).toBe(true); send(Buffer.from('late')); finish(); await tick()
  expect(frames.filter(f => f.type === 'talk.audio')).toHaveLength(1); expect(frames.at(-1).type).toBe('talk.done'); t.close()
})
