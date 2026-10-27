// Small, fail-closed typed relationship layer for Markdown knowledge records.
// Only explicitly verified relations with valid evidence are materialized as graph edges.
const ENTITY_TYPES = new Set(['person', 'team', 'workflow', 'dataset', 'artifact', 'project', 'policy', 'concept']);
const PREDICATES = new Set(['owned_by', 'runs', 'consumes', 'produces', 'depends_on', 'part_of', 'assigned_to', 'informed_by', 'communicates_with']);
const SCOPES = new Set(['personal', 'organisation', 'client']);
const ID = /^[a-z][a-z0-9._:-]{1,127}$/;
const phrase = (pattern, cjk = '') => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])${cjk ? `|(?:${cjk})` : ''}`, 'iu');
const DISCOVERY_RULES = [
  { predicate: 'owned_by', targets: ['team', 'person'], phrase: phrase('owned by|owner is|belongs to|gerido por|responsável é|pertence a|所有者是|負責人是|负责人是') },
  { predicate: 'runs', targets: ['workflow'], phrase: phrase('runs|operates|executes|executa|opera|realiza', '執行|执行|運行|运行') },
  { predicate: 'consumes', targets: ['dataset', 'artifact'], phrase: phrase('consumes|uses|reads|takes in|consome|usa|utiliza|lê', '消耗|使用|讀取|读取') },
  { predicate: 'produces', targets: ['dataset', 'artifact'], phrase: phrase('produces|creates|outputs|generates|produz|cria|gera', '產生|产生|生成|輸出|输出') },
  { predicate: 'depends_on', targets: ['workflow', 'dataset', 'project'], phrase: phrase('depends on|requires|relies on|depende de|requer|necessita de', '依賴|依赖|需要') },
  { predicate: 'part_of', targets: ['team', 'project'], phrase: phrase('part of|belongs to|parte de|faz parte de', '屬於|属于') },
  { predicate: 'assigned_to', targets: ['person', 'team'], phrase: phrase('assigned to|atribuído a|atribuída a|designado a', '分配給|分配给|指派給|指派给') },
  { predicate: 'informed_by', targets: ['artifact', 'dataset', 'concept'], phrase: phrase('informed by|based on|derived from|informado por|com base em|derivado de|baseado em', '根據|根据|依據|依据') },
  { predicate: 'communicates_with', targets: ['person', 'team'], phrase: phrase('communicates with|talks to|coordinates with|hands off to|comunica com|fala com|coordena com|encaminha para', '(?:與|和)[^。！？.!?]{0,80}?(?:溝通|沟通|協作|协作|交接給|交接给)') },
];

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
    for (let relation_index = 0; relation_index < record.relations.length; relation_index++) {
      const relation = record.relations[relation_index];
      const target = byId.get(relation.target);
      if (target === undefined || target === source) continue;
      const targetMeta = records[target].meta;
      const confidenceText = relation.confidence || '';
      const confidence = Number(confidenceText);
      if (!PREDICATES.has(relation.predicate) || relation.review !== 'verified' || !relation.source ||
          relation.source.length > 300 || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(confidenceText) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || targetMeta.scope !== meta.scope) continue;
      edges.push({ source, target, relation_index, predicate: relation.predicate, evidence: relation.source, confidence });
    }
  }
  return edges;
}

// Suggestions are visible only after the caller has applied its vault and privacy filters.
// Targets must still be unique, current, visible records in the same Twin scope.
function deriveTypedRelationsWithReview(notes, reviewStatus) {
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
      if (target === undefined || target === source || !PREDICATES.has(relation.predicate) || relation.review !== reviewStatus ||
          !relation.source || relation.source.length > 300 || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(confidenceText) ||
          records[target].meta.scope !== meta.scope) return;
      proposals.push({ source, target, relation_index, predicate: relation.predicate, evidence: relation.source, confidence: Number(confidenceText) });
    });
  }
  return proposals;
}

export function deriveProposedTypedRelations(notes) { return deriveTypedRelationsWithReview(notes, 'proposed'); }
export function deriveRejectedTypedRelations(notes) { return deriveTypedRelationsWithReview(notes, 'rejected'); }

// Deterministic, review-only discovery. It reads only the already-authorized vault index passed
// by the caller, requires a typed current source and a unique same-scope target, and stores one
// short sentence as evidence. It never creates or verifies a relationship by itself.
export function discoverTypedRelationshipCandidates(notes, sourceIndex, { limit = 12 } = {}) {
  const sourceNote = notes[sourceIndex];
  if (!sourceNote || sourceNote.private || sourceNote.generated) return [];
  const sourceMeta = parseRecord(sourceNote.raw).meta;
  if (!ENTITY_TYPES.has(sourceMeta.type) || !ID.test(sourceMeta.id || '') || !SCOPES.has(sourceMeta.scope) || sourceMeta.status !== 'current') return [];
  const entities = typedEntityMetadataMap(notes);
  const body = String(sourceNote.body || '');
  if (entities.size > 5000 || body.length > 200_000) return [];
  const positions = new Map(notes.map((note, index) => [note, index]));
  if (!entities.has(sourceNote)) return [];
  const existing = new Set(parseRecord(sourceNote.raw).relations.map((r) => `${r.predicate}\0${r.target}`));
  const paragraphs = body.split(/\r?\n/).flatMap((line) => line.split(/(?<=[.!?])\s+/u));
  const found = new Map();
  for (const [targetNote, targetMeta] of entities) {
    if (targetNote === sourceNote || targetNote.private || targetNote.generated || targetMeta.scope !== sourceMeta.scope || !DISCOVERY_RULES.some((r) => r.targets.includes(targetMeta.type))) continue;
    const title = targetNote.title || pathTitle(targetNote.rel);
    if (!title) continue;
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mention = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(title)
      ? new RegExp(escaped, 'iu')
      : new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu');
    for (const sentence of paragraphs) {
      const evidence = sentence.trim().replace(/^[-*#>\s]+/, '').replace(/\s+/g, ' ');
      if (!evidence || evidence.length > 320 || !mention.test(evidence)) continue;
      for (const rule of DISCOVERY_RULES) {
        const key = `${rule.predicate}\0${targetMeta.entity_id}`;
        if (!rule.targets.includes(targetMeta.type) || existing.has(key) || found.has(key)) continue;
        const trigger = evidence.match(rule.phrase);
        if (!trigger) continue;
        const targetAt = evidence.search(mention);
        if (targetAt < trigger.index) continue;
        found.set(key, { target_id: targetMeta.entity_id, target_title: title, target_index: positions.get(targetNote), predicate: rule.predicate, evidence, confidence: 0.5 });
      }
    }
  }
  return [...found.values()].slice(0, Math.max(1, Math.min(30, Number(limit) || 12)));
}

function pathTitle(rel) { return String(rel || '').split(/[\\/]/).pop()?.replace(/\.md$/i, '') || ''; }

// Change only the selected review marker and (when needed) the source record's status.
// The caller must first revalidate the target and compare a content hash.
function resolveTypedRelation(raw, relationIndex, decision, expectedReview = 'proposed') {
  if (!Number.isInteger(relationIndex) || relationIndex < 0) throw new Error('Invalid relationship selection.');
  if (!['verified', 'rejected', 'proposed'].includes(decision) || !['proposed', 'verified', 'rejected'].includes(expectedReview)) throw new Error('Invalid relationship decision.');
  const match = String(raw || '').match(/^(\uFEFF?---[^\S\r\n]*\r?\n)([\s\S]*?)(\r?\n---[^\S\r\n]*(?:\r?\n|$))/);
  if (!match) throw new Error('This note has no valid frontmatter.');
  const lines = match[2].split(/\r?\n/);
  if (decision === 'verified') {
    const statusLine = lines.findIndex((line) => /^status:\s*["']?(?:proposed|current)["']?\s*$/.test(line));
    if (statusLine < 0) throw new Error('This record is not a reviewable typed entity.');
    if (/^status:\s*["']?proposed["']?\s*$/.test(lines[statusLine])) lines[statusLine] = 'status: current';
  }
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
  const reviewLine = lines.findIndex((line, i) => i > start && i < stop && new RegExp(`^\\s{4}review:\\s*["']?${expectedReview}["']?\\s*$`).test(line));
  if (reviewLine < 0) throw new Error('This relationship is no longer awaiting review.');
  lines[reviewLine] = `    review: ${decision}`;
  return `${match[1]}${lines.join(raw.includes('\r\n') ? '\r\n' : '\n')}${match[3]}${String(raw).slice(match[0].length)}`;
}

// Approval makes the proposed record current; rejection only records the decision and keeps
// the source, target, and evidence so the user can inspect or correct it later.
export function approveTypedRelation(raw, relationIndex) { return resolveTypedRelation(raw, relationIndex, 'verified'); }
export function rejectTypedRelation(raw, relationIndex) { return resolveTypedRelation(raw, relationIndex, 'rejected'); }
export function reopenTypedRelation(raw, relationIndex, expectedReview = 'verified') { return resolveTypedRelation(raw, relationIndex, 'proposed', expectedReview); }

export function appendTypedRelationProposal(raw, proposal) {
  if (!PREDICATES.has(proposal?.predicate) || !ID.test(String(proposal?.target_id || '')) ||
      typeof proposal?.evidence !== 'string' || !proposal.evidence.trim() || proposal.evidence.length > 320 ||
      !Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) throw new Error('Invalid relationship suggestion.');
  const parsed = parseRecord(raw);
  if (!ENTITY_TYPES.has(parsed.meta.type) || !ID.test(parsed.meta.id || '') || !SCOPES.has(parsed.meta.scope) || parsed.meta.status !== 'current') throw new Error('This typed record cannot receive a relationship suggestion.');
  if (parsed.relations.some((r) => r.predicate === proposal.predicate && r.target === proposal.target_id)) throw new Error('This relationship is already recorded.');
  const match = String(raw || '').match(/^(\uFEFF?---[^\S\r\n]*\r?\n)([\s\S]*?)(\r?\n---[^\S\r\n]*(?:\r?\n|$))/);
  if (!match) throw new Error('This note has no valid frontmatter.');
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = match[2].split(/\r?\n/);
  const section = lines.findIndex((line) => /^relations:\s*$/.test(line));
  const quote = (s) => JSON.stringify(String(s));
  const relationLines = [
    `  - predicate: ${proposal.predicate}`,
    `    target: ${proposal.target_id}`,
    '    review: proposed',
    `    source: ${quote(proposal.evidence.trim())}`,
    `    confidence: ${proposal.confidence}`,
  ];
  if (section < 0) lines.push('relations:', ...relationLines);
  else {
    let insert = section + 1;
    while (insert < lines.length && (/^\s{2}-\s+/.test(lines[insert]) || /^\s{4}[A-Za-z_][\w-]*:\s*/.test(lines[insert]) || !lines[insert].trim())) insert++;
    lines.splice(insert, 0, ...relationLines);
  }
  return `${match[1]}${lines.join(newline)}${match[3]}${String(raw).slice(match[0].length)}`;
}

export const TYPED_ENTITY_TYPES = [...ENTITY_TYPES];
export const TYPED_RELATION_PREDICATES = [...PREDICATES];
