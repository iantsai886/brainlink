import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { syncSettings, chooseSync, syncOnce, readSessionIndex, restoreSnapshot, redact, PROVIDERS } from '../src/sync/index.mjs';

// Real BrainStore contract (brainlink-store, commit d8e792b): interface.d.ts, memory-store.mjs, errors.mjs.
const STORE_DIR = process.env.BRAINLINK_STORE_DIR
  || ['../vendor/brainlink-store', '../src/store', '../../brainlink-store'].map((p) => path.resolve(import.meta.dirname, p)).find((d) => existsSync(path.join(d, 'memory-store.mjs')));
if (!STORE_DIR) throw new Error('memory-store.mjs not found; set BRAINLINK_STORE_DIR');
const { createMemoryStore, toSessionRecord } = await import(pathToFileURL(path.join(STORE_DIR, 'memory-store.mjs')).href);

const VAULTS = [{ name: 'brain', private: false }, { name: 'personal', private: false }];
const freshStore = (opts = {}) => createMemoryStore({ vaults: VAULTS, ...opts });

const tmp = () => mkdtemp(path.join(tmpdir(), 'bl-sync-'));
const cfgFor = (provider, folder) => chooseSync({}, { provider, folder, device: 'macA' });
const notes = (f) => path.join(f, 'BrainLink', 'notes');

test('local only is the default and syncs nothing', async () => {
  assert.equal(syncSettings({}).provider, 'local');
  assert.deepEqual(PROVIDERS, ['local', 'gdrive', 'icloud', 'dropbox']);
  const store = freshStore(); await store.write({ vault: 'brain', path: 'a.md', body: 'x' }, { expected_etag: '' });
  assert.equal((await syncOnce({ store })).status, 'local-only');
  assert.throws(() => chooseSync({}, { provider: 'gdrive', folder: 'rel/path' }));
});

test('sync settings accept a named public vault and refuse an unknown or private vault', () => {
  const cfg = { vaults: [{ name: 'Work', private: false }, { name: 'Personal', private: true }] };
  const folder = path.resolve('Drive');
  assert.equal(chooseSync(cfg, { provider: 'gdrive', folder, vault: 'Work' }).sync.vault, 'Work');
  assert.throws(() => chooseSync(cfg, { provider: 'gdrive', folder, vault: 'Missing' }), /existing public vault/);
  assert.throws(() => chooseSync(cfg, { provider: 'gdrive', folder, vault: 'Personal' }), /existing public vault/);
  assert.equal(chooseSync(cfg, { provider: 'gdrive', folder, vault: 'Work', scheduled: true, intervalHours: 12 }).sync.scheduled, true);
  assert.equal(chooseSync(cfg, { provider: 'gdrive', folder, vault: 'Work', intervalHours: 12 }).sync.intervalHours, 12);
  assert.throws(() => chooseSync(cfg, { provider: 'gdrive', folder, vault: 'Work', scheduled: 'yes' }), /scheduled must be a boolean/);
  assert.throws(() => chooseSync(cfg, { provider: 'gdrive', folder, vault: 'Work', intervalHours: 0 }), /intervalHours must be 1–168/);
});

for (const p of ['gdrive', 'icloud', 'dropbox']) test(`${p}: push then pull round trip`, async () => {
  const f = await tmp(), store = freshStore();
  await store.write({ vault: 'brain', path: 'P/a.md', body: 'hello', frontmatter: { tags: ['t'] } }, { expected_etag: '' });
  let r = await syncOnce({ store, cfg: cfgFor(p, f) });
  assert.deepEqual(r.pushed, ['P/a.md']);
  await writeFile(path.join(notes(f), 'P/b.md'), '---\ntype: "idea"\n---\nfrom other device');
  r = await syncOnce({ store, cfg: cfgFor(p, f), state: r.state });
  assert.deepEqual(r.pulled, ['P/b.md']);
  assert.equal((await store.read('brain:P/b.md')).frontmatter.type, 'idea');
});

test('private notes, private vaults and non-brain scopes never sync', async () => {
  const f = await tmp(), store = freshStore();
  await store.write({ vault: 'brain', path: 'pub.md', body: 'ok' }, { expected_etag: '' });
  await store.write({ vault: 'brain', path: 'fm.md', body: 'no', frontmatter: { private: true } }, { expected_etag: '' });
  await store.write({ vault: 'brain', path: 'Secret/v.md', body: 'no' }, { expected_etag: '' });
  await store.write({ vault: 'personal', path: 'p.md', body: 'no' }, { expected_etag: '' });
  const cfg = { ...cfgFor('gdrive', f), vaults: [{ name: 'Secret', private: true }] };
  // Session entries are real SessionRecords (store contract v0.2 toSessionRecord), as a caller
  // backed by src/sessions/store.mjs would hand sync; `scope` is sync's own extra field, stamped
  // with the session's vault, same as src/sync-cli.mjs does today.
  const sessStore = freshStore();
  const pub = await sessStore.putSession({ client: 'claude-code', source_id: 'pub', vault: 'brain', project: 'x', title: 'pub', summary: 'pub summary', started_at: '2031-01-01T00:00:00Z', messages: [] });
  const priv = await sessStore.putSession({ client: 'claude-code', source_id: 'priv', vault: 'brain', project: 'x', title: 'priv', summary: 'priv summary', started_at: '2031-01-01T00:00:00Z', messages: [], private: true });
  const other = await sessStore.putSession({ client: 'codex', source_id: 'other', vault: 'brain', project: 'y', title: 'other', summary: 'other summary', started_at: '2031-01-01T00:00:00Z', messages: [] });
  const sessions = [toSessionRecord(pub), toSessionRecord(priv), { ...toSessionRecord(other), scope: 'personal' }];
  const r = await syncOnce({ store, cfg, sessions });
  assert.deepEqual(r.pushed, ['pub.md']);
  assert.deepEqual((await readSessionIndex(f)).map((s) => s.id), [pub.id]);
});

test('both sides changed: keep both copies and flag', async () => {
  const f = await tmp(), store = freshStore({ clock: () => '2026-10-19T05:00:00Z' }), cfg = cfgFor('gdrive', f);
  const w = await store.write({ vault: 'brain', path: 'a.md', body: 'v1' }, { expected_etag: '' });
  let r = await syncOnce({ store, cfg, now: () => '2026-10-19T05:00:00Z' });
  await store.write({ vault: 'brain', path: 'a.md', body: 'local v2' }, { expected_etag: w.etag });
  await writeFile(path.join(notes(f), 'a.md'), 'remote v2');
  r = await syncOnce({ store, cfg, state: r.state, now: () => '2026-10-19T05:00:00Z' });
  assert.equal(r.conflicts.length, 1);
  assert.equal((await store.read('brain:a.md')).body, 'local v2');
  assert.equal(await readFile(path.join(notes(f), 'a.md'), 'utf8'), 'remote v2');
  assert.equal((await store.read('brain:a (conflict remote 2026-10-19).md')).body, 'remote v2');
  assert.equal(await readFile(path.join(notes(f), 'a (conflict macA 2026-10-19).md'), 'utf8'), 'local v2');
  assert.equal(r.state.conflicts.length, 1);
});

test('offline / missing folder: no-op, queued, nothing written', async () => {
  const store = freshStore(); await store.write({ vault: 'brain', path: 'a.md', body: 'x' }, { expected_etag: '' });
  const gone = path.join(await tmp(), 'not-mounted');
  const r = await syncOnce({ store, cfg: cfgFor('dropbox', gone) });
  assert.equal(r.status, 'queued'); assert.equal(r.state.queued, true);
  await assert.rejects(readdir(gone));
  assert.equal((await store.list()).length, 1);
});

test('snapshot before apply, then restore', async () => {
  const f = await tmp(), store = freshStore(), cfg = cfgFor('icloud', f);
  await store.write({ vault: 'brain', path: 'a.md', body: 'v1' }, { expected_etag: '' });
  let r = await syncOnce({ store, cfg });
  await writeFile(path.join(notes(f), 'a.md'), 'remote edit');
  r = await syncOnce({ store, cfg, state: r.state });
  assert.ok(r.snapshot?.id); assert.equal((await store.read('brain:a.md')).body, 'remote edit');
  await restoreSnapshot(store, r.snapshot.id);
  assert.equal((await store.read('brain:a.md')).body, 'v1');
  assert.ok(!(await readdir(notes(f))).some((x) => x.includes('.tmp-')));
});

test('secrets redacted from session index', async () => {
  const keys = ['sk-' + 'a'.repeat(32), 'ghp_' + 'b'.repeat(36), 'AKIA' + 'C'.repeat(16), 'xoxb-' + '1'.repeat(12)];
  const t = `k ${keys.join(' ')} password=hunter2 Bearer ${'z'.repeat(20)} mail a.b@example.com ping @someone`;
  const out = redact(t);
  for (const s of [...keys, 'hunter2', 'z'.repeat(20), 'a.b@example.com', '@someone']) assert.ok(!out.includes(s), s);

  // The store's own secret filter (putSession/appendSession) already blocks sk-/AKIA/gh*/xox* etc at
  // import time, so a real SessionRecord can't carry those; use fields it does NOT check (email,
  // password=) to prove sync's redact pass runs independently on a genuine store-sourced SessionRecord.
  const f = await tmp();
  const sessStore = freshStore();
  const leaky = await sessStore.putSession({ client: 'claude-code', source_id: 'leaky', vault: 'brain', project: 'x', title: 'leak',
    summary: 'contact a.b@example.com, password=hunter2', started_at: '2031-01-01T00:00:00Z', messages: [] });
  await syncOnce({ store: freshStore(), cfg: cfgFor('gdrive', f), sessions: [toSessionRecord(leaky)] });
  const raw = await readFile(path.join(f, 'BrainLink', 'sessions', 'macA.json'), 'utf8');
  assert.ok(!raw.includes('a.b@example.com')); assert.ok(!raw.includes('hunter2'));
});
