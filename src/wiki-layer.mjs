// Addendum A MAP/INDEX wiki retrieval layer (00 MAP.md -> folder 00 INDEX.md -> note chunks).
// Built strictly from the already privacy- and exclusion-filtered vault index so private,
// ignored, or missing notes are never invented or leaked.
import path from 'node:path';
import { terms } from './graph.mjs';

const RETIRED_STATUS = /^(archived|historical|superseded)$/i;
const INDEX_NOTE_RE = /^(?:00 MAP\.md|[^/]+\/00 INDEX\.md)$/i;

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  if (cells.length < 3) return null;
  if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return null; // separator row
  return cells;
}

function extractLink(cell) {
  const m = String(cell || '').match(/\[([^\]]+)\]\((?:<([^>]+)>|([^)\s]+))\)/);
  if (m) return { label: m[1].trim(), target: (m[2] || m[3] || '').trim() };
  const wiki = String(cell || '').match(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/);
  if (wiki) return { label: wiki[1].trim(), target: `${wiki[1].trim()}.md`, wikilink: true };
  return null;
}

function resolveRel(baseDir, rawTarget) {
  let clean = String(rawTarget || '').trim();
  if (!clean || /^https?:\/\//i.test(clean)) return null;
  try { clean = decodeURIComponent(clean); } catch {}
  clean = clean.replace(/\\/g, '/').replace(/#.*$/, '').trim();
  if (!clean.toLowerCase().endsWith('.md')) return null;
  const joined = baseDir ? path.posix.normalize(path.posix.join(baseDir, clean)) : path.posix.normalize(clean);
  if (!joined || joined.startsWith('../') || joined === '..') return null;
  return joined;
}

function hasRealSuperseder(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '-' || s === '—' || /^—\s*\(/.test(s)) return false;
  return true;
}

function resolveSuperseder(raw, baseDir, byRel, byTitle) {
  if (!hasRealSuperseder(raw)) return undefined;
  const link = extractLink(raw);
  if (link) {
    if (!link.wikilink) {
      const rel = resolveRel(baseDir, link.target) || resolveRel('', link.target);
      if (rel && byRel.has(rel)) return byRel.get(rel);
    }
    const titleKey = link.label.replace(/\.md$/i, '').trim();
    const hits = byTitle.get(titleKey);
    if (hits?.length === 1) return hits[0];
  }
  const plain = String(raw).trim();
  const rel = resolveRel(baseDir, plain) || resolveRel('', plain);
  if (rel && byRel.has(rel)) return byRel.get(rel);
  const hits = byTitle.get(plain.replace(/\.md$/i, '').trim());
  if (hits?.length === 1) return hits[0];
  return undefined;
}

function parseMapNote(note) {
  const folders = [];
  const rawEntries = [];
  let section = '';
  for (const line of String(note.body || '').split(/\r?\n/)) {
    const h = line.match(/^#{2,4}\s+(.+)$/);
    if (h) { section = h[1].trim(); continue; }
    const cells = splitTableRow(line);
    if (!cells) continue;
    // Skip header rows
    if (/^(folder|title)$/i.test(cells[0])) continue;
    if (/^folders$/i.test(section) || (cells.length === 5 && /00 INDEX\.md/i.test(cells[1] || ''))) {
      const folder = cells[0].replace(/`/g, '').replace(/\/+$/, '').trim();
      const link = extractLink(cells[1]);
      const indexPath = link ? resolveRel('', link.target) : null;
      const summary = cells[3] || '';
      if (folder) {
        folders.push({
          folder,
          indexPath,
          summary,
          terms: terms(`${folder} ${summary}`),
        });
      }
      continue;
    }
    if (cells.length >= 6) {
      const link = extractLink(cells[0]);
      if (!link) continue;
      rawEntries.push({
        source: 'map',
        folder: '',
        baseDir: '',
        section,
        title: link.label,
        targetRel: resolveRel('', link.target),
        summary: cells[2] || '',
        status: cells[3] || '',
        supersededByRaw: cells[5] || '',
      });
    }
  }
  return { folders, rawEntries };
}

function parseIndexNote(note) {
  const folder = path.posix.dirname(note.rel);
  const rawEntries = [];
  let section = folder;
  for (const line of String(note.body || '').split(/\r?\n/)) {
    const h = line.match(/^#{2,4}\s+(.+)$/);
    if (h) { section = h[1].trim(); continue; }
    const cells = splitTableRow(line);
    if (!cells || cells.length < 6) continue;
    if (/^title$/i.test(cells[0])) continue;
    const link = extractLink(cells[0]);
    if (!link) continue;
    rawEntries.push({
      source: 'index',
      folder,
      baseDir: folder,
      section,
      title: link.label,
      targetRel: resolveRel(folder, link.target),
      summary: cells[2] || '',
      status: cells[3] || '',
      supersededByRaw: cells[5] || '',
    });
  }
  return rawEntries;
}

export function buildWikiLayer(notes, byRel, byTitle) {
  const mapNote = notes.find((n) => /^00 MAP\.md$/i.test(n.rel)) || null;
  const indexNotes = notes.filter((n) => /^[^/]+\/00 INDEX\.md$/i.test(n.rel));
  if (!mapNote && !indexNotes.length) {
    return { present: false, mapPath: null, indexCount: 0, folders: [], entries: [] };
  }

  const folders = [];
  const rawEntries = [];
  if (mapNote) {
    const parsed = parseMapNote(mapNote);
    folders.push(...parsed.folders);
    rawEntries.push(...parsed.rawEntries);
  }
  for (const idxNote of indexNotes) {
    rawEntries.push(...parseIndexNote(idxNote));
  }

  // Only keep folders that still have at least one visible indexed note (so excluded folders
  // such as 00 Home/ never appear as matched folders).
  const visibleFolders = new Set(notes.map((n) => n.rel.includes('/') ? n.rel.split('/')[0] : '').filter(Boolean));
  const activeFolders = folders.filter((f) => visibleFolders.has(f.folder));

  const entries = [];
  for (const raw of rawEntries) {
    if (!raw.targetRel) continue;
    if (INDEX_NOTE_RE.test(raw.targetRel)) continue;
    const targetIdx = byRel.get(raw.targetRel);
    if (targetIdx === undefined) continue; // never invent notes; drops private/excluded/missing targets
    const targetNote = notes[targetIdx];
    if (!targetNote || targetNote.private) continue;

    const retired = RETIRED_STATUS.test(raw.status)
      || hasRealSuperseder(raw.supersededByRaw)
      || targetNote.historical === true;

    let effectiveIdx = targetIdx;
    if (retired) {
      const replacementIdx = resolveSuperseder(raw.supersededByRaw, raw.baseDir, byRel, byTitle)
        ?? (targetNote.meta?.superseded_by ? resolveSuperseder(targetNote.meta.superseded_by, path.posix.dirname(targetNote.rel), byRel, byTitle) : undefined);
      if (replacementIdx === undefined || replacementIdx === targetIdx) continue;
      const repNote = notes[replacementIdx];
      if (!repNote || repNote.private || repNote.historical) continue;
      effectiveIdx = replacementIdx;
    }

    const effectiveNote = notes[effectiveIdx];
    entries.push({
      noteIdx: effectiveIdx,
      path: effectiveNote.rel,
      folder: raw.folder,
      source: raw.source,
      section: raw.section,
      title: raw.title,
      terms: terms(`${raw.title} ${raw.section} ${raw.summary}`),
      titleTerms: terms(raw.title),
      redirected: effectiveIdx !== targetIdx,
    });
  }

  return {
    present: true,
    mapPath: mapNote?.rel || null,
    indexCount: indexNotes.length,
    folders: activeFolders,
    entries,
  };
}

const idfOf = (index, t) => Math.log(1 + (index.chunks.length || 1) / (index.df.get(t) || 1));

export function queryWikiLayer(index, queries, keep = () => true) {
  const wiki = index?.wiki;
  if (!wiki?.present) {
    return { present: false, consulted: false, matched_folders: [], matched_entries: [], chunkCandidates: [] };
  }
  const qTerms = [...new Set(queries.flatMap((q) => [...terms(q)]))];
  if (!qTerms.length) {
    return { present: true, consulted: true, matched_folders: [], matched_entries: [], chunkCandidates: [] };
  }
  const totalIdf = qTerms.reduce((sum, t) => sum + idfOf(index, t), 0) || 1;

  // Stage 1: consult 00 MAP.md folder summaries.
  const folderScores = new Map();
  for (const f of wiki.folders) {
    let score = 0;
    for (const t of qTerms) if (f.terms.has(t)) score += idfOf(index, t);
    if (score > 0) folderScores.set(f.folder, score / totalIdf);
  }
  const matchedFolders = [...folderScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([folder]) => folder);
  const topFolderSet = new Set(matchedFolders);

  // Stage 2: consult 00 INDEX.md and MAP entry rows.
  const bestByNote = new Map(); // noteIdx -> { score, path, folder }
  for (const entry of wiki.entries) {
    if (!keep(entry.noteIdx)) continue;
    let bodyIdf = 0;
    let titleIdf = 0;
    let hitCount = 0;
    for (const t of qTerms) {
      const w = idfOf(index, t);
      if (entry.terms.has(t)) { bodyIdf += w; hitCount++; }
      if (entry.titleTerms.has(t)) titleIdf += w;
    }
    if (!hitCount) continue;
    const qShare = bodyIdf / totalIdf;
    const titleShare = titleIdf / totalIdf;
    // Require meaningful overlap so unrelated or unanswerable queries do not trigger false boosts.
    if (qShare < 0.25 && titleShare < 0.25) continue;
    let score = qShare + 0.5 * titleShare;
    if (entry.source === 'map' || topFolderSet.has(entry.folder)) score *= 1.15;
    const prev = bestByNote.get(entry.noteIdx);
    if (!prev || score > prev.score) {
      bestByNote.set(entry.noteIdx, { score, path: entry.path, folder: entry.folder });
    }
  }

  const rankedNotes = [...bestByNote.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].path.localeCompare(b[1].path))
    .slice(0, 15);

  // Stage 3: pick the best matching chunk for each wiki-nominated note (chunk-level retrieval).
  const chunkCandidates = [];
  for (const [noteIdx, info] of rankedNotes) {
    let bestChunkIdx = -1;
    let bestOverlap = -1;
    for (let i = 0; i < index.chunks.length; i++) {
      const c = index.chunks[i];
      if (c.noteIdx !== noteIdx) continue;
      let overlap = 0;
      for (const t of qTerms) if (c.tokens.has(t)) overlap += idfOf(index, t);
      if (overlap > bestOverlap) { bestOverlap = overlap; bestChunkIdx = i; }
    }
    if (bestChunkIdx >= 0) chunkCandidates.push({ i: bestChunkIdx, v: info.score, noteIdx });
  }

  return {
    present: true,
    consulted: true,
    matched_folders: matchedFolders,
    matched_entries: rankedNotes.slice(0, 8).map(([, info]) => info.path),
    chunkCandidates,
  };
}
