import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { unzipSync } from 'fflate';

const MAX_CHARS = 24_000;
const MAX_PART_BYTES = 20 * 1024 * 1024;
const PREFIX = '(?:[A-Za-z_][\\w.-]*:)?';

function safeXml(bytes) {
  if (!bytes || bytes.length > MAX_PART_BYTES) throw new Error('invalid');
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('invalid');
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

function decodeXml(value) {
  const input = String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const decoded = input.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (match, entity) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error('invalid');
    return String.fromCodePoint(code);
  });
  if (/&[^;\s]{1,80};/.test(decoded)) throw new Error('invalid');
  return decoded;
}

function getAttribute(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(attributes || '').match(new RegExp(`(?:^|\\s)(?:[A-Za-z_][\\w.-]*:)?${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'u'));
  return match ? decodeXml(match[1] ?? match[2]) : '';
}

function getQualifiedAttribute(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(attributes || '').match(new RegExp(`(?:^|\\s)[A-Za-z_][\\w.-]*:${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'u'));
  return match ? decodeXml(match[1] ?? match[2]) : '';
}

function eachElement(xml, name) {
  const open = new RegExp(`<${PREFIX}${name}\\b([^>]*)>([\\s\\S]*?)<\\/${PREFIX}${name}\\s*>`, 'giu');
  const empty = new RegExp(`<${PREFIX}${name}\\b([^>]*)\\/>`, 'giu');
  const results = [];
  for (const match of xml.matchAll(open)) results.push({ attributes: match[1], body: match[2] });
  for (const match of xml.matchAll(empty)) results.push({ attributes: match[1], body: '' });
  return results;
}

function textRuns(xml) {
  return eachElement(xml, 't').map(({ body }) => decodeXml(body)).join('');
}

function resolvePackagePart(base, target) {
  return path.posix.normalize(target.startsWith('/') ? target.replace(/^\/+/, '') : path.posix.join(base, target));
}

function boundedOutput(chunks) {
  let text = '';
  for (const chunk of chunks) {
    const value = String(chunk || '');
    const remaining = MAX_CHARS - text.length;
    if (remaining <= 0) return { text: text.trim(), truncated: true };
    text += value.slice(0, remaining);
    if (value.length > remaining) return { text: text.trim(), truncated: true };
  }
  return { text: text.trim(), truncated: false };
}

function extractSlides(parts) {
  const presentation = safeXml(parts['ppt/presentation.xml']);
  const rels = safeXml(parts['ppt/_rels/presentation.xml.rels']);
  const relationships = new Map(eachElement(rels, 'Relationship').map(({ attributes }) => [getAttribute(attributes, 'Id'), {
    target: getAttribute(attributes, 'Target'), type: getAttribute(attributes, 'Type'), mode: getAttribute(attributes, 'TargetMode'),
  }]));
  const slideRefs = eachElement(presentation, 'sldId').filter(({ attributes }) => !/^(?:0|false)$/iu.test(getAttribute(attributes, 'show')));
  if (!slideRefs.length || slideRefs.length > 500) throw new Error('invalid');
  const output = [];
  for (let index = 0; index < slideRefs.length; index++) {
    const rid = getQualifiedAttribute(slideRefs[index].attributes, 'id');
    const relationship = relationships.get(rid);
    const target = relationship?.target;
    if (!target || relationship.mode || !relationship.type.endsWith('/slide') || target.includes(':') || target.includes('\\')) throw new Error('invalid');
    const rel = resolvePackagePart('ppt', target);
    if (!/^ppt\/slides\/slide\d+\.xml$/u.test(rel) || !parts[rel]) throw new Error('invalid');
    const slide = safeXml(parts[rel]);
    const paragraphs = eachElement(slide, 'p').map(({ body }) => textRuns(body)).filter(Boolean);
    if (paragraphs.length) output.push(`Slide ${index + 1}\n${paragraphs.join('\n')}\n`);
  }
  const result = boundedOutput(output);
  if (!result.text) throw new Error('no_text');
  return result;
}

function columnNumber(reference) {
  const letters = String(reference || '').match(/^[A-Z]+/iu)?.[0]?.toUpperCase() || '';
  let value = 0;
  for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}

function extractWorkbook(parts) {
  const workbook = safeXml(parts['xl/workbook.xml']);
  const rels = safeXml(parts['xl/_rels/workbook.xml.rels']);
  const relationships = new Map(eachElement(rels, 'Relationship').map(({ attributes }) => [getAttribute(attributes, 'Id'), {
    target: getAttribute(attributes, 'Target'), type: getAttribute(attributes, 'Type'), mode: getAttribute(attributes, 'TargetMode'),
  }]));
  const sheets = eachElement(workbook, 'sheet').filter(({ attributes }) => !getAttribute(attributes, 'state') || getAttribute(attributes, 'state') === 'visible');
  if (!sheets.length || sheets.length > 256) throw new Error('invalid');
  const sharedStrings = parts['xl/sharedStrings.xml']
    ? eachElement(safeXml(parts['xl/sharedStrings.xml']), 'si').map(({ body }) => textRuns(body)) : [];
  const hiddenColumns = new Map();
  for (const [rel, bytes] of Object.entries(parts)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/u.test(rel)) continue;
    const xml = safeXml(bytes);
    const hidden = [];
    for (const { attributes } of eachElement(xml, 'col')) {
      if (!/^(?:1|true)$/iu.test(getAttribute(attributes, 'hidden'))) continue;
      const min = Number(getAttribute(attributes, 'min')), max = Number(getAttribute(attributes, 'max'));
      if (Number.isInteger(min) && Number.isInteger(max) && min > 0 && max >= min) hidden.push([min, max]);
    }
    hiddenColumns.set(rel, hidden);
  }
  const output = [];
  for (const { attributes } of sheets) {
    const name = getAttribute(attributes, 'name');
    const rid = getAttribute(attributes, 'id');
    const relationship = relationships.get(rid);
    if (!name || !relationship || relationship.mode || !relationship.type.endsWith('/worksheet') || !relationship.target || relationship.target.includes(':') || relationship.target.includes('\\')) continue;
    const rel = resolvePackagePart('xl', relationship.target);
    if (!/^xl\/worksheets\/sheet\d+\.xml$/u.test(rel) || !parts[rel]) continue;
    const xml = safeXml(parts[rel]);
    const hidden = hiddenColumns.get(rel) || [];
    const rowBlocks = eachElement(xml, 'row').slice(0, 100_000);
    output.push(`Sheet: ${name}\n`);
    for (const row of rowBlocks) {
      if (/^(?:1|true)$/iu.test(getAttribute(row.attributes, 'hidden'))) continue;
      const cells = eachElement(row.body, 'c').map(({ attributes, body }) => {
        const address = getAttribute(attributes, 'r');
        const col = columnNumber(address);
        if (!address || hidden.some(([min, max]) => col >= min && col <= max)) return '';
        const type = getAttribute(attributes, 't');
        const value = eachElement(body, 'v')[0]?.body;
        if (type === 'inlineStr') return `${address}=${textRuns(body)}`;
        if (value === undefined) return '';
        const decoded = decodeXml(value);
        if (type === 's') {
          const index = Number(decoded);
          return Number.isInteger(index) && index >= 0 && index < sharedStrings.length ? `${address}=${sharedStrings[index]}` : '';
        }
        if (type === 'str' || type === 'b' || !type) return `${address}=${decoded}`;
        return '';
      }).filter(Boolean);
      if (cells.length) output.push(`${cells.join(' | ')}\n`);
    }
  }
  const result = boundedOutput(output);
  if (!result.text) throw new Error('no_text');
  return result;
}

try {
  const kind = workerData?.kind;
  if (!['xlsx', 'pptx'].includes(kind) || !(workerData.data instanceof Uint8Array)) throw new Error('invalid');
  const wanted = new Set(kind === 'xlsx'
    ? ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml']
    : ['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels']);
  const packageParts = unzipSync(workerData.data, { filter: (entry) => wanted.has(entry.name) || (kind === 'xlsx' ? /^xl\/worksheets\/sheet\d+\.xml$/u.test(entry.name) : /^ppt\/slides\/slide\d+\.xml$/u.test(entry.name)) });
  const result = kind === 'xlsx' ? extractWorkbook(packageParts) : extractSlides(packageParts);
  parentPort.postMessage({ ok: true, ...result });
} catch (error) {
  parentPort.postMessage({ ok: false, reason: error?.message === 'no_text' ? 'no_text' : 'invalid' });
}
