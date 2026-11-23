// Proposal review routes shown under the Review destination.
export function createReviewRoutes({
  proposalInbox, createHash, loadConfig, file, normalize, localContext, env,
  findSecrets, path, stat, search, realpath, checkWritePath, mkdir, readFile,
  writeFile, appendTo, vaultRoot, commitNew, logActivity, listDecisionReviews, readDecisionReview,
  validReviewDate, proposeNote, safeJoin, decisionReviewPreviews, randomBytes, conflictReviewStore,
  listConflictCandidates, conflictReviewPreviews, buildTidyBatch, tidyState, tidyBatches,
  tidyPreviews, readNote, tidyAppendBlock,
}) {
  return {
    'GET /api/proposals': async () => ({ proposals: (await proposalInbox.listPending()).map(({ id, vault, path: rel, content, tool, agent, agent_verified, created_at }) => ({ id, vault, path: rel, content, tool, agent, agent_verified, created_at, edit_token: createHash('sha256').update(`${rel}\0${content}`).digest('hex') })) }),
    'POST /api/proposals/edit-preview': async (b) => {
      const proposal = await proposalInbox.getPending(String(b.id || ''));
      if (!proposal) throw new Error('This proposal is no longer pending. Refresh the review list.');
      const cfg = normalize(await loadConfig(file)), ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      const vault = ctx.byName.get(proposal.vault);
      if (!vault || !ctx.enabled.includes(proposal.vault) || vault.private || vault.writes === 'off') throw new Error('This proposal destination is not available for owner review.');
      const rel = String(b.path || proposal.path).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const content = String(b.content ?? proposal.content);
      if (!rel.endsWith('.md') || rel.split('/').some(part => !part || part === '.' || part === '..') || !content.trim() || content.length > 100_000 || findSecrets(content).length) throw new Error('Enter a safe Markdown destination and non-empty draft without secrets.');
      if (proposal.action === 'append' && rel !== proposal.path) throw new Error('An append proposal must keep its original destination.');
      const parent = path.posix.dirname(rel);
      if (parent !== '.' && !(await stat(path.join(vault.path, parent)).then(s => s.isDirectory(), () => false))) throw new Error('Choose an existing destination folder in this vault.');
      if (b.confirm === true) {
        const updated = await proposalInbox.updatePending({ id: proposal.id, expected: String(b.edit_token || ''), path: rel, content });
        return { ok: true, path: updated.path, content: updated.content };
      }
      const title = content.match(/^#\s+(.+)$/m)?.[1] || path.posix.basename(rel, '.md');
      const similarityQuery = `${title} ${content.replace(/^#.*$/m, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()}`.slice(0, 500);
      const similar = (await search(ctx, proposal.vault, similarityQuery, 5)).filter(note => note.path !== rel).slice(0, 3).map(note => ({ path: note.path, title: note.title, status: note.status }));
      return { preview: { vault: proposal.vault, path: rel, content, reason: `Requested by ${proposal.agent || 'an AI agent'} through ${proposal.tool || 'BrainLink'}.`, similar, action: proposal.action } };
    },
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
    'POST /api/tidy/generate': async (b) => {
      const cfg = await loadConfig(file), ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      const vault = String(b.vault || '');
      if (!ctx.enabled.includes(vault)) throw new Error('Choose an enabled vault.');
      const offset = b.offset === undefined ? 0 : b.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error('Tidy batch offset is invalid.');
      const result = await buildTidyBatch(ctx, vault, { dismissed: await tidyState.resolved(), limit: 50, offset });
      const batch_id = randomBytes(24).toString('base64url');
      tidyBatches.set(batch_id, { ...result, expires_at: Date.now() + 30 * 60_000 });
      return { batch_id, ...result };
    },
    'POST /api/tidy/dismiss-preview': async (b) => {
      const batch = tidyBatches.get(String(b.batch_id || ''));
      if (!batch || batch.expires_at < Date.now()) throw new Error('This tidy batch expired. Generate it again.');
      const ids = Array.isArray(b.item_ids) ? [...new Set(b.item_ids.map(String))] : [];
      if (!ids.length || ids.length > 50 || ids.some((id) => !batch.items.some((item) => item.id === id))) throw new Error('Choose valid tidy items from this batch.');
      const id = randomBytes(24).toString('base64url');
      tidyPreviews.set(id, { action: 'dismiss', item_ids: ids, expires_at: Date.now() + 15 * 60_000 });
      return { id, items: batch.items.filter((item) => ids.includes(item.id)).map(({ id: itemId, kind, source, target }) => ({ id: itemId, kind, source, target })), message: 'The selected suggestions will be dismissed in local BrainLink state. No vault note will change.', expires_in_minutes: 15 };
    },
    'POST /api/tidy/dismiss-confirm': async (b) => {
      if (b.confirm !== true) throw new Error('Review the dismissal preview before confirming.');
      const id = String(b.id || ''), preview = tidyPreviews.get(id);
      if (!preview || preview.action !== 'dismiss' || preview.expires_at < Date.now()) throw new Error('This tidy preview expired.');
      tidyPreviews.delete(id);
      await tidyState.resolve(preview.item_ids);
      return { ok: true, dismissed: preview.item_ids.length };
    },
    'POST /api/tidy/apply-preview': async (b) => {
      const batch = tidyBatches.get(String(b.batch_id || ''));
      if (!batch || batch.expires_at < Date.now()) throw new Error('This tidy batch expired. Generate it again.');
      const ids = Array.isArray(b.item_ids) ? [...new Set(b.item_ids.map(String))] : [];
      if (!ids.length || ids.length > 50 || ids.some((id) => !batch.items.some((item) => item.id === id))) throw new Error('Choose valid tidy items from this batch.');
      const selected = batch.items.filter((item) => ids.includes(item.id));
      if (selected.some((item) => item.kind === 'conflict')) throw new Error('Resolve duplicate candidates in Possible conflicts, where you can choose which note stands.');
      const cfg = await loadConfig(file), ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!ctx.enabled.includes(batch.vault)) throw new Error('The destination vault is no longer enabled.');
      const groups = new Map();
      for (const item of selected) { const rows = groups.get(item.source.path) || []; rows.push(item); groups.set(item.source.path, rows); }
      const files = [];
      for (const [rel, items] of groups) {
        await readNote(ctx, batch.vault, rel);
        for (const item of items) await readNote(ctx, batch.vault, item.target.path);
        const full = safeJoin(vaultRoot(ctx, batch.vault), rel);
        const bytes = await readFile(full);
        files.push({ path: rel, expected_hash: createHash('sha256').update(bytes).digest('hex'), append: tidyAppendBlock(items), item_ids: items.map((item) => item.id), items: items.map(({ kind, source, target, reason }) => ({ kind, source, target, reason })) });
      }
      const id = randomBytes(24).toString('base64url');
      tidyPreviews.set(id, { action: 'apply', vault: batch.vault, files, item_ids: selected.map((item) => item.id), expires_at: Date.now() + 15 * 60_000 });
      return { id, vault: batch.vault, files: files.map(({ path: rel, append, items }) => ({ path: rel, append, items })), item_count: selected.length, expires_in_minutes: 15 };
    },
    'POST /api/tidy/apply-confirm': async (b) => {
      if (b.confirm !== true) throw new Error('Review the exact append blocks before confirming.');
      const id = String(b.id || ''), preview = tidyPreviews.get(id);
      if (!preview || preview.action !== 'apply' || preview.expires_at < Date.now()) throw new Error('This tidy preview expired.');
      tidyPreviews.delete(id);
      const cfg = await loadConfig(file), ctx = localContext(cfg, { ...env, BRAINLINK_SEMANTIC: '0' });
      if (!ctx.enabled.includes(preview.vault)) throw new Error('The destination vault is no longer enabled.');
      const root = vaultRoot(ctx, preview.vault);
      for (const item of preview.files) {
        await readNote(ctx, preview.vault, item.path);
        for (const suggestion of item.items) await readNote(ctx, preview.vault, suggestion.target.path);
        const current = await readFile(safeJoin(root, item.path));
        if (createHash('sha256').update(current).digest('hex') !== item.expected_hash) throw new Error(`The note ${item.path} changed after preview. Generate and review a new tidy batch.`);
      }
      for (const item of preview.files) await appendTo(root, item.path, item.append);
      await tidyState.resolve(preview.item_ids);
      await logActivity(env, { tool: 'tidy_apply', ok: true });
      return { ok: true, files_changed: preview.files.map((item) => `${preview.vault}/${item.path}`), items_applied: preview.item_ids.length };
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
  };
}