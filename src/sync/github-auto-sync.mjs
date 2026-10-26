// Opt-in scheduler orchestration. All note access and Git mutations are delegated to the same
// profile-authorized, privacy-scanning functions used by the manual GitHub flow.
const LIMIT = 100;

export async function runGitHubAutoSync({ ctx, profile, state = {}, operations, now = new Date(), trigger = 'schedule', isEnabled = async () => true }) {
  const assignment = profile?.github_repository;
  if (!profile || !assignment || assignment.automatic_sync?.enabled !== true) throw new Error('Automatic GitHub sync is not enabled for this Twin profile.');
  const base = { profile_id: profile.id, remote: assignment.remote, vault: assignment.vault, at: now.toISOString(), trigger, ok: false };
  const receipts = { ...state };
  const report = { ...base, pulled: 0, pushed: 0, conflicts: 0, deferred: 0, pending: null, error: null };
  try {
    const requireOptIn = async () => { if (!await isEnabled(profile)) throw new Error('Sync stopped because automatic publishing was disabled or this Twin’s repository assignment changed.'); };
    await requireOptIn();
    // Retry an exact BrainLink commit left behind by a network interruption. Never create a
    // second commit until the previous commit has either reached origin or needs human review.
    const profileState = receipts[profile.id] || {};
    const pending = profileState.pending;
    if (pending) {
      await requireOptIn();
      const pushed = await operations.push({ ctx, repoPath: assignment.path, vaultName: assignment.vault, profileId: profile.id, paths: pending.paths, commit: pending.commit });
      delete profileState.pending;
      if (!profileState.cursorPath) delete receipts[profile.id];
      else receipts[profile.id] = profileState;
      await operations.saveState(receipts);
      report.pushed += pushed.files?.length || pending.paths.length;
    }

    const incoming = await operations.pullCandidates({ ctx, repoPath: assignment.path, vaultName: assignment.vault, profileId: profile.id });
    const incomingFiles = incoming.files || [];
    const conflicts = incomingFiles.filter((item) => item.action === 'conflict');
    report.conflicts = conflicts.length;
    if (conflicts.length) throw new Error(`Sync paused: ${conflicts.length} note conflict(s) need review. Local and GitHub copies were kept.`);
    const pullable = incomingFiles.filter((item) => ['add', 'update'].includes(item.action));
    report.deferred += Math.max(0, pullable.length - LIMIT);
    const pullPaths = pullable.slice(0, LIMIT).map((item) => item.path);
    if (pullPaths.length) {
      await requireOptIn();
      const imported = await operations.import({ ctx, repoPath: assignment.path, vaultName: assignment.vault, profileId: profile.id, paths: pullPaths });
      report.pulled += (imported.imported?.length || 0) + (imported.updated?.length || 0);
    }

    const candidates = await operations.shareCandidates(ctx, assignment.vault, profile.id);
    const previousCursor = receipts[profile.id]?.cursorPath;
    const startAt = previousCursor ? candidates.findIndex((item) => item.path > previousCursor) : 0;
    const start = startAt < 0 ? 0 : startAt;
    const ordered = [...candidates.slice(start), ...candidates.slice(0, start)];
    report.deferred += Math.max(0, ordered.length - LIMIT);
    const selected = ordered.slice(0, LIMIT).map((item) => item.path);
    if (selected.length) {
      receipts[profile.id] = { ...(receipts[profile.id] || {}), cursorPath: selected.at(-1) };
      await operations.saveState(receipts);
    }
    if (selected.length) {
      const preview = await operations.preview({ ctx, repoPath: assignment.path, vaultName: assignment.vault, profileId: profile.id, paths: selected });
      const blocked = preview.files.filter((item) => item.action === 'blocked_local_change');
      if (blocked.length) throw new Error(`Sync paused: ${blocked.length} repository file(s) have local changes. Nothing was overwritten or pushed.`);
      const changed = preview.files.filter((item) => ['add', 'update'].includes(item.action)).map((item) => item.path);
      if (changed.length) {
        await requireOptIn();
        const commit = await operations.commit({ ctx, repoPath: assignment.path, vaultName: assignment.vault, profileId: profile.id, paths: changed });
        if (commit.committed) {
          const committedPaths = Array.isArray(commit.committed_paths) ? commit.committed_paths : changed;
          receipts[profile.id] = { ...(receipts[profile.id] || {}), pending: { commit: commit.commit, paths: committedPaths } };
          report.pending = commit.commit;
          await operations.saveState(receipts);
          await requireOptIn();
          const pushed = await operations.push({ ctx, repoPath: assignment.path, vaultName: assignment.vault, profileId: profile.id, paths: committedPaths, commit: commit.commit });
          report.pushed += pushed.files?.length || committedPaths.length;
          delete receipts[profile.id].pending;
          if (!receipts[profile.id].cursorPath) delete receipts[profile.id];
          report.pending = null;
          await operations.saveState(receipts);
        }
      }
    }
    report.ok = true;
    if (report.deferred) report.error = `${report.deferred} additional notes are queued for a later scheduled run.`;
    return { report, state: receipts };
  } catch (error) {
    report.error = String(error?.message || error).slice(0, 500);
    report.pending = receipts[profile.id]?.pending?.commit || report.pending;
    return { report, state: receipts };
  }
}

export const GITHUB_AUTO_SYNC_LIMIT = LIMIT;
