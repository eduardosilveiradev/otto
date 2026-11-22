# App talk transport

Talk uses the existing authenticated `/app` WebSocket. The phone must keep its
normal socket heartbeat and device token handling. It can continue using
`POST /app/voice` until it implements the frames documented at the top of
`otto/talk.ts`.

Send 16 kHz mono signed 16-bit little-endian PCM, base64 encoded, in 20–200 ms
chunks. The server assigns a turn ID in `talk.ready`. A partial replaces the
previous partial; a final replaces it permanently. `talk.accepted` means the
voice message was saved through the normal inbound path. A failed or interrupted
recording must be sent again; mic buffers are not resumable after a disconnect.

On barge-in, stop local playback, discard queued audio and send `talk.cut`, then
`talk.start` for the next turn. Ignore audio from earlier turn IDs. The server
keeps the interrupted turn's text and history. It closes an active synthesis
request and skips all remaining sentences for that reply. Qwen may finish its
current decoder step before detecting the closed connection.

Audio frames contain independently playable WAV chunks, numbered across the
reply. Enqueue them in sequence. `talk.done` means no more audio is coming for
that turn; the ordinary chat message frames remain the source of chat history.
No desktop presence, quiet-mode or notification settings change.

## Shared screen

On the same socket, send `{"type":"talk.screen","image":"<base64 JPEG>","width":1440,"height":900}`
once every two seconds at most while sharing, plus one fresh capture just
before `talk.end`. Keep the JPEG at or below 1,500,000 bytes before encoding.
An oversized image or invalid JPEG signature yields `talk.error` within the
socket's 3 MiB transport limit.

The server keeps the latest valid image for that socket in memory. When it
accepts a turn, an image less than ten seconds old goes into the inbox next to
the audio. The turn carries `via="talk"` as usual, plus `image_path` and
`screen="1"`. The screenshot taints the turn because it can contain
third-party content.
Send `{"type":"talk.screen","off":true}` to clear the cached image immediately.
`talk.stop` and disconnect also clear it.

## Local speech

The server streams PCM to the voice daemon as it arrives. Parakeet can send
partial transcripts during recording. Whisper sends a final transcript only.
The phone's TurnDetector remains the primary detector. The server can also
end a turn after 900 ms below RMS 500 following speech, or after two seconds
without incoming audio.

Update the Mac's daemon from `otto/voice/voiced.py` before using talk. The new
`POST /tts/stream` endpoint uses the same bearer authentication and SSH tunnel
as `/tts`. It returns newline-delimited JSON audio chunks, followed by a done
frame. It calls Qwen with `stream=True, streaming_interval=0.3`; it does not wait
for the whole sentence's waveform. No cloud speech service or dependencies were
added. An older daemon reports speech unavailable; the text still arrives.

## Reply transport limitation

The persistent Claude Code session currently invokes MCP `reply` with complete
text. It does not expose live reply argument tokens to the channel server.
Consequently `talk.text` currently carries that completed reply, after its
normal talker pass and history write. The sentence speech queue supports
incremental deltas, but this adapter cannot deliver tokens before Claude Code
hands them off. True live reply text needs a session transport that exposes
those deltas; this change alone does not supply that part of live voice mode.

## Timing and an end-to-end check

Run from `otto/` with the device token in the environment:

```sh
ffmpeg -i input.wav -ar 16000 -ac 1 -c:a pcm_s16le talk.wav
bun talk-probe.ts wss://your-host/app talk.wav
```

Set `OTTO_APP_TOKEN` before running it. The script streams the file in real time
and prints transcripts, reply text, audio sizes and timing frames. It does not
play audio. Keep clips under 60 seconds. The server writes the same timing
frames to stderr, keyed by its random turn ID, without transcript contents.

To include a screenshot, pass a JPEG with `--screen`. The probe uses
`ffprobe`, from FFmpeg, to read its dimensions.

```sh
bun talk-probe.ts wss://your-host/app talk.wav --screen screen.jpg
```

Measurements are end-of-turn to final transcript, final transcript to first
available reply text, and each sentence's arrival to its first audio chunk
(including time queued behind previous speech). The second interval is not a
measurement of an upstream model token that the server cannot observe.

An isolated daemon using the configured voice produced these measurements for
“The connection is ready.” (one cold run, followed by one warm run):

| Path | First audio | Entire sentence | Chunks |
| --- | ---: | ---: | ---: |
| `/tts/stream`, cold model | 13,406 ms | 14,687 ms | 8 |
| `/tts/stream`, warm model | 775 ms | 1,477 ms | 6 |

The existing warm `/tts` endpoint took 10,087 ms in a separate baseline check.
The streaming measurement starts at the daemon HTTP request, so it excludes the
server's health check, queue wait, WebSocket delivery and phone playback. It is
not an end-to-end phone measurement. The warm streaming result meets the
approximately 1.5-second speech-start target for this sentence; cold startup
does not. Speech recognition and Qwen share the MLX lock, which can also delay
the first chunk.
The live daemon was neither updated nor restarted for this benchmark.
