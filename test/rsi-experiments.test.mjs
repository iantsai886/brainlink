import test from 'node:test';
import assert from 'node:assert/strict';
import { createRsiExperiments, RSI_EXPERIMENT_SUITES } from '../src/rsi-experiments.mjs';

test('RSI experiment runner only exposes the fixed fictional suites and returns aggregate receipts', async () => {
  const source = { commit_sha: 'a'.repeat(40), clean: true };
  const runner = createRsiExperiments({ env: { BRAINLINK_HOME: 'must-not-be-used' }, sourceState: () => source });
  assert.deepEqual(Object.keys(RSI_EXPERIMENT_SUITES), ['retrieval-rsi-v1', 'retrieval-independent-v1']);
  assert.equal(runner.suites().length, 2);
  await assert.rejects(runner.run('../private-vault'), /built-in fictional/);
  for (const suite of runner.suites()) {
    const receipt = await runner.run(suite.id);
    assert.equal(receipt.suite, suite.id);
    assert.equal(receipt.evaluator_version, 'retrieval-eval-v3');
    assert.equal(receipt.schema, 2);
    assert.equal(receipt.source_commit_sha, source.commit_sha);
    assert.equal(receipt.source_stable, true);
    assert.equal(receipt.source_tree_clean_after, true);
    if (suite.id === 'retrieval-independent-v1') assert.equal(receipt.candidate_version, 'compact-search-v1');
    assert.match(receipt.fixture_sha256, /^[a-f0-9]{64}$/);
    assert.ok(receipt.sample_count >= 20);
    assert.equal(receipt.guardrails.candidate_privacy_violations, 0);
    assert.doesNotMatch(JSON.stringify(receipt), /query|snippet|RSI_PRIVATE_CANARY|Acquisition Budget\.md|Northwind Coffee\.md|vault_path/i);
    assert.ok(['eligible_for_review', 'needs_more_cases', 'no_demonstrated_gain', 'blocked_privacy', 'quality_regression', 'no_demonstrated_efficiency_gain'].includes(receipt.decision));
  }
});

test('RSI experiment is not eligible when Git is missing, dirty, or changes during the run', async () => {
  const states = [
    [{ commit_sha: null, clean: false }, { commit_sha: null, clean: false }],
    [{ commit_sha: 'b'.repeat(40), clean: false }, { commit_sha: 'b'.repeat(40), clean: false }],
    [{ commit_sha: 'c'.repeat(40), clean: true }, { commit_sha: 'd'.repeat(40), clean: true }],
  ];
  for (const pair of states) {
    let index = 0;
    const runner = createRsiExperiments({ sourceState: () => pair[index++] });
    const receipt = await runner.run('retrieval-independent-v1');
    assert.equal(receipt.source_stable, false);
    assert.equal(receipt.decision, 'source_unbound');
  }
});
