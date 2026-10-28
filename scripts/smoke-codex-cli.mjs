#!/usr/bin/env node
// Verify that an installed Codex CLI parses a BrainLink connection in an isolated profile.
// This checks config recognition only; it does not start a model conversation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectClient } from '../src/connectors.mjs';
import { normalize, saveConfig } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findCodex() {
  if (process.env.CODEX_BIN?.trim()) return process.env.CODEX_BIN.trim();
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, ['codex'], { encoding: 'utf8', windowsHide: true });
  const found = result.status === 0 ? result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : null;
  if (!found) throw new Error('Codex CLI was not found. Install it or set CODEX_BIN to its executable path.');
  return found;
}

const codex = findCodex();
const tempRoot = await mkdtemp(path.join(tmpdir(), 'brainlink-codex-config-smoke-'));
const codexHome = path.join(tempRoot, '.codex');
const brainHome = path.join(tempRoot, 'brainlink-data');
const vault = path.join(tempRoot, 'fictional-vault');
const config = path.join(tempRoot, 'custom-config', 'config.json');
const clientConfig = path.join(codexHome, 'config.toml');

try {
  await mkdir(codexHome, { recursive: true });
  await mkdir(vault, { recursive: true });
  await writeFile(clientConfig, 'model = "fictional-smoke-profile"\n');
  await saveConfig(normalize({ vaults: [{ name: 'Fictional Codex Smoke Vault', path: vault }] }), config);

  await connectClient('codex', {
    home: tempRoot,
    os: process.platform,
    env: { ...process.env, CODEX_HOME: codexHome, BRAINLINK_HOME: brainHome, BRAINLINK_CONFIG: config },
    launch: { command: process.execPath, args: [path.join(ROOT, 'bin', 'brainlink.mjs'), 'serve'] },
    useCli: false,
  });

  const writtenConfig = await readFile(clientConfig, 'utf8');
  assert.ok(writtenConfig.includes(`BRAINLINK_HOME = ${JSON.stringify(brainHome)}`));
  assert.ok(writtenConfig.includes(`BRAINLINK_CONFIG = ${JSON.stringify(config)}`));

  const result = spawnSync(codex, ['mcp', 'list'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHome, HOME: tempRoot },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `codex mcp list failed: ${result.stderr || result.stdout}`);
  assert.match(result.stdout || '', /brainlink/i, 'Codex CLI should list the generated BrainLink server');
  assert.match(result.stdout || '', /enabled/i, 'Codex CLI should report the BrainLink entry as enabled');

  process.stdout.write('PASS: Codex CLI recognized the generated BrainLink MCP entry in a temporary profile.\n');
  if (result.stdout?.trim()) process.stdout.write(`${result.stdout.trim()}\n`);
  process.stdout.write('Scope: config recognition only; no model call or live tool invocation.\n');
  if (result.stderr?.trim()) process.stderr.write(`${result.stderr.trim()}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
