import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createContext } from '../src/core.mjs';
import { normalize } from '../src/config.mjs';
import { createReplayMisses } from '../src/replay-misses.mjs';
import { retrievalUseReport } from '../src/retrieval-use.mjs';
import { startSetup } from '../src/setup.mjs';
import { formatCoveragePercent } from '../scripts/rsi-fix-selection-report.mjs';

test('RSI fix-selection report calculates one-decimal coverage from hit counts', () => {
  assert.equal(formatCoveragePercent(7, 14), '50.0%');
  assert.equal(formatCoveragePercent(5, 14), '35.7%');
  assert.throws(() => formatCoveragePercent(1, 0), /positive total/);
});

test('pinned replay cases report changed top note and hidden private misses stay absent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-p2-pin-'));
  const vault = path.join(root, 'Vault'), home = path.join(root, 'home');
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, 'Expected.md'), '# Dispatch inventory\nA fictional dispatch inventory reconciliation process.');
  const ctx = createContext(normalize({ vaults: [{ name: 'Shared', path: vault }] }), { env: { BRAINLINK_HOME: home, BRAINLINK_SEMANTIC: '0' } });
  const misses = createReplayMisses({ home });
  await misses.record({ vault: 'Shared', query: 'dispatch inventory reconciliation process', status: 'weak' });
  const miss = (await misses.list())[0];
  assert.equal(await misses.pin(miss.id, 'Expected.md'), true);
  await writeFile(path.join(vault, 'Dispatch inventory reconciliation process.md'), '# Dispatch inventory reconciliation process\nA fictional dispatch inventory reconciliation process with an exact title match.');
  const report = await misses.replay(ctx);
  assert.equal(report.regression_count, 1);
  assert.equal(report.regressions[0].expected_path, 'Expected.md');
  assert.equal(report.regressions[0].actual_path, 'Dispatch inventory reconciliation process.md');
});

test('retrieval-use report counts recent shared note paths and excludes private/excluded notes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-p2-use-'));
  const vault = path.join(root, 'Vault');
  await mkdir(path.join(vault, 'Docs'), { recursive: true });
  await mkdir(path.join(vault, 'Hidden'), { recursive: true });
  await writeFile(path.join(vault, 'Docs', 'Used.md'), '# Used\nVisible fixture note.');
  await writeFile(path.join(vault, 'Docs', 'Private.md'), '---\nprivate: true\n---\n# Private\nPRIVATE_USE_CANARY');
  await writeFile(path.join(vault, 'Hidden', 'Excluded.md'), '# Excluded\nExcluded fixture note.');
  await writeFile(path.join(vault, '.brainlinkignore'), 'Hidden/\n');
  const ctx = createContext(normalize({ vaults: [{ name: 'Shared', path: vault }] }), { env: { BRAINLINK_HOME: path.join(root, 'home'), BRAINLINK_SEMANTIC: '0' } });
  const report = await retrievalUseReport(ctx, [
    { at: new Date().toISOString(), tool: 'vault_search', ok: true, retrieved_notes: ['Shared/Docs/Used.md'] },
    { at: new Date().toISOString(), tool: 'context_packet', ok: true, retrieved_notes: ['Shared/Docs/Private.md', 'Shared/Hidden/Excluded.md'] },
    { at: '2020-01-01T00:00:00.000Z', tool: 'vault_search', ok: true, retrieved_notes: ['Shared/Docs/Unused.md'] },
  ]);
  assert.equal(report.visible_notes, 1);
  assert.equal(report.retrieved_notes, 1);
  assert.equal(report.never_retrieved, 0);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_USE_CANARY|Private\.md|Excluded\.md/);
});

test('Setup runs one local self-test per day and does not recreate the same failure proposal', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-p2-daily-test-'));
  let now = new Date('2026-11-16T10:00:00.000Z');
  const env = { BRAINLINK_HOME: path.join(root, 'home'), BRAINLINK_SEMANTIC: '0' };
  const app = await startSetup({ env, home: root, os: 'linux', port: 0, useCli: false, selfTestNow: () => now, selfTestTickMs: 20 });
  t.after(async () => { app.server.close(); await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const list = async () => fetch(`http://127.0.0.1:${app.port}/api/rsi`, { headers: { 'X-BrainLink-Token': app.token } }).then(response => response.json());
  let ideas = [];
  for (let i = 0; i < 50 && !ideas.length; i++) { await new Promise(resolve => setTimeout(resolve, 20)); ideas = (await list()).ideas; }
  assert.equal(ideas.filter(item => item.origin === 'self_test').length, 1);
  now = new Date('2026-11-17T10:00:00.000Z');
  await new Promise(resolve => setTimeout(resolve, 70));
  ideas = (await list()).ideas;
  assert.equal(ideas.filter(item => item.origin === 'self_test').length, 1, 'daily reruns do not create duplicate proposals for the same failure');
});
