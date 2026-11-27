import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { compareRagBench } from '../scripts/compare-rag-bench.mjs';

const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-rag-s4-${p}-`));

test('S4: compareRagBench marks ignored expected notes as excluded_by_ignore, reports dual totals, and enforces abstention gate', async () => {
  const dir = await tmp('bench-vault');
  const home = await tmp('bench-home');
  await mkdir(path.join(dir, '00 Home'), { recursive: true });
  await mkdir(path.join(dir, '20 Iango'), { recursive: true });
  await writeFile(path.join(dir, '.brainlinkignore'), '00 Home/\n');
  await writeFile(path.join(dir, '00 Home', 'Vault Navigation.md'), '# Vault Navigation\n\nEntry point.\n');
  await writeFile(path.join(dir, '00 MAP.md'), [
    '# 00 MAP',
    '## Folders',
    '| Folder | Index | Drive id/URL | Summary | Updated |',
    '|---|---|---|---|---|',
    '| `20 Iango/` | [00 INDEX](<20 Iango/00 INDEX.md>) | — | Governance and reporting rules. | 2026-11-20 |',
  ].join('\n'));
  await writeFile(path.join(dir, '20 Iango', '00 INDEX.md'), [
    '# 00 INDEX — 20 Iango',
    '## 20 Iango/ (top level)',
    '| Title | Drive id/URL | Summary | Status | Updated | Superseded by |',
    '|---|---|---|---|---|---|',
    '| [Charter](<Charter.md>) | — | Chairman Decision Queue rule at most seven items. | active | 2026-11-20 | — |',
  ].join('\n'));
  await writeFile(path.join(dir, '20 Iango', 'Charter.md'), [
    '---',
    'status: active',
    '---',
    '# Charter',
    '',
    'Maintain one queue of at most seven items.',
  ].join('\n'));

  const fixture = {
    schema: 2,
    vault: 'Brain',
    topK: 5,
    cases: [
      { id: 'c1', query: 'Chairman Decision Queue rule', answerable: true, expected: ['20 Iango/Charter.md'] },
      { id: 'c2', query: 'Vault navigation entry point', answerable: true, expected: ['00 Home/Vault Navigation.md'] },
      { id: 'c3', query: 'What is the shared pilot folder access password?', answerable: false, expected: [] },
    ],
  };

  const report = await compareRagBench({
    fixture,
    vaultRoot: dir,
    vaultName: 'Brain',
    env: { BRAINLINK_HOME: home, BRAINLINK_SEMANTIC: '0' },
    modes: [
      { id: 'lexical', semantic: false, wiki: false },
      { id: 'lexical+wiki', semantic: false, wiki: true },
    ],
  });

  assert.equal(report.excluded_case_ids.length, 1);
  assert.equal(report.excluded_case_ids[0], 'c2');
  const wikiRun = report.runs.find((r) => r.id === 'lexical+wiki');
  assert.ok(wikiRun);
  assert.equal(wikiRun.abstention_gate_passed, true);
  assert.equal(wikiRun.totals_excluding_ignored.total, 2);
  assert.equal(wikiRun.totals_excluding_ignored.top1, 2);
  assert.equal(wikiRun.totals_excluding_ignored.top5, 2);
  assert.equal(wikiRun.totals_all.total, 3);
  assert.equal(wikiRun.totals_all.excluded_by_ignore, 1);
  assert.equal(wikiRun.cases.find((c) => c.id === 'c2').status, 'excluded_by_ignore');
});
