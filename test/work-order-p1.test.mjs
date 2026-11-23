import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSetup } from '../src/setup.mjs';

async function filesUnder(root, relative = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const rel = path.posix.join(relative.replace(/\\/g, '/'), entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(root, rel));
    else result.push([rel, await readFile(path.join(root, rel), 'utf8')]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}

test('existing-vault adoption previews choices and creates no files or exposes private/excluded paths', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'bl-adopt-existing-'));
  const vault = path.join(home, 'Existing');
  await mkdir(path.join(vault, 'Knowledge', 'Handoffs'), { recursive: true });
  await mkdir(path.join(vault, 'Office'), { recursive: true });
  await mkdir(path.join(vault, 'Excluded'), { recursive: true });
  await writeFile(path.join(vault, '.brainlinkignore'), 'Excluded/\n');
  await writeFile(path.join(vault, 'AGENTS.md'), '# Fictional rules\n');
  await writeFile(path.join(vault, 'Office/Role.md'), '# Fictional role\n');
  await writeFile(path.join(vault, 'Office/Captures.md'), '# Fictional captures\n');
  await writeFile(path.join(vault, 'Knowledge/Index.md'), '# Fictional knowledge\n');
  await writeFile(path.join(vault, 'Knowledge/Handoffs/README.md'), '# Fictional mailbox\n');
  await writeFile(path.join(vault, 'Secret.md'), '---\nprivate: true\n---\nPRIVATE_ADOPTION_CANARY');
  await writeFile(path.join(vault, 'Excluded/Hidden.md'), 'EXCLUDED_ADOPTION_CANARY');
  const before = await filesUnder(vault);
  const app = await startSetup({ env: { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' }, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${app.port}`;
  const api = async (route, body) => fetch(base + route, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.json());
  try {
    const structure = await api('/api/vault/inspect', { path: vault });
    assert.equal(structure.existing, true);
    assert.ok(structure.notes.some((note) => note.path === 'Office/Role.md'));
    assert.doesNotMatch(JSON.stringify(structure), /PRIVATE_ADOPTION_CANARY|Secret\.md|Excluded|EXCLUDED_ADOPTION_CANARY/);
    const refused = await api('/api/vault', { path: vault, name: 'Fictional', pack: 'simple', adoptExisting: true, scaffold: false });
    assert.match(refused.error, /Preview the existing-vault configuration/);
    const added = await api('/api/vault', {
      path: vault, name: 'Fictional', pack: 'simple', agentName: 'Fixture Agent', adoptExisting: true, reviewed: true, scaffold: false,
      intakeFolder: 'Knowledge', readFirst: ['AGENTS.md'], roleNotes: ['Office/Role.md'], closeTarget: 'Office/Captures.md', mailboxFolder: 'Knowledge/Handoffs', moveHandoff: false,
    });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.deepEqual(await filesUnder(vault), before, 'adoption does not scaffold, rewrite ignore rules, or change notes');
    const config = JSON.parse(await readFile(path.join(home, 'app', 'config.json'), 'utf8'));
    assert.equal(config.vaults.find((item) => item.name === 'Fictional').intake_folder, 'Knowledge');
    assert.deepEqual(config.vaults.find((item) => item.name === 'Fictional').read_first, ['AGENTS.md']);
    assert.deepEqual(config.agents.find((item) => item.name === 'Fixture Agent').connect_notes, ['Office/Role.md']);
    assert.deepEqual(config.agents.find((item) => item.name === 'Fixture Agent').close_target, { mode: 'append-section', path: 'Office/Captures.md' });
    assert.deepEqual(config.handoff, { vault: 'Fictional', folder: 'Knowledge/Handoffs' });
  } finally { app.server.close(); }
});

test('mailbox changes require a preview, warn for private vaults and only move the active setting', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'bl-mailbox-setting-'));
  const vault = path.join(home, 'Private');
  await mkdir(path.join(vault, 'Existing Mailbox'), { recursive: true });
  await writeFile(path.join(vault, 'Existing Mailbox/Message.md'), '# Fixture handoff\n');
  const app = await startSetup({ env: { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' }, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${app.port}`;
  const api = async (route, body) => fetch(base + route, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.json());
  try {
    const added = await api('/api/vault', { path: vault, name: 'Private Fixture', pack: 'private-journal', private: true, scaffold: false });
    assert.equal(added.ok, true, JSON.stringify(added));
    const before = await filesUnder(vault);
    const preview = await api('/api/handoff-mailbox/preview', { vault: 'Private Fixture', folder: 'Existing Mailbox' });
    assert.equal(preview.private_vault, true);
    assert.equal(preview.existing_files_stay_in_place, true);
    assert.equal(preview.from, null);
    const unconfirmed = await api('/api/handoff-mailbox/confirm', { id: preview.id, confirm: false });
    assert.match(unconfirmed.error, /Review the mailbox change preview/);
    const saved = await api('/api/handoff-mailbox/confirm', { id: preview.id, confirm: true });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.deepEqual(saved.handoff, { vault: 'Private Fixture', folder: 'Existing Mailbox' });
    assert.equal(saved.private_vault, true);
    assert.deepEqual(await filesUnder(vault), before, 'moving the active mailbox setting does not relocate or edit files');
    const config = JSON.parse(await readFile(path.join(home, 'app', 'config.json'), 'utf8'));
    assert.deepEqual(config.handoff, saved.handoff);
    const refused = await api('/api/handoff-mailbox/preview', { vault: 'Private Fixture', folder: 'missing' });
    assert.match(refused.error, /existing, non-excluded mailbox folder/);
  } finally { app.server.close(); }
});
