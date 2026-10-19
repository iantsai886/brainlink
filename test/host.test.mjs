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
