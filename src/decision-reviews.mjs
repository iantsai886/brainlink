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
    const happened = [];
    for (let j = 0; j < index.notes.length && happened.length < 3; j++) {
      if (j === i || index.notes[j].date <= String(note.meta.created_date || note.date)) continue;
      if (index.outlinks[j]?.has(i)) happened.push({ title: index.notes[j].title, path: index.notes[j].rel, date: index.notes[j].date });
    }
    candidates.push({ vault: vaultName, title: note.title, path: note.rel, review_date: effective, decision_date: String(note.meta.created_date || note.date), happened_since: happened });
  }
  return candidates.sort((a, b) => a.review_date.localeCompare(b.review_date) || a.path.localeCompare(b.path)).slice(0, Math.max(1, Math.min(50, limit)));
}

export async function readDecisionReview(ctx, vaultName, rel) {
  const note = await readNote(ctx, vaultName, rel);
  if (String(note.meta.type || '').toLowerCase() !== 'decision' || !validReviewDate(note.meta.review_date)) throw new Error('This visible note is not a decision with a valid review date.');
  return note;
}
