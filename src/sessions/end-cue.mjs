import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CLIENTS = new Set(['claude-code', 'codex']);
const MAX_EVENT_BYTES = 32 * 1024;

export function parseSessionEndEvent(input, client) {
  if (!CLIENTS.has(client)) throw new Error('client must be claude-code or codex');
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_EVENT_BYTES) throw new Error('hook event is too large');
  let event;
  try { event = JSON.parse(text); } catch { throw new Error('hook event must be valid JSON'); }
  if (event?.hook_event_name !== 'SessionEnd') throw new Error('expected a SessionEnd hook event');
  const sessionId = String(event.session_id || '').trim();
  if (!sessionId || sessionId.length > 200 || /[\r\n\0]/.test(sessionId)) throw new Error('hook event needs a valid session_id');
  const reason = String(event.reason || 'other').slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, '') || 'other';
  // Deliberately discard cwd and transcript_path. The hook only creates a local reminder;
  // reading a transcript requires a separate, explicit integration and privacy decision.
  return { schema: 1, client, session_id: sessionId, ended_at: new Date().toISOString(), reason };
}

export async function recordSessionEndCue({ input, client, dir, now = new Date() }) {
  const cue = parseSessionEndEvent(input, client);
  cue.ended_at = now.toISOString();
  const key = createHash('sha256').update(`${client}\0${cue.session_id}`).digest('hex');
  const file = path.join(dir, `${key}.json`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, `${JSON.stringify(cue, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { ok: true, duplicate: false, cue };
  } catch (error) {
    if (error.code === 'EEXIST') return { ok: true, duplicate: true, cue: JSON.parse(await readFile(file, 'utf8')) };
    throw error;
  }
}

export async function listSessionEndCues(dir) {
  const names = await readdir(dir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const cues = [];
  for (const name of names.filter((n) => /^[a-f0-9]{64}\.json$/.test(n))) {
    try { cues.push(JSON.parse(await readFile(path.join(dir, name), 'utf8'))); } catch {}
  }
  return cues.sort((a, b) => String(b.ended_at).localeCompare(String(a.ended_at)));
}
