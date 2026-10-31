import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(ROOT, 'scripts', 'smoke-live-cross-client-handoff.mjs');

test('live two-client handoff smoke is opt-in and skips without creating fixtures', async () => {
  const idle = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
  assert.equal(idle.status, 0);
  assert.match(idle.stdout, /No run made/);
  assert.match(idle.stdout, /fictional temporary vaults/);
});

test('live cross-client smoke checks both logins before fixtures and limits both clients to BrainLink', async () => {
  const source = await readFile(script, 'utf8');
  const firstFixture = source.indexOf("mkdtemp(path.join(os.tmpdir(), 'brainlink-live-cross-client-'))");
  assert.ok(firstFixture > source.indexOf('requireClaudeLogin(claude)'));
  assert.ok(firstFixture > source.indexOf('requireCodexLogin(codex)'));
  assert.match(source, /--strict-mcp-config/);
  assert.match(source, /--no-session-persistence/);
  assert.match(source, /--ephemeral/);
  assert.match(source, /--sandbox', 'read-only'/);
  assert.match(source, /--allowedTools',[\s\S]*mcp__brainlink__/);
  assert.match(source, /Fictional Restricted/);
  assert.match(source, /ZQX_CROSS_CLIENT_PRIVATE_CANARY/);
  assert.match(source, /assertNoPrivateCanary/);
  assert.match(source, /Claude sender/);
  assert.match(source, /Codex receiver/);
  assert.match(source, /ack_of to the original request path/);
  assert.doesNotMatch(source, /--dangerously-skip-permissions|claude\.json|config\.toml/);
});
