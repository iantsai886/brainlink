import { createHash } from 'node:crypto';
import { loadVault, ROUTING_NOTE } from './core.mjs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const folder = (rel) => path.posix.dirname(rel);
const dateToken = (value) => value.match(/(?:^|\D)(20\d{2}(?:[-_. ]?\d{2}){0,2})(?=\D|$)/g)?.map((x) => x.replace(/\D/g, '')) || [];
const stem = (value) => value.toLocaleLowerCase().replace(/\b20\d{2}(?:[-_. ]?\d{2}){0,2}\b/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

export async function listConflictCandidates(ctx, vaultName, { limit = 50, offset = 0, dismissed = [], index: suppliedIndex } = {}) {
  const index = suppliedIndex || await loadVault(ctx, vaultName);
  const visible = index.notes.filter((note) => !note.private && !note.generated && !ROUTING_NOTE.test(note.title));
  const pairs = new Map();
  const add = (left, right, reason) => {
    if (!left || !right || left.rel === right.rel) return;
    const [a, b] = [left, right].sort((x, y) => x.rel.localeCompare(y.rel));
    const id = digest(`${vaultName}\0${a.rel}\0${b.rel}`);
    if (dismissed.includes(id)) return;
    const prior = pairs.get(id);
    pairs.set(id, { id, vault: vaultName, a: { path: a.rel, title: a.title }, b: { path: b.rel, title: b.title }, reasons: [...new Set([...(prior?.reasons || []), reason])] });
  };
  const group = (items, key) => {
    const groups = new Map();
    for (const note of items) { const value = key(note); if (!value) continue; const rows = groups.get(value) || []; rows.push(note); groups.set(value, rows); }
    return groups;
  };
  for (const [title, notes] of group(visible, (note) => note.title.trim().toLocaleLowerCase())) {
    for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) if (folder(notes[i].rel) !== folder(notes[j].rel)) add(notes[i], notes[j], `same title: ${title}`);
  }
  const stems = group(visible, (note) => stem(note.title));
  for (const [titleStem, notes] of stems) {
    if (!titleStem || notes.length < 2) continue;
    const dated = notes.map((note) => ({ note, dates: dateToken(note.title) })).filter((item) => item.dates.length);
    const distinctDates = new Set(dated.flatMap((item) => item.dates));
    if (distinctDates.size < 2) continue;
    for (let i = 0; i < dated.length; i++) for (let j = i + 1; j < dated.length; j++) {
      if (dated[i].dates.some((date) => dated[j].dates.some((other) => date !== other))) add(dated[i].note, dated[j].note, `similar dated title: ${titleStem}`);
    }
  }
  for (const [, notes] of group(visible.filter((note) => note.meta.id && note.meta.type), (note) => `${String(note.meta.type).toLowerCase()}\0${String(note.meta.id).toLowerCase()}`)) {
    for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) add(notes[i], notes[j], `same typed entity ID: ${notes[i].meta.id}`);
  }
  const all = [...pairs.values()].sort((a, b) => a.a.path.localeCompare(b.a.path) || a.b.path.localeCompare(b.b.path));
  const size = Math.max(1, Math.min(50, limit)), start = Math.max(0, Math.min(100_000, offset));
  return { candidates: all.slice(start, start + size), total: all.length, more: Math.max(0, all.length - (start + size)), offset: start };
}

export function createConflictReviewStore(home) {
  const file = path.join(home, 'conflict-reviews', 'dismissed.json');
  async function read() { try { const data = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(data.dismissed) ? data.dismissed.filter((id) => /^[a-f0-9]{64}$/.test(id)) : []; } catch { return []; } }
  return {
    async dismissed() { return read(); },
    async dismiss(id) {
      if (!/^[a-f0-9]{64}$/.test(String(id))) throw new Error('Conflict candidate ID is invalid.');
      const dismissed = await read();
      if (!dismissed.includes(id)) dismissed.push(id);
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${digest(`${Date.now()}-${Math.random()}`).slice(0, 12)}.tmp`;
      await writeFile(temp, `${JSON.stringify({ dismissed }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temp, file);
    },
  };
}
