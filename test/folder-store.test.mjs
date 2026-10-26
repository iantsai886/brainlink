// Folder-backed BrainStore: must pass the published contract, and keep untouched notes byte-stable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFolderStore } from '../src/store/folder-store.mjs';

// The recovered local brainlink-store package did not include its advertised
// contract-tests.mjs. Keep explicit adapter checks here; do not claim these
// replace the missing published contract suite.
test('folder-store: rejects a stale etag and preserves the committed note', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bl-folder-cas-'));
  try {
    const store = createFolderStore({ vaults: [{ name: 'Work', private: false }], root });
    const made = await store.write({ vault: 'Work', path: 'A.md', body: 'first', frontmatter: {} }, { expected_etag: '' });
    await assert.rejects(store.write({ vault: 'Work', id: made.id, path: 'A.md', body: 'second', frontmatter: {} }, { expected_etag: 'stale' }), /conflict|etag/i);
    assert.equal((await store.read(made.id)).body, 'first');
    assert.match(readFileSync(path.join(root, 'Work', 'A.md'), 'utf8'), /first/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('folder-store: private vault is inaccessible without explicit scope', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bl-folder-private-'));
  try {
    const store = createFolderStore({ vaults: [{ name: 'Private', private: true }], root });
    const made = await store.write({ vault: 'Private', path: 'Secret.md', body: 'fictional private marker', frontmatter: {} }, { expected_etag: '' });
    await assert.rejects(store.read(made.id, { remote: true }), /privacy|private|denied|not found/i);
    assert.equal((await store.read(made.id)).body, 'fictional private marker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

test('folder-store: refresh imports external creates and edits and tombstones external removals', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bl-folder-refresh-'));
  try {
    const dir = path.join(root, 'Work'); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'Existing.md'), 'before');
    const store = createFolderStore({ vaults: [{ name: 'Work', private: false }], vaultPaths: { Work: dir } });
    const original = await store.read('Work:Existing.md');
    writeFileSync(path.join(dir, 'Existing.md'), 'after from Obsidian');
    writeFileSync(path.join(dir, 'New.md'), 'new from Obsidian');
    const result = await store.refreshFromDisk();
    assert.equal(result.changed, true);
    assert.equal((await store.read(original.id)).body, 'after from Obsidian');
    assert.equal((await store.read('Work:New.md')).body, 'new from Obsidian');
    unlinkSync(path.join(dir, 'New.md'));
    assert.equal((await store.refreshFromDisk()).changed, true);
    const remaining = await store.list({ vault: 'Work' });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].path, 'Existing.md');
    assert.equal(remaining[0].id, original.id);
    assert.equal((await store.read('Work:New.md').catch(() => null)), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('folder-store: file watcher reports a content-free change after an external note appears', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bl-folder-watch-'));
  try {
    const dir = path.join(root, 'Work'); mkdirSync(dir, { recursive: true });
    const store = createFolderStore({ vaults: [{ name: 'Work', private: false }], vaultPaths: { Work: dir } });
    await store.list({ vault: 'Work' }); // settle the initial disk scan before watching for new changes
    let resolveChange; const changed = new Promise((resolve) => { resolveChange = resolve; });
    const watcher = store.watchFiles(() => resolveChange('changed'), { debounceMs: 40, fallbackIntervalMs: 100 });
    try {
      writeFileSync(path.join(dir, 'External.md'), 'do not include this content in notifications');
      assert.equal(await Promise.race([changed, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))]), 'changed');
      assert.equal((await store.read('Work:External.md')).body, 'do not include this content in notifications');
    } finally { watcher.stop(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
