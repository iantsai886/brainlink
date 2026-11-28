// BrainLink Doctor: deterministic, honest capability diagnostics with first-class `declined`
// opt-out states and zero fake-green reporting.
// States:
//   - live       (live ✅)       verified working
//   - broken     (broken ❌)     failing, always includes an exact copy-pasteable fix_command
//   - declined   (declined ⏸)   explicitly opted out by user, persisted locally, never nagged
//   - UNMEASURED / MISSING       check not run or telemetry unavailable (never fake green)
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { appHome, configPath, loadConfig } from './config.mjs';
import { detect } from './connectors.mjs';
import { semanticStatus, createContext } from './core.mjs';
import { nowTaipeiIso } from './rsi-gate.mjs';

export const DOCTOR_STATES = Object.freeze(['live', 'broken', 'declined', 'UNMEASURED', 'MISSING']);
export const STATE_LABELS = Object.freeze({
  live: 'live ✅',
  broken: 'broken ❌',
  declined: 'declined ⏸',
  UNMEASURED: 'UNMEASURED',
  MISSING: 'MISSING',
});

export function doctorPrefsPath(env = process.env) {
  return path.join(appHome(env), 'doctor-preferences.json');
}

export async function loadDoctorPreferences({ env = process.env } = {}) {
  const file = doctorPrefsPath(env);
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const declined = raw && typeof raw.declined === 'object' && !Array.isArray(raw.declined) ? raw.declined : {};
    return { schema: 1, declined, file };
  } catch (err) {
    if (err.code === 'ENOENT') return { schema: 1, declined: {}, file };
    throw err;
  }
}

export async function declineCapability(capability, { reason = '', env = process.env, now = new Date() } = {}) {
  const cap = String(capability || '').trim().toLowerCase();
  if (!cap || !/^[a-z0-9._:-]+$/.test(cap)) {
    throw new Error(`Invalid capability name "${capability}".`);
  }
  const prefs = await loadDoctorPreferences({ env });
  prefs.declined[cap] = {
    declined_at: nowTaipeiIso(now),
    reason: String(reason || 'User opted out').trim().slice(0, 240),
  };
  await mkdir(path.dirname(prefs.file), { recursive: true });
  await writeFile(prefs.file, JSON.stringify({ schema: 1, declined: prefs.declined }, null, 2) + '\n', 'utf8');
  return { capability: cap, state: 'declined', label: STATE_LABELS.declined, ...prefs.declined[cap], file: prefs.file };
}

export async function undeclineCapability(capability, { env = process.env } = {}) {
  const cap = String(capability || '').trim().toLowerCase();
  const prefs = await loadDoctorPreferences({ env });
  const existed = Object.prototype.hasOwnProperty.call(prefs.declined, cap);
  delete prefs.declined[cap];
  await mkdir(path.dirname(prefs.file), { recursive: true });
  await writeFile(prefs.file, JSON.stringify({ schema: 1, declined: prefs.declined }, null, 2) + '\n', 'utf8');
  return { capability: cap, removed: existed, file: prefs.file };
}

const isDir = (p) => stat(p).then((s) => s.isDirectory(), () => false);
const isFile = (p) => stat(p).then((s) => s.isFile(), () => false);

function gitBehindOriginMain(cwd) {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const originMain = execFileSync('git', ['rev-parse', 'origin/main'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const behind = Number(execFileSync('git', ['rev-list', '--count', `${head}..${originMain}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    return { available: true, head: head.slice(0, 7), origin_main: originMain.slice(0, 7), behind };
  } catch {
    return { available: false };
  }
}

export async function runDoctor({
  env = process.env,
  repoRoot = '',
  reconcile = false,
  network = false,
  clientOpts = null,
  networkProbe = null,
  semanticProbe = null,
  now = new Date(),
} = {}) {
  const prefs = await loadDoctorPreferences({ env });
  const checks = [];
  const add = (id, state, detail, fixCommand = null, extra = {}) => {
    const cap = id.toLowerCase();
    if (prefs.declined[cap]) {
      checks.push({
        id: cap,
        state: 'declined',
        label: STATE_LABELS.declined,
        detail: `Opted out (${prefs.declined[cap].reason})`,
        declined_at: prefs.declined[cap].declined_at,
        fix_command: null,
        ...extra,
      });
      return;
    }
    checks.push({
      id: cap,
      state,
      label: STATE_LABELS[state] || state,
      detail,
      fix_command: state === 'broken' ? (fixCommand || 'brainlink setup') : null,
      ...extra,
    });
  };

  // 1. Config check
  const cfgFile = configPath(env);
  const cfgExists = await isFile(cfgFile);
  let cfg = null;
  if (!cfgExists) {
    add('config', 'MISSING', `BrainLink config not found at ${cfgFile}.`, 'brainlink setup');
  } else {
    try {
      cfg = await loadConfig(cfgFile);
      add('config', 'live', `Config loaded (${cfgFile}).`);
    } catch (err) {
      add('config', 'broken', `Config unreadable: ${err.message}`, 'brainlink setup');
    }
  }

  // 2. Vault reachability check
  if (!cfg || !cfg.vaults?.length) {
    add('vaults', 'MISSING', 'No vaults configured yet.', 'brainlink init --vault <PATH>');
  } else {
    const missingVaults = [];
    for (const v of cfg.vaults) {
      if (!(await isDir(v.path))) missingVaults.push(`${v.name} (${v.path})`);
    }
    if (missingVaults.length === 0) {
      add('vaults', 'live', `${cfg.vaults.length} configured vault(s) reachable.`);
    } else {
      add('vaults', 'broken', `Missing vault folder(s): ${missingVaults.join(', ')}.`, 'brainlink status');
    }
  }

  // 3. Local semantic embeddings (deterministic check; never fakes green)
  if (!prefs.declined['semantic']) {
    try {
      let sem;
      if (typeof semanticProbe === 'function') {
        sem = await semanticProbe();
      } else if (cfg) {
        const ctx = createContext(cfg, { env, trustedLocal: true });
        sem = await semanticStatus(ctx);
      } else {
        sem = null;
      }
      if (!sem) {
        add('semantic', 'UNMEASURED', 'Semantic embedder not measured (no config loaded).');
      } else if (sem.available) {
        add('semantic', 'live', `Local embeddings ready (${sem.model}).`);
      } else {
        add('semantic', 'broken', `Local embeddings unavailable: ${sem.reason || 'Ollama not running'}.`, sem.setup_hint || 'ollama pull nomic-embed-text');
      }
    } catch (err) {
      add('semantic', 'UNMEASURED', `Semantic probe error: ${err.message}`);
    }
  } else {
    add('semantic', 'declined', '');
  }

  // 4. Optional --reconcile checks (MCP drift + git staleness)
  if (reconcile) {
    if (clientOpts) {
      try {
        const found = await detect(clientOpts);
        const presentUnconfigured = Object.entries(found).filter(([, c]) => c.present && !c.connected && !c.unsupported).map(([id]) => id);
        if (presentUnconfigured.length > 0) {
          add('reconcile:clients', 'broken', `Installed AI clients not connected to BrainLink: ${presentUnconfigured.join(', ')}.`, 'brainlink connect --all');
        } else {
          add('reconcile:clients', 'live', 'All detected local AI clients are reconciled.');
        }
      } catch (err) {
        add('reconcile:clients', 'UNMEASURED', `Client reconcile unavailable: ${err.message}`);
      }
    } else {
      add('reconcile:clients', 'UNMEASURED', 'Client reconcile skipped (no clientOpts provided).');
    }

    if (repoRoot) {
      const gitState = gitBehindOriginMain(repoRoot);
      if (!gitState.available) {
        add('reconcile:git', 'UNMEASURED', 'Git checkout state unavailable (not a git repository or no origin/main).');
      } else if (gitState.behind > 0) {
        add('reconcile:git', 'broken', `Checkout ${gitState.head} is ${gitState.behind} commit(s) behind origin/main (${gitState.origin_main}).`, 'git fetch origin && git pull --ff-only origin main');
      } else {
        add('reconcile:git', 'live', `Checkout ${gitState.head} is up to date with origin/main.`);
      }
    } else {
      add('reconcile:git', 'UNMEASURED', 'Git reconcile not measured (no repoRoot).');
    }
  }

  // 5. Optional --network probe (explicitly UNMEASURED when not requested — never fake green!)
  if (!network) {
    add('network', 'UNMEASURED', 'Network/auth probe not run (pass --network to probe live connectivity).');
  } else if (typeof networkProbe === 'function') {
    try {
      const res = await networkProbe();
      if (res?.ok) add('network', 'live', res.detail || 'Live network probe succeeded.');
      else add('network', 'broken', res?.detail || 'Live network probe failed.', res?.fix_command || 'brainlink doctor --network');
    } catch (err) {
      add('network', 'broken', `Network probe error: ${err.message}`, 'brainlink doctor --network');
    }
  } else {
    add('network', 'UNMEASURED', 'No network probe configured; telemetry unavailable.');
  }

  const counts = { live: 0, broken: 0, declined: 0, UNMEASURED: 0, MISSING: 0 };
  for (const c of checks) {
    if (c.state in counts) counts[c.state]++;
  }
  const overall = counts.broken > 0 ? 'BROKEN' : (counts.MISSING > 0 ? 'INCOMPLETE' : (counts.UNMEASURED > 0 ? 'PARTIAL' : 'HEALTHY'));

  return {
    schema: 1,
    checked_at: nowTaipeiIso(now),
    overall,
    ok: counts.broken === 0 && counts.MISSING === 0,
    counts,
    checks,
  };
}

export function formatDoctorReport(report) {
  const lines = [`BrainLink Doctor — ${report.overall} (${report.counts.live} live, ${report.counts.broken} broken, ${report.counts.declined} declined, ${report.counts.MISSING} missing, ${report.counts.UNMEASURED} unmeasured)`];
  for (const c of report.checks) {
    lines.push(`  ${c.label.padEnd(12)} ${c.id}: ${c.detail}`);
    if (c.fix_command) lines.push(`               fix: ${c.fix_command}`);
  }
  return lines.join('\n');
}
