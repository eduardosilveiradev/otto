"""Isolated daemon fixture for the Bun STT contract test. No MLX or model downloads."""
import sys
from types import SimpleNamespace

import voiced


class Decoder:
    def __init__(self):
        self.text = ""

    def add_audio(self, _):
        self.text += " speech"

    @property
    def result(self):
        return SimpleNamespace(text=self.text)


core = SimpleNamespace(array=lambda x: x, pad=lambda x, _: x)
sys.modules.update({"mlx": SimpleNamespace(core=core), "mlx.core": core})
voiced.pcm_audio = list
voiced.is_silent = lambda audio: not any(audio)
voiced.load_parakeet = lambda name: SimpleNamespace(transcribe_stream=lambda **_: Decoder())
voiced.warm_whisper = lambda _: None
voiced.whisper_stt = lambda _, name, language: {"text": name, "language": language, "engine": "whisper"}
sys.exit(voiced.main())
