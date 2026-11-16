import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, saveConfig } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { readMemories } from '../src/writes.mjs';
import { startSetup } from '../src/setup.mjs';

test('local memory review saves user edits, detects conflicts, and respects vault write mode', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-memory-review-'));
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  const env = { HOME: root, BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_SEMANTIC: '0' };
  const file = path.join(env.BRAINLINK_HOME, 'config.json');
  let cfg = normalize({ vaults: [{ name: 'Private', path: vault, private: true, writes: 'on' }] });
  await saveConfig(cfg, file);
  const app = await startSetup({ env, home: root, os: process.platform, port: 0, useCli: false });
  t.after(async () => {
    await new Promise((resolve) => {
      app.server.close(resolve);
      app.server.closeAllConnections?.();
    });
    await rm(root, { recursive: true, force: true });
  });
  const post = (route, body, token = app.token) => fetch(`http://127.0.0.1:${app.port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body) });
  assert.equal((await post('/api/memory/review', { vault: 'Private' }, 'bad')).status, 401);
  const opened = await (await post('/api/memory/review', { vault: 'Private' })).json();
  assert.equal(opened.exists, false);
  assert.equal(opened.writable, true);
  const first = '# Memories\n\n- Fictional preference\n';
  assert.equal((await post('/api/memory/save', { vault: 'Private', text: first, etag: opened.etag })).status, 200);
  const ctx = createContext(cfg, { env, trustedLocal: true });
  assert.deepEqual(await readMemories(ctx, 'Private'), ['Fictional preference']);
  const reopened = await (await post('/api/memory/review', { vault: 'Private' })).json();
  const actual = path.join(vault, 'BrainLink', 'Memories.md');
  await writeFile(actual, '# Memories\n\n- Change from another editor\n');
  assert.equal((await post('/api/memory/save', { vault: 'Private', text: first, etag: reopened.etag })).status, 400);
  assert.match(await readFile(actual, 'utf8'), /Change from another editor/);
  const current = await (await post('/api/memory/review', { vault: 'Private' })).json();
  const concurrent = await Promise.all(['First review', 'Second review'].map((value) => post('/api/memory/save', { vault: 'Private', text: `# Memories\n\n- ${value}\n`, etag: current.etag })));
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 400], 'two saves based on one revision cannot both succeed');
  cfg = normalize({ vaults: [{ name: 'Private', path: vault, private: true, writes: 'off' }] });
  await saveConfig(cfg, file);
  assert.equal((await (await post('/api/memory/review', { vault: 'Private' })).json()).writable, false);
  assert.equal((await post('/api/memory/save', { vault: 'Private', text: first, etag: reopened.etag })).status, 400);
});
