// Offline retrieval experiment. No notes, queries or snippets leave this process in the report.
// A result can be eligible for human review, never auto-promoted into live ranking rules.
import { createHash } from 'node:crypto';
import { search, readNote, vault } from './core.mjs';
import { estTokens } from './sessions/tokens.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const boundedMean = (values) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;

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

export async function evaluateRetrieval(ctx, fixture, { minimumCases = 20, now = () => performance.now() } = {}) {
  const errors = validateRetrievalFixture(fixture);
  if (errors.length) throw new Error(errors.join('; '));
  vault(ctx, fixture.vault); // respect the active connection's vault scope before any note read or ranking
  for (const c of fixture.cases) for (const p of c.expected) await readNote(ctx, fixture.vault, p);
  const measure = async (candidate) => {
    const details = [], times = [], tokens = [];
    for (const c of fixture.cases) {
      const start = now();
      const results = await search(ctx, fixture.vault, c.query, { limit: fixture.topK, semantic: false, queries: candidate ? c.queries || [] : [] });
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
  const privacyOk = baseline.privacy_violations === 0 && candidate.privacy_violations === 0;
  const decision = !privacyOk ? 'blocked_privacy' : !enough ? 'needs_more_cases' : qualityGain ? 'eligible_for_review' : 'no_demonstrated_gain';
  return {
    schema: 1, fixture_sha256: sha256(JSON.stringify(fixture)), vault: fixture.vault, case_count: fixture.cases.length,
    minimum_cases_for_review: minimumCases, top_k: fixture.topK, candidate: 'per-case query rephrasings; semantic search off',
    baseline, result: candidate, decision,
    limitations: ['Output tokens are locally estimated, not provider billing.', 'Latency is environment-dependent.', 'Only labelled fixture queries are evaluated.', 'No live ranking or knowledge is changed.'],
  };
}
