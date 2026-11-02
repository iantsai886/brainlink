// Folder-backed BrainStore: must pass the published contract, and keep untouched notes byte-stable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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

test('folder-store: workflow lists round-trip commas, quotes, and colon text', async () => {
  const root=mkdtempSync(path.join(tmpdir(),'bl-folder-workflow-'));
  try {
    const store=createFolderStore({vaults:[{name:'Work',private:false}],root});
    const expected={triggers:['New file arrives, then wait','User asks: run review'],inputs:['CSV, JSON','"Ready" folder'],steps:['Read source, check revision','Create a linked note'],outputs:['Review proposal']};
    const made=await store.write({vault:'Work',path:'Workflow.md',body:'# Workflow',frontmatter:{type:'workflow',...expected}},{expected_etag:''});
    const text=readFileSync(path.join(root,'Work','Workflow.md'),'utf8');
    assert.match(text,/New file arrives, then wait/);
    assert.deepEqual((await store.read(made.id)).frontmatter,{type:'workflow',...expected});
    const reopened=createFolderStore({vaults:[{name:'Work',private:false}],root});
    const loaded=(await reopened.list({vault:'Work'}))[0];
    assert.deepEqual((await reopened.read(loaded.id)).frontmatter,{type:'workflow',...expected},'a fresh store must parse the lists back from Markdown');
  } finally { rmSync(root,{recursive:true,force:true}); }
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
