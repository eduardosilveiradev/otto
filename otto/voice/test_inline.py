"""Inline audio round trip for a server on another machine; no MLX or models needed."""
import ast
import base64
import os
import pathlib
import re
import tempfile
import unittest

source = pathlib.Path(__file__).with_name('voiced.py').read_text()
funcs = [n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name in ('do_stt', 'inline_audio')]


class InlineTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.seen = []
        def load_audio(path):
            with open(path, 'rb') as f:
                self.seen.append((path, f.read()))
            return b'note'

        self.scope = {'os': os, 're': re, 'time': __import__('time'), 'base64': base64, 'tempfile': tempfile,
                      'OUT_DIR': self.dir, 'log': lambda m: None, 'load_stt_audio': load_audio,
                      'is_silent': lambda _: False, 'stt_choice': lambda _: ('whisper', 'm', None),
                      'whisper_stt': lambda *args: {'text': 'hi', 'language': 'en'}}
        exec(compile(ast.Module(body=funcs, type_ignores=[]), '<voiced>', 'exec'), self.scope)

    def test_stt_accepts_inline_audio_and_cleans_up(self):
        res = self.scope['do_stt']({'audio_b64': base64.b64encode(b'note').decode(), 'ext': 'm4a'})
        self.assertEqual(res['text'], 'hi')
        path, data = self.seen[0]
        self.assertEqual((data, path.endswith('.m4a'), os.path.exists(path)), (b'note', True, False))

    def test_tts_result_inlined(self):
        path = os.path.join(self.dir, 'out.ogg')
        open(path, 'wb').write(b'spoken')
        res = self.scope['inline_audio']({'path': path, 'seconds': 1})
        self.assertEqual(res, {'seconds': 1, 'audio_b64': base64.b64encode(b'spoken').decode(), 'ext': 'ogg'})
        self.assertFalse(os.path.exists(path))


if __name__ == '__main__':
    unittest.main()
