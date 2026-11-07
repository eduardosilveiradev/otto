# voice — speech in and out for the otto channel

Optional, and off until you install it. Telegram voice notes arrive as words,
and Otto can answer out loud. Everything
runs on the Mac: Whisper for transcription, Qwen3-TTS for synthesis, both
through MLX. Nothing about a voice note leaves the machine.

```
voice note ──▶ download ──▶ whisper ──▶ transcript is the message the session sees
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
download on first use (~1.5GB Whisper, ~2–4GB Qwen3) into the shared Hugging
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

- Bound to `127.0.0.1` on an ephemeral port, bearer token required. Port and
  token land in `~/.otto/state/voice-daemon.json` once it is listening.
- Requests are serialized — MLX generation is not concurrency-safe, and two
  models in 16GB is tight enough without running two at once.
- Weights are dropped after `idleUnloadSeconds` (default 600) of quiet; the
  process itself exits when its parent dies or after six idle hours.
- `stdout` is model chatter, not protocol. Logs (and any traceback) go to `~/.otto/state/voice/voiced.log`, one line per reply naming the mode, model, reference clip and length; results go to HTTP.

Endpoints: `GET /health`, `POST /probe`, `POST /stt {path}`, `POST /tts {text}`.

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
    "sttLanguage": "",           // "en"/"pt"/"it"; empty auto-detects
    "refAudio": "~/.otto/state/voice/refs/myvoice.wav", // clone — wins over speaker
    "refText": "…"               // exactly what is said in that clip
  }
}
```

`reply(voice: true|false)` always overrides the policy.

## Picking a voice

Three ways, in the order the daemon prefers them:

1. **Clone** — `refAudio` + `refText`, on the Base model. Sounds like whoever is
   in the clip. 5–15 seconds of clean speech, converted to mono 24kHz wav;
   `refText` must be exactly what is said in it (Whisper will write it for you).
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

On an M1 Pro, warm: transcription ~2s for a 14s clip, synthesis roughly 1x
realtime (a 6-second reply takes ~6s). Cold, add ~25s for the TTS model to load
and ~10s for Whisper. First run of each also pays the download.

That is why spoken replies should stay short — a paragraph is a minute of the
user waiting and a minute of them listening.
