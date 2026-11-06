import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('restore_audio', Path(__file__).with_name('restore-r0-audio.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RestoreTests(unittest.TestCase):
    def test_verified_local_file_does_not_access_network(self):
        with tempfile.TemporaryDirectory() as directory:
            target = self.fixture(directory)
            target.write_bytes(b'fixture')
            module.restore(directory, lambda *_a, **_k: self.fail('Unexpected network request'))
            self.assertEqual(target.read_bytes(), b'fixture')

    def fixture(self, directory):
        target = Path(directory) / module.RELATIVE
        target.parent.mkdir(parents=True)
        target.with_name('provenance.json').write_text(json.dumps({'sha256': hashlib.sha256(b'fixture').hexdigest()}))
        return target

    def test_missing_file_is_restored_from_pinned_source(self):
        with tempfile.TemporaryDirectory() as directory:
            target = self.fixture(directory)
            def opener(url, **_kwargs):
                self.assertIn(module.SOURCE_COMMIT, url)
                return io.BytesIO(b'fixture')
            module.restore(directory, opener)
            self.assertEqual(target.read_bytes(), b'fixture')

    def test_bad_download_cannot_overwrite_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = self.fixture(directory)
            target.write_bytes(b'keep existing')
            with self.assertRaises(ValueError):
                module.restore(directory, lambda *_a, **_k: io.BytesIO(b'wrong data'))
            self.assertEqual(target.read_bytes(), b'keep existing')
