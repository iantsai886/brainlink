// Small, fail-closed typed relationship layer for Markdown knowledge records.
// Only explicitly verified relations with valid evidence are materialized as graph edges.
const ENTITY_TYPES = new Set(['person', 'team', 'workflow', 'dataset', 'artifact', 'project', 'policy', 'concept']);
const PREDICATES = new Set(['owned_by', 'runs', 'consumes', 'produces', 'depends_on', 'part_of', 'assigned_to', 'informed_by']);
const SCOPES = new Set(['personal', 'organisation', 'client']);
const ID = /^[a-z][a-z0-9._:-]{1,127}$/;

function scalar(value) {
  const s = String(value || '').trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) return s.slice(1, -1).trim();
  return s;
}

function frontmatterLines(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const match = text.match(/^(?:[ \t]*\r?\n)*---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/);
  return match ? match[1].split(/\r?\n/) : [];
}

function parseRecord(raw) {
  const lines = frontmatterLines(raw);
  const meta = {};
  let inRelations = false;
  let current = null;
  const relations = [];
  for (const line of lines) {
    const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (top) {
      if (inRelations && current) relations.push(current);
      inRelations = top[1] === 'relations' && top[2].trim() === '';
      current = null;
      if (!inRelations) meta[top[1]] = scalar(top[2]);
      continue;
    }
    if (!inRelations) continue;
    const item = line.match(/^\s{2}-\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    if (item) {
      if (current) relations.push(current);
      current = { [item[1]]: scalar(item[2]) };
      continue;
    }
    const field = line.match(/^\s{4}([A-Za-z_][\w-]*):\s*(.*)$/);
    if (field && current) current[field[1]] = scalar(field[2]);
  }
  if (current) relations.push(current);
  return { meta, relations };
}

export function typedEntityMetadataMap(notes) {
  const candidates = notes.map((note) => ({ note, meta: parseRecord(note.raw).meta }));
  const counts = new Map();
  for (const { note, meta } of candidates) {
    if (ENTITY_TYPES.has(meta.type) && ID.test(meta.id || '') && SCOPES.has(meta.scope) && meta.status === 'current' && !note.generated) counts.set(meta.id, (counts.get(meta.id) || 0) + 1);
  }
  return new Map(candidates.filter(({ note, meta }) => counts.get(meta.id) === 1 && ENTITY_TYPES.has(meta.type) && ID.test(meta.id || '') && SCOPES.has(meta.scope) && meta.status === 'current' && !note.generated)
    .map(({ note, meta }) => [note, { type: meta.type, entity_id: meta.id, scope: meta.scope }]));
}

// notes must already be filtered to the caller's authorized, non-private vault.
export function deriveTypedRelations(notes) {
  const records = notes.map((note) => ({ note, ...parseRecord(note.raw) }));
  const byId = new Map();
  const duplicates = new Set();
  for (let i = 0; i < records.length; i++) {
    const { meta } = records[i];
    if (!ENTITY_TYPES.has(meta.type) || !ID.test(meta.id || '') || !SCOPES.has(meta.scope) || meta.status !== 'current' || records[i].note.generated) continue;
    if (byId.has(meta.id)) { byId.delete(meta.id); duplicates.add(meta.id); }
    else if (!duplicates.has(meta.id)) byId.set(meta.id, i);
  }

  const edges = [];
  for (let source = 0; source < records.length; source++) {
    const record = records[source];
    const { meta } = record;
    if (!ENTITY_TYPES.has(meta.type) || !ID.test(meta.id || '') || !SCOPES.has(meta.scope) || meta.status !== 'current' || record.note.generated || duplicates.has(meta.id)) continue;
    for (const relation of record.relations) {
      const target = byId.get(relation.target);
      if (target === undefined || target === source) continue;
      const targetMeta = records[target].meta;
      const confidenceText = relation.confidence || '';
      const confidence = Number(confidenceText);
      if (!PREDICATES.has(relation.predicate) || relation.review !== 'verified' || !relation.source ||
          relation.source.length > 300 || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(confidenceText) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || targetMeta.scope !== meta.scope) continue;
      edges.push({ source, target, predicate: relation.predicate, evidence: relation.source, confidence });
    }
  }
  return edges;
}

// Suggestions are visible only after the caller has applied its vault and privacy filters.
// Targets must still be unique, current, visible records in the same Twin scope.
export function deriveProposedTypedRelations(notes) {
  const records = notes.map((note) => ({ note, ...parseRecord(note.raw) }));
  const byId = new Map();
  const duplicates = new Set();
  for (let i = 0; i < records.length; i++) {
    const { note, meta } = records[i];
    if (!note.generated && !note.private && ENTITY_TYPES.has(meta.type) && ID.test(meta.id || '') && SCOPES.has(meta.scope) && meta.status === 'current') {
      if (byId.has(meta.id)) { byId.delete(meta.id); duplicates.add(meta.id); }
      else if (!duplicates.has(meta.id)) byId.set(meta.id, i);
    }
  }
  const proposals = [];
  for (let source = 0; source < records.length; source++) {
    const { note, meta, relations } = records[source];
    if (note.generated || note.private || !ENTITY_TYPES.has(meta.type) || !ID.test(meta.id || '') || !SCOPES.has(meta.scope) || !['current', 'proposed'].includes(meta.status)) continue;
    relations.forEach((relation, relation_index) => {
      const target = byId.get(relation.target);
      const confidenceText = relation.confidence || '';
      if (target === undefined || target === source || !PREDICATES.has(relation.predicate) || relation.review !== 'proposed' ||
          !relation.source || relation.source.length > 300 || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(confidenceText) ||
          records[target].meta.scope !== meta.scope) return;
      proposals.push({ source, target, relation_index, predicate: relation.predicate, evidence: relation.source, confidence: Number(confidenceText) });
    });
  }
  return proposals;
}

// Change only the selected review marker and (when needed) the source record's status.
// The caller must first revalidate the target and compare a content hash.
export function approveTypedRelation(raw, relationIndex) {
  if (!Number.isInteger(relationIndex) || relationIndex < 0) throw new Error('Invalid relationship selection.');
  const match = String(raw || '').match(/^(\uFEFF?---[^\S\r\n]*\r?\n)([\s\S]*?)(\r?\n---[^\S\r\n]*(?:\r?\n|$))/);
  if (!match) throw new Error('This note has no valid frontmatter.');
  const lines = match[2].split(/\r?\n/);
  const statusLine = lines.findIndex((line) => /^status:\s*(?:proposed|current)\s*$/.test(line));
  if (statusLine < 0) throw new Error('This record is not a reviewable typed entity.');
  if (/^status:\s*proposed\s*$/.test(lines[statusLine])) lines[statusLine] = lines[statusLine].replace('proposed', 'current');
  const section = lines.findIndex((line) => /^relations:\s*$/.test(line));
  if (section < 0) throw new Error('This note has no relationship suggestions.');
  const starts = [];
  for (let i = section + 1; i < lines.length && !/^[A-Za-z_][\w-]*:\s*/.test(lines[i]); i++) {
    if (/^\s{2}-\s+/.test(lines[i])) starts.push(i);
  }
  const start = starts[relationIndex];
  if (start === undefined) throw new Error('The selected relationship no longer exists.');
  const end = starts[relationIndex + 1] ?? lines.findIndex((line, i) => i > start && /^[A-Za-z_][\w-]*:\s*/.test(line));
  const stop = end < 0 ? lines.length : end;
  const reviewLine = lines.findIndex((line, i) => i > start && i < stop && /^\s{4}review:\s*proposed\s*$/.test(line));
  if (reviewLine < 0) throw new Error('This relationship is no longer awaiting review.');
  lines[reviewLine] = lines[reviewLine].replace('proposed', 'verified');
  return `${match[1]}${lines.join(raw.includes('\r\n') ? '\r\n' : '\n')}${match[3]}${String(raw).slice(match[0].length)}`;
}

export const TYPED_ENTITY_TYPES = [...ENTITY_TYPES];
export const TYPED_RELATION_PREDICATES = [...PREDICATES];
