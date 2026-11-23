import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveConfig, CONFIG_SCHEMA_VERSION } from '../src/config.mjs';
import { importAll, openSessionStore } from '../src/sessions/index.mjs';

test('local history import requires opt-in, can be disabled, and is always disabled in demo', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-consent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { HOME: root, BRAINLINK_HOME: path.join(root, 'app') };
  const transcript = path.join(root, '.claude', 'projects', 'fictional', 'session.jsonl');
  await mkdir(path.dirname(transcript), { recursive: true });
  await writeFile(transcript, [
    JSON.stringify({ type: 'user', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: 'Fictional history marker.' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-01T00:00:01Z', message: { role: 'assistant', content: 'Fictional response.' } }),
  ].join('\n'));
  const store = await openSessionStore(env);
  assert.deepEqual(await importAll({ store, env }), { disabled: true });
  assert.equal((await store.listSessions({ limit: 10 })).length, 0);
  const config = (enabled) => saveConfig({ version: CONFIG_SCHEMA_VERSION, vaults: [], sessions: { importHistory: enabled } }, path.join(env.BRAINLINK_HOME, 'config.json'));
  await config(true);
  assert.deepEqual(await importAll({ store, env: { ...env, BRAINLINK_DISABLE_HISTORY_IMPORT: '1' } }), { disabled: true });
  assert.equal((await store.listSessions({ limit: 10 })).length, 0);
  await importAll({ store, env });
  assert.equal((await store.listSessions({ limit: 10 })).length, 1);
  await config(false);
  assert.deepEqual(await importAll({ store, env }), { disabled: true });
  assert.equal((await store.listSessions({ limit: 10 })).length, 1, 'turning off import retains existing records');
});
