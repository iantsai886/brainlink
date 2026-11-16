// Setup UI backend: a local-only web app (127.0.0.1, random session token) that picks the
// vault folder, applies a rule pack and connects AI clients.
import { runSelfTest } from './self-test.mjs';
import { createReplayMisses } from './replay-misses.mjs';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { watch as watchFs } from 'node:fs';
import { readFile, stat, lstat, realpath, cp, mkdir, writeFile, rename, unlink, readdir, rm } from 'node:fs/promises';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, configPath, normalize, validate, LOCALES, appHome, emptyConfig } from './config.mjs';
import { PACKS, buildPack, scaffold, mergePack } from './packs.mjs';
import { CLIENTS, resolveClient, detect, connectClient, disconnectClient, readClientAgentToken, test, deepSeekSessionCueStatus, setDeepSeekSessionCue } from './connectors.mjs';
import { createContext, search, searchWithVerdict, semanticStatus, readNote, related as relatedNotes, relatedText, ensureDefaultIgnore, readExcludedFolders, writeExcludedFolders, DEFAULT_EXCLUDED_FOLDERS, SUGGESTED_EXCLUDED_FOLDERS, safeJoin, vaultRoot, countVisibleNotes, parseFrontmatter } from './core.mjs';
import { extractTags } from './graph.mjs';
import { ROOT, launchSpec, readActivity, refreshMap, logActivity } from './runtime.mjs';
import { detectEmbedder } from './embed.mjs';
import { validateRerankerSettings, testReranker } from './rerank.mjs';
import { vaultHealth, brief as createBrief } from './insights.mjs';
import { loadVault } from './core.mjs';
import { resolveNoteWikilinks } from './links.mjs';
import { VERSION, createMcp } from './server.mjs';
import { findObsidianVaults, nestedVaults, obsidianOpenUrl, obsidianVaultForPath } from './obsidian.mjs';
import { syncSettings, chooseSync, suggestFolders, PROVIDERS, PROVIDER_LABELS } from './sync/settings.mjs';
import { linuxDriveSetup, normalizeDriveSelection } from './sync/gdrive-linux.mjs';
import { backupScheduleDue, normalizeBackupSchedule } from './backup-schedule.mjs';
import { runSync } from './sync-cli.mjs';
import { listGitHubShareCandidates, previewGitHubRepository, commitGitHubSelectedNotes, pushGitHubSelectedNotes, listGitHubPullCandidates, importGitHubSelectedNotes, saveGitHubConflictCopies, inspectGitHubAssignment, testGitHubRepositoryAccess, cloneGitHubRepository, githubAssignmentStatus } from './sync/github-preview.mjs';
import { githubAssignmentProjection } from './sync/github-assignment.mjs';
import { runGitHubAutoSync } from './sync/github-auto-sync.mjs';
import { sessionsService } from './host.mjs';
import { addAgent, renameAgent, removeAgent, revokeAgent, markConnected, findAgentByToken, publicAgent, localAgentSnippet, remoteAgentSnippet, generateAgentToken, hashToken } from './mcp-agents.mjs';
import { analyzeActivitySignals, attachRetrievalObservationSignals } from './rsi-observations.mjs';
import { buildGraph3D, noteDetail3D, listProposedTypedRelations, discoverVaultRelationshipCandidates, listGraphVaults } from './graph3d.mjs';
import { deriveTypedRelations, deriveProposedTypedRelations, deriveRejectedTypedRelations, deriveWithdrawnTypedRelations, discoverTypedRelationshipCandidates, typedEntityFields, typedEntityMetadataMap, typedRelationAllowed, updateTypedEntityFields, updateTypedRelation, appendTypedRelationProposal, approveTypedRelation, rejectTypedRelation, reopenTypedRelation, withdrawTypedRelation } from './typed-graph.mjs';
import { snapshotSettings, chooseSnapshot, suggestSnapshotFolder, clearSnapshot, startSnapshotWatcher, writeSnapshotOnce, loadSnapshotStatus, saveSnapshotStatus } from './snapshot.mjs';
import { listHandoffs, proposeNote, commitNew, appendTo, checkWritePath } from './writes.mjs';
import { readMemoryForReview, saveMemoryForReview } from './memory-review.mjs';
import { createProposalInbox } from './proposal-inbox.mjs';
import { backupOnce, verifyBackup, restoreBackupToEmpty, loadBackupStatus, saveBackupStatus, pruneBackups, listVerifiedBackups } from './backup.mjs';
import { createOrReadBackupRecoveryKey, parseBackupKey, requireBackupKey } from './backup-key.mjs';
import { fileSessionSummary, readFiledSessionSummary, updateFiledSessionSummary, listFiledSessionSummaries, findFiledSessionSummary } from './sessions/filing.mjs';
import { isStartupEnabled, setStartupEnabled } from './startup.mjs';
import { recommendSessionVault, exactSessionFilingDestination } from './sessions/routing.mjs';
import { harnessCueIsIdle, listSessionEndCues, dismissSessionEndCue, sessionEndCueId, matchSessionEndCue } from './sessions/end-cue.mjs';
import { listSessionFilingFolders, suggestedSessionFolder } from './sessions/folders.mjs';
import { generateLocalSessionSummary, LOCAL_OLLAMA_URL, readLocalSummaryDraft, saveLocalSummaryDraft, validLocalModelName } from './sessions/local-summary.mjs';
import { sessionHookStatus, setSessionHook, hermesSessionHookStatus, setHermesSessionHook } from './sessions/hooks.mjs';
import { twinProfileStatus, profileScopeEditable } from './twin-profiles.mjs';
import { createRsiLedger } from './rsi-ledger.mjs';
import { createRsiExperiments } from './rsi-experiments.mjs';
import { listDecisionReviews, readDecisionReview, validReviewDate } from './decision-reviews.mjs';
import { createConflictReviewStore, listConflictCandidates } from './conflict-review.mjs';
import { createRsiDiscovery } from './rsi-discovery.mjs';
import { createRsiObservationSchedule } from './rsi-observation-schedule.mjs';
import { createRsiWeekly, taipeiWeek } from './rsi-weekly.mjs';
import { validateWeeklyBenchmarkSchedule, weeklyBenchmarkScheduleDue, weeklyScheduleWeek } from './rsi-weekly-schedule.mjs';
import { hasGitCommit, readGitSourceState } from './git-source-state.mjs';
import { inspectAgentSkills, installAgentSkills, removeAgentSkills, skillClientRoot } from './agent-skills.mjs';
import { ingestionQueue, readIngestionSource, recordIngestion } from './ingestion.mjs';
import { generateLocalIngestionDraft } from './ingestion-draft.mjs';
import { redactText } from './sessions/redact.mjs';
import { ingestionDraftId, listIngestionDrafts, readIngestionDraft, removeIngestionDraft, saveIngestionDraft, updateIngestionDraftFiling } from './ingestion-drafts-store.mjs';
import { INGESTION_MAX_ATTEMPTS, INGESTION_RETRY_DELAY_MS, ingestionScheduleDue, localDateAndTime, normalizeIngestionTargets, validateIngestionSchedule } from './ingestion-schedule.mjs';
import { briefScheduleDue, validateBriefSchedule } from './brief-schedule.mjs';
import { defaultRoot as hermesDefaultRoot } from './sessions/hermes.mjs';
import { checkForUpdate, downloadVerifiedUpdate } from './update-client.mjs';
import { openUpdatePackage } from './update-launcher.mjs';
import { UPDATE_PUBLIC_KEYS } from './update-trust.mjs';
import { inspectClaudeDesktopRuntime } from './client-runtime.mjs';

const GRAPH_NOTE_MUTATIONS = new Set([
  '/api/graph3d/note/save',
  '/api/graph3d/entity/save',
  '/api/graph3d/relationship/approve',
  '/api/graph3d/relationship/reject',
  '/api/graph3d/relationship/reopen',
  '/api/graph3d/relationship/archive',
  '/api/graph3d/relationship/edit',
  '/api/graph3d/relationship/propose',
  '/api/graph3d/relationship/propose-manual',
]);
const graphNoteMutationQueues = new Map();

async function serializeGraphNoteMutation(body, action) {
  const vault = String(body?.vault || '');
  const note = path.posix.normalize(String(body?.path || '').replace(/\\/g, '/'));
  const key = JSON.stringify([vault, process.platform === 'win32' ? note.toLowerCase() : note]);
  const previous = graphNoteMutationQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  graphNoteMutationQueues.set(key, current);
  await previous.catch(() => {});
  try { return await action(); }
  finally {
    release();
    if (graphNoteMutationQueues.get(key) === current) graphNoteMutationQueues.delete(key);
  }
}

const UI_STATIC_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const UI_DIR = path.join(ROOT, 'ui');

// A small whitelist of ui/* assets this server will hand out with no session token (same trust
// level as index.html itself: static code and styles, never vault content or secrets).
async function readUiStatic(rel) {
  const ext = path.extname(rel);
  if (!UI_STATIC_TYPES[ext] || rel === 'index.html') return null;
  const full = path.resolve(UI_DIR, '.' + rel);
  if (full !== UI_DIR && !full.startsWith(UI_DIR + path.sep)) return null; // no traversal out of ui/
  try { return { body: await readFile(full), type: UI_STATIC_TYPES[ext] }; } catch { return null; }
}

const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
const LOCALES_DIR = path.join(ROOT, 'ui', 'locales');

async function verifyStagedUpdate(pending) {
  const root = path.resolve(pending.folder);
  const file = path.resolve(pending.file);
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Verified update package path is invalid.');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== pending.size) throw new Error('Verified update package changed after download. Prepare it again.');
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { bytes += chunk.length; digest.update(chunk); }
  if (bytes !== pending.size || digest.digest('hex') !== pending.sha256) throw new Error('Verified update package changed after download. Prepare it again.');
  return file;
}

async function markdownFingerprint(root) {
  const rows = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.') || ['node_modules', '.git'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const info = await stat(full).catch(() => null);
        if (info) rows.push(`${path.relative(root, full).split(path.sep).join('/')}\0${info.size}\0${info.mtimeMs}`);
      }
    }
  }
  await walk(root);
  rows.sort();
  return rows.join('\n');
}

function startVaultChangeWatcher(vaults, onChange, { debounceMs = 300, pollMs = 10000 } = {}) {
  let stopped = false, timer = null, pollRunning = false;
  const watchers = [], fallback = [];
  const notify = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (!stopped) onChange(); }, debounceMs);
    timer.unref?.();
  };
  for (const vault of vaults) {
    // Linux does not provide recursive fs.watch reliably. In particular, Node can
    // walk a large FUSE tree while opening the watcher, which blocks Setup startup.
    if (process.platform === 'linux') { fallback.push(vault); continue; }
    try {
      const watcher = watchFs(vault.path, { recursive: true }, (_event, filename) => {
        if (filename != null) {
          const name = String(filename);
          const ext = path.extname(name);
          if (ext && ext.toLowerCase() !== '.md') return;
          if (name.split(/[\\/]/).some((part) => part.startsWith('.'))) return;
        }
        notify();
      });
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch { fallback.push(vault); }
  }
  let fingerprints = new Map();
  let pollTimer = null;
  // Linux does not support recursive fs.watch. A recursive fingerprint fallback is
  // acceptable for small local folders, but it can block startup indefinitely on a
  // network/FUSE-backed vault (for example an rclone Google Drive mount). In that
  // case the user can refresh Setup manually; never scan the whole remote tree just
  // to start the local dashboard.
  // Linux always uses the fingerprint fallback because recursive fs.watch is unavailable.
  // Non-Linux platforms use it only when their native recursive watcher could not start.
  if (fallback.length) {
    const initialize = Promise.all(fallback.map(async (vault) => fingerprints.set(vault.name, await markdownFingerprint(vault.path))));
    pollTimer = setInterval(async () => {
      if (stopped || pollRunning) return;
      pollRunning = true;
      try {
        await initialize;
        for (const vault of fallback) {
          const next = await markdownFingerprint(vault.path);
          if (next !== fingerprints.get(vault.name)) { fingerprints.set(vault.name, next); notify(); }
        }
      } catch { /* local file scan failures do not expose paths or contents */ }
      finally { pollRunning = false; }
    }, pollMs);
    pollTimer.unref?.();
  }
  return { stop() { stopped = true; clearTimeout(timer); if (pollTimer) clearInterval(pollTimer); for (const watcher of watchers) { try { watcher.close(); } catch {} } } };
}

function assertTwinActionsMatchMemory(agentAccess, memoryPolicy) {
  const requiredMemory = {
    search: 'semantic', read_note: 'semantic',
    read_session: 'episodic', log_session: 'episodic', propose_note: 'semantic', write_note: 'semantic',
    handoff_read: 'working', write_handoff: 'working',
  };
  for (const agent of agentAccess) for (const grant of agent.vaults) {
    for (const operation of grant.operations) {
      const memoryType = requiredMemory[operation];
      const effective = agent.memory_policy || memoryPolicy;
      if (memoryType && effective[memoryType] !== true) throw new Error(`Enable ${memoryType} memory for this AI before granting ${operation} access.`);
    }
  }
}

const TWIN_MEMORY_TYPES = ['working', 'semantic', 'procedural', 'episodic'];
function normalizeAgentMemoryPolicy(requested, profilePolicy, inheritedPolicy = profilePolicy) {
  if (requested === undefined || requested === null) return { ...inheritedPolicy };
  if (!requested || typeof requested !== 'object' || Array.isArray(requested) || TWIN_MEMORY_TYPES.some((type) => typeof requested[type] !== 'boolean')) {
    throw new Error('Choose on or off for each of the four memory types for this AI.');
  }
  const policy = Object.fromEntries(TWIN_MEMORY_TYPES.map((type) => [type, requested[type]]));
  if (TWIN_MEMORY_TYPES.some((type) => policy[type] && profilePolicy[type] !== true)) throw new Error('An AI cannot receive memory access that the Twin profile has disabled.');
  return policy;
}

export function pickFolder(os = process.platform, prompt = 'Choose your Obsidian / Markdown vault folder') {
  return new Promise((resolve) => {
    const done = (err, out) => resolve(err ? null : String(out).trim() || null);
    if (os === 'darwin') execFile('osascript', ['-e', `POSIX path of (choose folder with prompt "${prompt.replace(/"/g, "'")}")`], done);
    else if (os === 'win32') execFile('powershell', ['-NoProfile', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = "${prompt.replace(/"/g, "'")}"; if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }`], done);
    // Linux: GNOME's zenity, else KDE's kdialog; with neither, Setup asks for the path instead.
    else execFile('zenity', ['--file-selection', '--directory', `--title=${prompt}`], (err, out) => {
      if (!err || err.code === 1) return done(err, out); // 1 = user cancelled
      execFile('kdialog', ['--getexistingdirectory', process.env.HOME || '/'], (e2, o2) => (e2 && e2.code !== 1 ? resolve(undefined) : done(e2, o2)));
    });
  });
}

// A search snippet is raw note text (headings, **bold**, `code`); strip the Markdown so the
// instant answer reads as prose instead of exposing the source's formatting.
const plainText = (s) => String(s || '').replace(/^#+\s*/gm, '').replace(/\s#{1,6}\s+/g, ' · ').replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').replace(/\s#{1,6}$/, '').trim();

// opts: { env, home, os, port, pick, openUrl }
export async function startSetup(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || homedir();
  const os = opts.os || process.platform;
  const file = configPath(env);
  let configMutationQueue = Promise.resolve();
  async function withConfigMutation(operation) {
    const previous = configMutationQueue;
    let release;
    configMutationQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
  const token = opts.token || randomBytes(18).toString('base64url');
  const updateDownloads = new Map();
  function retainUpdatePackage(ticket, pending) {
    clearTimeout(pending.timer);
    pending.expiresAt = Date.now() + 24 * 60 * 60_000;
    pending.timer = setTimeout(() => {
      if (updateDownloads.get(ticket) !== pending) return;
      updateDownloads.delete(ticket);
      rm(pending.folder, { recursive: true, force: true }).catch(() => {});
    }, 24 * 60 * 60_000);
    pending.timer.unref?.();
  }
  const pick = opts.pick || (() => pickFolder(os));
  const pickSnapshotFolder = opts.pickSnapshotFolder || (() => pickFolder(os, 'Choose a folder to share a read-only copy with cloud agents'));
  const pickBackupFolder = opts.pickBackupFolder || (() => pickFolder(os, 'Choose a private backup destination'));
  const pickRestoreSourceFolder = opts.pickRestoreSourceFolder || (() => pickFolder(os, 'Choose a BrainLink backup folder'));
  const pickRestoreDestinationFolder = opts.pickRestoreDestinationFolder || (() => pickFolder(os, 'Choose an empty restore destination'));
  const pickGitHubRepository = opts.pickGitHubRepository || (() => pickFolder(os, 'Choose an existing GitHub repository clone'));
  const clientOpts = () => ({ home, os, env, launch: launchSpec(env), useCli: opts.useCli });
  // Setup and its scheduled local jobs operate with the user's local authority. AI client
  // health checks intentionally use createContext() without this bypass.
  const localContext = (cfg, contextEnv = env) => createContext(cfg, { env: contextEnv, trustedLocal: true });
  const proposalInbox = createProposalInbox({ home: appHome(env) });
  const conflictReviewStore = createConflictReviewStore(appHome(env));
  const sessions = sessionsService(env, home); // src/host.mjs: imports only from this Setup user's home
  const rsiLedger = createRsiLedger({ home: appHome(env), verifyCommit: opts.rsiVerifyCommit || ((sha) => hasGitCommit(ROOT, sha)) });
  const rsiWeekly = createRsiWeekly({ home: appHome(env) });
  const rsiExperiments = createRsiExperiments({
    env,
    getRerankerSettings: async () => (await loadConfig(file)).reranker,
    ...(opts.rsiSourceState ? { sourceState: opts.rsiSourceState } : {}),
  });
  // Opt-in research discovery: off until the user enables it; runs only while this process is open.
  const rsiDiscovery = createRsiDiscovery({ home: appHome(env), ledger: rsiLedger, fetchImpl: opts.discoveryFetch, lookup: opts.discoveryLookup });
  const initialDiscoveryStatus = await rsiDiscovery.status().catch(() => null);
  let discoveryKeepsAlive = Boolean(initialDiscoveryStatus?.settings.enabled && !initialDiscoveryStatus.settings.paused);
  const rsiObservationSchedule = createRsiObservationSchedule({
    home: appHome(env), readEntries: () => readActivity(env, 20000),
    readRetrievalObservations: ({ since } = {}) => rsiWeekly.listRetrievalObservations({ since }),
    ledger: rsiLedger,
    readVaultHealth: async (name) => {
      const cfg = await loadConfig(file);
      const vault = cfg.vaults.find((item) => item.name === name);
      if (!vault || !await stat(vault.path).then((result) => result.isDirectory(), () => false)) throw new Error('The selected vault is no longer available.');
      const ctx = localContext(cfg, { ...env, BRAINLINK_VAULTS: name });
      const health = await vaultHealth(ctx, name);
      return {
        notes: health.notes, links: health.links, orphan_count: health.orphan_count, broken_count: health.broken_count,
        duplicate_title_count: health.duplicate_title_count, stale_active_count: health.stale_active_count,
        typed_entity_count: health.typed_entity_count,
        verified_typed_relation_count: health.verified_typed_relation_count,
        proposed_typed_relation_count: health.proposed_typed_relation_count,
        unresolved_typed_relation_count: health.unresolved_typed_relation_count,
        duplicate_typed_id_count: health.duplicate_typed_id_count,
      };
    },
  });
  const initialObservationStatus = await rsiObservationSchedule.status().catch(() => null);
  let observationKeepsAlive = Boolean(initialObservationStatus?.settings.enabled);
  const initialWeeklyBenchmarkConfig = await loadConfig(file);
  let weeklyBenchmarkKeepsAlive = Boolean(initialWeeklyBenchmarkConfig.weekly_benchmark?.enabled);
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  let port = opts.port ?? 0;
  // When started from the app (no terminal), exit after idleMinutes without requests. Closing
  // the Done button in the browser only hides that tab's view (see ui/index.html) — it must
  // never stop this background process, so idle timeout is the only thing that quits it here.
  let idleTimer = null;
  let idleQuitTimer = null;
  let backupEnabled = false;
  let ingestionKeepsAlive = false;
  let briefKeepsAlive = false;
  let localSummaryAutoDraftKeepsAlive = false;
  let syncKeepsAlive = false;
  let githubAutoKeepsAlive = false;
  const quit = () => {
    clearTimeout(idleQuitTimer);
    idleQuitTimer = setTimeout(() => { snapshotWatcher?.stop(); (opts.onQuit ? opts.onQuit() : server.close()); }, opts.idleQuitGraceMs ?? 100);
  };
  const touch = () => {
    clearTimeout(idleTimer);
    clearTimeout(idleQuitTimer);
    if (!opts.idleMinutes || backupEnabled || discoveryKeepsAlive || observationKeepsAlive || weeklyBenchmarkKeepsAlive || ingestionKeepsAlive || briefKeepsAlive || localSummaryAutoDraftKeepsAlive || syncKeepsAlive || githubAutoKeepsAlive) return;
    idleTimer = setTimeout(quit, opts.idleMinutes * 60e3);
    idleTimer.unref?.();
  };
  let localSummaryAutoDraftRunning = false;
  const localSummaryAutoDraftAttempts = new Map();
  const localSummaryAutoDraftStatus = new Map();
  const localSummaryAutoFileStatus = new Map();
  const localSummaryAutoDraftTimer = setInterval(async () => {
    if (localSummaryAutoDraftRunning) return;
    localSummaryAutoDraftRunning = true;
    try {
      const cfg = await loadConfig(file);
      const settings = cfg.sessions.localSummary;
      localSummaryAutoDraftKeepsAlive = Boolean(settings.enabled && settings.autoDraftOnEnd);
      if (!localSummaryAutoDraftKeepsAlive) return;
      touch();
      await sessions.refresh();
      const store = await sessions.store();
      const imported = await store.listSessions({ limit: 100000 });
      const cueDir = path.join(appHome(env), 'sessions', 'end-cues');
      const cues = await listSessionEndCues(cueDir);
      for (const cue of cues) {
        const id = matchSessionEndCue(cue, imported);
        if (!id) continue;
        const draftDir = path.join(appHome(env), 'sessions', 'auto-summary');
        const previousDraft = await readLocalSummaryDraft(draftDir, id);
        const fileDraft = async (draft) => {
          if (!settings.autoFileOnEnd || !draft) return false;
          const { session } = await store.readSession(id, { limit: 1 });
          const destination = exactSessionFilingDestination(session, cfg);
          if (!destination) { localSummaryAutoFileStatus.set(id, 'needs_destination'); return false; }
          const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: 'BrainLink Local' });
          const existing = await findFiledSessionSummary(ctx, destination.vault, destination.folder, id);
          if (existing) { localSummaryAutoFileStatus.set(id, 'filed'); return true; }
          const summarySession = { ...session, summary: draft.summary, local_summary_model: draft.model, local_summary_generated_at: draft.generated_at };
          const result = await fileSessionSummary(ctx, summarySession, destination.vault, true,
            { ai_platform: 'BrainLink Local', agent_or_role: 'automatic local session closeout', session_or_task_id: id }, destination.folder);
          if (!result?.written) throw new Error('The session summary note was not written.');
          localSummaryAutoFileStatus.set(id, 'filed');
          return true;
        };
        if (cue.client === 'deepseek-harness') {
          const { messages } = await store.readSession(id, { limit: 1000 });
          const latest = messages.filter((message) => ['user', 'assistant'].includes(message.role)).at(-1)?.at;
          if (!harnessCueIsIdle(cue, latest)) continue;
          if (previousDraft && Date.parse(previousDraft.generated_at) >= Date.parse(cue.ended_at)) {
            try { await fileDraft(previousDraft); } catch { localSummaryAutoFileStatus.set(id, 'failed'); }
            continue;
          }
        } else if (previousDraft) {
          try { await fileDraft(previousDraft); } catch { localSummaryAutoFileStatus.set(id, 'failed'); }
          continue;
        }
        const lastAttempt = localSummaryAutoDraftAttempts.get(id) || 0;
        if (Date.now() - lastAttempt < 10 * 60_000) continue;
        localSummaryAutoDraftAttempts.set(id, Date.now());
        try {
          const { messages } = await store.readSession(id, { limit: 1000 });
          const draft = await generateLocalSessionSummary(messages, settings.model, { fetchImpl: opts.localSummaryFetch || fetch });
          if (cue.client === 'deepseek-harness') {
            await sessions.refresh({ force: true });
            const latestStore = await sessions.store();
            const latestSessions = await latestStore.listSessions({ limit: 100000 });
            const latestId = matchSessionEndCue(cue, latestSessions);
            const latestMessages = latestId ? await latestStore.readSession(latestId, { limit: 1000 }).then((value) => value.messages) : [];
            const latestAt = latestMessages.filter((message) => ['user', 'assistant'].includes(message.role)).at(-1)?.at;
            const stillPending = (await listSessionEndCues(cueDir)).some((current) => sessionEndCueId(current) === sessionEndCueId(cue));
            if (!stillPending || !harnessCueIsIdle(cue, latestAt)) continue;
          }
          await saveLocalSummaryDraft(draftDir, id, draft, { replace: Boolean(previousDraft) });
          localSummaryAutoDraftStatus.set(id, 'ready');
          localSummaryAutoDraftAttempts.delete(id);
          try { await fileDraft(draft); } catch { localSummaryAutoFileStatus.set(id, 'failed'); }
        } catch {
          localSummaryAutoDraftStatus.set(id, 'failed');
        }
        break; // One local-model task per tick; never turn one cue into repeated generation.
      }
    } catch { /* Keep the cue available for manual review; never write a note on failure. */ }
    finally { localSummaryAutoDraftRunning = false; }
  }, opts.localSummaryAutoDraftTickMs ?? 60_000);
  localSummaryAutoDraftTimer.unref?.();

  // Shared snapshot (Ian's RB8): runs for as long as this Setup process is open. Restarted
  // whenever the setting changes so a just-picked folder, or turning it off, takes effect at once.
  const snapshotStateFile = path.join(appHome(env), 'snapshot-state.json');
  const backupStateFile = path.join(appHome(env), 'backup-state.json');
  const syncStatusFile = path.join(appHome(env), 'sync-status.json');
  const githubAutoStateFile = path.join(appHome(env), 'github-auto-sync-state.json');
  const githubAutoStatusFile = path.join(appHome(env), 'github-auto-sync-status.json');
  let snapshotWatcher = null;
  let backupTimer = null;
  let syncTimer = null;
  let syncRunning = false;
  let syncTickRunning = false;
  let syncStatus = await readFile(syncStatusFile, 'utf8').then((raw) => JSON.parse(raw)).catch(() => null);
  let githubAutoState = await readFile(githubAutoStateFile, 'utf8').then((raw) => JSON.parse(raw)).catch(() => ({}));
  let githubAutoStatus = await readFile(githubAutoStatusFile, 'utf8').then((raw) => JSON.parse(raw)).catch(() => ({}));
  let githubAutoRunning = false;
  let githubAutoTickRunning = false;
  async function saveGitHubAutoState(value) {
    await mkdir(path.dirname(githubAutoStateFile), { recursive: true });
    const temp = `${githubAutoStateFile}.${randomBytes(5).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, githubAutoStateFile);
    githubAutoState = value;
  }
  async function saveGitHubAutoStatus(value) {
    await mkdir(path.dirname(githubAutoStatusFile), { recursive: true });
    const temp = `${githubAutoStatusFile}.${randomBytes(5).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, githubAutoStatusFile);
    githubAutoStatus = value;
  }
  const interruptedSyncs = Object.entries(githubAutoStatus).filter(([, status]) => status?.running);
  if (interruptedSyncs.length) {
    const recovered = { ...githubAutoStatus };
    for (const [id, status] of interruptedSyncs) recovered[id] = { ...status, at: new Date(Date.now() - 24 * 3600e3).toISOString(), running: false, ok: false, error: 'BrainLink restarted during the previous sync. Retry is available; any saved pending commit is preserved.' };
    await saveGitHubAutoStatus(recovered).catch(() => {});
  }
  async function runGitHubAutoProfile(cfg, profile, trigger) {
    if (githubAutoRunning) throw new Error('A GitHub sync is already running.');
    githubAutoRunning = true;
    const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
    const operations = {
      pullCandidates: listGitHubPullCandidates,
      import: importGitHubSelectedNotes,
      shareCandidates: listGitHubShareCandidates,
      preview: previewGitHubRepository,
      commit: commitGitHubSelectedNotes,
      push: pushGitHubSelectedNotes,
      saveState: saveGitHubAutoState,
    };
    try {
      const previous = githubAutoStatus[profile.id];
      await saveGitHubAutoStatus({ ...githubAutoStatus, [profile.id]: { ...previous, profile_id: profile.id, remote: profile.github_repository.remote, vault: profile.github_repository.vault, at: new Date().toISOString(), trigger, running: true, ok: null, error: null } });
      const isEnabled = async (expected) => {
        const latest = await loadConfig(file);
        const current = latest.twin_profiles.find((item) => item.id === expected.id)?.github_repository;
        return current?.automatic_sync?.enabled === true && JSON.stringify(current) === JSON.stringify(expected.github_repository);
      };
      const result = await runGitHubAutoSync({ ctx, profile, state: githubAutoState, operations, trigger, isEnabled });
      await saveGitHubAutoState(result.state);
      const status = { ...result.report, running: false };
      await saveGitHubAutoStatus({ ...githubAutoStatus, [profile.id]: status });
      return status;
    } finally { githubAutoRunning = false; }
  }
  function refreshGitHubAutoSchedule(cfg) {
    githubAutoKeepsAlive = cfg.twin_profiles.some((profile) => profile.github_repository?.automatic_sync?.enabled === true);
    touch();
  }
  const githubAutoTimer = setInterval(async () => {
    if (githubAutoTickRunning || githubAutoRunning) return;
    githubAutoTickRunning = true;
    try {
      const cfg = await loadConfig(file);
      refreshGitHubAutoSchedule(cfg);
      for (const profile of cfg.twin_profiles.filter((item) => item.github_repository?.automatic_sync?.enabled === true)) {
        const prior = githubAutoStatus[profile.id];
        const interval = profile.github_repository.automatic_sync.intervalHours * 3600e3;
        const last = Date.parse(prior?.at || '');
        if (Number.isFinite(last) && Date.now() - last < interval) continue;
        await runGitHubAutoProfile(cfg, profile, 'schedule').catch(() => {});
      }
    } catch { /* failures are shown in the saved run status */ }
    finally { githubAutoTickRunning = false; }
  }, opts.githubAutoTickMs ?? 60_000);
  githubAutoTimer.unref?.();
  let backupRunning = false;
  let backupTickRunning = false;
  let backupStatus = await loadBackupStatus(backupStateFile);
  const ingestionStateFile = path.join(appHome(env), 'ingestion-state.json');
  let ingestionStatus = await readFile(ingestionStateFile, 'utf8').then((raw) => JSON.parse(raw)).catch(() => ({ ok: null, at: null, trigger: null, queued_total: 0, scanned: 0, skipped: 0, unsupported_count: 0, unsupported_formats: [], error: null }));
  let ingestionRunning = false;
  const ingestionDraftsDir = path.join(appHome(env), 'ingestion', 'drafts');
  const ingestionDraftStatusFile = path.join(appHome(env), 'ingestion-draft-state.json');
  async function typedEntitiesForIngestionSource(ctx, vaultName, source) {
    const index = await loadVault(ctx, vaultName);
    const visible = index.notes.filter((note) => !note.private && !note.generated);
    const metadata = typedEntityMetadataMap(visible);
    if (!metadata.size) return [];
    const text = redactText(source.body).toLocaleLowerCase();
    return visible.map((note) => ({ note, entity: metadata.get(note) }))
      .filter(({ note, entity }) => entity && note.rel !== source.rel && note.title.length >= 3 && text.includes(note.title.toLocaleLowerCase()))
      .sort((a, b) => b.note.title.length - a.note.title.length || a.note.rel.localeCompare(b.note.rel))
      .slice(0, 12)
      .map(({ note, entity }) => ({ id: entity.entity_id, title: note.title, type: entity.type, scope: entity.scope }));
  }
  let ingestionDraftStatus = await readFile(ingestionDraftStatusFile, 'utf8').then((raw) => JSON.parse(raw)).catch(() => ({ ok: null, at: null, trigger: null, attempted: 0, created: 0, failed: 0 }));
  const briefStateFile = path.join(appHome(env), 'brief-state.json');
  let briefStatus = await readFile(briefStateFile, 'utf8').then((raw) => JSON.parse(raw)).catch(() => ({ ok: null, at: null, trigger: null, vault: null, result: null, error: null }));
  let briefRunning = false;
  async function saveBriefStatus(status) {
    await mkdir(path.dirname(briefStateFile), { recursive: true });
    const temp = `${briefStateFile}.${randomBytes(5).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(status, null, 2) + '\n', { flag: 'wx' });
    await rename(temp, briefStateFile);
    briefStatus = status;
  }
  async function runBrief(cfg, { trigger = 'manual', vaultName = cfg.brief?.vault } = {}) {
    if (briefRunning) throw new Error('A brief is already running.');
    const selected = cfg.vaults.find((item) => item.name === vaultName);
    if (!selected || !(await stat(selected.path).then((s) => s.isDirectory(), () => false))) throw new Error('Choose one existing vault for the brief.');
    briefRunning = true;
    try {
      const result = await createBrief(localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' }), vaultName, { days: 7 });
      const status = { ok: true, at: new Date().toISOString(), trigger, vault: vaultName, result, error: null };
      await saveBriefStatus(status);
      return status;
    } catch (error) {
      const status = { ok: false, at: new Date().toISOString(), trigger, vault: vaultName, result: null, error: error.message || String(error) };
      await saveBriefStatus(status).catch(() => {});
      throw error;
    } finally { briefRunning = false; }
  }
  let briefTickRunning = false;
  const briefTimer = setInterval(async () => {
    if (briefTickRunning || briefRunning) return;
    briefTickRunning = true;
    try {
      const cfg = await loadConfig(file);
      if (!briefScheduleDue(cfg.brief, new Date(), cfg.timezone)) return;
      cfg.brief.last_scheduled_date = localDateAndTime(new Date(), cfg.timezone).date;
      await saveConfig(cfg, file);
      await runBrief(cfg, { trigger: 'schedule' });
    } catch (error) {
      await saveBriefStatus({ ok: false, at: new Date().toISOString(), trigger: 'schedule', vault: null, result: null, error: error.message || String(error) }).catch(() => {});
    } finally { briefTickRunning = false; }
  }, opts.briefTickMs ?? 30_000);
  briefTimer.unref?.();
  function refreshBriefSchedule(cfg) {
    briefKeepsAlive = Boolean(cfg.brief?.enabled);
    touch();
  }
  async function saveIngestionStatus(status) {
    await mkdir(path.dirname(ingestionStateFile), { recursive: true });
    const temp = `${ingestionStateFile}.${randomBytes(5).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(status, null, 2) + '\n', { flag: 'wx' });
    await rename(temp, ingestionStateFile);
    ingestionStatus = status;
  }
  async function runIngestion(cfg, { trigger = 'manual', targets = cfg.ingestion?.targets?.length ? cfg.ingestion.targets : [{ vault: cfg.ingestion?.vault, folder: cfg.ingestion?.folder }] } = {}) {
    if (ingestionRunning) throw new Error('A source scan is already running.');
    const selected = normalizeIngestionTargets(targets);
    if (!selected.length || selected.some((target) => !target?.vault || !target?.folder)) throw new Error('Add at least one vault folder to scan.');
    ingestionRunning = true;
    try {
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      const candidates = [], folders = [];
      let queued_total = 0, scanned = 0, skipped = 0, unsupported_count = 0, truncated = false;
      const unsupportedCounts = new Map();
      for (const target of selected) {
        try {
          const remaining = Math.max(0, 100 - candidates.length);
          const queue = await ingestionQueue(ctx, target.vault, target.folder, { limit: Math.max(1, remaining) });
          queued_total += queue.queued_total; scanned += queue.scanned; skipped += queue.skipped; unsupported_count += queue.unsupported_count || 0; truncated ||= queue.truncated;
          for (const item of queue.unsupported_formats || []) {
            const extension = String(item.extension || '');
            const key = unsupportedCounts.has(extension) || unsupportedCounts.size < 19 ? extension : 'other';
            unsupportedCounts.set(key, (unsupportedCounts.get(key) || 0) + Math.max(0, Number(item.count) || 0));
          }
          folders.push({ vault: target.vault, folder: queue.folder, ok: true, queued_total: queue.queued_total, scanned: queue.scanned, skipped: queue.skipped, unsupported_count: queue.unsupported_count || 0, unsupported_formats: queue.unsupported_formats || [], truncated: queue.truncated });
          const destinations = (await listSessionFilingFolders(ctx, target.vault))
            .map((entry) => entry.path)
            .filter((folder) => folder && folder !== target.folder && !folder.startsWith(`${target.folder}/`)
              && !(folder === ctx.byName.get(target.vault)?.intake_folder && ctx.byName.get(target.vault)?.decisions?.length));
          const configured = (cfg.ingestion?.targets || []).find((item) => item.vault === target.vault && item.folder === queue.folder);
          const destination = target.destination || configured?.destination || null;
          for (const item of queue.candidates.slice(0, remaining)) candidates.push({ ...item, vault: target.vault, folder: queue.folder, destination, destinations });
        } catch (error) {
          folders.push({ vault: target.vault, folder: target.folder, ok: false, error: error.message || String(error) });
        }
      }
      const failures = folders.filter((entry) => !entry.ok);
      const unsupported_formats = [...unsupportedCounts.entries()].map(([extension, count]) => ({ extension, count })).sort((a, b) => a.extension.localeCompare(b.extension));
      const status = { ok: failures.length === 0, at: new Date().toISOString(), trigger, vault: selected.length === 1 ? selected[0].vault : null, folder: selected.length === 1 ? selected[0].folder : null, targets: folders, queued_total, scanned, skipped, unsupported_count, unsupported_formats, truncated, error: failures.length ? failures.map((entry) => `${entry.vault}: ${entry.error}`).join('; ').slice(0, 500) : null };
      await saveIngestionStatus(status);
      await logActivity(env, { tool: 'source_scan', ok: status.ok });
      return { ...status, candidates, limited: queued_total > candidates.length };
    } catch (error) {
      const status = { ok: false, at: new Date().toISOString(), trigger, vault: null, folder: null, queued_total: 0, scanned: 0, skipped: 0, unsupported_count: 0, unsupported_formats: [], error: error.message || String(error) };
      await saveIngestionStatus(status).catch(() => {});
      await logActivity(env, { tool: 'source_scan', ok: false });
      throw error;
    } finally { ingestionRunning = false; }
  }
  async function runScheduledIngestionDrafts(cfg, candidates, { trigger = 'schedule' } = {}) {
    const record = { ok: true, at: new Date().toISOString(), trigger, attempted: 0, created: 0, filed: 0, waiting_review: 0, already_pending: 0, failed: 0, limited: 0 };
    try {
      if (!cfg.ingestion?.autoDrafts || !cfg.sessions.localSummary?.enabled || !cfg.sessions.localSummary?.model) throw new Error('Local draft settings are not enabled.');
      const selected = [];
      for (const candidate of candidates) {
        const id = ingestionDraftId({ vault: candidate.vault, source_id: candidate.source_id, revision: candidate.revision });
        const existing = await readIngestionDraft(ingestionDraftsDir, id);
        if (existing) {
          if (cfg.ingestion.autoFile && candidate.destination && existing.draft.destinations.includes(candidate.destination)) {
            try {
              const relationshipIndexes = (existing.draft.relationships || []).map((_, index) => index).slice(0, 12);
              const filed = await saveIngestionDraftRecord(cfg, id, candidate.destination, null, [], relationshipIndexes);
              if (filed.written && !filed.partial) record.filed++;
              else if (filed.written) record.waiting_review++;
              else record.waiting_review++;
            } catch { record.failed++; }
          } else record.already_pending++;
          continue;
        }
        if (selected.length < 5) selected.push(candidate);
      }
      record.attempted = selected.length; record.limited = Math.max(0, candidates.length - selected.length - record.already_pending);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      for (const candidate of selected) {
        try {
          const source = await readIngestionSource(ctx, candidate.vault, candidate.folder, { source_id: candidate.source_id, revision: candidate.revision });
          source.typed_entities = await typedEntitiesForIngestionSource(ctx, candidate.vault, source);
          const draft = await generateLocalIngestionDraft(source, cfg.sessions.localSummary.model, { fetchImpl: opts.ingestionDraftFetch || fetch });
          const related = await relatedText(ctx, draft.vault, `${draft.title}\n${draft.body}\n${redactText(source.body)}`, { excludePath: source.rel });
          draft.related_basis = 'source_and_draft';
          draft.related_notes = related.suggested
            .filter((item) => typeof item.path === 'string' && !/[\[\]]/.test(item.path) && Array.isArray(item.shared_terms))
            .slice(0, 8)
            .map((item) => ({ path: item.path, title: String(item.title || '').slice(0, 160), shared_terms: item.shared_terms.slice(0, 6).map((term) => String(term).slice(0, 50)), score: Number(item.score) || 0 }));
          draft.destinations = (await listSessionFilingFolders(ctx, draft.vault)).map((entry) => entry.path)
            .filter((folder) => folder && folder !== draft.folder && !folder.startsWith(`${draft.folder}/`)
              && !(folder === ctx.byName.get(draft.vault)?.intake_folder && ctx.byName.get(draft.vault)?.decisions?.length));
          const savedDraft = await saveIngestionDraft(ingestionDraftsDir, draft);
          record.created++;
          if (cfg.ingestion.autoFile && candidate.destination && draft.destinations.includes(candidate.destination)) {
            const relationshipIndexes = (draft.relationships || []).map((_, index) => index).slice(0, 12);
            const filed = await saveIngestionDraftRecord(cfg, savedDraft.id, candidate.destination, null, [], relationshipIndexes);
            if (filed.written && !filed.partial) record.filed++;
            else if (filed.written) record.waiting_review++;
            else record.waiting_review++;
          }
        } catch { record.failed++; }
      }
      record.ok = record.failed === 0;
    } catch { record.ok = false; record.failed = Math.max(1, record.failed); }
    const temp = `${ingestionDraftStatusFile}.${randomBytes(5).toString('hex')}.tmp`;
    await writeFile(temp, `${JSON.stringify(record)}\n`, { flag: 'wx' });
    await rename(temp, ingestionDraftStatusFile);
    ingestionDraftStatus = record;
    await logActivity(env, { tool: 'source_auto_draft', ok: record.ok });
    return record;
  }
  async function saveIngestionDraftRecord(cfg, id, destination, requestedRelated = null, entityChoices = [], relationChoices = [], dismissUnselectedEntities = false) {
    const stored = await readIngestionDraft(ingestionDraftsDir, id);
    const draft = stored?.draft;
    if (!draft) throw new Error('This local draft is missing or damaged. Prepare it again from the source queue.');
    const chosen = String(destination || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!chosen || !Array.isArray(draft.destinations) || !draft.destinations.includes(chosen)) throw new Error('Choose an existing knowledge folder outside the selected source folder.');
    if (stored.filing && stored.filing.destination !== chosen) throw new Error('This filing already saved its main note. Retry the remaining suggestions in the original destination.');
    const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
    const source = await readIngestionSource(ctx, draft.vault, draft.folder, { source_id: draft.source_id, revision: draft.revision });
    const availableFolders = new Set((await listSessionFilingFolders(ctx, draft.vault)).map((entry) => entry.path));
    if (!availableFolders.has(chosen)) throw new Error('The selected knowledge folder is no longer available in this vault.');
    if (!Array.isArray(entityChoices) || entityChoices.length > 8) throw new Error('Choose only entity suggestions shown in this draft.');
    if (new Set(entityChoices.map((choice) => choice?.index)).size !== entityChoices.length) throw new Error('An entity suggestion was selected more than once.');
    const savedEntities = new Set(stored.filing?.saved_entities || []);
    const savedChoices = (stored.filing?.entity_choices || []).filter((choice) => savedEntities.has(choice.index));
    const mergedChoices = new Map(savedChoices.map((choice) => [choice.index, choice]));
    for (const choice of entityChoices) {
      const previous = mergedChoices.get(choice?.index);
      if (previous && previous.scope !== choice.scope) throw new Error('An entity suggestion cannot be reassigned after it was saved.');
      mergedChoices.set(choice?.index, choice);
    }
    const effectiveEntityChoices = [...mergedChoices.values()];
    const effectiveRelationChoices = stored.filing?.relationship_indexes || relationChoices;
    if (!Array.isArray(effectiveEntityChoices) || effectiveEntityChoices.length > 8 || effectiveEntityChoices.some((choice) => !choice || !Number.isSafeInteger(choice.index) || choice.index < 0 || choice.index >= (draft.entities || []).length || !['personal', 'organisation', 'client'].includes(choice.scope))) throw new Error('Choose only entity suggestions shown in this draft and set a valid scope.');
    const uniqueIndexes = new Set(effectiveEntityChoices.map((choice) => choice.index));
    if (uniqueIndexes.size !== effectiveEntityChoices.length) throw new Error('An entity suggestion was selected more than once.');
    const selectedEntities = effectiveEntityChoices.map((choice) => ({ ...draft.entities[choice.index], index: choice.index, scope: choice.scope }));
    if (!Array.isArray(effectiveRelationChoices) || effectiveRelationChoices.length > 12 || effectiveRelationChoices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= (draft.relationships || []).length)) throw new Error('Choose only relationship suggestions shown in this draft.');
    const uniqueRelationIndexes = new Set(effectiveRelationChoices);
    if (uniqueRelationIndexes.size !== effectiveRelationChoices.length) throw new Error('A relationship suggestion was selected more than once.');
    const selectedRelationships = effectiveRelationChoices.map((index) => ({ ...draft.relationships[index], index }));
    const redactedSource = redactText(source.body);
    if (selectedEntities.some((entity) => !entity.evidence || !redactedSource.includes(entity.evidence))) throw new Error('An entity quote no longer matches the selected source. Prepare the draft again.');
    if (selectedRelationships.some((relationship) => !relationship.evidence || !redactedSource.includes(relationship.evidence))) throw new Error('A relationship quote no longer matches the selected source. Prepare the draft again.');
    let selectedPaths;
    if (stored.filing) selectedPaths = stored.filing.related_paths;
    else {
      const originalCandidates = new Set((draft.related_notes || []).map((item) => item.path));
      if (requestedRelated !== null && (!Array.isArray(requestedRelated) || requestedRelated.length > 5 || requestedRelated.some((item) => typeof item !== 'string'))) throw new Error('Choose up to five related-note suggestions from this draft.');
      selectedPaths = requestedRelated === null ? [...originalCandidates].slice(0, 3) : [...new Set(requestedRelated)];
      if (requestedRelated !== null && selectedPaths.length !== requestedRelated.length) throw new Error('A related-note suggestion was selected more than once.');
      const relatedNow = draft.related_basis === 'source_and_draft'
        ? await relatedText(ctx, draft.vault, `${draft.title}\n${draft.body}\n${redactText(source.body)}`, { excludePath: draft.source_path })
        : await relatedNotes(ctx, draft.vault, draft.source_path);
      const currentCandidates = new Set(relatedNow.suggested.map((item) => item.path));
      if (selectedPaths.some((item) => !originalCandidates.has(item) || !currentCandidates.has(item))) throw new Error('A related-note suggestion is no longer visible. Review the source and prepare the draft again.');
    }
    const relatedSection = selectedPaths.length
      ? `\n\n## Related notes (${requestedRelated === null ? 'automatic shared-term suggestions; unverified' : 'selected similarity suggestions; not verified facts'})\n${selectedPaths.map((item) => `- [[${item.replace(/\.md$/i, '')}]]`).join('\n')}`
      : '';
    const result = stored.filing ? { ok: true, written: true, path: `${draft.vault}/${stored.filing.note_path}` } : await proposeNote(ctx, {
      vault: draft.vault, folder: chosen, title: draft.title, body: `${draft.body}${relatedSection}`,
      type: 'note', memory_type: draft.memory_type, confidence: 'reported',
      source: `Local AI draft from ${draft.source_path}`,
      ai_platform: 'BrainLink Local Review', agent_or_role: 'Raw-to-Wiki draft',
      session_or_task_id: `ingestion-${draft.source_id.slice(0, 12)}`, confirm: true, auto_link: false,
    });
    if (!result.ok || !result.written) return { ...result, written: false, saved_as_proposal: false };
    const prefix = `${draft.vault}/`;
    const notePath = result.path.startsWith(prefix) ? result.path.slice(prefix.length) : '';
    if (!notePath) throw new Error('The saved note path could not be verified. The draft remains available for recovery.');
    let filing = stored.filing || { destination: chosen, note_path: notePath, related_paths: selectedPaths, entity_choices: selectedEntities.map(({ index, scope }) => ({ index, scope })), relationship_indexes: selectedRelationships.map(({ index }) => index), saved_entities: [], dismissed_entity_indexes: [], saved_relationships: [] };
    if (stored.filing) {
      filing = { ...filing, entity_choices: effectiveEntityChoices };
      await updateIngestionDraftFiling(ingestionDraftsDir, id, filing);
    }
    if (!stored.filing) {
      await updateIngestionDraftFiling(ingestionDraftsDir, id, filing);
    }
    await logActivity(env, { tool: 'source_proposal_saved', ok: true });
    const entityProposals = [];
    for (const entity of selectedEntities) {
      if (filing.saved_entities.includes(entity.index)) {
        entityProposals.push({ title: entity.title, path: 'already saved', status: 'proposed', verified: false, saved: true });
        continue;
      }
      const slug = entity.title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
      if (!slug) { entityProposals.push({ title: entity.title, errors: ['This entity title cannot be converted to a safe record ID.'] }); continue; }
      const entityId = `${entity.type}.${slug}`;
      const current = await loadVault(ctx, draft.vault);
      const existing = current.notes.find((note) => {
        if (note.private || note.generated) return false;
        const meta = parseFrontmatter(note.raw).meta;
        return meta.id === entityId && meta.type === entity.type && meta.scope === entity.scope && meta.status === 'proposed'
          && note.raw.includes(`> ${entity.evidence}`) && note.raw.includes(`[[${draft.source_path.replace(/\.md$/i, '')}]]`);
      });
      const entityResult = existing ? { ok: true, written: true, path: `${draft.vault}/${existing.rel}` } : await proposeNote(ctx, {
        vault: draft.vault, folder: chosen, title: entity.title,
        body: `## Description (AI draft; unverified)\n${entity.description}\n\n## Source evidence (exact quote; unverified)\n> ${entity.evidence}\n\n## Source\n[[${draft.source_path.replace(/\.md$/i, '')}]]\n\nReview this entity, its scope, and evidence before changing its status from proposed.`,
        type: entity.type, entity_id: entityId, entity_scope: entity.scope,
        memory_type: 'semantic', confidence: 'reported', source: `Exact quote from ${draft.source_path}`,
        ai_platform: 'BrainLink Local Review', agent_or_role: 'Raw-to-Wiki entity suggestion',
        session_or_task_id: `ingestion-${draft.source_id.slice(0, 12)}`, confirm: true, auto_link: false,
      });
      if (entityResult.ok && entityResult.written) {
        filing = { ...filing, saved_entities: [...new Set([...filing.saved_entities, entity.index])] };
        await updateIngestionDraftFiling(ingestionDraftsDir, id, filing);
        entityProposals.push({ title: entity.title, path: entityResult.path, status: 'proposed', verified: false });
      }
      else entityProposals.push({ title: entity.title, errors: entityResult.errors || ['Could not save this entity proposal.'] });
    }
    if (dismissUnselectedEntities === true) {
      const selectedIndexes = new Set(effectiveEntityChoices.map(({ index }) => index));
      const dismissed = (draft.entities || []).map((_, index) => index).filter((index) => !selectedIndexes.has(index));
      filing = { ...filing, dismissed_entity_indexes: [...new Set([...(filing.dismissed_entity_indexes || []), ...dismissed])] };
      await updateIngestionDraftFiling(ingestionDraftsDir, id, filing);
    }
    const relationProposals = [];
    const latestIndex = await loadVault(ctx, draft.vault);
    const visible = latestIndex.notes.filter((note) => !note.private && !note.generated);
    const entityMap = typedEntityMetadataMap(visible);
    for (const relationship of selectedRelationships) {
      if (filing.saved_relationships.includes(relationship.index)) {
        relationProposals.push({ subject: relationship.subject_title, predicate: relationship.predicate, target: relationship.target_title, path: 'already saved', review: 'proposed', verified: false });
        continue;
      }
      const subjectEntry = [...entityMap.entries()].find(([, meta]) => meta.entity_id === relationship.subject_id && meta.scope === relationship.scope);
      const targetEntry = [...entityMap.entries()].find(([, meta]) => meta.entity_id === relationship.target_id && meta.scope === relationship.scope);
      if (!subjectEntry || !targetEntry || subjectEntry[0] === targetEntry[0] || !typedRelationAllowed(relationship.predicate, subjectEntry[1].type, targetEntry[1].type)) {
        relationProposals.push({ predicate: relationship.predicate, errors: ['The graph records changed or are no longer compatible. Review the current graph and try again.'] });
        continue;
      }
      const subjectNote = subjectEntry[0];
      const full = safeJoin(vaultRoot(ctx, draft.vault), subjectNote.rel);
      const raw = await readFile(full, 'utf8');
      if (raw !== subjectNote.raw) {
        relationProposals.push({ predicate: relationship.predicate, errors: ['The graph record changed while saving. Reload it and review again.'] });
        continue;
      }
      let next;
      try { next = appendTypedRelationProposal(raw, { predicate: relationship.predicate, target_id: relationship.target_id, evidence: relationship.evidence, confidence: 0.5 }); }
      catch {
        const target = latestIndex.notes.findIndex((note) => {
          const meta = parseFrontmatter(note.raw).meta;
          return meta.id === relationship.target_id && meta.scope === relationship.scope && !note.private && !note.generated;
        });
        const source = latestIndex.notes.indexOf(subjectNote);
        const alreadySaved = deriveProposedTypedRelations(latestIndex.notes).some((edge) => edge.source === source && edge.target === target && edge.predicate === relationship.predicate && edge.evidence === relationship.evidence);
        if (alreadySaved) {
          filing = { ...filing, saved_relationships: [...new Set([...filing.saved_relationships, relationship.index])] };
          await updateIngestionDraftFiling(ingestionDraftsDir, id, filing);
          relationProposals.push({ subject: relationship.subject_title, predicate: relationship.predicate, target: relationship.target_title, path: subjectNote.rel, review: 'proposed', verified: false });
        } else relationProposals.push({ predicate: relationship.predicate, errors: ['This relationship is already present or is no longer valid.'] });
        continue;
      }
      const sourceLink = draft.source_path.replace(/\.md$/i, '');
      const linkLine = `- [[${sourceLink}]]`;
      if (!next.includes(linkLine)) next += `\n\n## BrainLink proposed relationship sources\n\n${linkLine}\n`;
      const temp = `${full}.brainlink-${randomBytes(6).toString('hex')}.tmp`;
      try { await writeFile(temp, next, 'utf8'); await rename(temp, full); }
      catch (error) { await unlink(temp).catch(() => {}); relationProposals.push({ predicate: relationship.predicate, errors: ['Could not save the relationship proposal.'] }); continue; }
      subjectNote.raw = next;
      filing = { ...filing, saved_relationships: [...new Set([...filing.saved_relationships, relationship.index])] };
      await updateIngestionDraftFiling(ingestionDraftsDir, id, filing);
      relationProposals.push({ subject: relationship.subject_title, predicate: relationship.predicate, target: relationship.target_title, path: subjectNote.rel, review: 'proposed', verified: false });
    }
    const resolvedEntities = new Set([...(filing.saved_entities || []), ...(filing.dismissed_entity_indexes || [])]);
    const entityReviewRemaining = (draft.entities || []).filter((_, index) => !resolvedEntities.has(index)).length;
    const partial = entityReviewRemaining > 0 || entityProposals.some((item) => !item.path) || relationProposals.some((item) => !item.path);
    if (!partial) {
      await recordIngestion(ctx, draft.vault, draft.folder, { source_id: draft.source_id, revision: draft.revision, outcome: 'filed', knowledge_path: notePath });
      await removeIngestionDraft(ingestionDraftsDir, id);
    }
    return { ok: true, written: true, partial, entity_review_remaining: entityReviewRemaining, saved_as_proposal: true, path: result.path, entity_proposals: entityProposals, relationship_proposals: relationProposals, note_status: 'proposed', confidence: 'reported', verified: false };
  }
  let ingestionTickRunning = false;
  const ingestionTimer = setInterval(async () => {
    if (ingestionTickRunning || ingestionRunning) return;
    ingestionTickRunning = true;
    try {
      const scheduled = await withConfigMutation(async () => {
        const cfg = await loadConfig(file);
        const now = new Date();
        if (!ingestionScheduleDue(cfg.ingestion, now, cfg.timezone)) return null;
        const localDate = localDateAndTime(now, cfg.timezone).date;
        const isRetry = Boolean(cfg.ingestion.retry_after)
          && (cfg.ingestion.mode === 'watch' || cfg.ingestion.retry_date === localDate);
        const attempt = isRetry ? (Number(cfg.ingestion.retry_count) || 1) + 1 : 1;
        // Reserve the next run before starting it, then retry failures at a bounded interval.
        if (!isRetry && cfg.ingestion.mode === 'watch') {
          cfg.ingestion.last_scan_at = now.toISOString();
          cfg.ingestion.retry_count = 0;
          cfg.ingestion.retry_date = null;
          cfg.ingestion.retry_after = null;
        } else if (!isRetry) {
          cfg.ingestion.last_scheduled_date = localDate;
          cfg.ingestion.retry_count = 0;
          cfg.ingestion.retry_date = null;
          cfg.ingestion.retry_after = null;
        }
        await saveConfig(cfg, file);
        return { cfg, localDate, attempt };
      });
      if (!scheduled) return;
      const { cfg, localDate, attempt } = scheduled;
      try {
        const trigger = cfg.ingestion.mode === 'watch' ? 'watch' : 'schedule';
        const result = await runIngestion(cfg, { trigger });
        if (!result.ok) throw new Error(result.error || 'One or more scan folders could not be read.');
        const latestBeforeDrafts = await loadConfig(file);
        const stillSameTargets = latestBeforeDrafts.ingestion?.enabled
          && (latestBeforeDrafts.ingestion?.mode || 'daily') === (cfg.ingestion?.mode || 'daily')
          && JSON.stringify(latestBeforeDrafts.ingestion?.targets || []) === JSON.stringify(cfg.ingestion?.targets || []);
        if (stillSameTargets && latestBeforeDrafts.ingestion.autoDrafts) {
          const currentTargets = new Map(latestBeforeDrafts.ingestion.targets.map((target) => [`${target.vault}\0${target.folder}`, target]));
          const currentCandidates = result.candidates.map((candidate) => ({
            ...candidate,
            destination: currentTargets.get(`${candidate.vault}\0${candidate.folder}`)?.destination || null,
          })).filter((candidate) => currentTargets.has(`${candidate.vault}\0${candidate.folder}`));
          const draftResult = await runScheduledIngestionDrafts(latestBeforeDrafts, currentCandidates, { trigger });
          if (!draftResult.ok) throw new Error('One or more scheduled local drafts failed.');
        }
        await withConfigMutation(async () => {
          const latest = await loadConfig(file);
          if (JSON.stringify(latest.ingestion?.targets || []) === JSON.stringify(cfg.ingestion?.targets || [])) {
            latest.ingestion.retry_count = 0;
            latest.ingestion.retry_date = null;
            latest.ingestion.retry_after = null;
            await saveConfig(latest, file);
          }
        });
      } catch (error) {
        const retryAt = await withConfigMutation(async () => {
          const latest = await loadConfig(file);
          const sameSchedule = latest.ingestion?.enabled
            && (latest.ingestion?.mode || 'daily') === (cfg.ingestion?.mode || 'daily')
            && Number(latest.ingestion?.intervalMinutes || 5) === Number(cfg.ingestion?.intervalMinutes || 5)
            && (latest.ingestion?.time || '02:00') === (cfg.ingestion?.time || '02:00')
            && Boolean(latest.ingestion?.autoDrafts) === Boolean(cfg.ingestion?.autoDrafts)
            && JSON.stringify(latest.ingestion?.targets || []) === JSON.stringify(cfg.ingestion?.targets || []);
          const retry = sameSchedule && attempt < (opts.ingestionMaxAttempts ?? INGESTION_MAX_ATTEMPTS)
            ? new Date(Date.now() + (opts.ingestionRetryMs ?? INGESTION_RETRY_DELAY_MS)).toISOString() : null;
          if (sameSchedule) {
            latest.ingestion.retry_count = attempt;
            latest.ingestion.retry_date = retry ? localDate : null;
            latest.ingestion.retry_after = retry;
            await saveConfig(latest, file);
          }
          return retry;
        });
        await saveIngestionStatus({ ...ingestionStatus, attempt, retry_after: retryAt }).catch(() => {});
        if (!ingestionStatus) throw error;
      }
    } catch (error) {
      if (!ingestionStatus?.at || ingestionStatus.trigger !== 'schedule') {
        await saveIngestionStatus({ ok: false, at: new Date().toISOString(), trigger: 'schedule', queued_total: 0, scanned: 0, skipped: 0, error: error.message || String(error) }).catch(() => {});
      }
    } finally { ingestionTickRunning = false; }
  }, opts.ingestionTickMs ?? 30_000);
  ingestionTimer.unref?.();
  function refreshIngestionSchedule(cfg) {
    ingestionKeepsAlive = Boolean(cfg.ingestion?.enabled);
    touch();
  }
  async function rsiBackupArtifacts() {
    const artifacts = [];
    // Validate the append-only journal before including it in an otherwise verified vault backup.
    await rsiLedger.list();
    const st = await lstat(rsiLedger.file).catch((e) => e.code === 'ENOENT' ? null : Promise.reject(e));
    if (st) {
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('RSI ledger backup refused: expected a regular local file.');
      artifacts.push({ name: 'rsi/ledger.jsonl', data: await readFile(rsiLedger.file) });
    }
    // Discovery preferences and receipts are private app data too. Preserve them in the
    // separately confirmed private backup, while restore remains an inspectable copy.
    const discoveryStat = await lstat(rsiDiscovery.file).catch((e) => e.code === 'ENOENT' ? null : Promise.reject(e));
    if (discoveryStat) {
      if (!discoveryStat.isFile() || discoveryStat.isSymbolicLink()) throw new Error('RSI discovery backup refused: expected a regular local file.');
      artifacts.push({ name: 'rsi/discovery.json', data: await readFile(rsiDiscovery.file) });
    }
    // The optional recurring observer stores only settings, aggregate reports and run status.
    // Preserve that privacy-safe record with the other RSI artifacts in the verified backup.
    const observationStat = await lstat(rsiObservationSchedule.file).catch((e) => e.code === 'ENOENT' ? null : Promise.reject(e));
    if (observationStat) {
      if (!observationStat.isFile() || observationStat.isSymbolicLink()) throw new Error('RSI observation backup refused: expected a regular local file.');
      artifacts.push({ name: 'rsi/observations.json', data: await readFile(rsiObservationSchedule.file) });
    }
    return artifacts;
  }
  async function runBackup(cfg, trigger = 'manual') {
    if (backupRunning) throw new Error('A backup is already running.');
    if (!cfg.backup?.folder) throw new Error('Choose a backup destination first.');
    backupRunning = true;
    try {
      const encryptionKey = cfg.backup.encrypted ? await requireBackupKey(env) : null;
      const result = await backupOnce(cfg.vaults, cfg.backup.folder, new Date(), await rsiBackupArtifacts(), { encryptionKey });
      const check = await verifyBackup(result.folder, encryptionKey);
      if (!check.ok) throw new Error(`Backup verification failed: ${check.errors.join('; ')}`);
      let retention;
      try { retention = await pruneBackups(cfg.backup.folder, cfg.backup.keepCount ?? 0, result.folder, encryptionKey); }
      catch { retention = { retained_count: null, removed_count: 0, warning: 'The new backup is verified, but old copies could not be cleaned up.' }; }
      backupStatus = { ok: true, ...result, trigger, encrypted: Boolean(encryptionKey), ...retention, at: new Date().toISOString() };
      await saveBackupStatus(backupStateFile, backupStatus);
      await logActivity(env, { tool: 'backup', ok: true });
      return backupStatus;
    } catch (error) {
      backupStatus = { ok: false, trigger, error: error.message || String(error), at: new Date().toISOString() };
      await saveBackupStatus(backupStateFile, backupStatus).catch(() => {});
      await logActivity(env, { tool: 'backup', ok: false });
      throw error;
    } finally { backupRunning = false; }
  }
  async function saveSyncReceipt(receipt) {
    syncStatus = receipt;
    await mkdir(path.dirname(syncStatusFile), { recursive: true });
    const temp = `${syncStatusFile}.${randomBytes(5).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try { await rename(temp, syncStatusFile); break; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 19) throw error;
          await delay(25);
        }
      }
    } catch (error) { await unlink(temp).catch(() => {}); throw error; }
  }
  function syncScheduleKey(settings) {
    return createHash('sha256').update(JSON.stringify({ provider: settings.provider, folder: settings.folder, vault: settings.vault, device: settings.device, scheduled: settings.scheduled, intervalHours: settings.intervalHours })).digest('hex');
  }
  async function runSyncTask(cfg, trigger = 'manual') {
    if (syncRunning) return { status: 'already-running', pushed: [], pulled: [], conflicts: [], sessions: 0 };
    syncRunning = true;
    try {
      const result = await runSync(cfg, env);
      await saveSyncReceipt({ at: new Date().toISOString(), trigger, status: result.status, config_key: syncScheduleKey(syncSettings(cfg)),
        pushed: result.pushed?.length || 0, pulled: result.pulled?.length || 0, conflicts: result.conflicts?.length || 0 });
      return result;
    } catch {
      await saveSyncReceipt({ at: new Date().toISOString(), trigger, status: 'failed', config_key: syncScheduleKey(syncSettings(cfg)), pushed: 0, pulled: 0, conflicts: 0 }).catch(() => {});
      return { status: 'failed', pushed: [], pulled: [], conflicts: [], sessions: 0 };
    } finally { syncRunning = false; }
  }
  function refreshSyncSchedule(cfg) {
    if (syncTimer) { clearTimeout(syncTimer); clearInterval(syncTimer); }
    syncTimer = null;
    const settings = syncSettings(cfg);
    syncKeepsAlive = Boolean(settings.provider !== 'local' && settings.scheduled);
    touch();
    if (!syncKeepsAlive) return;
    const interval = opts.syncIntervalMs ?? settings.intervalHours * 3600e3;
    const lastAttempt = syncStatus?.config_key === syncScheduleKey(settings) ? Date.parse(syncStatus?.at || '') : NaN;
    const firstDelay = Number.isFinite(lastAttempt) ? Math.max(0, interval - (Date.now() - lastAttempt)) : 0;
    const tick = async () => {
      if (syncTickRunning || syncRunning) return;
      syncTickRunning = true;
      try {
        const latest = await loadConfig(file);
        const current = syncSettings(latest);
        if (current.provider !== 'local' && current.scheduled) await runSyncTask(latest, 'schedule');
      } catch {
        await saveSyncReceipt({ at: new Date().toISOString(), trigger: 'schedule', status: 'failed', config_key: syncScheduleKey(settings), pushed: 0, pulled: 0, conflicts: 0 }).catch(() => {});
      } finally { syncTickRunning = false; }
    };
    syncTimer = setTimeout(() => {
      tick();
      syncTimer = setInterval(tick, interval);
      syncTimer.unref?.();
    }, firstDelay);
    syncTimer.unref?.();
  }
  function refreshBackupTimer(cfg) {
    if (backupTimer) { clearTimeout(backupTimer); clearInterval(backupTimer); }
    backupTimer = null;
    backupEnabled = Boolean(cfg.backup?.enabled);
    touch(); // scheduled backups must survive the app's ordinary inactivity timeout
    if (!cfg.backup?.enabled) return;
    if (cfg.backup.scheduleMode === 'daily') {
      const tick = async () => {
        if (backupTickRunning || backupRunning) return;
        backupTickRunning = true;
        try {
          const latest = await loadConfig(file);
          const now = new Date();
          const today = localDateAndTime(now, latest.timezone).date;
          if (backupStatus?.ok && backupStatus.trigger === 'schedule' && localDateAndTime(new Date(backupStatus.at), latest.timezone).date === today) {
            if (latest.backup.last_scheduled_date !== today) {
              latest.backup.last_scheduled_date = today;
              await saveConfig(latest, file);
            }
            return;
          }
          if (!backupScheduleDue(latest.backup, now, latest.timezone)) return;
          const lastAttempt = Date.parse(backupStatus?.at || '');
          if (backupStatus?.trigger === 'schedule' && !backupStatus.ok && Number.isFinite(lastAttempt) && Date.now() - lastAttempt < (opts.backupRetryMs ?? 15 * 60e3)) return;
          const receipt = await runBackup(latest, 'schedule');
          if (receipt.ok) {
            latest.backup.last_scheduled_date = localDateAndTime(new Date(receipt.at), latest.timezone).date;
            await saveConfig(latest, file);
          }
        } catch (error) {
          backupStatus = { ok: false, trigger: 'schedule', error: error.message || String(error), at: new Date().toISOString() };
          await saveBackupStatus(backupStateFile, backupStatus).catch(() => {});
        } finally { backupTickRunning = false; }
      };
      backupTimer = setInterval(tick, opts.backupTickMs ?? 30_000);
      tick();
      backupTimer.unref?.();
      return;
    }
    const interval = opts.backupIntervalMs ?? cfg.backup.intervalHours * 3600e3;
    const lastAttempt = Date.parse(backupStatus?.at || '');
    const firstDelay = Number.isFinite(lastAttempt) ? Math.max(0, interval - (Date.now() - lastAttempt)) : 0;
    const tick = async () => {
      if (backupTickRunning || backupRunning) return; // slow copies must not turn a good receipt into a spurious failure
      backupTickRunning = true;
      try {
        let latest;
        try { latest = await loadConfig(file); }
        catch (error) {
          backupStatus = { ok: false, error: error.message || String(error), at: new Date().toISOString() };
          await saveBackupStatus(backupStateFile, backupStatus).catch(() => {});
          return;
        }
        if (latest.backup.enabled) await runBackup(latest, 'schedule'); // runBackup saves its own success/failure receipt
      } catch { // a failed scheduled copy is already recorded by runBackup
      } finally { backupTickRunning = false; }
    };
    backupTimer = setTimeout(() => {
      tick();
      backupTimer = setInterval(tick, interval);
      backupTimer.unref?.();
    }, firstDelay);
    backupTimer.unref?.();
  }
  function refreshDiscoveryIdlePolicy(status) {
    discoveryKeepsAlive = Boolean(status?.settings.enabled && !status.settings.paused);
    touch();
  }
  function refreshObservationIdlePolicy(status) {
    observationKeepsAlive = Boolean(status?.settings.enabled);
    touch();
  }
  async function refreshSnapshotWatcher(cfg) {
    snapshotWatcher?.stop();
    snapshotWatcher = null;
    const settings = snapshotSettings(cfg);
    if (!settings.enabled) return;
    const ctx = localContext(cfg);
    if (!ctx.enabled.length) {
      // No vault left to watch (e.g. the last one was just removed) — still run one write so a
      // previously-synced snapshot's note copies are cleared from the destination folder, not
      // left there indefinitely with nothing left enabled to ever clean them up again.
      const result = await writeSnapshotOnce(ctx, cfg, env).catch((e) => ({ ok: false, error: e.message || String(e) }));
      await saveSnapshotStatus(snapshotStateFile, result.ok ? result : { ok: false, error: result.error || 'Add a folder first, then turn sharing on.' });
      return;
    }
    snapshotWatcher = startSnapshotWatcher(ctx, cfg, env, { onResult: (r) => saveSnapshotStatus(snapshotStateFile, r).catch(() => {}) });
    await snapshotWatcher.ready;
  }
  async function runDiscovery(trigger) {
    const run = await rsiDiscovery.run({ trigger });
    const { settings } = await rsiDiscovery.status();
    if (settings.refresh_existing && run.status !== 'paused') {
      run.source_refresh = await rsiDiscovery.refreshStaleSources();
      await rsiDiscovery.attachFreshnessReport(run.run_id, run.source_refresh);
    }
    return run;
  }
  // One cheap timer checks whether a scheduled discovery run is due. Enabled, unpaused discovery
  // disables the ordinary idle timeout; pausing or disabling it restores the normal app lifecycle.
  let discoveryTickRunning = false;
  const discoveryTimer = setInterval(async () => {
    if (discoveryTickRunning) return;
    discoveryTickRunning = true;
    try { if (await rsiDiscovery.due()) await runDiscovery('schedule'); }
    catch { /* run() records its own receipt; settings errors are shown in Setup */ }
    finally { discoveryTickRunning = false; }
  }, opts.discoveryTickMs ?? 15 * 60e3);
  discoveryTimer.unref?.();

  let observationTickRunning = false;
  const observationTimer = setInterval(async () => {
    if (observationTickRunning) return;
    observationTickRunning = true;
    try { if (await rsiObservationSchedule.due()) await rsiObservationSchedule.run('schedule'); }
    catch { /* aggregate-only observation failures stay in local status; never affect live behavior */ }
    finally { observationTickRunning = false; }
  }, opts.observationTickMs ?? 15 * 60e3);
  observationTimer.unref?.();
  if (await rsiObservationSchedule.due().catch(() => false)) rsiObservationSchedule.run('schedule').catch(() => {});

  let weeklyBenchmarkRunning = false;
  const weeklyBenchmarkSourceState = opts.weeklyBenchmarkSourceState || (() => readGitSourceState(ROOT));
  async function runWeeklyBenchmark(trigger = 'manual', week = null) {
    if (weeklyBenchmarkRunning) throw new Error('A weekly benchmark is already running.');
    weeklyBenchmarkRunning = true;
    try {
      const fixturePath = path.join(ROOT, 'samples', 'evaluation', 'rsi-weekly-fictional-20.json');
      const vaultPath = path.join(ROOT, 'samples', 'rsi-fictional-vault');
      const fixtureBytes = await readFile(fixturePath);
      const fixture = JSON.parse(fixtureBytes.toString('utf8'));
      if (fixture.vault !== 'RSI Fictional' || fixture.schema !== 2 || fixture.cases?.length !== 20) throw new Error('The built-in RSI benchmark fixture is invalid.');
      const cfg = await loadConfig(file);
      const benchmarkWeek = week || weeklyScheduleWeek(opts.weeklyBenchmarkNow?.() || new Date(), cfg.timezone);
      const ctx = createContext({ ...emptyConfig(), vaults: [{ name: fixture.vault, path: vaultPath }] }, { env: { ...env, BRAINLINK_SEMANTIC: '0' }, trustedLocal: true });
      const sourceState = weeklyBenchmarkSourceState();
      const result = await rsiWeekly.runBenchmark({ ctx, fixture, fixtureBytes, week: benchmarkWeek, softwareVersion: VERSION, sourceState, getSourceState: weeklyBenchmarkSourceState });
      return { ...result, trigger };
    } finally { weeklyBenchmarkRunning = false; }
  }
  let weeklyBenchmarkTickRunning = false;
  const weeklyBenchmarkTimer = setInterval(async () => {
    if (weeklyBenchmarkTickRunning || weeklyBenchmarkRunning) return;
    weeklyBenchmarkTickRunning = true;
    try {
      const cfg = await loadConfig(file);
      const now = opts.weeklyBenchmarkNow?.() || new Date();
      weeklyBenchmarkKeepsAlive = Boolean(cfg.weekly_benchmark?.enabled);
      if (!weeklyBenchmarkScheduleDue(cfg.weekly_benchmark, now, cfg.timezone)) return;
      cfg.weekly_benchmark = validateWeeklyBenchmarkSchedule({}, cfg.weekly_benchmark);
      cfg.weekly_benchmark.last_scheduled_week = weeklyScheduleWeek(now, cfg.timezone);
      cfg.weekly_benchmark.last_run_at = now.toISOString();
      cfg.weekly_benchmark.last_run_ok = null;
      await saveConfig(cfg, file);
      touch();
      try {
        await runWeeklyBenchmark('schedule', weeklyScheduleWeek(now, cfg.timezone));
        const latest = await loadConfig(file);
        latest.weekly_benchmark.last_run_ok = true;
        await saveConfig(latest, file);
      } catch {
        const latest = await loadConfig(file);
        latest.weekly_benchmark.last_run_ok = false;
        await saveConfig(latest, file).catch(() => {});
      }
    } catch { /* failures are reflected by a false last_run_ok when possible */ }
    finally { weeklyBenchmarkTickRunning = false; }
  }, opts.weeklyBenchmarkTickMs ?? 30_000);
  weeklyBenchmarkTimer.unref?.();
  refreshSnapshotWatcher(await loadConfig(file)).catch(() => {});
  const initialConfig = await loadConfig(file);
  refreshBackupTimer(initialConfig);
  refreshIngestionSchedule(initialConfig);
  refreshBriefSchedule(initialConfig);
  refreshSyncSchedule(initialConfig);
  refreshGitHubAutoSchedule(initialConfig);
  const eventClients = new Set();
  const vaultNoteCounts = new Map();
  const vaultNoteCountJobs = new Map();
  const sendVaultNoteCount = (name, result) => {
    const data = JSON.stringify({ vault: name, ...result });
    for (const client of eventClients) { try { client.write(`event: vault-counts-updated\ndata: ${data}\n\n`); } catch { eventClients.delete(client); } }
  };
  const scheduleVaultNoteCount = (name) => {
    if (vaultNoteCounts.has(name) || vaultNoteCountJobs.has(name)) return;
    vaultNoteCounts.set(name, { status: 'scanning' });
    const job = (async () => {
      try {
        const cfg = await loadConfig(file);
        const vault = cfg.vaults.find((v) => v.name === name);
        if (!vault || !await stat(vault.path).then((s) => s.isDirectory(), () => false)) throw new Error('Vault is unavailable');
        const ctx = localContext(cfg);
        const notes = await (opts.countVisibleNotes || countVisibleNotes)(ctx, name);
        const result = { status: 'ready', notes };
        vaultNoteCounts.set(name, result);
        sendVaultNoteCount(name, result);
      } catch {
        const result = { status: 'unavailable' };
        vaultNoteCounts.set(name, result);
        sendVaultNoteCount(name, result);
      } finally { vaultNoteCountJobs.delete(name); }
    })();
    vaultNoteCountJobs.set(name, job);
  };
  let vaultWatcher = null;
  const refreshVaultWatcher = (cfg) => {
    vaultWatcher?.stop();
    vaultWatcher = startVaultChangeWatcher(cfg.vaults, () => {
      for (const client of eventClients) { try { client.write('event: vault-changed\ndata: {}\n\n'); } catch { eventClients.delete(client); } }
    }, { debounceMs: opts.vaultWatchDebounceMs ?? 300, pollMs: opts.vaultWatchPollMs ?? 10000 });
  };
  refreshVaultWatcher(initialConfig);

  async function state() {
    const cfg = await loadConfig(file);
    const vaults = [];
    for (const v of cfg.vaults) {
      const ok = await stat(v.path).then((s) => s.isDirectory(), () => false);
      const excluded = ok ? await readExcludedFolders(v.path) : { active: [], suggested: [] };
      if (ok) scheduleVaultNoteCount(v.name);
      const count = vaultNoteCounts.get(v.name);
      vaults.push({ ...v, exists: ok, notes: ok ? count?.notes ?? null : 0, notes_status: ok ? count?.status ?? 'scanning' : 'missing', excluded_folders: excluded.active, excluded_suggestions: excluded.suggested });
    }
    return {
      version: VERSION, config_path: file, os, locale: cfg.locale,
      default_excluded_folders: DEFAULT_EXCLUDED_FOLDERS, suggested_excluded_folders: SUGGESTED_EXCLUDED_FOLDERS,
      vaults, agents: cfg.agents, ai_agents: cfg.ai_agents.map(publicAgent), handoff: cfg.handoff, timezone: cfg.timezone,
      twin_profiles: twinProfileStatus(cfg),
      github_assignments: await githubAssignmentStatus(cfg),
      github_auto_sync: githubAutoStatus,
      packs: Object.entries(PACKS).map(([id, p]) => ({ id, title: p.title, description: p.description })),
      clients: await detect(clientOpts()),
      agent_skills: Object.fromEntries(await Promise.all(['claude-code', 'codex', 'gemini', 'antigravity', 'antigravity-cli', 'hermes', 'deepseek-harness'].map(async (client) => [client, await inspectAgentSkills({ client, sourceRoot: path.join(ROOT, 'skills'), stateDir: appHome(env), home, env }).catch((error) => ({ supported: true, root: skillClientRoot(client, { home, env }), skills: [], error: error.message || String(error) }))]))),
      http: { port: cfg.http.port, token_set: Boolean(cfg.http.token) },
      activity: await readActivity(env, 15),
      semantic: await detectEmbedder(cfg, env),
      reranker: cfg.reranker,
      obsidian_vaults: (await findObsidianVaults({ home, os, env })).filter((o) => !cfg.vaults.some((v) => path.resolve(v.path) === path.resolve(o.path))),
      sync: (() => {
        const current = syncSettings(cfg);
        const recordedDrive = current.drive || cfg.vaults.find((vault) => vault.drive)?.drive || null;
        return { ...current, providers: PROVIDERS, provider_labels: PROVIDER_LABELS, suggested_folders: suggestFolders(home), gdrive_setup: linuxDriveSetup({ home, os, env, sync: { ...current, drive: recordedDrive, folder: current.folder || recordedDrive?.mount_path || null } }), status: syncStatus, running: syncRunning };
      })(),
      sessions_sharing: cfg.sessions,
      sessions_import_available: env.BRAINLINK_DISABLE_HISTORY_IMPORT !== '1',
      sessions_local_summary: cfg.sessions.localSummary,
      sessions_hermes_profile: { home: cfg.sessions.hermesHome, defaultHome: hermesDefaultRoot(home, env) },
      // P1a: imported sessions default to private, and a private session is invisible to every
      // connected AI while sessions.shareSummaries is off -- regardless of the "Show private
      // sessions" checkbox below, which only controls what this local Setup UI displays. Peeking
      // at a small page is enough to know "at least one exists"; the UI doesn't need the full list.
      sessions_has_private: ((await sessions.list({ include_private: true, limit: 20 }).catch(() => ({ sessions: [] }))).sessions || []).some((x) => x.private),
      snapshot: { ...snapshotSettings(cfg), suggested_folder: suggestSnapshotFolder(home), ...(await loadSnapshotStatus(snapshotStateFile)) },
      backup: { ...cfg.backup, status: backupStatus, running: backupRunning },
      ingestion: { ...cfg.ingestion, status: ingestionStatus, running: ingestionRunning },
      ingestion_drafts: { status: ingestionDraftStatus },
      weekly_benchmark: validateWeeklyBenchmarkSchedule({}, cfg.weekly_benchmark),
      brief: { ...cfg.brief, status: briefStatus, running: briefRunning },
      startup_at_login: ['win32', 'darwin', 'linux'].includes(os) ? await isStartupEnabled(env, home, os) : false,
    };
  }

  // Configure every AI app found on this computer that is not configured yet.
  // clientHealthCheck verifies BrainLink locally with the generated client token; it does not
  // launch the AI app or prove that app loaded the new configuration.
  async function connectAll(cfg) {
    if (cfg.twin_profiles?.length) return { connected: [], skipped: [], failed: ['Choose a Twin profile and permissions for each AI app before connecting it.'] };
    const found = await detect(clientOpts());
    const connected = [], skipped = [], failed = [];
    for (const [id, c] of Object.entries(found)) {
      if (!c.present || c.connected) continue;
      try {
        await connectClient(id, clientOpts());
        const health = await clientHealthCheck(id).catch((e) => ({ ok: false, message: e.message || String(e) }));
        if (!health.ok) { await disconnectClient(id, clientOpts()).catch(() => {}); throw new Error(health.message); }
        connected.push(c.title);
      } catch (e) { failed.push(`${c.title}: ${e.message}`); }
    }
    return { connected, skipped, failed, already: Object.values(found).filter((c) => c.connected).map((c) => c.title) };
  }

  // Verify BrainLink locally with the exact token and profile the client config will use. This is
  // deliberately not described as an external-client check: it does not launch the AI app or prove
  // that the app loaded the changed MCP config. Logs through the normal content-free activity log.
  async function clientHealthCheck(clientId, suppliedToken) {
    const c = resolveClient(clientId);
    if (!c) throw new Error(`Unknown client "${clientId}".`);
    const cfg = await loadConfig(file);
    const token = suppliedToken ?? await readClientAgentToken(clientId, clientOpts());
    const ctx = createContext(cfg, { env: { ...env, BRAINLINK_AGENT_TOKEN: token, BRAINLINK_AI_PLATFORM: c.platform, BRAINLINK_AGENT_ROLE: c.role } });
    if (ctx.twinScope.mode === 'unassigned') return {
      ok: false, verification: 'brainlink_local_mcp', external_client_verified: false, client: clientId, tool: null, took_ms: 0,
      message: 'This AI app has no Twin profile permission yet. Connect it through a named AI agent assigned to a Twin profile.',
    };
    if (!ctx.enabled.length) return { ok: false, verification: 'brainlink_local_mcp', external_client_verified: false, client: clientId, tool: null, took_ms: 0, message: 'Add a vault first, then check BrainLink access.' };
    const pending = [];
    const mcp = createMcp(ctx, { onCall: (e) => pending.push(logActivity(env, { ...e, platform: c.platform, mode: 'health-check' })) });
    const t0 = Date.now();
    await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    // Always inspect the exact tool list for this identity. Besides proving which data tool is
    // usable, this tells Setup which named BrainLink roles the connected AI can actually call.
    const listed = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listedTools = listed?.result?.tools || [];
    const toolNames = listedTools.map((item) => item.name);
    const available_agent_roles = listedTools
      .filter((item) => item.name.startsWith('agent_connect_'))
      .map((item) => String(item.title || '').replace(/^Connect to\s+/i, '').trim())
      .filter(Boolean);
    const tool = ctx.twinScope.mode === 'scoped' ? 'tools/list' : 'brainlink_guide';
    const expectedByAction = { search: 'vault_search', read_note: 'vault_read_note', read_session: 'session_list', log_session: 'session_log', propose_note: 'propose_note', handoff_read: 'list_handoffs', write_handoff: 'send_handoff' };
    const scopeHasLiveTool = ctx.twinScope.mode !== 'scoped' || ctx.twinScope.grants
      .filter((grant) => ctx.enabled.includes(grant.name))
      .flatMap((grant) => grant.operations)
      .some((action) => toolNames.includes(expectedByAction[action]));
    if (!scopeHasLiveTool) return {
      ok: false, verification: 'brainlink_local_mcp', external_client_verified: false, client: clientId, tool: null, took_ms: 0,
      message: 'This AI app has no usable tools under its selected Twin permissions. Review its memory and action settings.',
    };
    // For scoped identities, tools/list is the connection check. Calling vault_search here
    // used to scan/index a real vault just to show a green connection light, which could time
    // out on large vaults and read content the user did not ask to search. The authorized tool
    // list already proves that this token can see its granted tools and named role connectors.
    const args = {};
    const called = tool === 'tools/list' ? listed
      : await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: args } });
    await Promise.all(pending);
    const took_ms = Date.now() - t0;
    const ok = Boolean(called?.result) && !called.result.isError;
    const client_runtime = clientId === 'claude-desktop'
      ? await (opts.inspectClientRuntime || inspectClaudeDesktopRuntime)({ os, configPath: c.file(clientOpts()) }).catch(() => ({ status: 'unknown', started_before_config: null }))
      : undefined;
    const restartHint = client_runtime?.started_before_config === true
      ? ' Claude Desktop was already running when its BrainLink settings changed. Fully quit it (including the tray icon), reopen it, and start a new chat.'
      : client_runtime?.status === 'not_running'
        ? ' Claude Desktop is not running now. Open it and start a new chat to load BrainLink.'
        : '';
    return {
      ok, verification: 'brainlink_local_mcp', external_client_verified: false,
      client: clientId, tool, took_ms, available_agent_roles,
      ...(client_runtime ? { client_runtime } : {}),
      message: ok
        ? `BrainLink access check passed: ${tool} (${took_ms}ms); no vault notes were read.${available_agent_roles.length ? ` Named BrainLink roles available: ${available_agent_roles.join(', ')}.` : ''}${restartHint || ` Fully quit ${c.title} (including any tray/background process), reopen it, and start a new chat.`} This check does not confirm that the app loaded the updated tools.`
        : 'BrainLink access check failed; see Activity below.',
    };
  }

  // Give a built-in client its own revocable, profile-scoped identity. The token is written only
  // into that client's local MCP config; BrainLink stores its hash and never returns either in UI.
  async function connectPresetWithTwin(b) {
    const clientId = String(b.client || '');
    const client = resolveClient(clientId);
    if (!client) throw new Error('Choose a supported AI app.');
    const cfg = await loadConfig(file);
    const existingPresetAgent = cfg.ai_agents.find((item) => item.preset_client_id === clientId);
    const selections = Array.isArray(b.profiles) ? b.profiles : (b.profile_id ? [{ profile_id: b.profile_id, vaults: b.vaults, memory_policy: b.memory_policy }] : []);
    if (!selections.length) throw new Error('Choose at least one Twin profile.');
    if (new Set(selections.map((item) => item.profile_id)).size !== selections.length) throw new Error('A Twin profile can be selected only once.');
    const updates = [];
    const namesAcrossProfiles = new Set();
    for (const selection of selections) {
    const profile = cfg.twin_profiles.find((item) => item.id === String(selection.profile_id || ''));
    if (!profile) throw new Error('Choose existing Twin profiles.');
    const existingProfileGrant = existingPresetAgent && profile.agent_access.find((item) => item.agent_id === existingPresetAgent.id);
    const defaultAgentMemory = existingProfileGrant?.memory_policy || (existingProfileGrant ? profile.memory_policy : {
      working: false, semantic: profile.memory_policy.semantic === true,
      procedural: profile.memory_policy.procedural === true, episodic: profile.memory_policy.episodic === true,
    });
    const memory_policy = normalizeAgentMemoryPolicy(selection.memory_policy, profile.memory_policy, defaultAgentMemory);
    const requested = Array.isArray(selection.vaults) ? selection.vaults : [];
    if (!requested.length || requested.length > profile.vaults.length) throw new Error('Choose at least one vault for each selected Twin profile.');
    const seen = new Set();
    const grants = requested.map((item) => {
      const name = String(item?.name || '');
      const profileVault = profile.vaults.find((grant) => grant.name === name);
      const vault = cfg.vaults.find((entry) => entry.name === name);
      const operations = Array.isArray(item?.operations) ? [...new Set(item.operations)] : [];
      if (!profileVault || !vault || seen.has(name) || namesAcrossProfiles.has(name)) throw new Error('Choose available vaults only once across the selected Twin profiles.');
      if (!operations.length || operations.some((action) => !['search', 'read_note', 'read_session', 'log_session', 'propose_note', 'write_note', 'handoff_read', 'write_handoff'].includes(action))) throw new Error('Choose supported search, note, session, or handoff actions.');
      const needsSemantic = operations.some((action) => ['search', 'read_note', 'propose_note', 'write_note'].includes(action));
      const needsEpisodic = operations.includes('read_session');
      const needsWorking = operations.some((action) => ['handoff_read', 'write_handoff'].includes(action));
      if (needsSemantic && memory_policy.semantic !== true) throw new Error('Enable semantic memory for this AI before granting note or search access.');
      if ((needsEpisodic || operations.includes('log_session')) && memory_policy.episodic !== true) throw new Error('Enable episodic memory for this AI before granting session access.');
      if (needsWorking && memory_policy.working !== true) throw new Error('Enable working memory for this AI before granting handoff access.');
      if (operations.some((action) => ['handoff_read', 'write_handoff'].includes(action)) && cfg.handoff?.vault !== name) throw new Error('Handoff access is available only in the vault configured as BrainLink’s handoff mailbox.');
      if (operations.includes('write_note') && profileVault.access !== 'write') throw new Error('Choose full read and write access for a vault before granting note writes.');
      if (operations.some((action) => ['propose_note', 'write_handoff'].includes(action)) && !['propose', 'write'].includes(profileVault.access)) throw new Error('Choose propose or write access for a vault before allowing note proposals or handoffs.');
      seen.add(name);
      namesAcrossProfiles.add(name);
      return { name, access: operations.includes('write_note') ? 'write' : operations.some((action) => ['propose_note', 'write_handoff'].includes(action)) ? 'propose' : 'read', operations };
    });
    if (grants.some((grant) => grant.operations.includes('read_session')) && grants.some((grant) => !grant.operations.includes('read_session'))) throw new Error('Session history access applies across this Twin. Select session access for every vault granted to this AI, or remove the other vaults from its access.');
    if (grants.some((grant) => grant.operations.includes('log_session')) && grants.some((grant) => !grant.operations.includes('log_session'))) throw new Error('Private session logging applies across this Twin. Select it for every vault granted to this AI, or remove the other vaults from its access.');

    updates.push({ profile, memory_policy, grants });
    }

    let agent = cfg.ai_agents.find((item) => item.preset_client_id === clientId);
    const token = generateAgentToken();
    if (!agent) {
      const name = `BrainLink preset: ${clientId}`;
      if (cfg.ai_agents.some((item) => item.name.toLowerCase() === name.toLowerCase())) throw new Error('A manually created AI agent already uses BrainLink’s reserved name. Rename it before connecting this app.');
      agent = { id: `preset_${clientId}_${randomBytes(4).toString('hex')}`, name, kind: 'local', tokenHash: hashToken(token), connected: false, revoked: false, createdAt: new Date().toISOString(), lastSeenAt: null, preset_client_id: clientId };
      cfg.ai_agents.push(agent);
    } else {
      agent.tokenHash = hashToken(token);
      agent.connected = false;
      agent.revoked = false;
    }
    for (const item of cfg.twin_profiles) item.agent_access = (item.agent_access || []).filter((grant) => grant.agent_id !== agent.id);
    for (const { profile, memory_policy, grants } of updates) {
      profile.agent_access.push({ agent_id: agent.id, memory_policy, vaults: grants });
      profile.allowed_actions = [...new Set([...(profile.allowed_actions || []), ...grants.flatMap((grant) => grant.operations)])];
    }
    const validationErrors = validate(cfg);
    if (validationErrors.length) throw new Error(`These permissions cannot be saved: ${validationErrors[0]}`);

    const before = await loadConfig(file);
    const clientConfigFile = client.file(clientOpts());
    const previousClientConfig = await readFile(clientConfigFile, 'utf8').catch(() => null);
    await saveConfig(cfg, file);
    try {
      const connected = await connectClient(clientId, { ...clientOpts(), extraEnv: { BRAINLINK_AGENT_TOKEN: token } });
      const health = await clientHealthCheck(clientId, token);
      if (!health.ok) throw new Error(health.message);
      const latest = await loadConfig(file);
      await saveConfig(markConnected(latest, agent.id), file);
      return { ...connected, health, twin_profiles: updates.map((item) => item.profile.name) };
    } catch (error) {
      await saveConfig(before, file).catch(() => {});
      if (previousClientConfig !== null) await writeFile(clientConfigFile, previousClientConfig, 'utf8').catch(() => {});
      else await disconnectClient(clientId, clientOpts()).catch(() => {});
      throw new Error(`Could not check BrainLink access for ${client.title}; the previous permissions were restored. ${error.message || error}`);
    }
  }

  // Same local BrainLink check as clientHealthCheck, keyed by an agent's own token instead of a
  // preset app's env. Agents start out not connected; this is the only path that flips one to
  // connected, and only once the round trip actually succeeds with that exact token.
  async function agentHealthCheck(token) {
    const cfg = await loadConfig(file);
    const agent = findAgentByToken(cfg, token);
    if (!agent) return { ok: false, verification: 'brainlink_local_mcp', external_client_verified: false, agent: null, tool: null, took_ms: 0, message: 'That key was not recognized. It may have been revoked or mistyped.' };
    const ctx = createContext(cfg, { env: { ...env, BRAINLINK_AGENT_TOKEN: token } });
    if (!ctx.enabled.length) return { ok: false, verification: 'brainlink_local_mcp', external_client_verified: false, agent: agent.name, tool: null, took_ms: 0, message: 'Add a vault first, then check BrainLink access.' };
    const pending = [];
    const mcp = createMcp(ctx, { onCall: (e) => pending.push(logActivity(env, { ...e, platform: agent.name, mode: 'agent-check' })) });
    const t0 = Date.now();
    await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const called = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brainlink_guide', arguments: {} } });
    await Promise.all(pending);
    const took_ms = Date.now() - t0;
    const ok = Boolean(called?.result) && !called.result.isError;
    if (ok) await saveConfig(markConnected(cfg, agent.id), file);
    return {
      ok, verification: 'brainlink_local_mcp', external_client_verified: false,
      agent: agent.name, tool: 'brainlink_guide', took_ms,
      message: ok
        ? `BrainLink access check passed (${took_ms}ms). This only checks BrainLink; it does not confirm the AI app loaded its configuration.`
        : 'BrainLink access check failed; see Activity below.',
    };
  }

  // The one-click path: use an Obsidian vault, a folder, or a brand-new vault; then connect all AIs.
  async function quickStart(b, { connect = true } = {}) {
    const cfg = await loadConfig(file);
    let vaultPath;
    if (b.mode === 'new') {
      const docs = path.join(home, 'Documents');
      let n = 1;
      vaultPath = path.join(docs, 'My Brain');
      while (await stat(vaultPath).catch(() => null)) vaultPath = path.join(docs, `My Brain ${++n}`);
      await mkdir(vaultPath, { recursive: true });
    } else {
      vaultPath = path.resolve(String(b.path || '').replace(/^~(?=$|[\/\\])/, home));
      if (!(await stat(vaultPath).then((x) => x.isDirectory(), () => false))) return { ok: false, error: `Folder not found: ${vaultPath}` };
      const nested = await nestedVaults(vaultPath);
      if (nested.length > 1) return { ok: false, nested: nested.map((n) => ({ name: n, path: path.join(vaultPath, n) })), error: `This folder holds ${nested.length} separate vaults. Pick one so they stay separate.` };
      // A real, already-existing folder: ship the default excluded-folder list so personal/system
      // folders never reach search, answers, graph, sessions or sync. Never overrides a vault's
      // own .brainlinkignore if it already has one.
      await ensureDefaultIgnore(vaultPath);
    }
    const already = cfg.vaults.find((v) => path.resolve(v.path) === vaultPath);
    if (!already) {
      let name = path.basename(vaultPath);
      while (cfg.vaults.some((v) => v.name === name)) name += ' 2';
      const agentName = cfg.agents.some((a) => a.name === 'Brain') ? name : 'Brain';
      const built = buildPack('simple', { vaultName: name, vaultPath, agentName });
      await scaffold(vaultPath, built.scaffold);
      const next = mergePack(cfg, built);
      next.timezone ||= Intl.DateTimeFormat().resolvedOptions().timeZone;
      await saveConfig(next, file);
      refreshVaultWatcher(next);
      await refreshMap(next, name, env);
    }
    const saved = await loadConfig(file);
    const vault = saved.vaults.find((v) => path.resolve(v.path) === vaultPath);
    const agent = saved.agents.find((a) => a.vault === vault.name);
    return { ok: true, vault: vault.name, path: vault.path, phrase: agent?.activation[0], close: agent?.close[0], ...(connect ? await connectAll(saved) : { connected: [], skipped: [] }) };
  }

  const teachPreviews = new Map();
  const decisionReviewPreviews = new Map();
  const conflictReviewPreviews = new Map();
  const routes = {
    'GET /api/state': () => state(),
    'GET /api/updates/check': async () => checkForUpdate({
      publicKey: opts.updatePublicKey ?? UPDATE_PUBLIC_KEYS,
      currentVersion: VERSION,
      platform: os,
      arch: opts.arch || process.arch,
      fetchImpl: opts.updateFetch || fetch,
    }),
    'POST /api/updates/download': async () => {
      const download = await downloadVerifiedUpdate({
        publicKey: opts.updatePublicKey ?? UPDATE_PUBLIC_KEYS,
        currentVersion: VERSION,
        platform: os,
        arch: opts.arch || process.arch,
        fetchImpl: opts.updateFetch || fetch,
        tempRoot: opts.updateTempRoot,
      });
      const ticket = randomBytes(32).toString('base64url');
      const timer = setTimeout(() => {
        const pending = updateDownloads.get(ticket);
        updateDownloads.delete(ticket);
        if (pending) rm(pending.folder, { recursive: true, force: true }).catch(() => {});
      }, 5 * 60_000);
      timer.unref?.();
      updateDownloads.set(ticket, { ...download, timer, expiresAt: Date.now() + 5 * 60_000, opened: false });
      return { status: 'ready', version: download.version, filename: download.filename, format: download.format, size: download.size, sha256: download.sha256, ticket, download_url: `/api/updates/download/${ticket}?t=${encodeURIComponent(token)}` };
    },
    'POST /api/updates/open': async (b) => {
      const ticket = String(b?.ticket || '');
      if (!/^[A-Za-z0-9_-]{40,48}$/.test(ticket)) throw new Error('This verified update has expired. Check for updates and try again.');
      const pending = updateDownloads.get(ticket);
      if (!pending || pending.expiresAt <= Date.now()) throw new Error('This verified update has expired. Check for updates and try again.');
      if (pending.opened || pending.opening || pending.downloadInProgress) throw new Error('This package is already being opened or was already opened. Use its verified download link if you need another copy.');
      pending.opening = true;
      try {
        const file = await verifyStagedUpdate(pending);
        await (opts.updateLauncher || openUpdatePackage)({ file, format: pending.format, platform: os });
        pending.opened = true;
        retainUpdatePackage(ticket, pending);
        return { status: 'opened', version: pending.version, format: pending.format };
      } finally { pending.opening = false; }
    },
    'POST /api/reranker/test': async (b) => testReranker(validateRerankerSettings(b)),
    'POST /api/reranker/settings': async (b) => {
      const cfg = await loadConfig(file);
      const reranker = validateRerankerSettings(b);
      const next = { ...cfg, reranker };
      validate(next);
      await saveConfig(next, file);
      return { ok: true, reranker };
    },
    'GET /api/rsi': async () => ({ ideas: await rsiLedger.list() }),
    'GET /api/rsi/weekly-benchmark': async () => {
      const cfg = await loadConfig(file);
      return { runs: await rsiWeekly.benchmarkReport(8), schedule: validateWeeklyBenchmarkSchedule({}, cfg.weekly_benchmark) };
    },
    'POST /api/rsi/weekly-benchmark/settings': async (b) => {
      const cfg = await loadConfig(file);
      cfg.weekly_benchmark = validateWeeklyBenchmarkSchedule(b, cfg.weekly_benchmark);
      await saveConfig(cfg, file);
      weeklyBenchmarkKeepsAlive = cfg.weekly_benchmark.enabled;
      touch();
      return { schedule: cfg.weekly_benchmark };
    },
    'POST /api/rsi/weekly-benchmark/run': async () => {
      const run = await runWeeklyBenchmark('manual');
      const cfg = await loadConfig(file);
      return { run, runs: await rsiWeekly.benchmarkReport(8), schedule: validateWeeklyBenchmarkSchedule({}, cfg.weekly_benchmark) };
    },
    'GET /api/rsi/observations': async () => ({ observations: await rsiObservationSchedule.status() }),
    'POST /api/rsi/observations/settings': async (b) => {
      if (b?.vault_health_enabled === true) {
        const cfg = await loadConfig(file);
        const selected = cfg.vaults.find((vault) => vault.name === b.vault_health_vault);
        if (!selected || !await stat(selected.path).then((result) => result.isDirectory(), () => false)) throw new Error('Choose one available vault for link-health checks. The selected vault stays local and is not combined with another vault.');
      }
      let observations = await rsiObservationSchedule.configure(b);
      refreshObservationIdlePolicy(observations);
      // Give an enabled schedule its first observation promptly, then use the regular timer.
      if (await rsiObservationSchedule.due()) await rsiObservationSchedule.run('schedule');
      observations = await rsiObservationSchedule.status();
      return { observations };
    },
    'POST /api/rsi/observations/run': async () => ({ run: await rsiObservationSchedule.run('manual'), observations: await rsiObservationSchedule.status() }),
    'GET /api/rsi/export': async () => {
      const record = { schema: 1, exported_at: new Date().toISOString(), ideas: await rsiLedger.list() };
      return { ...record, sha256: createHash('sha256').update(JSON.stringify(record)).digest('hex') };
    },
    'POST /api/rsi/observations/analyze': async () => {
      const now = new Date();
      const report = analyzeActivitySignals(await readActivity(env, 20000), { now });
      const since = new Date(now.getTime() - 60 * 86400000).toISOString();
      attachRetrievalObservationSignals(report, await rsiWeekly.listRetrievalObservations({ since }), { now });
      return { report };
    },
    'GET /api/rsi/experiments': async () => {
      const cfg = await loadConfig(file);
      return { suites: rsiExperiments.suites({ rerankerEnabled: cfg.reranker.enabled }) };
    },
    'POST /api/rsi/experiments/run': async (b) => {
      const ideas = await rsiLedger.list();
      const idea = ideas.find((item) => item.id === b.idea_id);
      if (!idea) throw new Error('RSI idea not found.');
      if (idea.status !== 'testing') throw new Error('Move this RSI idea to testing before running an experiment.');
      const cfg = await loadConfig(file);
      const suite = rsiExperiments.suites({ rerankerEnabled: cfg.reranker.enabled }).find((item) => item.id === b.suite);
      if (!suite) throw new Error('Choose one of the built-in fictional evaluation suites.');
      if (idea.fields.candidate_version !== suite.candidate_version) throw new Error(`This test is for candidate ${suite.candidate_version}; update the RSI idea candidate version first.`);
      const receipt = await rsiExperiments.run(b.suite);
      return { idea: await rsiLedger.recordExperiment({ id: idea.id, expected_revision: idea.revision, receipt }) };
    },
    'POST /api/rsi/ideas/check': async (b) => ({ similar: await rsiLedger.similar(b) }),
    'POST /api/rsi/ideas': async (b) => ({ idea: await rsiLedger.create(b) }),
    'POST /api/rsi/ideas/update': async (b) => ({ idea: await rsiLedger.update(b) }),
    'POST /api/rsi/ideas/monitor': async (b) => ({ idea: await rsiLedger.recordMonitoring(b) }),
    'POST /api/rsi/ideas/rollback': async (b) => ({ idea: await rsiLedger.recordRollback(b) }),
    'GET /api/rsi/discovery': async () => ({ discovery: await rsiDiscovery.status() }),
    'POST /api/rsi/discovery/settings': async (b) => { const discovery = await rsiDiscovery.configure(b); refreshDiscoveryIdlePolicy(discovery); return { discovery }; },
    'POST /api/rsi/discovery/pause': async () => { const discovery = await rsiDiscovery.pause(); refreshDiscoveryIdlePolicy(discovery); return { discovery }; },
    'POST /api/rsi/discovery/resume': async () => { const discovery = await rsiDiscovery.resume(); refreshDiscoveryIdlePolicy(discovery); return { discovery }; },
    'POST /api/rsi/discovery/run': async () => ({ run: await runDiscovery('manual'), discovery: await rsiDiscovery.status() }),
    'POST /api/rsi/discovery/refresh-source': async (b) => ({ check: await rsiDiscovery.refreshSource(b.idea_id), discovery: await rsiDiscovery.status() }),
    'POST /api/pick-folder': async () => { const p = await pick(); return p === undefined ? { path: null, unavailable: true } : { path: p }; },
    'POST /api/quick': (b) => quickStart(b),
    'POST /api/quick/prepare': (b) => quickStart(b, { connect: false }),
    'POST /api/graph': async (b) => {
      const cfg = await loadConfig(file);
      const name = b.vault || cfg.vaults[cfg.vaults.length - 1]?.name;
      if (!name) return { nodes: [], edges: [] };
      const ctx = localContext(cfg, { ...env, BRAINLINK_VAULTS: name, BRAINLINK_SEMANTIC: '0' });
      const index = await loadVault(ctx, name);
      // Big vaults: show the 600 most-connected notes so the map stays readable.
      const deg = (i) => index.backlinks[i].size + index.outlinks[i].size;
      const keep = index.notes.map((n, i) => i).filter((i) => !index.notes[i].generated && !index.notes[i].minor && !index.notes[i].historical && !index.notes[i].private).sort((a, b) => deg(b) - deg(a)).slice(0, 600);
      const pos = new Map(keep.map((i, k) => [i, k]));
      const health = await vaultHealth(ctx, name);
      return {
        vault: name, shown: keep.length, health: { notes: health.notes, links: health.links, not_linked: health.orphan_count, broken: health.broken_count },
        nodes: keep.map((i) => ({ title: index.notes[i].title, group: index.notes[i].rel.includes('/') ? index.notes[i].rel.split('/')[0] : '', degree: index.backlinks[i].size + index.outlinks[i].size })),
        edges: index.edges.filter(([a, c]) => pos.has(a) && pos.has(c)).map(([a, c]) => [pos.get(a), pos.get(c)]),
      };
    },
    'POST /api/connect-all': async () => connectAll(await loadConfig(file)),
    'POST /api/vault': async (b) => {
      const cfg = await loadConfig(file);
      const vaultPath = path.resolve(String(b.path || '').replace(/^~(?=$|[\/\\])/, home));
      if (!(await stat(vaultPath).then((s) => s.isDirectory(), () => false))) throw new Error(`Folder not found: ${vaultPath}`);
      const name = String(b.name || path.basename(vaultPath)).trim();
      // A real vault folder: write the shipped default excluded-folder list (unless the caller
      // already chose one, e.g. from the "connect a vault" form), or keep an existing one as-is.
      if (Array.isArray(b.excludedFolders)) await writeExcludedFolders(vaultPath, b.excludedFolders);
      else await ensureDefaultIgnore(vaultPath);
      const built = buildPack(b.pack || 'simple', { vaultName: name, vaultPath, agentName: String(b.agentName || '').trim() || undefined });
      const drive = normalizeDriveSelection(b.drive);
      if (drive) built.vault.drive = drive;
      if (b.private !== undefined) built.vault.private = Boolean(b.private);
      const created = b.scaffold === false ? [] : await scaffold(vaultPath, built.scaffold);
      const next = mergePack(cfg, built, { moveHandoff: b.moveHandoff === true });
      if (!next.timezone) next.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await saveConfig(next, file);
      refreshVaultWatcher(next);
      await refreshMap(next, name, env);
      // Tell the owner when this vault's pack offered a mailbox but the existing one was kept.
      const handoffKept = Boolean(built.handoff && next.handoff && next.handoff.vault !== name);
      return { ok: true, vault: name, created, handoff_mailbox: next.handoff ? { vault: next.handoff.vault, folder: next.handoff.folder } : null, handoff_kept: handoffKept };
    },
    'POST /api/vault/remove': async (b) => {
      const next = await withConfigMutation(async () => {
        const cfg = await loadConfig(file);
        const updated = { ...cfg, vaults: cfg.vaults.filter((v) => v.name !== b.name), agents: cfg.agents.filter((a) => a.vault !== b.name), handoff: cfg.handoff?.vault === b.name ? null : cfg.handoff };
        if ((updated.ingestion?.targets || []).some((target) => target.vault === b.name)) {
          const targets = updated.ingestion.targets.filter((target) => target.vault !== b.name);
          updated.ingestion = { ...updated.ingestion, targets, vault: targets[0]?.vault || null, folder: targets[0]?.folder || null, enabled: Boolean(updated.ingestion.enabled && targets.length), last_scheduled_date: null, last_scan_at: null, retry_count: 0, retry_date: null, retry_after: null };
        }
        await saveConfig(updated, file);
        return updated;
      });
      refreshVaultWatcher(next);
      refreshIngestionSchedule(next);
      // S5: the snapshot watcher was started from whatever vault list existed at launch (or the
      // last /api/snapshot call) and otherwise runs for the life of this process — removing a
      // vault here must stop it from still syncing a now-gone folder until next restart.
      await refreshSnapshotWatcher(next);
      return { ok: true };
    },
    // Excluded folders and the private flag stay editable after connecting, not just at
    // first-connect time (Technical Reviewer's Mac-zip safety review).
    'POST /api/vault/excluded': async (b) => {
      const cfg = await loadConfig(file);
      const v = cfg.vaults.find((x) => x.name === b.name);
      if (!v) throw new Error(`Unknown vault "${b.name}".`);
      const folders = Array.isArray(b.folders) ? b.folders : String(b.folders || '').split(/\r?\n/);
      const active = await writeExcludedFolders(v.path, folders);
      return { ok: true, excluded_folders: active };
    },
    'POST /api/vault/private': async (b) => {
      const updated = await withConfigMutation(async () => {
        const cfg = await loadConfig(file);
        const v = cfg.vaults.find((x) => x.name === b.name);
        if (!v) throw new Error(`Unknown vault "${b.name}".`);
        v.private = Boolean(b.private);
        if (v.private && (cfg.ingestion?.targets || []).some((target) => target.vault === v.name)) {
          const targets = cfg.ingestion.targets.filter((target) => target.vault !== v.name);
          cfg.ingestion = { ...cfg.ingestion, targets, vault: targets[0]?.vault || null, folder: targets[0]?.folder || null, enabled: Boolean(cfg.ingestion.enabled && targets.length), last_scheduled_date: null, last_scan_at: null, retry_count: 0, retry_date: null, retry_after: null };
        }
        await saveConfig(cfg, file);
        return { cfg, isPrivate: v.private };
      });
      refreshIngestionSchedule(updated.cfg);
      // S5: a vault just marked private must stop being watched/synced into the shared snapshot
      // right away, not only after the app restarts (startSnapshotWatcher already skips private
      // vault roots — see src/snapshot.mjs — but only when it starts watching).
      await refreshSnapshotWatcher(updated.cfg);
      return { ok: true, private: updated.isPrivate };
    },
    'POST /api/sync': async (b) => {
      // Local by default; Drive/iCloud/Dropbox need an existing, writable folder (the user's own
      // desktop client syncs it — no API, no credentials). validateSync (src/sync/settings.mjs)
      // rejects anything else.
      const cfg = await loadConfig(file);
      const next = chooseSync(cfg, { provider: b.provider, folder: b.folder, vault: b.vault, scheduled: b.scheduled, intervalHours: b.intervalHours, device: b.device, drive: b.drive });
      await saveConfig(next, file);
      refreshSyncSchedule(next);
      return { ok: true, sync: syncSettings(next) };
    },
    'POST /api/sync/run': async () => {
      const cfg = await loadConfig(file);
      const result = await runSyncTask(cfg, 'manual');
      return { ok: result.status === 'ok' || result.status === 'local-only', result };
    },
    'POST /api/github/assignment/inspect': async (b) => {
      const cfg = await loadConfig(file);
      return inspectGitHubAssignment(cfg, b);
    },
    'POST /api/github/assignment/test-access': async (b) => {
      const cfg = await loadConfig(file);
      return testGitHubRepositoryAccess(cfg, b);
    },
    'POST /api/github/repository/clone': async (b) => {
      const cfg = await loadConfig(file);
      const profile = cfg.twin_profiles.find((item) => item.id === String(b.profile_id || ''));
      const vault = cfg.vaults.find((item) => item.name === String(b.vault || ''));
      if (!profile || !(profile.vaults || []).some((item) => item.name === vault?.name)) throw new Error('Choose one of this Twin profile\'s vaults first.');
      if (!vault || vault.private) throw new Error('Private or unavailable vaults cannot be connected to GitHub.');
      return cloneGitHubRepository({ ownerRepo: b.remote, home, reservedPaths: cfg.vaults.map((item) => item.path) });
    },
    'POST /api/github/assignment/pick-repository': async () => {
      const selected = await pickGitHubRepository();
      return selected === undefined ? { path: null, unavailable: true } : { path: selected || null };
    },
    'POST /api/github/assignment/set': async (b) => {
      const cfg = await loadConfig(file);
      const inspected = await inspectGitHubAssignment(cfg, b);
      if (inspected.blocked.length) throw new Error(inspected.blocked[0]);
      // The user must repeat the exact repository identity they reviewed; nothing is inferred.
      if (b.confirm_remote !== inspected.remote) throw new Error('Confirm the exact owner/repository shown in the review.');
      const profile = cfg.twin_profiles.find((item) => item.id === inspected.profile_id);
      profile.github_repository = { remote: inspected.remote, path: inspected.path, vault: inspected.vault, ...(inspected.folders.length ? { folders: inspected.folders } : {}), whole_vault: inspected.whole_vault, confirmed_at: new Date().toISOString() };
      await saveConfig(cfg, file);
      refreshGitHubAutoSchedule(cfg);
      return { ok: true, assignments: githubAssignmentProjection(cfg) };
    },
    'POST /api/github/assignment/clear': async (b) => {
      const cfg = await loadConfig(file);
      const profile = cfg.twin_profiles.find((item) => item.id === String(b.profile_id || ''));
      if (!profile) throw new Error('Choose an existing Twin profile.');
      delete profile.github_repository;
      await saveConfig(cfg, file);
      refreshGitHubAutoSchedule(cfg);
      return { ok: true, assignments: githubAssignmentProjection(cfg) };
    },
    'POST /api/github/automatic-sync': async (b) => {
      const cfg = await loadConfig(file);
      const profile = cfg.twin_profiles.find((item) => item.id === String(b.profile_id || ''));
      if (!profile?.github_repository) throw new Error('Assign and confirm a GitHub repository for this Twin first.');
      const enabled = b.enabled === true;
      const intervalHours = Number(b.intervalHours);
      if (![1, 6, 12, 24].includes(intervalHours)) throw new Error('Choose a 1, 6, 12 or 24 hour interval.');
      if (enabled && (b.confirm !== true || b.confirm_profile_id !== profile.id)) throw new Error('Confirm automatic publishing for the selected Twin and repository.');
      profile.github_repository.automatic_sync = { enabled, intervalHours, ...(enabled ? { confirmed_at: new Date().toISOString() } : {}) };
      await saveConfig(cfg, file);
      refreshGitHubAutoSchedule(cfg);
      return { ok: true, assignment: githubAssignmentProjection(cfg).find((item) => item.profile_id === profile.id), status: githubAutoStatus[profile.id] || null };
    },
    'POST /api/github/automatic-sync/run': async (b) => {
      const cfg = await loadConfig(file);
      const profile = cfg.twin_profiles.find((item) => item.id === String(b.profile_id || ''));
      if (!profile?.github_repository?.automatic_sync?.enabled) throw new Error('Turn on automatic GitHub sync for this Twin before running it.');
      return runGitHubAutoProfile(cfg, profile, 'manual');
    },
    'POST /api/twins/create': async (b) => {
      const cfg = await loadConfig(file);
      const name = String(b.name || '').trim();
      const owner = String(b.owner || '').trim();
      const mode = String(b.mode || '');
      if (!name || name.length > 120 || !owner || owner.length > 160 || !['personal', 'organisation', 'client'].includes(mode)) throw new Error('Enter a profile name and owner, then choose Personal, Organisation or Client.');
      const vaults = Array.isArray(b.vaults) ? b.vaults : [];
      if (!vaults.length || vaults.length > 50) throw new Error('Choose at least one available vault.');
      const profileVaults = [];
      for (const item of vaults) {
        const vault = cfg.vaults.find((entry) => entry.name === item?.name);
        if (!vault || !['read', 'propose', 'write'].includes(item?.access)) throw new Error('Twin profiles can use only available vaults, with read, propose, or write access.');
        profileVaults.push({ name: vault.name, access: item.access });
      }
      if (new Set(profileVaults.map((item) => item.name)).size !== profileVaults.length) throw new Error('Choose each vault only once.');
      const memory = b.memory_policy || {};
      const memory_policy = Object.fromEntries(TWIN_MEMORY_TYPES.map((key) => [key, memory[key] === true]));
      const allowedOperations = new Set(['search', 'read_note', 'read_session', 'log_session', 'propose_note', 'write_note', 'handoff_read', 'write_handoff']);
      const rawAgents = Array.isArray(b.agent_access) ? b.agent_access : [];
      const agentIds = new Set();
      const agentAccess = rawAgents.map((entry) => {
        const agent = cfg.ai_agents.find((item) => item.id === entry?.agent_id && !item.revoked);
        if (!agent || agentIds.has(agent.id)) throw new Error('Choose each active AI agent only once.');
        const requestedGrants = Array.isArray(entry?.vaults) ? entry.vaults : profileVaults.map(({ name }) => ({ name, operations: entry?.operations }));
        if (!requestedGrants.length) throw new Error('Choose at least one vault for each assigned AI agent.');
        const grantNames = new Set();
        const vaultGrants = requestedGrants.map((grant) => {
          const profileVault = profileVaults.find((vault) => vault.name === grant?.name);
          const operations = Array.isArray(grant?.operations) ? [...new Set(grant.operations)] : [];
          if (!profileVault || grantNames.has(profileVault.name) || !operations.length || operations.some((operation) => !allowedOperations.has(operation))) throw new Error('Each AI permission must name a selected vault and at least one supported action.');
          if (operations.some((operation) => ['handoff_read', 'write_handoff'].includes(operation)) && cfg.handoff?.vault !== profileVault.name) throw new Error('Handoff actions must use the configured BrainLink handoff vault.');
          if (operations.includes('write_note') && profileVault.access !== 'write') throw new Error('Choose full read and write access for a vault before granting note writes.');
          if (operations.some((operation) => ['propose_note', 'write_handoff'].includes(operation)) && !['propose', 'write'].includes(profileVault.access)) throw new Error('Choose propose or write access for a vault before allowing note proposals or handoff messages there.');
          grantNames.add(profileVault.name);
          return { name: profileVault.name, access: operations.includes('write_note') ? 'write' : operations.some((operation) => ['propose_note', 'write_handoff'].includes(operation)) ? 'propose' : 'read', operations };
        });
        if (vaultGrants.some((grant) => grant.operations.includes('read_session')) && vaultGrants.some((grant) => !grant.operations.includes('read_session'))) throw new Error('Session history access applies across this AI connection. Grant session access to every selected vault or remove the other vaults.');
        if (vaultGrants.some((grant) => grant.operations.includes('log_session')) && vaultGrants.some((grant) => !grant.operations.includes('log_session'))) throw new Error('Private session logging applies across this AI connection. Grant it for every selected vault or remove the other vaults.');
        agentIds.add(agent.id);
        return { agent_id: agent.id, memory_policy: normalizeAgentMemoryPolicy(entry.memory_policy, memory_policy), vaults: vaultGrants };
      });
      assertTwinActionsMatchMemory(agentAccess, memory_policy);
      const allowed_actions = [...new Set(agentAccess.flatMap((entry) => entry.vaults.flatMap((vault) => vault.operations)))];
      const profile = {
        id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'twin'}_${randomBytes(3).toString('hex')}`,
        name, mode, owner, vaults: profileVaults,
        source_policy: { private_default: true, provenance_required: true, session_capture: 'summary-proposal' },
        memory_policy, allowed_actions, agent_access: agentAccess,
      };
      const next = normalize({ ...cfg, twin_profiles: [...cfg.twin_profiles, profile] });
      const errors = validate(next);
      if (errors.length) throw new Error(`This Twin could not be saved: ${errors[0]}`);
      await saveConfig(next, file);
      return { ok: true, profile: twinProfileStatus(next).profiles.find((item) => item.id === profile.id) };
    },
    'POST /api/twins/update': async (b) => {
      const cfg = await loadConfig(file);
      const profile = cfg.twin_profiles.find((item) => item.id === String(b.profile_id || ''));
      if (!profile) throw new Error('Choose an existing Twin profile.');
      if (!profileScopeEditable(profile)) throw new Error('This Twin has invalid or duplicate per-vault AI permissions. Review its saved configuration before editing.');
      const name = String(b.name || '').trim();
      const owner = String(b.owner || '').trim();
      const mode = String(b.mode || '');
      if (!name || name.length > 120 || !owner || owner.length > 160 || !['personal', 'organisation', 'client'].includes(mode)) throw new Error('Enter a profile name and owner, then choose Personal, Organisation or Client.');
      if (mode !== profile.mode || owner !== profile.owner) throw new Error('A Twin’s type and owner cannot be changed after creation because stored sessions and handoffs belong to that identity.');
      const vaults = Array.isArray(b.vaults) ? b.vaults : [];
      if (!vaults.length || vaults.length > 50) throw new Error('Choose at least one available vault.');
      const profileVaults = [];
      for (const item of vaults) {
        const vault = cfg.vaults.find((entry) => entry.name === item?.name);
        if (!vault || !['read', 'propose', 'write'].includes(item?.access)) throw new Error('Twin profiles can use only available vaults, with read, propose, or write access.');
        profileVaults.push({ name: vault.name, access: item.access });
      }
      if (new Set(profileVaults.map((item) => item.name)).size !== profileVaults.length) throw new Error('Choose each vault only once.');
      const assignmentVault = profile.github_repository?.vault;
      if (assignmentVault && !profileVaults.some((item) => item.name === assignmentVault)) throw new Error('Clear this profile’s GitHub assignment before removing its assigned vault.');
      const memory = b.memory_policy || {};
      const memory_policy = Object.fromEntries(TWIN_MEMORY_TYPES.map((key) => [key, memory[key] === true]));
      const allowedOperations = new Set(['search', 'read_note', 'read_session', 'log_session', 'propose_note', 'write_note', 'handoff_read', 'write_handoff']);
      const rawAgents = Array.isArray(b.agent_access) ? b.agent_access : [];
      const agentIds = new Set();
      const agentAccess = rawAgents.map((entry) => {
        const agent = cfg.ai_agents.find((item) => item.id === entry?.agent_id && !item.revoked);
        if (!agent || agentIds.has(agent.id)) throw new Error('Choose each active AI agent only once.');
        const requestedGrants = Array.isArray(entry?.vaults) ? entry.vaults : profileVaults.map(({ name }) => ({ name, operations: entry?.operations }));
        if (!requestedGrants.length) throw new Error('Choose at least one vault for each assigned AI agent.');
        const grantNames = new Set();
        const vaultGrants = requestedGrants.map((grant) => {
          const profileVault = profileVaults.find((vault) => vault.name === grant?.name);
          const operations = Array.isArray(grant?.operations) ? [...new Set(grant.operations)] : [];
          if (!profileVault || grantNames.has(profileVault.name) || !operations.length || operations.some((operation) => !allowedOperations.has(operation))) throw new Error('Each AI permission must name a selected vault and at least one supported action.');
          if (operations.some((operation) => ['handoff_read', 'write_handoff'].includes(operation)) && cfg.handoff?.vault !== profileVault.name) throw new Error('Handoff actions must use the configured BrainLink handoff vault.');
          if (operations.includes('write_note') && profileVault.access !== 'write') throw new Error('Choose full read and write access for a vault before granting note writes.');
          if (operations.some((operation) => ['propose_note', 'write_handoff'].includes(operation)) && !['propose', 'write'].includes(profileVault.access)) throw new Error('Choose propose or write access for a vault before allowing note proposals or handoff messages there.');
          grantNames.add(profileVault.name);
          return { name: profileVault.name, access: operations.includes('write_note') ? 'write' : operations.some((operation) => ['propose_note', 'write_handoff'].includes(operation)) ? 'propose' : 'read', operations };
        });
        if (vaultGrants.some((grant) => grant.operations.includes('read_session')) && vaultGrants.some((grant) => !grant.operations.includes('read_session'))) throw new Error('Session history access applies across this AI connection. Grant session access to every selected vault or remove the other vaults.');
        if (vaultGrants.some((grant) => grant.operations.includes('log_session')) && vaultGrants.some((grant) => !grant.operations.includes('log_session'))) throw new Error('Private session logging applies across this AI connection. Grant it for every selected vault or remove the other vaults.');
        agentIds.add(agent.id);
        return { agent_id: agent.id, memory_policy: normalizeAgentMemoryPolicy(entry.memory_policy, memory_policy), vaults: vaultGrants };
      });
      assertTwinActionsMatchMemory(agentAccess, memory_policy);
      profile.name = name;
      profile.owner = owner;
      profile.mode = mode;
      profile.vaults = profileVaults;
      profile.memory_policy = memory_policy;
      profile.agent_access = agentAccess;
      profile.allowed_actions = [...new Set(agentAccess.flatMap((entry) => entry.vaults.flatMap((vault) => vault.operations)))];
      const next = normalize(cfg);
      const errors = validate(next);
      if (errors.length) throw new Error(`This Twin could not be saved: ${errors[0]}`);
      await saveConfig(next, file);
      return { ok: true, profile: twinProfileStatus(next).profiles.find((item) => item.id === profile.id) };
    },
    'POST /api/github/share-candidates': async (b) => {
      const cfg = await loadConfig(file);
      const vaultName = String(b.vault || '');
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      return { vault: vaultName, notes: await listGitHubShareCandidates(ctx, vaultName, String(b.profile_id || '')) };
    },
    'POST /api/github/preview': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      return previewGitHubRepository({ ctx, repoPath: String(b.repository || ''), vaultName: String(b.vault || ''), paths: b.paths, profileId: String(b.profile_id || '') });
    },
      'POST /api/github/commit-selected': async (b) => {
        const cfg = await loadConfig(file);
        const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
        return commitGitHubSelectedNotes({ ctx, repoPath: String(b.repository || ''), vaultName: String(b.vault || ''), paths: b.paths, profileId: String(b.profile_id || '') });
      },
      'POST /api/github/push-selected': async (b) => {
        const cfg = await loadConfig(file);
        const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
        return pushGitHubSelectedNotes({ ctx, repoPath: String(b.repository || ''), vaultName: String(b.vault || ''), paths: b.paths, commit: String(b.commit || ''), profileId: String(b.profile_id || '') });
      },
      'POST /api/github/pull-candidates': async (b) => {
        const cfg = await loadConfig(file);
        const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
        return listGitHubPullCandidates({ ctx, repoPath: String(b.repository || ''), vaultName: String(b.vault || ''), profileId: String(b.profile_id || '') });
      },
      'POST /api/github/import-selected': async (b) => {
        const cfg = await loadConfig(file);
        const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
        return importGitHubSelectedNotes({ ctx, repoPath: String(b.repository || ''), vaultName: String(b.vault || ''), paths: b.paths, profileId: String(b.profile_id || '') });
      },
    'POST /api/github/save-conflict-copies': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      return saveGitHubConflictCopies({ ctx, repoPath: String(b.repository || ''), vaultName: String(b.vault || ''), paths: b.paths, profileId: String(b.profile_id || '') });
    },
    'POST /api/agent': async (b) => {
      const cfg = await loadConfig(file);
      const a = cfg.agents.find((x) => x.name === b.name);
      if (!a) throw new Error(`Unknown agent ${b.name}`);
      const clean = (arr) => (Array.isArray(arr) ? arr : String(arr || '').split('\n')).map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
      if (b.role !== undefined) a.role = String(b.role).slice(0, 600);
      if (b.activation !== undefined && clean(b.activation).length) a.activation = clean(b.activation);
      if (b.close !== undefined && clean(b.close).length) a.close = clean(b.close);
      if (b.capture_approved !== undefined) a.capture_approved = Boolean(b.capture_approved);
      await saveConfig(cfg, file);
      return { ok: true, agent: a };
    },
    'POST /api/agent/add': async (b) => {
      const cfg = await loadConfig(file);
      const name = String(b.name || '').trim();
      const vault = String(b.vault || '').trim();
      if (!name || name.length > 120 || /[\\/:\r\n]/.test(name)) throw new Error('Enter a role name up to 120 characters without slashes or colons.');
      if (cfg.agents.some((agent) => agent.name.toLowerCase() === name.toLowerCase())) throw new Error(`An agent named "${name}" already exists.`);
      const targetVault = cfg.vaults.find((item) => item.name === vault);
      if (!targetVault || targetVault.private) throw new Error('Choose an existing non-private vault for this role.');
      const captureFile = `${name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')} Session Captures.md`;
      const agent = {
        name,
        vault,
        role: `Assistant for ${vault}: answer from its notes and prepare safe, evidence-backed proposals within the user's instructions.`,
        activation: [`Connect to ${name}`, name],
        close: [`${name} close loop`, `${name}, close the loop`],
        connect_notes: [],
        tail_notes: [],
        recent_dir: null,
        stale_days: 14,
        capture_approved: false,
        close_target: { mode: 'append-section', path: captureFile },
      };
      const next = { ...cfg, agents: [...cfg.agents, agent] };
      await saveConfig(next, file);
      return { ok: true, agent };
    },
    'POST /api/agent/remove': async (b) => {
      const cfg = await loadConfig(file);
      const name = String(b.name || '').trim();
      if (!cfg.agents.some((agent) => agent.name === name)) throw new Error(`Unknown agent "${name}".`);
      await saveConfig({ ...cfg, agents: cfg.agents.filter((agent) => agent.name !== name) }, file);
      return { ok: true };
    },
    'POST /api/connect': async (b) => {
      const cfg = await loadConfig(file);
      if (cfg.twin_profiles?.length) return connectPresetWithTwin(b);
      // connectClient refuses undetected apps. A write with no verified handshake is not a real
      // connection, so an unhealthy check undoes the write instead of reporting Connected.
      const r = await connectClient(b.client, clientOpts());
      const health = await clientHealthCheck(b.client).catch((e) => ({ ok: false, client: b.client, tool: null, took_ms: 0, message: e.message || String(e) }));
      if (!health.ok) { await disconnectClient(b.client, clientOpts()).catch(() => {}); throw new Error(`Could not verify ${r.title}: ${health.message}`); }
      return { ...r, health };
    },
    'POST /api/client-health': (b) => clientHealthCheck(b.client),
    'POST /api/skills/install': async (b) => {
      const clients = await detect(clientOpts());
      const connectedClient = b.client === 'antigravity-cli' ? 'antigravity' : b.client;
      const namedHarnessConnected = b.client === 'deepseek-harness'
        && Object.entries(clients).some(([id, client]) => id.startsWith('deepseek-harness@') && client.connected);
      if (!clients[String(connectedClient || '')]?.connected && !namedHarnessConnected) throw new Error('Connect this AI first.');
      return installAgentSkills({ client: b.client, sourceRoot: path.join(ROOT, 'skills'), stateDir: appHome(env), home, env });
    },
    'POST /api/skills/remove': async (b) => removeAgentSkills({ client: b.client, stateDir: appHome(env), home, env }),
    'POST /api/disconnect': async (b) => {
      const cfg = await loadConfig(file);
      const managed = cfg.ai_agents.find((agent) => agent.preset_client_id === String(b.client || ''));
      if (managed) {
        const revoked = revokeAgent(cfg, managed.id);
        for (const profile of revoked.twin_profiles) profile.agent_access = (profile.agent_access || []).filter((grant) => grant.agent_id !== managed.id);
        await saveConfig(revoked, file);
      }
      return disconnectClient(b.client, clientOpts());
    },
    // Normalized {ok,message} check (connectors.mjs `test`): same detect() the buttons above
    // already use, re-shaped for callers that want one consistent result instead of each
    // function's own shape (see connectors.mjs for why /api/connect keeps its richer shape).
    'POST /api/client-test': (b) => test(b.client, clientOpts()),
    'POST /api/locale': async (b) => {
      const locale = String(b.locale || '').trim();
      if (!LOCALES.includes(locale)) throw new Error(`Unknown locale "${locale}".`);
      const cfg = await loadConfig(file);
      await saveConfig({ ...cfg, locale }, file);
      return { ok: true, locale };
    },
    'POST /api/http-token': async () => {
      const cfg = await loadConfig(file);
      const t = randomBytes(24).toString('hex');
      await saveConfig({ ...cfg, http: { ...cfg.http, token: t } }, file);
      return { ok: true, url: `http://127.0.0.1:${cfg.http.port}/mcp`, token: t, start: 'brainlink serve --http' };
    },
    // ---- Agents: any number of user-added AI connections, on top of the preset apps above ----
    'POST /api/agents/add': async (b) => {
      const cfg = await loadConfig(file);
      const { cfg: next, agent, token } = addAgent(cfg, { name: b.name, kind: b.kind });
      await saveConfig(next, file);
      const snippet = agent.kind === 'remote' ? remoteAgentSnippet(agent, token, cfg.http.port) : localAgentSnippet(agent, token, launchSpec(env));
      return { ok: true, agent: publicAgent(agent), token, snippet };
    },
    'POST /api/agents/rename': async (b) => {
      const cfg = await loadConfig(file);
      const next = renameAgent(cfg, b.id, b.name);
      await saveConfig(next, file);
      return { ok: true, agent: publicAgent(next.ai_agents.find((a) => a.id === b.id)) };
    },
    'POST /api/agents/remove': async (b) => {
      const cfg = await loadConfig(file);
      await saveConfig(removeAgent(cfg, b.id), file);
      return { ok: true };
    },
    'POST /api/agents/revoke': async (b) => {
      const cfg = await loadConfig(file);
      const next = revokeAgent(cfg, b.id);
      await saveConfig(next, file);
      return { ok: true, agent: publicAgent(next.ai_agents.find((a) => a.id === b.id)) };
    },
    // Runs the same live round trip as /api/client-health, keyed by the agent's own key instead
    // of a preset app's env; the only path that marks an agent Connected.
    'POST /api/agents/test': (b) => agentHealthCheck(String(b.token || '')),
    // ---- 3D notes graph: nodes/edges plus one note's panel (Markdown, tags, links) ----
    'POST /api/graph3d': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!ctx.enabled.length) return { nodes: [], links: [], shown: 0, total: 0 };
      const selected = b.vault && ctx.enabled.includes(b.vault) ? b.vault : undefined;
      const includePrivateVault = Boolean(selected && ctx.byName.get(selected)?.private);
      return buildGraph3D(ctx, selected, { includePrivateVault });
    },
    'POST /api/graph3d/vaults': async () => {
      const cfg = await loadConfig(file);
      return listGraphVaults(localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' }), { includePrivateVaults: true });
    },
    'POST /api/memory/review': async (b) => {
      const cfg = await loadConfig(file);
      return readMemoryForReview(localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' }), String(b.vault || ''));
    },
    'POST /api/memory/save': async (b) => {
      const cfg = await loadConfig(file);
      return saveMemoryForReview(localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' }), String(b.vault || ''), b.text, b.etag);
    },
    'GET /api/proposals': async () => ({ proposals: (await proposalInbox.listPending()).map(({ id, vault, path: rel, content, tool, agent, agent_verified, created_at }) => ({ id, vault, path: rel, content, tool, agent, agent_verified, created_at })) }),
    'POST /api/decision-reviews/list': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      const vault = String(b.vault || '');
      if (!ctx.enabled.includes(vault)) throw new Error('Choose an enabled vault.');
      const reviews = await listDecisionReviews(ctx, vault, { limit: 50 });
      return { reviews };
    },
    'POST /api/decision-reviews/preview': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0', BRAINLINK_AI_PLATFORM: 'BrainLink Setup' });
      const vault = String(b.vault || ''), rel = String(b.path || ''), action = String(b.action || '');
      if (!ctx.enabled.includes(vault)) throw new Error('Choose an enabled vault.');
      if (!['still_stands', 'changed', 'retire'].includes(action)) throw new Error('Choose a supported decision review action.');
      const note = await readDecisionReview(ctx, vault, rel);
      const oldTitle = String(note.body?.match(/^# (.+)$/m)?.[1] || path.posix.basename(rel, '.md'));
      let reviewDate;
      if (action === 'still_stands') {
        reviewDate = String(b.review_date || '');
        if (!validReviewDate(reviewDate) || reviewDate <= new Date().toISOString().slice(0, 10)) throw new Error('Choose a valid future review date.');
      }
      let newNote = null, newNoteArgs = null;
      if (action === 'changed') {
        const title = String(b.new_title || '').trim(), body = String(b.body || '').trim();
        if (!title || !body) throw new Error('Enter the updated decision title and body.');
        newNoteArgs = { vault, folder: path.posix.dirname(rel) === '.' ? '.' : path.posix.dirname(rel), title,
          type: 'decision', template: null, body: `${body}\n\nReplaces the earlier decision [[${oldTitle}]] (${rel}).`, review_date: validReviewDate(String(b.review_date || '')) ? String(b.review_date) : undefined,
          status: 'active', confidence: 'reported', source: `Owner-reviewed change to ${rel}`, ai_platform: 'BrainLink Setup', agent_or_role: 'owner', session_or_task_id: 'decision-review-owner', auto_link: false };
        newNote = await proposeNote(ctx, newNoteArgs);
        if (!newNote.ok || !newNote.preview) throw new Error((newNote.errors || ['Could not prepare the updated decision note.']).join(' '));
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const append = action === 'still_stands' ? `\nDecision reviewed: ${stamp} — still stands.\nReview rescheduled: ${reviewDate}\n`
        : action === 'retire' ? `\nDecision retired: ${stamp}\n`
          : `\nDecision changed: ${stamp}.\nsuperseded_by: [[${String(b.new_title).trim()}]]\n`;
      const original = await readFile(safeJoin(vaultRoot(ctx, vault), rel));
      const id = randomBytes(24).toString('base64url');
      decisionReviewPreviews.set(id, { vault, rel, action, append, expected_hash: createHash('sha256').update(original).digest('hex'), newNote, newNoteArgs, expires_at: Date.now() + 15 * 60_000 });
      return { id, vault, path: rel, action, append_preview: append, ...(newNote ? { new_note_preview: newNote.preview, new_note_path: newNote.path } : {}), expires_in_minutes: 15 };
    },
    'POST /api/decision-reviews/confirm': async (b) => {
      if (b.confirm !== true) throw new Error('Review the complete append and any new decision note before confirming.');
      const preview = decisionReviewPreviews.get(String(b.id || ''));
      if (!preview || preview.expires_at < Date.now()) throw new Error('This decision review preview expired. Prepare it again.');
      decisionReviewPreviews.delete(String(b.id));
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0', BRAINLINK_AI_PLATFORM: 'BrainLink Setup' });
      const full = safeJoin(vaultRoot(ctx, preview.vault), preview.rel);
      const current = await readFile(full);
      if (createHash('sha256').update(current).digest('hex') !== preview.expected_hash) throw new Error('The decision changed after preview. Refresh and review it again.');
      let newPath = null;
      if (preview.newNote) {
        const saved = await proposeNote(ctx, { ...preview.newNoteArgs, confirm: true });
        if (!saved.ok || saved.written !== true) throw new Error((saved.errors || ['Updated decision could not be saved.']).join(' '));
        newPath = saved.path;
      }
      await appendTo(vaultRoot(ctx, preview.vault), preview.rel, preview.append);
      await logActivity(env, { tool: 'decision_review', ok: true });
      return { ok: true, path: `${preview.vault}/${preview.rel}`, new_note_path: newPath, action: preview.action };
    },
    'POST /api/conflicts/list': async (b) => {
      const cfg = await loadConfig(file), ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      const vault = String(b.vault || '');
      if (!ctx.enabled.includes(vault)) throw new Error('Choose an enabled vault.');
      const offset = b.offset === undefined ? 0 : b.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error('Conflict review offset is invalid.');
      const result = await listConflictCandidates(ctx, vault, { dismissed: await conflictReviewStore.dismissed(), limit: 50, offset });
      return result;
    },
    'POST /api/conflicts/preview': async (b) => {
      const cfg = await loadConfig(file), ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      const vault = String(b.vault || ''), candidateId = String(b.candidate_id || ''), choice = String(b.choice || '');
      if (!ctx.enabled.includes(vault)) throw new Error('Choose an enabled vault.');
      if (!['a_stands', 'b_stands', 'both_valid', 'not_conflict'].includes(choice)) throw new Error('Choose a supported conflict resolution.');
      const result = await listConflictCandidates(ctx, vault, { dismissed: await conflictReviewStore.dismissed(), limit: 50 });
      const candidate = result.candidates.find((item) => item.id === candidateId);
      if (!candidate) throw new Error('This candidate is no longer visible. Refresh the list.');
      const winner = choice === 'a_stands' ? candidate.a : choice === 'b_stands' ? candidate.b : null;
      const loser = winner ? (winner.path === candidate.a.path ? candidate.b : candidate.a) : null;
      const append = winner ? `\n\n## BrainLink proposed supersession\n\n- superseded_by: [[${winner.title}]]\n- Review status: proposed\n- Reason: owner selected this note as the current record for a possible conflict with [[${loser.title}]].\n` : null;
      const id = randomBytes(24).toString('base64url');
      conflictReviewPreviews.set(id, { vault, candidate, choice, winner, loser, append, expires_at: Date.now() + 15 * 60_000 });
      return { id, candidate, choice, proposal_preview: append, expires_in_minutes: 15 };
    },
    'POST /api/conflicts/confirm': async (b) => {
      if (b.confirm !== true) throw new Error('Review the proposed action before confirming.');
      const id = String(b.id || ''), preview = conflictReviewPreviews.get(id);
      if (!preview || preview.expires_at < Date.now()) throw new Error('This conflict review preview expired. Refresh the list.');
      conflictReviewPreviews.delete(id);
      const cfg = await loadConfig(file), ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      const latest = await listConflictCandidates(ctx, preview.vault, { dismissed: await conflictReviewStore.dismissed(), limit: 50 });
      if (!latest.candidates.some((item) => item.id === preview.candidate.id)) throw new Error('This candidate changed or is no longer visible. Refresh the list.');
      let proposal_id = null;
      if (preview.winner && preview.loser) {
        const full = safeJoin(vaultRoot(ctx, preview.vault), preview.loser.path);
        const current = await readFile(full);
        const proposal = await proposalInbox.add({ vault: preview.vault, vaultPath: ctx.byName.get(preview.vault).path, path: preview.loser.path,
          content: preview.append, tool: 'conflict_review', agent: 'owner', action: 'append', expectedHash: createHash('sha256').update(current).digest('hex') });
        if (!proposal) throw new Error('The supersession proposal was not queued. No vault note was changed.');
        proposal_id = proposal.id;
      }
      await conflictReviewStore.dismiss(preview.candidate.id);
      await logActivity(env, { tool: 'conflict_review', ok: true });
      return { ok: true, proposal_id, dismissed: true, choice: preview.choice };
    },
    'POST /api/proposals/approve': async (b) => {
      if (b.confirm !== true) throw new Error('Review the full draft, then explicitly approve it.');
      const proposal = await proposalInbox.getPending(String(b.id || ''));
      if (!proposal) throw new Error('This proposal is no longer pending. Refresh the review list.');
      const cfg = await loadConfig(file);
      const vault = cfg.vaults.find((item) => item.name === proposal.vault);
      if (!vault || vault.writes === 'off') throw new Error('This destination is missing or read-only; the proposal was not saved.');
      const currentRoot = await realpath(vault.path).catch(() => null);
      if (!currentRoot || createHash('sha256').update(currentRoot.toLocaleLowerCase()).digest('hex') !== proposal.vault_ref) throw new Error('The vault location changed since this proposal was created. Review a fresh proposal before saving.');
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      let result;
      if (proposal.action === 'append') {
        const root = vaultRoot(ctx, proposal.vault);
        let full = await checkWritePath(root, proposal.path);
        await mkdir(path.dirname(full), { recursive: true });
        full = await checkWritePath(root, proposal.path);
        let existing = null;
        try { existing = await readFile(full); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const currentHash = existing === null ? null : createHash('sha256').update(existing).digest('hex');
        if (currentHash !== proposal.expected_hash) throw new Error('The destination changed after this draft was prepared. Refresh and review a new draft before appending.');
        if (existing === null) {
          try { await writeFile(full, `${proposal.header || ''}${proposal.content}`, { flag: 'wx' }); }
          catch (error) { if (error.code === 'EEXIST') throw new Error('The destination changed after review began. Refresh and review a new draft before appending.'); throw error; }
        } else await appendTo(root, proposal.path, proposal.content);
        result = { ok: true, written: true, path: `${proposal.vault}/${proposal.path}` };
      } else {
        result = await commitNew(ctx, proposal.vault, proposal.path, proposal.content, true, { ownerApproved: true });
        if (!result.ok || !result.written) throw new Error((result.errors || ['The proposal could not be saved.']).join(' '));
      }
      await proposalInbox.resolve(proposal.id, 'approved');
      await logActivity(env, { tool: 'proposal_approved', ok: true });
      return { ok: true, path: result.path };
    },
    'POST /api/proposals/reject': async (b) => {
      if (b.confirm !== true) throw new Error('Confirm that you want to discard this draft.');
      const proposal = await proposalInbox.getPending(String(b.id || ''));
      if (!proposal) throw new Error('This proposal is no longer pending. Refresh the review list.');
      await proposalInbox.resolve(proposal.id, 'rejected');
      await logActivity(env, { tool: 'proposal_rejected', ok: true });
      return { ok: true };
    },
    'POST /api/graph3d/reviews': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (b.vault && !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const offset = b.offset === undefined ? 0 : b.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error('Review queue offset is invalid.');
      return listProposedTypedRelations(ctx, { vault: b.vault, offset });
    },
    'POST /api/graph3d/discover': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (b.vault && !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      return discoverVaultRelationshipCandidates(ctx, { vault: b.vault, offset: b.offset ?? 0, limit: 20, scanId: b.scan_id });
    },
    'POST /api/graph3d/note': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const includePrivateVault = Boolean(ctx.byName.get(b.vault)?.private);
      const detail = await noteDetail3D(ctx, b.vault, String(b.path || ''), { includePrivateVault });
      const raw = await readFile(safeJoin(vaultRoot(ctx, b.vault), detail.path), 'utf8');
      const vaultPath = path.resolve(ctx.byName.get(b.vault).path);
      const obsidianVault = obsidianVaultForPath(vaultPath, await findObsidianVaults({ home, os, env }));
      const obsidian_url = obsidianVault ? obsidianOpenUrl(obsidianVault, detail.path, vaultPath) : null;
      return { ...detail, etag: createHash('sha256').update(raw).digest('hex'), writable: !ctx.readOnly && ctx.byName.get(b.vault).writes === 'on', obsidian_registered: Boolean(obsidian_url), obsidian_url };
    },
    'POST /api/graph3d/note/preview': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const rel = String(b.path || '');
      const note = await readNote(ctx, b.vault, rel);
      const raw = await readFile(safeJoin(vaultRoot(ctx, b.vault), note.path), 'utf8');
      return {
        vault: b.vault, path: note.path, title: path.posix.basename(note.path).replace(/\.md$/i, ''),
        body: note.body, tags: extractTags(note.body, note.meta), graph_record: typedEntityFields(raw),
        etag: createHash('sha256').update(raw).digest('hex'),
        writable: !ctx.readOnly && ctx.byName.get(b.vault).writes === 'on',
      };
    },
    'POST /api/graph3d/note/save': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const vault = ctx.byName.get(b.vault);
      if (ctx.readOnly || vault.writes !== 'on') throw new Error('This vault does not allow direct edits.');
      const rel = String(b.path || '');
      const current = await readNote(ctx, b.vault, rel); // privacy, ignore, index and path checks run before write
      const index = await loadVault(ctx, b.vault);
      const noteIndex = index.byRel.get(current.path);
      if (noteIndex === undefined || index.notes[noteIndex].generated) throw new Error('Generated notes cannot be edited here.');
      if (typeof b.body !== 'string' || Buffer.byteLength(b.body, 'utf8') > 90000) throw new Error('Note body is missing or too large.');
      const full = safeJoin(vaultRoot(ctx, b.vault), current.path);
      const raw = await readFile(full, 'utf8');
      const etag = createHash('sha256').update(raw).digest('hex');
      if (typeof b.etag !== 'string' || b.etag !== etag) throw new Error('This note changed since it was opened. Reload it before saving.');
      const header = /^(\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n)/.exec(raw)?.[1] || '';
      const next = header + b.body;
      const tmp = `${full}.brainlink-${randomBytes(6).toString('hex')}.tmp`;
      try { await writeFile(tmp, next, 'utf8'); await rename(tmp, full); }
      catch (e) { try { await (await import('node:fs/promises')).unlink(tmp); } catch {} throw e; }
      return { ok: true, etag: createHash('sha256').update(next).digest('hex') };
    },
    'POST /api/graph3d/entity/save': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const vault = ctx.byName.get(b.vault);
      if (vault.private) throw new Error('Graph records in a private vault cannot be edited in the shared graph.');
      if (ctx.readOnly || vault.writes !== 'on') throw new Error('This vault does not allow graph record edits.');
      const current = await readNote(ctx, b.vault, String(b.path || ''));
      const index = await loadVault(ctx, b.vault);
      const noteIndex = index.byRel.get(current.path);
      if (noteIndex === undefined || index.notes[noteIndex].generated) throw new Error('This record cannot be edited.');
      const full = safeJoin(vaultRoot(ctx, b.vault), current.path);
      const raw = await readFile(full, 'utf8');
      const etag = createHash('sha256').update(raw).digest('hex');
      if (typeof b.etag !== 'string' || b.etag !== etag) throw new Error('This note changed since it was opened. Reload it before saving.');
      const next = updateTypedEntityFields(raw, b.graph_record);
      const fields = typedEntityFields(next);
      if (fields.id && index.notes.some((note, i) => i !== noteIndex && !note.private && !note.generated && typedEntityFields(note.raw).id === fields.id)) {
        throw new Error('That graph ID is already used by another visible note in this vault. Choose a unique ID.');
      }
      const tmp = `${full}.brainlink-${randomBytes(6).toString('hex')}.tmp`;
      try { await writeFile(tmp, next, 'utf8'); await rename(tmp, full); }
      catch (error) { await unlink(tmp).catch(() => {}); throw error; }
      await logActivity(env, { tool: 'graph_entity_edit', ok: true });
      return { ok: true, etag: createHash('sha256').update(next).digest('hex'), graph_record: fields };
    },
    'POST /api/graph3d/relationship/approve': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const vault = ctx.byName.get(b.vault);
      if (vault.private) throw new Error('Relationships in a private vault cannot be reviewed in the shared graph.');
      if (ctx.readOnly || vault.writes !== 'on') throw new Error('This vault does not allow relationship review.');
      const current = await readNote(ctx, b.vault, String(b.path || ''));
      const index = await loadVault(ctx, b.vault);
      const sourceIndex = index.byRel.get(current.path);
      if (sourceIndex === undefined || index.notes[sourceIndex].generated) throw new Error('This record cannot be reviewed.');
      if (!Number.isSafeInteger(b.relation_index) || b.relation_index < 0) throw new Error('Invalid relationship selection.');
      const relationIndex = b.relation_index;
      const candidate = deriveProposedTypedRelations(index.notes).find((edge) => edge.source === sourceIndex && edge.relation_index === relationIndex);
      if (!candidate) throw new Error('That relationship is no longer an eligible suggestion. Reload the note and review it again.');
      const full = safeJoin(vaultRoot(ctx, b.vault), current.path);
      const raw = await readFile(full, 'utf8');
      const etag = createHash('sha256').update(raw).digest('hex');
      if (typeof b.etag !== 'string' || b.etag !== etag) throw new Error('This note changed since it was opened. Reload it before reviewing the relationship.');
      const next = approveTypedRelation(raw, relationIndex);
      const tmp = `${full}.brainlink-${randomBytes(6).toString('hex')}.tmp`;
      try { await writeFile(tmp, next, 'utf8'); await rename(tmp, full); }
      catch (e) { try { await unlink(tmp); } catch {} throw e; }
      await logActivity(env, { tool: 'graph_relationship_review', ok: true, action: 'approved' });
      return { ok: true, etag: createHash('sha256').update(next).digest('hex') };
    },
    'POST /api/graph3d/relationship/reject': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const vault = ctx.byName.get(b.vault);
      if (vault.private) throw new Error('Relationships in a private vault cannot be reviewed in the shared graph.');
      if (ctx.readOnly || vault.writes !== 'on') throw new Error('This vault does not allow relationship review.');
      const current = await readNote(ctx, b.vault, String(b.path || ''));
      const index = await loadVault(ctx, b.vault);
      const sourceIndex = index.byRel.get(current.path);
      if (sourceIndex === undefined || index.notes[sourceIndex].generated) throw new Error('This record cannot be reviewed.');
      if (!Number.isSafeInteger(b.relation_index) || b.relation_index < 0) throw new Error('Invalid relationship selection.');
      const relationIndex = b.relation_index;
      const candidate = deriveProposedTypedRelations(index.notes).find((edge) => edge.source === sourceIndex && edge.relation_index === relationIndex);
      if (!candidate) throw new Error('That relationship is no longer an eligible suggestion. Reload the note and review it again.');
      const full = safeJoin(vaultRoot(ctx, b.vault), current.path);
      const raw = await readFile(full, 'utf8');
      const etag = createHash('sha256').update(raw).digest('hex');
      if (typeof b.etag !== 'string' || b.etag !== etag) throw new Error('This note changed since it was opened. Reload it before reviewing the relationship.');
      const next = rejectTypedRelation(raw, relationIndex);
      const tmp = `${full}.brainlink-${randomBytes(6).toString('hex')}.tmp`;
      try { await writeFile(tmp, next, 'utf8'); await rename(tmp, full); }
      catch (e) { try { await unlink(tmp); } catch {} throw e; }
      await logActivity(env, { tool: 'graph_relationship_review', ok: true, action: 'rejected' });
      return { ok: true, etag: createHash('sha256').update(next).digest('hex') };
    },
    'POST /api/graph3d/relationship/reopen': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const vault = ctx.byName.get(b.vault);
      if (vault.private) throw new Error('Relationships in a private vault cannot be reviewed in the shared graph.');
      if (ctx.readOnly || vault.writes !== 'on') throw new Error('This vault does not allow relationship review.');
      const current = await readNote(ctx, b.vault, String(b.path || ''));
      const index = await loadVault(ctx, b.vault);
      const sourceIndex = index.byRel.get(current.path);
      if (sourceIndex === undefined || index.notes[sourceIndex].generated) throw new Error('This record cannot be reviewed.');
      if (!Number.isSafeInteger(b.relation_index) || b.relation_index < 0) throw new Error('Invalid relationship selection.');
      const relationIndex = b.relation_index;
      const wasVerified = deriveTypedRelations(index.notes).some((edge) => edge.source === sourceIndex && edge.relation_index === relationIndex);
      const wasRejected = deriveRejectedTypedRelations(index.notes).some((edge) => edge.source === sourceIndex && edge.relation_index === relationIndex);
      const wasWithdrawn = deriveWithdrawnTypedRelations(index.notes).some((edge) => edge.source === sourceIndex && edge.relation_index === relationIndex);
      if (!wasVerified && !wasRejected && !wasWithdrawn) throw new Error('That relationship is no longer eligible to return to review. Reload the note and review it again.');
      const full = safeJoin(vaultRoot(ctx, b.vault), current.path);
      const raw = await readFile(full, 'utf8');
      const etag = createHash('sha256').update(raw).digest('hex');
      if (typeof b.etag !== 'string' || b.etag !== etag) throw new Error('This note changed since it was opened. Reload it before reviewing the relationship.');
      const next = reopenTypedRelation(raw, relationIndex, wasWithdrawn ? 'withdrawn' : wasVerified ? 'verified' : 'rejected');
      const tmp = `${full}.brainlink-${randomBytes(6).toString('hex')}.tmp`;
      try { await writeFile(tmp, next, 'utf8'); await rename(tmp, full); }
      catch (e) { try { await unlink(tmp); } catch {} throw e; }
      await logActivity(env, { tool: 'graph_relationship_review', ok: true, action: 'reopened' });
      return { ok: true, etag: createHash('sha256').update(next).digest('hex') };
    },
    'POST /api/graph3d/relationship/archive': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const vault = ctx.byName.get(b.vault);
      if (vault.private) throw new Error('Relationships in a private vault cannot be changed in the shared graph.');
      if (ctx.readOnly || vault.writes !== 'on') throw new Error('This vault does not allow relationship changes.');
      const current = await readNote(ctx, b.vault, String(b.path || ''));
      const index = await loadVault(ctx, b.vault);
      const sourceIndex = index.byRel.get(current.path);
      if (sourceIndex === undefined || index.notes[sourceIndex].generated) throw new Error('This record cannot be changed.');
      if (!Number.isSafeInteger(b.relation_index) || b.relation_index < 0) throw new Error('Invalid relationship selection.');
      const relationIndex = b.relation_index;
      const isVerified = deriveTypedRelations(index.notes).some((edge) => edge.source === sourceIndex && edge.relation_index === relationIndex);
      const expectedReview = isVerified ? 'verified' : deriveProposedTypedRelations(index.notes).some((edge) => edge.source === sourceIndex && edge.relation_index === relationIndex)
        ? 'proposed' : deriveRejectedTypedRelations(index.notes).some((edge) => edge.source === sourceIndex && edge.relation_index === relationIndex) ? 'rejected' : null;
      if (!expectedReview) throw new Error('That relationship is no longer active. Reload the note and review it again.');
      const full = safeJoin(vaultRoot(ctx, b.vault), current.path);
      const raw = await readFile(full, 'utf8');
      const etag = createHash('sha256').update(raw).digest('hex');
      if (typeof b.etag !== 'string' || b.etag !== etag) throw new Error('This note changed since it was opened. Reload it before changing the relationship.');
      const next = withdrawTypedRelation(raw, relationIndex, expectedReview);
      const tmp = `${full}.brainlink-${randomBytes(6).toString('hex')}.tmp`;
      try { await writeFile(tmp, next, 'utf8'); await rename(tmp, full); }
      catch (e) { try { await unlink(tmp); } catch {} throw e; }
      await logActivity(env, { tool: 'graph_relationship_review', ok: true, action: 'archived' });
      return { ok: true, etag: createHash('sha256').update(next).digest('hex') };
    },
    'POST /api/graph3d/relationship/edit': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const vault = ctx.byName.get(b.vault);
      if (vault.private) throw new Error('Relationships in a private vault cannot be changed in the shared graph.');
      if (ctx.readOnly || vault.writes !== 'on') throw new Error('This vault does not allow relationship changes.');
      const current = await readNote(ctx, b.vault, String(b.path || ''));
      const index = await loadVault(ctx, b.vault);
      const sourceIndex = index.byRel.get(current.path);
      if (sourceIndex === undefined || index.notes[sourceIndex].generated) throw new Error('This record cannot be changed.');
      if (!Number.isSafeInteger(b.relation_index) || b.relation_index < 0) throw new Error('Invalid relationship selection.');
      const relationIndex = b.relation_index;
      const matches = [
        ['verified', deriveTypedRelations(index.notes)],
        ['proposed', deriveProposedTypedRelations(index.notes)],
        ['rejected', deriveRejectedTypedRelations(index.notes)],
      ];
      const expectedReview = matches.find(([, edges]) => edges.some((edge) => edge.source === sourceIndex && edge.relation_index === relationIndex))?.[0];
      if (!expectedReview) throw new Error('That relationship is no longer active. Reload the note and review it again.');
      const full = safeJoin(vaultRoot(ctx, b.vault), current.path);
      const raw = await readFile(full, 'utf8');
      const etag = createHash('sha256').update(raw).digest('hex');
      if (typeof b.etag !== 'string' || b.etag !== etag) throw new Error('This note changed since it was opened. Reload it before editing the relationship.');
      const entityMap = typedEntityMetadataMap(index.notes);
      const sourceNote = index.notes[sourceIndex];
      const sourceMeta = entityMap.get(sourceNote);
      const targetId = String(b.target_id || '').trim();
      const targetEntry = [...entityMap.entries()].find(([, meta]) => meta.entity_id === targetId);
      const targetMeta = targetEntry?.[1];
      const evidence = String(b.evidence || '').trim();
      if (!sourceMeta || !targetMeta || targetEntry[0] === sourceNote || sourceMeta.scope !== targetMeta.scope) throw new Error('Choose a current visible record in the same Twin scope.');
      if (!evidence || evidence.length > 300 || !String(sourceNote.body || '').includes(evidence)) throw new Error('Evidence must be an exact excerpt of up to 300 characters from this note.');
      if (!typedRelationAllowed(String(b.predicate || ''), sourceMeta.type, targetMeta.type)) throw new Error('Choose a relationship type that matches both record types.');
      const next = updateTypedRelation(raw, relationIndex, { predicate: b.predicate, target_id: targetId, evidence, confidence: b.confidence }, expectedReview);
      const tmp = `${full}.brainlink-${randomBytes(6).toString('hex')}.tmp`;
      try { await writeFile(tmp, next, 'utf8'); await rename(tmp, full); }
      catch (e) { try { await unlink(tmp); } catch {} throw e; }
      await logActivity(env, { tool: 'graph_relationship_review', ok: true, action: 'edited' });
      return { ok: true, etag: createHash('sha256').update(next).digest('hex') };
    },
    'POST /api/graph3d/relationship/propose': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const vault = ctx.byName.get(b.vault);
      if (vault.private) throw new Error('Relationships in a private vault cannot be suggested in the shared graph.');
      if (ctx.readOnly || vault.writes !== 'on') throw new Error('This vault does not allow relationship suggestions.');
      const current = await readNote(ctx, b.vault, String(b.path || ''));
      const index = await loadVault(ctx, b.vault);
      const sourceIndex = index.byRel.get(current.path);
      if (sourceIndex === undefined || index.notes[sourceIndex].generated) throw new Error('This record cannot receive a relationship suggestion.');
      const candidates = discoverTypedRelationshipCandidates(index.notes, sourceIndex);
      const candidate = candidates.find((item) => item.predicate === b.predicate && item.target_id === b.target_id && item.evidence === b.evidence);
      if (!candidate) throw new Error('That connection is no longer a current suggestion. Reload the note and review it again.');
      const full = safeJoin(vaultRoot(ctx, b.vault), current.path);
      const raw = await readFile(full, 'utf8');
      const etag = createHash('sha256').update(raw).digest('hex');
      if (typeof b.etag !== 'string' || b.etag !== etag) throw new Error('This note changed since it was opened. Reload it before saving the suggestion.');
      const next = appendTypedRelationProposal(raw, candidate);
      const tmp = `${full}.brainlink-${randomBytes(6).toString('hex')}.tmp`;
      try { await writeFile(tmp, next, 'utf8'); await rename(tmp, full); }
      catch (e) { try { await unlink(tmp); } catch {} throw e; }
      return { ok: true, etag: createHash('sha256').update(next).digest('hex') };
    },
    'POST /api/graph3d/relationship/propose-manual': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const vault = ctx.byName.get(b.vault);
      if (vault.private) throw new Error('Relationships in a private vault cannot be suggested in the shared graph.');
      if (ctx.readOnly || vault.writes !== 'on') throw new Error('This vault does not allow relationship suggestions.');
      const current = await readNote(ctx, b.vault, String(b.path || ''));
      const index = await loadVault(ctx, b.vault);
      const sourceIndex = index.byRel.get(current.path);
      if (sourceIndex === undefined || index.notes[sourceIndex].generated) throw new Error('This record cannot receive a relationship suggestion.');
      const visible = index.notes.filter((note) => !note.private && !note.generated);
      const entityMap = typedEntityMetadataMap(visible);
      const source = index.notes[sourceIndex];
      const sourceMeta = entityMap.get(source);
      const targetId = String(b.target_id || '');
      const targetEntry = [...entityMap.entries()].find(([, meta]) => meta.entity_id === targetId);
      const targetMeta = targetEntry?.[1];
      const evidence = String(b.evidence || '').trim();
      const predicate = String(b.predicate || '');
      if (!sourceMeta || !targetMeta || targetEntry[0] === source || sourceMeta.scope !== targetMeta.scope) {
        throw new Error('Choose a current typed record in the same Twin scope and a compatible relationship.');
      }
      if (!evidence || evidence.length > 320 || !String(source.body || '').includes(evidence)) {
        throw new Error('Evidence must be an exact excerpt of up to 320 characters from this note.');
      }
      if (!typedRelationAllowed(predicate, sourceMeta.type, targetMeta.type)) {
        throw new Error('Choose a current typed record in the same Twin scope and a compatible relationship.');
      }
      const full = safeJoin(vaultRoot(ctx, b.vault), current.path);
      const raw = await readFile(full, 'utf8');
      const etag = createHash('sha256').update(raw).digest('hex');
      if (typeof b.etag !== 'string' || b.etag !== etag) throw new Error('This note changed since it was opened. Reload it before saving the suggestion.');
      const next = appendTypedRelationProposal(raw, { predicate, target_id: targetMeta.entity_id, evidence, confidence: 0.5 });
      const tmp = `${full}.brainlink-${randomBytes(6).toString('hex')}.tmp`;
      try { await writeFile(tmp, next, 'utf8'); await rename(tmp, full); }
      catch (e) { try { await unlink(tmp); } catch {} throw e; }
      return { ok: true, etag: createHash('sha256').update(next).digest('hex') };
    },
    'POST /api/sample': async () => {
      const dest = path.join(home, 'Documents', 'BrainLink Sample Vault');
      if (!(await stat(dest).catch(() => null))) await cp(path.join(ROOT, 'samples', 'acme-studio'), dest, { recursive: true, errorOnExist: true, force: false });
      return { ok: true, path: dest };
    },
    'POST /api/sessions/hooks': async () => {
      const base = await Promise.all(['claude-code', 'codex'].map(async (client) => {
        try { return await sessionHookStatus(client, { home, env }); } catch (e) { return { client, error: e.message }; }
      }));
      const detected = await detect(clientOpts());
      const harness = await Promise.all(Object.entries(detected).filter(([id, client]) => id.startsWith('deepseek-harness@') && client.connected).map(async ([client]) => {
        try { return { ...await deepSeekSessionCueStatus(client, clientOpts()), title: detected[client].title }; }
        catch (e) { return { client, title: detected[client].title, error: e.message }; }
      }));
      const cfg = await loadConfig(file);
      const hermesHome = cfg.sessions?.hermesHome || hermesDefaultRoot(home, env);
      let hermes;
      try { hermes = await hermesSessionHookStatus(hermesHome); }
      catch (e) { hermes = { client: 'hermes', profile: hermesHome, error: e.message, trust_required: true, privileged_shell_hook: true }; }
      return { clients: [...base, ...harness, hermes] };
    },
    'POST /api/sessions/hooks/set': async (b) => {
      if (String(b.client || '').startsWith('deepseek-harness@')) {
        const detected = await detect(clientOpts());
        if (!detected[b.client]?.connected) throw new Error('Connect this named Harness profile to BrainLink first.');
        return setDeepSeekSessionCue(b.client, b.enabled, clientOpts());
      }
      if (b.client === 'hermes') {
        const cfg = await loadConfig(file);
        const hermesHome = cfg.sessions?.hermesHome || hermesDefaultRoot(home, env);
        return setHermesSessionHook(hermesHome, b.enabled, { env, os });
      }
      return setSessionHook(b.client, b.enabled, { home, env, os });
    },
    'POST /api/sessions/end-cues': async () => {
      const cfg = await loadConfig(file);
      const cues = (await listSessionEndCues(path.join(appHome(env), 'sessions', 'end-cues'))).slice(0, 100);
      await sessions.refresh();
      const store = await sessions.store();
      const imported = await store.listSessions({ limit: 100000 });
      return { cues: await Promise.all(cues.map(async (cue) => {
        const id = matchSessionEndCue(cue, imported);
        const summary_ready = Boolean(id && await readLocalSummaryDraft(path.join(appHome(env), 'sessions', 'auto-summary'), id));
        let summary_filed = id ? localSummaryAutoFileStatus.get(id) === 'filed' : false;
        if (id && !summary_filed && cfg.sessions.localSummary.autoFileOnEnd) {
          try {
            const { session } = await store.readSession(id, { limit: 1 });
            const destination = exactSessionFilingDestination(session, cfg);
            if (!destination && summary_ready) localSummaryAutoFileStatus.set(id, 'needs_destination');
            else summary_filed = Boolean(await findFiledSessionSummary(localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: 'BrainLink Local' }), destination.vault, destination.folder, id));
            if (summary_filed) localSummaryAutoFileStatus.set(id, 'filed');
          } catch { /* Keep status unknown when the local index or destination cannot be read. */ }
        }
        return { id: sessionEndCueId(cue), client: cue.client, ended_at: cue.ended_at, reason: cue.reason || null, session_ref: id,
          summary_ready, summary_failed: id ? localSummaryAutoDraftStatus.get(id) === 'failed' : false,
          summary_filed,
          auto_file_status: id ? (localSummaryAutoFileStatus.get(id) || null) : null };
      })) };
    },
    'POST /api/sessions/end-cues/dismiss': (b) => dismissSessionEndCue(path.join(appHome(env), 'sessions', 'end-cues'), b.id),
    'POST /api/sessions': async (b) => {
      await sessions.refresh();
      const result = await sessions.list({ q: b.q, client: b.client, project: b.project, since: b.since, limit: b.limit, include_private: Boolean(b.include_private) });
      const store = await sessions.store();
      const annotated = await Promise.all(result.sessions.map(async (item) => {
        const { session } = await store.readSession(item.id);
        return { ...item, profile_id: session.profile_id || null };
      }));
      return { ...result, sessions: annotated };
    },
    'POST /api/sessions/read': (b) => sessions.read({ id: b.id, include_private: Boolean(b.include_private) }),
    'POST /api/sessions/assign-twin': async (b) => {
      const profileId = String(b.profile_id || '');
      const cfg = normalize(await loadConfig(file));
      const profile = cfg.twin_profiles.find((item) => item.id === profileId);
      if (!profile) throw new Error('Choose an existing Twin profile.');
      if (!(profile.allowed_actions || []).includes('read_session') || !(profile.agent_access || []).some((agent) => (agent.vaults || []).some((grant) => (grant.operations || []).includes('read_session')))) {
        throw new Error('This Twin has no agent explicitly authorized to read sessions.');
      }
      const before = await sessions.read({ id: b.id, include_private: true });
      if (before.profile_id) throw new Error('This session is already assigned to a Twin and cannot be reassigned.');
      const store = await sessions.store();
      if (typeof store.assignSessionProfile !== 'function') throw new Error('This session store does not support Twin assignment.');
      const assigned = await store.assignSessionProfile(b.id, profile.id);
      return { ok: true, session: { id: assigned.id, profile_id: assigned.profile_id, private: assigned.private }, profile: { id: profile.id, name: profile.name, mode: profile.mode } };
    },
    'POST /api/sessions/recommend': async (b) => {
      const cfg = await loadConfig(file);
      const session = await sessions.read({ id: b.id, include_private: true });
      return { ...recommendSessionVault(session, cfg), project: session.project || null, remember_available: Boolean(session.project && session.project.length <= 1024) };
    },
    'POST /api/sessions/filing-folders': async (b) => {
      const cfg = await loadConfig(file);
      const vaultName = String(b.vault || '');
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: 'BrainLink Local' });
      const session = await sessions.read({ id: b.id, include_private: true });
      const destination = ctx.byName.get(vaultName);
      if (!destination || destination.writes === 'off') throw new Error('Choose a writable destination vault.');
      const suggestion = await suggestedSessionFolder(ctx, session, vaultName);
      return { folders: await listSessionFilingFolders(ctx, vaultName),
        suggested_folder: suggestion?.folder ?? null, folder_suggestion_source: suggestion?.source ?? null,
        default_folder: destination.flat ? '' : destination.intake_folder };
    },
    'POST /api/sessions/file': async (b) => {
      if (b.confirm !== true && b.confirm !== false) throw new Error('Choose preview or confirm.');
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: 'BrainLink Local' });
      const session = await sessions.read({ id: b.id, include_private: true });
      if (b.useLocalDraft === true) {
        const draft = await readLocalSummaryDraft(path.join(appHome(env), 'sessions', 'auto-summary'), String(b.id || ''));
        if (!draft) throw new Error('No reviewed local summary draft is available for this session.');
        session.summary = draft.summary;
        session.local_summary_model = draft.model;
        session.local_summary_generated_at = draft.generated_at;
      }
      const folder = typeof b.folder === 'string' ? b.folder : undefined;
      const result = await fileSessionSummary(ctx, session, String(b.vault || ''), b.confirm, {}, folder);
      if (b.confirm === true && b.rememberDestination === true && result.written && session.project && session.project.length <= 1024) {
        const latest = await loadConfig(file);
        const projectVaults = { ...latest.session_filing.projectVaults, [session.project]: String(b.vault || '') };
        const projectFolders = { ...latest.session_filing.projectFolders, [session.project]: { vault: String(b.vault || ''), folder: folder ?? '' } };
        try {
          await saveConfig({ ...latest, session_filing: { ...latest.session_filing, projectVaults, projectFolders } }, file);
          result.destination_rule_saved = true;
        } catch { result.destination_rule_saved = false; }
      }
      return result;
    },
    'POST /api/sessions/filed-summary': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: 'BrainLink Local' });
      const sessionId = String(b.session_id || b.sessionId || '');
      const session = await sessions.read({ id: sessionId, include_private: true });
      if (!session?.id) throw new Error('Session not found.');
      const input = { vaultName: String(b.vault || ''), rel: String(b.path || ''), sessionId };
      if (b.action === 'read') return readFiledSessionSummary(ctx, input);
      return updateFiledSessionSummary(ctx, { ...input, etag: b.etag, action: b.action, summary: b.summary });
    },
    'POST /api/sessions/filed-summaries': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: 'BrainLink Local' });
      return listFiledSessionSummaries(ctx, String(b.vault || ''), { limit: 100 });
    },
    'POST /api/sessions/private': (b) => sessions.setPrivate(b.id, b.private),
    'POST /api/sessions/import-setting': async (b) => {
      if (typeof b.enabled !== 'boolean') throw new Error('Choose whether to import local AI session history.');
      if (b.enabled && env.BRAINLINK_DISABLE_HISTORY_IMPORT === '1') throw new Error('Session-history import is unavailable in demo mode.');
      const cfg = await loadConfig(file);
      const next = { ...cfg, sessions: { ...cfg.sessions, importHistory: b.enabled } };
      await saveConfig(next, file);
      // Drain this Setup process's current refresh and re-read the new setting. Other
      // BrainLink processes can have an import already in progress; they read the saved
      // setting again on their next refresh.
      await sessions.refresh();
      return { ok: true, sessions: next.sessions };
    },
    // What connected AI apps (not this local UI) may see of imported/logged sessions. The user's
    // own choice; session_list/session_read in src/server.mjs always read this, never a caller flag.
    'POST /api/sessions/sharing': async (b) => {
      const cfg = await loadConfig(file);
      const shareSummaries = typeof b.shareSummaries === 'boolean' ? b.shareSummaries : cfg.sessions.shareSummaries;
      const shareFullText = typeof b.shareFullText === 'boolean' ? b.shareFullText : cfg.sessions.shareFullText;
      const next = { ...cfg, sessions: { ...cfg.sessions, shareSummaries, shareFullText: shareSummaries && shareFullText } };
      await saveConfig(next, file);
      return { ok: true, sessions: next.sessions };
    },
    'POST /api/sessions/hermes-profile/pick': async () => {
      const selected = await pickFolder(os, 'Choose the Hermes profile folder containing state.db');
      return selected === undefined ? { path: null, unavailable: true } : { path: selected };
    },
    'POST /api/sessions/hermes-profile': async (b) => {
      const requested = typeof b.home === 'string' ? b.home.trim() : '';
      let hermesHome = null;
      if (requested) {
        if (!path.isAbsolute(requested)) throw new Error('Choose an absolute Hermes profile folder.');
        const folderStat = await stat(requested).catch(() => null);
        const databaseStat = await stat(path.join(requested, 'state.db')).catch(() => null);
        if (!folderStat?.isDirectory() || !databaseStat?.isFile()) throw new Error('That folder does not contain a Hermes state.db profile.');
        hermesHome = path.resolve(requested);
      }
      const cfg = await loadConfig(file);
      const next = { ...cfg, sessions: { ...cfg.sessions, hermesHome } };
      await saveConfig(next, file);
      const store = await sessions.refresh({ force: true });
      const imported = await store.listSessions({ client: 'hermes', limit: 100000 });
      touch();
      return { ok: true, profile: { home: hermesHome, defaultHome: hermesDefaultRoot(home, env) }, sessionCount: imported.length };
    },
    'POST /api/sessions/local-summary/settings': async (b) => {
      const cfg = await loadConfig(file);
      const enabled = typeof b.enabled === 'boolean' ? b.enabled : cfg.sessions.localSummary.enabled;
      const model = typeof b.model === 'string' ? b.model.trim() : cfg.sessions.localSummary.model;
      const autoDraftOnEnd = enabled && typeof b.autoDraftOnEnd === 'boolean' ? b.autoDraftOnEnd : enabled ? cfg.sessions.localSummary.autoDraftOnEnd : false;
      const autoFileOnEnd = enabled && autoDraftOnEnd && typeof b.autoFileOnEnd === 'boolean' ? b.autoFileOnEnd : enabled && autoDraftOnEnd ? cfg.sessions.localSummary.autoFileOnEnd : false;
      if (enabled && (!validLocalModelName(model) || !model)) throw new Error('Enter a valid local Ollama model name before enabling summaries.');
      const next = { ...cfg, sessions: { ...cfg.sessions, localSummary: { enabled, model, autoDraftOnEnd, autoFileOnEnd } }, ingestion: enabled ? cfg.ingestion : { ...cfg.ingestion, autoDrafts: false, autoFile: false } };
      await saveConfig(next, file);
      localSummaryAutoDraftKeepsAlive = Boolean(enabled && autoDraftOnEnd);
      touch();
      return { ok: true, settings: next.sessions.localSummary };
    },
    'POST /api/sessions/local-summary/models': async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      timer.unref?.();
      try {
        const response = await (opts.localSummaryModelsFetch || fetch)(`${LOCAL_OLLAMA_URL}/api/tags`, { signal: controller.signal });
        if (!response?.ok) return { available: false, models: [] };
        const payload = await response.json();
        const models = [...new Set((Array.isArray(payload?.models) ? payload.models : [])
          .map((model) => typeof model?.name === 'string' ? model.name.trim() : '')
          .filter((name) => validLocalModelName(name)))].sort();
        return { available: true, models };
      } catch { return { available: false, models: [] }; }
      finally { clearTimeout(timer); }
    },
    'POST /api/sessions/local-summary/model-capabilities': async (b) => {
      const model = typeof b.model === 'string' ? b.model.trim() : '';
      if (!validLocalModelName(model)) throw new Error('Enter a valid local Ollama model name.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      timer.unref?.();
      try {
        const response = await (opts.localSummaryModelInfoFetch || fetch)(`${LOCAL_OLLAMA_URL}/api/show`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ model }),
        });
        if (!response?.ok) return { available: false, model, vision: null };
        const payload = await response.json();
        const capabilities = Array.isArray(payload?.capabilities) ? payload.capabilities.filter((item) => typeof item === 'string') : null;
        return { available: true, model, vision: capabilities ? capabilities.includes('vision') : null };
      } catch { return { available: false, model, vision: null }; }
      finally { clearTimeout(timer); }
    },
    'POST /api/sessions/local-summary/generate': async (b) => {
      const cfg = await loadConfig(file);
      if (!cfg.sessions.localSummary.enabled) throw new Error('Turn on local summaries in Sessions settings first.');
      const id = String(b.id || '');
      const existing = await readLocalSummaryDraft(path.join(appHome(env), 'sessions', 'auto-summary'), id);
      if (existing) return { ok: true, draft: { summary: existing.summary, model: existing.model, generated_at: existing.generated_at, source: existing.source } };
      const store = await sessions.store();
      const { session, messages } = await store.readSession(id, { limit: 1000 });
      const generated = await generateLocalSessionSummary(messages, cfg.sessions.localSummary.model, { fetchImpl: opts.localSummaryFetch || fetch });
      const draft = await saveLocalSummaryDraft(path.join(appHome(env), 'sessions', 'auto-summary'), id, generated);
      return { ok: true, draft: { summary: draft.summary, model: draft.model, generated_at: draft.generated_at, source: draft.source }, session: { id: session.id } };
    },
    // P0: two-AI handoff receipt -- who handed off, who picked it up (if anyone yet), and when.
    // listHandoffs() already drops anything under an excluded ("00 Home"-style) folder or marked
    // private, so this never has to re-check that itself; it only has to pair each handoff with
    // the later handoff (if any) that acks it via `ack_of` to know whether it was picked up.
    'POST /api/handoffs': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!cfg.handoff || !ctx.enabled.includes(cfg.handoff.vault)) return { enabled: false, receipts: [] };
      const list = await listHandoffs(ctx, { limit: b.limit || 30 });
      // Replies are append-only. If multiple agents update a request at the same
      // timestamp, do not choose one arbitrarily and present it as authoritative.
      const updatesByTarget = new Map();
      for (const update of list) if (update.ack_of) {
        const updates = updatesByTarget.get(update.ack_of) || [];
        updates.push(update);
        updatesByTarget.set(update.ack_of, updates);
      }
      const receipts = list.filter((x) => !x.ack_of).map((x) => {
        const updates = updatesByTarget.get(x.path) || [];
        const latestTime = updates.reduce((latest, item) => Math.max(latest, Date.parse(item.sent_at) || 0), 0);
        const latestUpdates = updates.filter((item) => (Date.parse(item.sent_at) || 0) === latestTime);
        const updateConflict = latestUpdates.length > 1;
        const update = updateConflict ? null : latestUpdates[0];
        const legacyStatus = { ACK: 'ACKNOWLEDGED', DONE: 'COMPLETED', COMPLETE: 'COMPLETED' }[String(update?.status || '').toUpperCase()];
        return {
          from: x.from, to: x.to, subject: x.subject, sent_at: x.sent_at, status: x.status, priority: x.priority,
          picked_up: updates.length > 0, picked_up_by: update ? update.from : null, picked_up_at: latestUpdates[0]?.sent_at || null,
          update_conflict: updateConflict,
          update_status: updateConflict ? 'CONCURRENT_UPDATES' : update ? (legacyStatus || update.status || 'ACKNOWLEDGED') : null,
          update_subject: updateConflict ? `${latestUpdates.length} updates need review` : update ? update.subject : null,
        };
      });
      return { enabled: true, receipts };
    },
    // ---- Shared snapshot: a read-only copy of the notes for cloud agents (Ian's RB8) ----
    'POST /api/snapshot/pick-folder': async () => { const p = await pickSnapshotFolder(); return p === undefined ? { path: null, unavailable: true } : { path: p }; },
    'POST /api/snapshot': async (b) => {
      const cfg = await loadConfig(file);
      const next = chooseSnapshot(cfg, { enabled: b.enabled, folder: b.folder, includeSessions: b.includeSessions });
      await saveConfig(next, file);
      // Writes once immediately on enabling (or on any change), not just on the next interval or
      // vault edit, and picks up errors (e.g. the folder disappeared) right away.
      await refreshSnapshotWatcher(next);
      const status = await loadSnapshotStatus(snapshotStateFile);
      return { ok: true, snapshot: { ...snapshotSettings(next), suggested_folder: suggestSnapshotFolder(home), ...status } };
    },
    // F2 recovery: force=true is the "Clear and re-share" action -- a full reset of the
    // dedicated subfolder when the manifest was lost, not the normal "Stop sharing" toggle-off.
    'POST /api/snapshot/clear': async (b) => {
      const cfg = await loadConfig(file);
      await clearSnapshot(snapshotSettings(cfg).folder, env, cfg.vaults, { force: Boolean(b?.force) });
      if (b?.force) await refreshSnapshotWatcher(cfg);
      return { ok: true };
    },
    'POST /api/backup/pick-folder': async () => { const p = await pickBackupFolder(); return p === undefined ? { path: null, unavailable: true } : { path: p }; },
    'POST /api/backup/history': async () => {
      const cfg = await loadConfig(file);
      if (!cfg.backup?.folder) throw new Error('Choose a backup folder first.');
      const key = cfg.backup.encrypted ? await requireBackupKey(env).catch(() => null) : null;
      return listVerifiedBackups(cfg.backup.folder, key);
    },
    'POST /api/backup/encryption-key': async () => createOrReadBackupRecoveryKey(env),
    'POST /api/backup/restore/pick-source': async () => { const p = await pickRestoreSourceFolder(); return p === undefined ? { path: null, unavailable: true } : { path: p }; },
    'POST /api/backup/restore/pick-destination': async () => { const p = await pickRestoreDestinationFolder(); return p === undefined ? { path: null, unavailable: true } : { path: p }; },
    'POST /api/backup': async (b) => {
      const cfg = await loadConfig(file);
      const backupSchedule = normalizeBackupSchedule({
        scheduleMode: b.scheduleMode, intervalHours: b.intervalHours === undefined ? cfg.backup.intervalHours : Number(b.intervalHours), time: b.time,
      }, cfg.backup);
      const scheduleChanged = backupSchedule.scheduleMode !== cfg.backup.scheduleMode || backupSchedule.time !== cfg.backup.time;
      const next = { ...cfg, backup: { ...cfg.backup, ...backupSchedule, last_scheduled_date: scheduleChanged ? null : backupSchedule.last_scheduled_date,
        enabled: Boolean(b.enabled), folder: b.folder || null, keepCount: Number(b.keepCount ?? cfg.backup.keepCount ?? 0), encrypted: Boolean(b.encrypted) } };
      if (next.backup.encrypted && !cfg.backup.encrypted) {
        const storedKey = await requireBackupKey(env);
        const confirmedKey = parseBackupKey(String(b.recoveryKeyConfirmation || ''));
        if (!timingSafeEqual(storedKey, confirmedKey)) throw new Error('The recovery key did not match. Copy the displayed key and try again.');
      } else if (next.backup.encrypted) {
        await requireBackupKey(env);
      }
      if (next.backup.enabled) {
        await runBackup(next, 'setup'); // verify before enabling the schedule
        if (backupScheduleDue(next.backup, new Date(), next.timezone)) next.backup.last_scheduled_date = localDateAndTime(new Date(), next.timezone).date;
      }
      await saveConfig(next, file);
      refreshBackupTimer(next);
      return { ok: true, backup: { ...next.backup, status: backupStatus } };
    },
    'POST /api/backup/run': async () => {
      const cfg = await loadConfig(file);
      return runBackup(cfg, 'manual');
    },
    'POST /api/ingestion/settings': async (b) => {
      const next = await withConfigMutation(async () => {
        const cfg = await loadConfig(file);
        const updated = { ...cfg, ingestion: validateIngestionSchedule(b, cfg.ingestion) };
        if (updated.ingestion.autoDrafts && (!cfg.sessions.localSummary?.enabled || !cfg.sessions.localSummary?.model)) throw new Error('Enable Local summary drafts and choose an Ollama model before scheduling AI drafts.');
        if (updated.ingestion.autoFile) {
          if (!updated.ingestion.targets.length || updated.ingestion.targets.some((target) => !target.destination)) throw new Error('Choose a filing destination for every scan folder before enabling automatic filing.');
          const ctx = localContext(updated, { ...env, BRAINLINK_SEMANTIC: '0' });
          for (const target of updated.ingestion.targets) {
            const selected = ctx.byName.get(target.vault);
            const folders = new Set((await listSessionFilingFolders(ctx, target.vault)).map((entry) => entry.path)
              .filter((folder) => folder && !(folder === selected?.intake_folder && selected?.decisions?.length)));
            if (!folders.has(target.destination)) throw new Error(`The filing destination for ${target.vault}/${target.folder} is not an existing allowed folder in that vault.`);
            if (target.destination === target.folder || target.destination.startsWith(`${target.folder}/`)) throw new Error('A filing destination must be outside its scan folder.');
          }
        }
        if (updated.ingestion.enabled) {
          const ctx = localContext(updated, { ...env, BRAINLINK_SEMANTIC: '0' });
          for (const target of updated.ingestion.targets) await ingestionQueue(ctx, target.vault, target.folder, { limit: 1 });
        }
        await saveConfig(updated, file);
        return updated;
      });
      refreshIngestionSchedule(next);
      return { ok: true, ingestion: { ...next.ingestion, status: ingestionStatus } };
    },
    'POST /api/ingestion/folders': async (b) => {
      const cfg = await loadConfig(file);
      const vaultName = String(b.vault || '');
      const selected = cfg.vaults.find((item) => item.name === vaultName);
      if (!selected || selected.private) throw new Error('Choose an existing non-private vault.');
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      let folders = await listSessionFilingFolders(ctx, vaultName);
      if (b.destinationOnly) {
        const vaultConfig = ctx.byName.get(vaultName);
        folders = folders.filter((entry) => entry.path && !(entry.path === vaultConfig?.intake_folder && vaultConfig?.decisions?.length));
      }
      return { folders: folders.map((item) => item.path).filter(Boolean) };
    },
    'POST /api/ingestion/run': async (b) => {
      const cfg = await loadConfig(file);
      const targets = Array.isArray(b.targets) ? b.targets : b.vault && b.folder ? [{ vault: String(b.vault), folder: String(b.folder) }] : undefined;
      const result = await runIngestion(cfg, { trigger: 'manual', targets });
      if (cfg.ingestion?.autoDrafts && result.ok) {
        const configured = new Map((cfg.ingestion.targets || []).map((target) => [`${target.vault}\0${target.folder}`, target]));
        const eligible = result.candidates.filter((item) => configured.has(`${item.vault}\0${item.folder}`))
          .map((item) => ({ ...item, destination: configured.get(`${item.vault}\0${item.folder}`).destination || null }));
        if (eligible.length) result.processing = await runScheduledIngestionDrafts(cfg, eligible, { trigger: 'manual' });
      }
      return result;
    },
    'POST /api/ingestion/draft': async (b) => {
      const cfg = await loadConfig(file);
      const local = cfg.sessions.localSummary;
      if (!local.enabled || !local.model) throw new Error('Enable Local summary drafts and choose an Ollama model in Sessions first.');
      const ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      const source = await readIngestionSource(ctx, String(b.vault || ''), String(b.folder || ''), { source_id: b.source_id, revision: b.revision });
      source.typed_entities = await typedEntitiesForIngestionSource(ctx, source.vault, source);
      const draft = await generateLocalIngestionDraft(source, local.model, { fetchImpl: opts.ingestionDraftFetch || fetch });
      const related = await relatedText(ctx, draft.vault, `${draft.title}\n${draft.body}\n${redactText(source.body)}`, { excludePath: source.rel });
      draft.related_basis = 'source_and_draft';
      draft.related_notes = related.suggested
        .filter((item) => typeof item.path === 'string' && !/[[\]]/.test(item.path) && Array.isArray(item.shared_terms))
        .slice(0, 8)
        .map((item) => ({ path: item.path, title: String(item.title || '').slice(0, 160), shared_terms: item.shared_terms.slice(0, 6).map((term) => String(term).slice(0, 50)), score: Number(item.score) || 0 }));
      draft.destinations = (await listSessionFilingFolders(ctx, draft.vault))
        .map((entry) => entry.path)
        .filter((folder) => folder && folder !== draft.folder && !folder.startsWith(`${draft.folder}/`)
          && !(folder === ctx.byName.get(draft.vault)?.intake_folder && ctx.byName.get(draft.vault)?.decisions?.length));
      const savedDraft = await saveIngestionDraft(ingestionDraftsDir, draft);
      await logActivity(env, { tool: 'source_draft', ok: true });
      return { ok: true, draft_id: savedDraft.id, draft };
    },
    'GET /api/ingestion/drafts': async () => ({ drafts: await listIngestionDrafts(ingestionDraftsDir) }),
    'POST /api/ingestion/discard-draft': async (b) => {
      if (b.confirm !== true) throw new Error('Confirm removing this local draft.');
      const id = String(b.draft_id || '');
      const stored = await readIngestionDraft(ingestionDraftsDir, id);
      if (!stored?.draft) throw new Error('This local draft is missing or damaged.');
      try {
          const draft = stored.draft;
          const ctx = localContext(await loadConfig(file), { ...env, BRAINLINK_SEMANTIC: '0' });
          await readIngestionSource(ctx, draft.vault, draft.folder, { source_id: draft.source_id, revision: draft.revision });
          await recordIngestion(ctx, draft.vault, draft.folder, { source_id: draft.source_id, revision: draft.revision, outcome: 'skipped' });
      } catch { /* stale or withdrawn sources are simply removed from the local review list */ }
      await removeIngestionDraft(ingestionDraftsDir, id);
      await logActivity(env, { tool: 'source_draft_discard', ok: true });
      return { ok: true };
    },
    'POST /api/ingestion/save-draft': async (b) => {
      const cfg = await loadConfig(file);
      if (b.confirm !== true) throw new Error('Review the draft and explicitly confirm saving it as a proposed note.');
      const id = String(b.draft_id || '');
      const stored = await readIngestionDraft(ingestionDraftsDir, id);
      const draft = stored?.draft;
      if (!draft) throw new Error('This local draft is missing or damaged. Prepare it again from the source queue.');
      const destination = String(b.destination || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!destination || !Array.isArray(draft.destinations) || !draft.destinations.includes(destination)) throw new Error('Choose an existing knowledge folder outside the selected source folder.');
      const requestedRelated = b.related_note_paths === undefined ? [] : b.related_note_paths;
      return saveIngestionDraftRecord(cfg, id, destination, requestedRelated, b.entity_choices || [], b.relationship_indexes || [], b.dismiss_unselected_entities === true);
    },
    'POST /api/brief/settings': async (b) => {
      const cfg = await loadConfig(file);
      const next = { ...cfg, brief: validateBriefSchedule(b, cfg.brief) };
      if (next.brief.enabled) {
        const selected = next.vaults.find((item) => item.name === next.brief.vault);
        if (!selected || !(await stat(selected.path).then((s) => s.isDirectory(), () => false))) throw new Error('Choose an existing vault before enabling scheduled briefs.');
      }
      await saveConfig(next, file);
      refreshBriefSchedule(next);
      return { ok: true, brief: { ...next.brief, status: briefStatus } };
    },
    'POST /api/brief/run': async (b) => {
      const cfg = await loadConfig(file);
      return runBrief(cfg, { trigger: 'manual', vaultName: String(b.vault || cfg.brief?.vault || '') });
    },
    'POST /api/startup': async (b) => ({ ok: true, enabled: await setStartupEnabled(Boolean(b.enabled), { env, home, os }) }),
    'POST /api/backup/restore': async (b) => {
      if (b.confirm !== true) throw new Error('Confirm restoring into an empty folder first.');
      const recoveryKey = b.recoveryKey ? String(b.recoveryKey) : await requireBackupKey(env).catch(() => null);
      try {
        const restored = await restoreBackupToEmpty(String(b.backupFolder || ''), String(b.destination || ''), recoveryKey);
        await logActivity(env, { tool: 'backup_restore', ok: true });
        return { ok: true, ...restored };
      } catch (error) {
        await logActivity(env, { tool: 'backup_restore', ok: false });
        throw error;
      }
    },
    'POST /api/test': async (b) => {
      const cfg = normalize(await loadConfig(file));
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: '' });
      if (!ctx.enabled.length) throw new Error('Add a vault first.');
      const v = b.vault && ctx.enabled.includes(b.vault) ? b.vault : ctx.enabled[0];
      return { vault: v, results: (await search(ctx, v, String(b.query || 'goal'), 5)).map((r) => ({ title: r.title, path: r.path, heading: r.heading, score: r.score })) };
    },
    // Cited instant answer: the same ranked search + status verdict the vault_search MCP tool uses,
    // reshaped for a one-paragraph answer with clickable source chips (/api/note opens each one).
    // Read-only setup check: can connected AIs actually reach the rules, role notes and
    // mailbox this configuration points them at? Changes nothing.
    'POST /api/self-test': async () => {
      const cfg = normalize(await loadConfig(file));
      return runSelfTest(localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: '' }));
    },
    // Replayable misses (opt-in, local only, question text kept on this computer).
    'GET /api/replay-misses': async () => {
      const cfg = normalize(await loadConfig(file));
      const ctx = localContext(cfg);
      const items = await createReplayMisses({ home: ctx.dataDir }).list();
      const visible = items.filter((item) => ctx.enabled.includes(item.vault) && !ctx.byName.get(item.vault)?.private);
      return { enabled: cfg.replay_misses.enabled, count: visible.length, items: visible.slice(-50).reverse() };
    },
    'POST /api/replay-misses/settings': async (b) => withConfigMutation(async () => {
      const cfg = await loadConfig(file);
      const next = { ...cfg, replay_misses: { enabled: b.enabled === true } };
      await saveConfig(next, file);
      return { ok: true, enabled: next.replay_misses.enabled };
    }),
    'POST /api/replay-misses/run': async () => {
      const cfg = normalize(await loadConfig(file));
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: '' });
      return createReplayMisses({ home: ctx.dataDir }).replay(ctx);
    },
    'POST /api/replay-misses/teach': async (b) => {
      const cfg = normalize(await loadConfig(file));
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: '' });
      const misses = createReplayMisses({ home: ctx.dataDir });
      const miss = await misses.get(b.miss_id);
      if (!miss || !ctx.enabled.includes(miss.vault) || ctx.byName.get(miss.vault)?.private) throw new Error('This question is no longer available for teaching.');
      if (miss.fixed_by) throw new Error('This question already has a saved answer.');
      const answer = String(b.answer || '').trim();
      if (!answer || answer.length > 24_000) throw new Error('Enter an answer of at most 24,000 characters.');
      const title = String(b.title || miss.query).trim();
      const folder = String(b.folder || '').trim();
      const identity = `teach-${miss.id.slice(0, 32)}`;
      const noteDraft = await proposeNote(ctx, {
        vault: miss.vault, title, folder, body: answer, source: 'owner answer to a recorded miss',
        status: 'active', confidence: 'verified', memory_type: 'semantic', decision: 'ADOPT',
        ai_platform: 'BrainLink', agent_or_role: 'owner', session_or_task_id: identity,
        confirm: false,
      });
      if (!noteDraft.ok || typeof noteDraft.preview !== 'string') {
        if (!noteDraft.ok) throw new Error((noteDraft.errors || []).join(' '));
        throw new Error(noteDraft.next || 'This vault cannot save a confirmed answer.');
      }
      const key = randomBytes(24).toString('hex');
      const rel = noteDraft.path.slice(`${miss.vault}/`.length);
      if (b.confirm !== true) {
        const now = Date.now();
        for (const [id, item] of teachPreviews) if (item.expires < now) teachPreviews.delete(id);
        if (teachPreviews.size >= 100) teachPreviews.delete(teachPreviews.keys().next().value);
        teachPreviews.set(key, { miss_id: miss.id, vault: miss.vault, args: { title, folder, answer }, path: noteDraft.path, rel, preview: noteDraft.preview, expires: now + 15 * 60_000 });
        return { ...noteDraft, miss_id: miss.id, preview_id: key, question: miss.query, destination: noteDraft.path };
      }
      const preview = teachPreviews.get(String(b.preview_id || ''));
      if (!preview || preview.expires < Date.now() || preview.miss_id !== miss.id || preview.vault !== miss.vault
        || preview.args.title !== title || preview.args.folder !== folder || preview.args.answer !== answer) {
        throw new Error('Preview expired or changed. Review a fresh preview before saving.');
      }
      const result = await commitNew(ctx, miss.vault, preview.rel, preview.preview, true, { ownerApproved: true });
      if (!result.ok || !result.written) throw new Error((result.errors || []).join(' ') || result.next || 'The answer was not saved.');
      teachPreviews.delete(String(b.preview_id));
      const replay = await searchWithVerdict(ctx, miss.vault, miss.query, { limit: 3 });
      const top = replay.results[0] || null;
      const fixed = replay.status === 'hits' && top?.path === preview.rel;
      if (fixed) await misses.markFixed(miss.id, result.path);
      return { ...result, question: miss.query, replay: { status: replay.status, top: top ? { path: top.path, title: top.title } : null }, fixed_by: fixed ? result.path : null };
    },
    'POST /api/replay-misses/clear': async () => {
      const cfg = normalize(await loadConfig(file));
      return createReplayMisses({ home: localContext(cfg).dataDir }).clear();
    },
    // Cited local search for the owner. One call searches one vault, or (vault: '*') every
    // non-private vault. Vaults are searched separately and never ranked against each other,
    // so each result group keeps its own verdict. Private vaults are searched only when the
    // owner names one. Every source carries the note's own date/status/confidence so the
    // owner can judge how far to trust it before opening it.
    'POST /api/ask': async (b) => {
      const cfg = normalize(await loadConfig(file));
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: '' });
      if (!ctx.enabled.length) throw new Error('Add a vault first.');
      const query = String(b.query || '').trim();
      if (!query) throw new Error('Ask a question first.');
      const requested = typeof b.vault === 'string' ? b.vault : '';
      if (requested && requested !== '*' && !ctx.enabled.includes(requested)) throw new Error('Unknown vault.');
      const shared = ctx.enabled.filter((name) => !ctx.byName.get(name).private);
      const scope = requested === '*' ? (shared.length ? shared : [ctx.enabled[0]]) : [requested || ctx.enabled[0]];
      const skippedPrivate = requested === '*' ? ctx.enabled.filter((name) => !scope.includes(name)) : [];
      const groups = [];
      for (const v of scope) {
        const r = await searchWithVerdict(ctx, v, query, { limit: 5 });
        if (cfg.replay_misses?.enabled === true) await createReplayMisses({ home: ctx.dataDir }).record({ vault: v, query, status: r.status, source: 'ask', isPrivate: Boolean(ctx.byName.get(v).private) }).catch(() => {});
        // Among the three best matches, show reviewed notes before unreviewed drafts, so the
        // excerpt the owner reads first is not an unapproved proposal. Superseded notes keep
        // their rank (search already demotes them) and are flagged instead.
        const lessTrusted = (x) => (/^(proposed|draft)$/i.test(x.status || '') ? 1 : 0);
        const top = r.results.slice(0, 3).map((x, i) => ({ x, i })).sort((a, b) => lessTrusted(a.x) - lessTrusted(b.x) || a.i - b.i).map(({ x }) => x);
        groups.push({
          vault: v, private: Boolean(ctx.byName.get(v).private), status: r.status, coverage: r.coverage, note: r.note || null,
          answer: r.status === 'not_in_brain' ? null : plainText(top[0]?.snippet) || null,
          sources: top.map((x) => ({
            vault: v, path: x.path, title: x.title, heading: x.heading || '', score: x.score,
            date: x.date || '', status: x.status || '', confidence: x.confidence || '', historical: Boolean(x.historical),
            match: x.match || '', snippet: (plainText(x.snippet) || '').slice(0, 320),
          })),
        });
      }
      const rank = { hits: 0, weak: 1, not_in_brain: 2 };
      groups.sort((x, y) => (rank[x.status] ?? 3) - (rank[y.status] ?? 3));
      const first = groups[0];
      const embedder = await semanticStatus(ctx).catch(() => null);
      return {
        vault: first.vault, query, status: first.status, coverage: first.coverage, note: first.note, answer: first.answer, sources: first.sources,
        groups, vaults_searched: scope, vaults_skipped_private: skippedPrivate, search_mode: embedder?.available ? 'meaning' : 'keyword',
      };
    },
    // Opens one of the answer's source chips (or a citation modal's own wikilink): full
    // frontmatter + body, read-only, plus each [[wikilink]] in the body already resolved (or not)
    // against this vault's privacy-filtered index — P1b: the modal renders formatted text and
    // real links, and a dead/private target must never be distinguishable from the other.
    'POST /api/note': async (b) => {
      const cfg = normalize(await loadConfig(file));
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: '' });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const note = await readNote(ctx, b.vault, String(b.path || ''));
      const index = await loadVault(ctx, b.vault);
      return { vault: b.vault, ...note, wikilinks: resolveNoteWikilinks(index, note.body) };
    },
  };

  const server = createServer(async (req, res) => {
    // Only this machine, only our port: blocks DNS-rebinding and cross-site requests.
    const host = req.headers.host || '';
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`).test(host)) { res.writeHead(421).end(); return; }
    const url = new URL(req.url, `http://${host}`);
    touch();
    if (url.pathname === '/health') { json(res, 200, { app: 'brainlink', version: VERSION }); return; }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const given = Buffer.from(url.searchParams.get('t') || ''); const want = Buffer.from(token);
      if (given.length !== want.length || !timingSafeEqual(given, want)) { res.writeHead(401).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n'); eventClients.add(res);
      for (const [name, result] of vaultNoteCounts) {
        if (result.status !== 'scanning') res.write(`event: vault-counts-updated\ndata: ${JSON.stringify({ vault: name, ...result })}\n\n`);
      }
      res.on('close', () => eventClients.delete(res));
      return;
    }
    if (req.method === 'GET' && /^\/locales\/[A-Za-z-]+\.json$/.test(url.pathname)) {
      const lang = url.pathname.slice('/locales/'.length, -'.json'.length);
      if (!LOCALES.includes(lang)) { res.writeHead(404).end(); return; }
      try {
        const body = await readFile(path.join(LOCALES_DIR, `${lang}.json`), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
      } catch { res.writeHead(404).end(); }
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:", 'X-Frame-Options': 'DENY' }).end(html);
      return;
    }
    // Static code/styles for the Agents and 3D graph panels (ui/agents.js, ui/notes3d.js, their
    // CSS and vendored libraries): same trust level as index.html, no session token needed.
    if (req.method === 'GET') {
      const file = await readUiStatic(url.pathname);
      if (file) { res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store' }).end(file.body); return; }
    }
    const updateDownloadMatch = req.method === 'GET' && url.pathname.match(/^\/api\/updates\/download\/([A-Za-z0-9_-]{40,48})$/);
    if (updateDownloadMatch) {
      const given = Buffer.from(String(url.searchParams.get('t') || req.headers['x-brainlink-token'] || ''));
      const want = Buffer.from(token);
      if (given.length !== want.length || !timingSafeEqual(given, want)) { json(res, 401, { error: 'Setup session expired. Reopen BrainLink.' }); return; }
      const ticket = updateDownloadMatch[1];
      const pending = updateDownloads.get(ticket);
      if (!pending || pending.expiresAt <= Date.now()) {
        if (pending) { clearTimeout(pending.timer); updateDownloads.delete(ticket); await rm(pending.folder, { recursive: true, force: true }).catch(() => {}); }
        json(res, 404, { error: 'This verified download expired. Check for updates and try again.' });
        return;
      }
      if (pending.downloaded || pending.downloadInProgress || pending.opening) { json(res, 409, { error: 'This verified download is already in progress or has already been downloaded.' }); return; }
      pending.downloadInProgress = true;
      let file;
      try { file = await verifyStagedUpdate(pending); }
      catch (error) {
        pending.downloadInProgress = false;
        json(res, 409, { error: error.message || 'This verified package is no longer available.' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(pending.size),
        'Content-Disposition': `attachment; filename="${pending.filename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      const stream = createReadStream(file);
      stream.once('error', () => res.destroy());
      res.once('finish', () => {
        pending.downloadInProgress = false;
        pending.downloaded = true;
        retainUpdatePackage(ticket, pending);
      });
      res.once('close', () => { if (!res.writableFinished) pending.downloadInProgress = false; });
      res.once('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) { res.writeHead(404).end(); return; }
    const given = Buffer.from(String(req.headers['x-brainlink-token'] || ''));
    const want = Buffer.from(token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) { json(res, 401, { error: 'Setup session expired. Reopen BrainLink.' }); return; }
    let body = {};
    if (req.method === 'POST') {
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > 1e5) { res.writeHead(413).end(); return; } }
      try { body = raw ? JSON.parse(raw) : {}; } catch { json(res, 400, { error: 'Bad JSON' }); return; }
    }
    try {
      const result = url.pathname === '/api/memory/save'
        ? await serializeGraphNoteMutation({ ...body, path: 'BrainLink/Memories.md' }, () => route(body))
        : GRAPH_NOTE_MUTATIONS.has(url.pathname)
        ? await serializeGraphNoteMutation(body, () => route(body))
        : await route(body);
      json(res, 200, result);
    } catch (e) { json(res, 400, { error: String(e.message || e) }); }
  });
  server.once('close', () => { snapshotWatcher?.stop(); vaultWatcher?.stop(); for (const client of eventClients) client.end(); eventClients.clear(); for (const pending of updateDownloads.values()) { clearTimeout(pending.timer); if (!pending.opened) rm(pending.folder, { recursive: true, force: true }).catch(() => {}); } updateDownloads.clear(); clearInterval(discoveryTimer); clearInterval(observationTimer); clearInterval(weeklyBenchmarkTimer); clearInterval(ingestionTimer); clearInterval(githubAutoTimer); clearInterval(localSummaryAutoDraftTimer); if (backupTimer) { clearTimeout(backupTimer); clearInterval(backupTimer); } if (syncTimer) { clearTimeout(syncTimer); clearInterval(syncTimer); } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  port = server.address().port;
  const startupConfig = await loadConfig(file);
  localSummaryAutoDraftKeepsAlive = Boolean(startupConfig.sessions.localSummary.enabled && startupConfig.sessions.localSummary.autoDraftOnEnd);
  touch();
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  if (opts.openUrl) opts.openUrl(url);
  return { server, url, port, token };
}

export function openInBrowser(url, os = process.platform, run = execFile) {
  if (os === 'darwin') run('open', [url]);
  else if (os === 'win32') run('cmd', ['/c', 'start', '', url]);
  else run('xdg-open', [url]);
}

function installedAppBrowserCandidates(os, env, exists) {
  const pathApi = os === 'win32' ? path.win32 : path.posix;
  const found = [];
  const add = (browser, candidate) => { if (candidate && exists(candidate) && !found.some((item) => item.path === candidate)) found.push({ browser, path: candidate }); };
  if (os === 'win32') {
    for (const root of [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean)) {
      add('edge', pathApi.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)) {
      add('chrome', pathApi.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (os === 'darwin') {
    const homes = [env.HOME ? pathApi.join(env.HOME, 'Applications') : null, '/Applications'].filter(Boolean);
    for (const home of homes) {
      add('edge', pathApi.join(home, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'));
      add('chrome', pathApi.join(home, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
      add('chromium', pathApi.join(home, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    }
  } else if (os === 'linux') {
    const binaries = [
      ['edge', 'microsoft-edge-stable'], ['edge', 'microsoft-edge'],
      ['chrome', 'google-chrome-stable'], ['chrome', 'google-chrome'],
      ['chromium', 'chromium'], ['chromium', 'chromium-browser'],
    ];
    const search = String(env.PATH || '').split(pathApi.delimiter);
    for (const [browser, binary] of binaries) for (const folder of search) {
      if (folder) add(browser, pathApi.join(folder, binary));
    }
  }
  return found;
}

// The installed desktop icon should feel like opening an app, while CLI use keeps
// the user's normal browser. Only pass a loopback Setup URL to a browser app window.
export function openInAppWindow(url, { os = process.platform, env = process.env, exists = existsSync, run = execFile } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { parsed = null; }
  const local = parsed && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    && ['http:', 'https:'].includes(parsed.protocol);
  if (local) {
    const browser = installedAppBrowserCandidates(os, env, exists)[0];
    if (browser) {
      const child = run(browser.path, [`--app=${url}`], (error) => { if (error) openInBrowser(url, os, run); });
      child?.unref?.();
      return { mode: 'app', browser: browser.browser };
    }
  }
  openInBrowser(url, os, run);
  return { mode: 'browser', browser: 'default' };
}

export { CLIENTS };

