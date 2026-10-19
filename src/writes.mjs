// Identity-aware writes. Every write is a new file or an append (never an overwrite), carries
// attribution in the vault's frontmatter schema, passes a secret scan, and returns a preview
// unless confirm=true.
import { writeFile, appendFile, readdir, readFile, stat, open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { TEMPLATES, renderTemplate } from './templates.mjs';
import { suggestLinks, relatedSection, safeUpdateMap } from './links.mjs';
import { vault, vaultRoot, safeJoin, findSecrets, zonedNow, parseFrontmatter } from './core.mjs';

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

export function frontmatter(ctx, vaultName, id, f, now = new Date()) {
  const v = vault(ctx, vaultName);
  const ts = zonedNow(ctx.tz, now);
  const tags = `[${(f.tags || []).map((t) => String(t).replace(/[^\w㐀-鿿-]/g, '')).filter(Boolean).join(', ')}]`;
  const extra = Object.entries(v.extra_fields || {}).map(([k, val]) => `${k}: ${q(val)}`);
  if (v.schema === 'provenance') {
    const date = ts.slice(0, 10);
    return ['---', `type: ${f.type || 'log'}`, `status: ${f.status || 'proposed'}`, `tags: ${tags}`, ...extra,
      `created_by_platform: ${slug(id.ai_platform)}`, `created_by_agent: ${slug(id.agent_or_role)}`, `created_session_or_task_id: ${q(id.session_or_task_id)}`, `created_date: ${date}`,
      `last_material_revision_by_platform: ${slug(id.ai_platform)}`, `last_material_revision_by_agent: ${slug(id.agent_or_role)}`,
      `last_material_revision_session_or_task_id: ${q(id.session_or_task_id)}`, `last_material_revision_date: ${date}`,
      `provenance_confidence: ${['verified', 'reported', 'inferred'].includes(f.confidence) ? f.confidence : 'unknown'}`, `source: ${q(f.source)}`, '---'].join('\n');
  }
  return ['---', `type: ${f.type || 'note'}`, `status: ${f.status || 'proposed'}`, `ai_platform: ${q(id.ai_platform)}`, `agent_or_role: ${q(id.agent_or_role)}`,
    `session_or_task_id: ${q(id.session_or_task_id)}`, `written_at: ${ts}`, `source: ${q(f.source)}`, `confidence: ${q(f.confidence || 'proposed')}`, `tags: ${tags}`, ...extra, '---'].join('\n');
}

export function checkCommon(ctx, vaultName, a, id) {
  const errors = [...id.errors];
  const v = vault(ctx, vaultName);
  if (ctx.readOnly) errors.push(ctx.features.writes ? 'this connection is read-only (BRAINLINK_READ_ONLY)' : 'writes need a BrainLink licence (free mode is read-only)');
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
  const title = String(a.title || '').trim();
  const te = titleError(title); if (te) errors.push(te);
  const tpl = a.template ? TEMPLATES[a.template] : null;
  if (a.template && !tpl) errors.push(`template must be one of ${Object.keys(TEMPLATES).join(', ')}`);
  if (!tpl && (!a.body || !String(a.body).trim())) errors.push('body is required');
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
  if (errors.length) return { ok: false, errors };

  const date = zonedNow(ctx.tz, now).slice(0, 10);
  const name = `${date} — ${title}.md`;
  const rel = folder ? `${folder}/${name}` : name;
  const fm = frontmatter(ctx, vaultName, id, { ...a, type: a.type || tpl?.type || (intake ? 'intake' : undefined) }, now);
  const decision = needsDecision ? `## Decision\n\n**${String(a.decision).toUpperCase()}**\n\n` : '';
  const body = tpl ? renderTemplate(a.template, a.fields || {}, a.body) : String(a.body).trim();
  const links = a.auto_link === false ? [] : await suggestLinks(ctx, vaultName, `${title}\n${body}`, { limit: 5 }).catch(() => []);
  const content = `${fm}\n\n# ${title}\n\n${madeBy(id)}\nOther AI platforms also write this vault — do not treat unsigned edits as this note's author.\n\n${decision}${body}\n\n${relatedSection(links)}## Changelog\n\n- ${date} — Created. Made by ${id.ai_platform} (${id.agent_or_role}).\n`;
  const r = await commitNew(ctx, vaultName, rel, content, a.confirm);
  return r.ok ? { ...r, linked_to: links.map((l) => l.target) } : r;
}

export async function commitNew(ctx, vaultName, rel, content, confirm) {
  const v = vault(ctx, vaultName);
  const full = safeJoin(vaultRoot(ctx, vaultName), rel);
  if (await exists(full)) return { ok: false, errors: [`refused: ${vaultName}/${rel} already exists; never overwrite — use a new dated note or an append tool`] };
  if (v.writes === 'proposal-only') return { ok: true, written: false, path: `${vaultName}/${rel}`, preview: content, next: `${vaultName} is proposal-only: show this to the user; do not write it elsewhere.` };
  if (!confirm) return { ok: true, written: false, path: `${vaultName}/${rel}`, preview: content, next: 'Show the preview to the user; call again with confirm=true after approval.' };
  await writeFile(full, content, { flag: 'wx' });
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

// ---- remember: durable facts the user wants every AI to know ----

export const MEMORY_NOTE = 'BrainLink/Memories.md';
const normFact = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export async function readMemories(ctx, vaultName, limit = 30) {
  try {
    const raw = await readFile(safeJoin(vaultRoot(ctx, vaultName), MEMORY_NOTE), 'utf8');
    return raw.split('\n').filter((l) => /^- /.test(l)).map((l) => l.replace(/^- /, '').replace(/\s*_\(.*\)_\s*$/, '').trim()).slice(-limit);
  } catch { return []; }
}

export async function remember(ctx, a, now = new Date()) {
  const vaultName = a.vault || ctx.enabled[0];
  const root = vaultRoot(ctx, vaultName);
  const id = resolveIdentity(ctx, a);
  const errors = checkCommon(ctx, vaultName, { ...a, source: a.source || 'conversation' }, id);
  const facts = (Array.isArray(a.facts) ? a.facts : [a.fact]).map((f) => String(f || '').trim().replace(/\n+/g, ' ')).filter(Boolean);
  if (!facts.length) errors.push('fact is required (one short sentence the user wants remembered)');
  if (facts.some((f) => f.length > 300)) errors.push('keep each fact under 300 characters');
  if (errors.length) return { ok: false, errors };
  const known = new Set((await readMemories(ctx, vaultName, 1000)).map(normFact));
  const fresh = facts.filter((f) => !known.has(normFact(f)));
  if (!fresh.length) return { ok: true, written: false, already_known: facts };
  const date = zonedNow(ctx.tz, now).slice(0, 10);
  const text = fresh.map((f) => `- ${f} _(${date}, ${id.ai_platform})_`).join('\n') + '\n';
  if (vault(ctx, vaultName).writes === 'proposal-only') return { ok: true, written: false, preview: text, next: 'This vault is proposal-only: show the memory to the user.' };
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
  const entry = `${text.split('\n').map((l, i) => (i ? `  ${l}` : `- ${ts.slice(11, 16)} ${l}`)).join('\n')} _(${id.ai_platform})_\n`;
  if (vault(ctx, vaultName).writes === 'proposal-only') return { ok: true, written: false, path: `${vaultName}/${rel}`, preview: entry, next: 'This vault is proposal-only.' };
  if (!a.confirm) return { ok: true, written: false, path: `${vaultName}/${rel}`, preview: entry, next: 'Call again with confirm=true to add it to today\'s note.' };
  const full = safeJoin(root, rel);
  if (!(await exists(full))) { await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, `# ${ts.slice(0, 10)}\n\n`, { flag: 'wx' }); }
  await appendTo(root, rel, entry);
  await safeUpdateMap(ctx, vaultName);
  return { ok: true, written: true, path: `${vaultName}/${rel}` };
}

// ---- inter-AI handoff mailbox ----

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const HANDOFF_RE = /^\d{4}-\d{2}-\d{2}-\d{4}-from-.+\.md$/;

function handoffBox(ctx) {
  const h = ctx.cfg.handoff;
  if (!h) throw new Error('No handoff mailbox configured (config.handoff)');
  vault(ctx, h.vault);
  return h;
}

export async function sendHandoff(ctx, a, now = new Date()) {
  const h = handoffBox(ctx);
  const id = resolveIdentity(ctx, a);
  const errors = checkCommon(ctx, h.vault, { ...a, source: a.source || 'handoff' }, id);
  const subject = String(a.subject || '').trim();
  const te = titleError(subject); if (te) errors.push(te.replace('title', 'subject'));
  if (!a.to) errors.push('to is required (platform or agent name, or "all")');
  if (!a.body) errors.push('body is required');
  if (a.priority && !PRIORITIES.includes(a.priority)) errors.push(`priority must be one of ${PRIORITIES.join(', ')}`);
  if (!(await isDir(safeJoin(vaultRoot(ctx, h.vault), h.folder)))) errors.push(`handoff folder "${h.folder}" does not exist in ${h.vault}`);
  if (errors.length) return { ok: false, errors };
  const ts = zonedNow(ctx.tz, now);
  const rel = `${h.folder}/${ts.slice(0, 10)}-${ts.slice(11, 13)}${ts.slice(14, 16)}-from-${slug(id.ai_platform)}-to-${slug(a.to)}-${slug(subject).slice(0, 60)}.md`;
  const fm = ['---', 'type: handoff', `status: ${a.status || 'REQUEST'}`, `ai_platform: ${q(id.ai_platform)}`, `agent_or_role: ${q(id.agent_or_role)}`,
    `session_or_task_id: ${q(id.session_or_task_id)}`, `written_at: ${ts}`, `to: ${q(a.to)}`, `priority: ${a.priority || 'P2'}`, `subject: ${q(subject)}`,
    `decision_needed: ${a.decision_needed ? 'yes' : 'no'}`, `deadline: ${a.deadline || ''}`, `ack_of: ${a.ack_of || ''}`, `source: ${q(a.source || 'handoff')}`, '---'].join('\n');
  return commitNew(ctx, h.vault, rel, `${fm}\n\n# ${subject}\n\n${madeBy(id)}\n\n## Body\n\n${String(a.body).trim()}\n`, a.confirm);
}

export async function listHandoffs(ctx, { to, limit = 10 } = {}) {
  const h = handoffBox(ctx);
  const dir = safeJoin(vaultRoot(ctx, h.vault), h.folder);
  let names = [];
  try { names = (await readdir(dir)).filter((f) => HANDOFF_RE.test(f)).sort().reverse(); } catch {}
  const want = to ? slug(to) : null;
  const out = [];
  for (const f of names) {
    const m = f.match(/-from-([a-z0-9-]+?)-to-([a-z0-9-]+?)-/);
    if (want && m && !(m[2] === want || m[2] === 'all' || m[2].startsWith(want))) continue;
    const { meta, body } = parseFrontmatter(await readFile(safeJoin(dir, f), 'utf8'));
    out.push({ path: `${h.vault}/${h.folder}/${f}`, from: m?.[1], to: m?.[2], status: meta.status || '', priority: meta.priority || '', subject: meta.subject || f, decision_needed: meta.decision_needed || '', excerpt: body.trim().slice(0, 300) });
    if (out.length >= limit) break;
  }
  return out;
}
