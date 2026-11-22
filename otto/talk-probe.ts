/** bun talk-probe.ts <ws(s)://host/app> <16kHz-mono-s16le.wav> [--screen <jpeg>]
 * OTTO_APP_TOKEN is read from the environment. Ctrl-C closes the socket. */
import { readFileSync } from 'fs'
const [url, file, option, jpeg, ...rest] = process.argv.slice(2)
if (!url || !file || !process.env.OTTO_APP_TOKEN || (option && (option !== '--screen' || !jpeg || rest.length))) {
  throw new Error('set OTTO_APP_TOKEN; bun talk-probe.ts <socket-url> <wav> [--screen <jpeg>]')
}
const wav = readFileSync(file)
let pcm: Buffer | undefined, valid = false
if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('expected WAV')
for (let i = 12; i + 8 <= wav.length;) {
  const size = wav.readUInt32LE(i + 4), tag = wav.toString('ascii', i, i + 4)
  if (i + 8 + size > wav.length) throw new Error('truncated WAV')
  if (tag === 'fmt ' && size >= 16) valid = wav.readUInt16LE(i + 8) === 1 && wav.readUInt16LE(i + 10) === 1 && wav.readUInt32LE(i + 12) === 16000 && wav.readUInt16LE(i + 22) === 16
  if (tag === 'data') pcm = wav.subarray(i + 8, i + 8 + size)
  i += 8 + size + size % 2
}
if (!valid || !pcm) throw new Error('convert: ffmpeg -i input -ar 16000 -ac 1 -c:a pcm_s16le output.wav')
let screen: string | undefined
if (jpeg) {
  const probe = Bun.spawnSync(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', '-i', jpeg])
  const dimensions = probe.success ? JSON.parse(probe.stdout.toString()).streams[0] : undefined
  if (!dimensions?.width || !dimensions?.height) throw new Error('ffprobe could not read screen JPEG dimensions')
  screen = JSON.stringify({ type: 'talk.screen', image: readFileSync(jpeg).toString('base64'), ...dimensions })
}
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${process.env.OTTO_APP_TOKEN}` } })
let recording = true
ws.onopen = () => ws.send(JSON.stringify({ type: 'talk.start' }))
ws.onmessage = async e => {
  const f = JSON.parse(String(e.data))
  if (!String(f.type).startsWith('talk.')) return
  console.log(JSON.stringify(f.type === 'talk.audio' ? { ...f, audio: `[${f.audio.length} base64 bytes]` } : f))
  if (f.type === 'talk.ending') recording = false
  if (f.type === 'talk.ready') {
    for (let i = 0; i < pcm!.length && recording && ws.readyState === WebSocket.OPEN; i += 3200) {
      if (screen && i % 64_000 === 0) ws.send(screen)
      ws.send(JSON.stringify({ type: 'talk.audio', audio: pcm!.subarray(i, i + 3200).toString('base64') })); await Bun.sleep(100)
    }
    if (recording && ws.readyState === WebSocket.OPEN) {
      if (screen) ws.send(screen)
      ws.send(JSON.stringify({ type: 'talk.end' }))
    }
  }
  if (f.type === 'talk.done' || f.type === 'talk.error') ws.close()
}
ws.onerror = () => { console.error('socket failed; check URL, device token and tunnel'); process.exitCode = 1 }
process.on('SIGINT', () => ws.close())
