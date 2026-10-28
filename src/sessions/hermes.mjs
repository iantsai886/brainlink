// Read-only import of ended Hermes CLI sessions. Hermes stores all local client history in
// SQLite, including messaging and tool data, so this importer deliberately selects only ended
// `cli` sessions and only active user/assistant content. It never reads tool or reasoning fields.
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { autoSummary, autoTitle, redactText } from './import-util.mjs';

export const CLIENT = 'hermes';
const PAGE_SIZE = 100;
const MAX_MESSAGES_PER_SESSION = 1000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SESSION_BYTES = 2 * 1024 * 1024;

export const defaultRoot = (home = homedir(), env = process.env) => path.resolve(
  env.HERMES_HOME || (process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'hermes')
    : path.join(home, '.hermes')),
);

function supportsReadOnlySqlite(version) {
  const [major, minor] = String(version).split('.').map(Number);
  return (major === 22 && minor >= 18) || (major === 24 && minor >= 4) || major >= 25;
}

function asIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const ms = n < 10_000_000_000 ? n * 1000 : n;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function safeText(value) {
  if (typeof value !== 'string') return '';
  return redactText(value.slice(0, MAX_MESSAGE_BYTES));
}

// opts: { store, root?, cursorsFile }. cursorsFile is BrainLink-owned; root is only read.
export async function importHermes({ store, root = defaultRoot(), cursorsFile }) {
  const file = path.join(root, 'state.db');
  const result = { imported: 0, unchanged: 0, empty: 0, errors: [], files: 0, disabled: false };
  const dbStat = await stat(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!dbStat?.isFile()) return result;
  result.files = 1;

  const nodeVersion = process.versions.node;
  if (!supportsReadOnlySqlite(nodeVersion)) {
    result.errors.push({ file, error: 'Safe read-only Hermes import requires Node.js 22.18+, 24.4+, or 25+.' });
    return result;
  }

  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch (error) {
    result.errors.push({ file, error: `Node.js SQLite support is unavailable: ${error.message || error}` });
    return result;
  }

  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 500 });
    const sessionColumns = columns(db, 'sessions');
    const messageColumns = columns(db, 'messages');
    for (const required of ['id', 'source', 'started_at', 'ended_at']) {
      if (!sessionColumns.has(required)) throw new Error(`Hermes sessions table is missing ${required}`);
    }
    for (const required of ['id', 'session_id', 'role', 'content', 'timestamp', 'active']) {
      if (!messageColumns.has(required)) throw new Error(`Hermes messages table is missing ${required}`);
    }

    let cursor = { endedAt: 0, sessionId: '' };
    if (cursorsFile) {
      try {
        const { readFile } = await import('node:fs/promises');
        const saved = JSON.parse(await readFile(cursorsFile, 'utf8'));
        const key = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
        if (saved?.[key] && Number.isFinite(saved[key].endedAt) && typeof saved[key].sessionId === 'string') cursor = saved[key];
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }

    const key = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
    const sessionRows = db.prepare(`SELECT id, title, cwd, started_at, ended_at
      FROM sessions
      WHERE source = 'cli' AND ended_at IS NOT NULL
        AND (ended_at > ? OR (ended_at = ? AND id > ?))
      ORDER BY ended_at ASC, id ASC LIMIT ${PAGE_SIZE}`).all(cursor.endedAt, cursor.endedAt, cursor.sessionId);
    const messageQuery = db.prepare(`SELECT role, substr(content, 1, ${MAX_MESSAGE_BYTES + 1}) AS content, timestamp FROM messages
      WHERE session_id = ? AND role IN ('user', 'assistant') AND content IS NOT NULL AND active = 1
      ORDER BY timestamp ASC, id ASC LIMIT ${MAX_MESSAGES_PER_SESSION}`);

    for (const row of sessionRows) {
      try {
        let usedBytes = 0;
        const messages = [];
        for (const m of messageQuery.all(row.id)) {
          const clipped = typeof m.content === 'string' ? m.content.slice(0, MAX_MESSAGE_BYTES) : '';
          const size = Buffer.byteLength(clipped, 'utf8');
          if (usedBytes + size > MAX_SESSION_BYTES) { result.truncated = (result.truncated || 0) + 1; break; }
          usedBytes += size;
          const text = safeText(clipped);
          if (text.trim()) messages.push({ role: m.role, at: asIso(m.timestamp), text });
          if (typeof m.content === 'string' && m.content.length > MAX_MESSAGE_BYTES) result.truncated = (result.truncated || 0) + 1;
        }
        if (messages.length) {
          const opaqueId = createHash('sha256').update(`${path.resolve(root)}\0${String(row.id)}`).digest('hex').slice(0, 32);
          const source_id = `${key}:${opaqueId}`;
          const project = typeof row.cwd === 'string' ? row.cwd : '';
          await store.putSession({
            client: CLIENT, source_id, project,
            title: autoTitle(messages, typeof row.title === 'string' ? redactText(row.title) : ''),
            summary: autoSummary(messages), started_at: asIso(row.started_at) || messages[0].at,
            note_refs: [], private: true, messages,
          });
          result.imported++;
        } else result.empty++;
        cursor = { endedAt: Number(row.ended_at), sessionId: String(row.id) };
      } catch (error) {
        result.errors.push({ session: String(row.id), error: error.message || String(error) });
        break;
      }
    }
    if (cursorsFile && sessionRows.length) {
      const { mkdir, readFile, writeFile } = await import('node:fs/promises');
      const prior = await readFile(cursorsFile, 'utf8').then(JSON.parse).catch(() => ({}));
      await mkdir(path.dirname(cursorsFile), { recursive: true });
      await writeFile(cursorsFile, JSON.stringify({ ...prior, [key]: cursor }, null, 1));
    }
    if (!sessionRows.length) result.unchanged = 1;
  } catch (error) {
    result.errors.push({ file, error: error.message || String(error) });
  } finally { db?.close(); }
  return result;
}
