import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeActivitySignals, compareVaultHealth, sanitizeVaultHealthSnapshot } from '../src/rsi-observations.mjs';

test('RSI observation compares local tool failure counts and returns aggregates only', () => {
  const now = new Date('2026-10-27T12:00:00.000Z');
  const entries = [];
  for (let i = 0; i < 5; i++) entries.push({ at: new Date(now.getTime() - i * 1000).toISOString(), tool: i === 0 ? 'brainlink_guide' : 'vault_search', ok: i === 0, result_token_estimate: 100 + i * 10, platform: 'PRIVATE_AGENT_CANARY', text: 'PRIVATE_NOTE_CANARY' });
  for (let i = 0; i < 5; i++) entries.push({ at: new Date(now.getTime() - 40 * 86400000 - i * 1000).toISOString(), tool: 'vault_search', ok: true, result_token_estimate: 500 + i * 10, agent: 'PRIVATE_OLD_AGENT' });
  for (let i = 0; i < 5; i++) entries.push({ at: now.toISOString(), tool: 'backup_restore', ok: i === 0, path: 'PRIVATE_PATH_CANARY' });
  for (let i = 0; i < 5; i++) entries.push({ at: now.toISOString(), tool: 'source_scan', ok: true, vault: 'PRIVATE_VAULT_CANARY' });
  entries.push({ at: now.toISOString(), tool: 'graph_relationship_review', ok: true, action: 'approved' });
  entries.push({ at: now.toISOString(), tool: 'graph_relationship_review', ok: true, action: 'rejected', evidence: 'PRIVATE_NOTE_CANARY' });
  entries.push({ at: now.toISOString(), tool: 'graph_relationship_review', ok: true, action: 'reopened', path: 'PRIVATE_PATH_CANARY' });
  entries.push({ at: new Date(now.getTime() - 40 * 86400000).toISOString(), tool: 'graph_relationship_review', ok: true, action: 'approved' });
  entries.push({ at: new Date(now.getTime() - 40 * 86400000).toISOString(), tool: 'graph_relationship_review', ok: true, action: 'rejected' });
  entries.push({ at: now.toISOString(), tool: 'vault_read_note', ok: false, mode: 'health-check' });
  entries.push({ at: now.toISOString(), tool: 'custom_tool', ok: false });
  entries.push({ at: 'invalid', tool: 'session_read', ok: false });
  const report = analyzeActivitySignals(entries, { now });
  const retrieval = report.categories.find((item) => item.id === 'retrieval');
  assert.equal(report.events_analyzed, 25);
  assert.deepEqual(retrieval.current, { calls: 5, failures: 4, failure_rate: 0.8 });
  assert.deepEqual(retrieval.previous, { calls: 5, failures: 0, failure_rate: 0 });
  assert.deepEqual(retrieval.current_result_tokens, { samples: 5, mean_estimate: 120 });
  assert.deepEqual(retrieval.previous_result_tokens, { samples: 5, mean_estimate: 520 });
  assert.equal(retrieval.signal, 'review_increase');
  const recovery = report.categories.find((item) => item.id === 'recovery');
  assert.deepEqual(recovery.current, { calls: 5, failures: 4, failure_rate: 0.8 });
  assert.equal(recovery.signal, 'review_failures');
  const filing = report.categories.find((item) => item.id === 'filing');
  assert.deepEqual(filing.current, { calls: 5, failures: 0, failure_rate: 0 });
  assert.equal(report.findings.length, 2);
  const graph = report.categories.find((item) => item.id === 'graph_review');
  assert.deepEqual(graph.current_review_actions, { approved: 1, rejected: 1, reopened: 1 });
  assert.deepEqual(graph.previous_review_actions, { approved: 1, rejected: 1, reopened: 0 });
  assert.deepEqual(graph.current, { calls: 3, failures: 0, failure_rate: 0 });
  assert.deepEqual(report.privacy, { source: 'local_content_free_activity_log', note_content_read: false, raw_events_returned: false, report_saved: false, read_response_content_persisted: false });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_(?:AGENT|NOTE|OLD_AGENT|PATH|VAULT)_CANARY/);
});

test('RSI observation labels small or empty samples as unknown, not as zero failures', () => {
  const now = new Date('2026-10-27T12:00:00.000Z');
  const report = analyzeActivitySignals([
    { at: now.toISOString(), tool: 'send_handoff', ok: true },
    { at: now.toISOString(), tool: 'send_handoff', ok: true },
    { at: now.toISOString(), tool: 'session_close', ok: true, result_token_estimate: 999 },
  ], { now });
  const handoff = report.categories.find((item) => item.id === 'handoff');
  const retrieval = report.categories.find((item) => item.id === 'retrieval');
  const recovery = report.categories.find((item) => item.id === 'recovery');
  const sessions = report.categories.find((item) => item.id === 'sessions');
  const graph = report.categories.find((item) => item.id === 'graph_review');
  assert.equal(handoff.signal, 'insufficient_data');
  assert.equal(retrieval.signal, 'insufficient_data');
  assert.equal(retrieval.current.failure_rate, null);
  assert.deepEqual(retrieval.current_result_tokens, { samples: 0, mean_estimate: null });
  assert.equal(recovery.signal, 'insufficient_data');
  assert.deepEqual(sessions.current_result_tokens, { samples: 0, mean_estimate: null }, 'write previews are not included in read-response size metrics');
  assert.deepEqual(graph.current_review_actions, { approved: 0, rejected: 0, reopened: 0 });
  assert.deepEqual(report.findings, []);
});

test('vault health comparison uses only counts, keeps vaults separate, and reports structural signals', () => {
  const baseline = { typed_entity_count: 5, verified_typed_relation_count: 2, proposed_typed_relation_count: 1, unresolved_typed_relation_count: 2, duplicate_typed_id_count: 1 };
  const previous = sanitizeVaultHealthSnapshot({ notes: 10, links: 8, orphan_count: 4, broken_count: 2, duplicate_title_count: 1, stale_active_count: 3, ...baseline, paths: ['PRIVATE_PATH'], note_text: 'PRIVATE_NOTE' }, 'Personal');
  const current = sanitizeVaultHealthSnapshot({ notes: 10, links: 10, orphan_count: 2, broken_count: 0, duplicate_title_count: 1, stale_active_count: 3, ...baseline, unresolved_typed_relation_count: 1, duplicate_typed_id_count: 1, title: 'PRIVATE_TITLE' }, 'Personal');
  assert.deepEqual(current, { vault: 'Personal', counts: { notes: 10, links: 10, orphan_count: 2, broken_count: 0, duplicate_title_count: 1, stale_active_count: 3, ...baseline, unresolved_typed_relation_count: 1 } });
  assert.deepEqual(compareVaultHealth(current, previous), {
    signal: 'improved',
    changes: { notes: 0, links: 2, orphan_count: -2, broken_count: -2, duplicate_title_count: 0, stale_active_count: 0, typed_entity_count: 0, verified_typed_relation_count: 0, proposed_typed_relation_count: 0, unresolved_typed_relation_count: -1, duplicate_typed_id_count: 0, orphan_rate: -0.2 },
  });
  const worse = sanitizeVaultHealthSnapshot({ notes: 10, links: 5, orphan_count: 5, broken_count: 4, duplicate_title_count: 2, stale_active_count: 3, ...baseline }, 'Personal');
  assert.equal(compareVaultHealth(worse, previous).signal, 'regressed');
  const staleWorse = sanitizeVaultHealthSnapshot({ notes: 10, links: 8, orphan_count: 4, broken_count: 2, duplicate_title_count: 1, stale_active_count: 4, ...baseline }, 'Personal');
  assert.equal(compareVaultHealth(staleWorse, previous).signal, 'regressed', 'stale active notes affect the trend classification');
  const staleBetter = sanitizeVaultHealthSnapshot({ notes: 10, links: 8, orphan_count: 4, broken_count: 2, duplicate_title_count: 1, stale_active_count: 2, ...baseline }, 'Personal');
  assert.equal(compareVaultHealth(staleBetter, previous).signal, 'improved', 'fewer stale active notes affect the trend classification');
  const mixed = sanitizeVaultHealthSnapshot({ notes: 10, links: 9, orphan_count: 1, broken_count: 3, duplicate_title_count: 1, stale_active_count: 3, ...baseline }, 'Personal');
  assert.equal(compareVaultHealth(mixed, previous).signal, 'mixed');
  assert.equal(compareVaultHealth(current, { ...previous, vault: 'Organisation' }).signal, 'baseline_unavailable');
  const legacy = { ...previous, counts: { ...previous.counts } };
  delete legacy.counts.typed_entity_count;
  assert.equal(compareVaultHealth(current, legacy).signal, 'baseline_unavailable', 'old snapshots are not treated as zero-valued typed graph baselines');
  const graphWorse = sanitizeVaultHealthSnapshot({ ...previous.counts, unresolved_typed_relation_count: 3 }, 'Personal');
  assert.equal(compareVaultHealth(graphWorse, previous).signal, 'regressed', 'more unresolved typed relations are a structural regression');
  const graphBetter = sanitizeVaultHealthSnapshot({ ...previous.counts, duplicate_typed_id_count: 0 }, 'Personal');
  assert.equal(compareVaultHealth(graphBetter, previous).signal, 'improved', 'fewer duplicate typed IDs are a structural improvement');
  assert.throws(() => sanitizeVaultHealthSnapshot({ ...current.counts, broken_count: -1 }, 'Personal'), /non-negative/);
  assert.throws(() => sanitizeVaultHealthSnapshot(current.counts, ''), /one valid vault/);
  assert.doesNotMatch(JSON.stringify(current), /PRIVATE_(?:PATH|NOTE|TITLE)/);
});
