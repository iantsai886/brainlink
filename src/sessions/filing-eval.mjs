// Read-only evaluator for session-folder suggestions. Reports opaque IDs and aggregate metrics;
// it never writes notes, changes saved routes, or promotes a recommendation into live behavior.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { vault } from '../core.mjs';
import { listSessionFilingFolders, suggestedSessionFolder } from './folders.mjs';

const fingerprint = (fixture) => createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
const ratio = (n, d) => d ? +(n / d).toFixed(3) : 0;

export function validateFilingFixture(fixture) {
  const errors = [];
  const safeFolder = (value) => value === '' || (typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.startsWith('\\') && !/^[a-zA-Z]:/.test(value) && !value.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'));
  if (fixture?.schema !== 1) errors.push('schema must be 1');
  if (!fixture?.vault || typeof fixture.vault !== 'string') errors.push('vault is required');
  if (typeof fixture?.intake_folder !== 'string') errors.push('intake_folder is required');
  else if (!safeFolder(fixture.intake_folder)) errors.push('intake_folder must be a safe relative folder path');
  if (!Array.isArray(fixture?.cases) || !fixture.cases.length || fixture.cases.length > 500) errors.push('cases must contain 1–500 entries');
  const ids = new Set();
  for (const c of Array.isArray(fixture?.cases) ? fixture.cases : []) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(c?.id || '') || ids.has(c.id)) errors.push('each case needs a unique short opaque id');
    ids.add(c?.id);
    if (typeof c?.project !== 'string' || c.project.length > 200) errors.push('each case needs a project label of at most 200 characters');
    if (typeof c?.summary !== 'string' || !c.summary.trim() || c.summary.length > 6000) errors.push('each case needs a summary of at most 6000 characters');
    if (c?.title !== undefined && (typeof c.title !== 'string' || c.title.length > 200)) errors.push('title must be at most 200 characters');
    if (c?.expected_folder !== null && typeof c?.expected_folder !== 'string') errors.push('expected_folder must be a folder path or null for abstention');
    if (typeof c?.expected_folder === 'string' && !safeFolder(c.expected_folder)) errors.push('expected_folder must be a safe relative folder path');
    if (c?.forbidden_folders && (!Array.isArray(c.forbidden_folders) || c.forbidden_folders.some((f) => typeof f !== 'string'))) errors.push('forbidden_folders must be an array of folder paths');
    if (Array.isArray(c?.forbidden_folders) && c.forbidden_folders.some((f) => !safeFolder(f))) errors.push('forbidden_folders must contain safe relative folder paths');
  }
  return [...new Set(errors)];
}

export async function evaluateSessionFiling(ctx, fixture, { minimumCases = 20, now = () => performance.now() } = {}) {
  const errors = validateFilingFixture(fixture);
  if (errors.length) throw new Error(errors.join('; '));
  vault(ctx, fixture.vault); // enforce connection scope before folder enumeration or note matching
  const folders = await listSessionFilingFolders(ctx, fixture.vault);
  const available = new Set(folders.map((item) => item.path));
  if (!available.has(fixture.intake_folder)) throw new Error('intake_folder must be an existing selectable folder in the chosen vault');
  for (const c of fixture.cases) {
    if (c.expected_folder !== null && !available.has(c.expected_folder)) throw new Error(`case ${c.id} expected_folder is unavailable`);
    for (const forbidden of c.forbidden_folders || []) if (!available.has(forbidden)) throw new Error(`case ${c.id} forbidden_folders contains an unavailable folder`);
  }

  let baselineCorrect = 0, candidateCorrect = 0, suggestions = 0, falseSuggestions = 0, privacyViolations = 0, abstentions = 0;
  const latencies = [], cases = [];
  for (const c of fixture.cases) {
    const start = now();
    const suggestion = await suggestedSessionFolder(ctx, { project: c.project, title: c.title || '', summary: c.summary }, fixture.vault);
    latencies.push(Math.max(0, now() - start));
    const folder = suggestion?.folder ?? null;
    const suggested = folder !== null;
    const correct = folder === c.expected_folder;
    const privacyViolation = Boolean(folder && (c.forbidden_folders || []).includes(folder));
    if (fixture.intake_folder === c.expected_folder) baselineCorrect++;
    if (correct) candidateCorrect++;
    if (suggested) suggestions++;
    else abstentions++;
    if (suggested && !correct) falseSuggestions++;
    if (privacyViolation) privacyViolations++;
    cases.push({ id: c.id, suggested, correct, privacy_violation: privacyViolation });
  }

  const enough = fixture.cases.length >= minimumCases;
  // Correct suggested destinations are correct cases with a non-null expected folder.
  const correctSuggestions = cases.filter((item, i) => item.suggested && item.correct && fixture.cases[i].expected_folder !== null).length;
  const suggestionPrecision = ratio(correctSuggestions, suggestions);
  const privacyOk = privacyViolations === 0;
  const gain = candidateCorrect > baselineCorrect && suggestionPrecision >= 0.8;
  const decision = !privacyOk ? 'blocked_privacy' : !enough ? 'needs_more_cases' : gain ? 'eligible_for_review' : 'no_demonstrated_gain';
  return {
    schema: 1, fixture_sha256: fingerprint(fixture), vault: fixture.vault, case_count: fixture.cases.length,
    minimum_cases_for_review: minimumCases,
    baseline: { policy: 'always choose the configured intake folder', correct: baselineCorrect, accuracy: ratio(baselineCorrect, fixture.cases.length) },
    candidate: { policy: 'exact approved project choice or conservative same-vault note matches', correct: candidateCorrect,
      accuracy: ratio(candidateCorrect, fixture.cases.length), precision: suggestionPrecision, coverage: ratio(suggestions, fixture.cases.length),
      false_suggestions: falseSuggestions, abstentions, privacy_violations: privacyViolations, mean_latency_ms: Math.round(latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length)), cases },
    decision,
    limitations: ['Fictional or labelled cases do not prove production filing accuracy.', 'The evaluator does not measure provider tokens, task success or user time.', 'Eligibility only requests human review; no live route or filing behavior is changed.'],
  };
}
