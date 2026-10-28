#!/usr/bin/env node
// Verify that an installed Claude Code CLI parses a BrainLink connection in an isolated profile.
// This checks config recognition only; it does not start a model conversation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectClient } from '../src/connectors.mjs';
import { normalize, saveConfig } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findClaude() {
  if (process.env.CLAUDE_BIN?.trim()) return process.env.CLAUDE_BIN.trim();
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, ['claude'], { encoding: 'utf8', windowsHide: true });
  const found = result.status === 0 ? result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : null;
  if (!found) throw new Error('Claude Code CLI was not found. Install it or set CLAUDE_BIN to its executable path.');
  if (process.platform !== 'win32') return found;
  const executable = path.join(path.dirname(found), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (!existsSync(executable)) throw new Error('Could not resolve Claude Code CLI executable. Set CLAUDE_BIN to its executable path.');
  return executable;
}

const claude = findClaude();
const tempRoot = await mkdtemp(path.join(tmpdir(), 'brainlink-claude-config-smoke-'));
const brainHome = path.join(tempRoot, 'brainlink-data');
const vault = path.join(tempRoot, 'fictional-vault');
const config = path.join(tempRoot, 'custom-config', 'config.json');
const clientConfig = path.join(tempRoot, '.claude.json');

try {
  await mkdir(vault, { recursive: true });
  await writeFile(clientConfig, '{}\n');
  await saveConfig(normalize({ vaults: [{ name: 'Fictional Claude Smoke Vault', path: vault }] }), config);

  await connectClient('claude-code', {
    home: tempRoot,
    os: process.platform,
    env: { ...process.env, HOME: tempRoot, USERPROFILE: tempRoot, BRAINLINK_HOME: brainHome, BRAINLINK_CONFIG: config },
    launch: { command: process.execPath, args: [path.join(ROOT, 'bin', 'brainlink.mjs'), 'serve'] },
    useCli: false,
  });

  const writtenConfig = await readFile(clientConfig, 'utf8');
  const parsed = JSON.parse(writtenConfig);
  assert.ok(parsed.mcpServers?.brainlink, 'BrainLink MCP entry was written to the temporary Claude profile');
  assert.equal(parsed.mcpServers.brainlink.env.BRAINLINK_HOME, brainHome);
  assert.equal(parsed.mcpServers.brainlink.env.BRAINLINK_CONFIG, config);

  const result = spawnSync(claude, ['mcp', 'list'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, HOME: tempRoot, USERPROFILE: tempRoot, APPDATA: tempRoot },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `claude mcp list failed: ${result.stderr || result.stdout}`);
  assert.match(result.stdout || '', /brainlink/i, 'Claude Code CLI should list the generated BrainLink server');

  process.stdout.write('PASS: Claude Code CLI recognized the generated BrainLink MCP entry in a temporary profile.\n');
  process.stdout.write('Scope: config recognition only; no model call or live tool invocation.\n');
  if (result.stderr?.trim()) process.stderr.write(`${result.stderr.trim()}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
