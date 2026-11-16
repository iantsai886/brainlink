// Small provenance summary derived only from result rows that already passed search filters.
export function buildAnswerReceipt(result, { vault, sources = result?.results || [] } = {}) {
  const rows = Array.isArray(sources) ? sources : [];
  const top = rows[0];
  let basis = 'unreviewed';
  if (result?.status === 'not_in_brain' || !top) basis = 'none';
  else if (String(top.confidence || '').toLowerCase() === 'verified') basis = 'verified';
  else if (['active', 'final'].includes(String(top.status || '').toLowerCase()) && top.historical !== true) basis = 'reviewed';
  else if (['proposed', 'draft'].includes(String(top.status || '').toLowerCase())) basis = 'unreviewed';

  return {
    sources: rows.map((source) => ({
      path: source.path,
      title: source.title,
      date: source.date || '',
      status: source.status || '',
      confidence: source.confidence || null,
      historical: source.historical === true,
    })),
    searched_vault: vault,
    search_mode: rows.some((source) => String(source.match || '').includes('meaning')) ? 'meaning' : 'keyword',
    missing_words: Array.isArray(result?.missing_words) ? result.missing_words.slice(0, 5) : [],
    basis,
  };
}
