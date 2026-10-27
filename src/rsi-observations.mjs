// Privacy-safe RSI observation. It consumes only BrainLink's local, content-free
// tool/outcome activity log and returns aggregates; it never persists a report.
import { isReadResponseSizeTool } from './response-metrics.mjs';
const WINDOWS = Object.freeze({ current: 30, previous: 30 });
const TOOL_GROUPS = Object.freeze({
  retrieval: new Set(['brainlink_guide', 'vault_search', 'vault_related', 'vault_recent', 'vault_read_note', 'search', 'fetch', 'open_loops', 'brain_brief']),
  sessions: new Set(['session_list', 'session_read', 'session_close', 'session_filing_folders']),
  filing: new Set(['ingestion_queue', 'ingestion_record', 'propose_note', 'source_scan']),
  handoff: new Set(['list_handoffs', 'send_handoff']),
  recovery: new Set(['backup', 'backup_restore']),
  graph_review: new Set(['graph_relationship_review']),
});
const GRAPH_REVIEW_ACTIONS = ['approved', 'rejected', 'reopened'];

function blank() { return { calls: 0, failures: 0, failure_rate: null }; }
function finish(bucket) { return { ...bucket, failure_rate: bucket.calls ? Number((bucket.failures / bucket.calls).toFixed(3)) : null }; }
function tokenSummary(values) { return { samples: values.length, mean_estimate: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null }; }

// Persist only a small aggregate snapshot. Do not accept paths, titles, excerpts, or other
// note-derived fields from the vault-health reader.
export function sanitizeVaultHealthSnapshot(input, vault) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Vault health snapshot is invalid.');
  const fields = ['notes', 'links', 'orphan_count', 'broken_count', 'duplicate_title_count', 'stale_active_count'];
  const counts = {};
  for (const field of fields) {
    const value = input[field];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Vault health ${field} must be a non-negative count.`);
    counts[field] = value;
  }
  const name = String(vault || '').trim();
  if (!name || name.length > 100 || /[\r\n]/.test(name)) throw new Error('Choose one valid vault for local health observation.');
  return { vault: name, counts };
}

export function compareVaultHealth(current, previous) {
  if (!current?.counts || !previous?.counts || current.vault !== previous.vault) return { signal: 'baseline_unavailable', changes: null };
  const keys = ['notes', 'links', 'orphan_count', 'broken_count', 'duplicate_title_count', 'stale_active_count'];
  const changes = Object.fromEntries(keys.map((key) => [key, current.counts[key] - previous.counts[key]]));
  const orphanRate = (snapshot) => snapshot.counts.notes ? snapshot.counts.orphan_count / snapshot.counts.notes : null;
  const beforeRate = orphanRate(previous), afterRate = orphanRate(current);
  const orphanRateChange = beforeRate === null || afterRate === null ? null : Number((afterRate - beforeRate).toFixed(4));
  changes.orphan_rate = orphanRateChange;
  const worse = changes.broken_count > 0 || changes.duplicate_title_count > 0 || changes.stale_active_count > 0 || (orphanRateChange !== null && orphanRateChange > 0.01);
  const better = changes.broken_count < 0 || changes.duplicate_title_count < 0 || changes.stale_active_count < 0 || (orphanRateChange !== null && orphanRateChange < -0.01);
  return { signal: worse && better ? 'mixed' : worse ? 'regressed' : better ? 'improved' : 'stable', changes };
}

export function analyzeActivitySignals(entries, { now = new Date() } = {}) {
  const end = now instanceof Date ? now : new Date(now);
  const currentStart = end.getTime() - WINDOWS.current * 86400000;
  const previousStart = currentStart - WINDOWS.previous * 86400000;
  const counts = Object.fromEntries(Object.keys(TOOL_GROUPS).map((key) => [key, { current: blank(), previous: blank(), currentTokens: [], previousTokens: [], currentActions: [], previousActions: [] }]));
  let acceptedEvents = 0;
  for (const entry of Array.isArray(entries) ? entries.slice(-20000) : []) {
    if (!entry || typeof entry !== 'object' || typeof entry.tool !== 'string' || typeof entry.ok !== 'boolean') continue;
    if (['health-check', 'agent-check'].includes(entry.mode)) continue;
    const category = Object.entries(TOOL_GROUPS).find(([, tools]) => tools.has(entry.tool))?.[0];
    if (!category) continue;
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at) || at < previousStart || at > end.getTime()) continue;
    const window = at >= currentStart ? 'current' : 'previous';
    const bucket = counts[category][window];
    bucket.calls++;
    if (!entry.ok) bucket.failures++;
    if (isReadResponseSizeTool(entry.tool) && Number.isSafeInteger(entry.result_token_estimate) && entry.result_token_estimate >= 0 && entry.result_token_estimate <= 250_000) {
      counts[category][window === 'current' ? 'currentTokens' : 'previousTokens'].push(entry.result_token_estimate);
    }
    if (category === 'graph_review' && GRAPH_REVIEW_ACTIONS.includes(entry.action)) {
      counts[category][window === 'current' ? 'currentActions' : 'previousActions'].push(entry.action);
    }
    acceptedEvents++;
  }
  const categories = Object.entries(counts).map(([id, windows]) => {
    const current = finish(windows.current), previous = finish(windows.previous);
    let signal = 'insufficient_data';
    if (current.calls >= 5) {
      signal = 'stable';
      if (current.failures >= 3 && current.failure_rate >= 0.25) signal = 'review_failures';
      if (previous.calls >= 5 && current.failures >= 2 && current.failure_rate - previous.failure_rate >= 0.2) signal = 'review_increase';
    }
    const reviewCounts = (actions) => Object.fromEntries(GRAPH_REVIEW_ACTIONS.map((action) => [action, actions.filter((value) => value === action).length]));
    return { id, current, previous, current_result_tokens: tokenSummary(windows.currentTokens), previous_result_tokens: tokenSummary(windows.previousTokens), current_review_actions: reviewCounts(windows.currentActions), previous_review_actions: reviewCounts(windows.previousActions), signal };
  });
  const findings = categories.filter((item) => item.signal.startsWith('review_')).map((item) => ({
    category: item.id,
    signal: item.signal,
    current_failures: item.current.failures,
    current_calls: item.current.calls,
    current_failure_rate: item.current.failure_rate,
    previous_failure_rate: item.previous.failure_rate,
    next_step: 'review_recent_failures_and_add_a_fictional_regression_case',
  }));
  return {
    schema: 1,
    generated_at: end.toISOString(),
    current_window_days: WINDOWS.current,
    previous_window_days: WINDOWS.previous,
    events_analyzed: acceptedEvents,
    categories,
    findings,
    privacy: { source: 'local_content_free_activity_log', note_content_read: false, raw_events_returned: false, report_saved: false, read_response_content_persisted: false },
    limitations: ['Activity logs contain only observed tool calls and graph-review decisions; they do not show whether an answer was useful or why a person rejected a suggestion.', 'Graph approval/rejection/reopen counts are feedback signals, not standalone quality scores; review choices are not linked to note content.', 'Response token counts are rough estimates for selected read-only BrainLink tool results, not all conversation context or provider billing; averages can change when the tool mix changes.', 'The activity log rotates, so older calls may be missing from a 60-day comparison.', 'No automatic proposal, code change, permission change, or promotion is made.'],
  };
}
