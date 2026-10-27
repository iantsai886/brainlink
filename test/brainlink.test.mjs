import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, cp, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalize, validate, saveConfig } from '../src/config.mjs';
import { tokens, extractLinks, linkGraph } from '../src/graph.mjs';
import { createContext, chunkMarkdown, search, readNote, related, zonedNow, findSecrets, DEFAULT_EXCLUDED_FOLDERS, SUGGESTED_EXCLUDED_FOLDERS, ensureDefaultIgnore, readExcludedFolders, writeExcludedFolders, parseFrontmatter, isPrivateMeta, fmSaysPrivate, loadVault, indexableHeader } from '../src/core.mjs';
import { findObsidianVaults, nestedVaults } from '../src/obsidian.mjs';
import { proposeNote, sendHandoff, listHandoffs, frontmatter, resolveIdentity } from '../src/writes.mjs';
import { connectAgent, closeLoop, resolveAgent, latestCaptures } from '../src/agents.mjs';
import { createMcp, serveHttp, VERSION } from '../src/server.mjs';
import { buildPack, scaffold, mergePack } from '../src/packs.mjs';
import { connectClient, disconnectClient, detect, codexToml, readClientAgentToken } from '../src/connectors.mjs';
import { startSetup } from '../src/setup.mjs';
import { ingestionQueue, recordIngestion } from '../src/ingestion.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = path.join(ROOT, 'samples', 'acme-studio');
const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-${p}-`));
const NOW = new Date('2026-10-18T01:30:00Z');
test('runtime version comes from the canonical package manifest', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(VERSION, pkg.version);
});
test('pre-release installer notice matches the full, non-expiring build', async () => {
  const notice = await readFile(path.join(ROOT, 'LICENSE.txt'), 'utf8');
  const macNotice = await readFile(path.join(ROOT, 'packaging', 'macos', 'resources', 'license.txt'), 'utf8');
  assert.equal(macNotice.trim(), notice.trim());
  assert.match(notice, /all implemented product features enabled/i);
  assert.match(notice, /no trial timer,\s*feature expiry,\s*licence-key requirement, or account check/i);
  assert.doesNotMatch(notice, /14-day trial|limited features|circumvent the licence check/i);
});

test('customer one-pager does not advertise a trial or feature limit', async () => {
  const page = await readFile(path.join(ROOT, 'docs', 'one-pager.html'), 'utf8');
  assert.match(page, /available without a countdown, licence key, or account/i);
  assert.doesNotMatch(page, /14.day trial|first 14 days|free trial|trial ended/i);
});
const long = Array.from({ length: 300 }, (_, i) => `filler${i}`).join(' ');

// Company vault = copy of the sample with the Founder OS pack; private vault = journal pack.
async function fixture() {
  const base = await tmp('vaults');
  const company = path.join(base, 'Acme Studio'), journal = path.join(base, 'Journal');
  await cp(SAMPLE, company, { recursive: true });
  await mkdir(journal);
  await writeFile(path.join(company, 'Agent Memory.md'), `---\nstatus: active\n---\n# Agent Memory\n\n## Retrieval\n\nHybrid retrieval with reranking for agent memory.\n\n## Storage\n\n${long}\n\nSee [[Home]].`);
  await writeFile(path.join(company, 'Old Memory.md'), '---\nsuperseded_by: "[[Agent Memory]]"\n---\nagent memory retrieval reranking');
  await writeFile(path.join(journal, 'diary.md'), 'private diary about pricing and agent memory');
  let cfg = normalize({ timezone: 'Asia/Taipei' });
  const f = buildPack('founder-os', { vaultName: 'Acme Studio', vaultPath: company, agentName: 'Chief of Staff' });
  await scaffold(company, f.scaffold);
  cfg = mergePack(cfg, f);
  const j = buildPack('private-journal', { vaultName: 'Journal', vaultPath: journal, agentName: 'Journal' });
  await scaffold(journal, j.scaffold);
  cfg = normalize(mergePack(cfg, j));
  // mergePack keeps the company handoff when adding a vault without one.
  return { base, company, journal, cfg };
}

// Tests never touch the real app folder or a local Ollama.
process.env.BRAINLINK_SEMANTIC = '0';
const TEST_HOME = await mkdtemp(path.join(tmpdir(), 'brainlink-apphome-'));
const ctxOf = (cfg, env = {}) => createContext(cfg, { env: { BRAINLINK_AI_PLATFORM: 'Claude', BRAINLINK_HOME: TEST_HOME, BRAINLINK_SEMANTIC: '0', ...env } });

// ---- graph & retrieval ----

test('tokens: Latin words, stopwords dropped, CJK bigrams', () => {
  const t = tokens('The agent memory 知識管理 and retrieval');
  assert.ok(t.includes('agent') && t.includes('retrieval') && !t.includes('the') && !t.includes('and'));
  assert.ok(t.includes('知識') && t.includes('識管') && t.includes('管理'));
});

test('links: wikilinks, embeds, md links; code ignored; graph resolves by title and relative path', () => {
  const links = extractLinks('[[A|alias]] ![[B#h]] [c](sub/C.md) `[[No]]`\n```\n[[NoFence]]\n```\n[x](https://e.com/x.md)');
  assert.deepEqual(links, ['A', 'B', 'sub/C.md']);
  const notes = [{ rel: 'A.md', title: 'A', raw: '[[B]] [c](sub/C.md) [[A]]' }, { rel: 'dir/B.md', title: 'B', raw: '[[Missing]]' }, { rel: 'sub/C.md', title: 'C', raw: '[[dir/B]]' }];
  const g = linkGraph(notes);
  assert.deepEqual(g.edges, [[0, 1], [0, 2], [2, 1]]);
  assert.deepEqual(g.broken, [{ from: 1, target: 'Missing' }]);
});

test('chunks carry heading ancestry and respect the word cap', () => {
  const chunks = chunkMarkdown(`# A\n\n## B\n\nshort\n\n## C\n\n${long}`);
  assert.ok(chunks.some((c) => c.heading === 'A › B' && c.text.includes('short')));
  assert.ok(chunks.filter((c) => c.heading === 'A › C').length >= 2);
  assert.ok(chunks.every((c) => c.text.split(/\s+/).length <= 256));
});

test('search ranks the relevant note first and demotes superseded notes', async () => {
  const { cfg } = await fixture();
  const ctx = ctxOf(cfg);
  const r = await search(ctx, 'Acme Studio', 'agent memory reranking');
  assert.equal(r[0].path, 'Agent Memory.md');
  const old = r.find((x) => x.path === 'Old Memory.md');
  assert.ok(old.historical && old.superseded_by);
  const p = await search(ctx, 'Acme Studio', 'care plan pricing');
  assert.equal(p[0].path, 'Pricing and Packages.md');
  assert.ok(p.findIndex((x) => x.path.startsWith('SUPERSEDED')) > 0);
});

test('[[mentions]] are returned first in full', async () => {
  const { cfg } = await fixture();
  const r = await search(ctxOf(cfg), 'Acme Studio', 'what about [[Northwind Coffee]] subscriptions');
  assert.equal(r[0].match, 'mention');
  assert.equal(r[0].path, 'Clients/Northwind Coffee.md');
});

test('related: links both ways plus unlinked suggestions', async () => {
  const { cfg } = await fixture();
  const r = await related(ctxOf(cfg), 'Acme Studio', 'Clients/Northwind Coffee.md');
  assert.ok(r.links_to.some((x) => x.path === 'Pricing and Packages.md'));
  assert.ok(r.linked_from.some((x) => x.path === 'Home.md'));
  assert.ok(Array.isArray(r.suggested));
});

test('reads are confined to the vault and to Markdown', async () => {
  const { cfg } = await fixture();
  const ctx = ctxOf(cfg);
  await assert.rejects(readNote(ctx, 'Acme Studio', '../Journal/diary.md'), /escapes/);
  await assert.rejects(readNote(ctx, 'Acme Studio', 'AGENTS'), /Markdown/);
  assert.match((await readNote(ctx, 'Acme Studio', 'Home.md')).body, /Acme Studio/);
});

test('readNote refuses private notes and notes in an excluded folder, everywhere it is called', async () => {
  const { cfg, company } = await fixture();
  await writeFile(path.join(company, 'Secret Plan.md'), '---\nprivate: true\n---\n# Secret Plan\n\nAcquire Globex quietly.');
  await mkdir(path.join(company, '00 Home'), { recursive: true });
  await writeFile(path.join(company, '00 Home', 'Diary.md'), '# Diary\n\nvery personal notes');
  await writeFile(path.join(company, '.brainlinkignore'), '00 Home/\n');
  const ctx = ctxOf(cfg);
  // vault_read_note (MCP tool)
  const mcp = createMcp(ctx);
  const privTool = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vault_read_note', arguments: { vault: 'Acme Studio', path: 'Secret Plan.md' } } });
  assert.equal(privTool.result.isError, true);
  assert.match(privTool.result.content[0].text, /private/i);
  assert.ok(!JSON.stringify(privTool.result).includes('Globex'));
  const exclTool = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vault_read_note', arguments: { vault: 'Acme Studio', path: '00 Home/Diary.md' } } });
  assert.equal(exclTool.result.isError, true);
  assert.match(exclTool.result.content[0].text, /private/i);
  // connector fetch tool
  const fetchPriv = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fetch', arguments: { id: 'Acme Studio::Secret Plan.md' } } });
  assert.equal(fetchPriv.result.isError, true);
  assert.match(fetchPriv.result.content[0].text, /private/i);
  const fetchExcl = await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fetch', arguments: { id: 'Acme Studio::00 Home/Diary.md' } } });
  assert.equal(fetchExcl.result.isError, true);
  assert.match(fetchExcl.result.content[0].text, /private/i);
  // readNote itself (used directly by /api/note)
  await assert.rejects(readNote(ctx, 'Acme Studio', 'Secret Plan.md'), /private/i);
  await assert.rejects(readNote(ctx, 'Acme Studio', '00 Home/Diary.md'), /private/i);
});

test('ingestion queue scans only a chosen folder and filters private, excluded, generated and malformed sources', async () => {
  const { base, company, cfg } = await fixture();
  const raw = path.join(company, 'Raw');
  await mkdir(path.join(raw, 'Blocked'), { recursive: true });
  await writeFile(path.join(raw, '.brainlinkignore'), 'Blocked/\n');
  await writeFile(path.join(raw, 'Public.md'), '# Public source\n\nReusable project facts.');
  await writeFile(path.join(raw, 'Private.md'), '---\nprivate: true\n---\n# PRIVATE_CANARY_DO_NOT_READ\nsecret body');
  await writeFile(path.join(raw, 'Malformed.md'), '---\nprivate: true\n# malformed and unsafe\nPRIVATE_MALFORMED_CANARY');
  await writeFile(path.join(raw, 'Generated.md'), '---\ngenerated_by: brainlink\n---\n# generated');
  await writeFile(path.join(raw, 'Blocked', 'Excluded.md'), '# EXCLUDED_CANARY');
  const env = { BRAINLINK_HOME: path.join(base, 'app') };
  const queue = await ingestionQueue(ctxOf(cfg, env), 'Acme Studio', 'Raw');
  assert.deepEqual(queue.candidates.map((x) => x.path), ['Raw/Public.md']);
  assert.equal(queue.candidates[0].title, 'Public');
  assert.equal(JSON.stringify(queue).includes('Reusable project facts'), false);
  assert.equal(JSON.stringify(queue).includes('PRIVATE_CANARY_DO_NOT_READ'), false);
  assert.equal(JSON.stringify(queue).includes('EXCLUDED_CANARY'), false);
  assert.equal(JSON.stringify(queue).includes('PRIVATE_MALFORMED_CANARY'), false);
  assert.ok(indexableHeader('---\nprivate: true\n---\n# private', 30) === false);
  await assert.rejects(ingestionQueue(ctxOf(cfg, env), 'Acme Studio', '../Raw'), /folder/i);
  await assert.rejects(ingestionQueue(ctxOf(cfg, env), 'Journal', 'Raw'), /private vault/i);
});

test('ingestion receipts are local and content-free; changed sources return to the queue', async () => {
  const { base, company, cfg } = await fixture();
  const raw = path.join(company, 'Raw');
  await mkdir(raw);
  await writeFile(path.join(raw, 'Source.md'), '# Source\n\nFIRST_SOURCE_CANARY');
  const env = { BRAINLINK_HOME: path.join(base, 'app') };
  const ctx = ctxOf(cfg, env);
  const first = await ingestionQueue(ctx, 'Acme Studio', 'Raw');
  const item = first.candidates[0];
  assert.ok(item);
  const recorded = await recordIngestion(ctx, 'Acme Studio', 'Raw', { ...item, outcome: 'skipped' });
  assert.equal(recorded.recorded, true);
  assert.equal((await ingestionQueue(ctx, 'Acme Studio', 'Raw')).candidates.length, 0);
  await writeFile(path.join(raw, 'Source.md'), '# Source\n\nSECOND_SOURCE_CANARY');
  const changed = await ingestionQueue(ctx, 'Acme Studio', 'Raw');
  assert.equal(changed.candidates.length, 1);
  assert.notEqual(changed.candidates[0].revision, item.revision);
  const [journalName] = await readdir(path.join(env.BRAINLINK_HOME, 'ingestion'));
  const journal = await readFile(path.join(env.BRAINLINK_HOME, 'ingestion', journalName), 'utf8');
  assert.equal(journal.includes('FIRST_SOURCE_CANARY'), false);
  assert.equal(journal.includes('Raw/Source.md'), false);
});

test('filed ingestion requires a saved linked knowledge note and refuses a stale source revision', async () => {
  const { base, company, cfg } = await fixture();
  const raw = path.join(company, 'Raw');
  const wiki = path.join(company, 'Wiki');
  await mkdir(raw); await mkdir(wiki);
  await writeFile(path.join(raw, 'Source.md'), '# Source\n\nFacts to organize.');
  await writeFile(path.join(wiki, 'Knowledge.md'), '---\ntype: note\nstatus: proposed\nai_platform: ChatGPT Codex\nsession_or_task_id: test\n---\n# Knowledge\n\nSummary from [[Raw/Source]].');
  const ctx = ctxOf(cfg, { BRAINLINK_HOME: path.join(base, 'app') });
  const item = (await ingestionQueue(ctx, 'Acme Studio', 'Raw')).candidates[0];
  await assert.rejects(recordIngestion(ctx, 'Acme Studio', 'Raw', { ...item, outcome: 'filed', knowledge_path: 'Raw/Source.md' }), /outside the selected Raw folder/i);
  await assert.rejects(recordIngestion(ctx, 'Acme Studio', 'Raw', { ...item, outcome: 'filed', knowledge_path: 'Wiki/Unlinked.md' }), /ENOENT|no such file/i);
  const result = await recordIngestion(ctx, 'Acme Studio', 'Raw', { ...item, outcome: 'filed', knowledge_path: 'Wiki/Knowledge.md' });
  assert.equal(result.recorded, true);
  assert.equal((await ingestionQueue(ctx, 'Acme Studio', 'Raw')).candidates.length, 0);
  await writeFile(path.join(raw, 'Source.md'), '# Source\n\nChanged after review.');
  await assert.rejects(recordIngestion(ctx, 'Acme Studio', 'Raw', { ...item, outcome: 'skipped' }), /changed|Refresh/i);
});

test('ingestion MCP tools are exposed with explicit folder and review instructions', () => {
  const mcp = createMcp(ctxOf(normalize({})));
  const names = mcp.tools.map((t) => t.name);
  assert.ok(names.includes('ingestion_queue'));
  assert.ok(names.includes('ingestion_record'));
  assert.match(mcp.instructions, /daily schedule while BrainLink is running/i);
  assert.match(mcp.instructions, /do not ask an AI to read, summarize, or file notes/i);
  assert.match(mcp.instructions, /never scan the whole vault/i);
  const queue = mcp.tools.find((tool) => tool.name === 'ingestion_queue');
  assert.match(queue.description, /does not read source bodies/i);
  assert.match(queue.description, /does not .* change the Setup background-scan schedule/i);
});

test('parseFrontmatter: a leading UTF-8 BOM or blank lines before --- still detect private: true', () => {
  const bom = '﻿---\nprivate: true\n---\n# Secret\n\nbody text';
  const blank = '\n\n---\nprivate: true\n---\n# Secret\n\nbody text';
  const both = '﻿\n\n---\nprivate: true\n---\n# Secret\n\nbody text';
  const hidden = '\n---\nprivate: false\n---\n# Not secret\n\nbody text';
  for (const text of [bom, blank, both]) {
    const { meta, body } = parseFrontmatter(text);
    assert.equal(meta.private, 'true');
    assert.ok(isPrivateMeta(meta));
    assert.match(body, /^# Secret/);
    assert.ok(!body.includes('﻿'), 'the BOM itself never leaks into the body');
  }
  const { meta: hiddenMeta } = parseFrontmatter(hidden);
  assert.ok(!isPrivateMeta(hiddenMeta), 'private: false after leading blank lines is still not private');
});

// F4: a trailing space or tab on either fence line (e.g. the opening line is literally "--- ",
// which some editors write) must not stop detection, and CRLF line endings on the fence must still
// be accepted with trailing whitespace too.
test('F4: trailing spaces/tabs (and CRLF) on either frontmatter fence still detect private: true', () => {
  const openSpace = '--- \nprivate: true\n---\n# Secret\n\nbody text';
  const openTab = '---\t\nprivate: true\n---\n# Secret\n\nbody text';
  const closeSpace = '---\nprivate: true\n--- \n# Secret\n\nbody text';
  const bothCrlf = '--- \r\nprivate: true\r\n--- \r\n# Secret\r\n\r\nbody text';
  for (const text of [openSpace, openTab, closeSpace, bothCrlf]) {
    const { meta, body } = parseFrontmatter(text);
    assert.equal(meta.private, 'true');
    assert.ok(isPrivateMeta(meta));
    assert.match(body, /^# Secret/);
  }
});

// R3: isPrivateMeta's line-by-line key parser is deliberately strict (a looser leading-\s* regex
// would also match a `private:` line nested under an unrelated key, flipping a genuinely private
// note to public -- see the two "must stay private" cases below). fmSaysPrivate is a second,
// fail-closed scan of the raw frontmatter block that catches the spellings the strict parser
// misses. A note's real privacy check is isPrivateMeta(meta) || fmSaysPrivate(frontmatter).
test('R3: fail-closed frontmatter private detection covers spellings the strict parser misses, without being fooled by nested false', () => {
  const isPrivate = (text) => { const { meta, frontmatter } = parseFrontmatter(text); return isPrivateMeta(meta) || fmSaysPrivate(frontmatter); };

  const mustBePrivate = {
    'space before the colon': '---\nprivate : true\n---\nbody',
    'indented key': '---\n  private: true\n---\nbody',
    'quoted key': '---\n"private": true\n---\nbody',
    'value on the next line (block/empty)': '---\nprivate:\n---\nbody',
    'flow-style mapping': '---\nx: {private: true}\n---\nbody',
    'duplicate key, different case (first hit is false)': '---\nPrivate: false\nprivate: true\n---\nbody',
    // The two override cases: a real `private: true` must not be undone by an unrelated nested
    // `private: false` elsewhere in the block (that's exactly what a looser leading-\s* regex gets
    // wrong, per the Claude review).
    'nested private:false under another key does not override the real one': '---\nprivate: true\nsettings:\n  private: false\n---\nbody',
    'private:false inside a block scalar does not override the real one': '---\nprivate: true\nnotes: |\n  private: false\n---\nbody',
  };
  for (const [name, text] of Object.entries(mustBePrivate)) assert.ok(isPrivate(text), name);

  const mustStayPublic = {
    'explicit private: false': '---\nprivate: false\n---\nbody',
    'tags: [private] is not the private key': '---\ntags: [private]\n---\nbody',
    'is_private is not the private key': '---\nis_private: true\n---\nbody',
    'no frontmatter at all': '# Title\nbody',
  };
  for (const [name, text] of Object.entries(mustStayPublic)) assert.ok(!isPrivate(text), name);
});

test('R3: a note using one of the previously-missed private spellings is gated end to end (readNote + index)', async () => {
  const vaultDir = await tmp('r3-vault');
  await writeFile(path.join(vaultDir, 'Spacecolon.md'), '---\nprivate : true\n---\n# Spacecolon\nshh');
  await writeFile(path.join(vaultDir, 'Indented.md'), '---\n  private: true\n---\n# Indented\nshh');
  await writeFile(path.join(vaultDir, 'Quotedkey.md'), '---\n"private": true\n---\n# Quotedkey\nshh');
  await writeFile(path.join(vaultDir, 'Public.md'), '# Public\nhello');
  const cfg = normalize({ vaults: [{ name: 'Co', path: vaultDir }] });
  const ctx = createContext(cfg, { env: { BRAINLINK_HOME: await tmp('r3-home'), BRAINLINK_SEMANTIC: '0' } });
  for (const rel of ['Spacecolon.md', 'Indented.md', 'Quotedkey.md']) {
    await assert.rejects(readNote(ctx, 'Co', rel), /private/i, `${rel} is gated by readNote`);
  }
  const index = await loadVault(ctx, 'Co');
  assert.deepEqual(index.notes.map((n) => n.rel), ['Public.md'], 'private notes never enter the vault index');
  assert.equal(index.chunks.every((c) => c.noteIdx === 0), true);
});

test('private content cannot affect term frequencies, links or ranking candidates', async () => {
  const vaultDir = await tmp('private-index-isolation');
  await writeFile(path.join(vaultDir, 'Public.md'), '# Public\nFictional project calendar.');
  const ctx = createContext(normalize({ vaults: [{ name: 'Co', path: vaultDir }] }), { env: { BRAINLINK_HOME: await tmp('private-index-home'), BRAINLINK_SEMANTIC: '0' } });
  const before = await loadVault(ctx, 'Co');
  const baselineTerms = [...before.df.entries()];
  await writeFile(path.join(vaultDir, 'Secret.md'), '---\nprivate: true\n---\n# Secret\nZQXPRIVATECANARY [[Public]] launch budget');
  const after = await loadVault(ctx, 'Co');
  assert.deepEqual(after.notes.map((n) => n.rel), ['Public.md']);
  assert.deepEqual([...after.df.entries()], baselineTerms);
  assert.deepEqual(after.edges, []);
  assert.ok(!after.chunks.some((c) => c.text.includes('ZQXPRIVATECANARY')));
});

test('BOM and leading-blank-line private notes are hidden from readNote and search, same as any other private note', async () => {
  const { cfg, company } = await fixture();
  await writeFile(path.join(company, 'Secret BOM.md'), '﻿---\nprivate: true\n---\n# Secret BOM\n\nAcquire Initech quietly.');
  await writeFile(path.join(company, 'Secret Blank Lines.md'), '\n\n---\nprivate: true\n---\n# Secret Blank Lines\n\nAcquire Umbrella quietly.');
  const ctx = ctxOf(cfg);
  await assert.rejects(readNote(ctx, 'Acme Studio', 'Secret BOM.md'), /private/i);
  await assert.rejects(readNote(ctx, 'Acme Studio', 'Secret Blank Lines.md'), /private/i);
  const r = await search(ctx, 'Acme Studio', 'Initech Umbrella quietly');
  assert.ok(!r.some((x) => /Secret BOM|Secret Blank Lines/.test(x.path)));
});

test('S1: a private note never surfaces in search, related notes or the 2D graph', async () => {
  const { cfg, company } = await fixture();
  await writeFile(path.join(company, 'Secret Plan.md'), '---\nprivate: true\n---\n# Secret Plan\n\nzebracorn acquisition plan, linked from [[Home]].');
  await writeFile(path.join(company, 'Home.md'), (await readFile(path.join(company, 'Home.md'), 'utf8')) + '\n\nSee [[Secret Plan]] for zebracorn details.\n');
  const ctx = ctxOf(cfg);

  const r = await search(ctx, 'Acme Studio', 'zebracorn');
  assert.ok(!r.some((x) => x.path === 'Secret Plan.md'), JSON.stringify(r));

  const rel = await related(ctx, 'Acme Studio', 'Home.md');
  assert.ok(!rel.links_to.some((x) => x.path === 'Secret Plan.md'), JSON.stringify(rel.links_to));
  await assert.rejects(related(ctx, 'Acme Studio', 'Secret Plan.md'), /not found/i);

  const env = { BRAINLINK_HOME: await tmp('s1-graph-home'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home: await tmp('s1-graph'), os: 'darwin', port: 0, useCli: false });
  const api = (p, body) => fetch(`http://127.0.0.1:${s.port}${p}`, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  try {
    await api('/api/vault', { path: company, name: 'Acme Studio', pack: 'simple', scaffold: false });
    const g = await (await api('/api/graph', { vault: 'Acme Studio' })).json();
    assert.ok(!g.nodes.some((n) => n.title === 'Secret Plan'), JSON.stringify(g.nodes));
  } finally { s.server.close(); }
});

test('canary: a planted private note (ZQXCANARYPRIV) and 00 Home note (ZQXCANARYHOME) never surface anywhere', async () => {
  const { cfg, company } = await fixture();
  const CANARY = /ZQXCANARYPRIV|ZQXCANARYHOME/;
  // Filenames deliberately do NOT contain the marker: agent_connect legitimately echoes a missing
  // connect note's configured *path* in a warning (see item 1's test), which would false-positive
  // this canary if the marker were in the filename itself. Only the title/body/tasks carry it, so
  // a match here can only mean real note content leaked.
  await writeFile(path.join(company, 'Secret Note.md'), '---\nprivate: true\n---\n# ZQXCANARYPRIV\n\nSecret body mentioning ZQXCANARYPRIV plans.\n\n- [ ] ZQXCANARYPRIV next step\n\n- **Unresolved questions:** ZQXCANARYPRIV question\n');
  await mkdir(path.join(company, '00 Home'), { recursive: true });
  await writeFile(path.join(company, '00 Home', 'Diary.md'), '# ZQXCANARYHOME\n\nHome content mentioning ZQXCANARYHOME plans.\n\n- [ ] ZQXCANARYHOME next step\n');
  await writeFile(path.join(company, '.brainlinkignore'), '00 Home/\n');
  // An agent pointed straight at both canary files, so agent_connect / agents.mjs readSource is
  // exercised directly, not just incidentally.
  cfg.agents.push({
    ...cfg.agents[0], name: 'Canary', activation: ['Connect to Canary'], close: ['Canary close loop'],
    connect_notes: ['Secret Note.md'], recent_dir: '00 Home',
    close_target: { mode: 'append-section', path: 'Chief of Staff Office/Session Captures.md' },
  });
  const ctx = ctxOf(cfg);
  const mcp = createMcp(ctx);
  const call = async (name, args) => { const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }); return r.result; };

  const vs = await call('vault_search', { vault: 'Acme Studio', query: 'ZQXCANARYPRIV ZQXCANARYHOME plans', limit: 20 });
  assert.ok(!CANARY.test(JSON.stringify(vs)), JSON.stringify(vs));

  const recent = await call('vault_recent', { vault: 'Acme Studio', days: 365, limit: 50 });
  assert.ok(!CANARY.test(JSON.stringify(recent)), JSON.stringify(recent));

  const loops = await call('open_loops', { vault: 'Acme Studio', days: 365 });
  assert.ok(!CANARY.test(JSON.stringify(loops)), JSON.stringify(loops));

  const brief = await call('brain_brief', { vault: 'Acme Studio', days: 365 });
  assert.ok(!CANARY.test(JSON.stringify(brief)), JSON.stringify(brief));

  const connected = await call('agent_connect', { agent: 'Connect to Canary' });
  assert.ok(!CANARY.test(JSON.stringify(connected)), JSON.stringify(connected));

  const map = await buildHomeMap(ctx, 'Acme Studio');
  assert.ok(!CANARY.test(map), map);

  const suggestions = await suggestLinks(ctx, 'Acme Studio', 'Thinking about ZQXCANARYPRIV and ZQXCANARYHOME plans today');
  assert.ok(!CANARY.test(JSON.stringify(suggestions)), JSON.stringify(suggestions));

  // Link suggestions as surfaced through a real write (propose_note's auto-linked "Related"
  // section): the new note's own body legitimately contains the marker text the caller gave it,
  // so what matters is that the private/00-Home note titles are never auto-linked to.
  const proposed = await proposeNote(ctx, { title: 'Note about plans', body: 'Thinking about ZQXCANARYPRIV and ZQXCANARYHOME plans today.', source: 'chat', decision: 'MONITOR' });
  assert.ok(!/\[\[Secret Note\]\]|\[\[Diary\]\]/.test(proposed.preview), proposed.preview);
});

test('per-connection vault scope: BRAINLINK_VAULTS hides other vaults', async () => {
  const { cfg } = await fixture();
  const ctx = ctxOf(cfg, { BRAINLINK_VAULTS: 'Acme Studio' });
  assert.deepEqual(ctx.enabled, ['Acme Studio']);
  await assert.rejects(search(ctx, 'Journal', 'diary'), /not enabled/);
  assert.ok(ctx.agents.every((a) => a.vault === 'Acme Studio'));
});

// ---- config, time ----

test('config validation catches bad vaults, agents, close targets and timezones', () => {
  const errs = validate(normalize({ timezone: 'Mars/Base', vaults: [{ name: 'A', path: 'relative' }, { name: 'A', path: '/x' }], agents: [{ name: 'Z', vault: 'Nope', close_target: { mode: 'bogus' } }], handoff: { vault: 'Q', folder: 'x' } }));
  for (const re of [/absolute/, /duplicate vault/, /unknown vault/, /close_target.mode/, /handoff/, /timezone/]) assert.ok(errs.some((e) => re.test(e)), re);
  assert.deepEqual(validate(normalize({ vaults: [{ name: 'A', path: '/x' }] })), []);
});

test('zonedNow formats the configured zone with its offset', () => {
  assert.equal(zonedNow('Asia/Taipei', NOW), '2026-10-18T09:30:00+08:00');
  assert.equal(zonedNow('UTC', NOW), '2026-10-18T01:30:00+00:00');
  assert.equal(zonedNow('America/New_York', NOW), '2026-10-17T21:30:00-04:00');
});

test('every install is fully unlocked: every vault enabled, writes and agents on, no licence needed', async () => {
  const { cfg } = await fixture();
  const ctx = createContext(cfg, { env: {} });
  assert.equal(ctx.enabled.length, 2);
  assert.equal(ctx.readOnly, false);
  assert.equal(ctx.features.plan, 'full');
  const names = createMcp(ctx).tools.map((t) => t.name);
  assert.ok(names.includes('vault_search') && names.includes('propose_note') && names.includes('agent_connect'));
});

test('vault_search defaults to compact output without dropping sources, citation context or freshness cues', async () => {
  const { cfg } = await fixture();
  const searchTool = createMcp(ctxOf(cfg)).tools.find((tool) => tool.name === 'vault_search');
  const args = { vault: 'Acme Studio', query: 'launch package', limit: 8 };
  const compact = await searchTool.run(args);
  const full = await searchTool.run({ ...args, detail: 'full' });
  const contextFields = ['path', 'title', 'date', 'status', 'historical', 'superseded_by', 'match', 'heading', 'snippet'];
  assert.equal(compact.status, full.status);
  assert.equal(compact.coverage, full.coverage);
  assert.equal(compact.note, full.note);
  assert.deepEqual(compact.results, full.results.map((result) => Object.fromEntries(contextFields.filter((key) => Object.hasOwn(result, key)).map((key) => [key, result[key]]))));
  assert.ok(compact.results.length > 0);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length, 'compact output removes ranking metadata while preserving every result');
  for (const result of compact.results) for (const key of ['score', 'graph_boost', 'coverage', 'collection', 'tags']) assert.equal(Object.hasOwn(result, key), false, key);
});

// ---- writes ----

test('propose_note: preview, write, never overwrite, attribution in the vault schema', async () => {
  const { cfg, company } = await fixture();
  const ctx = ctxOf(cfg);
  const args = { vault: 'Acme Studio', title: 'Faster QA', body: 'Use a checklist.', source: 'retro', decision: 'adopt', session_or_task_id: 's1' };
  const p = await proposeNote(ctx, args, NOW);
  assert.equal(p.written, false);
  assert.match(p.preview, /ai_platform: "Claude"/);
  assert.match(p.preview, /written_at: 2026-10-18T09:30:00\+08:00/);
  assert.match(p.preview, /\*\*ADOPT\*\*/);
  const w = await proposeNote(ctx, { ...args, confirm: true }, NOW);
  assert.equal(w.path, 'Acme Studio/Knowledge Intake/2026-10-18 — Faster QA.md');
  assert.match(await readFile(path.join(company, 'Knowledge Intake/2026-10-18 — Faster QA.md'), 'utf8'), /Made by Claude \(direct assistant\)/);
  const again = await proposeNote(ctx, { ...args, confirm: true }, NOW);
  assert.match(again.errors[0], /already exists/);
});

test('propose_note refuses: missing decision, unknown folder, secrets, missing identity', async () => {
  const { cfg } = await fixture();
  const ctx = ctxOf(cfg);
  const base = { vault: 'Acme Studio', title: 'T', body: 'b', source: 's' };
  assert.match((await proposeNote(ctx, base)).errors.join(), /decision is required/);
  assert.match((await proposeNote(ctx, { ...base, folder: 'Nowhere' })).errors.join(), /does not exist/);
  assert.match((await proposeNote(ctx, { ...base, decision: 'ADOPT', body: 'key sk-abcdefghijklmnopqrstuvwxyz123' })).errors.join(), /secrets/);
  assert.match((await proposeNote(ctx, { ...base, folder: 'Clients', body: 'card 4111 1111 1111 1111' })).errors.join(), /card/);
  const anon = createContext(cfg, { env: {} });
  assert.match((await proposeNote(anon, { ...base, decision: 'ADOPT' })).errors.join(), /ai_platform is required/);
  assert.ok((await proposeNote(ctx, { ...base, folder: 'Clients' })).ok, 'existing folder needs no decision');
});

test('proposal-only vault never writes; provenance schema used', async () => {
  const { cfg, journal } = await fixture();
  const ctx = ctxOf(cfg);
  const r = await proposeNote(ctx, { vault: 'Journal', title: 'Mood', body: 'ok', source: 'chat', confidence: 'reported', confirm: true }, NOW);
  assert.equal(r.written, false);
  assert.match(r.preview, /created_by_platform: claude/);
  assert.match(r.preview, /provenance_confidence: reported/);
  assert.deepEqual((await readdir(path.join(journal, 'Inbox'))), []);
});

test('read-only connection refuses writes', async () => {
  const { cfg } = await fixture();
  const ctx = ctxOf(cfg, { BRAINLINK_READ_ONLY: '1' });
  assert.match((await proposeNote(ctx, { title: 'T', body: 'b', source: 's', decision: 'ADOPT' })).errors.join(), /read-only/);
});

test('handoffs: send to a mailbox and filter by recipient', async () => {
  const { cfg } = await fixture();
  const ctx = ctxOf(cfg);
  const r = await sendHandoff(ctx, { to: 'Grok', subject: 'Check pricing page', body: 'Please review.', priority: 'P1', confirm: true }, NOW);
  assert.match(r.path, /Handoffs\/2026-10-18-0930-from-claude-to-grok-check-pricing-page\.md$/);
  const forGrok = await listHandoffs(ctx, { to: 'Grok' });
  assert.equal(forGrok.length, 1);
  assert.equal((await listHandoffs(ctx, {})).length, 2);
});

test('structured handoff keeps scope and evidence, and refuses private source links before writing', async () => {
  const { cfg, company } = await fixture();
  const ctx = ctxOf(cfg);
  const args = { to: 'Codex', subject: 'Continue fictional site', goal: 'Finish the public landing page',
    current_state: 'Design approved', decisions: ['Keep one-column layout'], modified_files: ['site/index.html'],
    tests: ['Local preview passed'], open_questions: ['Check keyboard navigation'],
    next_steps: ['Add focus states'], scope: 'company', confidence: 'reported',
    source_refs: ['Home.md'], confirm: true };
  const made = await sendHandoff(ctx, args, NOW);
  assert.equal(made.written, true);
  const saved = await readFile(path.join(company, made.path.split('/').slice(1).join('/')), 'utf8');
  assert.match(saved, /handoff_schema: 1/);
  assert.match(saved, /scope: "company"/);
  assert.match(saved, /## Tests and results\n\n- Local preview passed/);
  assert.match(saved, /\[\[Home\]\]/);
  const privateRef = await sendHandoff(ctx, { ...args, subject: 'Must not write', source_refs: ['Secret Note.md'] }, NOW);
  assert.equal(privateRef.ok, false);
  assert.match(privateRef.errors.join(' '), /private note/);
  assert.equal((await listHandoffs(ctx, { to: 'Codex' })).length, 1);
});

test('handoff replies are append-only and use a constrained lifecycle status', async () => {
  const { cfg, company } = await fixture();
  const ctx = ctxOf(cfg);
  const request = await sendHandoff(ctx, { to: 'Codex', subject: 'Fictional task', goal: 'Complete the demo', confirm: true }, NOW);
  assert.equal(request.written, true);
  const requestFile = await readFile(path.join(company, request.path.split('/').slice(1).join('/')), 'utf8');
  assert.match(requestFile, /status: REQUEST/);

  const invalid = await sendHandoff(ctx, { to: 'Claude', subject: 'Invalid update', body: 'No arbitrary status', ack_of: request.path, status: 'MAGIC', confirm: true }, new Date(NOW.getTime() + 3600000));
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(' '), /status must be one of/);
  const blocked = await sendHandoff(ctx, { to: 'Claude', subject: 'Blocked on approval', body: 'Waiting for approval.', ack_of: request.path, status: 'BLOCKED', confirm: true }, new Date(NOW.getTime() + 3600000));
  const completed = await sendHandoff(ctx, { to: 'Claude', subject: 'Demo complete', body: 'The fictional demo is done.', ack_of: request.path, status: 'COMPLETED', confirm: true }, new Date(NOW.getTime() + 7200000));
  assert.equal(blocked.written, true);
  assert.equal(completed.written, true);
  assert.notEqual(blocked.path, completed.path);
  const items = await listHandoffs(ctx, {});
  assert.equal(items.find((item) => item.path === blocked.path).status, 'BLOCKED');
  assert.equal(items.find((item) => item.path === completed.path).status, 'COMPLETED');
  const unchanged = await readFile(path.join(company, request.path.split('/').slice(1).join('/')), 'utf8');
  assert.equal(unchanged, requestFile, 'replies never rewrite the original request');
});

test('P0: listHandoffs carries ack_of/sent_at for pickup pairing, and never surfaces a private or excluded handoff', async () => {
  const { cfg, company } = await fixture();
  const ctx = ctxOf(cfg);
  const r1 = await sendHandoff(ctx, { to: 'Grok', subject: 'Check pricing page', body: 'Please review.', confirm: true }, NOW);
  const r2 = await sendHandoff(ctx, { to: 'Claude', subject: 'Pricing page reviewed', body: 'Done, looks good.', ack_of: r1.path, confirm: true }, new Date(NOW.getTime() + 3600000));
  const r3 = await sendHandoff(ctx, { to: 'Grok', subject: 'Pricing page complete', body: 'Changes are finished.', ack_of: r1.path, status: 'COMPLETED', confirm: true }, new Date(NOW.getTime() + 7200000));
  const list = await listHandoffs(ctx, {});
  const original = list.find((x) => x.path === r1.path);
  const ack = list.find((x) => x.path === r2.path);
  const completion = list.find((x) => x.path === r3.path);
  assert.equal(ack.ack_of, r1.path);
  assert.equal(ack.status, 'ACKNOWLEDGED', 'reply without a status defaults to acknowledgement');
  assert.equal(completion.status, 'COMPLETED');
  assert.match(original.sent_at, /^2026-10-18T09:30/);
  assert.match(ack.sent_at, /^2026-10-18T10:30/);

  // Hand-edited frontmatter (sendHandoff never writes private:true itself, but the same
  // fail-closed rule readNote() applies to ordinary notes must apply here too).
  const dir = path.join(company, 'Chief of Staff Office', 'Handoffs');
  await writeFile(path.join(dir, '2026-10-19-0900-from-claude-to-grok-secret-plan.md'), '---\ntype: handoff\nprivate: true\nsubject: "Secret plan"\nto: "Grok"\n---\n# Secret plan\n');
  const withPrivate = await listHandoffs(ctx, {});
  assert.ok(!withPrivate.some((x) => x.subject === 'Secret plan'), 'a handoff hand-marked private must never be listed');
  assert.equal(withPrivate.length, list.length, 'the private handoff must be dropped, not added, from the count');

  // A user excluding the whole mailbox folder (e.g. via the vault's excluded-folders setting)
  // must empty the list, exactly like it would for ordinary notes under that folder. Rules
  // accumulate by folder name at any depth (see isExcludedPath), so "Handoffs/" alone covers it.
  await writeFile(path.join(company, '.brainlinkignore'), 'Handoffs/\n');
  assert.deepEqual(await listHandoffs(ctx, {}), []);
});

// ---- agents ----

test('agents resolve by name or phrase, case and punctuation insensitive', async () => {
  const { cfg } = await fixture();
  const ctx = ctxOf(cfg);
  assert.equal(resolveAgent(ctx, 'connect to chief of staff').name, 'Chief of Staff');
  assert.equal(resolveAgent(ctx, 'Chief of Staff, close the loop.').name, 'Chief of Staff');
  assert.throws(() => resolveAgent(ctx, 'Anna'), /Unknown agent/);
});

test('agent_connect loads role notes, newest captures and stale warnings', async () => {
  const { cfg, company } = await fixture();
  const old = new Date(Date.now() - 40 * 86400e3);
  await utimes(path.join(company, 'Chief of Staff Office/Current Goal.md'), old, old);
  const r = await connectAgent(ctxOf(cfg), { agent: 'Connect to Chief of Staff' });
  assert.equal(r.agent.vault, 'Acme Studio');
  assert.ok(r.role_notes.some((n) => /Operating coordinator/.test(n.excerpt)));
  assert.equal(r.recent_captures[0].heading, '2026-10-10 09:30 — Weekly planning');
  assert.ok(r.warnings.some((w) => /Current Goal/.test(w)));
  assert.match(r.instructions, /Chief of Staff close loop/);
});

test('agent_connect: private connect notes and private recent_dir entries never reach the agent', async () => {
  const { cfg, company } = await fixture();
  const office = 'Chief of Staff Office';
  await writeFile(path.join(company, office, 'Current Goal.md'), '---\nprivate: true\n---\n# Current Goal\n\nZQXGOALMARK should stay hidden.');
  await writeFile(path.join(company, office, '2026-10-17 — Secret.md'), '---\nprivate: true\n---\n# Secret\n\nZQXRECENTMARK should stay hidden.');
  await writeFile(path.join(company, office, '2026-10-16 — Public.md'), '# Public\n\nnothing sensitive here');
  const r = await connectAgent(ctxOf(cfg), { agent: 'Connect to Chief of Staff' });
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes('ZQXGOALMARK'));
  assert.ok(!dump.includes('ZQXRECENTMARK'));
  assert.ok(r.warnings.some((w) => /Current Goal/.test(w)), 'private connect note reported as missing, not private');
  assert.ok(!r.recent_notes.some((p) => /Secret/.test(p)));
  assert.ok(r.recent_notes.some((p) => /Public/.test(p)));
});

test('latestCaptures sorts by date, not file order', () => {
  const c = latestCaptures('## 2026-08-01 — a\n\nx\n\n## 2026-10-15 — c\n\nz\n\n## 2026-09-07 — b\n\ny');
  assert.deepEqual(c.map((x) => x.heading), ['2026-10-15 — c', '2026-09-07 — b']);
});

test('close loop: append-section preview then append', async () => {
  const { cfg, company } = await fixture();
  const ctx = ctxOf(cfg);
  const args = { agent: 'Chief of Staff', title: 'Launch review', source: 'chat', confidence: 'high', decisions: ['Launch Nov 3'], next_actions: ['Book QA'], links: ['Northwind Launch Site'] };
  const p = await closeLoop(ctx, args, NOW);
  assert.equal(p.written, false);
  assert.match(p.preview, /## 2026-10-18 09:30 — Launch review/);
  const w = await closeLoop(ctx, { ...args, confirm: true }, NOW);
  assert.equal(w.written, true);
  const text = await readFile(path.join(company, 'Chief of Staff Office/Session Captures.md'), 'utf8');
  assert.match(text, /Weekly planning[\s\S]*Launch review/);
  assert.match(text, /\[\[Northwind Launch Site\]\]/);
  assert.match((await closeLoop(ctx, { agent: 'Chief of Staff', source: 'x', confidence: 'y', title: 'T' })).errors.join(), /decision or action/);
});

test('close loop: proposal-only agent stays a proposal until capture_approved', async () => {
  const { cfg, journal } = await fixture();
  const args = { agent: 'Journal', title: 'Evening', source: 'chat', confidence: 'reported', actions: ['Reflected'], confirm: true };
  const r = await closeLoop(ctxOf(cfg), args, NOW);
  assert.equal(r.written, false);
  assert.match(r.next, /proposal-only/);
  assert.doesNotMatch(await readFile(path.join(journal, 'Memory Review Inbox.md'), 'utf8'), /Evening/);
});

test('close loop: new-note and append-task modes', async () => {
  const { cfg, company } = await fixture();
  cfg.agents.push(
    { ...cfg.agents[0], name: 'Fin', activation: ['Connect to Fin'], close: ['Fin close loop'], close_target: { mode: 'new-note', dir: 'Projects' } },
    { ...cfg.agents[0], name: 'Sec', activation: ['Connect to Sec'], close: ['Sec close loop'], close_target: { mode: 'append-task', path: 'Chief of Staff Office/Tasks.md' } },
  );
  const ctx = ctxOf(cfg);
  const n = await closeLoop(ctx, { agent: 'Fin', title: 'Budget check', source: 'chat', confidence: 'high', decisions: ['Hold'], confirm: true }, NOW);
  assert.equal(n.path, 'Acme Studio/Projects/2026-10-18 — Budget check.md');
  assert.match(await readFile(path.join(company, 'Projects/2026-10-18 — Budget check.md'), 'utf8'), /tags: \[close-loop, fin\]/);
  const t = await closeLoop(ctx, { agent: 'Sec', source: 'chat', confidence: 'high', tasks: [{ task: 'Renew domain', next: 'check registrar' }], confirm: true }, NOW);
  assert.equal(t.appended_tasks, 1);
  assert.match(await readFile(path.join(company, 'Chief of Staff Office/Tasks.md'), 'utf8'), /- \[ \] 2026-10-18 — Renew domain — check registrar/);
});

// ---- MCP protocol ----

test('MCP: initialize, tools, prompts, resources, errors', async () => {
  const { cfg } = await fixture();
  const mcp = createMcp(ctxOf(cfg));
  const call = (method, params, id = 1) => mcp.handle({ jsonrpc: '2.0', id, method, params });
  const init = await call('initialize', { protocolVersion: '2025-03-26' });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.match(init.result.instructions, /"Connect to Chief of Staff" → agent_connect/);
  const names = (await call('tools/list')).result.tools.map((t) => t.name);
  for (const n of ['brainlink_guide', 'vault_search', 'agent_connect', 'agent_close_loop', 'propose_note', 'send_handoff', 'search', 'fetch']) assert.ok(names.includes(n), n);
  const guide = await call('tools/call', { name: 'brainlink_guide', arguments: {} });
  const model = guide.result.structuredContent.memory_model;
  assert.deepEqual(Object.keys(model.types), ['working', 'semantic', 'procedural', 'episodic']);
  assert.ok(Object.values(model.types).every((item) => item.enabled));
  assert.match(model.approval, /Each additional durable semantic or procedural note needs a separate preview and approval/);
  assert.match(init.result.instructions, /MEMORY TYPES ENABLED FOR THIS CONNECTION: working, semantic, procedural, episodic/);
  const prompts = (await call('prompts/list')).result.prompts.map((p) => p.name);
  assert.ok(prompts.includes('connect-chief-of-staff') && prompts.includes('close-loop-chief-of-staff'));
  assert.match((await call('prompts/get', { name: 'close-loop-chief-of-staff', arguments: { focus: 'launch' } })).result.messages[0].content.text, /launch/);
  const res = (await call('resources/list')).result.resources;
  const rule = res.find((r) => r.name === 'Acme Studio: AGENTS.md');
  assert.match((await call('resources/read', { uri: rule.uri })).result.contents[0].text, /Rules for AI agents/);
  assert.equal((await call('nope')).error.code, -32601);
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const bad = await call('tools/call', { name: 'vault_read_note', arguments: { vault: 'Acme Studio', path: '../x.md' } });
  assert.equal(bad.result.isError, true);
});

test('connector search/fetch exclude private vaults', async () => {
  const { cfg } = await fixture();
  const mcp = createMcp(ctxOf(cfg));
  const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'pricing diary' } } });
  const ids = r.result.structuredContent.results.map((x) => x.id);
  assert.ok(ids.length && ids.every((id) => id.startsWith('Acme Studio::')));
  const f = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fetch', arguments: { id: 'Journal::diary.md' } } });
  assert.equal(f.result.isError, true);
});

test('HTTP transport: token required, foreign origins rejected', async () => {
  const { cfg } = await fixture();
  const token = 'a'.repeat(32);
  const server = await serveHttp(createMcp(ctxOf(cfg)), 0, token);
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  try {
    assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', body, headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } })).status, 403);
    const ok = await fetch(url, { method: 'POST', body, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    assert.ok((await ok.json()).result.tools.length > 5);
  } finally { server.close(); }
  assert.throws(() => serveHttp(createMcp(ctxOf(cfg)), 0, 'short'), /16\+/);
});

// ---- connectors, packs, setup ----

test('connectors: JSON clients keep other servers and get a backup; bad JSON is never overwritten', async () => {
  const home = await tmp('home');
  const opts = { home, os: 'darwin', env: {}, launch: { command: '/opt/BrainLink/node', args: ['/opt/BrainLink/cli.mjs', 'serve'] }, useCli: false, now: NOW };
  const file = path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
  const r = await connectClient('claude-desktop', opts);
  const j = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(j.mcpServers.other.command, 'x');
  assert.equal(j.theme, 'dark');
  assert.deepEqual(j.mcpServers.brainlink, { command: '/opt/BrainLink/node', args: ['/opt/BrainLink/cli.mjs', 'serve'], env: { BRAINLINK_AGENT_TOKEN: '', BRAINLINK_AI_PLATFORM: 'Claude', BRAINLINK_AGENT_ROLE: 'Claude Desktop' } });
  assert.ok(r.backup && JSON.parse(await readFile(r.backup, 'utf8')).mcpServers.brainlink === undefined);
  assert.equal((await detect(opts))['claude-desktop'].connected, true);
  await disconnectClient('claude-desktop', opts);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).mcpServers.brainlink, undefined);
  const cursor = path.join(home, '.cursor/mcp.json');
  await mkdir(path.dirname(cursor), { recursive: true });
  await writeFile(cursor, '{ broken');
  await assert.rejects(connectClient('cursor', opts), /not valid JSON/);
  assert.equal(await readFile(cursor, 'utf8'), '{ broken');
});

test('connectors: Codex TOML block is replaced, not duplicated', async () => {
  const entry = { command: 'C:\\BrainLink\\node.exe', args: ['C:\\BrainLink\\app\\bin\\brainlink.mjs', 'serve'], env: { BRAINLINK_AI_PLATFORM: 'ChatGPT Codex' } };
  const start = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n';
  const once = codexToml(start, entry);
  const twice = codexToml(once, entry);
  assert.equal(once, twice);
  assert.equal((twice.match(/\[mcp_servers\.brainlink\]/g) || []).length, 1);
  assert.match(twice, /command = "C:\\\\BrainLink\\\\node.exe"/);
  assert.match(twice, /\[mcp_servers\.other\]\ncommand = "x"/);
  assert.equal(codexToml(twice, null).includes('brainlink'), false);
});

test('connectors: the scoped Codex health check reads its token only from the BrainLink TOML env table', async () => {
  const home = await tmp('codex-token-home');
  const codexHome = path.join(home, '.codex');
  const opts = { home, os: 'linux', env: { CODEX_HOME: codexHome }, launch: { command: '/brainlink/node', args: ['serve'] }, useCli: false };
  await mkdir(codexHome, { recursive: true });
  const token = 'bla_scoped-codex-token';
  const content = codexToml('[mcp_servers.other]\ncommand = "other"\n', { command: '/brainlink/node', args: ['serve'], env: { BRAINLINK_AGENT_TOKEN: token, BRAINLINK_AI_PLATFORM: 'ChatGPT Codex' } });
  await writeFile(path.join(codexHome, 'config.toml'), content);
  assert.equal(await readClientAgentToken('codex', opts), token);
});

test('packs: scaffold never overwrites; merge replaces same-named vault', async () => {
  const dir = await tmp('pack');
  await writeFile(path.join(dir, 'AGENTS.md'), 'mine');
  const b = buildPack('founder-os', { vaultName: 'V', vaultPath: dir, agentName: 'Max' });
  const created = await scaffold(dir, b.scaffold);
  assert.equal(await readFile(path.join(dir, 'AGENTS.md'), 'utf8'), 'mine');
  assert.ok(created.includes('Max Office/Session Captures.md'));
  assert.deepEqual(await scaffold(dir, b.scaffold), []);
  const merged = mergePack(mergePack(normalize({}), b), b);
  assert.equal(merged.vaults.length, 1);
  assert.equal(merged.agents.length, 1);
  assert.deepEqual(validate(normalize(merged)), []);
  assert.throws(() => buildPack('nope', {}), /Unknown rule pack/);
});

test('setup UI: host check, token check, add vault, connect with no plan limits', async () => {
  const home = await tmp('setup-home');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const vaultDir = path.join(home, 'Notes');
  await cp(SAMPLE, vaultDir, { recursive: true });
  const s = await startSetup({ env, home, os: 'darwin', port: 0, pick: async () => vaultDir, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (method, p, body, token = s.token) => fetch(base + p, { method, headers: { 'X-BrainLink-Token': token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await api('GET', '/api/state', null, 'wrong')).status, 401);
    assert.equal((await api('POST', '/api/pick-folder')).status, 200);
    const add = await (await api('POST', '/api/vault', { path: vaultDir, name: 'Acme', pack: 'founder-os', agentName: 'Chief of Staff' })).json();
    assert.equal(add.ok, true);
    const st = await (await api('GET', '/api/state')).json();
    assert.equal(st.vaults[0].notes > 5, true);
    assert.equal(st.agents[0].name, 'Chief of Staff');
    // No vault cap: a second vault is always allowed, not just on a paid plan.
    const second = await api('POST', '/api/vault', { path: home, name: 'Other' });
    assert.equal(second.status, 200);
    const t = await (await api('POST', '/api/test', { query: 'care plan discount rules' })).json();
    assert.equal(t.results[0].path, 'Pricing and Packages.md');
    // No connection cap: a third AI app connects fine too.
    for (const c of ['claude-desktop', 'cursor', 'gemini']) {
      await mkdir(path.join(home, c === 'cursor' ? '.cursor' : c === 'gemini' ? '.gemini' : 'Library/Application Support/Claude'), { recursive: true });
      assert.equal((await api('POST', '/api/connect', { client: c })).status, 200);
    }
    // fetch() drops custom Host headers, so use node:http to simulate DNS rebinding.
    const status = await new Promise((resolve) => request({ host: '127.0.0.1', port: s.port, path: '/api/state', headers: { 'X-BrainLink-Token': s.token, Host: `evil.example:${s.port}` } }, (r) => { r.resume(); resolve(r.statusCode); }).end());
    assert.equal(status, 421);
  } finally { s.server.close(); }
});

test('P1a: the vault card\'s note count matches what is actually visible (private/excluded notes are not counted)', async () => {
  const home = await tmp('p1a-notecount');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const vaultDir = path.join(home, 'Notes');
  await cp(SAMPLE, vaultDir, { recursive: true });
  const s = await startSetup({ env, home, os: 'darwin', port: 0, pick: async () => vaultDir, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (method, p, body) => fetch(base + p, { method, headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    const add = await (await api('POST', '/api/vault', { path: vaultDir, name: 'Acme', pack: 'founder-os', agentName: 'Chief of Staff' })).json();
    assert.equal(add.ok, true);
    const before = (await (await api('GET', '/api/state')).json()).vaults[0].notes;
    const g0 = await (await api('POST', '/api/graph', {})).json();
    assert.equal(before, g0.health.notes, 'the vault card count must match the Brain map\'s own visible-notes count');

    // Add one private note and one excluded-folder note: a naive recursive .md count would see
    // both, but neither should ever count as a visible note.
    await writeFile(path.join(vaultDir, 'Private Thoughts.md'), '---\nprivate: true\n---\n# Private Thoughts\n');
    await mkdir(path.join(vaultDir, '00 Home'), { recursive: true });
    await writeFile(path.join(vaultDir, '00 Home', 'Diary.md'), '# Diary\n');
    await writeFile(path.join(vaultDir, '.brainlinkignore'), '00 Home/\n');
    const after = (await (await api('GET', '/api/state')).json()).vaults[0].notes;
    assert.equal(after, before, 'adding one private and one excluded-folder note must not move the visible count');
    const g1 = await (await api('POST', '/api/graph', {})).json();
    assert.equal(after, g1.health.notes);
  } finally { s.server.close(); }
});

test('P0: POST /api/handoffs shows a clear receipt (who sent, who picked up, when) and a "not picked up yet" state; never leaks a private or excluded handoff', async () => {
  const home = await tmp('p0-handoffs');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const vaultDir = path.join(home, 'Notes');
  await cp(SAMPLE, vaultDir, { recursive: true });
  const s = await startSetup({ env, home, os: 'darwin', port: 0, pick: async () => vaultDir, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (method, p, body) => fetch(base + p, { method, headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    const add = await (await api('POST', '/api/vault', { path: vaultDir, name: 'Acme', pack: 'founder-os', agentName: 'Chief of Staff' })).json();
    assert.equal(add.ok, true);
    const dir = path.join(vaultDir, 'Chief of Staff Office', 'Handoffs');
    // A: handed off by Claude, picked up (acked) by Grok.
    await writeFile(path.join(dir, '2026-10-18-0930-from-claude-to-grok-check-pricing-page.md'),
      '---\ntype: handoff\nstatus: REQUEST\nai_platform: "Claude"\nwritten_at: 2026-10-18T09:30:00+08:00\nto: "Grok"\npriority: P1\nsubject: "Check pricing page"\n---\n# Check pricing page\n');
    await writeFile(path.join(dir, '2026-10-18-1030-from-grok-to-claude-pricing-page-started.md'),
      `---\ntype: handoff\nstatus: IN_PROGRESS\nai_platform: "Grok"\nwritten_at: 2026-10-18T10:30:00+08:00\nto: "Claude"\npriority: P1\nsubject: "Pricing page started"\nack_of: "Acme/Chief of Staff Office/Handoffs/2026-10-18-0930-from-claude-to-grok-check-pricing-page.md"\n---\n# Pricing page started\n`);
    await writeFile(path.join(dir, '2026-10-18-1130-from-grok-to-claude-pricing-page-done.md'),
      `---\ntype: handoff\nstatus: COMPLETED\nai_platform: "Grok"\nwritten_at: 2026-10-18T11:30:00+08:00\nto: "Claude"\npriority: P1\nsubject: "Pricing page done"\nack_of: "Acme/Chief of Staff Office/Handoffs/2026-10-18-0930-from-claude-to-grok-check-pricing-page.md"\n---\n# Pricing page done\n`);
    await writeFile(path.join(dir, '2026-10-18-1130-from-codex-to-claude-pricing-page-blocked.md'),
      `---\ntype: handoff\nstatus: BLOCKED\nai_platform: "Codex"\nwritten_at: 2026-10-18T11:30:00+08:00\nto: "Claude"\npriority: P1\nsubject: "Pricing page blocked"\nack_of: "Acme/Chief of Staff Office/Handoffs/2026-10-18-0930-from-claude-to-grok-check-pricing-page.md"\n---\n# Pricing page blocked\n`);
    // B: handed off by Claude to Codex, no reply yet.
    await writeFile(path.join(dir, '2026-10-19-0900-from-claude-to-codex-deploy-the-fix.md'),
      '---\ntype: handoff\nstatus: REQUEST\nai_platform: "Claude"\nwritten_at: 2026-10-19T09:00:00+08:00\nto: "Codex"\npriority: P1\nsubject: "Deploy the fix"\n---\n# Deploy the fix\n');
    // Hand-marked private: must never appear in the receipt, title included.
    await writeFile(path.join(dir, '2026-10-20-0900-from-claude-to-grok-secret-plan.md'),
      '---\ntype: handoff\nprivate: true\nsubject: "Secret plan"\nto: "Grok"\n---\n# Secret plan\n');

    const r = await (await api('POST', '/api/handoffs', {})).json();
    assert.equal(r.enabled, true);
    // 3, not 4: the sample vault ships one pre-existing handoff of its own, and an ack is a
    // reply (paired into its original's receipt), never a top-level receipt on its own.
    assert.equal(r.receipts.length, 3);
    assert.ok(!JSON.stringify(r).includes('Secret plan'), 'a private handoff title must never reach the UI');

    const picked = r.receipts.find((x) => x.subject === 'Check pricing page');
    assert.equal(picked.from, 'claude');
    assert.equal(picked.to, 'grok');
    assert.equal(picked.picked_up, true);
    assert.equal(picked.picked_up_by, null, 'simultaneous updates must not select an arbitrary agent');
    assert.match(picked.picked_up_at, /^2026-10-18T11:30/);
    assert.equal(picked.update_conflict, true);
    assert.equal(picked.update_status, 'CONCURRENT_UPDATES');
    assert.equal(picked.update_subject, '2 updates need review');
    assert.match(picked.sent_at, /^2026-10-18T09:30/);

    const pending = r.receipts.find((x) => x.subject === 'Deploy the fix');
    assert.equal(pending.from, 'claude');
    assert.equal(pending.to, 'codex');
    assert.equal(pending.picked_up, false, 'not picked up yet');
    assert.equal(pending.picked_up_by, null);
  } finally { s.server.close(); }
});

test('CLI: `brainlink serve` speaks MCP over stdio and logs content-free activity', async () => {
  const { cfg } = await fixture();
  const home = await tmp('cli');
  await saveConfig(cfg, path.join(home, 'config.json'));
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/brainlink.mjs'), 'serve'], { env: { ...process.env, BRAINLINK_HOME: home, BRAINLINK_AI_PLATFORM: 'Cursor' } });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brainlink_guide', arguments: {} } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vault_search', arguments: { vault: 'Acme Studio', query: 'secret pricing words' } } }) + '\n');
  for (let i = 0; i < 300 && lines.length < 3 && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(lines.length, 3, `expected three MCP responses before timeout; received ${lines.length}, child exit=${child.exitCode}`);
  for (let i = 0; i < 40; i++) { if (await readFile(path.join(home, 'activity.log'), 'utf8').then((t) => t.includes('vault_search'), () => false)) break; await new Promise((r) => setTimeout(r, 50)); }
  child.kill();
  assert.equal(lines[0].result.serverInfo.name, 'brainlink');
  assert.equal(lines[1].result.isError, false);
  assert.equal(lines[2].result.isError, false); // every install searches, no licence needed
  const log = await readFile(path.join(home, 'activity.log'), 'utf8');
  assert.match(log, /"tool":"vault_search"/);
  assert.match(log, /"platform":"Cursor"/);
  const searchActivity = log.trim().split(/\r?\n/).map(JSON.parse).find((entry) => entry.tool === 'vault_search');
  assert.ok(Number.isSafeInteger(searchActivity.result_token_estimate) && searchActivity.result_token_estimate > 0);
  const guideActivity = log.trim().split(/\r?\n/).map(JSON.parse).find((entry) => entry.tool === 'brainlink_guide');
  assert.ok(Number.isSafeInteger(guideActivity.result_token_estimate) && guideActivity.result_token_estimate > 0);
  assert.doesNotMatch(log, /secret pricing/);
});

test('shipped files name no specific customer, person or private path', async () => {
  const banned = /\b(Iango|Ian Tsai|iantsai|Anna CEO|Ian Livva|Ian Personal|GoogleDrive-|Asia\/Taipei)\b/;
  const walk = async (d) => (await readdir(d, { withFileTypes: true })).flatMap((f) => f.isDirectory() ? [] : [path.join(d, f.name)]);
  const dirs = ['src', 'bin', 'ui'].map((d) => path.join(ROOT, d));
  const files = (await Promise.all(dirs.map(walk))).flat();
  const sampleFiles = [];
  const rec = async (d) => { for (const f of await readdir(d, { withFileTypes: true })) f.isDirectory() ? await rec(path.join(d, f.name)) : sampleFiles.push(path.join(d, f.name)); };
  await rec(SAMPLE);
  for (const f of [...files, ...sampleFiles]) assert.doesNotMatch(await readFile(f, 'utf8'), banned, f);
});

test('identity and secret helpers', () => {
  const ctx = { platform: '', agentRole: 'direct assistant', cfg: { platforms: ['Claude'] } };
  assert.ok(resolveIdentity(ctx, {}).errors.length);
  assert.equal(resolveIdentity(ctx, { ai_platform: 'Gemini' }).errors.length, 0);
  assert.deepEqual(findSecrets('plain text with 2026-10-18 date'), []);
  assert.ok(findSecrets('-----BEGIN OPENSSH PRIVATE KEY-----').length);
});

// ---- easy setup ----

test('Obsidian vaults are found from Obsidian settings; parent folders of several vaults are detected', async () => {
  const home = await tmp('obs');
  const root = path.join(home, 'Vaults');
  for (const v of ['Work', 'Life']) await mkdir(path.join(root, v, '.obsidian'), { recursive: true });
  const cfgFile = path.join(home, 'Library/Application Support/obsidian/obsidian.json');
  await mkdir(path.dirname(cfgFile), { recursive: true });
  await writeFile(cfgFile, JSON.stringify({ vaults: { a: { path: path.join(root, 'Work'), ts: 1 }, b: { path: path.join(root, 'Life'), ts: 2, open: true }, c: { path: path.join(root, 'Gone') } } }));
  const found = await findObsidianVaults({ home, os: 'darwin' });
  assert.deepEqual(found.map((v) => v.name), ['Life', 'Work']);
  assert.deepEqual((await nestedVaults(root)).sort(), ['Life', 'Work']);
  assert.deepEqual(await nestedVaults(path.join(root, 'Work')), []);
});

test('one-click setup: new brain, every found AI app connected; multi-vault folders refused', async () => {
  const home = await tmp('quick');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  for (const d of ['Library/Application Support/Claude', '.cursor', '.gemini']) await mkdir(path.join(home, d), { recursive: true });
  for (const v of ['A', 'B']) await mkdir(path.join(home, 'Parent', v, '.obsidian'), { recursive: true });
  const s = await startSetup({ env, home, os: 'darwin', port: 0, useCli: false });
  const api = (p, body) => fetch(`http://127.0.0.1:${s.port}${p}`, { method: body ? 'POST' : 'GET', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
  try {
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/health`).then((r) => r.json())).app, 'brainlink');
    const nested = await api('/api/quick', { mode: 'folder', path: path.join(home, 'Parent') });
    assert.equal(nested.ok, false);
    assert.deepEqual(nested.nested.map((n) => n.name).sort(), ['A', 'B']);
    const r = await api('/api/quick', { mode: 'new' });
    assert.equal(r.ok, true);
    assert.equal(r.path, path.join(home, 'Documents', 'My Brain'));
    assert.equal(r.phrase, 'Connect to Brain');
    assert.deepEqual(r.connected.sort(), ['Claude Desktop', 'Cursor', 'Gemini CLI']);
    assert.match(await readFile(path.join(r.path, 'BrainLink', 'Brain Role.md'), 'utf8'), /Brain/);
    assert.match(await readFile(path.join(r.path, 'BrainLink', 'Home.md'), 'utf8'), /generated_by: brainlink[\s\S]*\[\[Welcome\]\]/, 'Home map created at setup');
    const st = await api('/api/state');
    assert.equal(st.agents[0].name, 'Brain');
    // The brain works straight away in a connected AI: no licence, no trial, nothing to unlock.
    const ctx = createContext(normalize(JSON.parse(await readFile(path.join(home, 'app', 'config.json'), 'utf8'))), { env: { BRAINLINK_AI_PLATFORM: 'Claude' } });
    assert.equal(resolveAgent(ctx, 'Connect to my brain').name, 'Brain');
    const closed = await closeLoop(ctx, { agent: 'Close loop', title: 'First chat', source: 'chat', confidence: 'high', decisions: ['Try BrainLink'], confirm: true });
    assert.equal(closed.written, true);
  } finally { s.server.close(); }
});

test('CLI: `brainlink init` needs no licence and sets up writes and agents immediately', async () => {
  const home = await tmp('cli-init');
  const vault = path.join(home, 'Vault');
  await mkdir(vault, { recursive: true });
  const env = { ...process.env, BRAINLINK_HOME: path.join(home, 'app') };
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'brainlink.mjs'), 'init', '--vault', vault], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out}`))));
  });
  const cfg = JSON.parse(await readFile(path.join(home, 'app', 'config.json'), 'utf8'));
  assert.equal('license' in cfg, false);
  assert.equal('trial_started' in cfg, false);
  const ctx = createContext(normalize(cfg), { env: {} });
  assert.equal(ctx.readOnly, false);
  assert.equal(ctx.agents.length > 0, true);
});

// ---- smart features ----

import { stem, extractTags, findMentions, makeResolver } from '../src/graph.mjs';
import { remember, appendDaily } from '../src/writes.mjs';
import { recentNotes, openLoops, vaultHealth, brief } from '../src/insights.mjs';
import { buildHomeMap, suggestLinks, resolveNoteWikilinks } from '../src/links.mjs';
import { createServer as httpServer } from 'node:http';

test('stemming, tags, unlinked mentions, Obsidian-style link resolution', () => {
  assert.equal(stem('pricing'), stem('price'));
  assert.equal(stem('notes'), 'note');
  assert.equal(stem('strategies'), 'strategy');
  assert.deepEqual([...extractTags('Text #launch and #Q4/plan `#code`', { tags: '[client, "vip"]' })].sort(), ['client', 'launch', 'q4/plan', 'vip']);
  assert.deepEqual(findMentions('Call Northwind Coffee about the [[Strategy 2027]] and the coffee plan', ['Northwind Coffee', 'Strategy 2027', 'Coffee', 'Plan']), ['Northwind Coffee']);
  const notes = [{ rel: 'A/Spec.md', title: 'Spec' }, { rel: 'B/Spec.md', title: 'Spec' }, { rel: 'B/Other.md', title: 'Other' }];
  const r = makeResolver(notes);
  assert.equal(r('Spec', 'B/Other.md'), 1, 'same folder wins');
  assert.equal(r('A/Spec', 'B/Other.md'), 0, 'path suffix');
});

test('search: folder, date and #tag filters; rephrasings are fused', async () => {
  const { cfg, company } = await fixture();
  await writeFile(path.join(company, 'Projects/Launch Checklist.md'), '---\ndate: 2026-10-15\n---\n# Launch Checklist\n\n#launch tasks for go-live.');
  const ctx = ctxOf(cfg);
  const inClients = await search(ctx, 'Acme Studio', 'launch site', { folder: 'Clients' });
  assert.ok(inClients.length && inClients.every((x) => x.path.startsWith('Clients/')));
  const tagged = await search(ctx, 'Acme Studio', '#launch');
  assert.equal(tagged[0].path, 'Projects/Launch Checklist.md');
  assert.equal(tagged[0].match, 'tag');
  const recent = await search(ctx, 'Acme Studio', 'launch', { since: '2026-10-14' });
  assert.ok(recent.every((x) => x.date >= '2026-10-14'));
  const fused = await search(ctx, 'Acme Studio', 'go-live readiness', { queries: ['physiotherapy booking'] });
  assert.ok(fused.some((x) => x.path === 'Clients/Blue Harbor Clinic.md'), 'rephrasing finds the clinic');
});

test('meaning-based search with a local embedding model (fake Ollama)', async () => {
  const { cfg } = await fixture();
  const topics = [['coffee', 'espresso', 'roaster', 'beans', 'northwind', 'cafe'], ['clinic', 'physiotherapy', 'booking', 'patients', 'accessibility'], ['pricing', 'price', 'discount', 'invoice', 'fee']];
  const vec = (t) => { const w = t.toLowerCase(); return topics.map((ws) => ws.reduce((s, x) => s + (w.split(x).length - 1), 0) + 0.01); };
  const fake = httpServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }] }));
    const { input } = JSON.parse(body);
    res.end(JSON.stringify({ embeddings: input.map(vec) }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    const ctx = ctxOf(cfg, { BRAINLINK_SEMANTIC: '1', BRAINLINK_EMBED_URL: `http://127.0.0.1:${fake.address().port}` });
    const r = await search(ctx, 'Acme Studio', 'espresso');
    assert.ok(r.length, 'no keyword overlap, found by meaning');
    assert.match(r[0].path, /Northwind/);
    assert.equal(r[0].match, 'meaning');
    const g = await (createMcp(ctx).tools.find((t) => t.name === 'brainlink_guide').run());
    assert.match(g.search, /meaning \(local model nomic-embed-text/);
  } finally { fake.close(); }
});

test('auto-linking: new notes link what they mention plus similar notes, and the Home map links everything', async () => {
  const { cfg, company } = await fixture();
  const ctx = ctxOf(cfg);
  const r = await proposeNote(ctx, { vault: 'Acme Studio', folder: 'Projects', title: 'Subscription page', body: 'Plan the bean subscription page for Northwind Coffee. Shopify integration for subscriptions in phase 2.', source: 'chat', confirm: true }, NOW);
  assert.ok(r.linked_to.includes('Northwind Coffee'));
  const text = await readFile(path.join(company, 'Projects/2026-10-18 — Subscription page.md'), 'utf8');
  assert.match(text, /## Related\n\n- \[\[Northwind Coffee\]\] — mentioned here/);
  const home = await readFile(path.join(company, 'BrainLink/Home.md'), 'utf8');
  assert.match(home, /generated_by: brainlink/);
  assert.match(home, /\[\[Subscription page\]\]|\[\[2026-10-18 — Subscription page\]\]/);
  assert.match(home, /\[\[Strategy 2027\]\]/);
  // A user's own note at that path is never replaced.
  await writeFile(path.join(company, 'BrainLink/Home.md'), '# My own home');
  await proposeNote(ctx, { vault: 'Acme Studio', folder: 'Projects', title: 'Second', body: 'x', source: 's', confirm: true }, NOW);
  assert.equal(await readFile(path.join(company, 'BrainLink/Home.md'), 'utf8'), '# My own home');
  assert.match(await buildHomeMap(ctx, 'Acme Studio', NOW), /not linked to anything yet/);
});

test('P1b resolver: resolveNoteWikilinks resolves a real link, but a private note and an excluded-folder note are both just "not resolved" — indistinguishable from each other or a typo', async () => {
  const { cfg, company } = await fixture();
  await writeFile(path.join(company, 'Secret Note.md'), '---\nprivate: true\n---\n# Secret Note\n\nshh');
  await mkdir(path.join(company, '00 Home'), { recursive: true });
  await writeFile(path.join(company, '00 Home', 'Diary.md'), '# Diary\n\npersonal');
  await writeFile(path.join(company, '.brainlinkignore'), '00 Home/\n');
  const ctx = ctxOf(cfg);
  const index = await loadVault(ctx, 'Acme Studio');
  const body = 'See [[Northwind Coffee]], [[Secret Note]], [[Diary]], [[Totally Made Up Note]] and [[Northwind Coffee|the client]].';
  const links = resolveNoteWikilinks(index, body);
  assert.equal(links.length, 5);

  const real = links[0];
  assert.equal(real.target, 'Northwind Coffee');
  assert.ok(real.resolved && real.resolved.path && real.resolved.title === 'Northwind Coffee');

  const privateLink = links[1];
  assert.equal(privateLink.target, 'Secret Note');
  assert.equal(privateLink.resolved, null);

  const excludedLink = links[2];
  assert.equal(excludedLink.target, 'Diary');
  assert.equal(excludedLink.resolved, null);

  const deadLink = links[3];
  assert.equal(deadLink.target, 'Totally Made Up Note');
  assert.equal(deadLink.resolved, null);
  // Private, excluded and dead all come back exactly `null` — no extra field (e.g. a reason, or
  // the real path) that could let a reader tell a private note from one that never existed.
  assert.deepEqual(new Set([privateLink.resolved, excludedLink.resolved, deadLink.resolved]), new Set([null]));

  // An alias (`|the client`) uses the alias as the display label but still resolves the real target.
  const aliased = links[4];
  assert.equal(aliased.target, 'Northwind Coffee');
  assert.equal(aliased.label, 'the client');
  assert.ok(aliased.resolved);
});

test('P1b resolver over HTTP: /api/note returns wikilinks resolved the same way, private/dead both null, and never exposes a private note\'s real path', async () => {
  const { cfg, company } = await fixture();
  await writeFile(path.join(company, 'Secret Note.md'), '---\nprivate: true\n---\n# Secret Note\n\nshh');
  await writeFile(path.join(company, 'Cites Things.md'), 'Mentions [[Northwind Coffee]] and [[Secret Note]] and [[Nope]].');
  const home = await tmp('p1b-note-api');
  const env = { BRAINLINK_HOME: home };
  await saveConfig(cfg, path.join(home, 'config.json'));
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/api/note`, {
      method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vault: 'Acme Studio', path: 'Cites Things.md' }),
    }).then((x) => x.json());
    assert.equal(r.wikilinks.length, 3);
    assert.ok(r.wikilinks[0].resolved?.path === 'Northwind Coffee.md' || r.wikilinks[0].resolved?.title === 'Northwind Coffee');
    assert.equal(r.wikilinks[1].resolved, null);
    assert.equal(r.wikilinks[2].resolved, null);
    assert.ok(!JSON.stringify(r).includes('Secret Note.md'), 'the private note\'s real path must never appear in the response');
  } finally { s.server.close(); }
});

test('templates: meeting note with linked attendees, tasks and its own folder', async () => {
  const { cfg, company } = await fixture();
  await mkdir(path.join(company, 'Meetings'));
  const ctx = ctxOf(cfg);
  const r = await proposeNote(ctx, { vault: 'Acme Studio', template: 'meeting', title: 'Northwind launch sync', source: 'transcript', fields: { date: '2026-10-18', attendees: ['Dana', 'Sam'], summary: 'Reviewed the Northwind Launch Site timeline.', decisions: ['Launch Nov 3'], action_items: ['Sam — book QA — Oct 30'] }, confirm: true }, NOW);
  assert.equal(r.path, 'Acme Studio/Meetings/2026-10-18 — Northwind launch sync.md');
  const t = await readFile(path.join(company, 'Meetings/2026-10-18 — Northwind launch sync.md'), 'utf8');
  assert.match(t, /\*\*Attendees:\*\* \[\[Dana\]\], \[\[Sam\]\]/);
  assert.match(t, /- \[ \] Sam — book QA — Oct 30/);
  assert.match(t, /type: meeting/);
  assert.match(t, /\[\[Northwind Launch Site\]\] — mentioned here/);
  const loops = await openLoops(ctx, 'Acme Studio');
  assert.ok(loops.tasks.some((x) => /book QA/.test(x.task)));
});

test('remember, daily note, open loops, recent, health and brief', async () => {
  const { cfg, company } = await fixture();
  await mkdir(path.join(company, '.obsidian'), { recursive: true });
  await writeFile(path.join(company, '.obsidian/daily-notes.json'), JSON.stringify({ folder: 'Journal/Daily', format: 'YYYY-MM-DD' }));
  await writeFile(path.join(company, 'Lonely.md'), '# Lonely\n\nNo links here, and a [[Missing Note]].');
  const ctx = ctxOf(cfg);
  const m1 = await remember(ctx, { vault: 'Acme Studio', facts: ['Founder prefers short answers.', 'Founder uses markdown _(literal)_'], source: 'Ian stated this preference in planning', confirm: true }, NOW);
  assert.equal(m1.written, true);
  const memoryNote = await readFile(path.join(company, 'BrainLink', 'Memories.md'), 'utf8');
  assert.match(memoryNote, /source: "Ian stated this preference in planning"; confidence: reported/);
  assert.equal((await remember(ctx, { vault: 'Acme Studio', fact: 'No source', source: { private: true }, confirm: true }, NOW)).ok, false);
  assert.equal((await remember(ctx, { vault: 'Acme Studio', fact: 'No source', source: 'x'.repeat(301), confirm: true }, NOW)).ok, false);
  assert.equal((await remember(ctx, { vault: 'Acme Studio', fact: 'founder prefers short answers', confirm: true }, NOW)).written, false, 'duplicates skipped');
  const d = await appendDaily(ctx, { vault: 'Acme Studio', text: 'Called the printer', confirm: true }, NOW);
  assert.equal(d.path, 'Acme Studio/Journal/Daily/2026-10-18.md');
  assert.match(await readFile(path.join(company, 'Journal/Daily/2026-10-18.md'), 'utf8'), /- 09:30 Called the printer _\(Claude\)_/);
  const loops = await openLoops(ctx, 'Acme Studio', { days: 3650 });
  assert.ok(loops.next_actions.some((x) => /booking vendor/.test(x.action)), JSON.stringify(loops));
  const rec = await recentNotes(ctx, 'Acme Studio', { days: 1 });
  assert.ok(rec.some((x) => x.title === 'Lonely'));
  const h = await vaultHealth(ctx, 'Acme Studio');
  assert.ok(h.orphans.some((o) => o.title === 'Lonely'));
  assert.ok(h.broken_links.some((b) => b.target === 'Missing Note'));
  const b = await brief(ctx, 'Acme Studio');
  assert.ok(b.changed.length && b.health.notes > 10 && 'open_loops' in b);
  const c = await connectAgent(ctx, { agent: 'Chief of Staff' });
  assert.ok(c.memories.includes('Founder prefers short answers.'));
  assert.ok(c.memories.includes('Founder uses markdown _(literal)_'), 'metadata parsing preserves fact text that resembles a legacy metadata suffix');
  assert.ok(c.whats_new.length);
  assert.ok(c.open_loops.counts);
});

test('close-loop captures link the notes they are about', async () => {
  const { cfg, company } = await fixture();
  const r = await closeLoop(ctxOf(cfg), { agent: 'Chief of Staff', title: 'Clinic follow-up', source: 'chat', confidence: 'high', decisions: ['Blue Harbor Clinic picks a booking vendor this week'], confirm: true }, NOW);
  assert.ok(r.linked_to.includes('Blue Harbor Clinic'));
  assert.match(await readFile(path.join(company, 'Chief of Staff Office/Session Captures.md'), 'utf8'), /- \*\*Related:\*\* \[\[Blue Harbor Clinic\]\]/);
});

test('shared commands from BrainLink/Commands appear as prompts in every AI', async () => {
  const { cfg } = await fixture();
  const mcp = createMcp(ctxOf(cfg));
  const list = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'prompts/list' })).result.prompts.map((p) => p.name);
  for (const n of ['cmd-weekly-review', 'cmd-meeting-notes', 'cmd-link-my-notes', 'brief', 'remember']) assert.ok(list.includes(n), n);
  const got = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'cmd-meeting-notes', arguments: { input: 'Dana: launch moved to Nov 3' } } });
  assert.match(got.result.messages[0].content.text, /template "meeting"[\s\S]*Dana: launch moved to Nov 3/);
  const tools = (await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools.map((t) => t.name);
  for (const n of ['vault_recent', 'open_loops', 'brain_brief', 'vault_health', 'remember', 'append_daily']) assert.ok(tools.includes(n), n);
});

// ---- Windows code paths (run here with os = 'win32') ----

import { appHome } from '../src/config.mjs';
import { obsidianConfigPath } from '../src/obsidian.mjs';
import { CLIENTS } from '../src/connectors.mjs';

test('Windows: app data, Obsidian and every AI client resolve to their Windows locations', () => {
  const home = 'C:/Users/Ana', env = { APPDATA: 'C:/Users/Ana/AppData/Roaming' };
  assert.equal(appHome(env, 'win32', home), path.join(env.APPDATA, 'BrainLink'));
  assert.equal(obsidianConfigPath({ home, os: 'win32', env }), path.join(env.APPDATA, 'obsidian', 'obsidian.json'));
  const files = Object.fromEntries(Object.entries(CLIENTS).map(([id, c]) => [id, c.file({ home, os: 'win32', env })]));
  assert.equal(files['claude-desktop'], path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json'));
  assert.equal(files.cursor, path.join(home, '.cursor', 'mcp.json'));
  assert.equal(files.codex, path.join(home, '.codex', 'config.toml'));
  assert.equal(files.gemini, path.join(home, '.gemini', 'settings.json'));
  assert.equal(appHome({}, 'win32', home), path.join(home, 'AppData', 'Roaming', 'BrainLink'));
});

test('Windows: one-click setup connects apps with node.exe paths, and disconnect-all removes them', async () => {
  const home = await tmp('win');
  const env = { BRAINLINK_HOME: path.join(home, 'AppData/Roaming/BrainLink'), APPDATA: path.join(home, 'AppData/Roaming'), BRAINLINK_SEMANTIC: '0', BRAINLINK_LAUNCHER: 'C:\\Users\\Ana\\AppData\\Local\\Programs\\BrainLink\\bin\\brainlink.cmd' };
  await mkdir(path.join(env.APPDATA, 'Claude'), { recursive: true });
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await writeFile(path.join(home, '.codex/config.toml'), 'model = "gpt-5"\n');
  const s = await startSetup({ env, home, os: 'win32', port: 0, useCli: false });
  const api = (p, body) => fetch(`http://127.0.0.1:${s.port}${p}`, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  try {
    const r = await api('/api/quick', { mode: 'new' });
    assert.deepEqual(r.connected.sort(), ['ChatGPT Codex', 'Claude Desktop']);
    const claude = JSON.parse(await readFile(path.join(env.APPDATA, 'Claude/claude_desktop_config.json'), 'utf8'));
    assert.equal(claude.mcpServers.brainlink.command, env.BRAINLINK_LAUNCHER);
    assert.match(await readFile(path.join(home, '.codex/config.toml'), 'utf8'), /command = "C:\\\\Users\\\\Ana\\\\AppData\\\\Local\\\\Programs\\\\BrainLink\\\\bin\\\\brainlink.cmd"/);
  } finally { s.server.close(); }
  const { disconnectClient: dc, detect: dt } = await import('../src/connectors.mjs');
  const opts = { home, os: 'win32', env, launch: { command: 'x', args: [] }, useCli: false };
  for (const [id, c] of Object.entries(await dt(opts))) if (c.connected) await dc(id, opts);
  assert.equal(Object.values(await dt(opts)).some((c) => c.connected), false);
  assert.match(await readFile(path.join(home, '.codex/config.toml'), 'utf8'), /^model = "gpt-5"/);
});

// ---- Linux code paths ----

test('Linux: XDG config, Claude Desktop path, and Obsidian found in native, Flatpak and Snap installs', { skip: process.platform !== 'linux' }, async () => {
  const home = await tmp('linux');
  assert.equal(appHome({}, 'linux', home), path.join(home, '.config', 'brainlink'));
  assert.equal(appHome({ XDG_CONFIG_HOME: '/x' }, 'linux', home), '/x/brainlink');
  assert.equal(CLIENTS['claude-desktop'].file({ home, os: 'linux', env: {} }), path.join(home, '.config', 'Claude', 'claude_desktop_config.json'));
  const mk = async (rel, vaultName) => {
    const v = path.join(home, vaultName); await mkdir(v, { recursive: true });
    const f = path.join(home, rel); await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify({ vaults: { [vaultName]: { path: v, ts: 1 } } }));
  };
  await mk('.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json', 'Flatpak Vault');
  await mk('snap/obsidian/current/.config/obsidian/obsidian.json', 'Snap Vault');
  const found = await findObsidianVaults({ home, os: 'linux', env: {} });
  assert.deepEqual(found.map((v) => v.name).sort(), ['Flatpak Vault', 'Snap Vault']);
  assert.deepEqual(await findObsidianVaults({ home, os: 'darwin', env: {} }), [], 'Flatpak/Snap paths are Linux-only');
});

test('.brainlinkignore hides folders (e.g. sample vaults inside stored source code) from search', async () => {
  const { cfg, company } = await fixture();
  await mkdir(path.join(company, 'Projects/Tool/source/samples'), { recursive: true });
  await writeFile(path.join(company, 'Projects/Tool/source/samples/Fake.md'), '# Fake\n\nzebracorn pricing');
  await writeFile(path.join(company, 'Projects/Tool/source/README.md'), '# Tool readme\n\nzebracorn build notes');
  await writeFile(path.join(company, 'Projects/Tool/source/.brainlinkignore'), '# fictional sample notes\nsamples/\n*.tmp\n');
  await mkdir(path.join(company, 'Archive'));
  await writeFile(path.join(company, 'Archive/Old.md'), '# Old\n\nzebracorn');
  await writeFile(path.join(company, 'Archive/.brainlinkignore'), '*\n');
  const r = await search(ctxOf(cfg), 'Acme Studio', 'zebracorn');
  assert.deepEqual(r.map((x) => x.path), ['Projects/Tool/source/README.md']);
});

test('P0-2: a root .brainlinkignore exclusion applies at any depth, not only to its own directory\'s direct children', async () => {
  const { cfg, company } = await fixture();
  await writeFile(path.join(company, '.brainlinkignore'), '00 Home/\n');
  await mkdir(path.join(company, 'sub', '00 Home'), { recursive: true });
  await writeFile(path.join(company, 'sub', '00 Home', 'x.md'), 'zebracorn nested personal notes');
  await writeFile(path.join(company, 'sub', 'Visible.md'), '# Visible\n\nzebracorn visible notes');

  // index / search
  const r = await search(ctxOf(cfg), 'Acme Studio', 'zebracorn');
  assert.ok(!r.some((x) => x.path.includes('00 Home')), JSON.stringify(r));
  assert.ok(r.some((x) => x.path === 'sub/Visible.md'));

  // graph (/api/graph)
  const env = { BRAINLINK_HOME: await tmp('p02-graph-home'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home: await tmp('p02-graph'), os: 'darwin', port: 0, useCli: false });
  const api = (p, body) => fetch(`http://127.0.0.1:${s.port}${p}`, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  try {
    await api('/api/vault', { path: company, name: 'Acme Studio', pack: 'simple', scaffold: false });
    const g = await (await api('/api/graph', { vault: 'Acme Studio' })).json();
    assert.ok(!g.nodes.some((n) => n.title === 'x'), JSON.stringify(g.nodes));
  } finally { s.server.close(); }

  // snapshot
  const dest = await tmp('p02-snapshot-dest');
  const snapEnv = { BRAINLINK_HOME: await tmp('p02-snapshot-home'), BRAINLINK_SEMANTIC: '0' };
  const ctx = ctxOf(cfg, snapEnv);
  const { chooseSnapshot, writeSnapshotOnce } = await import('../src/snapshot.mjs');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  await writeSnapshotOnce(ctx, withSnapshot, snapEnv);
  const { existsSync } = await import('node:fs');
  assert.ok(!existsSync(path.join(dest, 'BrainLink Shared', 'Acme Studio', 'sub', '00 Home')), 'nested excluded folder never reaches the snapshot');
  assert.ok(existsSync(path.join(dest, 'BrainLink Shared', 'Acme Studio', 'sub', 'Visible.md')));
});

test('default .brainlinkignore: shipped on a fresh real vault, never overwrites one already there, folders stay out of search and answers', async () => {
  const home = await tmp('excluded');
  const vaultDir = path.join(home, 'Notes');
  await mkdir(vaultDir, { recursive: true });
  assert.equal(await ensureDefaultIgnore(vaultDir), true);
  const shipped = await readFile(path.join(vaultDir, '.brainlinkignore'), 'utf8');
  for (const f of DEFAULT_EXCLUDED_FOLDERS) assert.match(shipped, new RegExp(f.replace('/', '\\/')));
  for (const f of SUGGESTED_EXCLUDED_FOLDERS) assert.match(shipped, new RegExp(`#\\s*${f.replace('/', '\\/')}`));
  assert.equal(await ensureDefaultIgnore(vaultDir), false, 'never overwrites an existing .brainlinkignore');

  // A vault that actually has the shipped default folders: their notes never surface.
  const company = path.join(home, 'Acme Studio');
  await cp(SAMPLE, company, { recursive: true });
  await ensureDefaultIgnore(company);
  await mkdir(path.join(company, '00 Home'));
  await writeFile(path.join(company, '00 Home/Diary.md'), '# Diary\n\nzebracorn personal notes');
  await mkdir(path.join(company, 'finance'));
  await writeFile(path.join(company, 'finance/Taxes.md'), '# Taxes\n\nzebracorn bank numbers');
  let cfg = normalize({ timezone: 'Asia/Taipei' });
  const built = buildPack('simple', { vaultName: 'Acme Studio', vaultPath: company });
  await scaffold(company, built.scaffold);
  cfg = normalize(mergePack(cfg, built));
  const r = await search(ctxOf(cfg), 'Acme Studio', 'zebracorn');
  assert.deepEqual(r.map((x) => x.path), ['finance/Taxes.md']); // "finance/" is a suggestion only (commented out) until the user opts in; "00 Home/" is excluded by default
  const read = await readExcludedFolders(company);
  assert.deepEqual(read.active, DEFAULT_EXCLUDED_FOLDERS);
  assert.deepEqual(read.suggested, SUGGESTED_EXCLUDED_FOLDERS);
  await writeExcludedFolders(company, [...DEFAULT_EXCLUDED_FOLDERS, 'finance/']);
  const r2 = await search(ctxOf(cfg), 'Acme Studio', 'zebracorn');
  assert.deepEqual(r2.map((x) => x.path), []); // still none: "00 Home" and now "finance" are both excluded
});

test('setup UI: connecting a real vault ships default excluded folders; private flag and excluded folders are editable after connecting', async () => {
  const home = await tmp('setup-excluded');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const vaultDir = path.join(home, 'Notes');
  await cp(SAMPLE, vaultDir, { recursive: true });
  const s = await startSetup({ env, home, os: 'darwin', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (method, p, body) => fetch(base + p, { method, headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    const stateBefore = await (await api('GET', '/api/state')).json();
    assert.deepEqual(stateBefore.default_excluded_folders, DEFAULT_EXCLUDED_FOLDERS);
    assert.deepEqual(stateBefore.suggested_excluded_folders, SUGGESTED_EXCLUDED_FOLDERS);
    const add = await (await api('POST', '/api/vault', { path: vaultDir, name: 'Acme', pack: 'founder-os', private: true })).json();
    assert.equal(add.ok, true);
    const shipped = await readFile(path.join(vaultDir, '.brainlinkignore'), 'utf8');
    for (const f of DEFAULT_EXCLUDED_FOLDERS) assert.match(shipped, new RegExp(f.replace('/', '\\/')));
    const st = await (await api('GET', '/api/state')).json();
    assert.equal(st.vaults[0].private, true);
    assert.deepEqual(st.vaults[0].excluded_folders, DEFAULT_EXCLUDED_FOLDERS);
    assert.deepEqual(st.vaults[0].excluded_suggestions, SUGGESTED_EXCLUDED_FOLDERS);
    // Editable afterwards, independent of the connect step.
    const priv = await (await api('POST', '/api/vault/private', { name: 'Acme', private: false })).json();
    assert.equal(priv.private, false);
    const excl = await (await api('POST', '/api/vault/excluded', { name: 'Acme', folders: ['.obsidian/', 'finance/'] })).json();
    assert.deepEqual(excl.excluded_folders, ['.obsidian/', 'finance/']);
    const stAfter = await (await api('GET', '/api/state')).json();
    assert.equal(stAfter.vaults[0].private, false);
    assert.deepEqual(stAfter.vaults[0].excluded_folders, ['.obsidian/', 'finance/']);
  } finally { s.server.close(); }
});
