"""Isolated release packer checks. All app, API and media bytes are self-authored fixtures."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest


MODULE = Path(__file__).with_name('pack-app.py')
SPEC = importlib.util.spec_from_file_location('band_r6_pack_app_under_test', MODULE)
PACK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACK)
COMMIT = 'a' * 40


def sha(data):
    return hashlib.sha256(data).hexdigest()


class PackAppTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='band-r6-pack-app-')
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        self.dist = self.source / 'dist'
        self.out = self.root / 'candidate.tar.gz'
        self.shared = self.root / 'shared-atlas'
        self.runtime = ['app.py', 'fixture_auth.py']
        api_files = {}
        for name in self.runtime:
            data = ('# Self-authored isolated API fixture: ' + name + '\nVALUE = 1\n').encode()
            self.write(self.source / 'server' / name, data)
            api_files[name] = sha(data)
        self.write(self.source / 'server/runtime-files.json', json.dumps(self.runtime))
        self.build = {'version': '1.0.0', 'fullCommit': COMMIT, 'sourceDirty': False, 'apiFiles': api_files}
        self.write(self.dist / 'build-info.json', json.dumps(self.build))
        for name, content in {
            'index.html': '<!doctype html><title>Self-authored release fixture</title>',
            'sw.js': '/* self-authored fixture worker */',
            'manifest.webmanifest': '{"name":"Self-authored test"}',
            'offline/pack.json': '{"version":1,"files":[]}',
            'assets/app.js': 'console.log("self-authored app fixture");',
            'assets/app.css': 'body { margin: 0; }',
            'atlas/index.json': '{"selfAuthoredFixture":true,"words":[]}',
            'atlas/img/test.webp': b'Self-authored fixture image bytes; not an external image',
            'atlas/audio/test.mp3': b'Self-authored fixture audio bytes; packer does not decode media',
            'ielts/phrase/test.mp3': b'Self-authored phrase audio fixture',
            'sfx/test.wav': b'Self-authored effect fixture',
        }.items():
            self.write(self.dist / name, content)

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def write(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data.encode() if isinstance(data, str) else data)

    def package(self, **changes):
        args = {'source_root': self.source, 'dist': self.dist, 'out': self.out, 'commit': COMMIT, 'atlas_out': self.shared}
        args.update(changes)
        return PACK.package(**args)

    def save_build(self):
        self.write(self.dist / 'build-info.json', json.dumps(self.build))

    def assert_no_outputs(self):
        self.assertFalse(self.out.exists())
        self.assertFalse(self.shared.exists())
        self.assertFalse(self.out.with_suffix(self.out.suffix + '.part').exists())

    def test_pax_commit_and_runtime_hashes_bind_the_clean_prebuilt_candidate(self):
        result = self.package()
        self.assertEqual(result['commit'], COMMIT)
        self.assertEqual(result['version'], '1.0.0')
        self.assertEqual(result['sha256'], sha(self.out.read_bytes()))
        self.assertLess(result['archiveBytes'], 50 * 1024 * 1024)
        with tarfile.open(self.out, 'r:gz') as archive:
            self.assertEqual(archive.pax_headers['comment'], COMMIT)
            names = archive.getnames()
            self.assertIn('dist/index.html', names)
            self.assertIn('dist/build-info.json', names)
            self.assertIn('server/runtime-files.json', names)
            for name in self.runtime:
                content = archive.extractfile('server/' + name).read()
                self.assertEqual(sha(content), self.build['apiFiles'][name])
            release = json.load(archive.extractfile('release-manifest.json'))
            self.assertEqual(release, {'formatVersion': 1, 'sharedAtlas': True, 'commit': COMMIT, 'sharedPaths': [{'path': p, 'sharedPath': '_public/' + p} for p in PACK.SHARED_PATHS]})
            for member in archive.getmembers():
                self.assertTrue(member.isfile())
                self.assertEqual((member.uid, member.gid, member.uname, member.gname, member.mtime, member.mode), (0, 0, '', '', 0, 0o644))
        report = json.loads(self.out.with_suffix(self.out.suffix + '.json').read_text())
        self.assertEqual(report['sha256'], result['sha256'])
        self.assertEqual({item['path'] for item in report['files']}, set(names))

    def test_atlas_and_vocabulary_media_trees_are_shared_once_at_their_original_urls(self):
        result = self.package()
        self.assertTrue(result['sharedAtlas'])
        self.assertEqual(result['sharedCopied'], 5)
        self.assertEqual(result['sharedFiles'], 5)
        for name in ['index.json', 'img/test.webp', 'audio/test.mp3']:
            self.assertEqual((self.shared / name).read_bytes(), (self.dist / 'atlas' / name).read_bytes())
        for tree in PACK.SHARED_PATHS:
            for original in (self.dist / tree).rglob('*'):
                if original.is_file():
                    self.assertEqual((self.shared / '_public' / original.relative_to(self.dist)).read_bytes(), original.read_bytes())
        second = self.package(out=self.root / 'second.tar.gz')
        self.assertEqual(second['sharedCopied'], 0)
        self.assertEqual(second['sharedBytes'], result['sharedBytes'])
        with tarfile.open(self.out) as archive:
            self.assertFalse(any(name.startswith('dist/atlas/') for name in archive.getnames()))
            self.assertFalse(any(any(name.startswith('dist/' + tree + '/') for tree in PACK.SHARED_PATHS) for name in archive.getnames()))

    def test_archive_excludes_private_banks_databases_keys_and_media(self):
        for name in ['private/manifest.json', 'private/raw.pdf', 'local-bank/audio/hidden.m4a', 'local-content/source.mp3', '.git/config', 'node_modules/private.key']:
            self.write(self.dist / name, b'Self-authored excluded fixture')
        self.package()
        with tarfile.open(self.out) as archive:
            for name in archive.getnames():
                self.assertFalse(set(Path(name).parts) & PACK.BLOCKED, name)
                self.assertNotIn(Path(name).suffix.lower(), PACK.MEDIA, name)
                self.assertFalse(PACK.forbidden(name), name)
        self.assertFalse((self.shared / 'private').exists())
        self.assertFalse((self.shared / '_public/private').exists())

    def test_archive_is_deterministic_across_output_names_and_input_mtimes(self):
        first = self.package()
        for item in self.dist.rglob('*'):
            if item.is_file():
                import os
                os.utime(item, (1730000000, 1730000000))
        second = self.package(out=self.root / 'different-name.tar.gz')
        self.assertEqual(first['sha256'], second['sha256'])
        self.assertEqual(self.out.read_bytes(), (self.root / 'different-name.tar.gz').read_bytes())

    def test_missing_atlas_audio_is_rejected_before_creating_outputs(self):
        (self.dist / 'atlas/audio/test.mp3').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing shared atlas audio'):
            self.package()
        self.assert_no_outputs()

    def test_missing_atlas_image_is_rejected_before_creating_outputs(self):
        (self.dist / 'atlas/img/test.webp').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing shared atlas image'):
            self.package()
        self.assert_no_outputs()

    def test_existing_candidate_is_immutable(self):
        self.package()
        old_archive = self.out.read_bytes()
        old_report = self.out.with_suffix(self.out.suffix + '.json').read_bytes()
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.package()
        self.assertEqual(self.out.read_bytes(), old_archive)
        self.assertEqual(self.out.with_suffix(self.out.suffix + '.json').read_bytes(), old_report)

    def test_dirty_build_or_wrong_source_commit_is_rejected_before_outputs(self):
        for dirty in [True, None, 0, 'false']:
            with self.subTest(dirty=dirty):
                self.build['sourceDirty'] = dirty
                self.save_build()
                with self.assertRaisesRegex(ValueError, 'clean source commit'):
                    self.package()
                self.assert_no_outputs()
        self.build['sourceDirty'] = False
        self.save_build()
        with self.assertRaisesRegex(ValueError, 'clean source commit'):
            self.package(commit='b' * 40)
        self.assert_no_outputs()
        with self.assertRaisesRegex(ValueError, '40-character'):
            self.package(commit='abcdef1')
        self.assert_no_outputs()

    def test_api_source_hash_drift_cannot_be_packaged_with_old_tested_build(self):
        self.write(self.source / 'server/app.py', '# Changed after tested frontend build\n')
        with self.assertRaisesRegex(ValueError, 'API source differs'):
            self.package()
        self.assert_no_outputs()

    def test_unmapped_media_is_rejected_instead_of_entering_the_app_package(self):
        for extension in ['mp3', 'm4a', 'pdf']:
            with self.subTest(extension=extension):
                file = self.dist / ('assets/unmapped.' + extension)
                self.write(file, b'Self-authored unexpected media fixture')
                with self.assertRaisesRegex(ValueError, 'Unmapped media'):
                    self.package()
                self.assert_no_outputs()
                file.unlink()

    def test_sensitive_app_files_are_rejected_before_either_output_is_touched(self):
        for name in ['.env', '.env.production', 'db/progress.sqlite3', 'db/progress.sqlite3-wal', 'keys/cert.pem', 'keys/private.key', 'server.env', 'credentials.json']:
            with self.subTest(name=name):
                file = self.dist / name
                self.write(file, b'Self-authored sensitive-output sentinel')
                with self.assertRaisesRegex(ValueError, 'sensitive build output'):
                    self.package()
                self.assert_no_outputs()
                file.unlink()

    def test_input_symlinks_are_rejected_instead_of_reading_outside_the_build(self):
        outside = self.root / 'outside.js'
        self.write(outside, 'Self-authored file outside the selected build')
        (self.dist / 'assets/linked.js').symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'Symbolic links'):
            self.package()
        self.assert_no_outputs()

    def test_shared_output_parent_symlink_cannot_write_outside_selected_output(self):
        outside = self.root / 'outside-shared'
        outside.mkdir()
        self.shared.mkdir()
        (self.shared / 'img').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, '[Ss]ymbolic|[Ss]ymlink|escapes its root'):
            self.package()
        self.assertFalse((outside / 'test.webp').exists())
        self.assertFalse(self.out.exists())


if __name__ == '__main__':
    unittest.main()
