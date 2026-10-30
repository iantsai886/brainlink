// session_list / session_read / session_log: the MCP-facing logic over the local session store
// (src/sessions/store.mjs). Summary-first, token-budgeted (src/sessions/tokens.mjs), privacy-gated.
import { toSessionRecord } from 'brainlink-store';
import { estTokens, clip } from './tokens.mjs';
import { redactText } from './redact.mjs';
import { CLIENT as CLAUDE_CODE_CLIENT } from './claude-code.mjs';
import { CLIENT as CODEX_CLIENT } from './codex.mjs';
import { CLIENT as DEEPSEEK_HARNESS_CLIENT } from './deepseek-harness.mjs';
import { CLIENT as HERMES_CLIENT } from './hermes.mjs';

const FULL_PAGE_TOKENS = 3800; // leaves headroom for the summary fields wrapped around the page
const FULL_PAGE_FETCH = 200; // messages fetched per page before trimming to the token budget
const KEY_TURN_CHARS = 200; // snippet length for the default (non-full) response
const MAX_KEY_TURNS = 3;

// Importers (src/sessions/claude-code.mjs, codex.mjs) always set private:true with no per-session
// choice — that is what BrainLink Settings' "share summaries of imported sessions" toggle
// (cfg.sessions, src/config.mjs) relaxes. Anything logged by an AI via session_log keeps its
// private flag fully opaque to every other AI client no matter that setting: it is a deliberate
// per-note privacy choice, not the import default, and must not be loosened by a global toggle.
const IMPORTED_CLIENTS = new Set([CLAUDE_CODE_CLIENT, CODEX_CLIENT, DEEPSEEK_HARNESS_CLIENT, HERMES_CLIENT]);
const isRelaxableImport = (s) => IMPORTED_CLIENTS.has(s.client);

export const clientIdFor = (platform) => {
  const id = String(platform || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return id || 'other';
};

const summaryOf = (s) => ({ id: s.id, client: s.client, project: s.project, title: s.title, summary: s.summary,
  started_at: s.started_at, updated_at: s.updated_at, message_count: s.message_count, note_refs: s.note_refs, private: s.private });

// Read session metadata without loading any transcript messages. Closeout uses this to verify
// optional provenance references before it writes an episode; visibility follows the same
// profile and imported-session sharing rules as session_read.
export async function sessionMetadata(store, id, a = {}) {
  if (!id) throw new Error('id is required');
  const scope = a.profile_id ? { profile_id: a.profile_id } : {};
  const { session } = await store.readSession(id, { ...scope, limit: 0 });
  const profilePrivate = Boolean(a.allow_profile_private && a.profile_id && session.profile_id === a.profile_id);
  const allowed = !session.private || a.include_private || profilePrivate || (a.allow_imported_private && isRelaxableImport(session));
  return { accessible: allowed, session: allowed ? summaryOf(session) : null };
}

// Keep adding messages while the running total (measured on the serialized message, so JSON
// struct overhead counts too) stays under budget; always keep at least one message (even an
// oversized one) so pagination can never stall.
function fitByTokens(messages, budget) {
  const kept = [];
  let used = 0;
  for (const m of messages) {
    const t = estTokens(JSON.stringify(m));
    if (kept.length && used + t > budget) break;
    kept.push(m);
    used += t;
  }
  return kept;
}

// a: { q?, client?, project?, since?, limit?<=20 default 8, include_private?, allow_imported_private? }.
// include_private = a fully trusted local caller asking to see every private session (the user's
// own BrainLink UI). allow_imported_private = the Settings "share summaries" choice, which only
// ever un-hides imported sessions (see isRelaxableImport above), never session_log entries.
export async function sessionList(store, a = {}) {
  const limit = Math.max(1, Math.min(a.limit ?? 8, 20));
  const fetched = await store.listSessions({ q: a.q, client: a.client, since: a.since, profile_id: a.profile_id, limit: Math.min(limit * 4, 80) });
  const visible = fetched.filter((s) => {
    const profilePrivate = Boolean(a.allow_profile_private && a.profile_id && s.profile_id === a.profile_id);
    const allowed = !s.private || a.include_private || profilePrivate || (a.allow_imported_private && isRelaxableImport(s));
    return allowed && (!a.project || s.project.includes(a.project));
  });
  return { sessions: visible.slice(0, limit).map(toSessionRecord) };
}

// Up to MAX_KEY_TURNS short snippets (first, middle, last turn) instead of the raw message log —
// enough to orient on without a client having to opt into full=true.
async function keyTurns(store, id, messageCount, scope = {}) {
  if (!messageCount) return [];
  const offsets = [...new Set([0, Math.floor((messageCount - 1) / 2), messageCount - 1])].slice(0, MAX_KEY_TURNS);
  const picked = await Promise.all(offsets.map((offset) => store.readSession(id, { ...scope, offset, limit: 1 })));
  return picked.map(({ messages: [m] }) => ({ role: m.role, at: m.at, text: clip(redactText(m.text), KEY_TURN_CHARS / 4) }));
}

const PRIVATE_MESSAGE = 'This session is private; change it in BrainLink Settings.';
const PRIVATE_FULL_MESSAGE = 'Full message text for this session is private; change it in BrainLink Settings.';

// a: { id, offset?, full?, include_private?, allow_imported_private?, allow_imported_full_private? }.
// include_private is the same fully-trusted local-caller bypass as sessionList's; the MCP transport
// (src/server.mjs) always passes it as false so an AI client can never reach it. The two
// allow_imported_* flags are the Settings "share summaries" / "share full text" choices and, like
// sessionList's allow_imported_private, only ever apply to imported sessions (isRelaxableImport).
export async function sessionRead(store, a = {}) {
  if (!a.id) throw new Error('id is required');
  const scope = a.profile_id ? { profile_id: a.profile_id } : {};
  const peek = await store.readSession(a.id, scope);
  const session = peek.session;
  const relaxable = isRelaxableImport(session);
  const profilePrivate = Boolean(a.allow_profile_private && a.profile_id && session.profile_id === a.profile_id);
  const summaryOk = a.include_private || profilePrivate || (a.allow_imported_private && relaxable);
  if (session.private && !summaryOk) return { id: session.id, private: true, message: PRIVATE_MESSAGE };
  const base = summaryOf(session);
  const fullOk = a.include_private
    || (profilePrivate && a.allow_profile_full_text === true && (!relaxable || a.allow_imported_full_private === true))
    || (a.allow_imported_full_private && relaxable);
  if (a.full) {
    if (a.profile_id && a.allow_profile_full_text !== true) return { ...base, message: PRIVATE_FULL_MESSAGE };
    if (a.profile_id && relaxable && !a.allow_imported_full_private) return { ...base, message: PRIVATE_FULL_MESSAGE };
    if (session.private && !fullOk) return { ...base, message: PRIVATE_FULL_MESSAGE };
    const batch = await store.readSession(a.id, { ...scope, offset: a.offset || 0, limit: FULL_PAGE_FETCH });
    const messages = fitByTokens(batch.messages, FULL_PAGE_TOKENS);
    const nextOffset = (a.offset || 0) + messages.length < session.message_count ? (a.offset || 0) + messages.length : null;
    return { ...base, messages: messages.map((m) => ({ ...m, text: redactText(m.text) })), next_offset: nextOffset };
  }
  // Key turns are transcript excerpts, not summary metadata. Summary permission alone must
  // never grant access to the body of a private imported session.
  if (session.private && !fullOk) return { ...base, key_turns: [] };
  // summary + metadata + up to 3 key-turn snippets — comfortably under the ~800 token default budget
  return { ...base, key_turns: await keyTurns(store, a.id, session.message_count, scope) };
}

// a: { title?, text, role?, session_id?, project?, private? }. platform = ctx.platform (BRAINLINK_AI_PLATFORM).
export async function sessionLog(store, a = {}, platform = '', scope = {}) {
  if (!a.text) throw new Error('text is required');
  const text = redactText(String(a.text));
  const role = ['note', 'user', 'assistant'].includes(a.role) ? a.role : 'note';
  const profileId = scope.profile_id ? String(scope.profile_id) : null;
  if (a.session_id) {
    const r = await store.appendSession(a.session_id, [{ role, text }], profileId ? { profile_id: profileId } : {});
    return { id: r.id, message_count: r.message_count };
  }
  const client = clientIdFor(platform);
  const source_id = profileId ? `${client}-${profileId}-${new Date().toISOString().slice(0, 10)}` : `${client}-${new Date().toISOString().slice(0, 10)}`;
  const r = await store.appendSession({ client, source_id, profile_id: profileId, project: a.project || '', title: a.title || clip(text, 20), private: profileId ? true : a.private !== false }, [{ role, text }], profileId ? { profile_id: profileId } : {});
  return { id: r.id, message_count: r.message_count };
}
