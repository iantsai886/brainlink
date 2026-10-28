const CONFIDENCE = new Set(['verified', 'reported', 'inferred', 'unknown']);

// A packet is a bounded projection of already-authorized search results. It does not
// perform its own search or access note bodies; vault_search applies those boundaries first.
export function buildContextPacket(result, { vault, maxSources = 4, excerptChars = 300 } = {}) {
  const sources = (Array.isArray(result?.results) ? result.results : []).slice(0, clamp(maxSources, 1, 8, 4)).map((item) => {
    const snippet = String(item.snippet || '');
    const source = {
      path: item.path,
      title: item.title,
      date: item.date,
      status: item.status,
      excerpt: snippet.slice(0, clamp(excerptChars, 80, 300, 300)),
    };
    if (item.historical) source.historical = true;
    if (item.heading) source.heading = item.heading;
    if (snippet.length > clamp(excerptChars, 80, 300, 300)) source.truncated = true;
    if (CONFIDENCE.has(item.confidence)) source.confidence = item.confidence;
    if (item.superseded_by) source.superseded_by = item.superseded_by;
    return source;
  });
  return {
    vault,
    status: result?.status || 'not_in_brain',
    sources,
  };
}

function clamp(value, min, max, fallback) {
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
