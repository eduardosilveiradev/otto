# voice — speech in and out for the otto channel

Optional, and off until you install it. Telegram voice notes arrive as words,
and Otto can answer out loud. Everything runs on the Mac with MLX. Parakeet transcribes voice notes and live talk,
and Qwen3-TTS speaks replies.

```
voice note ──▶ download ──▶ Parakeet ──▶ transcript is the message the session sees
reply(voice) ──▶ qwen3-tts ──▶ ffmpeg/opus ──▶ sendVoice, text as the caption
```

## Setup

```bash
bash otto/voice/setup.sh
```

Apple Silicon Macs only (MLX); on anything else setup.sh says so and exits,
and Otto stays a text channel. That is the whole install. It builds a venv at
`~/.otto/state/voice/.venv`, and the channel treats that interpreter
existing as "voice is on" — delete it and otto is a text channel again. Models
download on first use (~2.5GB Parakeet, ~2–4GB Qwen3) into the shared Hugging
Face cache. `ffmpeg` must be on PATH: Telegram only renders OGG/Opus as a real
voice note.

Two locations, on purpose. `voiced.py` lives in the plugin directory so it is
copied into the plugin cache along with `server.ts`; the venv, the models and
the reference clips live in the state dir, where nothing ever copies them.

## How it runs

`voiced.py` is a localhost HTTP daemon, started by `server.ts` the first time
anything needs it and shared by every otto process. It exists because both
models cost seconds to load and gigabytes to hold, and paying that per voice
note would make the channel feel broken.

- Bound to `127.0.0.1` on an ephemeral port (or `OTTO_VOICE_PORT`), bearer token required. Port and
  token land in `~/.otto/state/voice-daemon.json` once it is listening.
- MLX work is serialized. A talk stream releases the lock between PCM batches.
- Weights are dropped after `idleUnloadSeconds` (default 600) of quiet; the
  process itself exits when its parent dies or after six idle hours (never, run standalone).
- `stdout` is model chatter, not protocol. Logs (and any traceback) go to `~/.otto/state/voice/voiced.log`, one line per reply naming the mode, model, reference clip and length; results go to HTTP.

Endpoints: `GET /health`, `POST /probe`, `POST /stt {path}` (or `{audio_b64, ext}`), `POST /tts {text}` (add `inline: true` to get `{audio_b64, ext}` back instead of a path).

Talk opens `POST /stt/stream` to warm the configured speech model. It sends
16 kHz mono signed 16-bit little-endian PCM using chunked transfer encoding.
The daemon sends newline-delimited JSON with `type: "partial"` and the current
text, then `type: "final"` with the transcript when the request ends. Each
partial replaces the previous one. Whisper sends a final only.

Every voice path fails soft. No venv, dead daemon, model that will not load: the
channel does what it did before — plain text — and says so in the tool result.

## Configuration

All of it lives under `voice` in `~/.otto/state/access.json`:

```jsonc
{
  "voice": {
    "enabled": true,
    "stt": true,
    "autoReply": "mirror",      // speak when the user last spoke. always | never
    "mirrorWindowMinutes": 15,
    "speaker": "ryan",          // named Qwen3 voice
    "instruct": "Dry, warm, unhurried. Short sentences.",
    "language": "English",
    "maxSpeakChars": 900,
    "idleUnloadSeconds": 600,
    "sttModel": "mlx-community/parakeet-tdt-0.6b-v3", // default
    "sttLanguage": "",           // empty lets the model recognize the language
    "refAudio": "~/.otto/state/voice/refs/myvoice.wav", // clone — wins over speaker
    "refText": "…",              // exactly what is said in that clip
    "remote": false              // daemon on another machine; see below
  }
}
```

Parakeet v3 recognizes 25 European languages automatically, English among
them. If an explicit `sttLanguage` is outside that set,
Otto uses Whisper for that recording. Set `sttModel` to
`mlx-community/whisper-large-v3-turbo` to select Whisper for all speech.

`reply(voice: true|false)` always overrides the policy.

## Picking a voice

Three ways, in the order the daemon prefers them:

1. **Clone** — `refAudio` + `refText`, on the Base model. Sounds like whoever is
   in the clip. 5–15 seconds of clean speech, converted to mono 24kHz wav;
   `refText` must be exactly what is said in it (STT can transcribe it for you).
   Clips live in `~/.otto/state/voice/refs/`:

   ```bash
   ffmpeg -i clip.mp3 -ar 24000 -ac 1 ~/.otto/state/voice/refs/name.wav
   ```

   Cloning is the slowest of the three — roughly 3x realtime on the 0.6B Base —
   because the reference has to be encoded on every call.
2. **Named speaker** — CustomVoice with `speaker`, delivery steered by
   `instruct` in plain English. Speakers: serena, vivian, uncle_fu, ryan, aiden,
   ono_anna, sohee, eric, dylan.
3. **VoiceDesign** — only if `ttsModel` points at it. It invents a timbre on
   every call, so the voice changes between replies. Avoid.

`instruct` is the pacing control. "Unhurried, clear pauses between sentences" is
a real fix; there is no slider that does the same job.

## What it costs

On an M1 Pro, warm synthesis runs roughly in real time. Loading the TTS model
can add about 25 seconds. First use also pays for the model download.

That is why spoken replies should stay short — a paragraph is a minute of the
user waiting and a minute of them listening.

## Voice self-check

The channel probes the configured TTS model and speaker at startup, every five
minutes, and before synthesis (`POST /probe`). A missing reference, unavailable
speaker or unverified engine fails closed to text. Synthesis responses identify
the engine too, so fallback audio is never sent. `otto_status` has a Voice row
with the failure onset and timezone; failures are logged once per transition,
without notifying the user. Telegram voice replies are restricted to the owner's
private chat, even when explicitly requested elsewhere. Failed inbound Telegram
transcriptions get a short text asking for another recording.

## Running on another machine

The models need Apple silicon, so a server on Linux reaches a daemon on a Mac
through an SSH tunnel. On the Mac, run `voiced.py` standalone on a fixed port:

- `OTTO_VOICE_TOKEN` — required; any long random string, shared with the server.
- `OTTO_VOICE_PORT` — the port the tunnel points at (default is ephemeral).
- `OTTO_VOICE_INFO` — optional; default `~/.otto/state/voice-daemon.json`.
- No `OTTO_VOICE_PARENT`: without it the daemon never exits for idleness, it only drops the weights.

`~/Library/LaunchAgents/otto.voiced.plist`, with `__HOME__` replaced by your home directory:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>otto.voiced</string>
  <key>ProgramArguments</key>
  <array>
    <string>__HOME__/.otto/state/voice/.venv/bin/python</string>
    <string>__HOME__/.otto/otto/voice/voiced.py</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OTTO_VOICE_TOKEN</key><string>replace-with-a-long-random-token</string>
    <key>OTTO_VOICE_PORT</key><string>4590</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
```

`ProcessType` matters: without it launchd runs the daemon as a background job, and macOS throttles it
whenever the Mac is busy. Under a few parallel builds the same clip took 4 s to transcribe as a
background job and 0.14 s as an interactive one.

`launchctl load ~/Library/LaunchAgents/otto.voiced.plist`. `PATH` has to reach `ffmpeg`.

On the server, forward the port (`ssh -N -L 4590:127.0.0.1:4590 <mac>`, under
autossh or a unit that restarts it), write `{"port": 4590, "token": "<same token>"}`
to `~/.otto/state/voice-daemon.json`, and set `"remote": true` under `voice` in
`access.json`. The server then never spawns a daemon, only health-checks that one,
and sends voice notes and receives spoken replies inside the JSON, since neither
machine can read the other's files. `refAudio` is a path on the Mac.
