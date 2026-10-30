import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyConfig, normalize, saveConfig } from '../src/config.mjs';
import { createContext, countVisibleNotes } from '../src/core.mjs';
import { startSetup } from '../src/setup.mjs';

test('Setup returns before a slow vault count and updates the count when it finishes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-lazy-count-'));
  const home = path.join(root, 'home');
  const vaultPath = path.join(root, 'vault');
  await Promise.all([mkdir(home), mkdir(vaultPath)]);
  const config = emptyConfig();
  config.vaults.push({ name: 'Synthetic', path: vaultPath });
  await saveConfig(config, path.join(home, 'config.json'));

  let finishCount;
  let started;
  const countStarted = new Promise((resolve) => { started = resolve; });
  const countGate = new Promise((resolve) => { finishCount = resolve; });
  let app;
  let reader;
  try {
    app = await startSetup({
      env: { BRAINLINK_HOME: home, HOME: home }, home, os: process.platform, port: 0, useCli: false,
      countVisibleNotes: async () => { started(); return countGate; },
    });
    const response = await fetch(`http://127.0.0.1:${app.port}/api/state`, { headers: { 'X-BrainLink-Token': app.token }, signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    const initial = await response.json();
    assert.equal(initial.vaults[0].notes, null);
    assert.equal(initial.vaults[0].notes_status, 'scanning');
    await countStarted;

    const events = await fetch(`http://127.0.0.1:${app.port}/api/events?t=${encodeURIComponent(app.token)}`);
    reader = events.body.getReader();
    await reader.read(); // connected comment
    const eventRead = (async () => {
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('event: vault-counts-updated')) {
        const next = await reader.read();
        if (next.done) return text;
        text += decoder.decode(next.value, { stream: true });
      }
      return text;
    })();
    finishCount(7);
    const eventText = await Promise.race([
      eventRead,
      new Promise((_, reject) => setTimeout(() => reject(new Error('count update event timed out')), 2000)),
    ]);
    assert.match(eventText, /"vault":"Synthetic","status":"ready","notes":7/);

    const refreshed = await (await fetch(`http://127.0.0.1:${app.port}/api/state`, { headers: { 'X-BrainLink-Token': app.token } })).json();
    assert.equal(refreshed.vaults[0].notes, 7);
    assert.equal(refreshed.vaults[0].notes_status, 'ready');
  } finally {
    await reader?.cancel().catch(() => {});
    if (app) await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('lightweight vault count excludes private, generated, and excluded-folder notes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-count-visibility-'));
  const vaultPath = path.join(root, 'vault');
  await mkdir(vaultPath);
  await mkdir(path.join(vaultPath, 'Excluded'), { recursive: true });
  await mkdir(path.join(vaultPath, 'BrainLink', 'Commands'), { recursive: true });
  await writeFile(path.join(vaultPath, 'Visible.md'), '# Visible\n\nPublic note.\n');
  await writeFile(path.join(vaultPath, 'Private.md'), '---\nprivate: true\n---\nSecret.\n');
  await writeFile(path.join(vaultPath, 'Generated.md'), '---\ngenerated_by: brainlink\n---\nGenerated.\n');
  await writeFile(path.join(vaultPath, 'BrainLink', 'Commands', 'Command.md'), '# Command\n');
  await writeFile(path.join(vaultPath, 'Excluded', 'Hidden.md'), '# Hidden\n');
  await writeFile(path.join(vaultPath, '.brainlinkignore'), 'Excluded/\n');
  try {
    const config = emptyConfig();
    config.vaults.push({ name: 'Synthetic', path: vaultPath });
    const ctx = createContext(normalize(config), { env: {} });
    assert.equal(await countVisibleNotes(ctx, 'Synthetic'), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
