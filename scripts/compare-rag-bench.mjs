#!/usr/bin/env node
// Read-only RAG retrieval comparison harness for brain-bench (schema 2).
// Compares lexical-only, lexical + local embeddings, and lexical + local embeddings + MAP/INDEX wiki.
// Never modifies the vault or .brainlinkignore; writes no note bodies or secrets into output.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalize } from '../src/config.mjs';
import { createContext, isExcludedPath, loadVault, searchWithVerdict, semanticStatus, warmSemantic } from '../src/core.mjs';

export const DEFAULT_MODES = [
  { id: 'lexical', label: 'Lexical only', semantic: false, wiki: false },
  { id: 'lexical+embeddings', label: 'Lexical + embeddings', semantic: true, wiki: false },
  { id: 'lexical+embeddings+wiki', label: 'Lexical + embeddings + MAP/INDEX', semantic: true, wiki: true },
];

export async function compareRagBench({
  fixture,
  vaultRoot,
  vaultName = fixture.vault,
  env = process.env,
  modes = DEFAULT_MODES,
  warm = true,
} = {}) {
  const resolvedRoot = path.resolve(vaultRoot);
  const cfg = normalize({ vaults: [{ name: vaultName, path: resolvedRoot }] });
  const ctx = createContext(cfg, { env, trustedLocal: true });

  // Identify cases whose expected note is excluded by .brainlinkignore so they are scored
  // transparently as "excluded_by_ignore" rather than counted as retrieval misses.
  const excludedCaseIds = new Set();
  for (const c of fixture.cases) {
    if (!c.answerable) continue;
    for (const rel of c.expected || []) {
      if (await isExcludedPath(resolvedRoot, rel)) {
        excludedCaseIds.add(c.id);
        break;
      }
    }
  }

  const index = await loadVault(ctx, vaultName);
  let embedder = null;
  let warmSummary = null;
  if (modes.some((m) => m.semantic)) {
    embedder = await semanticStatus(ctx);
    if (embedder.available && warm) {
      warmSummary = await warmSemantic(ctx, vaultName);
    }
  }

  const runs = [];
  for (const mode of modes) {
    const cases = [];
    let top1 = 0;
    let top5 = 0;
    let evaluated = 0;
    let answerableEvaluated = 0;
    let rrSum = 0;
    let abstentionExpected = 0;
    let abstentionCorrect = 0;
    let totalLatencyMs = 0;

    for (const c of fixture.cases) {
      if (excludedCaseIds.has(c.id)) {
        cases.push({
          id: c.id,
          answerable: c.answerable,
          status: 'excluded_by_ignore',
          rank: null,
          top1_correct: null,
          top5_correct: null,
          top1_path: null,
        });
        continue;
      }
      evaluated++;
      const start = performance.now();
      const res = await searchWithVerdict(ctx, vaultName, c.query, {
        limit: fixture.topK || 5,
        semantic: mode.semantic,
        wiki: mode.wiki,
      });
      const latencyMs = Math.max(0, performance.now() - start);
      totalLatencyMs += latencyMs;

      if (!c.answerable) {
        abstentionExpected++;
        const abstained = res.status !== 'hits';
        if (abstained) {
          abstentionCorrect++;
          top1++;
          top5++;
        }
        cases.push({
          id: c.id,
          answerable: false,
          status: res.status,
          rank: null,
          top1_correct: abstained,
          top5_correct: abstained,
          abstained,
          top1_path: res.results[0]?.path || null,
          latency_ms: Math.round(latencyMs),
        });
        continue;
      }

      answerableEvaluated++;
      const rankIdx = res.results.findIndex((r) => c.expected.includes(r.path));
      const rank = rankIdx >= 0 ? rankIdx + 1 : null;
      const hit1 = rank === 1;
      const hit5 = rank !== null && rank <= (fixture.topK || 5);
      if (hit1) top1++;
      if (hit5) top5++;
      if (rank) rrSum += 1 / rank;

      cases.push({
        id: c.id,
        answerable: true,
        status: res.status,
        rank,
        top1_correct: hit1,
        top5_correct: hit5,
        top1_path: res.results[0]?.path || null,
        wiki_matched: Boolean(res.wiki_layer?.matched_entries?.some((p) => c.expected.includes(p))),
        latency_ms: Math.round(latencyMs),
      });
    }

    const totalAll = fixture.cases.length;
    const pct = (n, d) => (d ? +((100 * n) / d).toFixed(1) : 0);
    runs.push({
      id: mode.id,
      label: mode.label || mode.id,
      semantic: mode.semantic,
      wiki: mode.wiki,
      abstention_gate_passed: abstentionCorrect === abstentionExpected,
      abstention: { correct: abstentionCorrect, expected: abstentionExpected },
      mrr_answerable: answerableEvaluated ? +(rrSum / answerableEvaluated).toFixed(3) : 0,
      mean_latency_ms: evaluated ? Math.round(totalLatencyMs / evaluated) : 0,
      totals_all: {
        top1,
        top5,
        total: totalAll,
        excluded_by_ignore: excludedCaseIds.size,
        top1_pct: pct(top1, totalAll),
        top5_pct: pct(top5, totalAll),
      },
      totals_excluding_ignored: {
        top1,
        top5,
        total: evaluated,
        top1_pct: pct(top1, evaluated),
        top5_pct: pct(top5, evaluated),
      },
      cases,
    });
  }

  return {
    vault: vaultName,
    indexed_notes: index.notes.length,
    indexed_chunks: index.chunks.length,
    wiki_present: Boolean(index.wiki?.present),
    wiki_entries: index.wiki?.entries?.length || 0,
    embedder: embedder ? { available: embedder.available, model: embedder.model || null, reason: embedder.reason || null } : null,
    warm_vectors: warmSummary,
    excluded_case_ids: [...excludedCaseIds],
    runs,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 || argv[i + 1]?.startsWith('--') ? dflt : argv[i + 1] ?? dflt;
  };
  const fixturePath = opt('fixture');
  const vaultRoot = opt('vault-root');
  if (!fixturePath || !vaultRoot) {
    process.stderr.write('Usage: node scripts/compare-rag-bench.mjs --fixture FILE --vault-root DIR [--vault-name NAME]\n');
    process.exit(1);
  }
  const fixture = JSON.parse(await readFile(path.resolve(fixturePath), 'utf8'));
  const vaultName = opt('vault-name', fixture.vault || 'Brain');
  const report = await compareRagBench({ fixture, vaultRoot, vaultName });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
