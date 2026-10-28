import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { discoverTypedRelationshipCandidates, TYPED_ENTITY_TYPES, TYPED_RELATION_PREDICATES } from './typed-graph.mjs';

export const TYPED_GRAPH_EVALUATOR_VERSION = 'typed-graph-eval-v1';
export const TYPED_GRAPH_MIN_CASES = 20;

export function validateTypedGraphFixture(fixture) {
  const errors = [];
  if (!fixture || fixture.schema !== 1) errors.push('schema must be 1');
  if (!Array.isArray(fixture?.notes) || fixture.notes.length < 2 || fixture.notes.length > 5000) errors.push('notes must contain 2 to 5000 visible records');
  if (!Array.isArray(fixture?.cases) || fixture.cases.length < 1 || fixture.cases.length > 5000) errors.push('cases must contain 1 to 5000 labelled examples');
  if (!Array.isArray(fixture?.forbidden_target_ids) || fixture.forbidden_target_ids.length > 5000 || fixture.forbidden_target_ids.some((id) => typeof id !== 'string' || id.length > 128)) errors.push('forbidden_target_ids must be a bounded string list');
  if (fixture?.forbidden_strings !== undefined && (!Array.isArray(fixture.forbidden_strings) || fixture.forbidden_strings.length > 100 || fixture.forbidden_strings.some((value) => typeof value !== 'string' || value.length > 500))) errors.push('forbidden_strings must be a bounded string list');
  const notes = Array.isArray(fixture?.notes) ? fixture.notes : [];
  const byRel = new Map();
  for (const note of notes) {
    if (!note || typeof note.rel !== 'string' || !note.rel || note.rel.length > 500 || byRel.has(note.rel) ||
        typeof note.title !== 'string' || !note.title || note.title.length > 240 || typeof note.raw !== 'string' || note.raw.length > 50_000 ||
        typeof note.body !== 'string' || note.body.length > 200_000 || note.private === true || note.generated === true ||
        /^private:\s*(?:true|yes)\s*$/mi.test(note.raw || '') || /^generated_by:\s*\S/m.test(note.raw || '')) {
      errors.push('notes must be unique, bounded, visible, non-generated records');
      continue;
    }
    byRel.set(note.rel, note);
  }
  const idRecords = notes.map((note) => ({
    id: String(note?.raw || '').match(/^id:\s*([a-z][a-z0-9._:-]{1,127})\s*$/m)?.[1],
    scope: String(note?.raw || '').match(/^scope:\s*(personal|organisation|client)\s*$/m)?.[1],
    type: String(note?.raw || '').match(/^type:\s*([a-z]+)\s*$/m)?.[1],
    status: String(note?.raw || '').match(/^status:\s*([a-z]+)\s*$/m)?.[1],
  }));
  const ids = new Set(idRecords.map(({ id }) => id).filter(Boolean));
  if (idRecords.some(({ id, scope, type, status }) => !id || !scope || !TYPED_ENTITY_TYPES.includes(type) || status !== 'current') || ids.size !== idRecords.filter(({ id }) => id).length) errors.push('visible typed records must have unique IDs, a valid type and scope, and current status');
  const idScopes = new Map(idRecords.filter(({ id }) => id).map(({ id, scope }) => [id, scope]));
  const caseIds = new Set(), caseSources = new Set();
  for (const item of Array.isArray(fixture?.cases) ? fixture.cases : []) {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || caseIds.has(item.id) || !byRel.has(item.source) || !Array.isArray(item.expected) || item.expected.length > 30) {
      errors.push('each case needs a unique ID, visible source note, and bounded expected edge list');
      continue;
    }
    caseIds.add(item.id);
    if (caseSources.has(item.source)) errors.push('each source note may appear in only one case');
    caseSources.add(item.source);
    const sourceScope = String(byRel.get(item.source)?.raw || '').match(/^scope:\s*([a-z]+)\s*$/m)?.[1];
    for (const edge of item.expected) {
      if (!edge || !TYPED_RELATION_PREDICATES.includes(edge.predicate) || typeof edge.target_id !== 'string' || !ids.has(edge.target_id)) errors.push('expected edges must name visible target IDs and allowlisted predicates');
      else if (!sourceScope || idScopes.get(edge.target_id) !== sourceScope) errors.push('expected edges must stay within the source scope');
    }
  }
  return [...new Set(errors)];
}

// This evaluator measures only the deterministic proposal detector on a supplied, already
// authorized fictional corpus. It does not read user vaults, write notes, or promote edges.
export function evaluateTypedGraphDiscovery(fixture, { fixtureBytes } = {}) {
  const errors = validateTypedGraphFixture(fixture);
  if (errors.length) throw new Error(`Invalid typed graph fixture: ${errors.join('; ')}`);
  const notes = fixture.notes.map((note) => ({ ...note }));
  const byRel = new Map(notes.map((note, index) => [note.rel, index]));
  const forbidden = new Set(fixture.forbidden_target_ids || []);
  const canaries = Array.isArray(fixture.forbidden_strings) ? fixture.forbidden_strings.filter((x) => typeof x === 'string' && x.length > 0) : [];
  const expectedAll = new Set();
  const predictedAll = new Set();
  let privacyViolations = 0;
  let caseLatency = 0;
  for (const item of fixture.cases) {
    const source = byRel.get(item.source);
    const started = performance.now();
    const candidates = discoverTypedRelationshipCandidates(notes, source, { limit: 30 });
    caseLatency += performance.now() - started;
    const predicted = new Set();
    for (const candidate of candidates) {
      const candidateText = JSON.stringify(candidate);
      if ([...forbidden].some((secret) => candidateText.includes(secret)) || canaries.some((secret) => candidateText.includes(secret))) privacyViolations++;
      predicted.add(`${item.source}\0${candidate.predicate}\0${candidate.target_id}`);
    }
    for (const edge of item.expected) expectedAll.add(`${item.source}\0${edge.predicate}\0${edge.target_id}`);
    for (const key of predicted) predictedAll.add(key);
  }
  let truePositive = 0;
  for (const key of predictedAll) if (expectedAll.has(key)) truePositive++;
  const falsePositive = predictedAll.size - truePositive;
  const falseNegative = expectedAll.size - truePositive;
  const precision = predictedAll.size ? truePositive / predictedAll.size : 0;
  const recall = expectedAll.size ? truePositive / expectedAll.size : 1;
  const caseCount = fixture.cases.length;
  const eligibleForReview = caseCount >= TYPED_GRAPH_MIN_CASES && privacyViolations === 0;
  const bytes = fixtureBytes || Buffer.from(JSON.stringify(fixture));
  const output = {
    schema: 1,
    evaluator_version: TYPED_GRAPH_EVALUATOR_VERSION,
    fixture_sha256: createHash('sha256').update(bytes).digest('hex'),
    case_count: caseCount,
    expected_edges: expectedAll.size,
    predicted_edges: predictedAll.size,
    true_positive: truePositive,
    false_positive: falsePositive,
    false_negative: falseNegative,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number((precision + recall ? 2 * precision * recall / (precision + recall) : 0).toFixed(4)),
    privacy_violations: privacyViolations,
    mean_latency_ms: Number((caseLatency / caseCount).toFixed(3)),
    decision: privacyViolations ? 'blocked_privacy' : eligibleForReview ? 'eligible_for_human_review' : 'needs_more_cases',
    auto_promotion: false,
  };
  const serialized = JSON.stringify(output);
  if (canaries.some((secret) => serialized.includes(secret)) || notes.some((note) => [note.rel, note.title, ...[...note.raw.matchAll(/^id:\s*(.+)$/gm)].map((match) => match[1])].some((value) => value && serialized.includes(value)))) {
    throw new Error('Typed graph evaluation output contains fixture content.');
  }
  return output;
}
