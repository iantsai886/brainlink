// Offline retrieval experiment. No notes, queries or snippets leave this process in the report.
// A result can be eligible for human review, never auto-promoted into live ranking rules.
import { createHash } from 'node:crypto';
import { search, searchWithVerdict, readNote, vault } from './core.mjs';
import { estTokens } from './sessions/tokens.mjs';
import { compactSearchResult } from './search-projection.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const boundedMean = (values) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
export const RETRIEVAL_EVALUATOR_VERSION = 'retrieval-eval-v3';

export function decideRetrievalComparison({ privacyOk, enoughCases, qualityRegression, qualityGain }) {
  if (!privacyOk) return 'blocked_privacy';
  if (!enoughCases) return 'needs_more_cases';
  if (qualityRegression) return 'quality_regression';
  return qualityGain ? 'eligible_for_review' : 'no_demonstrated_gain';
}

export function validateRetrievalFixture(fixture) {
  const errors = [];
  if (fixture?.schema !== 1) errors.push('schema must be 1');
  if (!fixture?.vault || typeof fixture.vault !== 'string') errors.push('vault is required');
  if (!Array.isArray(fixture?.cases) || !fixture.cases.length || fixture.cases.length > 500) errors.push('cases must contain 1–500 entries');
  if (!Number.isInteger(fixture?.topK) || fixture.topK < 1 || fixture.topK > 10) errors.push('topK must be 1–10');
  const seen = new Set();
  for (const c of Array.isArray(fixture?.cases) ? fixture.cases : []) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(c?.id || '') || seen.has(c.id)) errors.push('each case needs a unique short opaque id');
    seen.add(c?.id);
    if (!c?.query || typeof c.query !== 'string' || c.query.length > 500) errors.push('each case needs a query of at most 500 characters');
    if (!Array.isArray(c?.expected) || !c.expected.length || c.expected.some((p) => typeof p !== 'string' || !p.endsWith('.md'))) errors.push('each case needs expected Markdown paths');
    if (c?.queries && (!Array.isArray(c.queries) || c.queries.length > 4 || c.queries.some((q) => typeof q !== 'string' || q.length > 500))) errors.push('queries must be up to 4 short rephrasings');
    if (c?.forbidden && (!Array.isArray(c.forbidden) || c.forbidden.some((p) => typeof p !== 'string' || !p.endsWith('.md')))) errors.push('forbidden must contain Markdown paths');
  }
  return [...new Set(errors)];
}

function validateIndependentFixture(fixture) {
  const errors = [];
  if (fixture?.schema !== 2) errors.push('schema must be 2');
  if (typeof fixture?.vault !== 'string' || !fixture.vault) errors.push('vault is required');
  if (!Number.isInteger(fixture?.topK) || fixture.topK < 1 || fixture.topK > 10) errors.push('topK must be 1–10');
  if (!Array.isArray(fixture?.cases) || !fixture.cases.length || fixture.cases.length > 500) errors.push('cases must contain 1–500 entries');
  const seen = new Set();
  for (const c of Array.isArray(fixture?.cases) ? fixture.cases : []) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(c?.id || '') || seen.has(c.id)) errors.push('each case needs a unique short opaque id');
    seen.add(c?.id);
    if (typeof c?.query !== 'string' || !c.query.trim() || c.query.length > 500) errors.push('each case needs a query of at most 500 characters');
    if (typeof c?.answerable !== 'boolean') errors.push('each case needs an answerable boolean');
    if (!Array.isArray(c?.expected) || c.expected.some((p) => typeof p !== 'string' || !p.endsWith('.md')) || (c.answerable && !c.expected.length) || (!c.answerable && c.expected.length)) errors.push('answerable cases need expected Markdown sources; unanswerable cases need an empty expected array');
    if (c?.required_context && (!Array.isArray(c.required_context) || c.required_context.length > 8 || c.required_context.some((v) => typeof v !== 'string' || !v.trim() || v.length > 160))) errors.push('required_context must contain up to 8 short phrases');
    if (c?.forbidden && (!Array.isArray(c.forbidden) || c.forbidden.some((p) => typeof p !== 'string' || !p.endsWith('.md')))) errors.push('forbidden must contain Markdown paths');
  }
  return [...new Set(errors)];
}

const isAbstention = (status) => status !== 'hits';
const allSourcesPresent = (results, expected) => expected.every((p) => results.some((r) => r.path === p));
const contextPresent = (results, required = []) => {
  const excerpts = results.map((r) => `${r.title || ''}\n${r.heading || ''}\n${r.snippet || ''}`).join('\n').toLocaleLowerCase();
  return required.every((phrase) => excerpts.includes(phrase.toLocaleLowerCase()));
};

// Lossless projection used by the production MCP compact response: retain every selected
// source and full snippet; remove only internal per-result diagnostics.
function compactResults(results) { return results.map(compactSearchResult); }

function summarizeIndependent(results, status, c) {
  const abstained = isAbstention(status);
  const correctAbstention = !c.answerable && abstained;
  const falseAbstention = c.answerable && abstained;
  const sourcesComplete = c.answerable && allSourcesPresent(results, c.expected);
  const contextComplete = c.answerable && contextPresent(results, c.required_context || []);
  const privacyViolation = results.some((r) => (c.forbidden || []).includes(r.path));
  const success = c.answerable ? !abstained && sourcesComplete && contextComplete : correctAbstention;
  return {
    success,
    sources_complete: sourcesComplete,
    required_context_complete: contextComplete,
    abstained,
    correct_abstention: correctAbstention,
    false_abstention: falseAbstention,
    privacy_violation: privacyViolation,
    failure: success ? null : privacyViolation ? 'privacy_violation' : falseAbstention ? 'false_abstention' : !c.answerable ? 'missed_abstention' : !sourcesComplete ? 'missing_required_source' : 'missing_required_context',
  };
}

function independentMetrics(cases, observations) {
  const outcomes = cases.map((c, i) => summarizeIndependent(observations[i].results, observations[i].status, c));
  const answerable = cases.filter((c) => c.answerable);
  const expectedSourceCount = answerable.reduce((n, c) => n + c.expected.length, 0);
  const returnedSourceCount = cases.reduce((n, c, i) => n + (c.answerable ? c.expected.filter((p) => observations[i].results.some((r) => r.path === p)).length : 0), 0);
  const successful = outcomes.filter((o) => o.success).length;
  const privacyViolations = outcomes.filter((o) => o.privacy_violation).length;
  const casesById = outcomes.map((o, i) => ({ id: cases[i].id, ...o }));
  return {
    task_success: { count: successful, total: cases.length, rate: +(successful / cases.length).toFixed(3) },
    source_correctness: { top_k_all_sources_correct: outcomes.filter((o, i) => cases[i].answerable && o.sources_complete).length, answerable_cases: answerable.length, source_recall: expectedSourceCount ? +(returnedSourceCount / expectedSourceCount).toFixed(3) : 1 },
    abstention: {
      expected: cases.filter((c) => !c.answerable).length,
      returned: outcomes.filter((o) => o.abstained).length,
      correct: outcomes.filter((o) => o.correct_abstention).length,
      false: outcomes.filter((o) => o.false_abstention).length,
      missed: outcomes.filter((o, i) => !cases[i].answerable && !o.abstained).length,
    },
    privacy_violations: privacyViolations,
    context: {
      mean_estimated_tokens: boundedMean(observations.map((x) => estTokens(JSON.stringify(x.results)))),
      mean_characters: boundedMean(observations.map((x) => JSON.stringify(x.results).length)),
    },
    mean_latency_ms: boundedMean(observations.map((x) => x.latency_ms)),
    failures: casesById.filter((x) => !x.success || x.privacy_violation).map(({ id, failure, privacy_violation }) => ({ id, failure, privacy_violation })),
    cases: casesById,
  };
}

// Keep the evidence gates in one pure function so the RSI decision policy can be
// checked independently of retrieval behavior and fixture contents.
export function decideIndependentComparison({ privacyOk, enoughCases, qualityOk, smallerContext }) {
  if (!privacyOk) return 'blocked_privacy';
  if (!enoughCases) return 'needs_more_cases';
  if (!qualityOk) return 'quality_regression';
  return smallerContext ? 'eligible_for_review' : 'no_demonstrated_efficiency_gain';
}

async function evaluateIndependent(ctx, fixture, options) {
  const errors = validateIndependentFixture(fixture);
  if (errors.length) throw new Error(errors.join('; '));
  vault(ctx, fixture.vault);
  for (const c of fixture.cases) for (const p of c.expected) await readNote(ctx, fixture.vault, p);
  const run = async (compact) => Promise.all(fixture.cases.map(async (c) => {
    const start = performance.now();
    const found = await searchWithVerdict(ctx, fixture.vault, c.query, { limit: fixture.topK, semantic: false });
    const results = compact ? compactResults(found.results) : found.results;
    return { status: found.status, results, latency_ms: Math.max(0, performance.now() - start) };
  }));
  const baseline = await run(false);
  const candidate = await run(true);
  const baselineMetrics = independentMetrics(fixture.cases, baseline);
  const candidateMetrics = independentMetrics(fixture.cases, candidate);
  const enough = fixture.cases.length >= 20;
  const privacyOk = baselineMetrics.privacy_violations === 0 && candidateMetrics.privacy_violations === 0;
  const qualityOk = candidateMetrics.task_success.rate >= baselineMetrics.task_success.rate
    && candidateMetrics.source_correctness.source_recall >= baselineMetrics.source_correctness.source_recall
    && candidateMetrics.abstention.false <= baselineMetrics.abstention.false
    && candidateMetrics.abstention.missed <= baselineMetrics.abstention.missed;
  const smaller = candidateMetrics.context.mean_estimated_tokens < baselineMetrics.context.mean_estimated_tokens;
  const decision = decideIndependentComparison({ privacyOk, enoughCases: enough, qualityOk, smallerContext: smaller });
  return {
    schema: 2,
    fixture_sha256: sha256(options.fixtureBytes ?? JSON.stringify(fixture)),
    vault: fixture.vault,
    case_count: fixture.cases.length,
    evaluator_version: RETRIEVAL_EVALUATOR_VERSION,
    minimum_cases_for_review: 20,
    ...(options.receipt || {}),
    comparison: 'same questions, vault scope, topK, lexical search, and semantic=false',
    candidate_policy: { id: 'compact-search-v1', selected_sources_preserved: true, note_text_truncated: false, tuned_on_fixture: false },
    baseline: baselineMetrics,
    candidate: candidateMetrics,
    decision,
    limitations: ['Task success is a source and required-context proxy; no language model generated answers.', 'Token values are local estimates, not provider-billed counts or real-world savings.', 'Latency is local and environment-dependent.', 'Only this fictional frozen corpus and configured vault scope were evaluated.', 'This result does not establish cross-client isolation or production readiness.'],
  };
}

export async function evaluateRetrieval(ctx, fixture, options = {}) {
  if (fixture?.schema === 2) return evaluateIndependent(ctx, fixture, options);
  const { minimumCases = 20, now = () => performance.now() } = options;
  const errors = validateRetrievalFixture(fixture);
  if (errors.length) throw new Error(errors.join('; '));
  vault(ctx, fixture.vault); // respect the active connection's vault scope before any note read or ranking
  for (const c of fixture.cases) for (const p of c.expected) await readNote(ctx, fixture.vault, p);
  const measure = async (candidate) => {
    const details = [], times = [], tokens = [];
    for (const c of fixture.cases) {
      const start = now();
      const searchContext = candidate ? options.candidateContext || ctx : ctx;
      const candidateQueries = candidate && options.candidateRephrasing !== false ? c.queries || [] : [];
      const results = await search(searchContext, fixture.vault, c.query, {
        limit: fixture.topK, semantic: false, queries: candidateQueries,
        ...(candidate && options.requireCandidateReranker ? { strictReranker: true } : {}),
      });
      times.push(Math.max(0, now() - start));
      tokens.push(estTokens(JSON.stringify(results)));
      const rank = results.findIndex((r) => c.expected.includes(r.path)) + 1;
      details.push({ id: c.id, rank: rank || null, privacy_violation: results.some((r) => (c.forbidden || []).includes(r.path)) });
    }
    return {
      hit_at_k: details.filter((d) => d.rank).length,
      reciprocal_rank: +(details.reduce((sum, d) => sum + (d.rank ? 1 / d.rank : 0), 0) / details.length).toFixed(3),
      privacy_violations: details.filter((d) => d.privacy_violation).length,
      mean_estimated_output_tokens: boundedMean(tokens), mean_latency_ms: boundedMean(times), cases: details,
    };
  };
  const baseline = await measure(false);
  const candidate = await measure(true);
  const enough = fixture.cases.length >= minimumCases;
  const qualityGain = candidate.hit_at_k > baseline.hit_at_k || (candidate.hit_at_k === baseline.hit_at_k && candidate.reciprocal_rank > baseline.reciprocal_rank);
  const qualityRegression = candidate.hit_at_k < baseline.hit_at_k || candidate.reciprocal_rank < baseline.reciprocal_rank;
  const privacyOk = baseline.privacy_violations === 0 && candidate.privacy_violations === 0;
  const decision = decideRetrievalComparison({ privacyOk, enoughCases: enough, qualityRegression, qualityGain });
  return {
    schema: 1, fixture_sha256: sha256(options.fixtureBytes ?? JSON.stringify(fixture)), vault: fixture.vault, case_count: fixture.cases.length,
    minimum_cases_for_review: minimumCases, top_k: fixture.topK, candidate: options.candidatePolicy || 'per-case query rephrasings; semantic search off',
    baseline, result: candidate, decision,
    limitations: ['Output tokens are locally estimated, not provider billing.', 'Latency is environment-dependent.', 'Only labelled fixture queries are evaluated.', 'No live ranking or knowledge is changed.'],
  };
}
