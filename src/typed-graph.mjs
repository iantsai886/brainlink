// Small, fail-closed typed relationship layer for Markdown knowledge records.
// Only explicitly verified relations with valid evidence are materialized as graph edges.
const ENTITY_TYPES = new Set(['person', 'team', 'workflow', 'dataset', 'artifact', 'project', 'policy', 'concept']);
const PREDICATES = new Set(['owned_by', 'runs', 'consumes', 'produces', 'depends_on', 'part_of', 'assigned_to', 'informed_by', 'communicates_with']);
const SCOPES = new Set(['personal', 'organisation', 'client']);
const ID = /^[a-z][a-z0-9._:-]{1,127}$/;
const phrase = (pattern, cjk = '') => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])${cjk ? `|(?:${cjk})` : ''}`, 'iu');
const DISCOVERY_RULES = [
  { predicate: 'owned_by', sources: ['team', 'workflow', 'dataset', 'artifact', 'project', 'policy', 'concept'], targets: ['team', 'person'], phrase: phrase('owned by|owner is|gerido por|responsável é|所有者是|負責人是|负责人是') },
  { predicate: 'runs', sources: ['team', 'person', 'project', 'workflow'], targets: ['workflow'], phrase: phrase('runs|operates|executes|executa|opera|realiza', '執行|执行|運行|运行') },
  { predicate: 'consumes', sources: ['workflow'], targets: ['dataset', 'artifact'], phrase: phrase('consumes|uses|reads|takes in|consome|usa|utiliza|lê', '消耗|使用|讀取|读取') },
  { predicate: 'produces', sources: ['workflow'], targets: ['dataset', 'artifact'], phrase: phrase('produces|creates|outputs|generates|produz|cria|gera', '產生|产生|生成|輸出|输出') },
  { predicate: 'depends_on', sources: ['team', 'workflow', 'dataset', 'artifact', 'project', 'policy', 'concept'], targets: ['workflow', 'dataset', 'project'], phrase: phrase('depends on|requires|relies on|depende de|requer|necessita de', '依賴|依赖|需要') },
  // Membership phrases are kept distinct from explicit ownership phrases above. Treating
  // "belongs to" / "pertence a" as both predicates used to create two conflicting edges.
  { predicate: 'part_of', sources: ['person', 'team', 'workflow', 'dataset', 'artifact', 'project', 'policy', 'concept'], targets: ['team', 'project'], phrase: phrase('part of|belongs to|pertence a|parte de|faz parte de', '屬於|属于') },
  { predicate: 'assigned_to', sources: ['workflow', 'artifact', 'project'], targets: ['person', 'team'], phrase: phrase('assigned to|atribuído a|atribuída a|designado a', '分配給|分配给|指派給|指派给') },
  { predicate: 'informed_by', sources: ['team', 'workflow', 'project', 'policy', 'concept'], targets: ['artifact', 'dataset', 'concept'], phrase: phrase('informed by|based on|derived from|informado por|com base em|derivado de|baseado em', '根據|根据|依據|依据') },
  { predicate: 'communicates_with', sources: ['person', 'team', 'workflow'], targets: ['person', 'team'], phrase: phrase('communicates with|talks to|coordinates with|hands off to|comunica com|fala com|coordena com|encaminha para', '(?:與|和)[^。！？.!?]{0,80}?(?:溝通|沟通|協作|协作|交接給|交接给)') },
];
const PREDICATE_TARGET_TYPES = new Map(DISCOVERY_RULES.map((rule) => [rule.predicate, new Set(rule.targets)]));
const PREDICATE_SOURCE_TYPES = new Map(DISCOVERY_RULES.map((rule) => [rule.predicate, new Set(rule.sources)]));

export function typedRelationTargetAllowed(predicate, targetType) {
  return PREDICATE_TARGET_TYPES.get(predicate)?.has(targetType) === true;
}

export function typedRelationSourceAllowed(predicate, sourceType) {
  return PREDICATE_SOURCE_TYPES.get(predicate)?.has(sourceType) === true;
}

export function typedRelationAllowed(predicate, sourceType, targetType) {
  return typedRelationSourceAllowed(predicate, sourceType) && typedRelationTargetAllowed(predicate, targetType);
}

function scalar(value) {
  const s = String(value || '').trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { const parsed = JSON.parse(s); if (typeof parsed === 'string') return parsed.trim(); } catch {}
    return s.slice(1, -1).trim();
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).trim();
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

export function typedEntityFields(raw) {
  const { meta } = parseRecord(raw);
  const fields = {};
  for (const key of ['type','id','scope','status']) if (typeof meta[key] === 'string' && meta[key].length <= 160) fields[key] = meta[key];
  return fields;
}

export function updateTypedEntityFields(raw, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Graph record fields are required.');
  const fields = Object.fromEntries(['type','id','scope','status'].map((key) => [key, String(input[key] ?? '').trim()]));
  const present = Object.values(fields).filter(Boolean).length;
  if (present === 0) {
    const match = String(raw).match(/^(\uFEFF?---[^\S\r\n]*\r?\n)([\s\S]*?)(\r?\n---[^\S\r\n]*(?:\r?\n|$))/);
    if (!match) return String(raw);
    const lines = match[2].split(/\r?\n/).filter((line) => !/^(?:type|id|scope|status):\s*/.test(line));
    return `${match[1]}${lines.join(raw.includes('\r\n') ? '\r\n' : '\n')}${match[3]}${String(raw).slice(match[0].length)}`;
  }
  if (present !== 4) throw new Error('Set type, ID, scope, and status together, or clear all four fields.');
  if (!ENTITY_TYPES.has(fields.type)) throw new Error('Choose a supported graph record type.');
  if (!ID.test(fields.id)) throw new Error('Graph IDs must start with a lowercase letter and use only lowercase letters, numbers, dot, underscore, colon, or hyphen.');
  if (!SCOPES.has(fields.scope)) throw new Error('Choose a supported graph data scope.');
  if (!['proposed','current','archived'].includes(fields.status)) throw new Error('Choose a supported graph record status.');
  const source = String(raw || '');
  const match = source.match(/^(\uFEFF?---[^\S\r\n]*\r?\n)([\s\S]*?)(\r?\n---[^\S\r\n]*(?:\r?\n|$))/);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let lines, prefix, suffix;
  if (match) { lines = match[2].split(/\r?\n/); prefix = match[1]; suffix = match[3] + source.slice(match[0].length); }
  else { lines = []; prefix = `---${newline}`; suffix = `${newline}---${newline}${source}`; }
  for (const key of ['type','id','scope','status']) {
    const indexes = lines.flatMap((line, index) => new RegExp(`^${key}:\\s*`).test(line) ? [index] : []);
    if (indexes.length > 1) throw new Error(`This note has duplicate ${key} frontmatter fields. Fix them in the note before editing its graph record.`);
    if (indexes.length) lines[indexes[0]] = `${key}: ${fields[key]}`;
    else lines.push(`${key}: ${fields[key]}`);
  }
  return `${prefix}${lines.join(newline)}${suffix}`;
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
      if (!typedRelationAllowed(relation.predicate, meta.type, targetMeta.type) || relation.review !== 'verified' || !relation.source ||
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
      if (target === undefined || target === source || !typedRelationAllowed(relation.predicate, meta.type, records[target].meta.type) || relation.review !== reviewStatus ||
          !relation.source || relation.source.length > 300 || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(confidenceText) ||
          records[target].meta.scope !== meta.scope) return;
      proposals.push({ source, target, relation_index, predicate: relation.predicate, evidence: relation.source, confidence: Number(confidenceText) });
    });
  }
  return proposals;
}

export function deriveProposedTypedRelations(notes) { return deriveTypedRelationsWithReview(notes, 'proposed'); }
export function deriveRejectedTypedRelations(notes) { return deriveTypedRelationsWithReview(notes, 'rejected'); }
export function deriveWithdrawnTypedRelations(notes) { return deriveTypedRelationsWithReview(notes, 'withdrawn'); }

// Privacy-safe structural counts for RSI. Only aggregate numbers leave this function: no note
// titles, IDs, evidence, paths, or relation text. Private/generated notes cannot affect totals.
export function typedGraphHealth(notes) {
  const records = (Array.isArray(notes) ? notes : [])
    .filter((note) => note && !note.private && !note.generated)
    .map((note) => ({ note, ...parseRecord(note.raw) }));
  const isEntity = ({ meta }) => ENTITY_TYPES.has(meta.type) && ID.test(meta.id || '')
    && SCOPES.has(meta.scope) && ['current', 'proposed'].includes(meta.status);
  const typed = records.filter(isEntity);
  const currentById = new Map();
  const duplicateIds = new Set();
  for (const record of typed) {
    if (record.meta.status !== 'current') continue;
    const id = record.meta.id;
    if (currentById.has(id)) { currentById.delete(id); duplicateIds.add(id); }
    else if (!duplicateIds.has(id)) currentById.set(id, record);
  }

  let verified = 0, proposed = 0, unresolved = 0;
  for (const source of typed) {
    for (const relation of source.relations) {
      if (!['verified', 'proposed'].includes(relation.review)) continue;
      const target = currentById.get(relation.target);
      const confidenceText = relation.confidence || '';
      const confidence = Number(confidenceText);
      const validEvidence = Boolean(relation.source) && relation.source.length <= 300
        && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(confidenceText)
        && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
      const resolves = ENTITY_TYPES.has(source.meta.type) && source.meta.status === 'current'
        && typedRelationAllowed(relation.predicate, source.meta.type, target?.meta.type) && validEvidence && target
        && target.note !== source.note && target.meta.scope === source.meta.scope;
      if (!resolves) { unresolved++; continue; }
      if (relation.review === 'verified') verified++;
      else proposed++;
    }
  }
  return {
    typed_entity_count: typed.filter(({ meta }) => meta.status === 'current').length,
    verified_typed_relation_count: verified,
    proposed_typed_relation_count: proposed,
    unresolved_typed_relation_count: unresolved,
    duplicate_typed_id_count: duplicateIds.size,
  };
}

// Deterministic, review-only discovery. It reads only the already-authorized vault index passed
// by the caller, requires a typed current source and a unique same-scope target, and stores one
// short sentence as evidence. It never creates or verifies a relationship by itself.
export function discoverTypedRelationshipCandidates(notes, sourceIndex, { limit = 12 } = {}) {
  const entities = typedEntityMetadataMap(notes);
  if (entities.size > 5000) return [];
  const positions = new Map(notes.map((note, index) => [note, index]));
  return discoverCandidatesWithIndex(notes, sourceIndex, entities, positions, limit);
}

// Same deterministic rules as the single-source helper, but builds the vault-wide entity and
// position indexes once for a page of sources instead of once for every note in that page.
export function discoverTypedRelationshipCandidatesForSources(notes, sourceIndices, { limit = 12 } = {}) {
  const results = new Map();
  const entities = typedEntityMetadataMap(notes);
  if (entities.size > 5000) return results;
  const positions = new Map(notes.map((note, index) => [note, index]));
  for (const sourceIndex of sourceIndices) results.set(sourceIndex, discoverCandidatesWithIndex(notes, sourceIndex, entities, positions, limit));
  return results;
}

function discoverCandidatesWithIndex(notes, sourceIndex, entities, positions, limit) {
  const sourceNote = notes[sourceIndex];
  if (!sourceNote || sourceNote.private || sourceNote.generated) return [];
  const sourceMeta = parseRecord(sourceNote.raw).meta;
  if (!ENTITY_TYPES.has(sourceMeta.type) || !ID.test(sourceMeta.id || '') || !SCOPES.has(sourceMeta.scope) || sourceMeta.status !== 'current') return [];
  const body = String(sourceNote.body || '');
  if (entities.size > 5000 || body.length > 200_000) return [];
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
        if (!rule.sources.includes(sourceMeta.type) || !rule.targets.includes(targetMeta.type) || existing.has(key) || found.has(key)) continue;
        const trigger = evidence.match(rule.phrase);
        if (!trigger) continue;
        if (isNegatedRelation(evidence, trigger.index)) continue;
        const targetAt = evidence.search(mention);
        if (targetAt < trigger.index) continue;
        const interveningRelation = DISCOVERY_RULES.some((other) => {
          const next = evidence.slice(trigger.index + trigger[0].length).match(other.phrase);
          return next && trigger.index + trigger[0].length + next.index < targetAt;
        });
        if (interveningRelation) continue;
        found.set(key, { target_id: targetMeta.entity_id, target_title: title, target_index: positions.get(targetNote), predicate: rule.predicate, evidence, confidence: 0.5 });
      }
    }
  }
  return [...found.values()].slice(0, Math.max(1, Math.min(30, Number(limit) || 12)));
}

// The phrase matcher is intentionally small, but it must not turn an explicit denial into
// a proposed edge. This checks a short window immediately before the relation verb; it is not
// a general-purpose language or sentiment model, so complex clauses still need human review.
function isNegatedRelation(sentence, triggerIndex) {
  const prefix = sentence.slice(Math.max(0, triggerIndex - 64), triggerIndex);
  if (/\bnot\s+only\s+$/iu.test(prefix)) return false;
  return /(?:^|[^\p{L}\p{N}_])(?:not|never|cannot|can't|doesn't|don't|didn't|não|nunca|sem)(?:\s+[\p{L}]+){0,2}\s*$/iu.test(prefix) ||
    /(?:不|未|沒|没|無|无)$/u.test(prefix);
}

function pathTitle(rel) { return String(rel || '').split(/[\\/]/).pop()?.replace(/\.md$/i, '') || ''; }

// Change only the selected review marker and (when needed) the source record's status.
// The caller must first revalidate the target and compare a content hash.
function resolveTypedRelation(raw, relationIndex, decision, expectedReview = 'proposed') {
  if (!Number.isInteger(relationIndex) || relationIndex < 0) throw new Error('Invalid relationship selection.');
  if (!['verified', 'rejected', 'proposed', 'withdrawn'].includes(decision) || !['proposed', 'verified', 'rejected', 'withdrawn'].includes(expectedReview)) throw new Error('Invalid relationship decision.');
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
export function withdrawTypedRelation(raw, relationIndex, expectedReview) { return resolveTypedRelation(raw, relationIndex, 'withdrawn', expectedReview); }

export function updateTypedRelation(raw, relationIndex, input, expectedReview) {
  if (!Number.isInteger(relationIndex) || relationIndex < 0 || !['verified', 'proposed', 'rejected'].includes(expectedReview)) throw new Error('Invalid relationship selection.');
  const predicate = String(input?.predicate || '').trim();
  const target = String(input?.target_id || '').trim();
  const evidence = String(input?.evidence || '').trim();
  const confidenceText = String(input?.confidence ?? '').trim();
  const confidence = Number(confidenceText);
  if (!PREDICATES.has(predicate) || !ID.test(target) || !evidence || evidence.length > 300 || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(confidenceText) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Enter a valid relationship, target, evidence excerpt, and confidence from 0 to 1.');
  const source = String(raw || '');
  const match = source.match(/^(\uFEFF?---[^\S\r\n]*\r?\n)([\s\S]*?)(\r?\n---[^\S\r\n]*(?:\r?\n|$))/);
  if (!match) throw new Error('This note has no valid frontmatter.');
  const lines = match[2].split(/\r?\n/);
  if (lines.filter((line) => /^type:\s*/.test(line)).length !== 1) throw new Error('This record must have one valid type field before its relationship can be edited.');
  const sourceType = typedEntityFields(source).type;
  if (!typedRelationSourceAllowed(predicate, sourceType)) throw new Error('This relationship type is not allowed for this record type.');
  const section = lines.findIndex((line) => /^relations:\s*$/.test(line));
  if (section < 0) throw new Error('This note has no relationships to edit.');
  const starts = [];
  for (let i = section + 1; i < lines.length && !/^[A-Za-z_][\w-]*:\s*/.test(lines[i]); i++) if (/^\s{2}-\s+/.test(lines[i])) starts.push(i);
  const start = starts[relationIndex];
  if (start === undefined) throw new Error('The selected relationship no longer exists.');
  const nextStart = starts[relationIndex + 1];
  const nextField = lines.findIndex((line, i) => i > start && /^[A-Za-z_][\w-]*:\s*/.test(line));
  const end = nextStart ?? (nextField < 0 ? lines.length : nextField);
  const block = lines.slice(start, end);
  const reviewLine = block.findIndex((line, i) => i > 0 && /^\s{4}review:\s*/.test(line));
  if (reviewLine < 0 || scalar(block[reviewLine].replace(/^\s{4}review:\s*/, '')) !== expectedReview) throw new Error('This relationship is no longer active.');
  const current = parseRecord(source).relations[relationIndex];
  if (!current || parseRecord(source).relations.some((relation, i) => i !== relationIndex && relation.predicate === predicate && relation.target === target)) throw new Error('This relationship would duplicate another saved connection.');
  const changed = current.predicate !== predicate || current.target !== target || current.source !== evidence || Number(current.confidence) !== confidence;
  block[0] = `  - predicate: ${predicate}`;
  const values = { target, source: JSON.stringify(evidence), confidence: String(confidence) };
  for (const key of Object.keys(values)) {
    if (block.filter((line, i) => i > 0 && new RegExp(`^\\s{4}${key}:\\s*`).test(line)).length > 1) throw new Error(`This relationship has duplicate ${key} fields. Fix it in the note before editing.`);
    const at = block.findIndex((line, i) => i > 0 && new RegExp(`^\\s{4}${key}:\\s*`).test(line));
    const line = `    ${key}: ${values[key]}`;
    if (at < 0) block.push(line); else block[at] = line;
  }
  if (changed) block[reviewLine] = '    review: proposed';
  lines.splice(start, end - start, ...block);
  return `${match[1]}${lines.join(source.includes('\r\n') ? '\r\n' : '\n')}${match[3]}${source.slice(match[0].length)}`;
}

export function appendTypedRelationProposal(raw, proposal) {
  if (!PREDICATES.has(proposal?.predicate) || !ID.test(String(proposal?.target_id || '')) ||
      typeof proposal?.evidence !== 'string' || !proposal.evidence.trim() || proposal.evidence.length > 320 ||
      !Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) throw new Error('Invalid relationship suggestion.');
  const parsed = parseRecord(raw);
  if (!ENTITY_TYPES.has(parsed.meta.type) || !ID.test(parsed.meta.id || '') || !SCOPES.has(parsed.meta.scope) || parsed.meta.status !== 'current' || !typedRelationSourceAllowed(proposal.predicate, parsed.meta.type)) throw new Error('This typed record cannot receive this kind of relationship suggestion.');
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
export const TYPED_RELATION_SOURCE_TYPES = Object.fromEntries([...PREDICATE_SOURCE_TYPES].map(([predicate, types]) => [predicate, [...types]]));
