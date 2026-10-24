// A connected AI can submit a bounded, attributed closure. It cannot inspect another private
// session or choose a vault silently; the destination and stable task ID are explicit inputs.
import { createHash } from 'node:crypto';
import { vault } from '../core.mjs';
import { checkCommon, resolveIdentity } from '../writes.mjs';
import { clientIdFor } from './mcp.mjs';
import { fileSessionSummary } from './filing.mjs';

const lines = (value) => (Array.isArray(value) ? value : value ? [value] : []).map((x) => String(x).trim()).filter(Boolean);
const section = (label, value) => {
  const items = lines(value);
  return items.length ? `## ${label}\n\n${items.map((x) => `- ${x}`).join('\n')}\n\n` : '';
};

export function closeSummary(args) {
  return section('Goal', args.goal) + section('Outcome', args.outcome) + section('Decisions', args.decisions)
    + section('Actions taken', args.actions) + section('Corrections', args.corrections)
    + section('Open questions', args.open_questions) + section('Next actions', args.next_actions);
}

export async function closeSession(ctx, store, args, now = new Date()) {
  if (!args.vault) return { ok: false, errors: ['destination vault is required'] };
  vault(ctx, args.vault);
  const id = resolveIdentity(ctx, args);
  const sourceId = String(args.session_or_task_id || '').trim();
  const errors = checkCommon(ctx, args.vault, { ...args, source: 'session_close' }, id);
  if (!sourceId || sourceId.length > 120 || /[\r\n]/.test(sourceId)) errors.push('stable session_or_task_id is required (up to 120 characters)');
  if (!String(args.title || '').trim()) errors.push('title is required');
  if (!lines(args.goal).length || !lines(args.outcome).length) errors.push('goal and outcome are required');
  const summary = closeSummary(args);
  if (summary.length > 6000) errors.push('closure summary must be at most 6000 characters');
  if (errors.length) return { ok: false, errors };

  // Prefix deliberately differs from imported "codex" / "claude-code" clients. Their global
  // sharing toggle must never turn an explicitly private closure into a visible imported session.
  const profileId = ctx.twinScope?.mode === 'scoped' ? ctx.twinScope.profile_id : null;
  const profileTag = profileId ? `profile-${createHash('sha256').update(profileId).digest('hex').slice(0, 12)}-` : '';
  const client = `brainlink-${profileTag}close-${clientIdFor(id.ai_platform)}`;
  const sessionId = 's_' + createHash('sha256').update(`${client}:${sourceId}`).digest('hex').slice(0, 16);
  try {
    await store.readSession(sessionId, {});
    return { ok: false, errors: ['This task ID was already closed. Review the existing private session; do not overwrite its outcome.'], session_id: sessionId };
  } catch (error) { if (error.code !== 'E_NOT_FOUND') throw error; }
  const session = { id: sessionId, client, profile_id: profileId, title: `${args.title} (${sessionId.slice(-6)})`, project: args.project || '', summary, updated_at: now.toISOString(), private: true };
  const identity = { ...id, session_or_task_id: sourceId };
  const folder = typeof args.folder === 'string' ? args.folder : undefined;
  const draft = await fileSessionSummary(ctx, session, args.vault, false, identity, folder);
  if (!draft.ok || !args.confirm) return { ...draft, session_id: sessionId, session_saved: false };

  const stored = await store.putSession({ client, source_id: sourceId, profile_id: profileId, project: session.project, title: session.title,
    summary, started_at: now.toISOString(), note_refs: [], private: true, messages: [] }, profileId ? { profile_id: profileId } : {});
  const note = await fileSessionSummary(ctx, { ...session, id: stored.id }, args.vault, true, identity, folder);
  return { ...note, session_id: stored.id, session_saved: true };
}
