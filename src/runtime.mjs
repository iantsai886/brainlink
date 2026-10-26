// Glue shared by the CLI and Setup UI: load config into a context, the command AI clients
// should launch, and a content-free activity log.
import { appendFile, readFile, stat, rename, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig, configPath, appHome, normalize } from './config.mjs';
import { createContext } from './core.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_PATH = path.join(ROOT, 'bin', 'brainlink.mjs');

export async function openContext(env = process.env, { trustedLocal = false } = {}) {
  const cfg = await loadConfig(configPath(env));
  return { cfg, ctx: createContext(cfg, { env, trustedLocal }) };
}

// What AI clients run. Absolute paths so GUI apps without a shell PATH can start it.
export function launchSpec(env = process.env) {
  if (env.BRAINLINK_LAUNCHER) return { command: env.BRAINLINK_LAUNCHER, args: ['serve'] };
  return { command: process.execPath, args: [CLI_PATH, 'serve'] };
}

const LOG_MAX = 512 * 1024;

// Tool name, outcome, platform, and bounded read-response size estimates only: never content or arguments.
export async function logActivity(env, entry) {
  try {
    const dir = appHome(env);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'activity.log');
    const st = await stat(file).catch(() => null);
    if (st && st.size > LOG_MAX) await rename(file, `${file}.1`);
    await appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

export async function readActivity(env, n = 20) {
  try {
    const lines = (await readFile(path.join(appHome(env), 'activity.log'), 'utf8')).trim().split('\n');
    return lines.slice(-n).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// Rebuild a vault's Home map from setup or the CLI (no AI connection involved).
export async function refreshMap(cfg, vaultName, env = process.env) {
  const { updateHomeMap } = await import('./links.mjs');
  cfg = normalize(cfg); // freshly merged packs lack defaults such as writes: 'on'
  const ctx = createContext(cfg, { env: { ...env, BRAINLINK_VAULTS: vaultName, BRAINLINK_SEMANTIC: '0' }, trustedLocal: true });
  try { return await updateHomeMap(ctx, vaultName); } catch { return null; }
}
