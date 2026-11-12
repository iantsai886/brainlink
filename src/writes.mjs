// Identity-aware writes. Every write is a new file or an append (never an overwrite), carries
// attribution in the vault's frontmatter schema, passes a secret scan, and returns a preview
// unless confirm=true.
import { writeFile, appendFile, readdir, readFile, stat, lstat, open, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { twinCanWriteNotes } from './twin-profiles.mjs';
import path from 'node:path';
import { TEMPLATES, renderTemplate } from './templates.mjs';
import { suggestLinks, relatedSection, safeUpdateMap } from './links.mjs';
import { vault, vaultRoot, safeJoin, findSecrets, zonedNow, parseFrontmatter, isExcludedPath, isPrivateMeta, fmSaysPrivate, readNote, loadVault, assertRegularWritePath as checkWritePath } from './core.mjs';
export { assertRegularWritePath as checkWritePath } from './core.mjs';
import { typedEntityMetadataMap, typedRelationAllowed } from './typed-graph.mjs';
import { createHandoffGitVerifier } from './handoff-git.mjs';

export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g, '-').replace(/^-|-$/g, '') || 'unknown';

// Identity from the call, falling back to the per-connection env written into each AI's MCP config.
export function resolveIdentity(ctx, a = {}) {
  const ai_platform = String(a.ai_platform || ctx.platform).trim();
  const errors = [];
  if (!ai_platform) errors.push(`ai_platform is required (${ctx.cfg.platforms.join(', ')}, or the exact tool name). Pass it per call or set BRAINLINK_AI_PLATFORM in your MCP config.`);
  if (ai_platform.length > 40 || /[\n:]/.test(ai_platform)) errors.push('ai_platform must be a short name');
  const agent_or_role = String(a.agent_or_role || ctx.agentRole).trim().slice(0, 60);
  return { ai_platform, agent_or_role, session_or_task_id: String(a.session_or_task_id || 'unknown').slice(0, 120), errors };
}

const q = (s) => JSON.stringify(String(s ?? ''));
export const madeBy = (id) => `**Made by ${id.ai_platform} (${id.agent_or_role}).**`;
const TYPED_ENTITY_TYPES = new Set(['person', 'team', 'workflow', 'dataset', 'artifact', 'project', 'policy', 'concept']);
const MEMORY_TYPES = new Set(['working', 'semantic', 'procedural', 'episodic']);
const TYPED_PREDICATES = new Set(['owned_by', 'runs', 'consumes', 'produces', 'depends_on', 'part_of', 'assigned_to', 'informed_by', 'communicates_with']);
const TYPED_ID = /^[a-z][a-z0-9._:-]{1,127}$/;

export function frontmatter(ctx, vaultName, id, f, now = new Date()) {
  const v = vault(ctx, vaultName);
  const ts = zonedNow(ctx.tz, now);
  const tags = `[${(f.tags || []).map((t) => String(t).replace(/[^\w㐀-鿿-]/g, '')).filter(Boolean).join(', ')}]`;
  const sourceSession = typeof f.source_session_id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(f.source_session_id)
    ? [`source_session_id: ${q(f.source_session_id)}`] : [];
  const extra = Object.entries(v.extra_fields || {}).filter(([k]) => !(sourceSession.length && k.toLowerCase() === 'source_session_id')).map(([k, val]) => `${k}: ${q(val)}`);
  const typed = TYPED_ENTITY_TYPES.has(f.type) && f.entity_id && f.entity_scope;
  const typedFields = typed ? [`id: ${f.entity_id}`, `scope: ${f.entity_scope}`,
    ...(f.relations?.length ? ['relations:', ...f.relations.flatMap((r) => [
      '  - predicate: ' + r.predicate, `    target: ${r.target}`, '    review: proposed',
      `    source: ${q(r.source)}`, `    confidence: ${r.confidence}`,
    ])] : [])] : [];
  const memoryTypeField = MEMORY_TYPES.has(f.memory_type) ? [`memory_type: ${f.memory_type}`] : [];
  if (v.schema === 'provenance') {
    const date = ts.slice(0, 10);
    return ['---', `type: ${f.type || 'log'}`, `status: ${f.status || 'proposed'}`, ...memoryTypeField, `tags: ${tags}`, ...extra,
      ...(f.private ? ['private: true'] : []),
      `created_by_platform: ${slug(id.ai_platform)}`, `created_by_agent: ${slug(id.agent_or_role)}`, `created_session_or_task_id: ${q(id.session_or_task_id)}`, `created_date: ${date}`,
      `last_material_revision_by_platform: ${slug(id.ai_platform)}`, `last_material_revision_by_agent: ${slug(id.agent_or_role)}`,
      `last_material_revision_session_or_task_id: ${q(id.session_or_task_id)}`, `last_material_revision_date: ${date}`,
      ...sourceSession, ...typedFields,
      `provenance_confidence: ${['verified', 'reported', 'inferred'].includes(f.confidence) ? f.confidence : 'unknown'}`, `source: ${q(f.source)}`, '---'].join('\n');
  }
  return ['---', `type: ${f.type || 'note'}`, `status: ${f.status || 'proposed'}`, ...memoryTypeField, `ai_platform: ${q(id.ai_platform)}`, `agent_or_role: ${q(id.agent_or_role)}`,
    ...(f.private ? ['private: true'] : []),
    `session_or_task_id: ${q(id.session_or_task_id)}`, `written_at: ${ts}`, `source: ${q(f.source)}`, `confidence: ${q(f.confidence || 'proposed')}`, `tags: ${tags}`, ...extra, ...sourceSession, ...typedFields, '---'].join('\n');
}

export function checkCommon(ctx, vaultName, a, id) {
  const errors = [...id.errors];
  const v = vault(ctx, vaultName);
  if (ctx.readOnly) errors.push('this connection is read-only (BRAINLINK_READ_ONLY)');
  if (v.writes === 'off') errors.push(`vault "${vaultName}" does not accept writes`);
  if (!a.source) errors.push('source is required (what prompted this write)');
  const secrets = findSecrets(JSON.stringify(a));
  if (secrets.length) errors.push(`refused: content looks like it contains secrets (${secrets.join(', ')}). Vaults must never hold credentials, tokens or account numbers.`);
  return errors;
}

const titleError = (t, max = 120) => (!t || /[\/\\:#\n*?"<>|]/.test(t) || t.length > max ? `title is required, one line, ≤${max} chars, without / \\ : # * ? " < > |` : null);
const isProtected = (v, rel) => (v.protected || []).some((p) => rel.split('/').some((seg) => seg.replace(/\.md$/i, '').toLowerCase().startsWith(p.toLowerCase())));
const exists = (full) => stat(full).then(() => true, () => false);
const isDir = (full) => stat(full).then((s) => s.isDirectory(), () => false);

// ---- propose_note ----

export async function proposeNote(ctx, a, now = new Date()) {
  const vaultName = a.vault || ctx.enabled[0];
  const v = vault(ctx, vaultName);
  const root = vaultRoot(ctx, vaultName);
  const id = resolveIdentity(ctx, a);
  const errors = checkCommon(ctx, vaultName, a, id);
  if (a.memory_type !== undefined && !MEMORY_TYPES.has(a.memory_type)) errors.push('memory_type must be working, semantic, procedural, or episodic');
  if (ctx.twinScope?.mode === 'scoped' && a.memory_type && ctx.twinScope.memory_policy?.[a.memory_type] !== true) {
    errors.push(`this Twin profile does not allow proposing ${a.memory_type} memory`);
  }
  const twinSourcePolicy = ctx.twinScope?.mode === 'scoped' ? ctx.twinScope.source_policy : null;
  let twinConfidence = a.confidence;
  if (twinSourcePolicy?.provenance_required) {
    const sourceId = String(a.session_or_task_id || '').trim();
    if (!sourceId || sourceId !== a.session_or_task_id || sourceId.toLowerCase() === 'unknown') errors.push('this Twin requires a stable session_or_task_id for every proposed note');
    if (!String(a.source || '').trim()) errors.push('this Twin requires a non-empty source for every proposed note');
    twinConfidence = String(a.confidence || '').trim().toLowerCase();
    if (!['verified', 'reported', 'inferred', 'unknown'].includes(twinConfidence)) errors.push('this Twin requires confidence: verified, reported, inferred, or unknown');
    if (sourceId) id.session_or_task_id = sourceId;
  }
  const title = String(a.title || '').trim();
  const te = titleError(title); if (te) errors.push(te);
  const tpl = a.template ? TEMPLATES[a.template] : null;
  if (a.template && !tpl) errors.push(`template must be one of ${Object.keys(TEMPLATES).join(', ')}`);
  if (!tpl && (!a.body || !String(a.body).trim())) errors.push('body is required');
  const typed = TYPED_ENTITY_TYPES.has(a.type);
  if (typed) {
    if (!TYPED_ID.test(String(a.entity_id || ''))) errors.push('typed entity records require entity_id using lowercase letters, numbers, dot, underscore, colon or hyphen');
    if (!['personal', 'organisation', 'client'].includes(a.entity_scope)) errors.push('typed entity records require entity_scope: personal, organisation, or client');
    if (ctx.twinScope?.mode === 'scoped' && a.entity_scope !== ctx.twinScope.mode) errors.push('typed entity scope must match the active Twin profile');
    if (a.relations !== undefined && (!Array.isArray(a.relations) || a.relations.length > 20)) errors.push('relations must be a list of at most 20 proposed relationships');
    else for (const relation of a.relations || []) {
      if (!relation || typeof relation !== 'object' || !TYPED_PREDICATES.has(relation.predicate)) errors.push('each relationship needs a supported predicate');
      if (!TYPED_ID.test(String(relation?.target || ''))) errors.push('each relationship target must be a valid entity ID in this vault');
      if (typeof relation?.source !== 'string' || !relation.source.trim() || relation.source.length > 300) errors.push('each relationship needs a source excerpt or citation of at most 300 characters');
      if (typeof relation?.confidence !== 'number' || !Number.isFinite(relation.confidence) || relation.confidence < 0 || relation.confidence > 1) errors.push('each relationship confidence must be a number from 0 to 1');
    }
  } else if (a.entity_id !== undefined || a.entity_scope !== undefined || a.relations !== undefined) errors.push('typed entity fields require a supported entity type');
  let folder = String(a.folder || '').replace(/^\/+|\/+$/g, '');
  if (v.flat && folder) errors.push(`${vaultName} is a flat vault: omit folder`);
  // A template files into its own folder when the vault has one (Meetings, People, ...).
  if (!folder && tpl && !v.flat && (await isDir(safeJoin(root, tpl.folder)))) folder = tpl.folder;
  const intake = !v.flat && (!folder || folder === v.intake_folder);
  if (intake) folder = v.flat ? '' : v.intake_folder;
  if (folder && !(await isDir(safeJoin(root, folder)))) errors.push(`folder "${folder}" does not exist in ${vaultName}; use an existing folder (no parallel taxonomy)`);
  if (folder && isProtected(v, folder)) errors.push('generated index/map notes are not writable');
  const decisions = v.decisions || [];
  const needsDecision = intake && decisions.length && !tpl;
  if (needsDecision) {
    if (!a.decision) errors.push(`decision is required for ${v.intake_folder} (${decisions.join(', ')})`);
    else if (!decisions.includes(String(a.decision).toUpperCase())) errors.push(`decision must be one of ${decisions.join(', ')}`);
  }
  if (typed && Array.isArray(a.relations) && a.relations.length && !errors.length) {
    // Resolve proposed endpoints only from the already privacy-filtered, single-vault index.
    // A private, excluded, duplicate, stale, or cross-scope target gets the same generic refusal.
    const index = await loadVault(ctx, vaultName);
    const visible = new Map([...typedEntityMetadataMap(index.notes).values()].map((record) => [`${record.entity_id}|${record.scope}`, record]));
    if ((a.relations || []).some((relation) => {
      const target = visible.get(`${relation.target}|${a.entity_scope}`);
      return !target || !typedRelationAllowed(relation.predicate, a.type, target.type);
    })) {
      errors.push('each relationship target must be a unique, current, visible typed record with the same scope in this vault');
    }
  }
  if (errors.length) return { ok: false, errors };

  const date = zonedNow(ctx.tz, now).slice(0, 10);
  const name = `${date} — ${title}.md`;
  const rel = folder ? `${folder}/${name}` : name;
  const fm = frontmatter(ctx, vaultName, id, { ...a, confidence: twinConfidence, private: twinSourcePolicy?.private_default === true ? true : a.private,
    type: a.type || tpl?.type || (intake ? 'intake' : undefined), memory_type: a.memory_type,
    status: typed ? 'proposed' : a.status, relations: typed ? a.relations : undefined }, now);
  const decision = needsDecision ? `## Decision\n\n**${String(a.decision).toUpperCase()}**\n\n` : '';
  const body = tpl ? renderTemplate(a.template, a.fields || {}, a.body) : String(a.body).trim();
  const links = a.auto_link === false ? [] : await suggestLinks(ctx, vaultName, `${title}\n${body}`, { limit: 5 }).catch(() => []);
  const content = `${fm}\n\n# ${title}\n\n${madeBy(id)}\nOther AI platforms also write this vault — do not treat unsigned edits as this note's author.\n\n${decision}${body}\n\n${relatedSection(links)}## Changelog\n\n- ${date} — Created. Made by ${id.ai_platform} (${id.agent_or_role}).\n`;
  const r = await commitNew(ctx, vaultName, rel, content, a.confirm, { profileWrite: twinCanWriteNotes(ctx, vaultName) });
  return r.ok ? { ...r, linked_to: links.map((l) => l.target) } : r;
}

export async function commitNew(ctx, vaultName, rel, content, confirm, { ownerApproved = false, profileWrite = false } = {}) {
  const v = vault(ctx, vaultName);
  if (ctx.readOnly || v.writes === 'off') return { ok: false, errors: [`${vaultName} is read-only; no file was created.`] };
  let full;
  try { full = await checkWritePath(vaultRoot(ctx, vaultName), rel); }
  catch { return { ok: false, errors: ['Destination is excluded or not a regular path in the vault.'] }; }
  if (await exists(full)) return { ok: false, conflict: true, path: `${vaultName}/${rel}`, errors: [`refused: ${vaultName}/${rel} already exists; never overwrite — choose a new path`] };
  if (((v.private && !ctx.trustedLocal) || v.writes === 'proposal-only') && !ownerApproved && !profileWrite) return { ok: true, written: false, path: `${vaultName}/${rel}`, preview: content, next: `${vaultName} is proposal-only: show this to the user; do not write it elsewhere.` };
  if (ownerApproved && !ctx.trustedLocal) return { ok: false, errors: ['Only the local vault owner can approve a saved proposal.'] };
  if (!confirm) return { ok: true, written: false, path: `${vaultName}/${rel}`, preview: content, next: 'Show the preview to the user; call again with confirm=true after approval.' };
  try { await writeFile(full, content, { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') return { ok: false, conflict: true, path: `${vaultName}/${rel}`, errors: [`refused: ${vaultName}/${rel} was created after preview; no file was overwritten — preview again`] };
    throw error;
  }
  await safeUpdateMap(ctx, vaultName);
  return { ok: true, written: true, path: `${vaultName}/${rel}` };
}

// Append keeps concurrent AI writers from losing each other's text.
export async function appendTo(root, rel, text) {
  const full = safeJoin(root, rel);
  let size = 0;
  try {
    const fh = await open(full, 'r');
    size = (await fh.stat()).size;
    const last = Buffer.alloc(1);
    if (size) await fh.read(last, 0, 1, size - 1);
    await fh.close();
    if (size && last.toString() !== '\n') text = '\n' + text;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await appendFile(full, text);
}

export async function appendProposalState(root, rel, header = '') {
  try { return { proposal_action: 'append', proposal_expected_hash: createHash('sha256').update(await readFile(safeJoin(root, rel))).digest('hex'), proposal_header: header }; }
  catch (error) { if (error.code === 'ENOENT') return { proposal_action: 'append', proposal_expected_hash: null, proposal_header: header }; throw error; }
}

// ---- remember: durable facts the user wants every AI to know ----

export const MEMORY_NOTE = 'BrainLink/Memories.md';
const normFact = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function memoryFact(line) {
  if (!line.startsWith('- ')) return null;
  const value = line.slice(2);
  const suffixAt = value.lastIndexOf(' _(');
  if (suffixAt < 0 || !value.endsWith(')_')) return value.trim();
  const metadata = value.slice(suffixAt + 3, -2);
  if (metadata.startsWith('BrainLink memory;') || /^\d{4}-\d{2}-\d{2}, /.test(metadata)) return value.slice(0, suffixAt).trimEnd();
  return value.trim();
}

export async function readMemories(ctx, vaultName, limit = 30) {
  try {
    // Memory activation must obey the same private-note, exclusion, Twin and symlink
    // checks as any other direct note read. A configured vault is not a bypass.
    const { body } = await readNote(ctx, vaultName, MEMORY_NOTE);
    return body.split('\n').map(memoryFact).filter(Boolean).slice(-limit);
  } catch { return []; }
}

export async function remember(ctx, a, now = new Date()) {
  const vaultName = a.vault || ctx.enabled[0];
  const root = vaultRoot(ctx, vaultName);
  const id = resolveIdentity(ctx, a);
  const errors = checkCommon(ctx, vaultName, { ...a, source: a.source || 'conversation' }, id);
  if (a.source !== undefined && typeof a.source !== 'string') errors.push('source must be text');
  const source = (typeof a.source === 'string' ? a.source : a.source ? '' : 'conversation').replace(/\s+/g, ' ').trim();
  if (!source || source.length > 300) errors.push('source must be a short description of where the user stated this fact (at most 300 characters)');
  const facts = (Array.isArray(a.facts) ? a.facts : [a.fact]).map((f) => String(f || '').trim().replace(/\n+/g, ' ')).filter(Boolean);
  if (!facts.length) errors.push('fact is required (one short sentence the user wants remembered)');
  if (facts.some((f) => f.length > 300)) errors.push('keep each fact under 300 characters');
  if (errors.length) return { ok: false, errors };
  // Reject link-backed or excluded destinations before even returning a preview. Existing
  // memory notes also pass the ordinary private-note and Twin memory checks before append.
  const memoryDir = safeJoin(root, 'BrainLink');
  const dirInfo = await lstat(memoryDir).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (dirInfo && (dirInfo.isSymbolicLink() || !dirInfo.isDirectory())) return { ok: false, errors: ['Memory destination is not a regular directory.'] };
  const memoryFile = safeJoin(root, MEMORY_NOTE);
  const fileInfo = dirInfo ? await lstat(memoryFile).catch((error) => { if (error.code === 'ENOENT') return null; throw error; }) : null;
  if (fileInfo && (fileInfo.isSymbolicLink() || !fileInfo.isFile())) return { ok: false, errors: ['Memory destination is not a regular file.'] };
  if (await isExcludedPath(root, MEMORY_NOTE)) return { ok: false, errors: ['Memory destination is excluded.'] };
  if (fileInfo) {
    try { await readNote(ctx, vaultName, MEMORY_NOTE); }
    catch { return { ok: false, errors: ['Memory destination is not accessible to this connection.'] }; }
  }
  const known = new Set((await readMemories(ctx, vaultName, 1000)).map(normFact));
  const fresh = facts.filter((f) => !known.has(normFact(f)));
  if (!fresh.length) return { ok: true, written: false, already_known: facts };
  const date = zonedNow(ctx.tz, now).slice(0, 10);
  // A user-requested memory is user-reported, not independently verified. Preserve its origin
  // beside the compact fact so later reviewers can trace it without retaining the conversation.
  const text = fresh.map((f) => `- ${f} _(BrainLink memory; date: ${date}; platform: ${q(id.ai_platform)}; source: ${q(source)}; confidence: reported)_`).join('\n') + '\n';
  if (((vault(ctx, vaultName).private && !ctx.trustedLocal) || vault(ctx, vaultName).writes === 'proposal-only') && !twinCanWriteNotes(ctx, vaultName)) return { ok: true, written: false, path: `${vaultName}/${MEMORY_NOTE}`, preview: text, ...await appendProposalState(root, MEMORY_NOTE, '# Memories\n\nFacts every connected AI should know. Added by AIs when you say "remember".\n\n'), next: 'This vault is proposal-only: show the memory to the user.' };
  if (!a.confirm) return { ok: true, written: false, path: `${vaultName}/${MEMORY_NOTE}`, preview: text, next: 'Confirm with the user (or their "remember this" already did), then call again with confirm=true.' };
  const full = safeJoin(root, MEMORY_NOTE);
  if (!(await exists(full))) { await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, '# Memories\n\nFacts every connected AI should know. Added by AIs when you say "remember".\n\n', { flag: 'wx' }); }
  await appendTo(root, MEMORY_NOTE, text);
  return { ok: true, written: true, path: `${vaultName}/${MEMORY_NOTE}`, added: fresh.length };
}

// ---- daily note: quick capture into today's note (Obsidian daily-notes settings respected) ----

export async function dailySettings(root) {
  try {
    const j = JSON.parse(await readFile(path.join(root, '.obsidian', 'daily-notes.json'), 'utf8'));
    return { folder: String(j.folder || '').replace(/^\/+|\/+$/g, ''), format: j.format || 'YYYY-MM-DD' };
  } catch { return { folder: 'Daily', format: 'YYYY-MM-DD' }; }
}

export function formatDate(fmt, iso) {
  const [Y, M, D] = iso.slice(0, 10).split('-');
  return fmt.replace(/YYYY/g, Y).replace(/MM/g, M).replace(/DD/g, D);
}

export async function appendDaily(ctx, a, now = new Date()) {
  const vaultName = a.vault || ctx.enabled[0];
  const root = vaultRoot(ctx, vaultName);
  const id = resolveIdentity(ctx, a);
  const errors = checkCommon(ctx, vaultName, { ...a, source: a.source || 'quick capture' }, id);
  const text = String(a.text || '').trim();
  if (!text) errors.push('text is required');
  if (errors.length) return { ok: false, errors };
  const ts = zonedNow(ctx.tz, now);
  const ds = await dailySettings(root);
  const name = /[^\w\s.-]/.test(ds.format) ? ts.slice(0, 10) : formatDate(ds.format, ts);
  const rel = `${ds.folder ? ds.folder + '/' : ''}${name}.md`;
  let full;
  try {
    full = await checkWritePath(root, rel);
    if (await exists(full)) await readNote(ctx, vaultName, rel);
  } catch { return { ok: false, errors: ['Daily note destination is not accessible to this connection.'] }; }
  const entry = `${text.split('\n').map((l, i) => (i ? `  ${l}` : `- ${ts.slice(11, 16)} ${l}`)).join('\n')} _(${id.ai_platform})_\n`;
  if (((vault(ctx, vaultName).private && !ctx.trustedLocal) || vault(ctx, vaultName).writes === 'proposal-only') && !twinCanWriteNotes(ctx, vaultName)) return { ok: true, written: false, path: `${vaultName}/${rel}`, preview: entry, ...await appendProposalState(root, rel, `# ${ts.slice(0, 10)}\n\n`), next: 'This vault is proposal-only.' };
  if (!a.confirm) return { ok: true, written: false, path: `${vaultName}/${rel}`, preview: entry, next: 'Call again with confirm=true to add it to today\'s note.' };
  if (!(await exists(full))) { await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, `# ${ts.slice(0, 10)}\n\n`, { flag: 'wx' }); }
  await appendTo(root, rel, entry);
  await safeUpdateMap(ctx, vaultName);
  return { ok: true, written: true, path: `${vaultName}/${rel}` };
}

// ---- inter-AI handoff mailbox ----

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const HANDOFF_STATUSES = ['REQUEST', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED'];
const HANDOFF_RE = /^\d{4}-\d{2}-\d{2}-\d{4}-from-.+\.md$/;
const HANDOFF_FIELDS = [
  ['goal', 'Goal'], ['current_state', 'Current state'], ['decisions', 'Decisions'],
  ['modified_files', 'Modified files'], ['tests', 'Tests and results'],
  ['open_questions', 'Open questions'], ['next_steps', 'Next steps'],
];

function validateGitCheckpoint(value) {
  if (value === undefined) return { value: null, errors: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['repo', 'branch', 'head', 'dirty', 'ahead'].includes(key)) || Object.keys(value).length !== 5) return { value: null, errors: ['git must contain repo, branch, head, dirty, and ahead only'] };
  const { repo, branch, head, dirty, ahead } = value;
  const errors = [];
  if (typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repo) || repo.split('/').some(part => part.includes('..'))) errors.push('git.repo must be an owner/name label, not a URL or path');
  if (typeof branch !== 'string' || branch.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.includes('@{') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) errors.push('git.branch is not a safe Git branch name');
  if (typeof head !== 'string' || !/^[a-fA-F0-9]{7,40}$/.test(head)) errors.push('git.head must be a 7–40 character commit SHA');
  if (typeof dirty !== 'boolean') errors.push('git.dirty must be true or false');
  if (!Number.isInteger(ahead) || ahead < 0 || ahead > 10000) errors.push('git.ahead must be an integer from 0 to 10000');
  return { value: errors.length ? null : { repo, branch, head: head.toLowerCase(), dirty, ahead, source: 'reported' }, errors };
}

function gitCheckpointFromMeta(meta) {
  if (meta.git_checkpoint_schema !== '1') return null;
  if (!['true', 'false'].includes(meta.git_dirty) || !/^(0|[1-9]\d{0,4})$/.test(meta.git_ahead || '')) return null;
  return validateGitCheckpoint({ repo: meta.git_repo, branch: meta.git_branch, head: meta.git_head, dirty: meta.git_dirty === 'true', ahead: Number(meta.git_ahead) }).value;
}

function handoffSection(label, value) {
  const items = Array.isArray(value) ? value : [value];
  const clean = items.map((item) => String(item || '').trim()).filter(Boolean);
  if (!clean.length) return '';
  return `\n## ${label}\n\n${Array.isArray(value) ? clean.map((item) => `- ${item}`).join('\n') : clean[0]}\n`;
}

function handoffBox(ctx) {
  const h = ctx.cfg.handoff;
  if (!h) throw new Error('No handoff mailbox configured (config.handoff)');
  vault(ctx, h.vault);
  return h;
}

// Read only bounded frontmatter before recipient filtering. Mailbox bodies are not touched until
// the target client and private/excluded gates have passed.
async function readHandoffHeader(file, maxBytes = 64 * 1024) {
  const fh = await open(file, 'r');
  try {
    const chunk = Buffer.alloc(4096);
    let data = '', position = 0;
    while (position < maxBytes) {
      const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, maxBytes - position), position);
      if (!bytesRead) break;
      data += chunk.toString('utf8', 0, bytesRead);
      position += bytesRead;
      const lines = data.split(/\r?\n/);
      const first = lines.findIndex((line) => line.trim() === '---');
      if (first < 0 || lines.slice(0, first).some((line) => line.trim())) return null;
      const last = lines.findIndex((line, index) => index > first && line.trim() === '---');
      if (last >= 0) {
        const raw = lines.slice(0, last + 1).join('\n');
        const parsed = parseFrontmatter(`${raw}\n`);
        return { raw: parsed.frontmatter, meta: parsed.meta, block: parsed.frontmatter };
      }
    }
    return null; // malformed or oversized headers fail closed
  } finally { await fh.close(); }
}

export async function sendHandoff(ctx, a, now = new Date()) {
  const h = handoffBox(ctx);
  const id = resolveIdentity(ctx, a);
  const errors = checkCommon(ctx, h.vault, { ...a, source: a.source || 'handoff' }, id);
  const subject = String(a.subject || '').trim();
  const te = titleError(subject); if (te) errors.push(te.replace('title', 'subject'));
  if (!a.to) errors.push('to is required (platform or agent name, or "all")');
  if (!a.body && !a.goal) errors.push('body or goal is required');
  if (a.priority && !PRIORITIES.includes(a.priority)) errors.push(`priority must be one of ${PRIORITIES.join(', ')}`);
  const status = String(a.status || (a.ack_of ? 'ACKNOWLEDGED' : 'REQUEST')).toUpperCase();
  if (!HANDOFF_STATUSES.includes(status)) errors.push(`status must be one of ${HANDOFF_STATUSES.join(', ')}`);
  if (!a.ack_of && status !== 'REQUEST') errors.push('status updates require ack_of; a new handoff must use REQUEST');
  if (a.ack_of && status === 'REQUEST') errors.push('a handoff update cannot return to REQUEST');
  if (a.scope && !['personal', 'company', 'client'].includes(a.scope)) errors.push('scope must be personal, company, or client');
  if (a.confidence && !['verified', 'reported', 'inferred', 'unknown'].includes(a.confidence)) errors.push('confidence must be verified, reported, inferred, or unknown');
  const git = validateGitCheckpoint(a.git);
  errors.push(...git.errors);
  if (a.ack_of) {
    const root = vaultRoot(ctx, h.vault);
    const ref = String(a.ack_of).replace(/\\/g, '/');
    const rel = ref.startsWith(`${h.vault}/`) ? ref.slice(h.vault.length + 1) : ref;
    const parts = rel.split('/');
    if (!rel.startsWith(`${h.folder}/`) || parts.some((part) => !part || part === '.' || part === '..') || !HANDOFF_RE.test(parts.at(-1) || '')) {
      errors.push('ack_of must identify a handoff inside the configured mailbox');
    } else {
      const target = safeJoin(root, rel);
      let header = null, unavailable = true;
      try {
        const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
        const relative = path.relative(realRoot, realTarget);
        if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
          header = await readHandoffHeader(realTarget);
          unavailable = !header || isPrivateMeta(header.meta) || fmSaysPrivate(header.block) || await isExcludedPath(root, rel)
            || (ctx.twinScope?.mode === 'scoped' && header.meta.twin_profile_id !== ctx.twinScope.profile_id);
        }
      } catch {}
      if (unavailable) errors.push('ack_of does not identify an available handoff within this Twin profile');
    }
  }
  const refs = a.source_refs || [];
  if (!Array.isArray(refs) || refs.length > 8 || refs.some((ref) => typeof ref !== 'string' || !(ref.includes('::') ? ref.split('::')[1]?.endsWith('.md') : ref.endsWith('.md')) || /[\r\n\[\]]/.test(ref))) errors.push('source_refs must be up to 8 Markdown paths, optionally qualified as Vault::path.md');
  if (!(await isDir(safeJoin(vaultRoot(ctx, h.vault), h.folder)))) errors.push(`handoff folder "${h.folder}" does not exist in ${h.vault}`);
  if (!errors.length) for (const ref of refs) {
    try {
      const [sourceVault, ...pathParts] = ref.includes('::') ? ref.split('::') : [h.vault, ref];
      const sourcePath = pathParts.join('::');
      const grant = ctx.twinScope?.mode === 'scoped'
        ? ctx.twinScope.grants?.find((item) => item.name === sourceVault && item.operations.includes('read_note'))
        : true;
      if (!grant || !ctx.enabled.includes(sourceVault)) throw new Error('source is outside the sender read scope');
      await readNote(ctx, sourceVault, sourcePath);
    }
    catch { errors.push('source_refs contains a missing, excluded, or private note'); break; }
  }
  if (errors.length) return { ok: false, errors };
  const ts = zonedNow(ctx.tz, now);
  const root = vaultRoot(ctx, h.vault);
  const nameTail = `from-${slug(id.ai_platform)}-to-${slug(a.to)}-${slug(subject).slice(0, 60)}`;
  const baseName = `${ts.slice(0, 10)}-${ts.slice(11, 13)}${ts.slice(14, 16)}-${nameTail}`;
  let rel;
  if (a.preview_path !== undefined) {
    const supplied = String(a.preview_path);
    const prefix = `${h.vault}/`;
    const relative = supplied.startsWith(prefix) ? supplied.slice(prefix.length) : supplied;
    const parts = relative.split('/');
    const fileName = parts.at(-1) || '';
    const timestampedTail = fileName.match(/^\d{4}-\d{2}-\d{2}-\d{4}-(.*)\.md$/)?.[1];
    const validName = timestampedTail === nameTail || (timestampedTail?.startsWith(`${nameTail}-`) && /^\d+$/.test(timestampedTail.slice(nameTail.length + 1)));
    if (supplied.includes('\\') || parts.length !== h.folder.split('/').length + 1 || !relative.startsWith(`${h.folder}/`) || parts.some((part) => !part || part === '.' || part === '..')
      || !HANDOFF_RE.test(fileName) || !validName) {
      return { ok: false, errors: ['preview_path must be the exact preview path for this recipient, subject, and mailbox'] };
    }
    rel = relative;
  } else {
    rel = `${h.folder}/${baseName}.md`;
    for (let suffix = 2; await exists(safeJoin(root, rel)); suffix++) {
      if (suffix > 10000) return { ok: false, errors: ['could not find an unused handoff filename; retry the preview'] };
      rel = `${h.folder}/${baseName}-${suffix}.md`;
    }
  }
  const fm = ['---', 'type: handoff', 'handoff_schema: 1', `status: ${status}`, `ai_platform: ${q(id.ai_platform)}`, `agent_or_role: ${q(id.agent_or_role)}`,
    `session_or_task_id: ${q(id.session_or_task_id)}`, `written_at: ${ts}`, `to: ${q(a.to)}`, `priority: ${a.priority || 'P2'}`, `subject: ${q(subject)}`,
    `decision_needed: ${a.decision_needed ? 'yes' : 'no'}`, `deadline: ${a.deadline || ''}`, `ack_of: ${a.ack_of || ''}`, `source: ${q(a.source || 'handoff')}`,
    `scope: ${q(a.scope || 'unspecified')}`, `confidence: ${q(a.confidence || 'unknown')}`,
    ...(git.value ? ['git_checkpoint_schema: 1', `git_repo: ${q(git.value.repo)}`, `git_branch: ${q(git.value.branch)}`, `git_head: ${q(git.value.head)}`, `git_dirty: ${git.value.dirty ? 'true' : 'false'}`, `git_ahead: ${git.value.ahead}`] : []),
    ...(ctx.twinScope?.mode === 'scoped' ? [`twin_profile_id: ${q(ctx.twinScope.profile_id)}`] : []), '---'].join('\n');
  const sections = HANDOFF_FIELDS.map(([field, label]) => handoffSection(label, a[field])).join('');
  const gitSection = git.value ? handoffSection('Git checkpoint (reported by sender; not verified by BrainLink)', `Repository: ${git.value.repo}\nBranch: ${git.value.branch}\nCommit: ${git.value.head}\nWorking tree dirty: ${git.value.dirty}\nCommits ahead: ${git.value.ahead}`) : '';
  const sources = refs.length ? handoffSection('Sources', refs.map((ref) => `\`${ref}\``)) : '';
  const body = a.body ? handoffSection('Body', a.body) : '';
  return commitNew(ctx, h.vault, rel, `${fm}\n\n# ${subject}\n\n${madeBy(id)}\n${sections}${gitSection}${sources}${body}`, a.confirm);
}

// P0: a handoff receipt (Setup UI) reads this same list, so a handoff mailbox folder that ends up
// under an excluded ("00 Home"-style) folder, or a handoff note hand-edited with `private: true`,
// must never surface here either -- same fail-closed check readNote() uses for ordinary notes.
export async function listHandoffs(ctx, { to, limit = 10 } = {}) {
  const h = handoffBox(ctx);
  const verifyCheckpoint = createHandoffGitVerifier(ctx);
  const root = vaultRoot(ctx, h.vault);
  const dir = safeJoin(root, h.folder);
  let names = [];
  try { names = (await readdir(dir)).filter((f) => HANDOFF_RE.test(f)).sort().reverse(); } catch {}
  const want = to ? slug(to) : null;
  const out = [];
  for (const f of names) {
    const rel = `${h.folder}/${f}`;
    if (await isExcludedPath(root, rel)) continue;
    const m = f.match(/-from-(.+)-to-/);
    const full = safeJoin(dir, f);
    const header = await readHandoffHeader(full).catch(() => null);
    if (!header || isPrivateMeta(header.meta) || fmSaysPrivate(header.block)) continue;
    if (ctx.twinScope?.mode === 'scoped' && header.meta.twin_profile_id !== ctx.twinScope.profile_id) continue;
    // Read the recipient from frontmatter: splitting a slugged name such as "Claude Code"
    // at hyphens makes filename-only matching ambiguous with the subject slug.
    const recipient = slug(header.meta.to || f.match(/-to-([a-z0-9-]+?)-/)?.[1] || '');
    if (want && !(recipient === want || recipient === 'all' || recipient.startsWith(want))) continue;
    const document = parseFrontmatter(await readFile(full, 'utf8'));
    if (document.frontmatter.replace(/\r\n/g, '\n') !== header.block.replace(/\r\n/g, '\n') || isPrivateMeta(document.meta) || fmSaysPrivate(document.frontmatter)) continue;
    const { meta, body } = document;
    const dm = f.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})-/);
    const sent_at = meta.written_at || (dm ? `${dm[1]}T${dm[2]}:${dm[3]}:00` : '');
    const gitCheckpoint = gitCheckpointFromMeta(meta);
    out.push({ path: `${h.vault}/${rel}`, from: m?.[1], to: recipient, status: meta.status || '', priority: meta.priority || '', subject: meta.subject || f, decision_needed: meta.decision_needed || '', excerpt: body.trim().slice(0, 300), ...(gitCheckpoint ? { git_checkpoint: gitCheckpoint, git_checkpoint_verification: verifyCheckpoint(gitCheckpoint) } : {}), ack_of: meta.ack_of || '', sent_at });
    if (out.length >= limit) break;
  }
  return out;
}
