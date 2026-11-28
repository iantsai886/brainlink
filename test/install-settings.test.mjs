import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHomeVars, installSettings } from '../scripts/install-settings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('installSettings defaults to dry-run, expands $HOME/%USERPROFILE%, backs up, and merges additively without clobbering user keys', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainlink-install-'));
  const fakeHome = path.join(dir, 'home');
  const target = path.join(dir, 'mcp_config.json');

  const preExisting = {
    customUserSetting: { theme: 'dark', keepMe: true },
    mcpServers: {
      otherTool: { command: 'other-bin', args: ['--serve'] },
      brainlink: { command: 'old-node', args: ['old.mjs'], env: { BRAINLINK_AGENT_TOKEN: 'keep-existing-token-123456' } },
    },
    hooks: {
      SessionEnd: [{ command: 'user-custom-hook' }],
    },
  };
  await writeFile(target, JSON.stringify(preExisting, null, 2) + '\n', 'utf8');

  const incoming = {
    customUserSetting: { theme: 'should-not-overwrite' },
    mcpServers: {
      otherTool: { command: 'should-not-clobber' },
      brainlink: {
        command: '$HOME/bin/node',
        args: ['%USERPROFILE%/brainlink/bin/brainlink.mjs', 'serve'],
        env: { BRAINLINK_HOME: '$HOME/.brainlink' },
      },
    },
    hooks: {
      SessionEnd: [{ command: 'brainlink session-end-cue' }],
    },
  };

  // 1. Dry-run by default: writes nothing, creates no backup
  const dry = await installSettings({ targetPath: target, incoming, home: fakeHome });
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.backup, null);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), preExisting);
  assert.equal((await readdir(dir)).length, 1);

  // 2. Apply mode: creates timestamped backup, expands $HOME/%USERPROFILE%, merges additively
  const applied = await installSettings({ targetPath: target, incoming, apply: true, home: fakeHome });
  assert.equal(applied.mode, 'applied');
  assert.ok(applied.backup && applied.backup.includes('.brainlink-backup-'));
  assert.deepEqual(JSON.parse(await readFile(applied.backup, 'utf8')), preExisting);

  const written = JSON.parse(await readFile(target, 'utf8'));
  // Pre-existing user keys & other MCP servers untouched
  assert.deepEqual(written.customUserSetting, preExisting.customUserSetting);
  assert.deepEqual(written.mcpServers.otherTool, preExisting.mcpServers.otherTool);
  // Existing non-empty BRAINLINK_AGENT_TOKEN preserved!
  assert.equal(written.mcpServers.brainlink.env.BRAINLINK_AGENT_TOKEN, 'keep-existing-token-123456');
  // $HOME and %USERPROFILE% expanded safely
  assert.equal(written.mcpServers.brainlink.command, `${fakeHome}/bin/node`);
  assert.equal(written.mcpServers.brainlink.args[0], `${fakeHome}/brainlink/bin/brainlink.mjs`);
  assert.equal(written.mcpServers.brainlink.env.BRAINLINK_HOME, `${fakeHome}/.brainlink`);
  // Hooks merged additively
  assert.equal(written.hooks.SessionEnd.length, 2);

  // Direct expandHomeVars unit check
  assert.equal(expandHomeVars('$HOME/a', '/u/me'), '/u/me/a');
  assert.equal(expandHomeVars('%USERPROFILE%\\b', 'C:\\Users\\me'), 'C:\\Users\\me\\b');
});

test('INSTALL.md documents consent prompts, capability opt-in, brainlink doctor, and SYSTEM vs USER boundary', async () => {
  const md = await readFile(path.join(ROOT, 'INSTALL.md'), 'utf8');
  assert.match(md, /Read INSTALL\.md and install BrainLink for me/);
  assert.match(md, /SYSTEM/);
  assert.match(md, /USER/);
  assert.match(md, /now.*later.*decline/i);
  assert.match(md, /brainlink doctor/);
  assert.match(md, /--apply/);
});
