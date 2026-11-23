import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DESTINATION_PARTS = Object.freeze([
  'find/ask.html',
  'find/brain.html',
  'review/memory.html',
  'review/proposals.html',
  'review/decisions.html',
  'review/conflicts.html',
  'review/tidy.html',
  'review/sessions.html',
  'review/ingestion.html',
  'home/handoffs.html',
]);

export async function renderSetupPage(root) {
  const uiRoot = path.join(root, 'ui');
  let page = await readFile(path.join(uiRoot, 'index.html'), 'utf8');
  const parts = await Promise.all(DESTINATION_PARTS.map(async (relative) => [
    relative,
    await readFile(path.join(uiRoot, 'destinations', relative), 'utf8'),
  ]));
  for (const [relative, content] of parts) {
    const marker = `<!-- brainlink-include:${relative} -->`;
    if (!page.includes(marker)) throw new Error(`Setup page is missing destination ${relative}.`);
    page = page.replace(marker, content);
  }
  if (/<!-- brainlink-include:/.test(page)) throw new Error('Setup page contains an unresolved destination.');
  return page;
}
