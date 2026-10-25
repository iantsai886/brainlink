// 3D notes graph (RB7 item 2): replaces the old 2D canvas map. Self-contained — own fetch,
// rendering and a small safe Markdown renderer — so it never conflicts with the parallel branch
// reshaping index.html into tabs. Hook into the page: one mount point (#notes3d-root inside the
// existing #brain-panel) plus the vendored library and this file's <script> tags.
(function () {
  const T = new URLSearchParams(location.search).get('t') || '';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': T }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  function toast(msg, bad) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(t._notes3dToastTimer); t._notes3dToastTimer = setTimeout(() => (t.className = ''), bad ? 6000 : 3500);
  }

  // ---- A small, safe Markdown renderer. Everything that isn't a tag we insert ourselves is run
  // through esc() first, so raw HTML in a note can never execute; links are limited to http(s)
  // and obsidian:// schemes. ----
  function renderInline(text) {
    const codes = [];
    let t = String(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\\u0000C${codes.length - 1}\\u0000`; });
    t = esc(t);
    t = t.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
      const target_ = target.trim(), label = (alias || target).trim();
      return `<a href="#" class="wikilink" data-wikilink="${esc(target_)}">${esc(label)}</a>`;
    });
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => (/^(https?:|obsidian:)/i.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label)));
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    t = t.replace(/(^|[^\w])_([^_]+)_(?!\w)/g, '$1<em>$2</em>');
    t = t.replace(/\\u0000C(\d+)\\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
    return t;
  }

  function renderMarkdown(md) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let list = null;
    const flush = () => { if (list) { out.push(`<${list.type}>${list.items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</${list.type}>`); list = null; } };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        flush();
        const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flush(); out.push(`<h${Math.min(6, h[1].length + 2)}>${renderInline(h[2])}</h${Math.min(6, h[1].length + 2)}>`); i++; continue; }
      const bq = line.match(/^>\s?(.*)$/);
      if (bq) { flush(); out.push(`<blockquote>${renderInline(bq[1])}</blockquote>`); i++; continue; }
      const ul = line.match(/^[-*]\s+(.*)$/);
      if (ul) { if (!list || list.type !== 'ul') { flush(); list = { type: 'ul', items: [] }; } list.items.push(ul[1]); i++; continue; }
      const ol = line.match(/^\d+\.\s+(.*)$/);
      if (ol) { if (!list || list.type !== 'ol') { flush(); list = { type: 'ol', items: [] }; } list.items.push(ol[1]); i++; continue; }
      if (!line.trim()) { flush(); i++; continue; }
      flush();
      const buf = [line]; i++;
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|[-*]\s|\d+\.\s|```)/.test(lines[i])) { buf.push(lines[i]); i++; }
      out.push(`<p>${renderInline(buf.join(' '))}</p>`);
    }
    flush();
    return out.join('\n');
  }

  // ---- Graph + panel ----

  function buildLayout(root) {
    root.innerHTML = `
      <div class="notes3d-wrap">
        <div class="notes3d-canvas" id="notes3d-canvas"></div>
        <aside class="notes3d-panel" id="notes3d-panel-detail" hidden>
          <div class="notes3d-actions"><a class="chip" id="notes3d-edit" target="_blank" rel="noopener" hidden></a><button class="chip" id="notes3d-edit-toggle" hidden>Edit</button><button class="link notes3d-close" id="notes3d-close" data-i18n="notes3d.close">Close ✕</button></div>
          <b id="notes3d-title"></b>
          <div class="notes3d-tags" id="notes3d-tags"></div>
          <div class="notes3d-body" id="notes3d-body"></div>
          <textarea id="notes3d-editor" class="notes3d-editor" hidden aria-label="Edit note"></textarea>
          <div class="notes3d-actions" id="notes3d-editor-actions" hidden><button class="chip" id="notes3d-save">Save</button><button class="chip" id="notes3d-cancel">Cancel</button><span class="muted" id="notes3d-save-status"></span></div>
          <div class="notes3d-links" id="notes3d-links"></div>
        </aside>
      </div>`;
    root.insertAdjacentHTML('beforeend', `
      <details class="notes3d-browse">
        <summary data-i18n="notes3d.browseNotes"></summary>
        <label for="notes3d-search" data-i18n="notes3d.browseSearch"></label>
        <input id="notes3d-search" type="search" data-i18n-placeholder="notes3d.browsePlaceholder" autocomplete="off">
        <p id="notes3d-browse-status" class="muted" role="status" aria-live="polite"></p>
        <div id="notes3d-node-list" class="notes3d-node-list" role="list"></div>
      </details>`);
  }

  function focusNode(graph, node) {
    if (!node || typeof node.x !== 'number') return;
    const distance = 90;
    const ratio = 1 + distance / Math.hypot(node.x, node.y, node.z || 0.001);
    graph.cameraPosition({ x: node.x * ratio, y: node.y * ratio, z: (node.z || 0) * ratio }, node, 900);
  }

  async function boot() {
    const brainPanel = document.getElementById('brain-panel');
    const root = document.getElementById('notes3d-root');
    if (!brainPanel || !root) return;
    let graphInstance = null, nodesById = [], byTitle = new Map(), loaded = false, loadedOk = false, selectedId = null, currentDetail = null, currentNode = null;

    function stat(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

    function openPanel(node) {
      const panel = document.getElementById('notes3d-panel-detail');
      if (!panel) return;
      panel.hidden = false;
      document.getElementById('notes3d-title').textContent = node.title;
      document.getElementById('notes3d-tags').innerHTML = (node.tags || []).map((t) => `<span class="pill">#${esc(t)}</span>`).join('');
      document.getElementById('notes3d-body').innerHTML = '<p class="skeleton">Loading…</p>';
      document.getElementById('notes3d-links').innerHTML = '';
      const edit = document.getElementById('notes3d-edit');
      edit.hidden = true;
      currentDetail = null; currentNode = node;
      document.getElementById('notes3d-edit-toggle').hidden = true;
      document.getElementById('notes3d-editor').hidden = true;
      document.getElementById('notes3d-editor-actions').hidden = true;
      document.getElementById('notes3d-body').hidden = false;
      api('/api/graph3d/note', { vault: node.vault, path: node.path }).then((detail) => {
        if (selectedId !== node.id) return; // ignore a slower response after the user selected another node
        const params = new URLSearchParams({ vault: detail.vault, file: detail.path });
        edit.href = `obsidian://open?${params.toString()}`;
        edit.textContent = window.t?.('notes3d.editInObsidian') || 'Edit in Obsidian';
        edit.hidden = false;
        currentDetail = detail;
        const editToggle = document.getElementById('notes3d-edit-toggle');
        editToggle.hidden = !detail.writable;
        document.getElementById('notes3d-body').innerHTML = renderMarkdown(detail.body) || '<p class="muted">(This note is empty.)</p>';
        const chip = (n, label) => `<button class="chip" data-focus-title="${esc(n.title)}" title="${esc(n.path)}">${esc(n.title)}<small>${esc(label)}</small></button>`;
        const parts = [];
        if (detail.backlinks.length) parts.push(`<div class="muted" style="font-size:12px;margin-top:10px">Linked from</div><div class="row">${detail.backlinks.map((n) => chip(n, 'backlink')).join('')}</div>`);
        if (detail.outlinks.length) parts.push(`<div class="muted" style="font-size:12px;margin-top:10px">Links to</div><div class="row">${detail.outlinks.map((n) => chip(n, 'link')).join('')}</div>`);
        if (detail.relationships?.length) parts.push(`<div class="muted" style="font-size:12px;margin-top:10px">Typed relationships</div>${detail.relationships.map((r) => `<div style="margin:5px 0"><div><b>${esc(r.predicate)}</b> · ${esc(r.direction)}</div><div class="row">${chip(r.note, 'related record')}</div><small class="muted">${esc(r.evidence)} · confidence ${esc(r.confidence)}</small></div>`).join('')}`);
        document.getElementById('notes3d-links').innerHTML = parts.join('');
      }).catch((e) => { if (selectedId === node.id) document.getElementById('notes3d-body').innerHTML = `<p class="error-box">Could not open this note: ${esc(e.message)}</p>`; });
    }
    function openById(id) {
      const node = nodesById[id];
      if (!node) return;
      selectedId = node.id;
      graphInstance?.refresh(); // re-applies nodeColor/nodeVal so the selected node is visibly highlighted
      renderNodeList();
      focusNode(graphInstance, node);
      openPanel(node);
    }
    function openByTitle(title) {
      const node = byTitle.get(String(title).toLowerCase());
      if (!node) { toast(`Can't find a note called "${title}".`, true); return; }
      openById(node.id);
    }

    function tr(key, vars = {}) {
      const template = window.brainlinkT?.(key) || key;
      return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
    }

    function renderNodeList() {
      const list = document.getElementById('notes3d-node-list');
      const status = document.getElementById('notes3d-browse-status');
      const input = document.getElementById('notes3d-search');
      if (!list || !status || !input) return;
      const query = input.value.trim().toLocaleLowerCase();
      const matches = nodesById.filter((node) => !query || `${node.title} ${node.type || ''} ${node.group || ''}`.toLocaleLowerCase().includes(query))
        .sort((a, b) => a.title.localeCompare(b.title));
      const visible = matches.slice(0, 50);
      list.innerHTML = visible.map((node) => `<div role="listitem"><button type="button" class="notes3d-node" data-graph-note-id="${esc(node.id)}" aria-pressed="${node.id === selectedId ? 'true' : 'false'}"><span>${esc(node.title)}</span><small>${esc(node.type || node.group || '')}</small></button></div>`).join('');
      status.textContent = matches.length > 50 ? tr('notes3d.browseMore', { count: matches.length, limit: 50 }) : tr('notes3d.browseCount', { count: matches.length });
      if (query && !matches.length) status.textContent = tr('notes3d.browseEmpty');
    }

    root.addEventListener('input', (e) => { if (e.target.id === 'notes3d-search') renderNodeList(); });
    window.addEventListener('brainlink:locale-changed', () => {
      root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = tr(el.dataset.i18n); });
      root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = tr(el.dataset.i18nPlaceholder); });
      renderNodeList();
    });

    root.addEventListener('click', (e) => {
      const graphNote = e.target.closest('[data-graph-note-id]');
      if (graphNote) { openById(graphNote.dataset.graphNoteId); return; }
      if (e.target.id === 'notes3d-edit-toggle') {
        const editor = document.getElementById('notes3d-editor');
        editor.value = currentDetail?.body || '';
        document.getElementById('notes3d-body').hidden = true;
        editor.hidden = false;
        document.getElementById('notes3d-editor-actions').hidden = false;
        document.getElementById('notes3d-save-status').textContent = '';
        return;
      }
      if (e.target.id === 'notes3d-cancel') {
        document.getElementById('notes3d-editor').hidden = true;
        document.getElementById('notes3d-editor-actions').hidden = true;
        document.getElementById('notes3d-body').hidden = false;
        return;
      }
      if (e.target.id === 'notes3d-save') {
        const button = e.target;
        button.disabled = true;
        document.getElementById('notes3d-save-status').textContent = 'Saving…';
        api('/api/graph3d/note/save', { vault: currentDetail.vault, path: currentDetail.path, etag: currentDetail.etag, body: document.getElementById('notes3d-editor').value }).then((saved) => {
          currentDetail.body = document.getElementById('notes3d-editor').value;
          currentDetail.etag = saved.etag;
          document.getElementById('notes3d-body').innerHTML = renderMarkdown(currentDetail.body) || '<p class="muted">(This note is empty.)</p>';
          document.getElementById('notes3d-editor').hidden = true;
          document.getElementById('notes3d-editor-actions').hidden = true;
          document.getElementById('notes3d-body').hidden = false;
          toast('Note saved.');
          return loadGraph();
        }).catch((err) => { document.getElementById('notes3d-save-status').textContent = err.message; }).finally(() => { button.disabled = false; });
        return;
      }
      if (e.target.id === 'notes3d-close') {
        document.getElementById('notes3d-panel-detail').hidden = true;
        selectedId = null;
        graphInstance?.refresh();
        return;
      }
      const wiki = e.target.closest('[data-wikilink]');
      if (wiki) { e.preventDefault(); openByTitle(wiki.dataset.wikilink); return; }
      const chip = e.target.closest('[data-focus-title]');
      if (chip) { openByTitle(chip.dataset.focusTitle); return; }
    });

    async function loadGraph() {
      const canvas = document.getElementById('notes3d-canvas');
      canvas.innerHTML = '<p class="skeleton">Loading your 3D brain map…</p>';
      let g;
      try { g = await api('/api/graph3d', {}); }
      catch (e) { canvas.innerHTML = `<p class="error-box">Could not load the map: ${esc(e.message)}</p>`; return; }
      try { const h = await api('/api/graph', {}); stat('st-notes', h.health?.notes ?? 0); stat('st-links', h.health?.links ?? 0); stat('st-orphans', h.health?.not_linked ?? 0); } catch {}
      if (!g.nodes.length) { canvas.innerHTML = '<p class="muted">No notes yet — once you add some, their links show up here.</p>'; loadedOk = false; return; }
      if (typeof ForceGraph3D !== 'function') { canvas.innerHTML = '<p class="error-box">Could not load the 3D map (missing viewer). Try reloading.</p>'; return; }
      canvas.innerHTML = '';
      nodesById = g.nodes;
      byTitle = new Map(g.nodes.map((n) => [n.title.toLowerCase(), n]));
      renderNodeList();
      const css = getComputedStyle(document.documentElement);
      const colorVars = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
      const counts = new Map();
      for (const n of g.nodes) counts.set(n.group, (counts.get(n.group) || 0) + 1);
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
      const colorOf = (grp) => { const r = ranked.indexOf(grp); return r >= 0 && r < 8 ? css.getPropertyValue(`--${colorVars[r]}`).trim() : css.getPropertyValue('--muted').trim(); };
      const selectedColor = css.getPropertyValue('--accent').trim() || css.getPropertyValue('--ink').trim() || '#fff';
      // nodeLabel is rendered as the hover tooltip's innerHTML (3d-force-graph's documented
      // behavior), so a note title must be escaped the same way any other note-derived text going
      // into innerHTML is (see renderInline/renderMarkdown above) — otherwise a crafted title could
      // inject HTML into the tooltip.
      graphInstance = ForceGraph3D()(canvas)
        .graphData({ nodes: g.nodes, links: g.links })
        .backgroundColor(css.getPropertyValue('--bg').trim() || '#000')
        .nodeLabel((n) => `${esc(n.title)}${n.type ? `<br><small>${esc(n.type)}</small>` : ''}`)
        .nodeColor((n) => (n.id === selectedId ? selectedColor : colorOf(n.group)))
        .nodeVal((n) => (n.id === selectedId ? 1.6 : 1) + Math.sqrt(n.degree || 0))
        .linkColor((l) => l.kind === 'typed' ? selectedColor : css.getPropertyValue('--muted').trim())
        .linkLabel((l) => l.predicate ? esc(l.predicate) : '')
        .linkOpacity(0.35)
        .onNodeClick((n) => openById(n.id));
      loadedOk = true;
      resizeToContainer();
    }

    // canvas.clientWidth/clientHeight can read 0 (or a stale pre-layout value) the instant
    // #brain-panel stops being hidden, so this is called once right after the graph is created,
    // again one frame later (requestAnimationFrame, after layout has definitely settled), and on
    // every subsequent ResizeObserver tick — never just once at construction time.
    function resizeToContainer() {
      const c = document.getElementById('notes3d-canvas');
      if (!graphInstance || !c) return;
      graphInstance.width(c.clientWidth || 600).height(c.clientHeight || 450);
    }

    buildLayout(root);
    const ro = new ResizeObserver(resizeToContainer);
    ro.observe(root);

    function maybeLoad() { if (!brainPanel.hidden && !loaded) { loaded = true; loadGraph().then(() => requestAnimationFrame(resizeToContainer)); } }
    maybeLoad();
    new MutationObserver(maybeLoad).observe(brainPanel, { attributes: true, attributeFilter: ['hidden'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
