// Read-only importer for Claude Code's local transcripts: ~/.claude/projects/<project>/<session>.jsonl.
// One line per transcript entry (type "user" | "assistant" | "summary" | ...); role/content match the
// Claude Code CLI's own public message shape (message.role, message.content as a string or content
// blocks). Only user/assistant text blocks are kept — tool_use/tool_result blocks and anything outside
// message content never reach the store. Incremental by file mtime + size (see import-util.mjs cursors).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { walkFiles, loadCursors, saveCursors, changedSince, extractText, autoSummary, autoTitle, redactText } from './import-util.mjs';

export const CLIENT = 'claude-code';
export const defaultRoot = (home = homedir()) => path.join(home, '.claude', 'projects');

function parseTranscript(raw) {
  let project = '';
  const messages = [];
  let summaryLine = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.cwd && !project) project = rec.cwd;
    if (rec.type === 'summary' && typeof rec.summary === 'string') { summaryLine = rec.summary; continue; }
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const role = rec.message?.role === 'assistant' ? 'assistant' : 'user';
    const text = redactText(extractText(rec.message?.content));
    if (!text.trim()) continue;
    messages.push({ role, at: rec.timestamp || null, text });
  }
  // Entries may arrive without a timestamp on rare malformed lines; fall back to the previous one.
  let last = null;
  for (const m of messages) { if (!m.at) m.at = last; else last = m.at; }
  for (const m of messages) if (!m.at) m.at = new Date(0).toISOString();
  return { project, messages, summaryLine: redactText(summaryLine) };
}

// opts: { store, root?, cursorsFile }. store = src/sessions/store.mjs createSessionStore().
export async function importClaudeCode({ store, root = defaultRoot(), cursorsFile }) {
  const files = await walkFiles(root, '.jsonl');
  const cursors = await loadCursors(cursorsFile);
  const result = { imported: 0, unchanged: 0, empty: 0, errors: [] };
  for (const full of files) {
    const st = await changedSince(full, cursors);
    if (!st) { result.unchanged++; continue; }
    try {
      const { project, messages, summaryLine } = parseTranscript(await readFile(full, 'utf8'));
      if (!messages.length) { result.empty++; cursors[full] = { mtimeMs: st.mtimeMs, size: st.size }; continue; }
      const source_id = path.relative(root, full).split(path.sep).join('/');
      await store.putSession({
        client: CLIENT, source_id, project,
        title: autoTitle(messages, summaryLine), summary: summaryLine || autoSummary(messages),
        started_at: messages[0].at, note_refs: [], private: true, messages,
      });
      result.imported++;
      cursors[full] = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (e) { result.errors.push({ file: full, error: e.message || String(e) }); } // cursor NOT updated: retry next run
  }
  await saveCursors(cursorsFile, cursors);
  return result;
}
