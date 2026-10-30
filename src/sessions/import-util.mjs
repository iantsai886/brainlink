// Shared helpers for the read-only session importers (claude-code.mjs, codex.mjs).
import { readdir, readFile, writeFile, mkdir, stat, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { redactText } from './redact.mjs';
import { clip } from './tokens.mjs';

export async function walkFiles(root, suffix) {
  const out = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith(suffix)) out.push(full);
    }
  }
  await walk(root);
  return out;
}

export async function loadCursors(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
}
export async function saveCursors(file, cursors) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temp, JSON.stringify(cursors, null, 1), { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
}

// Compare ctime when the platform reports a changing status time. Old cursor files without ctime
// remain compatible and upgrade on the next import.
export function sameFileVersion(a, b) {
  if (!a || !b || a.size !== b.size || a.mtimeMs !== b.mtimeMs) return false;
  return a.ctimeMs === undefined || b.ctimeMs === undefined || a.ctimeMs === b.ctimeMs;
}

export function cursorFor(st) {
  return { mtimeMs: st.mtimeMs, size: st.size, ctimeMs: st.ctimeMs };
}

// Read a transcript only when it still has the exact metadata observed before the read.
// If the source is being appended, return null without advancing its cursor; a later scan retries it.
export async function readStableFile(full, expected, { readFileImpl = readFile, statImpl = stat, encoding = 'utf8' } = {}) {
  const content = await readFileImpl(full, encoding);
  const after = await statImpl(full);
  return sameFileVersion(expected, after) ? { content, stat: after } : null;
}

// null = unchanged since the last import; otherwise the fresh metadata to compare with the read.
export async function changedSince(full, cursors, statImpl = stat) {
  const st = await statImpl(full);
  const prev = cursors[full];
  if (prev && sameFileVersion(prev, st)) return null;
  return st;
}

export function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && typeof b === 'object' && typeof b.text === 'string'
      && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text')).map((b) => b.text).join('\n');
  }
  return '';
}

const LOW_SIGNAL_USER_TURNS = /^(?:continue|keep going|go ahead|thanks?|thank you|ok(?:ay)?|yes|yep|done|收到|继续|繼續|好|好的|可以|嗯)[.!。！\s]*$/i;

// Build a compact, explicitly unverified record from imported turns; this never calls a model.
// Keep the original goal, the latest meaningful user direction, and the assistant's final reply
// in separate budgets so a long opening request cannot consume the space needed for the outcome.
export function autoSummary(messages) {
  const users = messages.filter((m) => m.role === 'user' && String(m.text || '').trim());
  const assistants = messages.filter((m) => m.role === 'assistant' && String(m.text || '').trim());
  const firstUser = users[0];
  const recentUser = [...users].reverse().find((m) => !LOW_SIGNAL_USER_TURNS.test(String(m.text || '').trim()));
  const lastAssistant = assistants.at(-1);
  const sections = [];
  const safeClip = (value, budget) => clip(redactText(String(value || '').replace(/\s+/g, ' ').trim()), budget);
  if (firstUser) sections.push(`Goal: ${safeClip(firstUser.text, 26)}`);
  if (recentUser && recentUser !== firstUser) sections.push(`Latest direction: ${safeClip(recentUser.text, 24)}`);
  if (lastAssistant) sections.push(`Last reply (unverified): ${safeClip(lastAssistant.text, 46)}`);
  return sections.join('\n');
}

export function autoTitle(messages, summaryLine) {
  return clip(summaryLine || messages[0]?.text || '(untitled session)', 20);
}

export { redactText };
