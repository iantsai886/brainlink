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
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(t._agentsToastTimer); t._agentsToastTimer = setTimeout(() => (t.className = ''), bad ? 6000 : 3500);
  }

  // Keeps a just-created key in memory only for this page load, so "Test connection" works right
  // after Add without asking the user to paste it back in. Never sent anywhere but /api/agents/test.
  const freshKeys = new Map(); // id -> key

  function statusPill(a) {
    if (a.revoked) return '<span class="pill">Key turned off</span>';
    return a.connected ? '<span class="pill on">Connected</span>' : '<span class="pill">Not connected yet</span>';
  }
  function kindLabel(a) { return a.kind === 'remote' ? 'In the cloud (not reachable yet)' : 'On this Mac'; }

  function agentCard(a) {
    const hasFreshKey = freshKeys.has(a.id);
    return `<div class="card agent-card" data-agent="${esc(a.id)}">
      <div class="row" style="justify-content:space-between">
        <b>${esc(a.name)}</b>
        ${statusPill(a)}
      </div>
      <div class="muted" style="font-size:13px">${esc(kindLabel(a))}${a.lastSeenAt ? ' · last used ' + esc(new Date(a.lastSeenAt).toLocaleString()) : ''}</div>
      <div class="row" style="margin-top:6px">
        <button class="link" data-agent-rename="${esc(a.id)}">Rename</button>
        ${a.revoked ? '' : `<button class="link" data-agent-test="${esc(a.id)}">Test connection</button><button class="link" data-agent-revoke="${esc(a.id)}">Turn off key</button>`}
        <button class="link" data-agent-remove="${esc(a.id)}">Remove</button>
      </div>
      ${hasFreshKey ? '' : !a.revoked ? `<div class="row agent-test-row" data-agent-test-row="${esc(a.id)}" hidden style="margin-top:6px">
        <input type="password" placeholder="Paste this agent's key" data-agent-test-input="${esc(a.id)}" style="flex:1;min-width:200px">
        <button data-agent-test-go="${esc(a.id)}">Check</button>
      </div>` : ''}
      <div class="agent-test-out" data-agent-test-out="${esc(a.id)}"></div>
    </div>`;
  }

  function revealHtml(a, token, snippet) {
    const setupText = a.kind === 'remote'
      ? `Address: ${snippet.url}\nKey: Bearer ${token}`
      : JSON.stringify(snippet, null, 2);
    return `<div class="card agent-reveal">
      <b>${esc(a.name)} is ready</b>
      <p class="hint" style="margin:4px 0 8px">Copy this key now — BrainLink will not show it again. Keep it somewhere safe.</p>
      <div class="row"><code class="mono agent-key" style="flex:1">${esc(token)}</code><button data-copy="${esc(token)}">Copy key</button></div>
      <details style="margin-top:10px"><summary>Connection details to paste into ${esc(a.name)}</summary>
        <pre class="mono agent-snippet">${esc(setupText)}</pre>
      </details>
      ${a.kind === 'remote' ? '<p class="notice" style="margin-top:10px">BrainLink runs only on this Mac. Agents in the cloud can\'t reach it yet.</p>' : ''}
      <div class="row" style="margin-top:10px"><button class="primary" data-agent-test="${esc(a.id)}">Test connection now</button><button class="link" data-reveal-done="${esc(a.id)}">Done</button></div>
    </div>`;
  }

  function render(root, state) {
    const { agents, reveal, loading, error, hasVault } = state;
    if (loading) { root.innerHTML = '<p class="skeleton">Loading agents…</p>'; return; }
    if (error) { root.innerHTML = `<p class="error-box">Could not load agents: ${esc(error)} <button data-agent-retry>Retry</button></p>`; return; }
    if (!hasVault) { root.innerHTML = '<p class="muted">Add a vault first (above), then come back to add agents.</p>'; return; }
    const revealBlock = reveal ? revealHtml(reveal.agent, reveal.token, reveal.snippet) : '';
    const list = agents.length
      ? `<div class="cards">${agents.filter((a) => !reveal || a.id !== reveal.agent.id).map(agentCard).join('')}</div>`
      : (reveal ? '' : '<p class="muted">No agents yet. Add one so any AI can connect with its own key.</p>');
    root.innerHTML = `${revealBlock}${list}
      <div class="row" style="margin-top:14px" id="agent-add-row">
        <input id="agent-add-name" placeholder="Agent name, e.g. Grok Bot" style="flex:1;min-width:180px">
        <select id="agent-add-kind">
          <option value="local">On this Mac</option>
          <option value="remote">In the cloud (not reachable yet)</option>
        </select>
        <button class="primary" id="agent-add-go">Add agent</button>
      </div>`;
  }

  async function boot() {
    const panel = document.getElementById('agents-panel');
    const root = document.getElementById('agents-root');
    if (!panel || !root) return;
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
          if (!name) { toast('Give the agent a name first.', true); return; }
          const r = await api('/api/agents/add', { name, kind });
          freshKeys.set(r.agent.id, r.token);
          state.reveal = { agent: r.agent, token: r.token, snippet: r.snippet };
          await load();
          return;
        }
        if (d.revealDone !== undefined) { state.reveal = null; draw(); return; }
        if (d.copy !== undefined) {
          try { await navigator.clipboard.writeText(d.copy); toast('Key copied.'); } catch { toast('Could not copy automatically; select and copy the key text.', true); }
          return;
        }
        if (d.agentRename !== undefined) {
          const a = state.agents.find((x) => x.id === d.agentRename);
          const name = window.prompt?.('Rename agent', a?.name);
          if (name && name.trim()) { await api('/api/agents/rename', { id: d.agentRename, name: name.trim() }); toast('Renamed.'); await load(); }
          return;
        }
        if (d.agentRemove !== undefined) {
          if (!window.confirm?.('Remove this agent? Its key stops working right away.')) return;
          await api('/api/agents/remove', { id: d.agentRemove });
          freshKeys.delete(d.agentRemove);
          toast('Agent removed.');
          await load();
          return;
        }
        if (d.agentRevoke !== undefined) {
          if (!window.confirm?.('Turn off this agent\'s key? It stops working right away; you can still rename or remove the agent.')) return;
          await api('/api/agents/revoke', { id: d.agentRevoke });
          freshKeys.delete(d.agentRevoke);
          toast('Key turned off.');
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
          if (!token) { toast('Paste the key first.', true); return; }
          if (out) out.innerHTML = '<p class="skeleton">Checking…</p>';
          const r = await api('/api/agents/test', { token });
          if (out) out.innerHTML = `<p class="${r.ok ? 'muted' : 'error-box'}">${esc(r.message)}</p>`;
          if (r.ok) { state.reveal = null; await load(); }
          return;
        }
        if (d.agentTestGo !== undefined) {
          const id = d.agentTestGo;
          const token = root.querySelector(`[data-agent-test-input="${id}"]`)?.value;
          if (!token) { toast('Paste the key first.', true); return; }
          const out = root.querySelector(`[data-agent-test-out="${id}"]`);
          if (out) out.innerHTML = '<p class="skeleton">Checking…</p>';
          const r = await api('/api/agents/test', { token });
          if (out) out.innerHTML = `<p class="${r.ok ? 'muted' : 'error-box'}">${esc(r.message)}</p>`;
          if (r.ok) await load();
          return;
        }
      } catch (err) { toast(err.message, true); }
    });

    await load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
