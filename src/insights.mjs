// Read-only views across a whole vault: what changed recently, what is still open (unchecked
// tasks, next actions, unresolved questions, decisions waiting), the vault's link health, and
// a brief that combines them, for "what's going on?" and for agents when they connect.
import { loadVault, summarize, zonedNow } from './core.mjs';
import { linkTarget } from './links.mjs';

const daysAgo = (tz, n, now = new Date()) => zonedNow(tz, new Date(now.getTime() - n * 86400e3)).slice(0, 10);

export async function recentNotes(ctx, vaultName, { days = 7, since, until, limit = 15, folder } = {}, now = new Date()) {
  const index = await loadVault(ctx, vaultName);
  const from = since || daysAgo(ctx.tz, days, now);
  const f = folder ? String(folder).replace(/^\/+|\/+$/g, '').toLowerCase() + '/' : null;
  const touched = (n) => [n.date, new Date(n.mtime).toISOString().slice(0, 10)].sort().pop();
  return index.notes.map((n, i) => ({ n, i, when: touched(n) }))
    .filter(({ n, when }) => !n.generated && !n.private && when >= from && (!until || when <= until) && (!f || n.rel.toLowerCase().startsWith(f)))
    .sort((a, b) => b.n.mtime - a.n.mtime)
    .slice(0, limit)
    .map(({ i, n, when }) => summarize(index, i, { changed: when, snippet: n.body.replace(/^#.*$/m, '').replace(/\*\*Made by[^\n]*\n?/, '').trim().slice(0, 200) }));
}

// Field lines written by close-loop captures, e.g. "- **Smallest next actions:** …" (single or nested list).
function captureFields(body, labels) {
  const out = [];
  // Markdown vaults synced from Windows commonly use CRLF. Match fields on logical lines.
  const lines = body.split(/\r?\n/);
  for (let k = 0; k < lines.length; k++) {
    const m = lines[k].match(/^- \*\*([^*]+):\*\*\s*(.*)$/);
    if (!m || !labels.some((re) => re.test(m[1]))) continue;
    if (m[2].trim()) out.push({ label: m[1], text: m[2].trim() });
    for (let j = k + 1; j < lines.length && /^\s{2,}- /.test(lines[j]); j++) out.push({ label: m[1], text: lines[j].replace(/^\s+- /, '').trim() });
  }
  return out;
}

const sectionHeadingBefore = (body, pos) => { const before = body.slice(0, pos); const m = [...before.matchAll(/^#{1,3} (.+)$/gm)].pop(); return m ? m[1].trim() : ''; };

export async function openLoops(ctx, vaultName, { days = 60, limit = 40 } = {}, now = new Date()) {
  const index = await loadVault(ctx, vaultName);
  const from = daysAgo(ctx.tz, days, now);
  const tasks = [], next = [], questions = [], decisions = [];
  index.notes.forEach((n, i) => {
    if (n.generated || n.historical || n.private) return;
    const at = linkTarget(index, i);
    for (const m of n.body.matchAll(/^\s*[-*] \[ \] (.+)$/gm)) tasks.push({ task: m[1].trim(), note: at, path: n.rel, date: n.date });
    // Captures are dated sections; only recent ones count as open.
    for (const part of n.body.split(/^(?=## \d{4}-\d{2}-\d{2})/m)) {
      const d = part.match(/^## (\d{4}-\d{2}-\d{2})/)?.[1] || n.date;
      if (d < from) continue;
      for (const f of captureFields(part, [/next action/i])) next.push({ action: f.text, note: at, path: n.rel, date: d });
      for (const f of captureFields(part, [/unresolved/i, /open question/i])) questions.push({ question: f.text, note: at, path: n.rel, date: d });
      for (const f of captureFields(part, [/decision needed/i])) decisions.push({ decision: f.text, note: at, path: n.rel, date: d });
    }
    if (/^yes$/i.test(n.meta.decision_needed || '') && !/^(done|closed|ack)/i.test(n.meta.status || '')) decisions.push({ decision: n.meta.subject || n.title, note: at, path: n.rel, date: n.date });
  });
  const newest = (a, b) => b.date.localeCompare(a.date);
  return {
    tasks: tasks.sort(newest).slice(0, limit), next_actions: next.sort(newest).slice(0, limit),
    unresolved_questions: questions.sort(newest).slice(0, limit), decisions_waiting: decisions.sort(newest).slice(0, limit),
    counts: { tasks: tasks.length, next_actions: next.length, unresolved_questions: questions.length, decisions_waiting: decisions.length },
  };
}

export async function vaultHealth(ctx, vaultName, { staleDays = 180 } = {}, now = new Date()) {
  const index = await loadVault(ctx, vaultName);
  const visible = (i) => !index.notes[i].generated && !index.notes[i].private;
  const real = index.notes.map((_, i) => i).filter(visible);
  const linked = (i) => [...index.backlinks[i], ...index.outlinks[i]].some(visible);
  const orphans = real.filter((i) => !linked(i));
  const dupes = [...index.byTitle.entries()].map(([title, ids]) => [title, ids.filter(visible)]).filter(([, ids]) => ids.length > 1).map(([title, ids]) => ({ title, paths: ids.map((i) => index.notes[i].rel) }));
  const cutoff = now.getTime() - staleDays * 86400e3;
  const stale = real.filter((i) => index.notes[i].mtime < cutoff && /^(active|current)$/i.test(index.notes[i].meta.status || '') && !index.notes[i].historical);
  const broken = index.broken.filter((b) => visible(b.from));
  const links = index.edges.filter(([a, b]) => visible(a) && visible(b)).length;
  return {
    notes: real.length, links, orphan_count: orphans.length,
    orphans: orphans.slice(0, 30).map((i) => summarize(index, i)),
    broken_links: broken.slice(0, 30).map((b) => ({ in: index.notes[b.from].rel, target: b.target })), broken_count: broken.length,
    duplicate_titles: dupes.slice(0, 20),
    stale_active_notes: stale.slice(0, 20).map((i) => summarize(index, i)),
    tips: [
      orphans.length ? `${orphans.length} notes have no links: open each with vault_related and add links in a new note, or mention them by name in your next notes (BrainLink links mentions automatically).` : null,
      broken.length ? `${broken.length} links point to notes that do not exist yet: create those notes or fix the names.` : null,
      dupes.length ? `${dupes.length} titles are used by more than one note: links to them may go to the wrong one.` : null,
    ].filter(Boolean),
  };
}

export async function brief(ctx, vaultName, { days = 7 } = {}, now = new Date()) {
  const [recent, loops, health] = await Promise.all([recentNotes(ctx, vaultName, { days, limit: 10 }, now), openLoops(ctx, vaultName, { days: 30, limit: 8 }, now), vaultHealth(ctx, vaultName, {}, now)]);
  return {
    vault: vaultName, as_of: zonedNow(ctx.tz, now), period_days: days,
    changed: recent.map((r) => ({ title: r.title, path: r.path, changed: r.changed })),
    open_loops: { counts: loops.counts, next_actions: loops.next_actions, decisions_waiting: loops.decisions_waiting, unresolved_questions: loops.unresolved_questions, tasks: loops.tasks },
    health: { notes: health.notes, links: health.links, not_linked: health.orphan_count, broken_links: health.broken_count },
    instructions: 'Summarise for the user in a few lines: what changed, the most important open items, and one suggested next step. Cite note titles.',
  };
}
