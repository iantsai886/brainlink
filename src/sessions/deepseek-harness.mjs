// Read-only importer for DeepSeek Harness persisted sessions. Harness defaults to
// concatenated Zstandard frames; raw JSONL is supported when its backend uses compression:none.
// Only direct user prompts and visible assistant text are retained. Tool, system, developer,
// injected user context, reasoning, and all other event data stay out of BrainLink.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { walkFiles, loadCursors, saveCursors, changedSince, autoSummary, autoTitle, redactText } from './import-util.mjs';

export const CLIENT = 'deepseek-harness';
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const SUPPORTED_FORMATS = new Set([3, 4]);

export const defaultRoot = (home = homedir(), env = process.env) => path.join(env.DSH_HOME || path.join(home, '.dsh'), 'sessions');

function textBlocks(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block && typeof block === 'object'
    && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('\n');
}

function timestamp(ms) {
  return Number.isSafeInteger(ms) && ms >= 0 ? new Date(ms).toISOString() : null;
}

function parseSession(raw) {
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) throw new Error('DeepSeek Harness session file is empty');
  let header;
  try { header = JSON.parse(lines[0]); } catch { throw new Error('DeepSeek Harness session header is invalid JSON'); }
  if (header?.type !== 'session' || !SUPPORTED_FORMATS.has(header.version)
      || typeof header.id !== 'string' || !header.id.trim()
      || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0) {
    throw new Error('Unsupported or invalid DeepSeek Harness session header (supported formats: v3 and v4)');
  }

  const messages = [];
  for (let i = 1; i < lines.length; i++) {
    let event;
    try { event = JSON.parse(lines[i]); } catch { throw new Error(`DeepSeek Harness event ${i} is invalid JSON`); }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string'
        || !Number.isSafeInteger(event.time) || event.time < 0 || !event.data || typeof event.data !== 'object') {
      throw new Error(`DeepSeek Harness event ${i} has an invalid event envelope`);
    }
    let role, content;
    if (event.type === 'user/message' && event.data.role === 'user' && event.data.source?.kind === 'user') {
      role = 'user';
      content = event.data.content;
    } else if (event.type === 'assistant/message' && event.data.message?.role === 'assistant') {
      role = 'assistant';
      content = event.data.message.content;
    } else continue;
    const text = redactText(textBlocks(content));
    if (text.trim()) messages.push({ role, at: timestamp(event.time), text });
  }
  return { header, messages };
}

async function readLog(file, size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_INPUT_BYTES) {
    throw new Error(`DeepSeek Harness session file exceeds the ${MAX_INPUT_BYTES / 1024 / 1024} MiB import limit`);
  }
  const bytes = await readFile(file);
  if (bytes.length > MAX_INPUT_BYTES) throw new Error(`DeepSeek Harness session file exceeds the ${MAX_INPUT_BYTES / 1024 / 1024} MiB import limit`);
  const raw = file.endsWith('.zstd')
    ? zstdDecompressSync(bytes, { maxOutputLength: MAX_OUTPUT_BYTES }).toString('utf8')
    : bytes.toString('utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_OUTPUT_BYTES) throw new Error('Decoded DeepSeek Harness session exceeds the import limit');
  return raw;
}

// opts: { store, root?, cursorsFile }. This importer never writes to the Harness source.
export async function importDeepSeekHarness({ store, root = defaultRoot(), cursorsFile }) {
  const files = [...new Set([
    ...(await walkFiles(root, '.jsonl')),
    ...(await walkFiles(root, '.jsonl.zstd')),
  ])].filter((file) => /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(path.basename(file)));
  const cursors = await loadCursors(cursorsFile);
  const result = { imported: 0, unchanged: 0, empty: 0, errors: [], files: files.length };
  for (const full of files) {
    const st = await changedSince(full, cursors).catch(() => null);
    if (!st) { result.unchanged++; continue; }
    try {
      const { header, messages } = parseSession(await readLog(full, st.size));
      if (!messages.length) { result.empty++; cursors[full] = { mtimeMs: st.mtimeMs, size: st.size }; continue; }
      const source_id = path.relative(root, full).split(path.sep).join('/');
      const project = typeof header.cwd === 'string' ? header.cwd : '';
      await store.putSession({
        client: CLIENT, source_id, project,
        title: autoTitle(messages), summary: autoSummary(messages),
        started_at: timestamp(header.createdAt) || messages[0].at,
        note_refs: [], private: true, messages,
      });
      result.imported++;
      cursors[full] = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (error) {
      result.errors.push({ file: full, error: error.message || String(error) });
    }
  }
  await saveCursors(cursorsFile, cursors);
  return result;
}

export { parseSession as parseDeepSeekHarnessSession };
