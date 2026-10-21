import test from 'node:test'; import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function files(d) { const o = []; for (const e of await readdir(d, { withFileTypes: true })) { if (e.name === 'test' || e.name === 'tools' || e.name === 'dist') continue; const p = path.join(d, e.name); e.isDirectory() ? o.push(...await files(p)) : o.push(p); } return o; }
test('guard: UI runtime code never touches files or network (store API only)', async () => {
  for (const f of (await files(APP)).filter((x) => x.endsWith('.mjs'))) {
    const s = await readFile(f, 'utf8');
    assert.doesNotMatch(s, /from ['"](node:)?(fs|path|child_process|http|https|net|crypto)(\/promises)?['"]/, f);
    assert.doesNotMatch(s, /\bfetch\(|XMLHttpRequest|WebSocket|localStorage\.setItem\(['"]note/, f);
  }
});
test('guard: UI code stays generic (no private names)', async () => {
  for (const f of await files(APP)) assert.doesNotMatch(await readFile(f, 'utf8'), /\b(Ian|Iango|Anna|Livva|Paulo|Taipei)\b/i, f);
});
