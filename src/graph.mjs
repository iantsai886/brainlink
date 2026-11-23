// Link graph and term model for Markdown vaults: [[wikilinks]], ![[embeds]], relative
// [text](note.md) links, #tags, unlinked title mentions, term extraction (Latin words with
// light stemming + CJK bigrams) and "related but not yet linked" suggestions.
// Written for BrainLink; no third-party code.

const STOP = new Set(('the and for are but not you all any can had her was one our out has have this that with from they will would there their what about which when make like time just know take into year your some could them than then look only come over think also back after use two how work first well way even want because these give most very '
  + 'into onto been being were does did done here such each other more much many must should shall may might per via etc yes non note notes').split(' '));

const CJK = /[㐀-鿿豈-﫿]/;
// Common Chinese function-word pairs, dropped like English stopwords.
const CJK_STOP = new Set(('我們 你們 他們 什麼 怎麼 如何 可以 能夠 需要 一個 這個 那個 這些 那些 哪個 哪些 有沒 沒有 是不 不是 還是 或是 以及 因為 所以 如果 但是 就是 的話 一些 一下 自己 現在 已經 可能 應該 時候 為什 為何 多少 是什 麼樣 有哪 哪裡 這樣 那樣 之後 之前 然後 而且 並且 其他 很多 非常 比較 我的 你的 他的 我想 想要 一則 有一 一份 手上 記得 筆記 '
  + '我们 你们 他们 怎么 这个 那个 这些 那些 哪个 没有 为什 什么 时候 应该 已经 现在 还是 因为 所以 如果 但是').split(' '));

// Light English stemmer so "pricing" finds "price" and "notes" finds "note". Applied to
// both the index and the query, so it only has to be consistent, not linguistically perfect.
export function stem(w) {
  if (w.length <= 4 || /\d/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 5) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ing') && w.length > 6) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 5) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

// Lowercased, stemmed tokens in document order.
export function tokens(text) {
  const out = [];
  const s = String(text || '').toLowerCase();
  for (const m of s.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)) {
    const w = m[0].replace(/^['-]+|['-]+$/g, '').replace(/'s$/, '');
    if (!CJK.test(w)) {
      if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.push(stem(w));
      if (/^\d{4}-\d{2}-\d{2}/.test(w)) out.push(w.slice(5, 10)); // "10-09" finds 2026-10-09
      continue;
    }
    // Mixed runs: Latin parts as words, CJK parts as overlapping bigrams.
    for (const part of w.match(/[㐀-鿿豈-﫿]+|[^㐀-鿿豈-﫿]+/g)) {
      if (CJK.test(part)) { if (part.length === 1) out.push(part); for (let i = 0; i + 1 < part.length; i++) { const bg = part.slice(i, i + 2); if (!CJK_STOP.has(bg)) out.push(bg); } }
      else if (part.length >= 3 && !STOP.has(part)) out.push(stem(part));
    }
  }
  return out;
}

export function termFrequencies(text) {
  const tf = new Map();
  for (const t of tokens(text)) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

export const terms = (text) => new Set(tokens(text));

const stripCode = (md) => String(md || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

// Link targets in a note body, ignoring fenced and inline code.
export function extractLinks(markdown) {
  const text = stripCode(markdown);
  const out = [];
  for (const m of text.matchAll(/!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g)) out.push(m[1].trim());
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+?\.md)(?:#[^)]*)?\)/gi)) {
    const target = m[1];
    if (/^[a-z]+:/i.test(target)) continue;
    try { out.push(decodeURIComponent(target)); } catch { out.push(target); }
  }
  return out;
}

// #tags in the body plus `tags:` in frontmatter (inline list or single value), lowercased.
export function extractTags(body, meta = {}) {
  const out = new Set();
  for (const m of stripCode(body).matchAll(/(?:^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu)) if (!/^\d+$/.test(m[1])) out.add(m[1].toLowerCase());
  const raw = String(meta.tags || '').replace(/^\[|\]$/g, '');
  for (const t of raw.split(',')) { const v = t.trim().replace(/^["'#]|["']$/g, ''); if (v) out.add(v.toLowerCase()); }
  return out;
}

// Resolver following Obsidian's order: exact path, relative to the linking note, same-folder
// title, unique title anywhere, unique path suffix.
export function makeResolver(notes) {
  const byPath = new Map(), byTitle = new Map();
  notes.forEach((n, i) => {
    const p = n.rel.toLowerCase();
    byPath.set(p, i); byPath.set(p.replace(/\.md$/, ''), i);
    const t = n.title.toLowerCase();
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(i);
  });
  // Obsidian also resolves [[links]] to a note's aliases.
  const byAlias = new Map();
  notes.forEach((n, i) => { for (const a of n.aliases || []) { const k = a.toLowerCase(); if (!byTitle.has(k) && !byAlias.has(k)) byAlias.set(k, i); } });
  return (target, fromRel = '') => {
    const t = String(target).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\.md$/i, '').toLowerCase();
    if (!t) return undefined;
    const dir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/') + 1).toLowerCase() : '';
    const direct = byPath.get(t) ?? byPath.get(dir + t);
    if (direct !== undefined) return direct;
    const name = t.split('/').pop();
    const same = byTitle.get(name) || [];
    if (same.length === 1) return same[0];
    if (same.length > 1) {
      const inDir = same.find((i) => notes[i].rel.toLowerCase().startsWith(dir) && !notes[i].rel.slice(dir.length).includes('/'));
      if (inDir !== undefined) return inDir;
      const suffix = same.filter((i) => notes[i].rel.toLowerCase().replace(/\.md$/, '').endsWith('/' + t));
      return suffix.length === 1 ? suffix[0] : same[0];
    }
    return byAlias.get(name);
  };
}

// notes: [{rel, title, raw}] → { edges: [[from, to]], broken: [{from, target}] }
export function linkGraph(notes) {
  const resolve = makeResolver(notes);
  const seen = new Set(), edges = [], broken = [];
  notes.forEach((n, i) => {
    for (const target of extractLinks(n.raw)) {
      const j = resolve(target, n.rel);
      if (j === undefined) { broken.push({ from: i, target }); continue; }
      if (j === i || seen.has(`${i}>${j}`)) continue;
      seen.add(`${i}>${j}`);
      edges.push([i, j]);
    }
  });
  return { edges, broken };
}

// Existing note titles mentioned in plain text (not already linked), longest first.
export function findMentions(text, titles, { minLength = 4, limit = 10 } = {}) {
  const original = stripCode(text).replace(/!?\[\[[^\]]*\]\]/g, ' ').replace(/\[[^\]]*\]\([^)]*\)/g, ' ');
  const linked = new Set(extractLinks(text).map((t) => t.split('/').pop().replace(/\.md$/i, '').toLowerCase()));
  const out = [];
  const sorted = [...new Set(titles)].filter((t) => t.length >= minLength && !/^\d{4}-\d{2}-\d{2}$/.test(t)).sort((a, b) => b.length - a.length);
  let rest = original;
  for (const title of sorted) {
    if (linked.has(title.toLowerCase())) continue;
    // One-word titles ("Plan", "Coffee") are ordinary words too: link them only when written
    // with the same capitalisation and at least 5 letters. Longer titles match in any case.
    const oneWord = !/\s/.test(title.trim()) && !CJK.test(title);
    if (oneWord && title.length < 5) continue;
    const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = oneWord ? 'u' : 'iu';
    const re = CJK.test(title) ? new RegExp(esc) : new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?=$|[^\\p{L}\\p{N}])`, flags);
    if (re.test(rest)) { out.push(title); rest = rest.replace(re, ' '); if (out.length >= limit) break; }
  }
  return out;
}

// Top-level folder, used as a coarse "collection" label in results.
export const collection = (rel) => (rel.includes('/') ? rel.split('/')[0] : 'Home');

// Notes sharing distinctive terms with a term set that are not already linked to it.
const postingCache = new WeakMap();
export function suggestRelated(mine, termSets, df, { exclude = new Set(), eligible = () => true, limit = 8 } = {}) {
  const N = termSets.length;
  const idf = (t) => Math.log(1 + N / (df.get(t) || 1));
  let postings = postingCache.get(termSets);
  if (!postings) {
    postings = new Map();
    for (let j = 0; j < termSets.length; j++) for (const term of termSets[j]) {
      const rows = postings.get(term) || [];
      rows.push(j);
      postings.set(term, rows);
    }
    postingCache.set(termSets, postings);
  }
  const maxDf = Math.max(2, N * 0.5);
  const candidates = new Set();
  for (const term of mine) if ((df.get(term) || 0) <= maxDf) for (const j of postings.get(term) || []) candidates.add(j);
  const scored = [];
  for (const j of [...candidates].sort((a, b) => a - b)) {
    if (exclude.has(j) || !eligible(j)) continue;
    // For tiny vaults, a useful term can occur in both notes and still be distinctive: two
    // occurrences are half of a four-note vault, but previously the strict `< 2` cutoff meant
    // a two-note vault could never suggest anything. Keep the half-vault cap inclusive.
    const shared = [...mine].filter((t) => termSets[j].has(t) && (df.get(t) || 0) <= maxDf);
    if (shared.length < 2) continue;
    const score = shared.reduce((s, t) => s + idf(t), 0) / Math.sqrt(mine.size * termSets[j].size || 1);
    scored.push({ j, score, shared: shared.sort((a, b) => idf(b) - idf(a)).slice(0, 6) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
