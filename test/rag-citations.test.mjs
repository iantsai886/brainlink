import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalize, saveConfig } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import { startSetup } from '../src/setup.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'brainlink.mjs');
const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-rag-s3-${p}-`));

function assertVaultRelativePath(p, vaultRoot, label) {
  assert.ok(typeof p === 'string' && p.length > 0 && p.endsWith('.md'), `${label}: missing .md path (${JSON.stringify(p)})`);
  assert.ok(!path.isAbsolute(p), `${label}: path must not be absolute (${p})`);
  assert.ok(!/^[A-Za-z]:[\\/]/.test(p), `${label}: path must not contain drive letter (${p})`);
  assert.ok(!p.startsWith('/') && !p.startsWith('\\') && !p.includes('\\'), `${label}: path must be POSIX vault-relative (${p})`);
  assert.ok(!p.includes(vaultRoot) && !p.includes(vaultRoot.replace(/\\/g, '/')), `${label}: path must not contain vault root (${p})`);
  assert.ok(!p.includes(homedir()) && !p.includes(homedir().replace(/\\/g, '/')), `${label}: path must not contain home dir (${p})`);
}

function assertNoAbsolutePathsInText(serialized, vaultRoot, label) {
  assert.ok(!serialized.includes(vaultRoot), `${label}: output leaked vaultRoot`);
  assert.ok(!serialized.includes(vaultRoot.replace(/\\/g, '/')), `${label}: output leaked POSIX vaultRoot`);
  assert.ok(!serialized.includes(homedir()), `${label}: output leaked homedir`);
  assert.ok(!/(?:^|[\s"'=([,{])[A-Za-z]:[\\/]/.test(serialized), `${label}: output leaked Windows drive-letter path`);
}

async function makeCitationVault() {
  const dir = await tmp('cite-vault');
  const home = await tmp('cite-home');
  await mkdir(path.join(dir, '20 Iango'), { recursive: true });
  await writeFile(path.join(dir, '20 Iango', 'Architecture Guide.md'), [
    '---',
    'status: active',
    'confidence: verified',
    `date: ${new Date().toISOString().slice(0, 10)}`,
    '---',
    '# Architecture Guide',
    '',
    '## Overview',
    `${'Background context describing system modules and vault layouts. '.repeat(35)}`,
    '',
    '## Retrieval Pipeline',
    'Hybrid retrieval fuses local embeddings with BM25 and wiki routing.',
    '',
    '## Open Items',
    '- **Decision needed:** Approve the local retrieval release checklist',
    '- **Next action:** Publish internal architecture notes',
  ].join('\n'));
  const cfg = normalize({
    vaults: [{ name: 'Brain', path: dir }],
    mcp: { tool_profile: 'full' },
  });
  const env = { BRAINLINK_HOME: home, BRAINLINK_SEMANTIC: '0' };
  const ctx = createContext(cfg, { env, trustedLocal: true });
  return { dir, home, cfg, env, ctx };
}

test('S3: vault_search (compact & full), vault_read_note, and context_packet cite vault-relative path without leaking absolute paths', async () => {
  const { dir, ctx } = await makeCitationVault();
  const mcp = createMcp(ctx);

  for (const detail of ['compact', 'full']) {
    const searchRes = await mcp.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'vault_search', arguments: { vault: 'Brain', query: 'Hybrid retrieval fuses local embeddings', detail } },
    });
    const rawText = searchRes.result.content[0].text;
    assertNoAbsolutePathsInText(rawText, dir, `vault_search(${detail})`);
    const searchPayload = JSON.parse(rawText);
    assert.ok(searchPayload.results.length >= 1);
    for (const r of searchPayload.results) assertVaultRelativePath(r.path, dir, `vault_search(${detail}).results`);
    for (const s of searchPayload.receipt.sources) assertVaultRelativePath(s.path, dir, `vault_search(${detail}).receipt.sources`);
    assert.equal(searchPayload.results[0].path, '20 Iango/Architecture Guide.md');
    assert.equal(searchPayload.receipt.sources[0].path, '20 Iango/Architecture Guide.md');
    assert.match(searchPayload.receipt.sources[0].heading || '', /Retrieval Pipeline/);
  }

  const readRes = await mcp.handle({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'vault_read_note', arguments: { vault: 'Brain', path: '20 Iango/Architecture Guide.md' } },
  });
  const readText = readRes.result.content[0].text;
  assertNoAbsolutePathsInText(readText, dir, 'vault_read_note');
  const readPayload = JSON.parse(readText);
  assertVaultRelativePath(readPayload.path, dir, 'vault_read_note.path');
  assert.equal(readPayload.path, '20 Iango/Architecture Guide.md');

  const packetRes = await mcp.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'context_packet', arguments: { vault: 'Brain', query: 'Hybrid retrieval fuses local embeddings' } },
  });
  const packetText = packetRes.result.content[0].text;
  assertNoAbsolutePathsInText(packetText, dir, 'context_packet');
  const packet = JSON.parse(packetText);
  for (const s of packet.sources) assertVaultRelativePath(s.path, dir, 'context_packet.sources');
  for (const s of packet.receipt.sources) assertVaultRelativePath(s.path, dir, 'context_packet.receipt.sources');
  assert.equal(packet.sources[0].path, '20 Iango/Architecture Guide.md');
  assert.equal(packet.receipt.sources[0].path, '20 Iango/Architecture Guide.md');
  assert.match(packet.receipt.sources[0].heading || '', /Retrieval Pipeline/);
});

test('S3: connector search and fetch include explicit vault and vault-relative note path without leaking absolute paths', async () => {
  const { dir, ctx } = await makeCitationVault();
  const mcp = createMcp(ctx);

  const searchRes = await mcp.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'search', arguments: { query: 'Hybrid retrieval fuses local embeddings' } },
  });
  const searchRaw = searchRes.result.content[0].text;
  assertNoAbsolutePathsInText(searchRaw, dir, 'connector search');
  const searchPayload = JSON.parse(searchRaw);
  assert.ok(searchPayload.results.length >= 1);
  assertVaultRelativePath(searchPayload.results[0].path, dir, 'connector search.path');
  assert.equal(searchPayload.results[0].id, 'Brain::20 Iango/Architecture Guide.md');
  assert.equal(searchPayload.results[0].vault, 'Brain');
  assert.equal(searchPayload.results[0].path, '20 Iango/Architecture Guide.md');
  assert.match(searchPayload.results[0].heading || '', /Retrieval Pipeline/);

  const fetchRes = await mcp.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'fetch', arguments: { id: 'Brain::20 Iango/Architecture Guide.md' } },
  });
  const fetchRaw = fetchRes.result.content[0].text;
  assertNoAbsolutePathsInText(fetchRaw, dir, 'connector fetch');
  const fetched = JSON.parse(fetchRaw);
  assertVaultRelativePath(fetched.path, dir, 'connector fetch.path');
  assert.equal(fetched.vault, 'Brain');
  assert.equal(fetched.path, '20 Iango/Architecture Guide.md');
  assert.match(fetched.text, /Hybrid retrieval fuses local embeddings/);
});

test('S3: POST /api/ask includes cited receipt and wiki_layer without leaking absolute paths', async () => {
  const { dir, home, cfg, env } = await makeCitationVault();
  await mkdir(home, { recursive: true });
  await saveConfig(cfg, path.join(home, 'config.json'));
  const setup = await startSetup({ env, home: await tmp('s3-userhome'), os: 'win32', port: 0, openUrl: null, useCli: false });
  try {
    const res = await fetch(`http://127.0.0.1:${setup.port}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': setup.token },
      body: JSON.stringify({ vault: 'Brain', query: 'Hybrid retrieval fuses local embeddings' }),
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assertNoAbsolutePathsInText(raw, dir, 'POST /api/ask');
    const body = JSON.parse(raw);
    for (const s of body.sources) assertVaultRelativePath(s.path, dir, 'POST /api/ask sources');
    for (const s of body.receipt.sources) assertVaultRelativePath(s.path, dir, 'POST /api/ask receipt.sources');
    assert.equal(body.sources[0]?.path, '20 Iango/Architecture Guide.md');
    assert.equal(body.receipt?.sources?.[0]?.path, '20 Iango/Architecture Guide.md');
    assert.equal(body.wiki_layer?.present, false);
  } finally {
    setup.server.close();
  }
});

test('S3: CLI brainlink brief cites vault-relative note paths without leaking absolute paths', async () => {
  const { dir, home, cfg, env } = await makeCitationVault();
  await mkdir(home, { recursive: true });
  await saveConfig(cfg, path.join(home, 'config.json'));
  const { stdout } = await execFileAsync(process.execPath, [CLI, 'brief', '--vault', 'Brain', '--days', '7'], {
    env: { ...process.env, ...env },
  });
  assertNoAbsolutePathsInText(stdout, dir, 'CLI brainlink brief');
  assert.match(stdout, /20 Iango\/Architecture Guide\.md/);
});
