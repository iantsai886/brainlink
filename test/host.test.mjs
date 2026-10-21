// Host wiring: createApi({store, services, access}) shape, backed by a real folder + scratch config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFolderHost } from '../src/host.mjs';

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bl-host-'));
  return { dir, configFile: path.join(dir, 'config.json'), vaultDir: path.join(dir, 'vault') };
}

test('createFolderHost: store is a real folder-backed BrainStore', async () => {
  const { dir, configFile, vaultDir } = scratch();
  const host = await createFolderHost({ name: 'Demo', folder: vaultDir, configFile });
  assert.deepEqual(host.store.vaults(), [{ name: 'Demo', private: false }]);
  const w = await host.store.write({ vault: 'Demo', path: 'Hello.md', body: 'Hi there.', frontmatter: {} }, { expected_etag: '' });
  assert.match(w.id, /^n_/);
  assert.equal((await host.store.read(w.id)).body, 'Hi there.');
  rmSync(dir, { recursive: true, force: true });
});

test('createFolderHost: connectors.detect returns the UI-shaped array', async () => {
  const { dir, configFile, vaultDir } = scratch();
  const host = await createFolderHost({ name: 'Demo', folder: vaultDir, configFile, env: { ...process.env, HOME: dir }, home: dir });
  const found = await host.services.connectors.detect();
  assert.ok(Array.isArray(found) && found.length > 0);
  for (const c of found) for (const k of ['client', 'name', 'transport', 'installed', 'connected', 'config_path']) assert.ok(k in c, `missing ${k}`);
  rmSync(dir, { recursive: true, force: true });
});

test('createFolderHost: services.sessions.list/read/setPrivate round-trip a logged session', async () => {
  const { dir, configFile, vaultDir } = scratch();
  const env = { BRAINLINK_HOME: dir };
  const host = await createFolderHost({ name: 'Demo', folder: vaultDir, configFile, env });
  const { openSessionStore } = await import('../src/sessions/index.mjs');
  const store = await openSessionStore(env);
  const s = await store.putSession({ client: 'codex', source_id: 'proj/1', project: '/x', title: 'Fix the kiln', summary: 'Diagnosed the kiln controller.', started_at: '2026-10-10T00:00:00Z', note_refs: [], private: true, messages: [{ role: 'user', at: '2026-10-10T00:00:00Z', text: 'hi' }] });

  assert.deepEqual((await host.services.sessions.list({})).sessions, [], 'private session hidden by default');
  const visible = await host.services.sessions.list({ include_private: true });
  assert.equal(visible.sessions.length, 1);
  assert.equal(visible.sessions[0].id, s.id);

  await assert.rejects(host.services.sessions.read({ id: s.id }), /private/i);
  const read = await host.services.sessions.read({ id: s.id, include_private: true });
  assert.equal(read.title, 'Fix the kiln');

  const toggled = await host.services.sessions.setPrivate(s.id, false);
  assert.equal(toggled.private, false);
  assert.deepEqual((await host.services.sessions.list({})).sessions.map((x) => x.id), [s.id], 'no longer private, now visible without include_private');
  rmSync(dir, { recursive: true, force: true });
});

test('createFolderHost: settings.get/suggestFolders/validate/save round-trip through config.json', async () => {
  const { dir, configFile, vaultDir } = scratch();
  writeFileSync(configFile, JSON.stringify({ version: 1, vaults: [{ name: 'Demo', path: vaultDir }], agents: [] }));
  const host = await createFolderHost({ name: 'Demo', folder: vaultDir, configFile });
  const s = host.services.settings;
  assert.equal((await s.get()).provider, 'local');
  assert.ok(typeof (await s.suggestFolders()) === 'object');
  assert.equal((await s.validate({ provider: 'gdrive', folder: 'relative', device: 'x' })).ok, false);
  const saved = await s.save({ provider: 'local', folder: null, device: 'laptop' });
  assert.equal(saved.ok, true);
  assert.equal((await s.get()).device, 'laptop');
  rmSync(dir, { recursive: true, force: true });
});
