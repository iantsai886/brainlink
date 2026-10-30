import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDiscoveryFixture, runDiscoveryEvaluation, validateDiscoveryFixture } from '../src/rsi-discovery-evaluation.mjs';

test('fixed discovery fixture produces a bounded, private aggregate receipt', async () => {
  const result = await runDiscoveryEvaluation();
  assert.equal(result.suite, 'rsi-discovery-v1');
  assert.equal(result.method_version, 'lexical-topic-gate-v3');
  assert.equal(result.sample_count, 28);
  assert.deepEqual(result.metrics, { precision: 1, recall: 1, f1: 1, true_positive: 12, false_positive: 0, false_negative: 0, true_negative: 16 });
  assert.equal(result.guardrails.hostile_entries_accepted, 0);
  assert.match(result.fixture_sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.metrics.precision >= 0 && result.metrics.precision <= 1);
  assert.ok(result.metrics.recall >= 0 && result.metrics.recall <= 1);
  assert.doesNotMatch(JSON.stringify(result), /weather|workflow automation notes|private notes|summary text/i);
  assert.ok(['no_discovery_errors_on_fixture', 'review_discovery_errors'].includes(result.decision));
});

test('discovery fixture rejects malformed labels and duplicate case IDs', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('../samples/evaluation/rsi-discovery-v1.json', import.meta.url), 'utf8'));
  assert.throws(() => validateDiscoveryFixture({ ...fixture, cases: [{ ...fixture.cases[0], relevant: 'yes' }, ...fixture.cases.slice(1)] }), /case is invalid/);
  assert.throws(() => validateDiscoveryFixture({ ...fixture, cases: [fixture.cases[0], ...fixture.cases.slice(1), { ...fixture.cases[0] }] }), /case is invalid/);
  assert.throws(() => evaluateDiscoveryFixture({ ...fixture, minimum_cases: 100 }), /invalid or too small/);
});
