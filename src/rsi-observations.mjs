// Privacy-safe RSI observation. It consumes only BrainLink's local, content-free
// tool/outcome activity log and returns aggregates; it never persists a report.
const WINDOWS = Object.freeze({ current: 30, previous: 30 });
const TOOL_GROUPS = Object.freeze({
  retrieval: new Set(['vault_search', 'vault_related', 'vault_recent', 'vault_read_note', 'search', 'fetch', 'open_loops', 'brain_brief']),
  sessions: new Set(['session_list', 'session_read', 'session_close', 'session_filing_folders']),
  filing: new Set(['ingestion_queue', 'ingestion_record', 'propose_note', 'source_scan']),
  handoff: new Set(['list_handoffs', 'send_handoff']),
  recovery: new Set(['backup', 'backup_restore']),
});

function blank() { return { calls: 0, failures: 0, failure_rate: null }; }
function finish(bucket) { return { ...bucket, failure_rate: bucket.calls ? Number((bucket.failures / bucket.calls).toFixed(3)) : null }; }

export function analyzeActivitySignals(entries, { now = new Date() } = {}) {
  const end = now instanceof Date ? now : new Date(now);
  const currentStart = end.getTime() - WINDOWS.current * 86400000;
  const previousStart = currentStart - WINDOWS.previous * 86400000;
  const counts = Object.fromEntries(Object.keys(TOOL_GROUPS).map((key) => [key, { current: blank(), previous: blank() }]));
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
    return { id, current, previous, signal };
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
    privacy: { source: 'local_content_free_activity_log', note_content_read: false, raw_events_returned: false, report_saved: false },
    limitations: ['Activity logs contain only observed tool calls; they do not show whether an answer was useful.', 'The activity log rotates, so older calls may be missing from a 60-day comparison.', 'No automatic proposal, code change, permission change, or promotion is made.'],
  };
}
