import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(ROOT, 'scripts', 'smoke-live-codex-handoff.mjs');

test('live Codex handoff smoke is opt-in and uses an ephemeral scoped fixture', async () => {
  const idle = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
  assert.equal(idle.status, 0);
  assert.match(idle.stdout, /No run made/);
  const source = await readFile(script, 'utf8');
  assert.match(source, /--ephemeral/);
  assert.match(source, /--ignore-user-config/);
  assert.doesNotMatch(source, /--ask-for-approval/);
  assert.match(source, /Fictional Company/);
  assert.match(source, /Fictional Restricted/);
  assert.match(source, /private canary must not reach Codex output/);
  assert.match(source, /append-only reply/);
  assert.match(source, /Set ack_of to the exact request path/);
  assert.match(source, /status to COMPLETED/);
  assert.match(source, /list_handoffs', \{ limit: 10 \}/);
});
