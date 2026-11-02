import test from 'node:test';
import assert from 'node:assert/strict';
import { createRsiExperiments, RSI_EXPERIMENT_SUITES } from '../src/rsi-experiments.mjs';

test('RSI experiment runner only exposes the fixed fictional suites and returns aggregate receipts', async () => {
  const source = { commit_sha: 'a'.repeat(40), clean: true };
  const runner = createRsiExperiments({ env: { BRAINLINK_HOME: 'must-not-be-used' }, sourceState: () => source });
  assert.deepEqual(Object.keys(RSI_EXPERIMENT_SUITES), ['retrieval-rsi-v1', 'retrieval-independent-v1', 'local-reranker-v1']);
  assert.equal(runner.suites().length, 2);
  assert.deepEqual(runner.suites().map((suite) => suite.label_key), ['rsi.experiment.suite1', 'rsi.experiment.suite2']);
  assert.equal(runner.suites({ rerankerEnabled: true }).length, 3);
  await assert.rejects(runner.run('local-reranker-v1'), /Enable and test the local reranking service/);
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
    const receiptText = JSON.stringify(receipt);
    assert.doesNotMatch(receiptText, /How does Mira prefer trip planning summaries\?|RSI_PRIVATE_CANARY|Acquisition Budget\.md|Northwind Coffee\.md|vault_path/i);
    assert.ok(['eligible_for_review', 'needs_more_cases', 'no_demonstrated_gain', 'blocked_privacy', 'quality_regression', 'no_demonstrated_efficiency_gain'].includes(receipt.decision));
  }
});

test('local reranker RSI uses only synthetic fixture text and fails instead of scoring a silent fallback', async () => {
  const source = { commit_sha: 'e'.repeat(40), clean: true };
  const runner = createRsiExperiments({
    env: { BRAINLINK_HOME: 'must-not-be-used' }, sourceState: () => source,
    getRerankerSettings: async () => ({ enabled: true, url: 'http://127.0.0.1:8080/v1/rerank' }),
  });
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return { ok: true, json: async () => ({ results: body.documents.map((_text, index) => ({ index, relevance_score: -index })) }) };
  };
  try {
    const receipt = await runner.run('local-reranker-v1');
    assert.equal(receipt.sample_count, 21);
    assert.equal(receipt.candidate_version, 'local-reranker-v1');
    assert.equal(receipt.source_stable, true);
    assert.equal(receipt.guardrails.candidate_privacy_violations, 0);
    assert.ok(requests.length >= 10, `expected the enabled reranker to score multiple synthetic cases, got ${requests.length}`);
    const sent = JSON.stringify(requests);
    assert.doesNotMatch(sent, /RSI_PRIVATE_CANARY|Acquisition Budget\.md|Northwind Coffee\.md|vault_path/i);
    assert.ok(requests.every((request) => Object.keys(request).sort().join(',') === 'documents,query,top_n'));
    assert.doesNotMatch(JSON.stringify(receipt), /How does Mira prefer trip planning summaries\?|RSI_PRIVATE_CANARY|Acquisition Budget\.md|Northwind Coffee\.md|vault_path/i);
    assert.ok(receipt.limitations.some((item) => /not an independent held-out set/.test(item)));

    globalThis.fetch = async () => { throw new Error('local service unavailable'); };
    await assert.rejects(runner.run('local-reranker-v1'), /local service unavailable/);
  } finally { globalThis.fetch = originalFetch; }
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
