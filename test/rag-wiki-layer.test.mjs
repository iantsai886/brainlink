import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalize } from '../src/config.mjs';
import { createContext, searchWithVerdict } from '../src/core.mjs';
import { buildAnswerReceipt } from '../src/answer-receipt.mjs';
import { buildContextPacket } from '../src/context-packet.mjs';

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
    '## Folders',
    '',
    '| Folder | Index | Drive id/URL | Summary | Updated |',
    '|---|---|---|---|---|',
    '| `20 Iango/` | [00 INDEX — 20 Iango](<20 Iango/00 INDEX.md>) | — | Company policies, reporting hierarchy, decision queue rules, and client projects. | 2026-11-20 |',
    '| `90 Noise/` | [00 INDEX — 90 Noise](<90 Noise/00 INDEX.md>) | — | Miscellaneous scratch drafts. | 2026-11-20 |',
    '| `00 Home/` | [00 INDEX — 00 Home](<00 Home/00 INDEX.md>) | — | Excluded personal home folder. | 2026-11-20 |',
    '',
    '## Entry notes',
    '',
    '| Title | Drive id/URL | Summary | Status | Updated | Superseded by |',
    '|---|---|---|---|---|---|',
    '| [Vault Access Rule](<Vault Access Rule.md>) | — | Canonical rule for AI vault attribution and Made by line. | active | 2026-11-20 | — |',
    '| [Secret Private Note](<Secret Private Note.md>) | — | Contains PRIVWIKICANARY confidential token. | active | 2026-11-20 | — |',
    '| [Home Excluded Note](<00 Home/Home Excluded Note.md>) | — | Contains EXCLWIKICANARY personal diary. | active | 2026-11-20 | — |',
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

  const cfg = normalize({ vaults: [{ name: 'Brain', path: dir }] });
  const ctx = createContext(cfg, { env: { BRAINLINK_HOME: home, BRAINLINK_SEMANTIC: '0' }, trustedLocal: true });
  return { dir, home, ctx };
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

test('S2: privacy & exclusion gate — private or ignored notes listed in MAP/INDEX never appear in wiki_layer, results, or citations', async () => {
  const { ctx } = await makeWikiVault();
  for (const query of ['PRIVWIKICANARY confidential token', 'EXCLWIKICANARY personal diary']) {
    const res = await searchWithVerdict(ctx, 'Brain', query, { limit: 5, semantic: false });
    const receipt = buildAnswerReceipt(res, { vault: 'Brain' });
    const packet = buildContextPacket(res, { vault: 'Brain' });
    const serialized = JSON.stringify({ res, receipt, packet });
    assert.ok(!serialized.includes('Secret Private Note.md'), 'private note leaked');
    assert.ok(!serialized.includes('Home Excluded Note.md'), 'excluded folder note leaked');
    assert.ok(!serialized.includes('PRIVWIKICANARY'), 'private canary leaked');
    assert.ok(!serialized.includes('EXCLWIKICANARY'), 'excluded canary leaked');
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

test('S2: abstention gate — unanswerable credential and account-balance queries still abstain even when adjacent topic notes exist', async () => {
  const { dir, ctx } = await makeWikiVault();
  // Add realistic adjacent topic notes with high word overlap (like a release audit or move log)
  // that do NOT contain a password or account balance.
  await writeFile(path.join(dir, '20 Iango', 'WeiMa Pilot Audit.md'), '# WeiMa Pilot Audit\n\nShared WeiMa pilot folder current access review completed. No credentials stored here.\n');
  await writeFile(path.join(dir, '20 Iango', 'John Finance Move Pack.md'), '# John Finance Move Pack\n\nMoved John Personal Finance Workboard out of Brain. Account balances are out of scope.\n');
  for (const wiki of [false, true]) {
    const q1 = await searchWithVerdict(ctx, 'Brain', 'What is the shared WeiMa pilot folder current access password or credential?', { limit: 5, semantic: false, wiki });
    assert.notEqual(q1.status, 'hits', `expected abstention for credential query (wiki=${wiki})`);
    const q2 = await searchWithVerdict(ctx, 'Brain', 'What is the current account balance shown in John Personal Finance Workboard?', { limit: 5, semantic: false, wiki });
    assert.notEqual(q2.status, 'hits', `expected abstention for account balance query (wiki=${wiki})`);
  }
});
