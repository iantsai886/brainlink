import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionSeenStore, sessionSeenIdentity } from '../src/since-last-session.mjs';
import { createContext } from '../src/core.mjs';
import { normalize } from '../src/config.mjs';
import { createMcp } from '../src/server.mjs';
import { estTokens } from '../src/sessions/tokens.mjs';

test('last-seen timestamps are isolated by connection and role and persisted locally', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'bl-session-seen-'));
  let stamp = new Date('2026-11-15T12:00:00Z');
  const store = createSessionSeenStore(home, { now: () => stamp });
  assert.equal(await store.get('codex', 'anna'), null);
  assert.equal(await store.mark('codex', 'anna'), stamp.toISOString());
  stamp = new Date('2026-11-16T12:00:00Z');
  await store.mark('codex', 'john');
  await store.mark('claude', 'anna');
  assert.equal(await store.get('codex', 'anna'), '2026-11-15T12:00:00.000Z');
  assert.equal(await store.get('codex', 'john'), '2026-11-16T12:00:00.000Z');
  assert.equal(await store.get('claude', 'anna'), '2026-11-16T12:00:00.000Z');
  assert.deepEqual(sessionSeenIdentity({ platform: 'codex', agentRole: 'anna' }), { connection: 'codex', role: 'anna' });
});

test('since_last_session uses visible notes only and does not disclose a planted private note', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-session-since-'));
  const vault = path.join(root, 'Vault');
  const home = path.join(root, 'home');
  await mkdir(vault);
  await writeFile(path.join(vault, 'Visible.md'), '# Shipping update\nA fictional public status update.');
  await writeFile(path.join(vault, 'Private.md'), '---\nprivate: true\n---\n# Shipping update\nSINCE_PRIVATE_CANARY');
  const ctx = createContext(normalize({ vaults: [{ name: 'Shared', path: vault }] }), {
    env: { BRAINLINK_HOME: home, BRAINLINK_SEMANTIC: '0' },
  });
  ctx.platform = 'fictional-codex';
  const tool = createMcp(ctx).tools.find((item) => item.name === 'since_last_session');
  assert.ok(tool);
  const result = await tool.run({});
  assert.equal(result.first_call_window_days, 7);
  assert.ok(result.changed.some((note) => note.path === 'Visible.md'));
  assert.doesNotMatch(JSON.stringify(result), /SINCE_PRIVATE_CANARY|Private\.md/);
  assert.ok(result.changed.length <= 6);
  assert.ok(result.open_loops.length <= 6);
});

test('since_last_session remains bounded on a 3,000-note fictional vault', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-session-since-large-'));
  const vault = path.join(root, 'Vault');
  await mkdir(vault);
  await Promise.all(Array.from({ length: 3000 }, (_, i) => writeFile(path.join(vault, `Note-${String(i).padStart(4, '0')}.md`),
    `# Fictional note ${i}\nRoutine archival reference for a test corpus.\n`)));
  const ctx = createContext(normalize({ vaults: [{ name: 'Shared', path: vault }] }), { env: { BRAINLINK_HOME: path.join(root, 'home'), BRAINLINK_SEMANTIC: '0' } });
  ctx.platform = 'fictional-codex';
  const result = await createMcp(ctx).tools.find((item) => item.name === 'since_last_session').run({});
  assert.ok(estTokens(JSON.stringify(result)) < 1200);
  assert.ok(result.changed.length <= 6);
  assert.ok(result.open_loops.length <= 6);
});
