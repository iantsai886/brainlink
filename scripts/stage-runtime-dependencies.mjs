#!/usr/bin/env node
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!destination) {
  console.error('Usage: node scripts/stage-runtime-dependencies.mjs DESTINATION_NODE_MODULES');
  process.exit(2);
}
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const packages = lock.packages || {};

function findPackage(name, from) {
  let current = from;
  while (current) {
    const candidate = `${current}/node_modules/${name}`;
    if (packages[candidate]) return candidate;
    const parentBoundary = current.lastIndexOf('/node_modules/');
    if (parentBoundary < 0) break;
    current = current.slice(0, parentBoundary);
  }
  const topLevel = `node_modules/${name}`;
  return packages[topLevel] ? topLevel : null;
}

const pending = Object.keys(packages['']?.dependencies || {})
  .filter((name) => !packages[`node_modules/${name}`]?.link)
  .map((name) => `node_modules/${name}`);
const visited = new Set();
while (pending.length) {
  const relative = pending.pop();
  if (visited.has(relative)) continue;
  const record = packages[relative];
  if (!record) throw new Error(`Runtime package is missing from package-lock.json: ${relative}`);
  visited.add(relative);
  for (const name of Object.keys(record.dependencies || {})) {
    const resolved = findPackage(name, relative);
    if (!resolved) throw new Error(`Locked runtime dependency cannot be resolved: ${name} from ${relative}`);
    pending.push(resolved);
  }
}

await mkdir(destination, { recursive: true });
for (const relative of [...visited].sort()) {
  const source = path.join(root, relative);
  const target = path.join(destination, relative.slice('node_modules/'.length));
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, dereference: true });
}
console.log(`Staged ${visited.size} locked runtime packages.`);
