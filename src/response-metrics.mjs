import { estTokens } from './sessions/tokens.mjs';

const RESPONSE_SIZE_TOOLS = new Set([
  'brainlink_guide', 'vault_search', 'context_packet', 'vault_read_note', 'vault_related', 'vault_recent',
  'search', 'fetch', 'open_loops', 'brain_brief', 'session_list', 'session_read',
  'session_filing_folders', 'list_handoffs',
]);
const MAX_RECORDED_ESTIMATE = 250_000;

export function estimateReadResponseTokens(tool, serializedResult) {
  if (!RESPONSE_SIZE_TOOLS.has(tool) || typeof serializedResult !== 'string') return null;
  const estimate = estTokens(serializedResult);
  return Number.isSafeInteger(estimate) && estimate <= MAX_RECORDED_ESTIMATE ? estimate : null;
}

export function isReadResponseSizeTool(tool) {
  return RESPONSE_SIZE_TOOLS.has(tool);
}
