// The MCP compact mode and offline evaluator share this lossless context projection.
// Keep every selected source, citation field and full snippet; omit diagnostics only.
export const COMPACT_SEARCH_FIELDS = Object.freeze([
  'path', 'title', 'date', 'status', 'historical', 'superseded_by', 'match', 'heading', 'snippet',
]);

export function compactSearchResult(result) {
  return Object.fromEntries(COMPACT_SEARCH_FIELDS
    .filter((key) => Object.hasOwn(result, key))
    .map((key) => [key, result[key]]));
}

export function compactSearchResponse(response) {
  const { results = [], ...summary } = response;
  return { ...summary, results: results.map(compactSearchResult) };
}
