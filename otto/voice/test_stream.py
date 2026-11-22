"""Exercise incremental Qwen output without loading models or an audio library."""
import ast
import base64
import io
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

source = pathlib.Path(__file__).with_name('voiced.py').read_text()
func = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'do_tts')

class StreamTest(unittest.TestCase):
    def test_chunks_leave_before_generator_finishes(self):
        frames, calls = [], []
        def generate(**kw):
            calls.append(kw)
            yield types.SimpleNamespace(audio=b'one', sample_rate=24000)
            self.assertEqual(len(frames), 1)
            yield types.SimpleNamespace(audio=b'two', sample_rate=24000)
        scope = {'io': io, 'base64': base64, 'os': __import__('os'), 'time': __import__('time'),
                 'CONFIG': {'max_chars': 900, 'speaker': 'test', 'instruct': '', 'language': 'English', 'ref_audio': '', 'ref_text': '', 'tts_model': 'test'},
                 'respell': lambda s: s, 'probe_tts': lambda r: None,
                 'load_tts': lambda n: types.SimpleNamespace(generate_custom_voice=generate), 'token_budget': lambda t: 100}
        libs = {'numpy': types.SimpleNamespace(array=lambda a: a), 'soundfile': types.SimpleNamespace(write=lambda f, a, sr, **kw: f.write(a))}
        exec(compile(ast.Module(body=[func], type_ignores=[]), '<voiced>', 'exec'), scope)
        with patch.dict(sys.modules, libs):
            result = scope['do_tts']({'text': 'hello'}, frames.append)
        self.assertTrue(calls[0]['stream'])
        self.assertEqual(calls[0]['streaming_interval'], 0.3)
        self.assertEqual([base64.b64decode(f['audio_b64']) for f in frames], [b'one', b'two'])
        self.assertEqual(result, {'engine': 'qwen3', 'fallback': False, 'done': True})

if __name__ == '__main__':
    unittest.main()
