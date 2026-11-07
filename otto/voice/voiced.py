#!/usr/bin/env python
"""
Voice sidecar for the otto channel — Whisper STT in, Qwen3-TTS out.

Runs as a long-lived localhost HTTP daemon rather than a per-request process
because both models cost seconds to load and gigabytes to hold: paying that on
every voice note would make the channel feel broken. The daemon loads lazily on
first use and drops the weights again after `idle_unload_seconds` of quiet, so
an idle otto session is a ~60MB Python process, not a 5GB one.

Protocol (JSON over HTTP, 127.0.0.1 only, bearer token):
    GET  /health -> {ok, stt_loaded, tts_loaded, idle_seconds}
    POST /stt    {path, language?}            -> {text, language, seconds}
    POST /tts    {text, speaker?, instruct?, language?, format?} -> {path, seconds}

The port is ephemeral and, with the token, written to the info file named by
OTTO_VOICE_INFO once the socket is listening. stdout is NOT part of the
protocol: mlx-audio prints progress there ("Initialized encoder codebooks"),
which is exactly the kind of thing that corrupts a stdout handshake. Everything
the parent needs comes from the info file; everything else goes to stderr.

Env:
    OTTO_VOICE_TOKEN    required — bearer token the parent generated
    OTTO_VOICE_INFO     required — path to write {pid, port, token}
    OTTO_VOICE_CONFIG   optional — JSON config blob (see CONFIG defaults)
    OTTO_VOICE_PARENT   optional — pid to follow; daemon exits when it dies
"""
from __future__ import annotations

import gc
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

warnings.filterwarnings("ignore")

CONFIG = {
    "stt_model": "mlx-community/whisper-large-v3-turbo",
    "tts_model": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16",
    # Cloning runs on the Base model instead, from a fixed reference clip.
    "clone_model": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
    "ref_audio": "",
    "ref_text": "",
    "speaker": "ryan",
    "instruct": "Dry, warm, and unhurried. Speaks in short sentences, like a friend texting.",
    "language": "English",
    # Cloned pacing comes from the reference clip and cannot be prompted; this
    # is the only speed control there is.
    "speed": 1.0,
    "idle_unload_seconds": 600,
    "exit_after_idle_seconds": 21600,
    "max_chars": 900,
}
CONFIG.update(json.loads(os.environ.get("OTTO_VOICE_CONFIG") or "{}"))

TOKEN = os.environ.get("OTTO_VOICE_TOKEN") or ""
INFO_PATH = os.environ.get("OTTO_VOICE_INFO") or ""
PARENT_PID = int(os.environ.get("OTTO_VOICE_PARENT") or 0)

if not TOKEN or not INFO_PATH:
    print("voiced: OTTO_VOICE_TOKEN and OTTO_VOICE_INFO are required", file=sys.stderr)
    sys.exit(2)

OUT_DIR = os.path.join(tempfile.gettempdir(), "otto-voice")
os.makedirs(OUT_DIR, exist_ok=True)


# stderr was the spawning session's pipe, and the daemon outlives it: once that died,
# every line and every library traceback went nowhere. fd 2 goes to a file of its own
# instead (beside the info file), started over once it passes 2 MB.
LOG_PATH = os.environ.get("OTTO_VOICE_LOG") or os.path.join(os.path.dirname(INFO_PATH), "voice", "voiced.log")
try:
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    big = os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 2_000_000
    os.dup2(os.open(LOG_PATH, os.O_WRONLY | os.O_CREAT | os.O_APPEND | (os.O_TRUNC if big else 0), 0o600), 2)
    sys.stderr = os.fdopen(2, "w", buffering=1)
except OSError:
    pass


def log(msg: str) -> None:
    try:
        print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} voiced: {msg}", file=sys.stderr, flush=True)
    except (OSError, ValueError, AttributeError):
        pass


# ---------------------------------------------------------------------------
# Model holders
# ---------------------------------------------------------------------------
# MLX generation is not safe to run concurrently, and both models want the same
# unified memory anyway, so every request through here is serialized. Voice
# notes are short and the user is one person; a queue costs nothing.

_lock = threading.Lock()
_last_use = time.time()
_tts_model = None
_tts_name: str | None = None
_stt_loaded = False


def _touch() -> None:
    global _last_use
    _last_use = time.time()


def load_stt(model: str):
    global _stt_loaded
    import mlx_whisper

    _stt_loaded = True
    return mlx_whisper


_last_tts_name: str | None = None  # survives an idle unload, so warm_tts knows what to bring back


def load_tts(name: str):
    global _tts_model, _tts_name, _last_tts_name
    _last_tts_name = name
    if _tts_model is not None and _tts_name == name:
        return _tts_model
    from mlx_audio.tts.utils import load_model

    t0 = time.time()
    log(f"loading tts {name}")
    _tts_model = load_model(name)
    _tts_name = name
    log(f"tts ready in {time.time() - t0:.1f}s")
    return _tts_model


def warm_tts() -> None:
    """A voice note in usually means a voice reply out: load the TTS weights while
    the reply is still being written, not after it, which hid 4-6 s of every
    first reply after an idle unload. Runs under the request lock like any request."""
    if _tts_model is not None or not _last_tts_name:
        return
    with _lock:
        try:
            load_tts(_last_tts_name)
            _touch()
        except Exception as err:
            log(f"tts warm-up failed: {type(err).__name__}: {err}")


def unload_all() -> None:
    """Drop both models. Whisper caches its own holder inside mlx_whisper, so
    clearing our reference is not enough — reach into the holder too."""
    global _tts_model, _tts_name, _stt_loaded
    _tts_model = None
    _tts_name = None
    if _stt_loaded:
        try:
            from mlx_whisper.transcribe import ModelHolder

            ModelHolder.model = None
            ModelHolder.model_path = None
        except Exception:
            pass
        _stt_loaded = False
    gc.collect()
    try:
        import mlx.core as mx

        mx.clear_cache()
    except Exception:
        pass
    log("models unloaded (idle)")


def janitor() -> None:
    idle_unload = float(CONFIG["idle_unload_seconds"])
    exit_after = float(CONFIG["exit_after_idle_seconds"])
    while True:
        time.sleep(15)
        idle = time.time() - _last_use
        if PARENT_PID:
            try:
                os.kill(PARENT_PID, 0)
            except OSError:
                log(f"parent {PARENT_PID} is gone — exiting")
                os._exit(0)
        if exit_after and idle > exit_after:
            log("idle too long — exiting")
            os._exit(0)
        if idle_unload and idle > idle_unload and (_tts_model is not None or _stt_loaded):
            if _lock.acquire(blocking=False):
                try:
                    unload_all()
                finally:
                    _lock.release()


# ---------------------------------------------------------------------------
# Work
# ---------------------------------------------------------------------------

# Whisper does not return nothing for silence — it returns its training data's
# most common filler, "Thank you." or "Thanks for watching!", with full
# confidence. A hallucinated sentence is worse than an empty one here, because
# the session will act on it, so check for signal before asking.
SILENCE_RMS = 0.002  # ≈ -54 dBFS


def is_silent(path: str) -> bool:
    try:
        from mlx_whisper.audio import load_audio

        audio = load_audio(path)
        if audio.size == 0:
            return True
        import numpy as np

        rms = float(np.sqrt(np.mean(np.square(audio))))
        peak = float(np.max(np.abs(audio)))
        log(f"level rms={rms:.5f} peak={peak:.5f}")
        return rms < SILENCE_RMS
    except Exception as err:
        # Never let the guard itself swallow a real recording.
        log(f"silence check failed ({err}) — transcribing anyway")
        return False


def do_stt(req: dict) -> dict:
    path = req["path"]
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    if is_silent(path):
        log("silent recording — not transcribing")
        return {"text": "", "language": None, "seconds": 0, "silent": True}
    mlx_whisper = load_stt(CONFIG["stt_model"])
    t0 = time.time()
    # Without previous-text conditioning a loop can't feed itself: trailing silence
    # otherwise came back as one word repeated hundreds of times.
    kwargs = {"path_or_hf_repo": CONFIG["stt_model"], "condition_on_previous_text": False}
    if req.get("language"):
        kwargs["language"] = req["language"]
    result = mlx_whisper.transcribe(path, **kwargs)
    text = (result.get("text") or "").strip()
    log(f"stt {time.time() - t0:.1f}s -> {len(text)} chars")
    return {
        "text": text,
        "language": result.get("language"),
        "seconds": round(time.time() - t0, 2),
    }


def encode(wav: str, fmt: str, speed: float) -> str:
    """Apply the speed-up and the output format in one ffmpeg pass.

    Cloned voices inherit their pacing from the reference clip and there is no
    knob on the model for it, so the tempo fix happens here. `atempo` stretches
    time without touching pitch, which is what keeps a faster read from sounding
    like a chipmunk.

    Format matters too: Telegram only renders OGG/Opus as a voice note, while
    afplay cannot decode Opus at all.
    """
    fast = abs(speed - 1.0) > 0.01
    # Always trim trailing silence: a missed end-of-speech token pads the clip
    # with seconds of nothing, and a voice note should end when the voice does.
    # Reverse, strip leading silence, reverse back — ffmpeg has no "trim end".
    # Stop at the first sound and keep a quarter second before it: waiting for a
    # run of loud audio (start_duration) ate the quiet tail of the last word.
    filters = ["areverse", "silenceremove=start_periods=1:start_threshold=-50dB:start_duration=0:start_silence=0.25", "areverse"]
    if fast:
        filters.append(f"atempo={max(0.5, min(2.0, speed)):.3f}")

    out = wav[:-4] + (".ogg" if fmt != "wav" else "-trim.wav")
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-filter:a", ",".join(filters)]
    if fmt != "wav":
        cmd += ["-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1"]
    cmd.append(out)

    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode()[:400]}")
    try:
        os.remove(wav)
    except OSError:
        pass
    return out


# Qwen3-TTS emits 12 codec tokens per second of audio. When sampling misses the
# end-of-speech token the library's default cap of 4096 tokens lets it run for
# five and a half minutes of silence, and every other request queues behind it.
# Budget from the text instead, per sentence (see split_sentences): the voice reads
# about 11 characters a second, so allow 1.6x that plus a second and a half of
# slack, and never more than the default. A miss then costs a few seconds, not ten.
TOKENS_PER_SECOND = 12
CHARS_PER_SECOND = 11.0

# Each sentence is generated on its own. On a whole reply the model would sometimes
# stop speaking after the first sentence and pad the rest of the budget with
# silence, so "Welcome home. Want the lights on?" came out as "Welcome home." after
# eight seconds of work. Fragments under 12 characters ride with the sentence before.
SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")
SENTENCE_GAP_S = 0.18


def split_sentences(text: str) -> list[str]:
    out: list[str] = []
    for part in SENTENCE_END.split(text):
        part = part.strip()
        if not part:
            continue
        if out and len(part) < 12:
            out[-1] += " " + part
        else:
            out.append(part)
    return out or [text]


def trim_tail(audio, sr: int):
    """Cut a sentence's trailing silence, keeping 120 ms after the last sound."""
    import numpy as np

    loud = np.nonzero(np.abs(audio) > max(float(np.abs(audio).max()) * 0.02, 1e-4))[0]
    return audio[: min(len(audio), int(loud[-1]) + int(sr * 0.12))] if len(loud) else audio[:0]


# "live" the adjective (it's live) reads as "liv" the verb. Respell it where the
# words before it give it away; everything else is left to the model.
LIVE = re.compile(r"\b(is|it's|its|are|was|be|been|goes|go|went|gone|going|now|already|still|stays) live\b", re.I)


def respell(text: str) -> str:
    return LIVE.sub(lambda m: f"{m.group(1)} lyve", text)


def token_budget(text: str) -> int:
    expected = len(text) / CHARS_PER_SECOND
    return int(min(4096, TOKENS_PER_SECOND * (expected * 1.6 + 1.5)))


def probe_tts(req: dict) -> dict:
    ref = req.get("ref_audio") or CONFIG["ref_audio"]
    if ref and not os.path.isfile(os.path.expanduser(ref)):
        raise FileNotFoundError("configured voice reference is missing")
    name = req.get("model") or CONFIG["clone_model" if ref else "tts_model"]
    model = load_tts(name)
    if not ref and "VoiceDesign" not in name:
        if not hasattr(model, "generate_custom_voice"):
            raise RuntimeError("configured named voice engine did not load")
        speakers = getattr(model, "get_supported_speakers", lambda: [])()
        if speakers and (req.get("speaker") or CONFIG["speaker"]).lower() not in [s.lower() for s in speakers]:
            raise ValueError("configured speaker is unavailable")
    return {"engine": "qwen3", "model": name, "fallback": False}


def do_tts(req: dict) -> dict:
    import numpy as np
    import soundfile as sf

    text = (req.get("text") or "").strip()
    if not text:
        raise ValueError("text is required")
    text = respell(text[: int(CONFIG["max_chars"])])

    speaker = req.get("speaker") or CONFIG["speaker"]
    instruct = req.get("instruct") or CONFIG["instruct"]
    language = req.get("language") or CONFIG["language"]
    ref_audio = req.get("ref_audio") or CONFIG["ref_audio"]
    ref_text = req.get("ref_text") or CONFIG["ref_text"]

    # Three ways to fix a voice, in the order they take precedence:
    #   clone  — Base model + a reference clip. Sounds like whoever is in it.
    #   custom — CustomVoice + a named speaker, delivery steered by instruct.
    #   design — VoiceDesign invents a timbre per call, so it drifts between
    #            replies. Only reachable by pointing tts_model at it directly.
    if ref_audio:
        name = req.get("model") or CONFIG["clone_model"]
        mode = "clone"
    else:
        name = req.get("model") or CONFIG["tts_model"]
        mode = "custom"
    probe_tts(req)
    model = load_tts(name)

    def speak(line: str, max_tokens: int):
        if mode == "clone":
            gen = model.generate(
                text=line, ref_audio=ref_audio, ref_text=ref_text or None, max_tokens=max_tokens
            )
        elif hasattr(model, "generate_custom_voice"):
            gen = model.generate_custom_voice(
                text=line, speaker=speaker, language=language, instruct=instruct,
                max_tokens=max_tokens,
            )
        else:
            gen = model.generate_voice_design(
                text=line, instruct=instruct, language=language, max_tokens=max_tokens
            )
        return list(gen)[0]

    t0 = time.time()
    # Every call pays ~3 s of fixed cost (the reference clip is prefilled and
    # decoded each time), so speak the reply whole and only go sentence by
    # sentence when it ran into its budget, the sign that it dropped the rest.
    lines = [text]
    max_tokens = token_budget(text)
    out = speak(text, max_tokens)
    sr = getattr(out, "sample_rate", 24000)
    audio = np.array(out.audio)
    if len(audio) / sr >= 0.9 * max_tokens / TOKENS_PER_SECOND and len(split_sentences(text)) > 1:
        lines = split_sentences(text)
        log(f"tts hit its budget on {len(lines)} sentences — redoing them one by one")
        chunks = []
        for line in lines:
            budget = token_budget(line)
            max_tokens += budget
            part = speak(line, budget)
            sr = getattr(part, "sample_rate", 24000)
            part = trim_tail(np.array(part.audio), sr)
            chunks += [part, np.zeros(int(sr * SENTENCE_GAP_S), dtype=part.dtype)]
        audio = np.concatenate(chunks[:-1])

    wav = os.path.join(OUT_DIR, f"otto-{int(time.time() * 1000)}.wav")
    sf.write(wav, audio, sr)
    speed = float(req.get("speed") or CONFIG["speed"])
    out_path = encode(wav, req.get("format") or "ogg", speed)

    dur = len(audio) / sr / max(0.5, min(2.0, speed))
    log(f"tts[{mode}] {name.split('/')[-1]} ref={os.path.basename(ref_audio) or '-'} ref_text={'yes' if ref_text else 'no'}"
        f" {len(text)} chars {time.time() - t0:.1f}s -> {dur:.1f}s audio at {speed}x ({len(lines)} sentences, budget {max_tokens} tokens)")
    return {"engine": "qwen3", "fallback": False, "path": out_path, "seconds": round(dur, 2), "took": round(time.time() - t0, 2)}


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # silence per-request access logging
        pass

    def _send(self, code: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authed(self) -> bool:
        if self.headers.get("Authorization") == f"Bearer {TOKEN}":
            return True
        self._send(401, {"error": "unauthorized"})
        return False

    def do_GET(self) -> None:
        if not self._authed():
            return
        if self.path == "/health":
            self._send(200, {
                "ok": True,
                "stt_loaded": _stt_loaded,
                "tts_loaded": _tts_model is not None,
                "idle_seconds": round(time.time() - _last_use, 1),
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if not self._authed():
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception as err:
            self._send(400, {"error": f"bad request: {err}"})
            return

        handler = {"/stt": do_stt, "/tts": do_tts, "/probe": probe_tts}.get(self.path)
        if handler is None:
            self._send(404, {"error": "not found"})
            return

        _touch()
        try:
            with _lock:
                result = handler(req)
            _touch()
            self._send(200, result)
            if handler is do_stt and result.get("text"):
                threading.Thread(target=warm_tts, daemon=True).start()
        except Exception as err:
            log(f"{self.path} failed: {type(err).__name__}: {err}")
            self._send(500, {"error": f"{type(err).__name__}: {err}"})


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    tmp = INFO_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"pid": os.getpid(), "port": port, "token": TOKEN, "startedAt": time.time()}, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, INFO_PATH)
    log(f"listening on 127.0.0.1:{port}")

    threading.Thread(target=janitor, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            if json.load(open(INFO_PATH)).get("pid") == os.getpid():
                os.remove(INFO_PATH)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
