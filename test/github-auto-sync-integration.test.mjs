// Full scheduled flow against a temporary local bare Git remote. The fixture has a GitHub-shaped
// identity for BrainLink validation, but Git redirects every network operation to the local disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalize, saveConfig } from '../src/config.mjs';
import { startSetup } from '../src/setup.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const run = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', windowsHide: true });
const canary = 'PRIVATE_REMOTE_CANARY_7912';
async function removeTempTree(root) {
  for (let attempt = 0; ; attempt++) {
    try { await rm(root, { recursive: true, force: true }); return; }
    catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt >= 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

test('scheduled GitHub sync fetches, filters, imports and publishes through a local-only remote', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-auto-gh-e2e-'));
  const bare = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  const vault = path.join(root, 'vault');
  const home = path.join(root, 'app-home');
  let app;
  try {
    await mkdir(bare, { recursive: true });
    await mkdir(seed, { recursive: true });
    await mkdir(path.join(vault, 'Shared'), { recursive: true });
    await mkdir(path.join(vault, 'Outside'), { recursive: true });
    await mkdir(path.join(vault, 'Private'), { recursive: true });
    await writeFile(path.join(vault, 'Shared', 'local.md'), '---\ntitle: Local shared note\n---\nPUBLIC_LOCAL_NOTE_8210\n');
    await writeFile(path.join(vault, 'Outside', 'not-allowed.md'), 'OUTSIDE_SCOPE_CANARY_9942\n');
    await writeFile(path.join(vault, 'Private', 'private.md'), `---\ntitle: Private note\nprivate: true\n---\n${canary}\n`);

    run(root, 'init', '--bare', '--initial-branch=main', bare);
    run(seed, 'init', '--initial-branch=main');
    git(seed, 'config', 'user.name', 'BrainLink Test');
    git(seed, 'config', 'user.email', 'brainlink-test@example.invalid');
    await mkdir(path.join(seed, 'BrainLink', 'notes', 'Shared'), { recursive: true });
    await mkdir(path.join(seed, 'BrainLink', 'notes', 'Outside'), { recursive: true });
    await writeFile(path.join(seed, 'BrainLink', 'notes', 'Shared', 'remote.md'), '---\ntitle: Remote shared note\n---\nPUBLIC_REMOTE_NOTE_1011\n');
    await writeFile(path.join(seed, 'BrainLink', 'notes', 'Shared', 'private.md'), `---\ntitle: Private remote note\nprivate: true\n---\n${canary}\n`);
    await writeFile(path.join(seed, 'BrainLink', 'notes', 'Outside', 'remote.md'), 'OUTSIDE_REMOTE_CANARY_1552\n');
    await writeFile(path.join(seed, 'README.md'), 'fictional local fixture\n');
    git(seed, 'add', '.'); git(seed, 'commit', '-m', 'fixture');
    run(seed, 'remote', 'add', 'origin', bare); run(seed, 'push', '-u', 'origin', 'main');
    run(root, 'clone', bare, clone);
    git(clone, 'config', 'user.name', 'BrainLink Test');
    git(clone, 'config', 'user.email', 'brainlink-test@example.invalid');
    git(clone, 'remote', 'set-url', 'origin', 'https://github.com/fictional-brainlink/second-brain.git');
    git(clone, 'config', '--local', `url.${pathToFileURL(bare).href}.insteadOf`, 'https://github.com/fictional-brainlink/second-brain.git');

    await mkdir(home, { recursive: true });
    const profile = {
      id: 'personal_fixture', name: 'Fictional Personal Twin', mode: 'personal', owner: 'Fixture user',
      vaults: [{ name: 'Fixture Vault', access: 'read' }],
      source_policy: { private_default: true, provenance_required: true, session_capture: 'metadata-only' },
      memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
      allowed_actions: [], agent_access: [],
      github_repository: {
        remote: 'fictional-brainlink/second-brain', path: clone, vault: 'Fixture Vault', folders: ['Shared'],
        whole_vault: false, confirmed_at: new Date().toISOString(),
        automatic_sync: { enabled: true, intervalHours: 1, confirmed_at: new Date().toISOString() },
      },
    };
    const cfg = normalize({
      version: 2,
      vaults: [{ name: 'Fixture Vault', path: vault }],
      twin_profiles: [profile],
    });
    await saveConfig(cfg, path.join(home, 'config.json'));
    app = await startSetup({ env: { BRAINLINK_HOME: home, HOME: home, BRAINLINK_SEMANTIC: '0' }, home, os: 'linux', useCli: false, githubAutoTickMs: 15 });

    let receipt;
    // Git setup and scheduled sync can be slow under the serialized full suite on Windows.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const response = await fetch(`http://127.0.0.1:${app.port}/api/state`, { headers: { 'X-BrainLink-Token': app.token } });
      const state = await response.json();
      receipt = state.github_auto_sync?.personal_fixture;
      if (receipt && !receipt.running) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(receipt && !receipt.running, 'the scheduled run should write a finished receipt');
    assert.equal(receipt.ok, true, receipt.error || 'scheduled run failed');
    assert.equal(receipt.trigger, 'schedule');
    assert.equal(receipt.pulled, 1);
    assert.equal(receipt.pushed, 1);
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(canary));
    assert.doesNotMatch(JSON.stringify(receipt), /OUTSIDE_(?:SCOPE|REMOTE)_CANARY/);
    assert.equal(await readFile(path.join(vault, 'Shared', 'remote.md'), 'utf8'), '---\ntitle: Remote shared note\n---\nPUBLIC_REMOTE_NOTE_1011\n');
    assert.match(await readFile(path.join(vault, 'Private', 'private.md'), 'utf8'), new RegExp(canary));
    assert.match(await readFile(path.join(vault, 'Outside', 'not-allowed.md'), 'utf8'), /OUTSIDE_SCOPE_CANARY_9942/);
    assert.equal(git(bare, 'show', 'main:BrainLink/notes/Shared/local.md'), '---\ntitle: Local shared note\n---\nPUBLIC_LOCAL_NOTE_8210');
    await assert.rejects(readFile(path.join(vault, 'Outside', 'remote.md')), { code: 'ENOENT' }, 'remote notes outside the approved folder must not enter the vault');
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    await removeTempTree(root);
  }
});
