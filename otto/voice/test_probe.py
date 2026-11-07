"""Engine stubs; no MLX, models, audio devices or network required."""
import ast
import pathlib
import unittest
from unittest.mock import Mock

source = pathlib.Path(__file__).with_name('voiced.py').read_text()
module = ast.parse(source)
probe = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'probe_tts')

class ProbeTest(unittest.TestCase):
    def setUp(self):
        import os
        self.load = Mock(return_value=Mock(generate_custom_voice=Mock(), get_supported_speakers=lambda: ['ryan']))
        self.scope = {'os': os, 'CONFIG': {'ref_audio': '', 'clone_model': 'Base', 'tts_model': 'CustomVoice', 'speaker': 'ryan'}, 'load_tts': self.load}
        exec(compile(ast.Module(body=[probe], type_ignores=[]), '<probe>', 'exec'), self.scope)

    def test_loads_configured_engine(self):
        self.assertEqual(self.scope['probe_tts']({})['engine'], 'qwen3')
        self.load.assert_called_once_with('CustomVoice')

    def test_wrong_engine_and_speaker(self):
        self.load.return_value = object()
        with self.assertRaises(RuntimeError):
            self.scope['probe_tts']({})
        self.setUp()
        with self.assertRaises(ValueError):
            self.scope['probe_tts']({'speaker': 'missing'})

    def test_load_failure_and_missing_reference(self):
        self.load.side_effect = RuntimeError('unavailable')
        with self.assertRaises(RuntimeError):
            self.scope['probe_tts']({})
        with self.assertRaises(FileNotFoundError):
            self.scope['probe_tts']({'ref_audio': '/nonexistent/reference.wav'})

if __name__ == '__main__':
    unittest.main()
