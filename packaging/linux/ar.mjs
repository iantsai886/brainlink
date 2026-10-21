#!/usr/bin/env node
// Minimal Unix "ar" writer for .deb packages (macOS's ar only handles object files).
// Usage: node ar.mjs out.deb debian-binary control.tar.gz data.tar.gz
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
const [out, ...files] = process.argv.slice(2);
const field = (v, n) => String(v).padEnd(n, ' ').slice(0, n);
const parts = [Buffer.from('!<arch>\n')];
for (const f of files) {
  const data = readFileSync(f);
  const mtime = Math.floor(statSync(f).mtimeMs / 1000);
  const header = field(path.basename(f), 16) + field(mtime, 12) + field(0, 6) + field(0, 6) + field('100644', 8) + field(data.length, 10) + '`\n';
  parts.push(Buffer.from(header, 'ascii'), data);
  if (data.length % 2) parts.push(Buffer.from('\n'));
}
writeFileSync(out, Buffer.concat(parts));
