import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const script = fileURLToPath(new URL('../package_public.py', import.meta.url));
const query = `import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('exporter',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps([m.allowed(Path(p)) for p in sys.argv[2:]]))`;
const allowed = (name) => JSON.parse(execFileSync('python3', ['-c', query, script, name], { encoding: 'utf8' }))[0];
test('new hidden tool directories never enter public exports', () => { assert.equal(allowed('src/.local-tool/generated.ts'), false); });
test('nested hidden tool directories never enter public exports', () => { assert.equal(allowed('docs/.another-tool/session.md'), false); });
test('project workflow files retain their existing allowlist behavior', () => { assert.equal(allowed('.github/workflows/pages.yml'), true); });
test('project gitignore retains its existing allowlist behavior', () => { assert.equal(allowed('.gitignore'), true); });
