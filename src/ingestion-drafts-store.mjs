// Private, local-only persistence for unverified Raw-to-Wiki drafts. Original source text is not stored.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ID_RE = /^[a-f0-9]{64}$/;
const SOURCE_EXTENSIONS = new Set(['.md', '.txt', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log', '.html', '.htm', '.pdf', '.docx', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg', '.bmp']);

export function ingestionDraftId(draft) {
  return createHash('sha256').update(`${draft.vault}\0${draft.source_id}\0${draft.revision}`).digest('hex');
}

function fileFor(dir, id) {
  if (!ID_RE.test(id || '')) throw new Error('Invalid local draft reference.');
  return path.join(dir, `${id}.json`);
}

function validRecord(record, id) {
  const draft = record?.draft;
  return record?.schema === 1 && record.id === id && record.status === 'pending'
    && draft && draft.status === 'unverified_draft' && draft.source_id && ID_RE.test(draft.source_id)
    && ID_RE.test(draft.revision) && record.id === ingestionDraftId(draft)
    && typeof draft.vault === 'string' && draft.vault.length > 0 && draft.vault.length <= 200
    && typeof draft.folder === 'string' && safeFolder(draft.folder)
    && typeof draft.source_path === 'string' && safeSourcePath(draft.source_path)
    && typeof draft.title === 'string' && draft.title.length > 0 && draft.title.length <= 120
    && typeof draft.summary === 'string' && draft.summary.length > 0 && draft.summary.length <= 2400
    && typeof draft.body === 'string' && draft.body.length <= 12_000
    && ['working', 'semantic', 'procedural', 'episodic'].includes(draft.memory_type)
    && (draft.entities === undefined || (Array.isArray(draft.entities) && draft.entities.length <= 8 && draft.entities.every((item) => item
      && ['person', 'team', 'workflow', 'dataset', 'artifact', 'project', 'policy', 'concept'].includes(item.type)
      && typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 100
      && typeof item.description === 'string' && item.description.length > 0 && item.description.length <= 500
      && typeof item.evidence === 'string' && item.evidence.length > 0 && item.evidence.length <= 240)))
    && (draft.relationships === undefined || (Array.isArray(draft.relationships) && draft.relationships.length <= 12 && draft.relationships.every((item) => item
      && typeof item.subject_id === 'string' && item.subject_id.length <= 128 && typeof item.subject_title === 'string' && item.subject_title.length <= 160
      && ['owned_by', 'runs', 'consumes', 'produces', 'depends_on', 'part_of', 'assigned_to', 'informed_by', 'communicates_with'].includes(item.predicate)
      && typeof item.target_id === 'string' && item.target_id.length <= 128 && typeof item.target_title === 'string' && item.target_title.length <= 160
      && ['personal', 'organisation', 'client'].includes(item.scope)
      && typeof item.evidence === 'string' && item.evidence.length > 0 && item.evidence.length <= 240)))
    && (draft.related_basis === undefined || draft.related_basis === 'source_and_draft')
    && (draft.related_notes === undefined || (Array.isArray(draft.related_notes) && draft.related_notes.length <= 8 && draft.related_notes.every((item) => item
      && safeNotePath(item.path) && !/[\[\]]/.test(item.path)
      && typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 160
      && Array.isArray(item.shared_terms) && item.shared_terms.length <= 6 && item.shared_terms.every((term) => typeof term === 'string' && term.length <= 50)
      && Number.isFinite(item.score) && item.score >= 0 && item.score <= 1)))
    && Array.isArray(draft.destinations) && draft.destinations.length <= 500 && draft.destinations.every(safeFolder)
    && (record.filing === undefined || validFiling(record.filing, draft));
}

function validFiling(filing, draft) {
  const validIndexes = (values, max) => Array.isArray(values) && values.length <= max
    && values.every((value) => Number.isSafeInteger(value) && value >= 0 && value < max)
    && new Set(values).size === values.length;
  return filing && typeof filing === 'object'
    && safeFolder(filing.destination) && draft.destinations.includes(filing.destination)
    && safeNotePath(filing.note_path)
    && Array.isArray(filing.related_paths) && filing.related_paths.length <= 5 && filing.related_paths.every(safeNotePath)
    && new Set(filing.related_paths).size === filing.related_paths.length
    && Array.isArray(filing.entity_choices) && filing.entity_choices.length <= 8 && filing.entity_choices.every((item) => item
      && Number.isSafeInteger(item.index) && item.index >= 0 && item.index < (draft.entities || []).length
      && ['personal', 'organisation', 'client'].includes(item.scope))
    && new Set(filing.entity_choices.map((item) => item.index)).size === filing.entity_choices.length
    && validIndexes(filing.relationship_indexes, (draft.relationships || []).length)
    && validIndexes(filing.saved_entities, (draft.entities || []).length)
    && validIndexes(filing.saved_relationships, (draft.relationships || []).length)
    && filing.saved_entities.every((index) => filing.entity_choices.some((item) => item.index === index))
    && filing.saved_relationships.every((index) => filing.relationship_indexes.includes(index));
}

function safeFolder(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && !value.includes('\\')
    && value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.'));
}

function safeNotePath(value) { return safeFolder(value) && /\.md$/i.test(value); }
function safeSourcePath(value) { return safeFolder(value) && SOURCE_EXTENSIONS.has(path.posix.extname(value).toLowerCase()); }

export async function saveIngestionDraft(dir, draft) {
  const id = ingestionDraftId(draft), file = fileFor(dir, id);
  const record = { schema: 1, id, status: 'pending', created_at: draft.generated_at, draft };
  if (!validRecord(record, id)) throw new Error('The local knowledge draft is invalid.');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    try { await rename(temp, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await unlink(temp).catch(() => {});
    }
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return record;
}

export async function readIngestionDraft(dir, id) {
  const file = fileFor(dir, id);
  try {
    const record = JSON.parse(await readFile(file, 'utf8'));
    return validRecord(record, id) ? record : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function updateIngestionDraftFiling(dir, id, filing) {
  const file = fileFor(dir, id);
  const current = await readIngestionDraft(dir, id);
  if (!current) throw new Error('This local knowledge draft is missing or damaged. Prepare it again from the source queue.');
  const next = { ...current, filing };
  if (!validRecord(next, id)) throw new Error('The local filing recovery record is invalid.');
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return next;
}

export async function listIngestionDrafts(dir, { limit = 100 } = {}) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 100));
  const names = await readdir(dir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const records = [];
  for (const name of names.filter((item) => /^[a-f0-9]{64}\.json$/.test(item)).slice(0, 1000)) {
    const id = name.slice(0, 64);
    const record = await readIngestionDraft(dir, id).catch(() => null);
    if (record) records.push(record);
  }
  return records.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, cap);
}

export async function removeIngestionDraft(dir, id) {
  await unlink(fileFor(dir, id)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}
