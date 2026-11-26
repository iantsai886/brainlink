import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalize, saveConfig } from '../src/config.mjs';
import { createContext, loadVault, readNote, searchWithVerdict } from '../src/core.mjs';
import { buildAnswerReceipt } from '../src/answer-receipt.mjs';
import { buildContextPacket } from '../src/context-packet.mjs';
import { createMcp } from '../src/server.mjs';
import { startSetup } from '../src/setup.mjs';

const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-rag-s2-${p}-`));

async function makeWikiVault() {
  const dir = await tmp('wiki-vault');
  const home = await tmp('wiki-home');
  await mkdir(path.join(dir, '20 Iango', 'Policies'), { recursive: true });
  await mkdir(path.join(dir, '90 Noise'), { recursive: true });
  await mkdir(path.join(dir, '00 Home'), { recursive: true });

  await writeFile(path.join(dir, '.brainlinkignore'), '.obsidian/\n00 Home/\n');

  await writeFile(path.join(dir, '00 MAP.md'), [
    '---',
    'type: index',
    'status: active',
    '---',
    '# 00 MAP — Brain',
    '',
    '## Entry notes',
    '',
    '| Title | Drive id/URL | Summary | Status | Updated | Superseded by |',
    '|---|---|---|---|---|---|',
    '| [Secret Private Note](<Secret Private Note.md>) | — | Contains PRIVWIKICANARY confidential token. | active | 2026-11-20 | — |',
    '| [Home Excluded Note](<00 Home/Home Excluded Note.md>) | — | Contains EXCLWIKICANARY personal diary. | active | 2026-11-20 | — |',
    '| [Vault Access Rule](<Vault Access Rule.md>) | — | Canonical rule for AI vault attribution and Made by line. | active | 2026-11-20 | — |',
    '',
    '## Folders',
    '',
    '| Folder | Index | Drive id/URL | Summary | Updated |',
    '|---|---|---|---|---|',
    '| `20 Iango/` | [00 INDEX — 20 Iango](<20 Iango/00 INDEX.md>) | — | Company policies, reporting hierarchy, decision queue rules, and client projects. | 2026-11-20 |',
    '| `90 Noise/` | [00 INDEX — 90 Noise](<90 Noise/00 INDEX.md>) | — | Miscellaneous scratch drafts. | 2026-11-20 |',
    '| `00 Home/` | [00 INDEX — 00 Home](<00 Home/00 INDEX.md>) | — | Excluded personal home folder. | 2026-11-20 |',
  ].join('\n'));

  await writeFile(path.join(dir, 'Vault Access Rule.md'), [
    '---',
    'status: active',
    'confidence: verified',
    '---',
    '# Vault Access Rule',
    '',
    '## Attribution',
    'Every AI-written note must include Made by {ai_platform} ({agent_or_role}).',
  ].join('\n'));

  await writeFile(path.join(dir, 'Secret Private Note.md'), [
    '---',
    'private: true',
    'status: active',
    '---',
    '# Secret Private Note',
    '',
    'This note holds PRIVWIKICANARY and must never leak.',
  ].join('\n'));

  await writeFile(path.join(dir, '00 Home', 'Home Excluded Note.md'), [
    '---',
    'status: active',
    '---',
    '# Home Excluded Note',
    '',
    'This note holds EXCLWIKICANARY inside an ignored folder.',
  ].join('\n'));

  await writeFile(path.join(dir, '20 Iango', '00 INDEX.md'), [
    '---',
    'type: index',
    'status: active',
    '---',
    '# 00 INDEX — 20 Iango',
    '',
    '## 20 Iango/Policies',
    '',
    '| Title | Drive id/URL | Summary | Status | Updated | Superseded by |',
    '|---|---|---|---|---|---|',
    '| [Governance Charter](<Policies/Governance Charter.md>) | — | Chairman Decision Queue rule: at most seven items; Repo Keeper ownership list. | active | 2026-11-20 | — |',
    '| [Old Release Rule](<Policies/Old Release Rule.md>) | — | Legacy deployment checklist for canary rollouts. | historical | 2026-10-01 | [Current Release Rule](<Policies/Current Release Rule.md>) |',
    '| [Current Release Rule](<Policies/Current Release Rule.md>) | — | Active deployment checklist for release rollouts. | active | 2026-11-19 | — |',
    '| [Ghost Note](<Policies/Ghost Note.md>) | — | Nonexistent note that must never be invented. | active | 2026-11-20 | — |',
  ].join('\n'));

  await writeFile(path.join(dir, '20 Iango', 'Policies', 'Governance Charter.md'), [
    '---',
    'status: active',
    'confidence: verified',
    '---',
    '# Governance Charter',
    '',
    '## Queue Policy',
    'Maintain one queue of at most seven items awaiting review.',
    '',
    '## Repository Ownership',
    'Repo Keeper reports to Paulo and owns brainlink.',
  ].join('\n'));

  await writeFile(path.join(dir, '20 Iango', 'Policies', 'Old Release Rule.md'), [
    '---',
    'status: historical',
    'superseded_by: 20 Iango/Policies/Current Release Rule.md',
    '---',
    '# Old Release Rule',
    '',
    'Legacy deployment checklist for canary rollouts.',
  ].join('\n'));

  await writeFile(path.join(dir, '20 Iango', 'Policies', 'Current Release Rule.md'), [
    '---',
    'status: active',
    'confidence: verified',
    '---',
    '# Current Release Rule',
    '',
    '## Release Checklist',
    'Verify tests and build signed installers before release rollouts.',
  ].join('\n'));

  await writeFile(path.join(dir, '90 Noise', '00 INDEX.md'), [
    '---',
    'type: index',
    'status: active',
    '---',
    '# 00 INDEX — 90 Noise',
    '',
    '## 90 Noise/ (top level)',
    '',
    '| Title | Drive id/URL | Summary | Status | Updated | Superseded by |',
    '|---|---|---|---|---|---|',
    '| [Random Notes](<Random Notes.md>) | — | Unrelated scratchpad. | active | 2026-11-20 | — |',
  ].join('\n'));

  await writeFile(path.join(dir, '90 Noise', 'Random Notes.md'), [
    '---',
    'status: draft',
    '---',
    '# Random Notes',
    '',
    'Someone asked about the Chairman Decision Queue rule once in a meeting, plus random decision queue chatter and decision queue ideas.',
  ].join('\n'));

  const cfg = normalize({ vaults: [{ name: 'Brain', path: dir }], mcp: { tool_profile: 'full' } });
  const env = { BRAINLINK_HOME: home, BRAINLINK_SEMANTIC: '0' };
  const ctx = createContext(cfg, { env, trustedLocal: true });
  return { dir, home, cfg, env, ctx };
}

test('S2: MAP/INDEX wiki stage boosts indexed target note over noisy draft and reports wiki_layer metadata', async () => {
  const { ctx } = await makeWikiVault();
  const withWiki = await searchWithVerdict(ctx, 'Brain', 'Chairman Decision Queue rule', { limit: 5, semantic: false });
  assert.equal(withWiki.wiki_layer?.present, true);
  assert.equal(withWiki.wiki_layer?.consulted, true);
  assert.equal(withWiki.results[0]?.path, '20 Iango/Policies/Governance Charter.md');

  const receipt = buildAnswerReceipt(withWiki, { vault: 'Brain' });
  assert.equal(receipt.wiki_layer?.present, true);
  assert.equal(receipt.wiki_layer?.consulted, true);

  const withoutWiki = await searchWithVerdict(ctx, 'Brain', 'Chairman Decision Queue rule', { limit: 5, semantic: false, wiki: false });
  assert.equal(withoutWiki.wiki_layer?.present, true);
  assert.equal(withoutWiki.wiki_layer?.consulted, false);
});

test('S2: wiki layer follows superseded_by and prefers replacement over retired note', async () => {
  const { ctx } = await makeWikiVault();
  const res = await searchWithVerdict(ctx, 'Brain', 'deployment checklist canary rollouts', { limit: 5, semantic: false });
  assert.equal(res.wiki_layer?.consulted, true);
  assert.equal(res.results[0]?.path, '20 Iango/Policies/Current Release Rule.md');
  assert.ok(!res.wiki_layer.matched_entries.includes('20 Iango/Policies/Old Release Rule.md'));
});

test('S2: privacy & exclusion gate — MAP/INDEX chunks never expose restricted titles or canaries on any surface (full content checked)', async () => {
  const { home, cfg, env, ctx } = await makeWikiVault();
  const index = await loadVault(ctx, 'Brain');
  const forbidden = ['Secret Private Note', 'Home Excluded Note', 'PRIVWIKICANARY', 'EXCLWIKICANARY'];

  // 1. No indexed chunk may come from 00 MAP.md / 00 INDEX.md or carry restricted titles/canaries.
  for (const chunk of index.chunks) {
    const note = index.notes[chunk.noteIdx];
    assert.ok(!/^(?:00 MAP\.md|[^/]+\/00 INDEX\.md)$/i.test(note.rel), `MAP/INDEX chunk should not be indexed: ${note.rel}`);
    for (const marker of forbidden) {
      assert.ok(!chunk.text.includes(marker), `indexed chunk leaked ${marker} via ${note.rel}`);
    }
  }

  const mcp = createMcp(ctx);
  await mkdir(home, { recursive: true });
  await saveConfig(cfg, path.join(home, 'config.json'));
  const setup = await startSetup({ env, home: await tmp('s2-priv-userhome'), os: 'win32', port: 0, openUrl: null, useCli: false });
  try {
    for (const query of ['PRIVWIKICANARY confidential token', 'EXCLWIKICANARY personal diary', 'Secret Private Note', 'Home Excluded Note']) {
      for (const wiki of [false, true]) {
        const res = await searchWithVerdict(ctx, 'Brain', query, { limit: 5, semantic: false, wiki });
        assert.equal(res.status, 'not_in_brain', `expected not_in_brain for "${query}" (wiki=${wiki}), got ${res.status}`);
        assert.equal(res.results.length, 0, `expected 0 results for "${query}" (wiki=${wiki}), got ${JSON.stringify(res.results.map((r) => r.path))}`);
        const receipt = buildAnswerReceipt(res, { vault: 'Brain' });
        const packet = buildContextPacket(res, { vault: 'Brain' });
        const serialized = JSON.stringify({ res, receipt, packet });
        for (const marker of forbidden) assert.ok(!serialized.includes(marker), `leaked ${marker} in core search (${query})`);
      }

      for (const detail of ['compact', 'full']) {
        const vs = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vault_search', arguments: { vault: 'Brain', query, detail } } });
        const payload = JSON.parse(vs.result.content[0].text);
        assert.equal(payload.results.length, 0, `vault_search(${detail}) returned hits for "${query}"`);
        for (const marker of forbidden) assert.ok(!vs.result.content[0].text.includes(marker), `vault_search(${detail}) leaked ${marker}`);
      }

      const cp = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'context_packet', arguments: { vault: 'Brain', query } } });
      const cpPayload = JSON.parse(cp.result.content[0].text);
      assert.equal(cpPayload.sources.length, 0, `context_packet returned sources for "${query}"`);
      for (const marker of forbidden) assert.ok(!cp.result.content[0].text.includes(marker), `context_packet leaked ${marker}`);

      const conn = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { query } } });
      const connPayload = JSON.parse(conn.result.content[0].text);
      assert.equal(connPayload.results.length, 0, `connector search returned hits for "${query}"`);
      for (const marker of forbidden) assert.ok(!conn.result.content[0].text.includes(marker), `connector search leaked ${marker}`);

      const askRes = await fetch(`http://127.0.0.1:${setup.port}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': setup.token },
        body: JSON.stringify({ vault: 'Brain', query }),
      });
      assert.equal(askRes.status, 200);
      const askBody = await askRes.json();
      assert.equal(askBody.sources.length, 0, `POST /api/ask returned sources for "${query}"`);
      const { query: _echoedQuery, ...askOutput } = askBody;
      const askSerialized = JSON.stringify(askOutput);
      for (const marker of forbidden) assert.ok(!askSerialized.includes(marker), `POST /api/ask leaked ${marker}`);
    }

    // Also verify full body of every hit returned for a legitimate query never exposes restricted titles.
    const legit = await searchWithVerdict(ctx, 'Brain', 'Vault Access Rule attribution', { limit: 5, semantic: false });
    assert.ok(legit.results.length >= 1);
    for (const hit of legit.results) {
      assert.ok(!/^(?:00 MAP\.md|[^/]+\/00 INDEX\.md)$/i.test(hit.path), `MAP/INDEX should not be returned as hit: ${hit.path}`);
      const fullNote = await readNote(ctx, 'Brain', hit.path);
      for (const marker of forbidden) assert.ok(!fullNote.body.includes(marker), `full body of ${hit.path} leaked ${marker}`);
    }
  } finally {
    setup.server.close();
  }
});

test('S2: wiki layer never invents missing notes and reports absent when vault has no MAP/INDEX', async () => {
  const { ctx } = await makeWikiVault();
  const ghost = await searchWithVerdict(ctx, 'Brain', 'Ghost Note nonexistent', { limit: 5, semantic: false });
  assert.ok(!ghost.results.some((r) => r.path.includes('Ghost Note')));
  assert.ok(!(ghost.wiki_layer?.matched_entries || []).some((p) => p.includes('Ghost Note')));

  const plainDir = await tmp('plain-vault');
  const plainHome = await tmp('plain-home');
  await writeFile(path.join(plainDir, 'Alpha.md'), '# Alpha\n\nSimple note about architecture.\n');
  const plainCfg = normalize({ vaults: [{ name: 'Plain', path: plainDir }] });
  const plainCtx = createContext(plainCfg, { env: { BRAINLINK_HOME: plainHome, BRAINLINK_SEMANTIC: '0' }, trustedLocal: true });
  const plain = await searchWithVerdict(plainCtx, 'Plain', 'architecture', { limit: 5, semantic: false });
  assert.equal(plain.results[0]?.path, 'Alpha.md');
  assert.equal(plain.wiki_layer?.present, false);
  assert.equal(plain.wiki_layer?.consulted, false);
});

test('S2: abstention gate — reaches sensitiveQuery guard directly (no missing_words, coverage >= 0.4) and does not false-refuse answerable queries', async () => {
  const { dir, ctx } = await makeWikiVault();
  // Ensure every query word exists in the indexed vault so missing_words is empty and coverage >= 0.4,
  // proving the sensitiveQuery guard itself (not missing_words) downgrades status from hits -> not_in_brain.
  await writeFile(path.join(dir, '20 Iango', 'WeiMa Pilot Audit.md'), '# WeiMa Pilot Audit\n\nShared WeiMa pilot folder current access review completed. Password and credential storage is forbidden here.\n');
  await writeFile(path.join(dir, '20 Iango', 'John Finance Move Pack.md'), '# John Finance Move Pack\n\nMoved John Personal Finance Workboard out of Brain. Current account balance numbers shown there are out of scope.\n');
  for (const wiki of [false, true]) {
    const q1 = await searchWithVerdict(ctx, 'Brain', 'What is the shared WeiMa pilot folder current access password or credential?', { limit: 5, semantic: false, wiki });
    assert.equal(q1.missing_words, undefined, `expected no missing_words so sensitiveQuery guard is exercised (wiki=${wiki})`);
    assert.ok(q1.coverage >= 0.4, `expected coverage >= 0.4, got ${q1.coverage}`);
    assert.equal(q1.status, 'not_in_brain', `expected sensitiveQuery guard to return not_in_brain (wiki=${wiki})`);

    const q2 = await searchWithVerdict(ctx, 'Brain', 'What is the current account balance shown in John Personal Finance Workboard?', { limit: 5, semantic: false, wiki });
    assert.equal(q2.missing_words, undefined, `expected no missing_words so sensitiveQuery guard is exercised (wiki=${wiki})`);
    assert.ok(q2.coverage >= 0.4, `expected coverage >= 0.4, got ${q2.coverage}`);
    assert.equal(q2.status, 'not_in_brain', `expected sensitiveQuery guard to return not_in_brain (wiki=${wiki})`);

    // False-refusal check: legitimate answerable queries on adjacent topics must still return hits.
    const ok1 = await searchWithVerdict(ctx, 'Brain', 'What is the Vault Access Rule for attribution?', { limit: 5, semantic: false, wiki });
    assert.equal(ok1.status, 'hits', `false refusal on answerable access rule query (wiki=${wiki})`);
    assert.equal(ok1.results[0]?.path, 'Vault Access Rule.md');

    const ok2 = await searchWithVerdict(ctx, 'Brain', 'Where did the move pack move John Personal Finance Workboard?', { limit: 5, semantic: false, wiki });
    assert.equal(ok2.status, 'hits', `false refusal on answerable finance move pack query (wiki=${wiki})`);
    assert.equal(ok2.results[0]?.path, '20 Iango/John Finance Move Pack.md');
  }
});
