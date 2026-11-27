import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalize, saveConfig } from '../src/config.mjs';
import { createContext, DEFAULT_EXCLUDED_FOLDERS, inspectVaultStructure, isExcludedPath, isSkippedDirName, loadVault, readNote, related, relatedText, searchWithVerdict } from '../src/core.mjs';
import { isWikiIndexPath } from '../src/wiki-layer.mjs';
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
    'aliases: [FMALIASPRIVCANARY, Brain Map]',
    'tags: [FM_TAG_PRIVCANARY]',
    'superseded_by: FM_SUPERSEDED_PRIVCANARY',
    'related:',
    '  - "[[Secret Private Note]]"',
    '  - FMRELPRIVCANARY',
    '---',
    '# 00 MAP — Brain',
    '',
    'Bare mention of Secret Private Note and BAREPRIVCANARY with no link.',
    '',
    '```markdown',
    'Secret Private Note CODEBLOCKPRIVCANARY inside fenced code block',
    '```',
    '',
    '## Entry notes',
    '',
    '| Title | Drive id/URL | Summary | Status | Updated | Superseded by |',
    '|---|---|---|---|---|---|',
    '| [Secret Private Note](<Secret Private Note.md>) | — | Contains PRIVWIKICANARY confidential token. | active | 2026-11-20 | — |',
    '| [Home Excluded Note](<00 Home/Home Excluded Note.md>) | — | Contains EXCLWIKICANARY personal diary. | active | 2026-11-20 | — |',
    '| [Vault Access Rule](<Vault Access Rule.md>) | — | Canonical rule for AI vault attribution and Made by line. Also mentions [Secret Private Note CELL2PRIVCANARY](<Secret Private Note.md>). | active | 2026-11-20 | — |',
    '',
    '## Folders',
    '',
    '| Folder | Index | Drive id/URL | Summary | Updated |',
    '|---|---|---|---|---|',
    '| `20 Iango/` | [00 INDEX — 20 Iango](<20 Iango/00 INDEX.md>) | — | Company policies, reporting hierarchy, decision queue rules, and client projects. | 2026-11-20 |',
    '| `90 Noise/` | [00 INDEX — 90 Noise](<90 Noise/00 INDEX.md>) | — | Miscellaneous scratch drafts. | 2026-11-20 |',
    '| `00 Home/` | [00 INDEX — 00 Home](<00 Home/00 INDEX.md>) | — | Excluded personal home folder. | 2026-11-20 |',
  ].join('\n'));

  // Staging / draft / promoted index filenames (must never be indexed raw or leaked)
  await mkdir(path.join(dir, 'Grok', 'Claude 886', '_staging', '2026-11-20'), { recursive: true });
  await writeFile(path.join(dir, 'Grok', 'Claude 886', '_staging', '2026-11-20', 'DRAFT 00 MAP.md'), [
    '---',
    'type: index',
    'aliases: [STAGINGFMPRIVCANARY]',
    '---',
    '# DRAFT 00 MAP',
    '| [Secret Private Note](<../../../../Secret Private Note.md>) | — | STAGINGPRIVCANARY draft leak | active | 2026-11-20 | — |',
  ].join('\n'));
  await writeFile(path.join(dir, 'Grok', 'Claude 886', '_staging', '2026-11-20', 'DRAFT 00 INDEX - BrainLink.md'), [
    '# DRAFT 00 INDEX - BrainLink',
    'Bare STAGINGIDXPRIVCANARY leak in draft index.',
  ].join('\n'));
  await writeFile(path.join(dir, 'Grok', 'Claude 886', '_staging', '2026-11-20', 'Staging Secret Draft.md'), [
    '# Staging Secret Draft',
    'Non-index note inside _staging with STAGINGNOTEPRIVCANARY must never be walked or searchable even without _staging/ in .brainlinkignore.',
  ].join('\n'));
  await writeFile(path.join(dir, 'PROMOTED 00 MAP.md'), [
    '---',
    'type: index',
    'related: [PROMOTEDFMPRIVCANARY]',
    '---',
    '# PROMOTED 00 MAP',
    'Bare PROMOTEDPRIVCANARY leak in promoted map copy.',
  ].join('\n'));
  await writeFile(path.join(dir, '00-MAP.md'), [
    '---',
    'type: index',
    'status: FM_STATUS_PRIVCANARY',
    '---',
    '# 00-MAP',
    'Bare HYPHENMAPPRIVCANARY leak in hyphenated map variant.',
  ].join('\n'));
  await writeFile(path.join(dir, '20 Iango', '00_INDEX.md'), [
    '---',
    'type: index',
    'status: FM_STATUS_PRIVCANARY',
    '---',
    '# 00_INDEX',
    'Bare UNDERINDEXPRIVCANARY leak in underscored index variant.',
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

  await writeFile(path.join(dir, '20 Iango', 'Policies', '00 INDEX.md'), [
    '---',
    'type: index',
    'status: active',
    '---',
    '# 00 INDEX — Policies',
    '',
    '| Title | Drive id/URL | Summary | Status | Updated | Superseded by |',
    '|---|---|---|---|---|---|',
    '| [Secret Private Note](<../../Secret Private Note.md>) | — | Nested index row with NESTEDPRIVCANARY secret token. | active | 2026-11-20 | — |',
    '| [Home Excluded Note](<../../00 Home/Home Excluded Note.md>) | — | Nested index row with NESTEDEXCLCANARY excluded diary. | active | 2026-11-20 | — |',
    '| [Governance Charter](<Governance Charter.md>) | — | Nested index row for Chairman Decision Queue rule. | active | 2026-11-20 | — |',
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

test('S2: privacy & exclusion gate — MAP and top-level/nested INDEX chunks never expose restricted titles or canaries on any surface (full content checked)', async () => {
  const { home, cfg, env, ctx } = await makeWikiVault();
  const index = await loadVault(ctx, 'Brain');
  const forbidden = [
    'Secret Private Note',
    'Home Excluded Note',
    'PRIVWIKICANARY',
    'EXCLWIKICANARY',
    'NESTEDPRIVCANARY',
    'NESTEDEXCLCANARY',
    'CELL2PRIVCANARY',
    'BAREPRIVCANARY',
    'CODEBLOCKPRIVCANARY',
    'FMALIASPRIVCANARY',
    'FMRELPRIVCANARY',
    'STAGINGPRIVCANARY',
    'STAGINGFMPRIVCANARY',
    'STAGINGIDXPRIVCANARY',
    'STAGINGNOTEPRIVCANARY',
    'PROMOTEDPRIVCANARY',
    'PROMOTEDFMPRIVCANARY',
    'HYPHENMAPPRIVCANARY',
    'UNDERINDEXPRIVCANARY',
    'FM_TAG_PRIVCANARY',
    'FM_SUPERSEDED_PRIVCANARY',
    'FM_STATUS_PRIVCANARY',
  ];
  const anyWikiIndexRe = /(?:^|[^A-Za-z0-9])00[\s_-]+(?:MAP|INDEX)(?:[^A-Za-z0-9]|$)/i;

  assert.ok(DEFAULT_EXCLUDED_FOLDERS.includes('_staging/'), 'DEFAULT_EXCLUDED_FOLDERS must include _staging/');
  // Runtime _staging/ enforcement: even without _staging/ in .brainlinkignore, walk() must never index _staging/ notes.
  for (const n of index.notes) {
    assert.ok(!/(?:^|\/)_staging\//i.test(n.rel), `_staging note should never be walked/indexed: ${n.rel}`);
  }
  await assert.rejects(
    readNote(ctx, 'Brain', 'Grok/Claude 886/_staging/2026-11-20/Staging Secret Draft.md'),
    /private/i,
    'readNote must reject _staging notes at runtime even when .brainlinkignore omits _staging/',
  );

  // 1. No indexed chunk may come from any 00 MAP / 00 INDEX note (including DRAFT/PROMOTED/nested) or carry restricted titles/canaries.
  for (const chunk of index.chunks) {
    const note = index.notes[chunk.noteIdx];
    assert.ok(!anyWikiIndexRe.test(path.posix.basename(note.rel)), `MAP/INDEX chunk should not be indexed: ${note.rel}`);
    for (const marker of forbidden) {
      assert.ok(!chunk.text.includes(marker), `indexed chunk leaked ${marker} via ${note.rel}`);
    }
  }

  const mcp = createMcp(ctx);
  await mkdir(home, { recursive: true });
  await saveConfig(cfg, path.join(home, 'config.json'));
  const setup = await startSetup({ env, home: await tmp('s2-priv-userhome'), os: 'win32', port: 0, openUrl: null, useCli: false });
  try {
    for (const query of [
      'PRIVWIKICANARY confidential token',
      'EXCLWIKICANARY personal diary',
      'NESTEDPRIVCANARY secret token',
      'NESTEDEXCLCANARY excluded diary',
      'CELL2PRIVCANARY',
      'BAREPRIVCANARY',
      'CODEBLOCKPRIVCANARY',
      'STAGINGPRIVCANARY',
      'STAGINGNOTEPRIVCANARY',
      'PROMOTEDPRIVCANARY',
      'HYPHENMAPPRIVCANARY',
      'UNDERINDEXPRIVCANARY',
      'Secret Private Note',
      'Home Excluded Note',
    ]) {
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

    // 2. Explicit-path readNote, vault_read_note, connector fetch, and POST /api/note on 00 MAP.md,
    // any 00 INDEX.md (including nested and backslash paths), and DRAFT/PROMOTED copies must return
    // ONLY an allowlist-regenerated listing + safe frontmatter keys (never raw body/frontmatter).
    for (const indexPath of [
      '00 MAP.md',
      '00-MAP.md',
      '20 Iango/00 INDEX.md',
      '20 Iango/00_INDEX.md',
      '20 Iango/Policies/00 INDEX.md',
      '20 Iango\\Policies\\00 INDEX.md',
      'PROMOTED 00 MAP.md',
    ]) {
      const direct = await readNote(ctx, 'Brain', indexPath);
      const directJson = JSON.stringify(direct);
      for (const marker of forbidden) assert.ok(!directJson.includes(marker), `readNote(${indexPath}) leaked ${marker}`);
      assert.ok(!direct.body.includes('00 Home/'), `readNote(${indexPath}) leaked excluded folder 00 Home/`);
      assert.equal(direct.meta.aliases, undefined, `readNote(${indexPath}) must strip raw frontmatter aliases`);
      assert.equal(direct.meta.related, undefined, `readNote(${indexPath}) must strip raw frontmatter related`);

      const vr = await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'vault_read_note', arguments: { vault: 'Brain', path: indexPath } } });
      for (const marker of forbidden) assert.ok(!vr.result.content[0].text.includes(marker), `vault_read_note(${indexPath}) leaked ${marker}`);

      const cf = await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fetch', arguments: { id: `Brain::${indexPath}` } } });
      for (const marker of forbidden) assert.ok(!cf.result.content[0].text.includes(marker), `connector fetch(${indexPath}) leaked ${marker}`);

      const noteRes = await fetch(`http://127.0.0.1:${setup.port}/api/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': setup.token },
        body: JSON.stringify({ vault: 'Brain', path: indexPath }),
      });
      assert.equal(noteRes.status, 200);
      const noteText = await noteRes.text();
      for (const marker of forbidden) assert.ok(!noteText.includes(marker), `POST /api/note(${indexPath}) leaked ${marker}`);
    }
    const sanitizedMap = await readNote(ctx, 'Brain', '00 MAP.md');
    assert.match(sanitizedMap.body, /Vault Access Rule/);
    const sanitizedNested = await readNote(ctx, 'Brain', '20 Iango/Policies/00 INDEX.md');
    assert.match(sanitizedNested.body, /Governance Charter/);

    // 3. related() and relatedText() must never return 00 MAP / 00 INDEX paths/titles or raw injected frontmatter.
    for (const target of ['Vault Access Rule.md', '20 Iango/Policies/Governance Charter.md']) {
      const relInfo = await related(ctx, 'Brain', target);
      const allRelated = [...relInfo.links_to, ...relInfo.linked_from, ...relInfo.suggested];
      for (const item of allRelated) {
        assert.ok(!anyWikiIndexRe.test(path.posix.basename(item.path)), `related(${target}) surfaced wiki index path: ${item.path}`);
        assert.ok(!anyWikiIndexRe.test(item.title), `related(${target}) surfaced wiki index title: ${item.title}`);
      }
    }
    for (const mapOrIndex of ['00 MAP.md', '00-MAP.md', '20 Iango/00_INDEX.md']) {
      const relMap = await related(ctx, 'Brain', mapOrIndex);
      const relMapJson = JSON.stringify(relMap);
      for (const marker of forbidden) assert.ok(!relMapJson.includes(marker), `related(${mapOrIndex}) leaked ${marker}`);
      const relTxt = await relatedText(ctx, 'Brain', 'Vault Access Rule attribution', { excludePath: mapOrIndex });
      const relTxtJson = JSON.stringify(relTxt);
      for (const marker of forbidden) assert.ok(!relTxtJson.includes(marker), `relatedText(${mapOrIndex}) leaked ${marker}`);
    }
    // Traversal guard with backslashes must still reject escapes.
    await assert.rejects(readNote(ctx, 'Brain', '..\\outside.md'), /escapes the vault/i);

    // 4. Full body of every hit returned for a legitimate query never exposes restricted titles.
    const legit = await searchWithVerdict(ctx, 'Brain', 'Vault Access Rule attribution', { limit: 5, semantic: false });
    assert.ok(legit.results.length >= 1);
    for (const hit of legit.results) {
      assert.ok(!anyWikiIndexRe.test(hit.path), `MAP/INDEX should not be returned as hit: ${hit.path}`);
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

test('S2: fail-closed _staging trailing space/dot exclusion and tightened MAP/INDEX filename matching', async () => {
  const dir = await tmp('staging-variants');
  const home = await tmp('staging-variants-home');
  await mkdir(path.join(dir, '20 Iango'), { recursive: true });
  await writeFile(path.join(dir, '.brainlinkignore'), '.obsidian/\n');
  await writeFile(path.join(dir, '00-MAP-of-ideas.md'), '# Ideas Map\n\nOrdinary brainstorm note with IDEAMAPTOKEN.\n');
  await writeFile(path.join(dir, '20 Iango', 'notes-00-INDEX-copy.md'), '# Notes Index Copy\n\nOrdinary notes copy with NOTESCOPYTOKEN.\n');
  await writeFile(path.join(dir, '00 MAP (1).md'), '---\naliases: [DRIVECOPYMAPPRIVCANARY]\n---\n# Map Copy\n\nRaw conflict copy leaking DRIVECOPYMAPPRIVCANARY.\n');
  await writeFile(path.join(dir, '20 Iango', '00 INDEX (1).md'), '---\nrelated: [DRIVECOPYIDXPRIVCANARY]\n---\n# Index Copy\n\nRaw conflict copy leaking DRIVECOPYIDXPRIVCANARY.\n');

  // Create _staging trailing-space and trailing-dot directories.
  // On POSIX these remain distinct literal dirs ("_staging " and "_staging."); on Win32,
  // Win32 silently strips trailing space/dot to "_staging". Either way, all assertions below run
  // unconditionally on every platform (no platform-gated assertion loops).
  await mkdir(path.join(dir, '_staging '), { recursive: true });
  await writeFile(path.join(dir, '_staging ', 'Space Staging Secret.md'), '# Secret\n\nSPACESTAGINGCANARY\n');
  await mkdir(path.join(dir, '_staging.'), { recursive: true });
  await writeFile(path.join(dir, '_staging.', 'Dot Staging Secret.md'), '# Secret\n\nDOTSTAGINGCANARY\n');

  const cfg = normalize({ vaults: [{ name: 'Brain', path: dir }] });
  const ctx = createContext(cfg, { env: { BRAINLINK_HOME: home }, trustedLocal: true });

  // 1. Fail-closed folder-name comparison: trailing spaces/dots and mixed case must all be excluded.
  for (const dirVariant of ['_staging', '_staging ', '_staging.', '_STAGING . ', '   ', '...']) {
    assert.equal(isSkippedDirName(dirVariant), true, `isSkippedDirName must reject "${dirVariant}"`);
  }
  assert.equal(isSkippedDirName('20 Iango'), false);
  assert.equal(isSkippedDirName('00-MAP-of-ideas.md'), false);

  for (const variant of [
    '_staging /Space Staging Secret.md',
    '_staging./Dot Staging Secret.md',
    'Grok/_staging /Nested Space.md',
    'Grok/_staging./Nested Dot.md',
    'Grok/_STAGING . /Mixed Case.md',
  ]) {
    assert.equal(await isExcludedPath(dir, variant), true, `isExcludedPath must exclude "${variant}"`);
    await assert.rejects(readNote(ctx, 'Brain', variant), /private/i, `readNote must reject "${variant}"`);
  }
  assert.equal(await isExcludedPath(dir, '00-MAP-of-ideas.md'), false);
  assert.equal(await isExcludedPath(dir, '20 Iango/notes-00-INDEX-copy.md'), false);

  const index = await loadVault(ctx, 'Brain');
  const structure = await inspectVaultStructure(dir);
  for (const n of index.notes) {
    assert.ok(!/(?:^|\/)_staging[\s.]*\//i.test(n.rel), `walk must never index trailing space/dot _staging: ${n.rel}`);
  }
  for (const folder of structure.folders) {
    assert.ok(!/(?:^|\/)_staging[\s.]*$/i.test(folder), `visibleFolderPaths must never list trailing space/dot _staging: ${folder}`);
  }
  assert.ok(structure.folders.includes('20 Iango'), 'inspectVaultStructure should still list normal folders');
  for (const canary of ['SPACESTAGINGCANARY', 'DOTSTAGINGCANARY', 'DRIVECOPYMAPPRIVCANARY', 'DRIVECOPYIDXPRIVCANARY']) {
    const res = await searchWithVerdict(ctx, 'Brain', canary, { limit: 5, semantic: false, wiki: true });
    assert.equal(res.results.length, 0, `search must return 0 hits for ${canary}`);
  }

  // 2. Tightened MAP/INDEX filename pattern: ordinary notes containing 00-MAP / 00-INDEX are NOT wiki indexes,
  // while Drive sync-conflict copies like "00 MAP (1).md" and "00 INDEX (1).md" ARE classified as wiki indexes.
  for (const ordinary of [
    '00-MAP-of-ideas.md',
    '00-MAP-of-ideas (1).md',
    'notes-00-INDEX-copy.md',
    'notes-00-INDEX-copy (1).md',
    '20 Iango/00-MAP-of-ideas.md',
    '20 Iango/notes-00-INDEX-copy.md',
  ]) {
    assert.equal(isWikiIndexPath(ordinary), false, `ordinary note must not match isWikiIndexPath: ${ordinary}`);
  }
  for (const wikiIdx of [
    '00 MAP.md',
    '00 MAP (1).md',
    '00 INDEX.md',
    '00 INDEX (1).md',
    '20 Iango/00 INDEX (2).md',
    '00-MAP.md',
    '00-MAP (1).md',
    '20 Iango/00_INDEX.md',
    '20 Iango/00_INDEX (1).md',
    'DRAFT 00 MAP.md',
    'PROMOTED 00 MAP.md',
    'DRAFT 00 INDEX - BrainLink.md',
    'DRAFT 00 INDEX - BrainLink (1).md',
  ]) {
    assert.equal(isWikiIndexPath(wikiIdx), true, `wiki index must match isWikiIndexPath: ${wikiIdx}`);
  }

  // Drive sync-conflict copies must never return raw body or frontmatter on explicit readNote.
  for (const copyPath of ['00 MAP (1).md', '20 Iango/00 INDEX (1).md']) {
    const direct = await readNote(ctx, 'Brain', copyPath);
    const serialized = JSON.stringify(direct);
    assert.ok(!serialized.includes('DRIVECOPYMAPPRIVCANARY'), `readNote(${copyPath}) leaked raw MAP copy`);
    assert.ok(!serialized.includes('DRIVECOPYIDXPRIVCANARY'), `readNote(${copyPath}) leaked raw INDEX copy`);
  }

  // Ordinary notes must remain searchable and readable raw.
  const ideaSearch = await searchWithVerdict(ctx, 'Brain', 'IDEAMAPTOKEN', { limit: 5, semantic: false, wiki: true });
  assert.equal(ideaSearch.results[0]?.path, '00-MAP-of-ideas.md');
  const ideaNote = await readNote(ctx, 'Brain', '00-MAP-of-ideas.md');
  assert.match(ideaNote.body, /IDEAMAPTOKEN/);

  const copySearch = await searchWithVerdict(ctx, 'Brain', 'NOTESCOPYTOKEN', { limit: 5, semantic: false, wiki: true });
  assert.equal(copySearch.results[0]?.path, '20 Iango/notes-00-INDEX-copy.md');
  const copyNote = await readNote(ctx, 'Brain', '20 Iango/notes-00-INDEX-copy.md');
  assert.match(copyNote.body, /NOTESCOPYTOKEN/);
});
