import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSetupPage } from '../../src/setup-page.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function readSetupHtml() {
  return renderSetupPage(ROOT);
}
