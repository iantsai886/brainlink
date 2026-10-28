const CONFIDENCE = new Set(['verified', 'reported', 'inferred', 'unknown']);

// A packet is a bounded projection of already-authorized search results. It does not
// perform its own search or access note bodies; vault_search applies those boundaries first.
export function buildContextPacket(result, { vault, maxSources = 3, excerptChars = 220 } = {}) {
  const sources = (Array.isArray(result?.results) ? result.results : []).slice(0, clamp(maxSources, 1, 8, 3)).map((item) => {
    const snippet = String(item.snippet || '');
    const source = {
      path: item.path,
      title: item.title,
      date: item.date,
      status: item.status,
      historical: Boolean(item.historical),
      match: item.match,
      heading: item.heading || '',
      excerpt: snippet.slice(0, clamp(excerptChars, 80, 300, 220)),
      excerpt_truncated: snippet.length > clamp(excerptChars, 80, 300, 220),
    };
    if (CONFIDENCE.has(item.confidence)) source.confidence = item.confidence;
    if (item.superseded_by) source.superseded_by = item.superseded_by;
    return source;
  });
  return {
    vault,
    status: result?.status || 'not_in_brain',
    coverage: Number.isFinite(result?.coverage) ? result.coverage : 0,
    ...(result?.note ? { note: result.note } : {}),
    sources,
    next_step: sources.length ? 'If an excerpt is insufficient, read its exact path with vault_read_note.' : 'No source excerpt was returned; do not guess from this packet.',
  };
}

function clamp(value, min, max, fallback) {
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
