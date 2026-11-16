import { buildAnswerReceipt } from './answer-receipt.mjs';
const CONFIDENCE = new Set(['verified', 'reported', 'inferred', 'unknown']);

// A packet is a bounded projection of already-authorized search results. It does not
// perform its own search or access note bodies; vault_search applies those boundaries first.
export function buildContextPacket(result, { vault, maxSources = 4, excerptChars = 300, maxTotalChars } = {}) {
  const sourceLimit = clamp(maxSources, 1, 8, 4);
  const excerptLimit = clamp(excerptChars, 80, 300, 300);
  const totalLimit = clamp(maxTotalChars, 80, 2400, sourceLimit * excerptLimit);
  const candidates = Array.isArray(result?.results) ? result.results.slice(0, sourceLimit) : [];
  // Keep at least 80 characters for each selected source so a packet budget cannot turn
  // citations into useless fragments. Lower budgets return fewer sources instead.
  const selected = candidates.slice(0, Math.max(1, Math.min(sourceLimit, Math.floor(totalLimit / 80))));
  let remainingChars = totalLimit;
  const sources = selected.map((item, index) => {
    const snippet = String(item.snippet || '');
    const remainingSources = selected.length - index;
    const itemLimit = Math.min(excerptLimit, Math.ceil(remainingChars / remainingSources));
    const excerpt = snippet.slice(0, itemLimit);
    remainingChars -= excerpt.length;
    const source = {
      path: item.path,
      title: item.title,
      date: item.date,
      status: item.status,
      excerpt,
    };
    if (item.historical) source.historical = true;
    if (item.heading) source.heading = item.heading;
    if (snippet.length > excerpt.length) source.truncated = true;
    if (CONFIDENCE.has(item.confidence)) source.confidence = item.confidence;
    if (item.superseded_by) source.superseded_by = item.superseded_by;
    return source;
  });
  const excerptCharsUsed = sources.reduce((total, item) => total + item.excerpt.length, 0);
  return {
    vault,
    status: result?.status || 'not_in_brain',
    ...(Number.isFinite(result?.coverage) ? { coverage: result.coverage } : {}),
    ...(Array.isArray(result?.missing_words) && result.missing_words.length ? { missing_words: result.missing_words.slice(0, 20) } : {}),
    ...(result?.needs_translation ? { needs_translation: true } : {}),
    receipt: buildAnswerReceipt(result, { vault, sources }),
    excerpt_chars_budget: totalLimit,
    excerpt_chars_used: excerptCharsUsed,
    sources,
  };
}

function clamp(value, min, max, fallback) {
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
