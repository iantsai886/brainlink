import { parentPort, workerData } from 'node:worker_threads';
import { parse } from 'parse5';

const MAX_HTML_CHARS = 24_000;
const MAX_HTML_NODES = 150_000;
const OMIT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'head', 'input', 'select', 'textarea', 'button', 'option']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden)\b/i;

function hidden(node) {
  return (node.attrs || []).some(({ name, value }) =>
    name === 'hidden' || (name === 'aria-hidden' && String(value).toLowerCase() === 'true') || (name === 'style' && HIDDEN_STYLE.test(value || ''))
  );
}

function findTag(root, tag) {
  const stack = [root];
  let visited = 0;
  while (stack.length) {
    const node = stack.pop();
    if (++visited > MAX_HTML_NODES) throw new Error('too_complex');
    if (node.tagName === tag) return node;
    if (node.tagName && ((OMIT.has(node.tagName) && !(tag === 'title' && node.tagName === 'head')) || hidden(node))) continue;
    const children = node.childNodes || [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return null;
}

function collectText(root, limit) {
  const parts = [];
  const stack = [{ node: root, end: false }];
  let length = 0, visited = 0, truncated = false;
  const append = (value) => {
    if (!value || length >= limit) { if (value) truncated = true; return; }
    const piece = value.slice(0, limit - length);
    parts.push(piece);
    length += piece.length;
    if (piece.length < value.length) truncated = true;
  };
  while (stack.length && length < limit) {
    const { node, end } = stack.pop();
    if (end) { append('\n'); continue; }
    if (++visited > MAX_HTML_NODES) { truncated = true; break; }
    if (node.nodeName === '#text') { append(node.value || ''); continue; }
    const tag = node.tagName;
    if (tag && (OMIT.has(tag) || hidden(node))) continue;
    if (tag === 'img') {
      const alt = node.attrs?.find((attr) => attr.name === 'alt')?.value;
      if (alt) append(alt);
    }
    const block = BLOCK.has(tag);
    if (block) append('\n');
    if (block) stack.push({ end: true });
    const children = node.childNodes || [];
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], end: false });
  }
  if (stack.length && length >= limit) truncated = true;
  const text = parts.join('').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text: text.slice(0, limit), truncated: truncated || text.length > limit };
}

try {
  const html = new TextDecoder('utf-8', { fatal: true }).decode(workerData).replace(/^\uFEFF/, '');
  const document = parse(html);
  const titleResult = findTag(document, 'title');
  const title = titleResult ? collectText(titleResult, 500) : { text: '', truncated: false };
  const bodyNode = findTag(document, 'body') || document;
  const bodyLimit = Math.max(1, MAX_HTML_CHARS - (title.text ? title.text.length + 2 : 0));
  const body = collectText(bodyNode, bodyLimit);
  const text = [title.text, body.text].filter(Boolean).join('\n\n').slice(0, MAX_HTML_CHARS);
  parentPort.postMessage({ ok: Boolean(text.trim()), reason: text.trim() ? undefined : 'no_text', text, truncated: body.truncated || title.truncated });
} catch (error) {
  parentPort.postMessage({ ok: false, reason: error?.message === 'too_complex' ? 'too_complex' : 'invalid_html' });
}
