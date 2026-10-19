// Read-only importer for Codex CLI's local transcripts.
//
// Primary source: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — one line per recorded item. Each
// line is {timestamp, type, payload}; a 'session_meta' line's payload carries {id, cwd, ...}, and a
// 'response_item' line's payload is a message {type:'message', role, content:[{type:'input_text'|
// 'output_text', text}]} for user/assistant turns (function_call / function_call_output / event_msg
// items are skipped: tool I/O never reaches the store). Fallback source, only used when no rollout
// files exist at all: ~/.codex/history.jsonl, a flat {session_id, ts, text} prompt log with no
// assistant replies, grouped into one user-only session per session_id.
//
// Caveat: the installed @openai/codex package ships a compiled binary with no bundled schema docs,
// so this shape comes from Codex's public rollout format rather than anything readable on this box.
// The parser is defensive: unrecognized lines/shapes are skipped, never thrown on.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { walkFiles, loadCursors, saveCursors, changedSince, extractText, autoSummary, autoTitle, redactText } from './import-util.mjs';

export const CLIENT = 'codex';
export const defaultRoot = (home = homedir()) => path.join(home, '.codex', 'sessions');
export const defaultHistoryFile = (home = homedir()) => path.join(home, '.codex', 'history.jsonl');

function parseRollout(raw) {
  let project = '';
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const payload = rec.payload || rec;
    if ((rec.type === 'session_meta' || payload.cwd) && payload.cwd && !project) project = payload.cwd;
    const isMessage = rec.type === 'response_item' ? payload.type === 'message' : payload.role && payload.content;
    if (!isMessage) continue;
    const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null;
    if (!role) continue;
    const text = redactText(extractText(payload.content));
    if (!text.trim()) continue;
    messages.push({ role, at: rec.timestamp || null, text });
  }
  let last = null;
  for (const m of messages) { if (!m.at) m.at = last; else last = m.at; }
  for (const m of messages) if (!m.at) m.at = new Date(0).toISOString();
  return { project, messages };
}

async function importRollouts({ store, root, cursorsFile }) {
  const files = await walkFiles(root, '.jsonl');
  const cursors = await loadCursors(cursorsFile);
  const result = { imported: 0, unchanged: 0, empty: 0, errors: [] };
  for (const full of files) {
    const st = await changedSince(full, cursors);
    if (!st) { result.unchanged++; continue; }
    try {
      const { project, messages } = parseRollout(await readFile(full, 'utf8'));
      if (!messages.length) { result.empty++; cursors[full] = { mtimeMs: st.mtimeMs, size: st.size }; continue; }
      const source_id = path.relative(root, full).split(path.sep).join('/');
      await store.putSession({
        client: CLIENT, source_id, project,
        title: autoTitle(messages), summary: autoSummary(messages),
        started_at: messages[0].at, note_refs: [], private: true, messages,
      });
      result.imported++;
      cursors[full] = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (e) { result.errors.push({ file: full, error: e.message || String(e) }); }
  }
  await saveCursors(cursorsFile, cursors);
  return { ...result, files: files.length };
}

async function importHistoryFallback({ store, historyFile, cursorsFile }) {
  const cursors = await loadCursors(cursorsFile);
  const st = await changedSince(historyFile, cursors).catch(() => null);
  const result = { imported: 0, unchanged: 0, empty: 0, errors: [] };
  if (!st) { result.unchanged = 1; return result; }
  const bySession = new Map();
  try {
    const raw = await readFile(historyFile, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const text = redactText(String(rec.text ?? ''));
      if (!text.trim()) continue;
      const sid = String(rec.session_id || 'unknown');
      const at = rec.ts ? new Date(rec.ts * (rec.ts < 1e12 ? 1000 : 1)).toISOString() : new Date(0).toISOString();
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid).push({ role: 'user', at, text });
    }
    for (const [sid, messages] of bySession) {
      await store.putSession({
        client: CLIENT, source_id: `history/${sid}`, project: '',
        title: autoTitle(messages), summary: autoSummary(messages),
        started_at: messages[0].at, note_refs: [], private: true, messages,
      });
      result.imported++;
    }
    cursors[historyFile] = { mtimeMs: st.mtimeMs, size: st.size };
    await saveCursors(cursorsFile, cursors);
  } catch (e) { result.errors = [{ file: historyFile, error: e.message || String(e) }]; }
  if (!result.imported) result.empty = 1;
  return result;
}

// opts: { store, root?, historyFile?, cursorsFile }. Rollouts first; history.jsonl only as a
// fallback when no rollout files exist at all (older Codex versions, or sessions/ not yet created).
export async function importCodex({ store, root = defaultRoot(), historyFile = defaultHistoryFile(), cursorsFile }) {
  const rollouts = await importRollouts({ store, root, cursorsFile });
  if (rollouts.files > 0) return { source: 'rollouts', ...rollouts };
  const history = await importHistoryFallback({ store, historyFile, cursorsFile });
  return { source: 'history', ...history };
}
