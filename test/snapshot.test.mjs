// Shared snapshot (Ian's RB8): a read-only, filtered copy of notes for cloud agents with no
// inbound network access. Same filter every other read path uses (excluded folders, private
// notes/vaults); atomic writes; manifest-tracked deletion so foreign files are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalize } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { openSessionStore } from '../src/sessions/index.mjs';
import { startSetup } from '../src/setup.mjs';
import {
  snapshotSettings, validateSnapshot, chooseSnapshot, suggestSnapshotFolder,
  writeSnapshotOnce, clearSnapshot, startSnapshotWatcher, loadSnapshotStatus, saveSnapshotStatus,
} from '../src/snapshot.mjs';

const tmp = (p) => mkdtemp(path.join(tmpdir(), `bl-snap-${p}-`));

async function setupVaults() {
  const vaultDir = await tmp('vault');
  await writeFile(path.join(vaultDir, 'Public.md'), '# Public\nhello');
  await mkdir(path.join(vaultDir, 'Secret'), { recursive: true });
  await writeFile(path.join(vaultDir, 'Secret', 'x.md'), 'hidden by excluded folder');
  await writeFile(path.join(vaultDir, '.brainlinkignore'), 'Secret/\n');
  await writeFile(path.join(vaultDir, 'Private.md'), '---\nprivate: true\n---\nshh');
  const privVaultDir = await tmp('priv-vault');
  await writeFile(path.join(privVaultDir, 'AlsoSecret.md'), 'nope');
  const env = { BRAINLINK_HOME: await tmp('home'), BRAINLINK_SEMANTIC: '0' };
  const cfg = normalize({ vaults: [{ name: 'Brain', path: vaultDir }, { name: 'Diary', path: privVaultDir, private: true }] });
  const ctx = createContext(cfg, { env });
  return { vaultDir, privVaultDir, env, cfg, ctx };
}

test('snapshot: enabling needs an absolute folder', () => {
  assert.throws(() => chooseSnapshot({}, { enabled: true }), /folder/);
  assert.throws(() => chooseSnapshot({}, { enabled: true, folder: 'relative/path' }), /folder/);
  assert.deepEqual(validateSnapshot({ enabled: false, folder: null }), []);
  const next = chooseSnapshot({}, { enabled: true, folder: '/tmp/shared' });
  assert.equal(snapshotSettings(next).enabled, true);
  assert.equal(snapshotSettings(next).folder, '/tmp/shared');
  assert.equal(snapshotSettings({}).enabled, false, 'off by default');
});

test('snapshot: nothing is written while the toggle is off', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-off');
  const withFolderButOff = chooseSnapshot(cfg, { enabled: false, folder: dest });
  const r = await writeSnapshotOnce(ctx, withFolderButOff, env);
  assert.equal(r.skipped, true);
  assert.deepEqual(await readdir(dest), [], 'a configured-but-disabled folder stays untouched');
  assert.ok(!existsSync(path.join(dest, 'manifest.json')));
});

test('snapshot: excluded and private notes never appear; foreign files are left untouched', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest');
  await writeFile(path.join(dest, 'my-own-file.txt'), 'keep me');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });

  const r = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r.ok, true);
  assert.equal(r.noteCount, 1, 'only Public.md qualifies');

  assert.equal(await readFile(path.join(dest, 'Brain', 'Public.md'), 'utf8'), '# Public\nhello');
  assert.ok(!existsSync(path.join(dest, 'Brain', 'Secret')), 'excluded folder never copied');
  assert.ok(!existsSync(path.join(dest, 'Brain', 'Private.md')), 'private note never copied');
  assert.ok(!existsSync(path.join(dest, 'Diary')), 'private vault never copied');
  assert.match(await readFile(path.join(dest, 'README.md'), 'utf8'), /read-only/);
  assert.match(await readFile(path.join(dest, 'index.md'), 'utf8'), /Public/);

  const manifest = JSON.parse(await readFile(path.join(dest, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.files).sort(), ['Brain/Public.md', 'README.md', 'index.md']);

  assert.equal(await readFile(path.join(dest, 'my-own-file.txt'), 'utf8'), 'keep me', 'foreign file untouched');
});

test('snapshot: removing or excluding a note propagates, without touching foreign files', async () => {
  const { vaultDir, ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-removal');
  await writeFile(path.join(dest, 'my-own-file.txt'), 'keep me');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });

  await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.ok(existsSync(path.join(dest, 'Brain', 'Public.md')));

  await writeFile(path.join(vaultDir, '.brainlinkignore'), 'Secret/\nPublic.md\n');
  const r2 = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r2.noteCount, 0);
  assert.ok(!existsSync(path.join(dest, 'Brain', 'Public.md')), 'newly excluded note is deleted from the snapshot');
  const manifest = JSON.parse(await readFile(path.join(dest, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.files).sort(), ['README.md', 'index.md']);
  assert.equal(await readFile(path.join(dest, 'my-own-file.txt'), 'utf8'), 'keep me');
});

test('snapshot: marking a previously-shared note private removes it too', async () => {
  const { vaultDir, ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-private');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.ok(existsSync(path.join(dest, 'Brain', 'Public.md')));
  await writeFile(path.join(vaultDir, 'Public.md'), '---\nprivate: true\n---\n# Public\nhello');
  const r2 = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r2.noteCount, 0);
  assert.ok(!existsSync(path.join(dest, 'Brain', 'Public.md')));
});

test('snapshot: clearing removes only files BrainLink wrote', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-clear');
  await writeFile(path.join(dest, 'my-own-file.txt'), 'keep me');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.ok(existsSync(path.join(dest, 'manifest.json')));

  await clearSnapshot(snapshotSettings(withSnapshot).folder);
  assert.ok(!existsSync(path.join(dest, 'manifest.json')));
  assert.ok(!existsSync(path.join(dest, 'README.md')));
  assert.ok(!existsSync(path.join(dest, 'index.md')));
  assert.ok(!existsSync(path.join(dest, 'Brain', 'Public.md')));
  assert.equal(await readFile(path.join(dest, 'my-own-file.txt'), 'utf8'), 'keep me');
});

test('snapshot: includeSessions opts in non-private session summaries only', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const store = await openSessionStore(env);
  await store.putSession({ client: 'codex', source_id: 'pub', project: 'x', title: 'Public chat', summary: 'public summary', started_at: '2026-10-10T00:00:00Z', messages: [] });
  await store.putSession({ client: 'codex', source_id: 'priv', project: 'x', title: 'Private chat', summary: 'private summary', started_at: '2026-10-10T00:00:00Z', messages: [], private: true });

  const dest1 = await tmp('dest-no-sessions');
  await writeSnapshotOnce(ctx, chooseSnapshot(cfg, { enabled: true, folder: dest1 }), env);
  assert.ok(!existsSync(path.join(dest1, 'sessions.json')), 'left out by default');

  const dest2 = await tmp('dest-with-sessions');
  await writeSnapshotOnce(ctx, chooseSnapshot(cfg, { enabled: true, folder: dest2, includeSessions: true }), env);
  const sessions = JSON.parse(await readFile(path.join(dest2, 'sessions.json'), 'utf8')).sessions;
  assert.deepEqual(sessions.map((s) => s.summary), ['public summary']);
});

test('snapshot: atomic write leaves no temp files behind', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-atomic');
  await writeSnapshotOnce(ctx, chooseSnapshot(cfg, { enabled: true, folder: dest }), env);
  const names = await readdir(path.join(dest, 'Brain'));
  assert.ok(!names.some((n) => n.includes('.tmp-')));
});

test('snapshot: suggestSnapshotFolder finds a Google Drive for desktop folder', async () => {
  const home = await tmp('home-gdrive');
  assert.equal(suggestSnapshotFolder(home), null);
  const drive = path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-me@example.com', 'My Drive');
  await mkdir(drive, { recursive: true });
  assert.equal(suggestSnapshotFolder(home), drive);
});

test('snapshot: status file tracks last synced time, count and error', async () => {
  const file = path.join(await tmp('status'), 'snapshot-state.json');
  assert.deepEqual(await loadSnapshotStatus(file), { lastSyncedAt: null, noteCount: 0, error: null });
  const ok = await saveSnapshotStatus(file, { ok: true, noteCount: 3, syncedAt: '2026-10-21T00:00:00Z' });
  assert.deepEqual(ok, { lastSyncedAt: '2026-10-21T00:00:00Z', noteCount: 3, error: null });
  const failed = await saveSnapshotStatus(file, { ok: false, error: 'Shared folder not found' });
  assert.equal(failed.error, 'Shared folder not found');
  assert.equal(failed.lastSyncedAt, '2026-10-21T00:00:00Z', 'keeps the last good sync time on a later error');
});

test('snapshot: watcher runs once immediately and stop() prevents further runs', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-watch');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  const results = [];
  const w = startSnapshotWatcher(ctx, withSnapshot, env, { debounceMs: 10, intervalMs: 60_000, onResult: (r) => results.push(r) });
  await new Promise((r) => setTimeout(r, 150));
  w.stop();
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].noteCount, 1);
});

test('snapshot: watcher is a no-op when the toggle is off', () => {
  const w = startSnapshotWatcher({ enabled: [] }, normalize({}), {});
  assert.doesNotThrow(() => w.stop());
});

// ---- setup.mjs: the Settings toggle, folder picker and clear routes ----

test('setup UI: /api/snapshot turns sharing on, writes once, and state() reports it', async () => {
  const home = await tmp('setup-home');
  const vaultDir = await tmp('setup-vault');
  await writeFile(path.join(vaultDir, 'A.md'), '# A\nhello');
  const dest = await tmp('setup-dest');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, pickSnapshotFolder: async () => dest });
  const api = (method, p, body) => fetch(`http://127.0.0.1:${s.port}${p}`, { method, headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    await (await api('POST', '/api/vault', { path: vaultDir, name: 'Brain', scaffold: false })).json();
    const st0 = await (await api('GET', '/api/state')).json();
    assert.equal(st0.snapshot.enabled, false);
    assert.equal(st0.snapshot.lastSyncedAt, null);

    const picked = await (await api('POST', '/api/snapshot/pick-folder')).json();
    assert.equal(picked.path, dest);

    const r = await (await api('POST', '/api/snapshot', { enabled: true, folder: dest })).json();
    assert.equal(r.ok, true);
    assert.equal(r.snapshot.noteCount, 2, 'A.md plus the auto-created BrainLink/Home.md map');
    assert.ok(r.snapshot.lastSyncedAt);
    assert.ok(existsSync(path.join(dest, 'manifest.json')), 'writes immediately on enabling, not just on the next interval');
    assert.ok(existsSync(path.join(dest, 'Brain', 'A.md')));

    const st1 = await (await api('GET', '/api/state')).json();
    assert.equal(st1.snapshot.enabled, true);
    assert.equal(st1.snapshot.noteCount, 2);

    const bad = await api('POST', '/api/snapshot', { enabled: true, folder: 'relative/path' });
    assert.equal(bad.status, 400);

    await (await api('POST', '/api/snapshot/clear')).json();
    assert.ok(!existsSync(path.join(dest, 'manifest.json')));
  } finally { s.server.close(); }
});
