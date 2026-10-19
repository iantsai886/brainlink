// Folder-backed BrainStore: must pass the published contract, and keep untouched notes byte-stable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runStoreContract } from 'brainlink-store/contract-tests.mjs';
import { createFolderStore } from '../src/store/folder-store.mjs';

runStoreContract((opts) => createFolderStore({ ...opts, root: mkdtempSync(path.join(tmpdir(), 'bl-folder-')) }));

test('folder-store: never rewrites an untouched note on disk', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bl-folder-bytes-'));
  const dir = path.join(root, 'Work');
  mkdirSync(dir, { recursive: true });
  const raw = '---\ntags: [a, b]\nowner: "Kestrel"\n---\nHand-formatted body.\n';
  writeFileSync(path.join(dir, 'Note.md'), raw);
  const store = await createFolderStore({ vaults: [{ name: 'Work', private: false }], vaultPaths: { Work: dir } });
  assert.equal(readFileSync(path.join(dir, 'Note.md'), 'utf8'), raw, 'scanning must not reformat the file');
  const n = await store.read('Work:Note.md');
  assert.deepEqual(n.frontmatter, { tags: ['a', 'b'], owner: 'Kestrel' });
  await store.write({ vault: 'Work', id: n.id, path: 'Note.md', body: 'Edited body.', frontmatter: n.frontmatter }, { expected_etag: n.etag });
  const after = readFileSync(path.join(dir, 'Note.md'), 'utf8');
  assert.match(after, /Edited body\./, 'an explicit write does update the file');
  rmSync(root, { recursive: true, force: true });
});

test('folder-store: rename moves the file without touching its bytes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bl-folder-rename-'));
  const store = await createFolderStore({ vaults: [{ name: 'Work', private: false }], root });
  const w = await store.write({ vault: 'Work', path: 'A.md', body: 'x', frontmatter: { tags: ['x'] } }, { expected_etag: '' });
  const before = readFileSync(path.join(root, 'Work', 'A.md'), 'utf8');
  await store.rename(w.id, 'Sub/B.md', { expected_etag: w.etag });
  assert.equal(readFileSync(path.join(root, 'Work', 'Sub', 'B.md'), 'utf8'), before);
  rmSync(root, { recursive: true, force: true });
});
