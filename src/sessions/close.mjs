// A connected AI can submit a bounded, attributed closure. It cannot inspect another private
// session or choose a vault silently; the destination and stable task ID are explicit inputs.
import { createHash } from 'node:crypto';
import { vault } from '../core.mjs';
import { checkCommon, resolveIdentity } from '../writes.mjs';
import { clientIdFor, sessionMetadata } from './mcp.mjs';
import { fileSessionSummary } from './filing.mjs';
import { suggestedSessionFolder } from './folders.mjs';
import { twinToolAuthorization } from '../twin-profiles.mjs';
import { recommendSessionVault } from './routing.mjs';

const lines = (value) => (Array.isArray(value) ? value : value ? [value] : []).map((x) => String(x).trim()).filter(Boolean);
const section = (label, value) => {
  const items = lines(value);
  return items.length ? `## ${label}\n\n${items.map((x) => `- ${x}`).join('\n')}\n\n` : '';
};

// MCP requests can overlap in one BrainLink process. Serialize the duplicate check and both
// writes for a stable task ID so a later close cannot replace an earlier outcome.
const closeQueues = new Map();
async function withCloseLock(key, action) {
  const previous = closeQueues.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  closeQueues.set(key, queued);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (closeQueues.get(key) === queued) closeQueues.delete(key);
  }
}

export function closeSummary(args) {
  return section('Goal', args.goal) + section('Outcome', args.outcome) + section('Decisions', args.decisions)
    + section('Source session', args.source_session_id ? `Imported BrainLink session ${args.source_session_id}` : [])
    + section('Actions taken', args.actions) + section('Corrections', args.corrections)
    + section('Open questions', args.open_questions) + section('Next actions', args.next_actions);
}

export async function closeSession(ctx, store, args, now = new Date(), { fileSummary = fileSessionSummary } = {}) {
  const route = !args.vault ? recommendSessionVault({ project: args.project }, ctx.cfg) : null;
  const destinationVault = String(args.vault || route?.vault || '').trim();
  if (!destinationVault) return { ok: false, errors: ['Choose a destination vault; BrainLink can use a saved destination only for an exact project match.'] };
  const destinationAuthorization = twinToolAuthorization(ctx, 'session_close', { vault: destinationVault, project: args.project });
  if (!destinationAuthorization.allowed) return { ok: false, errors: ['This AI connection is not allowed to close a session into that destination.'] };
  vault(ctx, destinationVault);
  const id = resolveIdentity(ctx, args);
  const sourceId = String(args.session_or_task_id || '').trim();
  const errors = checkCommon(ctx, destinationVault, { ...args, source: 'session_close' }, id);
  const profileId = ctx.twinScope?.mode === 'scoped' ? ctx.twinScope.profile_id : null;
  if (!sourceId || sourceId.length > 120 || /[\r\n]/.test(sourceId)) errors.push('stable session_or_task_id is required (up to 120 characters)');
  if (args.source_session_id !== undefined && (typeof args.source_session_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(args.source_session_id))) errors.push('source_session_id must be an exact safe BrainLink session ID');
  if (!String(args.title || '').trim()) errors.push('title is required');
  if (!lines(args.goal).length || !lines(args.outcome).length) errors.push('goal and outcome are required');
  let sourceSession = null;
  if (args.source_session_id !== undefined && typeof args.source_session_id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(args.source_session_id)) {
    try {
      const sourceAccess = await sessionMetadata(store, args.source_session_id, {
        allow_imported_private: ctx.cfg.sessions?.shareSummaries === true,
        profile_id: profileId || undefined,
        allow_profile_private: Boolean(profileId),
      });
      if (!sourceAccess.accessible) errors.push('source_session_id must refer to a session visible to this AI connection');
      else {
        sourceSession = sourceAccess.session;
        if (args.project && args.project !== sourceSession.project) errors.push('project must match the referenced source session');
      }
    } catch {
      errors.push('source_session_id must refer to an existing session visible to this AI connection');
    }
  }
  const summary = closeSummary(args);
  if (summary.length > 6000) errors.push('closure summary must be at most 6000 characters');
  if (errors.length) return { ok: false, errors };

  // Prefix deliberately differs from imported "codex" / "claude-code" clients. Their global
  // sharing toggle must never turn an explicitly private closure into a visible imported session.
  const profileTag = profileId ? `profile-${createHash('sha256').update(profileId).digest('hex').slice(0, 12)}-` : '';
  const client = `brainlink-${profileTag}close-${clientIdFor(id.ai_platform)}`;
  const sessionId = 's_' + createHash('sha256').update(`${client}:${sourceId}`).digest('hex').slice(0, 16);
  const close = async (sessionStore = store) => {
    try {
      await sessionStore.readSession(sessionId, {});
      return { ok: false, errors: ['This task ID was already closed. Review the existing private session; do not overwrite its outcome.'], session_id: sessionId };
    } catch (error) { if (error.code !== 'E_NOT_FOUND') throw error; }
    const session = { id: sessionId, client, profile_id: profileId, title: `${args.title} (${sessionId.slice(-6)})`, project: args.project || '', summary, source_session_id: args.source_session_id, updated_at: now.toISOString(), private: true };
    const identity = { ...id, session_or_task_id: sourceId };
    let folderSuggestion = null;
    if (typeof args.folder !== 'string') {
      const canSearchNotes = twinToolAuthorization(ctx, 'vault_search', { vault: destinationVault }).allowed;
      folderSuggestion = await suggestedSessionFolder(ctx, session, destinationVault, { allowContentSuggestions: canSearchNotes });
    }
    const folder = typeof args.folder === 'string' ? args.folder : folderSuggestion?.folder;
    const suggestionReceipt = folderSuggestion ? { folder_suggestion: folderSuggestion } : {};
    const vaultSuggestion = route?.vault ? { vault_suggestion: { vault: destinationVault, reason: route.reason } } : {};
    const draft = await fileSummary(ctx, session, destinationVault, false, identity, folder);
    if (!draft.ok || !args.confirm) return { ...draft, ...vaultSuggestion, ...suggestionReceipt, session_id: sessionId, session_saved: false };

    const stored = await sessionStore.putSession({ client, source_id: sourceId, profile_id: profileId, project: session.project, title: session.title,
      summary, started_at: now.toISOString(), note_refs: [], private: true, messages: [] }, profileId ? { profile_id: profileId } : {});
    let note;
    try {
      note = await fileSummary(ctx, { ...session, id: stored.id }, destinationVault, true, identity, folder);
    } catch {
      // The session store and Markdown vault are separate persistence systems. Never hide a
      // successful private session write behind a generic tool error; give the client a safe,
      // content-free recovery instruction and the exact session ID to find in Setup.
      return {
        ok: false,
        errors: ['The private session was saved, but filing its vault note did not complete. Check the saved session in BrainLink before retrying.'],
        session_id: stored.id,
        session_saved: true,
        filing_status: 'unknown',
        ...vaultSuggestion,
        ...suggestionReceipt,
        next: 'Open Sessions in BrainLink, review this saved session, then use File summary to finish filing it.',
      };
    }
    if (!note?.ok || note.written !== true) {
      // A valid response may still be only a proposal (for example, a proposal-only vault),
      // or may reject a destination that changed between preview and confirmation.
      return {
        ok: false,
        errors: ['The private session was saved, but its vault note was not written. Review the saved session and destination in BrainLink before retrying.'],
        session_id: stored.id,
        session_saved: true,
        filing_status: 'not_written',
        ...vaultSuggestion,
        ...suggestionReceipt,
        next: 'Open Sessions in BrainLink, review this saved session and choose a writable destination before using File summary.',
      };
    }
    return { ...note, ...vaultSuggestion, ...suggestionReceipt, session_id: stored.id, session_saved: true };
  };
  return typeof store.withExclusive === 'function'
    ? store.withExclusive(close)
    : withCloseLock(sessionId, () => close(store));
}
