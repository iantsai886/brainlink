// Host wiring: createApi({store, services, access}) shape, backed by a real folder + scratch config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
  const env = { BRAINLINK_HOME: dir, HOME: dir };
  const host = await createFolderHost({ name: 'Demo', folder: vaultDir, configFile, env });
  const { openSessionStore } = await import('../src/sessions/index.mjs');
  const store = await openSessionStore(env);
  const s = await store.putSession({ client: 'codex', source_id: 'proj/1', project: '/x', title: 'Fix the kiln', summary: 'Diagnosed the kiln controller.', started_at: '2026-10-10T00:00:00Z', note_refs: [], private: true, messages: [{ role: 'user', at: '2026-10-10T00:00:00Z', text: 'hi' }] });

  assert.deepEqual((await host.services.sessions.list({})).sessions, [], 'private session hidden by default');
  const visible = await host.services.sessions.list({ include_private: true });
  assert.equal(visible.sessions.length, 1);
  assert.equal(visible.sessions[0].id, s.id);

  const blocked = await host.services.sessions.read({ id: s.id });
  assert.equal(blocked.private, true);
  assert.match(blocked.message, /private/i, 'private session_read returns a clear message instead of throwing');
  const read = await host.services.sessions.read({ id: s.id, include_private: true });
  assert.equal(read.title, 'Fix the kiln');

  const toggled = await host.services.sessions.setPrivate(s.id, false);
  assert.equal(toggled.private, false);
  assert.deepEqual((await host.services.sessions.list({})).sessions.map((x) => x.id), [s.id], 'no longer private, now visible without include_private');
  rmSync(dir, { recursive: true, force: true });
});

test('explicit session refresh imports a newly ended Codex session without restarting BrainLink', async () => {
  const { dir, configFile, vaultDir } = scratch();
  const env = { BRAINLINK_HOME: path.join(dir, 'brainlink-data'), HOME: dir };
  writeFileSync(configFile, JSON.stringify({ version: 2, vaults: [], sessions: { importHistory: true } }));
  const host = await createFolderHost({ name: 'Demo', folder: vaultDir, configFile, env, home: dir });
  assert.deepEqual((await host.services.sessions.list({ include_private: true })).sessions, []);
  const transcript = path.join(dir, '.codex', 'sessions', '2026', '10', '26', 'rollout-new-session.jsonl');
  mkdirSync(path.dirname(transcript), { recursive: true });
  writeFileSync(transcript, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'new-session', cwd: path.join(dir, 'project') } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-10-26T01:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the synthetic release plan' }] } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-10-26T01:01:00.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The plan is ready for review.' }] } }),
  ].join('\n') + '\n');
  await host.services.sessions.refresh();
  const sessions = (await host.services.sessions.list({ include_private: true })).sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].client, 'codex');
  assert.match(sessions[0].summary, /Review the synthetic release plan/);
  assert.equal(sessions[0].private, true);
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
