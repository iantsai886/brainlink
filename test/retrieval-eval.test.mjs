import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, saveConfig } from '../src/config.mjs';
import { compareReviewTrust, createContext, loadVault, searchWithVerdict } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import { VectorStore, fillVectors } from '../src/embed.mjs';
import { evaluateRetrieval, validateRetrievalFixture, decideIndependentComparison, decideRetrievalComparison } from '../src/retrieval-eval.mjs';
import { estTokens } from '../src/sessions/tokens.mjs';
import { compactSearchResponse } from '../src/search-projection.mjs';
import { buildContextPacket } from '../src/context-packet.mjs';
import { buildAnswerReceipt } from '../src/answer-receipt.mjs';
const execFileAsync = promisify(execFile);

test('RSI comparison gates prioritize privacy, sample size, and quality before efficiency', () => {
  const cases = [
    [{ privacyOk: false, enoughCases: true, qualityOk: true, smallerContext: true }, 'blocked_privacy'],
    [{ privacyOk: true, enoughCases: false, qualityOk: true, smallerContext: true }, 'needs_more_cases'],
    [{ privacyOk: true, enoughCases: true, qualityOk: false, smallerContext: true }, 'quality_regression'],
    [{ privacyOk: true, enoughCases: true, qualityOk: true, smallerContext: true }, 'eligible_for_review'],
    [{ privacyOk: true, enoughCases: true, qualityOk: true, smallerContext: false }, 'no_demonstrated_efficiency_gain'],
    [{ privacyOk: false, enoughCases: false, qualityOk: false, smallerContext: true }, 'blocked_privacy'],
  ];
  for (const [input, expected] of cases) assert.equal(decideIndependentComparison(input), expected);
});

test('retrieval RSI rejects regressions before allowing human review', () => {
  const cases = [
    [{ privacyOk: false, enoughCases: true, qualityRegression: false, qualityGain: true }, 'blocked_privacy'],
    [{ privacyOk: true, enoughCases: false, qualityRegression: false, qualityGain: true }, 'needs_more_cases'],
    [{ privacyOk: true, enoughCases: true, qualityRegression: true, qualityGain: true }, 'quality_regression'],
    [{ privacyOk: true, enoughCases: true, qualityRegression: false, qualityGain: true }, 'eligible_for_review'],
    [{ privacyOk: true, enoughCases: true, qualityRegression: false, qualityGain: false }, 'no_demonstrated_gain'],
  ];
  for (const [input, expected] of cases) assert.equal(decideRetrievalComparison(input), expected);
});

test('retrieval experiment is scoped, privacy-safe, token-measured and never self-promotes on too few cases', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-rsi-eval-'));
  const vaultPath = path.join(root, 'Company');
  await mkdir(vaultPath);
  await writeFile(path.join(vaultPath, 'Launch.md'), '# Launch\nThe fictional bluebird product will launch next month.');
  await writeFile(path.join(vaultPath, 'Schedule.md'), '# Schedule\nA fictional conference schedule for attendees.');
  await writeFile(path.join(vaultPath, 'Private.md'), '---\nprivate: true\n---\nZQXPRIVATECANARY launch budget');
  const ctx = createContext(normalize({ vaults: [{ name: 'Company', path: vaultPath }] }), { env: { BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_VAULTS: 'Company', BRAINLINK_SEMANTIC: '0' } });
  const fixture = { schema: 1, vault: 'Company', topK: 2, cases: [
    { id: 'case_01', query: 'when is the bluebird launch', queries: ['fictional bluebird product launch next month'], expected: ['Launch.md'], forbidden: ['Private.md'] },
    { id: 'case_02', query: 'conference schedule', expected: ['Schedule.md'], forbidden: ['Private.md'] },
  ] };
  const report = await evaluateRetrieval(ctx, fixture);
  assert.equal(report.case_count, 2);
  assert.equal(report.decision, 'needs_more_cases');
  assert.equal(report.baseline.privacy_violations, 0);
  assert.equal(report.result.privacy_violations, 0);
  assert.ok(report.baseline.mean_estimated_output_tokens > 0);
  assert.match(report.fixture_sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(report), /ZQXPRIVATECANARY|fictional bluebird product|Private\.md|Launch\.md/);
  await assert.rejects(evaluateRetrieval(ctx, { ...fixture, cases: [{ ...fixture.cases[0], expected: ['Private.md'] }] }), /private/i);
  const excluded = createContext(ctx.cfg, { env: { BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_VAULTS: 'Other' } });
  await assert.rejects(evaluateRetrieval(excluded, fixture), /not enabled/);
});

test('retrieval fixture rejects missing labels, duplicate IDs and oversized rephrasings', () => {
  const invalid = { schema: 1, vault: 'Company', topK: 3, cases: [
    { id: 'same', query: 'a', expected: ['Note.md'] }, { id: 'same', query: 'b', expected: [], queries: Array(5).fill('x') },
  ] };
  assert.match(validateRetrievalFixture(invalid).join('; '), /unique/);
  assert.match(validateRetrievalFixture(invalid).join('; '), /expected/);
  assert.match(validateRetrievalFixture(invalid).join('; '), /rephrasings/);
});

test('frozen Acme RSI benchmark keeps its private canary out and is eligible only for human review', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-rsi-frozen-'));
  const vaultPath = path.resolve('samples/evaluation/vault');
  const fixturePath = path.resolve('samples/evaluation/retrieval-rsi-v1.json');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const ctx = createContext(normalize({ vaults: [{ name: 'Acme Eval', path: vaultPath }] }), {
    env: { BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_VAULTS: 'Acme Eval', BRAINLINK_SEMANTIC: '0' },
  });
  const report = await evaluateRetrieval(ctx, fixture);
  assert.equal(report.case_count, 21);
  assert.ok(['eligible_for_review', 'no_demonstrated_gain'].includes(report.decision));
  assert.equal(report.baseline.privacy_violations, 0);
  assert.equal(report.result.privacy_violations, 0);
  assert.equal(report.result.mean_estimated_output_tokens, report.baseline.mean_estimated_output_tokens);
  assert.doesNotMatch(JSON.stringify(report), /RSI_PRIVATE_CANARY_9D7|Acquisition Budget\.md|Northwind Coffee\.md/);
});

test('independent frozen retrieval set reports quality, abstention, context, latency and privacy without disclosing canaries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-independent-eval-'));
  const fixturePath = path.resolve('samples/evaluation/retrieval-independent-v1.json');
  const fixtureBytes = await readFile(fixturePath);
  const fixture = JSON.parse(fixtureBytes.toString('utf8'));
  const ctx = createContext(normalize({ vaults: [{ name: fixture.vault, path: path.resolve('samples/evaluation/independent-vault') }] }), {
    env: { BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_VAULTS: fixture.vault, BRAINLINK_SEMANTIC: '0' },
  });
  const report = await evaluateRetrieval(ctx, fixture, { fixtureBytes, receipt: { source_commit: 'fixture-test-commit', environment: { node: 'test-node' } } });
  const output = JSON.stringify(report);
  assert.equal(report.schema, 2);
  assert.equal(report.case_count, 30);
  assert.equal(report.fixture_sha256, createHashForTest(fixtureBytes));
  assert.equal(report.evaluator_version, 'retrieval-eval-v4');
  assert.equal(report.source_commit, 'fixture-test-commit');
  assert.equal(report.baseline.privacy_violations, 0);
  assert.equal(report.candidate.privacy_violations, 0);
  assert.equal(report.candidate_policy.tuned_on_fixture, false);
  assert.equal(report.candidate_policy.id, 'compact-search-v1');
  assert.equal(report.candidate_policy.selected_sources_preserved, true);
  assert.ok(report.baseline.mean_latency_ms >= 0);
  assert.ok(report.candidate.mean_latency_ms >= 0);
  assert.ok(report.baseline.context.mean_estimated_tokens > report.candidate.context.mean_estimated_tokens);
  assert.equal(report.baseline.task_success.total, 30);
  assert.equal(report.candidate.task_success.total, 30);
  assert.ok(report.baseline.abstention.expected >= 5);
  assert.equal(report.baseline.source_correctness.source_recall, 1);
  assert.equal(report.candidate.source_correctness.source_recall, 1);
  assert.equal(report.baseline.ranking.answerable_cases, report.baseline.source_correctness.answerable_cases);
  assert.ok(report.baseline.ranking.mean_reciprocal_rank > 0);
  assert.ok(report.candidate.ranking.mean_reciprocal_rank > 0);
  assert.equal(report.candidate.task_success.count, report.baseline.task_success.count);
  assert.ok(report.candidate.abstention.false <= report.baseline.abstention.false);
  assert.ok(report.candidate.abstention.missed <= report.baseline.abstention.missed);
  assert.equal(report.decision, 'eligible_for_review');
  assert.ok(Array.isArray(report.candidate.failures));
  assert.doesNotMatch(output, /INDEPENDENT_PRIVATE_CANARY_7C91|INDEPENDENT_FOREIGN_PROFILE_CANARY_A04F|INDEPENDENT_EXCLUDED_CANARY_28BD|SL-661|88421|Personal Budget\.md|Private Handoff\.md|Archive Record\.md|Silver Larch/);
  for (const marker of ['INDEPENDENT_PRIVATE_CANARY_7C91', 'INDEPENDENT_FOREIGN_PROFILE_CANARY_A04F', 'INDEPENDENT_EXCLUDED_CANARY_28BD']) {
    const found = await searchWithVerdict(ctx, fixture.vault, marker, { semantic: false });
    assert.doesNotMatch(JSON.stringify(found), new RegExp(marker));
  }
  const answerable = fixture.cases.filter((c) => c.answerable), unanswerable = fixture.cases.filter((c) => !c.answerable), interleaved = [];
  for (let i = 0; i < Math.max(answerable.length, unanswerable.length); i++) {
    if (answerable[i]) interleaved.push(answerable[i]);
    if (unanswerable[i]) interleaved.push(unanswerable[i]);
  }
  const reordered = await evaluateRetrieval(ctx, { ...fixture, cases: interleaved });
  assert.equal(reordered.baseline.source_correctness.source_recall, report.baseline.source_correctness.source_recall, 'source recall is invariant to answerable/unanswerable case ordering');
  assert.equal(reordered.candidate.source_correctness.source_recall, report.candidate.source_correctness.source_recall, 'candidate source recall is invariant to case ordering');
  await assert.rejects(evaluateRetrieval(ctx, { ...fixture, cases: [{ ...fixture.cases[0], answerable: false }] }), /empty expected array/);
});

test('compact vault_search preserves every source and snippet across the independent set while reducing response size', async () => {
  const fixture = JSON.parse(await readFile(path.resolve('samples/evaluation/retrieval-independent-v1.json'), 'utf8'));
  const ctx = createContext(normalize({ vaults: [{ name: fixture.vault, path: path.resolve('samples/evaluation/independent-vault') }] }), { env: { BRAINLINK_SEMANTIC: '0' } });
  const tool = createMcp(ctx).tools.find((item) => item.name === 'vault_search');
  const contextFields = ['path', 'title', 'date', 'status', 'historical', 'superseded_by', 'match', 'heading', 'snippet'];
  let fullTokens = 0, compactTokens = 0;
  for (const c of fixture.cases) {
    const args = { vault: fixture.vault, query: c.query, limit: fixture.topK };
    const compact = await tool.run(args);
    const full = await tool.run({ ...args, detail: 'full' });
    assert.equal(compact.status, full.status, c.id);
    assert.equal(compact.coverage, full.coverage, c.id);
    assert.deepEqual(compact.results, full.results.map((result) => Object.fromEntries(contextFields.filter((key) => Object.hasOwn(result, key)).map((key) => [key, result[key]]))), c.id);
    if (c.answerable) for (const expected of c.expected) assert.ok(compact.results.some((result) => result.path === expected), `${c.id} retains ${expected}`);
    for (const forbidden of c.forbidden || []) assert.ok(!compact.results.some((result) => result.path === forbidden), `${c.id} excludes ${forbidden}`);
    fullTokens += estTokens(JSON.stringify(full));
    compactTokens += estTokens(JSON.stringify(compact));
  }
  assert.ok(compactTokens < fullTokens);
});

test('default context packet preserves frozen-set task success and source recall with a smaller cited response', async () => {
  const fixture = JSON.parse(await readFile(path.resolve('samples/evaluation/retrieval-independent-v1.json'), 'utf8'));
  const ctx = createContext(normalize({ vaults: [{ name: fixture.vault, path: path.resolve('samples/evaluation/independent-vault') }] }), { env: { BRAINLINK_SEMANTIC: '0' } });
  const searchTool = createMcp(ctx).tools.find((item) => item.name === 'vault_search');
  const packetTool = createMcp(ctx).tools.find((item) => item.name === 'context_packet');
  let baseSuccess = 0, packetSuccess = 0, baseRecall = 0, packetRecall = 0, expectedSources = 0;
  let baseTokens = 0, packetTokens = 0, privacyHits = 0;
  const succeeds = (results, status, item) => {
    if (!item.answerable) return status !== 'hits';
    const text = results.map((source) => `${source.title || ''}\n${source.heading || ''}\n${source.snippet || source.excerpt || ''}`).join('\n').toLowerCase();
    return status === 'hits' && item.expected.every((source) => results.some((result) => result.path === source))
      && (item.required_context || []).every((phrase) => text.includes(phrase.toLowerCase()));
  };
  for (const item of fixture.cases) {
    const args = { vault: fixture.vault, query: item.query, limit: fixture.topK };
    const baseline = await searchTool.run(args);
    const packet = await packetTool.run({ vault: fixture.vault, query: item.query });
    const compact = compactSearchResponse(baseline);
    const packetResults = packet.sources.map((source) => ({ ...source, snippet: source.excerpt }));
    baseSuccess += Number(succeeds(compact.results, compact.status, item));
    packetSuccess += Number(succeeds(packetResults, packet.status, item));
    if (item.answerable) {
      expectedSources += item.expected.length;
      baseRecall += item.expected.filter((source) => compact.results.some((result) => result.path === source)).length;
      packetRecall += item.expected.filter((source) => packetResults.some((result) => result.path === source)).length;
    }
    privacyHits += (item.forbidden || []).filter((source) => packetResults.some((result) => result.path === source)).length;
    baseTokens += estTokens(JSON.stringify(compact));
    packetTokens += estTokens(JSON.stringify(packet));
  }
  assert.equal(packetTool.inputSchema.properties.max_sources.default, 4);
  assert.equal(packetTool.inputSchema.properties.excerpt_chars.default, 300);
  assert.equal(baseSuccess, 17);
  assert.equal(packetSuccess, baseSuccess);
  assert.equal(packetRecall, baseRecall);
  assert.equal(privacyHits, 0);
  assert.ok(packetTokens < baseTokens * 0.85, `packet tokens ${packetTokens} should be at least 15% below compact search ${baseTokens}`);
});

test('answer receipts cite only permission-filtered sources and stay compact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-answer-receipt-'));
  const vaultPath = path.join(root, 'Company');
  await mkdir(vaultPath);
  await writeFile(path.join(vaultPath, 'Reviewed.md'), '---\nstatus: active\nconfidence: reported\n---\n# Shipping policy\nFictional shipping takes two business days.');
  await writeFile(path.join(vaultPath, 'Private.md'), '---\nprivate: true\nstatus: verified\nconfidence: verified\n---\n# Shipping policy\nRECEIPT_PRIVATE_CANARY');
  const ctx = createContext(normalize({ vaults: [{ name: 'Company', path: vaultPath }] }), { env: { BRAINLINK_HOME: path.join(root, 'home'), BRAINLINK_SEMANTIC: '0' } });
  const search = createMcp(ctx).tools.find((item) => item.name === 'vault_search');
  const packetTool = createMcp(ctx).tools.find((item) => item.name === 'context_packet');
  const found = await search.run({ vault: 'Company', query: 'shipping policy' });
  assert.equal(found.receipt.searched_vault, 'Company');
  assert.equal(found.receipt.search_mode, 'keyword');
  assert.equal(found.receipt.basis, 'reviewed');
  assert.deepEqual(found.receipt.sources.map((source) => source.path), found.results.map((source) => source.path));
  assert.ok(found.receipt.sources.every((source) => source.path !== 'Private.md'));
  assert.doesNotMatch(JSON.stringify(found), /RECEIPT_PRIVATE_CANARY|Private\.md/);
  assert.ok(estTokens(JSON.stringify(found.receipt)) < 150);
  const packet = await packetTool.run({ vault: 'Company', query: 'shipping policy' });
  assert.deepEqual(packet.receipt.sources.map((source) => source.path), packet.sources.map((source) => source.path));
  assert.doesNotMatch(JSON.stringify(packet), /RECEIPT_PRIVATE_CANARY|Private\.md/);
  const none = buildAnswerReceipt({ status: 'not_in_brain', results: [], missing_words: ['unmatched'] }, { vault: 'Company' });
  assert.equal(none.basis, 'none');
  assert.deepEqual(none.sources, []);
  assert.deepEqual(none.missing_words, ['unmatched']);
});

test('equal-relevance retrieval prefers reviewed notes without changing the frozen top-five quality', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-trust-rank-'));
  const vaultPath = path.join(root, 'Company');
  await mkdir(vaultPath);
  await writeFile(path.join(vaultPath, 'A Proposed.md'), '---\nstatus: proposed\nconfidence: reported\n---\n# Dispatch cadence\nFictional dispatch occurs every Thursday.');
  await writeFile(path.join(vaultPath, 'Z Active.md'), '---\nstatus: active\nconfidence: reported\n---\n# Dispatch cadence\nFictional dispatch occurs every Thursday.');
  const ctx = createContext(normalize({ vaults: [{ name: 'Company', path: vaultPath }] }), { env: { BRAINLINK_HOME: path.join(root, 'home'), BRAINLINK_SEMANTIC: '0' } });
  assert.ok(compareReviewTrust({ meta: { status: 'active' } }, { meta: { status: 'proposed' } }) < 0, 'active wins an exact score tie');
  assert.ok(compareReviewTrust({ meta: { confidence: 'verified' } }, { meta: { status: 'draft' } }) < 0, 'verified wins an exact score tie');
  const found = await searchWithVerdict(ctx, 'Company', 'dispatch cadence', { semantic: false, limit: 2 });
  assert.deepEqual(new Set(found.results.map((source) => source.path)), new Set(['Z Active.md', 'A Proposed.md']));
  const fixture = JSON.parse(await readFile(path.resolve('samples/evaluation/retrieval-independent-v1.json'), 'utf8'));
  const evalCtx = createContext(normalize({ vaults: [{ name: fixture.vault, path: path.resolve('samples/evaluation/independent-vault') }] }), { env: { BRAINLINK_HOME: path.join(root, 'eval-home'), BRAINLINK_SEMANTIC: '0' } });
  const report = await evaluateRetrieval(evalCtx, fixture);
  assert.equal(report.candidate.hit_at_k, report.baseline.hit_at_k);
  assert.equal(report.candidate.reciprocal_rank, report.baseline.reciprocal_rank);
});

test('independent retrieval CLI accepts an explicit fictional vault and emits an exact-byte reproducibility receipt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-independent-cli-'));
  const fixturePath = path.resolve('samples/evaluation/retrieval-independent-v1.json');
  const fixtureBytes = await readFile(fixturePath);
  const { stdout } = await execFileAsync(process.execPath, [path.resolve('bin/brainlink.mjs'), 'eval', '--fixture', fixturePath, '--vault-root', path.resolve('samples/evaluation/independent-vault')], {
    cwd: process.cwd(), env: { ...process.env, BRAINLINK_HOME: path.join(root, 'home'), BRAINLINK_SEMANTIC: '0' },
  });
  const report = JSON.parse(stdout);
  assert.equal(report.fixture_sha256, createHashForTest(fixtureBytes));
  assert.equal(report.evaluator_version, 'retrieval-eval-v4');
  assert.equal(report.case_count, 30);
  assert.equal(report.environment.node, process.version);
  assert.equal(report.source_commit, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  assert.equal(report.source_branch, execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() || null);
});

function createHashForTest(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('semantic cache prunes vectors from notes no longer visible in the vault index', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-vector-prune-'));
  const vaultPath = path.join(root, 'Vault');
  await mkdir(vaultPath);
  await writeFile(path.join(vaultPath, 'Private.md'), '---\nprivate: true\n---\nZQXVECTORPRIVATE');
  const ctx = createContext(normalize({ vaults: [{ name: 'Company', path: vaultPath }] }), { env: { BRAINLINK_HOME: path.join(root, 'app') } });
  const index = await loadVault(ctx, 'Company');
  assert.equal(index.chunks.length, 0);
  const store = new VectorStore(path.join(root, 'app'), vaultPath, 'fictional-model');
  await store.load();
  store.vectors.set('old-private-chunk-key', Float32Array.of(1, 2));
  store.dirty = true;
  await store.save();
  await fillVectors({ url: 'unused', model: 'fictional-model' }, store, index);
  assert.equal(store.vectors.size, 0);
  const reopened = new VectorStore(path.join(root, 'app'), vaultPath, 'fictional-model');
  await reopened.load();
  assert.equal(reopened.vectors.size, 0);
});

test('CLI evaluation prints only aggregate evidence for a fictional fixture', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-rsi-cli-'));
  const vaultPath = path.join(root, 'Vault');
  const home = path.join(root, 'home');
  await mkdir(vaultPath);
  await writeFile(path.join(vaultPath, 'Public.md'), '# Public\nFictional bluebird garden project.');
  await writeFile(path.join(vaultPath, 'Secret.md'), '---\nprivate: true\n---\nZQXCLI_PRIVATE_CANARY');
  await saveConfig(normalize({ vaults: [{ name: 'Company', path: vaultPath }] }), path.join(home, 'config.json'));
  const fixturePath = path.join(root, 'fixture.json');
  await writeFile(fixturePath, JSON.stringify({ schema: 1, vault: 'Company', topK: 2, cases: [
    { id: 'opaque01', query: 'bluebird garden', expected: ['Public.md'], forbidden: ['Secret.md'] },
  ] }));
  const { stdout } = await execFileAsync(process.execPath, [path.resolve('bin/brainlink.mjs'), 'eval', '--fixture', fixturePath], {
    cwd: process.cwd(), env: { ...process.env, BRAINLINK_HOME: home, HOME: root, BRAINLINK_SEMANTIC: '0' },
  });
  const report = JSON.parse(stdout);
  assert.equal(report.decision, 'needs_more_cases');
  assert.equal(report.baseline.privacy_violations, 0);
  assert.doesNotMatch(stdout, /ZQXCLI_PRIVATE_CANARY|Secret\.md|Public\.md|bluebird garden/);
});
