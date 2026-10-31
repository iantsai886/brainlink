// Bounded RSI experiments. Only the bundled fictional retrieval fixtures and the current
// built-in evaluator are runnable here; this path executes no proposal-supplied code and never
// uses a connected user vault or changes live retrieval behavior.
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { normalize } from './config.mjs';
import { createContext } from './core.mjs';
import { evaluateRetrieval, RETRIEVAL_EVALUATOR_VERSION } from './retrieval-eval.mjs';
import { readGitSourceState } from './git-source-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RSI_EXPERIMENT_SUITES = Object.freeze({
  'retrieval-rsi-v1': Object.freeze({ fixture: 'retrieval-rsi-v1.json', vault: 'vault', candidate_version: 'per-case-rephrasing-v1', policy: 'fixed rephrasing policy; semantic search off' }),
  'retrieval-independent-v1': Object.freeze({ fixture: 'retrieval-independent-v1.json', vault: 'independent-vault', candidate_version: 'compact-search-v1', policy: 'lossless production MCP compact-search projection; evaluation only' }),
});

const safeRatio = (value) => Number.isFinite(value) ? Math.max(0, Math.min(1, Number(value))) : 0;

export function createRsiExperiments({ root = ROOT, env = process.env, now = () => new Date(), sourceState = readGitSourceState } = {}) {
  let running = false;
  return {
    suites: () => Object.entries(RSI_EXPERIMENT_SUITES).map(([id, suite]) => ({ id, fixture: suite.fixture, candidate_version: suite.candidate_version, candidate_policy: suite.policy })),
    run: async (suiteId) => {
      if (running) throw new Error('An RSI experiment is already running. Try again when it finishes.');
      const suite = RSI_EXPERIMENT_SUITES[suiteId];
      if (!suite) throw new Error('Choose one of BrainLink’s built-in fictional retrieval suites.');
      running = true;
      try {
        const startedAt = now().toISOString();
        const sourceBefore = sourceState(root);
        const fixturePath = path.join(root, 'samples', 'evaluation', suite.fixture);
        const fixtureBytes = await readFile(fixturePath);
        const fixture = JSON.parse(fixtureBytes.toString('utf8'));
        const vaultRoot = path.join(root, 'samples', 'evaluation', suite.vault);
        const isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'brainlink-rsi-'));
        let report;
        try {
          const ctx = createContext(normalize({ vaults: [{ name: fixture.vault, path: vaultRoot }] }), {
            env: { ...env, BRAINLINK_HOME: isolatedHome, BRAINLINK_VAULTS: fixture.vault, BRAINLINK_SEMANTIC: '0' },
          });
          report = await evaluateRetrieval(ctx, fixture, { fixtureBytes });
        } finally { await rm(isolatedHome, { recursive: true, force: true }); }
        const sourceAfter = sourceState(root);
        const sourceStable = Boolean(sourceBefore?.clean && sourceAfter?.clean
          && /^[a-f0-9]{40}$/.test(sourceBefore.commit_sha || '')
          && sourceBefore.commit_sha === sourceAfter.commit_sha);
        const independent = report.schema === 2;
        const baselineQuality = independent ? report.baseline.task_success.rate : report.baseline.hit_at_k / report.case_count;
        const candidateQuality = independent ? report.candidate.task_success.rate : report.result.hit_at_k / report.case_count;
        const baselineCoverage = independent ? report.baseline.source_correctness.source_recall : report.baseline.reciprocal_rank;
        const candidateCoverage = independent ? report.candidate.source_correctness.source_recall : report.result.reciprocal_rank;
        const baselinePrivacy = report.baseline.privacy_violations;
        const candidatePrivacy = independent ? report.candidate.privacy_violations : report.result.privacy_violations;
        const baselineTokens = independent ? report.baseline.context.mean_estimated_tokens : report.baseline.mean_estimated_output_tokens;
        const candidateTokens = independent ? report.candidate.context.mean_estimated_tokens : report.result.mean_estimated_output_tokens;
        return {
          schema: 2,
          run_id: `BL-RSI-RUN-${startedAt.slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`,
          suite: suiteId,
          started_at: startedAt,
          completed_at: now().toISOString(),
          fixture_sha256: report.fixture_sha256,
          evaluator_version: RETRIEVAL_EVALUATOR_VERSION,
          software_version: report.package_version || 'development',
          source_commit_sha: /^[a-f0-9]{40}$/.test(sourceBefore?.commit_sha || '') ? sourceBefore.commit_sha : null,
          source_tree_clean: Boolean(sourceBefore?.clean),
          source_tree_clean_after: Boolean(sourceAfter?.clean),
          source_stable: sourceStable,
          candidate_version: suite.candidate_version,
          candidate_policy: suite.policy,
          sample_count: report.case_count,
          decision: sourceStable ? report.decision : 'source_unbound',
          primary_metric: {
            name: independent ? 'task_success_rate' : 'hit_at_k_rate',
            baseline: safeRatio(baselineQuality), candidate: safeRatio(candidateQuality),
          },
          secondary_metric: {
            name: independent ? 'required_source_recall' : 'mean_reciprocal_rank',
            baseline: safeRatio(baselineCoverage), candidate: safeRatio(candidateCoverage),
          },
          guardrails: { baseline_privacy_violations: baselinePrivacy, candidate_privacy_violations: candidatePrivacy },
          estimated_context_tokens: { baseline: baselineTokens, candidate: candidateTokens },
          limitations: independent
            ? ['Fictional frozen corpus only; no model-generated answers.', 'Token values are local estimates, not provider billing.', 'No cross-client or production claim.']
            : ['Fictional frozen corpus only.', 'Token values are local estimates, not provider billing.', 'No live ranking or knowledge is changed.'],
        };
      } finally { running = false; }
    },
  };
}
