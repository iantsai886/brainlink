// Shared snapshot panel (Ian's RB8): "Share a read-only copy with cloud agents" toggle. Self-
// contained on purpose (own fetch/render, no globals from the main page), same pattern as
// agents.js and notes3d.js, so it never conflicts with the parallel branch reshaping index.html
// into tabs -- see the single script tag + mount point (#s-share / #share-root) added there.
(function () {
  const T = new URLSearchParams(location.search).get('t') || '';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': T }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  async function apiState() {
    const r = await fetch('/api/state', { headers: { 'X-BrainLink-Token': T } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  function toast(msg, bad) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg; el.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(el._shareToastTimer); el._shareToastTimer = setTimeout(() => (el.className = ''), bad ? 6000 : 3500);
  }

  const header = () => `<h2>${esc(t('share.title'))}</h2>`;

  function statusHtml(snap) {
    if (snap.error) {
      // F2: a lost/corrupt manifest fails closed rather than guessing, so the only way forward
      // is an explicit reset -- offer that action right next to the error, not just the message.
      const action = snap.action === 'clear_and_reshare' ? ` <button data-share-clear-reshare>${esc(t('share.clearAndReshare'))}</button>` : '';
      return `<p class="error-box">${esc(t('share.statusError', { error: snap.error }))}${action}</p>`;
    }
    if (!snap.lastSyncedAt) return `<p class="muted">${esc(t('share.statusNeverSynced'))}</p>`;
    const when = new Date(snap.lastSyncedAt).toLocaleString();
    return `<p class="muted">${esc(snap.noteCount === 1 ? t('share.statusLastSyncedOne', { when }) : t('share.statusLastSynced', { when, count: snap.noteCount }))}</p>`;
  }

  function render(root, state) {
    const { loading, error, hasVault, snap, draft } = state;
    if (loading) { root.innerHTML = `${header()}<p class="skeleton">${esc(t('share.loading'))}</p>`; return; }
    if (error) { root.innerHTML = `${header()}<p class="error-box">${esc(t('share.loadError', { error }))} <button data-share-retry>${esc(t('share.retry'))}</button></p>`; return; }
    if (!hasVault) { root.innerHTML = `${header()}<p class="muted">${esc(t('share.needVault'))}</p>`; return; }
    const folderArea = draft.enabled ? `
      <div class="grid2" style="margin-top:12px">
        <label>${esc(t('share.folderLabel'))}<input id="share-folder" class="mono" value="${esc(draft.folder || '')}" placeholder="${esc(t('share.folderPlaceholder'))}"></label>
        <div class="row" style="align-self:end"><button id="share-pick">${esc(t('share.pickFolder'))}</button></div>
      </div>
      ${!draft.folder && snap.suggested_folder ? `<p class="hint" style="margin:8px 0 0">${t('share.suggestedFound', { path: `<button type="button" class="link" data-share-use-suggested="${esc(snap.suggested_folder)}">${esc(snap.suggested_folder)}</button>` })}</p>` : ''}
      <label class="muted" style="display:flex;flex-direction:row;gap:6px;align-items:center;margin-top:10px"><input type="checkbox" id="share-sessions" ${draft.includeSessions ? 'checked' : ''} style="width:auto"> ${esc(t('share.includeSessions'))}</label>
    ` : '';
    root.innerHTML = `
      ${header()}
      <p class="hint">${esc(t('share.hint'))}</p>
      <label class="muted" style="display:flex;flex-direction:row;gap:6px;align-items:center"><input type="checkbox" id="share-enabled" ${draft.enabled ? 'checked' : ''} style="width:auto"> ${esc(t('share.toggleLabel'))}</label>
      ${folderArea}
      <div class="row" style="margin-top:12px"><button class="primary" id="share-save">${esc(t('share.save'))}</button></div>
      ${snap.enabled ? `<div id="share-status" style="margin-top:10px">${statusHtml(snap)}</div>` : ''}`;
  }

  async function boot() {
    const section = document.getElementById('s-share');
    const root = document.getElementById('share-root');
    if (!section || !root) return;
    await window.brainlinkLocaleBooted;
    let state = { loading: true, error: null, hasVault: false, snap: null, draft: { enabled: false, folder: null, includeSessions: false } };
    const draw = () => render(root, state);
    draw();

    async function load() {
      try {
        const st = await apiState();
        const snap = st.snapshot;
        state = { ...state, loading: false, error: null, hasVault: (st.vaults || []).length > 0, snap, draft: { enabled: snap.enabled, folder: snap.folder, includeSessions: snap.includeSessions } };
      } catch (e) { state = { ...state, loading: false, error: e.message }; }
      draw();
    }

    root.addEventListener('change', (e) => {
      if (e.target.id === 'share-enabled') { state.draft.enabled = e.target.checked; draw(); }
      if (e.target.id === 'share-sessions') { state.draft.includeSessions = e.target.checked; }
    });

    root.addEventListener('click', async (e) => {
      const d = e.target.dataset;
      try {
        if (d.shareRetry !== undefined) { state.loading = true; draw(); await load(); return; }
        if (d.shareUseSuggested !== undefined) { state.draft.folder = d.shareUseSuggested; draw(); return; }
        if (d.shareClearReshare !== undefined) {
          if (!window.confirm?.(t('share.confirmClearReshare'))) return;
          await api('/api/snapshot/clear', { force: true });
          toast(t('share.toastCleared'));
          await load();
          return;
        }
        if (e.target.id === 'share-pick') {
          const r = await api('/api/snapshot/pick-folder');
          const p = r.path || (r.unavailable ? await window.promptForFolder?.() : '');
          if (p) { state.draft.folder = p; draw(); }
          return;
        }
        if (e.target.id === 'share-save') {
          const folderInput = document.getElementById('share-folder');
          const sessionsInput = document.getElementById('share-sessions');
          const folder = folderInput ? folderInput.value.trim() : state.draft.folder;
          const includeSessions = sessionsInput ? sessionsInput.checked : state.draft.includeSessions;
          if (state.draft.enabled && !folder) { toast(t('share.toastNeedFolder'), true); return; }
          const turningOff = state.snap.enabled && !state.draft.enabled;
          if (turningOff && !window.confirm?.(t('share.confirmStop'))) { state.draft.enabled = true; draw(); return; }
          const prevFolder = state.snap.folder;
          const r = await api('/api/snapshot', { enabled: state.draft.enabled, folder: state.draft.enabled ? folder : prevFolder, includeSessions });
          state.snap = r.snapshot;
          state.draft = { enabled: r.snapshot.enabled, folder: r.snapshot.folder, includeSessions: r.snapshot.includeSessions };
          draw();
          toast(turningOff ? t('share.toastStopped') : t('share.toastSaved'));
          if (turningOff && prevFolder && window.confirm?.(t('share.confirmClear'))) {
            await api('/api/snapshot/clear');
            toast(t('share.toastCleared'));
          }
          return;
        }
      } catch (err) { toast(err.message, true); }
    });

    // index.html's load() fires this after every /api/state refresh, so a vault picked/created
    // there (hasVault was false) is reflected here right away instead of needing a manual reload.
    window.addEventListener('brainlink:state-updated', () => { load(); });

    await load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
