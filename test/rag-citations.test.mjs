import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

test('S3: vault_search and context_packet cite vault-relative path and heading on results and receipt.sources', async () => {
  const { ctx } = await makeCitationVault();
  const mcp = createMcp(ctx);

  const searchRes = await mcp.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'vault_search', arguments: { vault: 'Brain', query: 'Hybrid retrieval fuses local embeddings' } },
  });
  const searchPayload = JSON.parse(searchRes.result.content[0].text);
  assert.ok(searchPayload.results.length >= 1);
  for (const r of searchPayload.results) {
    assert.ok(typeof r.path === 'string' && r.path.endsWith('.md'), `missing path: ${JSON.stringify(r)}`);
  }
  assert.equal(searchPayload.results[0].path, '20 Iango/Architecture Guide.md');
  assert.equal(searchPayload.receipt.sources[0].path, '20 Iango/Architecture Guide.md');
  assert.match(searchPayload.receipt.sources[0].heading || '', /Retrieval Pipeline/);

  const packetRes = await mcp.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'context_packet', arguments: { vault: 'Brain', query: 'Hybrid retrieval fuses local embeddings' } },
  });
  const packet = JSON.parse(packetRes.result.content[0].text);
  assert.equal(packet.sources[0].path, '20 Iango/Architecture Guide.md');
  assert.equal(packet.receipt.sources[0].path, '20 Iango/Architecture Guide.md');
  assert.match(packet.receipt.sources[0].heading || '', /Retrieval Pipeline/);
});

test('S3: connector search and fetch include explicit vault and note path alongside id and url', async () => {
  const { ctx } = await makeCitationVault();
  const mcp = createMcp(ctx);

  const searchRes = await mcp.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'search', arguments: { query: 'Hybrid retrieval fuses local embeddings' } },
  });
  const searchPayload = JSON.parse(searchRes.result.content[0].text);
  assert.ok(searchPayload.results.length >= 1);
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
  const fetched = JSON.parse(fetchRes.result.content[0].text);
  assert.equal(fetched.vault, 'Brain');
  assert.equal(fetched.path, '20 Iango/Architecture Guide.md');
  assert.match(fetched.text, /Hybrid retrieval fuses local embeddings/);
});

test('S3: POST /api/ask includes cited receipt and wiki_layer alongside sources[].path', async () => {
  const { home, cfg, env } = await makeCitationVault();
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
    const body = await res.json();
    assert.equal(body.sources[0]?.path, '20 Iango/Architecture Guide.md');
    assert.equal(body.receipt?.sources?.[0]?.path, '20 Iango/Architecture Guide.md');
    assert.equal(body.wiki_layer?.present, false);
  } finally {
    setup.server.close();
  }
});

test('S3: CLI brainlink brief cites vault-relative note paths for changed notes and open loops', async () => {
  const { home, cfg, env } = await makeCitationVault();
  await mkdir(home, { recursive: true });
  await saveConfig(cfg, path.join(home, 'config.json'));
  const { stdout } = await execFileAsync(process.execPath, [CLI, 'brief', '--vault', 'Brain', '--days', '7'], {
    env: { ...process.env, ...env },
  });
  assert.match(stdout, /20 Iango\/Architecture Guide\.md/);
});
