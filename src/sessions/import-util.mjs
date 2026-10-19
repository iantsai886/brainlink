// Shared helpers for the read-only session importers (claude-code.mjs, codex.mjs).
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
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
  await writeFile(file, JSON.stringify(cursors, null, 1));
}

// null = unchanged since the last import (same mtime + size); otherwise the fresh stat to record.
export async function changedSince(full, cursors) {
  const st = await stat(full);
  const prev = cursors[full];
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return null;
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

// First user line + last assistant line, redacted and clipped to ~60 tokens. No LLM call.
export function autoSummary(messages) {
  const firstUser = messages.find((m) => m.role === 'user');
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const parts = [firstUser?.text, lastAssistant?.text].filter(Boolean);
  return clip(parts.join(' — '), 60);
}

export function autoTitle(messages, summaryLine) {
  return clip(summaryLine || messages[0]?.text || '(untitled session)', 20);
}

export { redactText };
