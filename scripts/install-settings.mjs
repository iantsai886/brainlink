#!/usr/bin/env node
// CLI wrapper around src/install-settings.mjs (dry-run by default; --apply to write).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHomeVars, mergeSettingsAdditive, installSettings } from '../src/install-settings.mjs';

export { expandHomeVars, mergeSettingsAdditive, installSettings };

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(`--${n}`);
  const opt = (n, d = '') => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 || argv[i + 1]?.startsWith('--') ? d : argv[i + 1] ?? d;
  };
  const optAll = (n) => {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === `--${n}` && argv[i + 1] !== undefined) out.push(argv[i + 1]);
    }
    return out;
  };

  const targetPath = opt('target');
  if (!targetPath) {
    process.stderr.write('Usage: install-settings.mjs --target <file.json> [--apply] [--server-cmd node] [--server-arg ...]\n');
    process.exit(2);
  }
  const cmd = opt('server-cmd', process.execPath);
  const args = optAll('server-arg');
  const incoming = {
    mcpServers: {
      brainlink: {
        command: cmd,
        args: args.length ? args : [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'brainlink.mjs'), 'serve'],
      },
    },
  };
  const result = await installSettings({ targetPath, incoming, apply: flag('apply') });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
