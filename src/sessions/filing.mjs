// A local, reviewable episodic-memory draft from a session summary. No transcript extraction,
// model inference, or cross-vault matching occurs here; the user selects the destination vault.
import { proposeNote } from '../writes.mjs';
import { listSessionFilingFolders } from './folders.mjs';
import { isPrivateMeta, parseFrontmatter, findSecrets, safeJoin, vaultRoot, isExcludedPath } from '../core.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';

export function filingFields(session, vaultName, identity = {}, folder) {
  if (!session?.id || !session?.summary?.trim()) throw new Error('This session has no summary to file. Review it manually first.');
  if (!vaultName) throw new Error('Choose a destination vault.');
  if (session.source_session_id !== undefined && (typeof session.source_session_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(session.source_session_id))) throw new Error('This source session ID is not valid.');
  const title = String(session.title || 'Session outcome').replace(/[\/\\:#*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Session outcome';
  return {
    vault: vaultName, ...(folder !== undefined ? { folder } : {}), title, type: 'episode', status: 'proposed', private: true,
    source: `BrainLink session ${session.id}`,
    ...(session.source_session_id ? { source_session_id: session.source_session_id } : {}),
    confidence: 'reported',
    ai_platform: identity.ai_platform || 'BrainLink Local', agent_or_role: identity.agent_or_role || 'session filing', session_or_task_id: identity.session_or_task_id || session.id,
    body: `## Session summary\n\n${session.summary.trim()}\n\n## Provenance\n\n- Client: ${session.client || 'unknown'}\n- Session ID: ${session.id}\n- Project: ${session.project || 'not recorded'}\n- Updated: ${session.updated_at || 'not recorded'}${session.local_summary_model ? `\n- Drafted locally with: ${session.local_summary_model}\n- Draft time: ${session.local_summary_generated_at || 'not recorded'}` : ''}\n\nThis is a private, unverified session summary. Review before promoting any claim to durable knowledge.`,
    // proposeNote builds links only from this explicitly selected vault's privacy-filtered index.
    // The links are visible in the preview, and are saved only after the same confirmation as the note.
    auto_link: true,
  };
}

export async function fileSessionSummary(ctx, session, vaultName, confirm = false, identity = {}, folder) {
  if (folder !== undefined) {
    const allowed = await listSessionFilingFolders(ctx, vaultName);
    if (!allowed.some((item) => item.path === folder)) return { ok: false, errors: ['Choose an existing, writable folder in the selected vault.'] };
  }
  return proposeNote(ctx, { ...filingFields(session, vaultName, identity, folder), confirm });
}

function metadataValue(meta, name) {
  const key = Object.keys(meta || {}).find((item) => item.toLowerCase() === name);
  return key === undefined ? '' : String(meta[key]).trim();
}

function validateFiledEpisode(raw, sessionId) {
  const parsed = parseFrontmatter(raw);
  if (metadataValue(parsed.meta, 'type').toLowerCase() !== 'episode'
    || metadataValue(parsed.meta, 'source') !== `BrainLink session ${sessionId}`
    || !isPrivateMeta(parsed.meta)
    || metadataValue(parsed.meta, 'status').toLowerCase() !== 'proposed') {
    throw new Error('This is not an editable private session-summary proposal.');
  }
  return parsed;
}

function appendFilingHistory(body, message, date) {
  const entry = `- ${date} — ${message}\n`;
  const marker = /^## Changelog\s*\r?$/im;
  return marker.test(body) ? body.replace(marker, (heading) => `${heading}\n\n${entry}`) : `${body.trimEnd()}\n\n## Changelog\n\n${entry}`;
}

async function openFiledEpisode(ctx, { vaultName, rel, sessionId, etag }) {
  if (!ctx.enabled.includes(vaultName)) throw new Error('Choose an enabled destination vault.');
  const vault = ctx.byName.get(vaultName);
  if (!vault) throw new Error('Choose an enabled destination vault.');
  if (typeof rel !== 'string' || !rel.toLowerCase().endsWith('.md') || rel.length > 3000 || rel.startsWith('/') || rel.includes('\\') || rel.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid note path.');
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(sessionId)) throw new Error('Invalid session reference.');
  const root = vaultRoot(ctx, vaultName);
  if (await isExcludedPath(root, rel)) throw new Error('This note is unavailable.');
  const full = safeJoin(root, rel);
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('This note is unavailable.');
  }
  if (!(await lstat(full)).isFile()) throw new Error('This note is unavailable.');
  const raw = await readFile(full, 'utf8');
  const parsed = validateFiledEpisode(raw, sessionId);
  const digest = createHash('sha256').update(raw).digest('hex');
  if (etag !== undefined && (typeof etag !== 'string' || etag !== digest)) throw new Error('This note changed since it was opened. Reload before saving.');
  const start = /^## Session summary\s*\r?\n/im.exec(parsed.body);
  const end = /^## Provenance\s*$/im.exec(parsed.body);
  if (!start || !end || end.index <= start.index) throw new Error('The expected summary section is missing.');
  const summary = parsed.body.slice(start.index + start[0].length, end.index).trim();
  return { vault, root, full, raw, parsed, etag: digest, summary };
}

export async function readFiledSessionSummary(ctx, input) {
  const opened = await openFiledEpisode(ctx, input);
  return { ok: true, vault: input.vaultName, path: input.rel, etag: opened.etag, summary: opened.summary };
}

export async function listFiledSessionSummaries(ctx, vaultName, { limit = 100 } = {}) {
  if (!ctx.enabled.includes(vaultName)) throw new Error('Choose an enabled vault.');
  const root = vaultRoot(ctx, vaultName), results = [];
  let scanned = 0, truncated = false;
  async function visit(dir, rel, depth) {
    if (depth > 8 || results.length >= limit || scanned >= 20000) { truncated = true; return; }
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ['node_modules', '.git', '.obsidian', '.trash'].includes(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      const full = safeJoin(root, child);
      if (entry.isDirectory()) {
        if (await isExcludedPath(root, child)) continue;
        await visit(full, child, depth + 1);
        if (results.length >= limit || scanned >= 20000) { truncated = true; return; }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        scanned++;
        if (await isExcludedPath(root, child)) continue;
        const info = await lstat(full);
        if (info.isSymbolicLink() || !info.isFile()) continue;
        const raw = await readFile(full, 'utf8');
        const meta = parseFrontmatter(raw).meta;
        const source = metadataValue(meta, 'source');
        const sessionId = source.startsWith('BrainLink session ') ? source.slice('BrainLink session '.length) : '';
        if (!sessionId || !/^s_[a-f0-9]{16}$/i.test(sessionId)
          || metadataValue(meta, 'type').toLowerCase() !== 'episode'
          || metadataValue(meta, 'status').toLowerCase() !== 'proposed'
          || !isPrivateMeta(meta)) continue;
        results.push({ vault: vaultName, path: child, sessionId, title: entry.name.replace(/\.md$/i, ''), status: 'proposed' });
        if (results.length >= limit) { truncated = true; return; }
      }
    }
  }
  await visit(root, '', 0);
  return { summaries: results, truncated };
}

export async function updateFiledSessionSummary(ctx, { vaultName, rel, sessionId, etag, action, summary, now = new Date() }) {
  const opened = await openFiledEpisode(ctx, { vaultName, rel, sessionId, etag });
  const { vault, full, raw, parsed } = opened;
  if (ctx.readOnly || vault.writes !== 'on') throw new Error('This vault does not allow edits.');
  const date = now.toISOString().slice(0, 10);
  let next;
  if (action === 'correct') {
    if (typeof summary !== 'string' || !summary.trim() || summary.length > 20000) throw new Error('Enter a summary under 20,000 characters.');
    if (findSecrets(summary).length) throw new Error('This summary looks like it may contain a secret. Remove it before saving.');
    const body = parsed.body;
    const start = /^## Session summary\s*\r?\n/im.exec(body);
    const end = /^## Provenance\s*$/im.exec(body);
    if (!start || !end || end.index <= start.index) throw new Error('The expected summary section is missing; no changes were made.');
    const before = body.slice(0, start.index);
    const summaryHeading = body.slice(start.index, start.index + start[0].length);
    const after = body.slice(end.index);
    const revised = `${before}${summaryHeading}${summary.trim()}\n\n${after}`;
    const bodyWithHistory = appendFilingHistory(revised, 'Summary corrected by user.', date);
    next = raw.slice(0, raw.length - parsed.body.length) + bodyWithHistory;
  } else if (action === 'withdraw') {
    const front = /^---[^\S\r\n]*\r?\n[\s\S]*?\r?\n---[^\S\r\n]*\r?\n?/.exec(raw)?.[0];
    if (!front || !/^status:\s*['"]?proposed['"]?\s*$/im.test(front)) throw new Error('The proposal status cannot be safely updated.');
    const updatedFront = front.replace(/^(status:\s*)['"]?proposed['"]?\s*$/im, '$1withdrawn');
    const bodyWithHistory = appendFilingHistory(parsed.body, 'Proposal withdrawn by user.', date);
    next = updatedFront + bodyWithHistory;
  } else throw new Error('Choose correct or withdraw.');

  const tmp = `${full}.brainlink-${randomBytes(6).toString('hex')}.tmp`;
  try { await writeFile(tmp, next, 'utf8'); await rename(tmp, full); }
  catch (error) { try { await unlink(tmp); } catch {} throw error; }
  return { ok: true, etag: createHash('sha256').update(next).digest('hex'), status: action === 'withdraw' ? 'withdrawn' : 'proposed' };
}
