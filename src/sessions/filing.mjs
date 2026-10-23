// A local, reviewable episodic-memory draft from a session summary. No transcript extraction,
// model inference, or cross-vault matching occurs here; the user selects the destination vault.
import { proposeNote } from '../writes.mjs';

export function filingFields(session, vaultName, identity = {}) {
  if (!session?.id || !session?.summary?.trim()) throw new Error('This session has no summary to file. Review it manually first.');
  if (!vaultName) throw new Error('Choose a destination vault.');
  const title = String(session.title || 'Session outcome').replace(/[\/\\:#*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Session outcome';
  return {
    vault: vaultName, title, type: 'episode', status: 'proposed', private: true,
    source: `BrainLink session ${session.id}`,
    confidence: 'reported',
    ai_platform: identity.ai_platform || 'BrainLink Local', agent_or_role: identity.agent_or_role || 'session filing', session_or_task_id: identity.session_or_task_id || session.id,
    body: `## Session summary\n\n${session.summary.trim()}\n\n## Provenance\n\n- Client: ${session.client || 'unknown'}\n- Session ID: ${session.id}\n- Project: ${session.project || 'not recorded'}\n- Updated: ${session.updated_at || 'not recorded'}\n\nThis is a private, unverified session summary. Review before promoting any claim to durable knowledge.`,
    auto_link: false,
  };
}

export async function fileSessionSummary(ctx, session, vaultName, confirm = false, identity = {}) {
  return proposeNote(ctx, { ...filingFields(session, vaultName, identity), confirm });
}
