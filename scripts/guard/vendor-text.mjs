#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Complete vocabulary words, never substrings or product identifiers.
export const ALLOWED_WORDS = ['claudere', 'philanthropic', 'misanthropic'];
const blocked = new RegExp(['anthro' + 'pic', 'clau' + 'de'].join('|'), 'i');
const phrasing = new RegExp(['不接\\s*' + 'AI', '没有\\s*' + 'AI', '无需\\s*' + 'AI', 'AI\\s*功能' + '除外', 'without ' + 'AI', 'no ' + 'AI', '保' + '底', '冲刺' + '目标', '正常' + '目标', '7\\s*分' + '版本'].join('|'), 'i');
const allowed = new RegExp(`\\b(?:${ALLOWED_WORDS.join('|')})\\b`, 'gi');
const roots = ['src', 'docs', 'server', 'scripts', 'ops', '.github'];
const files = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'index.html', 'vite.config.ts', 'package.json', 'package-lock.json'];
const publicText = new Set(['.js', '.mjs', '.css', '.html', '.json', '.md', '.txt', '.webmanifest', '.map']);
const sourceText = new Set([...publicText, '.ts', '.tsx', '.py', '.yml', '.yaml', '.sh', '.svg', '']);
async function walk(root, relative, extensions) {
  let entries;
  try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || ['node_modules', '.git', '__pycache__'].includes(entry.name)) continue;
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await walk(root, name, extensions));
    else if (entry.isFile() && extensions.has(path.extname(entry.name))) result.push(name);
  }
  return result;
}
export async function scanRepository(root, { dist = false } = {}) {
  const paths = [...files];
  for (const directory of roots) paths.push(...await walk(root, directory, sourceText));
  paths.push(...await walk(root, 'public', publicText));
  if (dist) paths.push(...await walk(root, 'dist', publicText));
  const issues = [];
  for (const file of [...new Set(paths)].sort()) {
    let text;
    try { text = await readFile(path.join(root, file), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    text.split(/\r?\n/).forEach((line, index) => {
      if (blocked.test(line.replace(allowed, ''))) issues.push({ file, line: index + 1, rule: 'vendor' });
      if ((file.startsWith('src/') || file.startsWith('docs/') || file === 'README.md') && phrasing.test(line))
        issues.push({ file, line: index + 1, rule: 'wording' });
    });
  }
  return issues;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const issues = await scanRepository(root, { dist: process.argv.includes('--dist') });
  if (issues.length) {
    issues.forEach((issue) => console.error(`${issue.file}:${issue.line}: ${issue.rule === 'vendor' ? '包含禁止的供应商文字' : '请使用统一训练文案'}`));
    process.exitCode = 1;
  } else console.log('文字守卫通过。');
}
