import test from 'node:test';
import assert from 'node:assert/strict';
import { createRsiExperiments, RSI_EXPERIMENT_SUITES } from '../src/rsi-experiments.mjs';

test('RSI experiment runner only exposes the fixed fictional suites and returns aggregate receipts', async () => {
  const runner = createRsiExperiments({ env: { BRAINLINK_HOME: 'must-not-be-used' } });
  assert.deepEqual(Object.keys(RSI_EXPERIMENT_SUITES), ['retrieval-rsi-v1', 'retrieval-independent-v1']);
  assert.equal(runner.suites().length, 2);
  await assert.rejects(runner.run('../private-vault'), /built-in fictional/);
  for (const suite of runner.suites()) {
    const receipt = await runner.run(suite.id);
    assert.equal(receipt.suite, suite.id);
    assert.match(receipt.fixture_sha256, /^[a-f0-9]{64}$/);
    assert.ok(receipt.sample_count >= 20);
    assert.equal(receipt.guardrails.candidate_privacy_violations, 0);
    assert.doesNotMatch(JSON.stringify(receipt), /query|snippet|RSI_PRIVATE_CANARY|Acquisition Budget\.md|Northwind Coffee\.md|vault_path/i);
    assert.ok(['eligible_for_review', 'needs_more_cases', 'no_demonstrated_gain', 'blocked_privacy', 'quality_regression', 'no_demonstrated_efficiency_gain'].includes(receipt.decision));
  }
});
