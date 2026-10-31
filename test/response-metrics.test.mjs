import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateReadResponseTokens, isReadResponseSizeTool } from '../src/response-metrics.mjs';
import { estTokens } from '../src/sessions/tokens.mjs';

test('response-size telemetry estimates selected read-only results without persisting content', () => {
  assert.equal(isReadResponseSizeTool('vault_search'), true);
  assert.equal(isReadResponseSizeTool('context_packet'), true);
  const serialized = JSON.stringify({ result: 'fictional-only' });
  assert.equal(estimateReadResponseTokens('vault_search', serialized), estTokens(serialized));
  assert.equal(estimateReadResponseTokens('propose_note', JSON.stringify({ preview: 'private candidate' })), null);
  assert.equal(estimateReadResponseTokens('vault_search', 'x'.repeat(1_000_005)), null);
  assert.equal(estimateReadResponseTokens('vault_read_note', null), null);
});
