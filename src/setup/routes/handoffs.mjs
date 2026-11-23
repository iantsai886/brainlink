// Handoffs destination routes: mailbox selection, preview/confirm and receipt list.
export function createHandoffRoutes({
  file, loadConfig, inspectVaultStructure, randomBytes, handoffMailboxPreviews,
  withConfigMutation, saveConfig, refreshVaultWatcher, localContext, env,
  listHandoffs,
}) {
  return {
    'POST /api/handoff-mailbox/preview': async (b) => {
      const cfg = await loadConfig(file), vault = cfg.vaults.find((item) => item.name === String(b.vault || ''));
      if (!vault) throw new Error('Choose a configured vault.');
      const folder = String(b.folder || '').replace(/^\/+|\/+$/g, '');
      if (!folder || !(await inspectVaultStructure(vault.path)).folders.includes(folder)) throw new Error('Choose an existing, non-excluded mailbox folder.');
      const preview = { id: randomBytes(24).toString('base64url'), from: cfg.handoff || null, to: { vault: vault.name, folder }, private_vault: Boolean(vault.private), expires_at: Date.now() + 15 * 60_000 };
      handoffMailboxPreviews.set(preview.id, preview);
      return { id: preview.id, from: preview.from, to: preview.to, private_vault: preview.private_vault, existing_files_stay_in_place: true, expires_in_minutes: 15 };
    },
    'POST /api/handoff-mailbox/confirm': async (b) => {
      if (b.confirm !== true) throw new Error('Review the mailbox change preview before confirming.');
      const id = String(b.id || ''), preview = handoffMailboxPreviews.get(id);
      if (!preview || preview.expires_at < Date.now()) throw new Error('This mailbox preview expired.');
      handoffMailboxPreviews.delete(id);
      const cfg = await withConfigMutation(async () => {
        const current = await loadConfig(file);
        if (JSON.stringify(current.handoff || null) !== JSON.stringify(preview.from)) throw new Error('The current mailbox changed after preview. Review the change again.');
        const vault = current.vaults.find((item) => item.name === preview.to.vault);
        if (!vault || !(await inspectVaultStructure(vault.path)).folders.includes(preview.to.folder)) throw new Error('The selected mailbox folder is no longer available.');
        current.handoff = preview.to;
        await saveConfig(current, file);
        return current;
      });
      refreshVaultWatcher(cfg);
      return { ok: true, handoff: cfg.handoff, private_vault: Boolean(cfg.vaults.find((item) => item.name === cfg.handoff.vault)?.private), existing_files_stay_in_place: true };
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
  };
}