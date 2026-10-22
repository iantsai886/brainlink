// Agents panel (RB7 item 1): add any number of AI agents on top of the preset apps, each with
// its own key. Self-contained on purpose (own fetch/render, no globals from the main page) so it
// never conflicts with the parallel branch reshaping index.html into tabs — see the single
// script tag + mount point (#agents-panel / #agents-root) added there.
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
    clearTimeout(el._agentsToastTimer); el._agentsToastTimer = setTimeout(() => (el.className = ''), bad ? 6000 : 3500);
  }

  // src/mcp-agents.mjs / src/setup.mjs return plain English error/result text (no locale context
  // server-side); map the known exact messages back to the matching translated key so the Agents
  // card reads in the user's language instead of always English.
  const SERVER_MESSAGE_KEYS = {
    'Give the agent a name.': 'agents.errNeedName',
    'Unknown agent. It may already have been removed.': 'agents.errUnknown',
    'Add a vault first, then test the connection.': 'agents.errNeedVaultForTest',
    'That key was not recognized. It may have been revoked or mistyped.': 'agents.errKeyNotRecognized',
    'The call failed; see Activity below.': 'agents.testFailed',
  };
  function localizeServerMessage(msg) {
    if (SERVER_MESSAGE_KEYS[msg]) return t(SERVER_MESSAGE_KEYS[msg]);
    const dup = /^An agent named "(.+)" already exists\.$/.exec(msg);
    if (dup) return t('agents.errDuplicateName', { name: dup[1] });
    const succeeded = /^Live call succeeded \((\d+)ms\)\. This agent is now connected\.$/.exec(msg);
    if (succeeded) return t('agents.testSucceeded', { ms: succeeded[1] });
    return msg;
  }

  // Keeps a just-created key in memory only for this page load, so "Test connection" works right
  // after Add without asking the user to paste it back in. Never sent anywhere but /api/agents/test.
  const freshKeys = new Map(); // id -> key

  function statusPill(a) {
    if (a.revoked) return `<span class="pill">${esc(t('agents.statusKeyOff'))}</span>`;
    return a.connected ? `<span class="pill on">${esc(t('agents.statusConnected'))}</span>` : `<span class="pill">${esc(t('agents.statusNotConnected'))}</span>`;
  }
  function kindLabel(a) { return a.kind === 'remote' ? t('agents.kindRemote') : t('agents.kindLocal'); }

  function agentCard(a) {
    const hasFreshKey = freshKeys.has(a.id);
    return `<div class="card agent-card" data-agent="${esc(a.id)}">
      <div class="row" style="justify-content:space-between">
        <b>${esc(a.name)}</b>
        ${statusPill(a)}
      </div>
      <div class="muted" style="font-size:13px">${esc(kindLabel(a))}${a.lastSeenAt ? ' · ' + esc(t('agents.lastUsed', { when: new Date(a.lastSeenAt).toLocaleString() })) : ''}</div>
      <div class="row" style="margin-top:6px">
        <button class="link" data-agent-rename="${esc(a.id)}">${esc(t('agents.rename'))}</button>
        ${a.revoked ? '' : `<button class="link" data-agent-test="${esc(a.id)}">${esc(t('agents.test'))}</button><button class="link" data-agent-revoke="${esc(a.id)}">${esc(t('agents.turnOffKey'))}</button>`}
        <button class="link" data-agent-remove="${esc(a.id)}">${esc(t('agents.remove'))}</button>
      </div>
      ${hasFreshKey ? '' : !a.revoked ? `<div class="row agent-test-row" data-agent-test-row="${esc(a.id)}" hidden style="margin-top:6px">
        <input type="password" placeholder="${esc(t('agents.pasteKeyPlaceholder'))}" data-agent-test-input="${esc(a.id)}" style="flex:1;min-width:200px">
        <button data-agent-test-go="${esc(a.id)}">${esc(t('agents.check'))}</button>
      </div>` : ''}
      <div class="agent-test-out" data-agent-test-out="${esc(a.id)}"></div>
    </div>`;
  }

  function revealHtml(a, token, snippet) {
    const setupText = a.kind === 'remote'
      ? `Address: ${snippet.url}\nKey: Bearer ${token}`
      : JSON.stringify(snippet, null, 2);
    return `<div class="card agent-reveal">
      <b>${esc(t('agents.ready', { name: a.name }))}</b>
      <p class="hint" style="margin:4px 0 8px">${esc(t('agents.copyKeyHint'))}</p>
      <div class="row"><code class="mono agent-key" style="flex:1">${esc(token)}</code><button data-copy="${esc(token)}">${esc(t('agents.copyKey'))}</button></div>
      <details style="margin-top:10px"><summary>${esc(t('agents.connectionDetailsFor', { name: a.name }))}</summary>
        <pre class="mono agent-snippet">${esc(setupText)}</pre>
      </details>
      ${a.kind === 'remote' ? `<p class="notice" style="margin-top:10px">${esc(t('agents.remoteNote'))}</p>` : ''}
      <div class="row" style="margin-top:10px"><button class="primary" data-agent-test="${esc(a.id)}">${esc(t('agents.testNow'))}</button><button class="link" data-reveal-done="${esc(a.id)}">${esc(t('agents.done'))}</button></div>
    </div>`;
  }

  function render(root, state) {
    const { agents, reveal, loading, error, hasVault } = state;
    if (loading) { root.innerHTML = `<p class="skeleton">${esc(t('agents.loading'))}</p>`; return; }
    if (error) { root.innerHTML = `<p class="error-box">${esc(t('agents.loadError', { error }))} <button data-agent-retry>${esc(t('agents.retry'))}</button></p>`; return; }
    if (!hasVault) { root.innerHTML = `<p class="muted">${esc(t('agents.needVault'))}</p>`; return; }
    const revealBlock = reveal ? revealHtml(reveal.agent, reveal.token, reveal.snippet) : '';
    const list = agents.length
      ? `<div class="cards">${agents.filter((a) => !reveal || a.id !== reveal.agent.id).map(agentCard).join('')}</div>`
      : (reveal ? '' : `<p class="muted">${esc(t('agents.empty'))}</p>`);
    root.innerHTML = `${revealBlock}${list}
      <div class="row" style="margin-top:14px" id="agent-add-row">
        <input id="agent-add-name" placeholder="${esc(t('agents.namePlaceholder'))}" style="flex:1;min-width:180px">
        <select id="agent-add-kind">
          <option value="local">${esc(t('agents.kindLocal'))}</option>
          <option value="remote">${esc(t('agents.kindRemote'))}</option>
        </select>
        <button class="primary" id="agent-add-go">${esc(t('agents.add'))}</button>
      </div>`;
  }

  async function boot() {
    const panel = document.getElementById('agents-panel');
    const root = document.getElementById('agents-root');
    if (!panel || !root) return;
    await window.brainlinkLocaleBooted;
    let state = { agents: [], reveal: null, loading: true, error: null, hasVault: false };
    const draw = () => render(root, state);
    draw();

    async function load() {
      try {
        const st = await apiState();
        panel.hidden = false;
        state = { ...state, agents: st.ai_agents || [], loading: false, error: null, hasVault: (st.vaults || []).length > 0 };
      } catch (e) { state = { ...state, loading: false, error: e.message }; }
      draw();
    }

    root.addEventListener('click', async (e) => {
      const d = e.target.dataset;
      try {
        if (d.agentRetry !== undefined) { state.loading = true; draw(); await load(); return; }
        if (e.target.id === 'agent-add-go') {
          const name = document.getElementById('agent-add-name').value.trim();
          const kind = document.getElementById('agent-add-kind').value;
          if (!name) { toast(t('agents.toastNeedName'), true); return; }
          const r = await api('/api/agents/add', { name, kind });
          freshKeys.set(r.agent.id, r.token);
          state.reveal = { agent: r.agent, token: r.token, snippet: r.snippet };
          await load();
          return;
        }
        if (d.revealDone !== undefined) { state.reveal = null; draw(); return; }
        if (d.copy !== undefined) {
          try { await navigator.clipboard.writeText(d.copy); toast(t('agents.toastKeyCopied')); } catch { toast(t('agents.toastCopyFailed'), true); }
          return;
        }
        if (d.agentRename !== undefined) {
          const a = state.agents.find((x) => x.id === d.agentRename);
          const name = window.prompt?.(t('agents.promptRename'), a?.name);
          if (name && name.trim()) { await api('/api/agents/rename', { id: d.agentRename, name: name.trim() }); toast(t('agents.toastRenamed')); await load(); }
          return;
        }
        if (d.agentRemove !== undefined) {
          if (!window.confirm?.(t('agents.confirmRemove'))) return;
          await api('/api/agents/remove', { id: d.agentRemove });
          freshKeys.delete(d.agentRemove);
          toast(t('agents.toastRemoved'));
          await load();
          return;
        }
        if (d.agentRevoke !== undefined) {
          if (!window.confirm?.(t('agents.confirmRevoke'))) return;
          await api('/api/agents/revoke', { id: d.agentRevoke });
          freshKeys.delete(d.agentRevoke);
          toast(t('agents.toastRevoked'));
          await load();
          return;
        }
        if (d.agentTest !== undefined) {
          const id = d.agentTest;
          const out = root.querySelector(`[data-agent-test-out="${id}"]`);
          const fresh = freshKeys.get(id);
          if (!fresh) {
            const row = root.querySelector(`[data-agent-test-row="${id}"]`);
            if (row) { row.hidden = false; return; }
          }
          const token = fresh || root.querySelector(`[data-agent-test-input="${id}"]`)?.value;
          if (!token) { toast(t('agents.toastNeedKey'), true); return; }
          if (out) out.innerHTML = `<p class="skeleton">${esc(t('agents.checking'))}</p>`;
          const r = await api('/api/agents/test', { token });
          if (out) out.innerHTML = `<p class="${r.ok ? 'muted' : 'error-box'}">${esc(localizeServerMessage(r.message))}</p>`;
          if (r.ok) { state.reveal = null; await load(); }
          return;
        }
        if (d.agentTestGo !== undefined) {
          const id = d.agentTestGo;
          const token = root.querySelector(`[data-agent-test-input="${id}"]`)?.value;
          if (!token) { toast(t('agents.toastNeedKey'), true); return; }
          const out = root.querySelector(`[data-agent-test-out="${id}"]`);
          if (out) out.innerHTML = `<p class="skeleton">${esc(t('agents.checking'))}</p>`;
          const r = await api('/api/agents/test', { token });
          if (out) out.innerHTML = `<p class="${r.ok ? 'muted' : 'error-box'}">${esc(localizeServerMessage(r.message))}</p>`;
          if (r.ok) await load();
          return;
        }
      } catch (err) { toast(localizeServerMessage(err.message), true); }
    });

    // index.html's load() fires this after every /api/state refresh, so a vault picked/created
    // there (hasVault was false) is reflected here right away instead of needing a manual reload.
    window.addEventListener('brainlink:state-updated', () => { load(); });

    await load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
