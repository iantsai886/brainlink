import { loadVault, readNote } from './core.mjs';

export function validReviewDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

export async function listDecisionReviews(ctx, vaultName, { today = new Date().toISOString().slice(0, 10), limit = 50 } = {}) {
  const index = await loadVault(ctx, vaultName);
  const candidates = [];
  // Build incoming links once. The old per-decision scan walked the complete note list
  // for every decision, making review load proportional to decisions × notes.
  const incomingByTarget = new Map();
  for (let source = 0; source < index.outlinks.length; source++) {
    for (const target of index.outlinks[source] || []) {
      const note = index.notes[source];
      const list = incomingByTarget.get(target) || [];
      list.push(note);
      incomingByTarget.set(target, list);
    }
  }
  for (let i = 0; i < index.notes.length; i++) {
    const note = index.notes[i];
    if (note.private || note.generated || String(note.meta.type || '').toLowerCase() !== 'decision') continue;
    const original = String(note.meta.review_date || '').trim();
    if (!validReviewDate(original)) continue;
    const retired = [...note.body.matchAll(/^Decision retired: (\d{4}-\d{2}-\d{2})$/gmi)].at(-1)?.[1];
    if (retired && validReviewDate(retired)) continue;
    const reschedules = [...note.body.matchAll(/^Review rescheduled: (\d{4}-\d{2}-\d{2})$/gmi)].map((m) => m[1]).filter(validReviewDate);
    const effective = reschedules.at(-1) || original;
    if (effective > today) continue;
    const cutoff = String(note.meta.created_date || note.date);
    const happened = (incomingByTarget.get(i) || [])
      .filter((linked) => linked !== note && linked.date > cutoff)
      .slice(0, 3)
      .map((linked) => ({ title: linked.title, path: linked.rel, date: linked.date }));
    candidates.push({ vault: vaultName, title: note.title, path: note.rel, review_date: effective, decision_date: String(note.meta.created_date || note.date), happened_since: happened });
  }
  return candidates.sort((a, b) => a.review_date.localeCompare(b.review_date) || a.path.localeCompare(b.path)).slice(0, Math.max(1, Math.min(50, limit)));
}

export async function readDecisionReview(ctx, vaultName, rel) {
  const note = await readNote(ctx, vaultName, rel);
  if (String(note.meta.type || '').toLowerCase() !== 'decision' || !validReviewDate(note.meta.review_date)) throw new Error('This visible note is not a decision with a valid review date.');
  return note;
}
