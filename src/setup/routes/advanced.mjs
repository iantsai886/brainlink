// Advanced operational routes (updates, reranker, snapshot, backup, ingestion, brief,
// startup, self-test, retrieval-use, and replay-misses) extracted from src/setup.mjs.
export function createAdvancedRoutes({
  file, env, home, os, opts, token, VERSION, UPDATE_PUBLIC_KEYS,
  loadConfig, saveConfig, normalize, validate, localContext, withConfigMutation,
  stat, rm, randomBytes, timingSafeEqual,
  checkForUpdate, downloadVerifiedUpdate, updateDownloads, verifyStagedUpdate, openUpdatePackage, retainUpdatePackage,
  testReranker, validateRerankerSettings,
  pickSnapshotFolder, chooseSnapshot, refreshSnapshotWatcher, loadSnapshotStatus, snapshotStateFile, snapshotSettings, suggestSnapshotFolder, clearSnapshot,
  pickBackupFolder, requireBackupKey, listVerifiedBackups, createOrReadBackupRecoveryKey, pickRestoreSourceFolder, pickRestoreDestinationFolder,
  normalizeBackupSchedule, parseBackupKey, runBackup, backupScheduleDue, localDateAndTime, refreshBackupTimer, getBackupStatus, restoreBackupToEmpty,
  validateIngestionSchedule, listSessionFilingFolders, ingestionQueue, refreshIngestionSchedule, getIngestionStatus, runIngestion, runScheduledIngestionDrafts,
  readIngestionSource, typedEntitiesForIngestionSource, generateLocalIngestionDraft, relatedText, redactText, saveIngestionDraft, ingestionDraftsDir,
  listIngestionDrafts, readIngestionDraft, recordIngestion, removeIngestionDraft, saveIngestionDraftRecord,
  validateBriefSchedule, refreshBriefSchedule, getBriefStatus, runBrief,
  setStartupEnabled, logActivity, search, runSelfTest, retrievalUseReport, readActivity,
  createReplayMisses, proposeNote, teachPreviews, commitNew, searchWithVerdict,
}) {
  return {
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
        const stagedFile = await verifyStagedUpdate(pending);
        await (opts.updateLauncher || openUpdatePackage)({ file: stagedFile, format: pending.format, platform: os });
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
    'POST /api/snapshot/pick-folder': async () => { const p = await pickSnapshotFolder(); return p === undefined ? { path: null, unavailable: true } : { path: p }; },
    'POST /api/snapshot': async (b) => {
      const cfg = await loadConfig(file);
      const next = chooseSnapshot(cfg, { enabled: b.enabled, folder: b.folder, includeSessions: b.includeSessions });
      await saveConfig(next, file);
      await refreshSnapshotWatcher(next);
      const status = await loadSnapshotStatus(snapshotStateFile);
      return { ok: true, snapshot: { ...snapshotSettings(next), suggested_folder: suggestSnapshotFolder(home), ...status } };
    },
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
        await runBackup(next, 'setup');
        if (backupScheduleDue(next.backup, new Date(), next.timezone)) next.backup.last_scheduled_date = localDateAndTime(new Date(), next.timezone).date;
      }
      await saveConfig(next, file);
      refreshBackupTimer(next);
      return { ok: true, backup: { ...next.backup, status: getBackupStatus() } };
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
      return { ok: true, ingestion: { ...next.ingestion, status: getIngestionStatus() } };
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
      return { ok: true, brief: { ...next.brief, status: getBriefStatus() } };
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
    'POST /api/self-test': async () => {
      const cfg = normalize(await loadConfig(file));
      return runSelfTest(localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: '' }));
    },
    'POST /api/retrieval-use': async (b) => {
      const cfg = normalize(await loadConfig(file));
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: '' });
      return retrievalUseReport(ctx, await readActivity(env, 20000), { days: b.days === undefined ? 60 : Number(b.days), vault: String(b.vault || '') });
    },
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
    'POST /api/replay-misses/pin': async (b) => {
      const cfg = normalize(await loadConfig(file));
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: '' });
      const misses = createReplayMisses({ home: ctx.dataDir });
      const miss = await misses.get(b.id);
      if (!miss || !ctx.enabled.includes(miss.vault) || ctx.byName.get(miss.vault)?.private) throw new Error('That miss is unavailable in the current shared-vault scope.');
      const replay = await misses.replay(ctx);
      const current = replay.results.find((item) => item.id === miss.id);
      if (current?.now !== 'hits' || !current.top?.path) throw new Error('Pinning requires a current successful result with a top note.');
      if (!await misses.pin(miss.id, current.top.path)) throw new Error('The regression case could not be pinned.');
      return { ok: true, expected_path: current.top.path };
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
  };
}
