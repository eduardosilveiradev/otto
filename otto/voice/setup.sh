#!/bin/bash
# Install the voice sidecar's environment. Idempotent — safe to re-run.
#
# The venv lives in the state dir, not next to this script, because the plugin
# directory gets copied into the plugin cache on every edit and a multi-hundred
# megabyte venv has no business being copied with it.
set -euo pipefail

VOICE_HOME="${OTTO_STATE_DIR:-$HOME/.otto/state}/voice"

# MLX runs on Apple Silicon only. Anywhere else, voice stays off and Otto is a
# text channel; nothing else depends on it.
[ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] || { echo "voice needs a Mac with Apple Silicon (MLX); Otto stays text-only here" >&2; exit 1; }

command -v uv >/dev/null || { echo "uv is required: brew install uv" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required: brew install ffmpeg" >&2; exit 1; }

mkdir -p "$VOICE_HOME/refs"
uv venv --python 3.12 "$VOICE_HOME/.venv"
uv pip install --python "$VOICE_HOME/.venv/bin/python" mlx-whisper mlx-audio soundfile numpy

echo
echo "voice installed at $VOICE_HOME"
echo "models download on first use; restart the otto session to pick it up."
