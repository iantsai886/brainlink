// session_list / session_read / session_log: the MCP-facing logic over the local session store
// (src/sessions/store.mjs). Summary-first, token-budgeted (src/sessions/tokens.mjs), privacy-gated.
import { toSessionRecord } from 'brainlink-store';
import { estTokens, clip } from './tokens.mjs';
import { redactText } from './redact.mjs';

const MSG_CLIP_CHARS = 400;
const FULL_PAGE_TOKENS = 3800; // leaves headroom for the summary fields wrapped around the page
const FULL_PAGE_FETCH = 200; // messages fetched per page before trimming to the token budget

export const clientIdFor = (platform) => {
  const id = String(platform || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return id || 'other';
};

const summaryOf = (s) => ({ id: s.id, client: s.client, project: s.project, title: s.title, summary: s.summary,
  started_at: s.started_at, updated_at: s.updated_at, message_count: s.message_count, note_refs: s.note_refs, private: s.private });

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

// a: { q?, client?, project?, since?, limit?<=20 default 8, include_private? }
export async function sessionList(store, a = {}) {
  const limit = Math.max(1, Math.min(a.limit ?? 8, 20));
  const fetched = await store.listSessions({ q: a.q, client: a.client, since: a.since, limit: Math.min(limit * 4, 80) });
  const visible = fetched.filter((s) => (a.include_private ? true : !s.private) && (!a.project || s.project.includes(a.project)));
  return { sessions: visible.slice(0, limit).map(toSessionRecord) };
}

// a: { id, offset?, limit?<=20, full?, include_private? }
export async function sessionRead(store, a = {}) {
  if (!a.id) throw new Error('id is required');
  const peek = await store.readSession(a.id, {});
  if (peek.session.private && !a.include_private) throw new Error('This session is private; pass include_private=true to read it.');
  const base = summaryOf(peek.session);
  if (a.full) {
    const batch = await store.readSession(a.id, { offset: a.offset || 0, limit: FULL_PAGE_FETCH });
    const messages = fitByTokens(batch.messages, FULL_PAGE_TOKENS);
    const nextOffset = (a.offset || 0) + messages.length < peek.session.message_count ? (a.offset || 0) + messages.length : null;
    return { ...base, messages: messages.map((m) => ({ ...m, text: redactText(m.text) })), next_offset: nextOffset };
  }
  const limit = Math.max(0, Math.min(a.limit || 0, 20));
  if (!limit) return base; // summary only — comfortably under the ~800 token default budget
  const page = await store.readSession(a.id, { offset: a.offset || 0, limit });
  return { ...base, messages: page.messages.map((m) => ({ ...m, text: clip(redactText(m.text), MSG_CLIP_CHARS / 4) })), next_offset: page.next_offset };
}

// a: { title?, text, role?, session_id?, project?, private? }. platform = ctx.platform (BRAINLINK_AI_PLATFORM).
export async function sessionLog(store, a = {}, platform = '') {
  if (!a.text) throw new Error('text is required');
  const text = redactText(String(a.text));
  const role = ['note', 'user', 'assistant'].includes(a.role) ? a.role : 'note';
  if (a.session_id) {
    const r = await store.appendSession(a.session_id, [{ role, text }]);
    return { id: r.id, message_count: r.message_count };
  }
  const client = clientIdFor(platform);
  const source_id = `${client}-${new Date().toISOString().slice(0, 10)}`;
  const r = await store.appendSession({ client, source_id, project: a.project || '', title: a.title || clip(text, 20), private: a.private !== false }, [{ role, text }]);
  return { id: r.id, message_count: r.message_count };
}
