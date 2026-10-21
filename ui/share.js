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
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(t._shareToastTimer); t._shareToastTimer = setTimeout(() => (t.className = ''), bad ? 6000 : 3500);
  }

  function statusHtml(snap) {
    if (snap.error) return `<p class="error-box">Could not finish sharing: ${esc(snap.error)}</p>`;
    if (!snap.lastSyncedAt) return '<p class="muted">Not shared yet.</p>';
    const when = new Date(snap.lastSyncedAt).toLocaleString();
    return `<p class="muted">Last synced ${esc(when)} · ${snap.noteCount} note${snap.noteCount === 1 ? '' : 's'} shared.</p>`;
  }

  function render(root, state) {
    const { loading, error, hasVault, snap, draft } = state;
    if (loading) { root.innerHTML = '<h2>Share with cloud agents</h2><p class="skeleton">Loading sharing settings…</p>'; return; }
    if (error) { root.innerHTML = `<h2>Share with cloud agents</h2><p class="error-box">Could not load sharing settings: ${esc(error)} <button data-share-retry>Retry</button></p>`; return; }
    if (!hasVault) { root.innerHTML = '<h2>Share with cloud agents</h2><p class="muted">Add a folder first (above), then come back to share it.</p>'; return; }
    const folderArea = draft.enabled ? `
      <div class="grid2" style="margin-top:12px">
        <label>Shared folder<input id="share-folder" class="mono" value="${esc(draft.folder || '')}" placeholder="Choose a folder…"></label>
        <div class="row" style="align-self:end"><button id="share-pick">Choose folder…</button></div>
      </div>
      ${!draft.folder && snap.suggested_folder ? `<p class="hint" style="margin:8px 0 0">Found: <button type="button" class="link" data-share-use-suggested="${esc(snap.suggested_folder)}">${esc(snap.suggested_folder)}</button></p>` : ''}
      <label class="muted" style="display:flex;flex-direction:row;gap:6px;align-items:center;margin-top:10px"><input type="checkbox" id="share-sessions" ${draft.includeSessions ? 'checked' : ''} style="width:auto"> Also include non-private chat sessions</label>
    ` : '';
    root.innerHTML = `
      <h2>Share with cloud agents</h2>
      <p class="hint">Give a cloud AI (for example a bot that only reads files) a read-only copy of your notes through a folder it can already reach. BrainLink never opens a network connection itself.</p>
      <label class="muted" style="display:flex;flex-direction:row;gap:6px;align-items:center"><input type="checkbox" id="share-enabled" ${draft.enabled ? 'checked' : ''} style="width:auto"> Share a read-only copy with cloud agents</label>
      ${folderArea}
      <div class="row" style="margin-top:12px"><button class="primary" id="share-save">Save</button></div>
      ${snap.enabled ? `<div id="share-status" style="margin-top:10px">${statusHtml(snap)}</div>` : ''}`;
  }

  async function boot() {
    const section = document.getElementById('s-share');
    const root = document.getElementById('share-root');
    if (!section || !root) return;
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
          if (state.draft.enabled && !folder) { toast('Choose a folder first.', true); return; }
          const turningOff = state.snap.enabled && !state.draft.enabled;
          if (turningOff && !window.confirm?.('Stop sharing? Cloud agents will no longer see new changes.')) { state.draft.enabled = true; draw(); return; }
          const prevFolder = state.snap.folder;
          const r = await api('/api/snapshot', { enabled: state.draft.enabled, folder: state.draft.enabled ? folder : prevFolder, includeSessions });
          state.snap = r.snapshot;
          state.draft = { enabled: r.snapshot.enabled, folder: r.snapshot.folder, includeSessions: r.snapshot.includeSessions };
          draw();
          toast(turningOff ? 'Sharing turned off.' : 'Saved.');
          if (turningOff && prevFolder && window.confirm?.('Also delete the files already shared in that folder?')) {
            await api('/api/snapshot/clear');
            toast('Shared files removed.');
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
