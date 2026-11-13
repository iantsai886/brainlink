// 3D notes graph (RB7 item 2): replaces the old 2D canvas map. Self-contained — own fetch,
// rendering and a small safe Markdown renderer — so it never conflicts with the parallel branch
// reshaping index.html into tabs. Hook into the page: one mount point (#notes3d-root inside the
// existing #brain-panel) plus the vendored library and this file's <script> tags.
(function () {
  const T = new URLSearchParams(location.search).get('t') || '';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, body) {
    const isGraphRead = path === '/api/graph3d' || path === '/api/graph3d/vaults';
    const controller = isGraphRead ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 90000) : null;
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': T }, body: JSON.stringify(body || {}), ...(controller ? { signal: controller.signal } : {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      return j;
    } catch (error) {
      if (controller?.signal.aborted) throw new Error('The map request timed out.');
      throw error;
    } finally { if (timer) clearTimeout(timer); }
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
        <div class="notes3d-vault-picker"><label for="notes3d-vault-select" data-i18n="notes3d.vaultFilter"></label><select id="notes3d-vault-select" aria-label="Choose a vault"></select></div>
        <div class="notes3d-legend" id="notes3d-legend" aria-label="Graph color legend"></div>
        <div class="notes3d-controls"><button type="button" class="chip" id="notes3d-reset-view" data-i18n="notes3d.resetView" disabled>Reset view</button></div>
        <div class="notes3d-canvas" id="notes3d-canvas"></div>
      </div>
      <dialog class="notes3d-dialog" id="notes3d-panel-detail" aria-labelledby="notes3d-title">
          <div class="notes3d-actions"><a class="chip" id="notes3d-edit" target="_blank" rel="noopener" hidden></a><button class="chip" id="notes3d-edit-toggle" hidden>Edit</button><button type="button" class="chip notes3d-close" id="notes3d-close" data-i18n="notes3d.close" aria-label="Close note">✕</button></div>
          <b id="notes3d-title"></b>
          <div class="notes3d-tags" id="notes3d-tags"></div>
          <div class="notes3d-body" id="notes3d-body"></div>
          <textarea id="notes3d-editor" class="notes3d-editor" hidden aria-label="Edit note"></textarea>
          <div class="notes3d-actions" id="notes3d-editor-actions" hidden><button class="chip" id="notes3d-save">Save</button><button class="chip" id="notes3d-cancel">Cancel</button><span class="muted" id="notes3d-save-status"></span></div>
          <div class="notes3d-links" id="notes3d-links"></div>
      </dialog>`;
    root.insertAdjacentHTML('beforeend', `
      <details class="notes3d-browse">
        <summary data-i18n="notes3d.browseNotes"></summary>
        <label for="notes3d-search" data-i18n="notes3d.browseSearch"></label>
        <input id="notes3d-search" type="search" data-i18n-placeholder="notes3d.browsePlaceholder" autocomplete="off">
        <p id="notes3d-browse-status" class="muted" role="status" aria-live="polite"></p>
        <div id="notes3d-node-list" class="notes3d-node-list" role="list"></div>
      </details>
      <details class="notes3d-browse" id="notes3d-review-queue">
        <summary data-i18n="notes3d.reviewQueue"></summary>
        <p id="notes3d-review-status" class="muted" role="status" aria-live="polite"></p>
        <div id="notes3d-review-list"></div>
      </details>`);
    root.insertAdjacentHTML('beforeend', `<details class="notes3d-browse" id="notes3d-discovery">
      <summary data-i18n="notes3d.discoverVault"></summary>
      <p class="muted" data-i18n="notes3d.discoverHint"></p>
      <button type="button" class="chip" id="notes3d-discover-run" data-i18n="notes3d.discoverRun"></button>
      <p id="notes3d-discover-status" class="muted" role="status" aria-live="polite"></p>
      <div id="notes3d-discover-list"></div>
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
    let graphInstance = null, nodesById = [], byTitle = new Map(), loaded = false, loadedOk = false, selectedId = null, currentDetail = null, currentDetailComplete = false, currentNode = null, pendingVaultRefresh = false, vaultFilter = null, graphVaultOptions = [], graphDataAll = { nodes: [], links: [] }, legendGroups = [], activeGroup = null;
    const relationTargets = { owned_by: ['team','person'], runs: ['workflow'], consumes: ['dataset','artifact'], produces: ['dataset','artifact'], depends_on: ['workflow','dataset','project'], part_of: ['team','project'], assigned_to: ['person','team'], informed_by: ['artifact','dataset','concept'], communicates_with: ['person','team'] };

    function stat(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

    function graphPayloadForActiveGroup() {
      const nodes = graphDataAll.nodes.filter((node) => activeGroup === null || node.group === activeGroup);
      const ids = new Set(nodes.map((node) => node.id));
      const endpointId = (endpoint) => typeof endpoint === 'object' ? endpoint.id : endpoint;
      const links = graphDataAll.links.filter((link) => ids.has(endpointId(link.source)) && ids.has(endpointId(link.target)))
        .map((link) => ({ ...link, source: endpointId(link.source), target: endpointId(link.target) }));
      return { nodes, links };
    }

    function applyGraphFilter() {
      if (!graphInstance) return;
      graphInstance.graphData(graphPayloadForActiveGroup());
      requestAnimationFrame(() => graphInstance?.zoomToFit(650, 55));
    }

    function toggleGraphGroup(group) {
      if (!legendGroups.includes(group)) return;
      activeGroup = activeGroup === group ? null : group;
      document.getElementById('notes3d-legend')?.querySelectorAll('[data-graph-group-index]').forEach((button) => {
        button.setAttribute('aria-pressed', String(legendGroups[Number(button.dataset.graphGroupIndex)] === activeGroup));
      });
      applyGraphFilter();
    }

    function renderGraphLegend(ranked, colorOf) {
      legendGroups = ranked.slice(0, 8);
      const legend = document.getElementById('notes3d-legend');
      if (!legend) return;
      legend.innerHTML = legendGroups.map((group, index) => {
        const label = group || (window.brainlinkT?.('notes3d.ungrouped') || 'No folder');
        return `<button type="button" class="notes3d-legend-item" data-graph-group-index="${index}" aria-pressed="${activeGroup === group ? 'true' : 'false'}" aria-label="Filter graph by ${esc(label)}" title="Filter graph by ${esc(label)}"><i style="--legend-color:${esc(colorOf(group))}"></i><span>${esc(label)}</span></button>`;
      }).join('') + (ranked.length > 8 ? `<span class="notes3d-legend-more">+${ranked.length - 8}</span>` : '');
      legend.querySelectorAll('[data-graph-group-index]').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          toggleGraphGroup(legendGroups[Number(button.dataset.graphGroupIndex)]);
        });
      });
    }

    function renderVaultOptions() {
      const select = document.getElementById('notes3d-vault-select');
      if (!select) return;
      select.innerHTML = `<option value="*">${esc(tr('notes3d.allVaults'))}</option>${graphVaultOptions.map((vault) => `<option value="${esc(vault.name)}">${esc(vault.name)}${vault.private ? ` · ${esc(tr('notes3d.privateLocal'))}` : ` · ${esc(vault.notes)}`}</option>`).join('')}`;
      select.value = vaultFilter === null ? '*' : vaultFilter;
    }

    function openPanel(node) {
      const panel = document.getElementById('notes3d-panel-detail');
      if (!panel) return;
      if (!panel.open) panel.showModal();
      document.getElementById('notes3d-title').textContent = node.title;
      document.getElementById('notes3d-tags').innerHTML = (node.tags || []).map((t) => `<span class="pill">#${esc(t)}</span>`).join('');
      document.getElementById('notes3d-body').innerHTML = '<p class="skeleton">Loading…</p>';
      document.getElementById('notes3d-links').innerHTML = '';
      const edit = document.getElementById('notes3d-edit');
      edit.hidden = true;
      currentDetail = null; currentDetailComplete = false; currentNode = node;
      document.getElementById('notes3d-edit-toggle').hidden = true;
      document.getElementById('notes3d-editor').hidden = true;
      document.getElementById('notes3d-editor-actions').hidden = true;
      document.getElementById('notes3d-body').hidden = false;
      api('/api/graph3d/note/preview', { vault: node.vault, path: node.path }).then((preview) => {
        if (selectedId !== node.id || currentDetailComplete) return;
        currentDetail = preview;
        document.getElementById('notes3d-body').innerHTML = renderMarkdown(preview.body) || '<p class="muted">(This note is empty.)</p>';
        document.getElementById('notes3d-links').innerHTML = `<p class="skeleton">${esc(tr('notes3d.loadingConnections'))}</p>`;
      }).catch((error) => {
        if (selectedId === node.id && !currentDetailComplete) document.getElementById('notes3d-body').innerHTML = `<p class="error-box">Could not open this note: ${esc(error.message)}</p>`;
      });
      api('/api/graph3d/note', { vault: node.vault, path: node.path }).then((detail) => {
        if (selectedId !== node.id) return; // ignore a slower response after the user selected another node
        currentDetailComplete = true;
        const notePath = detail.path.replace(/\.md$/i, '');
        edit.href = `obsidian://open?vault=${encodeURIComponent(detail.vault)}&file=${encodeURIComponent(notePath)}`;
        edit.textContent = window.t?.('notes3d.editInObsidian') || 'Edit in Obsidian';
        // A syntactically valid URI is not enough: Obsidian must know this exact folder as a vault.
        // Demo/temp folders are intentionally not registered, so don't offer a link that errors.
        edit.hidden = !detail.obsidian_registered;
        currentDetail = detail;
        const editToggle = document.getElementById('notes3d-edit-toggle');
        editToggle.hidden = !detail.writable;
        document.getElementById('notes3d-body').innerHTML = renderMarkdown(detail.body) || '<p class="muted">(This note is empty.)</p>';
        const chip = (n, label) => `<button class="chip" data-focus-title="${esc(n.title)}" title="${esc(n.path)}">${esc(n.title)}<small>${esc(label)}</small></button>`;
        const parts = [];
        const graphRecord = detail.graph_record || {};
        const workflowKeys = ['triggers','inputs','steps','outputs','exception_handling'];
        const graphChoices = (field, label, values) => {
          const current = typeof graphRecord[field] === 'string' ? graphRecord[field] : '';
          const custom = current && !values.includes(current) ? `<option value="${esc(current)}" selected>${esc(tr('notes3d.existingValue', { value: current }))}</option>` : '';
          return `<label>${esc(label)}<select data-graph-record-field="${field}" ${detail.writable ? '' : 'disabled'}><option value="">${esc(tr('notes3d.notSet'))}</option>${custom}${values.map((value) => `<option value="${value}" ${current === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>`;
        };
        const relationEditor = (r) => {
          const targets = nodesById.filter((item) => item.vault === detail.vault && item.scope === detail.graph_record?.scope && item.entity_id && item.entity_id !== detail.graph_record?.id);
          const hasCurrent = targets.some((item) => item.entity_id === r.target_id);
          const currentTarget = hasCurrent || !r.target_id ? '' : `<option value="${esc(r.target_id)}" selected>${esc(r.note.title)} · ${esc(r.target_id)}</option>`;
          return detail.writable ? `<details class="card" style="margin-top:8px"><summary>${esc(tr('notes3d.editRelationship'))}</summary><label class="muted">${esc(tr('notes3d.relationshipType'))}<select data-edit-predicate>${['owned_by','runs','consumes','produces','depends_on','part_of','assigned_to','informed_by','communicates_with'].map((value) => `<option value="${value}" ${r.predicate === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="muted">${esc(tr('notes3d.targetEntity'))}<select data-edit-target>${currentTarget}${targets.map((item) => `<option value="${esc(item.entity_id)}" ${item.entity_id === r.target_id ? 'selected' : ''}>${esc(item.title)} · ${esc(item.type)}</option>`).join('')}</select></label><label class="muted">${esc(tr('notes3d.evidenceExcerpt'))}<textarea data-edit-evidence maxlength="300" rows="3">${esc(r.evidence)}</textarea></label><label class="muted">${esc(tr('notes3d.confidenceLabel'))}<input data-edit-confidence type="number" min="0" max="1" step="0.01" value="${esc(r.confidence)}"></label><button type="button" class="chip" data-save-relation="${esc(r.relation_index)}">${esc(tr('notes3d.saveRelationship'))}</button></details>` : '';
        };
        const workflowFields = graphRecord.type === 'workflow' ? `<div class="card" style="margin-top:8px"><p><b>${esc(tr('notes3d.workflowFieldsTitle'))}</b></p><p class="muted">${esc(tr('notes3d.workflowFieldsHint'))}</p>${workflowKeys.map((key) => `<label>${esc(tr(`notes3d.workflow.${key}`))}<textarea data-graph-workflow-field="${key}" rows="${key === 'steps' ? 5 : 3}" maxlength="20040" ${detail.writable ? '' : 'disabled'}>${esc((graphRecord[key] || []).join('\n'))}</textarea></label>`).join('')}</div>` : '';
        parts.push(`<details class="card" style="margin-top:10px"><summary>${esc(tr('notes3d.graphRecord'))}</summary><p class="muted">${esc(tr('notes3d.graphRecordHint'))}</p>${graphChoices('type', tr('notes3d.recordType'), ['person','team','workflow','dataset','artifact','project','policy','concept'])}<label>${esc(tr('notes3d.stableId'))}<input data-graph-record-field="id" value="${esc(graphRecord.id || '')}" placeholder="team.product" maxlength="128" ${detail.writable ? '' : 'disabled'}></label>${graphChoices('scope', tr('notes3d.recordScope'), ['personal','organisation','client'])}${graphChoices('status', tr('notes3d.recordStatus'), ['proposed','current','archived'])}${workflowFields}<small class="muted">${esc(tr('notes3d.graphRecordSaveHint'))}</small><div class="row" style="margin-top:8px"><button type="button" class="chip" data-save-graph-record ${detail.writable ? '' : 'disabled'}>${esc(tr('notes3d.saveGraphRecord'))}</button></div></details>`);
        if (detail.backlinks.length) parts.push(`<div class="muted" style="font-size:12px;margin-top:10px">Linked from</div><div class="row">${detail.backlinks.map((n) => chip(n, 'backlink')).join('')}</div>`);
        if (detail.outlinks.length) parts.push(`<div class="muted" style="font-size:12px;margin-top:10px">Links to</div><div class="row">${detail.outlinks.map((n) => chip(n, 'link')).join('')}</div>`);
        if (detail.relationships?.length) parts.push(`<div class="muted" style="font-size:12px;margin-top:10px">Typed relationships</div>${detail.relationships.map((r) => `<div style="margin:5px 0"><div><b>${esc(r.predicate)}</b> · ${esc(r.direction)}</div><div class="row">${chip(r.note, 'related record')}</div><small class="muted">${esc(r.evidence)} · confidence ${esc(r.confidence)}</small>${detail.writable && r.direction === 'outgoing' ? `<div class="row" style="margin-top:8px"><button type="button" class="chip" data-reopen-relation="${esc(r.relation_index)}">${esc(tr('notes3d.undoApproval'))}</button><button type="button" class="chip" data-archive-relation="${esc(r.relation_index)}">${esc(tr('notes3d.archiveRelationship'))}</button></div>${relationEditor(r)}` : ''}</div>`).join('')}`);
        if (detail.proposed_relationships?.length) parts.push(`<div class="muted" style="font-size:12px;margin-top:12px"><b>${esc(tr('notes3d.proposedRelationships'))}</b></div><p class="muted">${esc(tr('notes3d.proposedHint'))}</p>${detail.proposed_relationships.map((r) => `<div class="card" style="margin:6px 0"><div><b>${esc(r.predicate)}</b></div><div class="row">${chip(r.note, tr('notes3d.suggestedTarget'))}</div><small class="muted">${esc(r.evidence)} · ${esc(tr('notes3d.confidence', { confidence: r.confidence }))}</small>${detail.writable ? `<div class="row" style="margin-top:8px"><button type="button" class="chip" data-review-relation="${esc(r.relation_index)}">${esc(tr('notes3d.approveRelationship'))}</button><button type="button" class="chip" data-reject-relation="${esc(r.relation_index)}">${esc(tr('notes3d.rejectRelationship'))}</button><button type="button" class="chip" data-archive-relation="${esc(r.relation_index)}">${esc(tr('notes3d.archiveRelationship'))}</button></div>${relationEditor(r)}` : ''}</div>`).join('')}`);
        if (detail.rejected_relationships?.length) parts.push(`<div class="muted" style="font-size:12px;margin-top:12px"><b>${esc(tr('notes3d.rejectedRelationships'))}</b></div>${detail.rejected_relationships.map((r) => `<div class="card" style="margin:6px 0"><div><b>${esc(r.predicate)}</b></div><div class="row">${chip(r.note, tr('notes3d.suggestedTarget'))}</div><small class="muted">${esc(r.evidence)} · ${esc(tr('notes3d.confidence', { confidence: r.confidence }))}</small>${detail.writable ? `<div class="row" style="margin-top:8px"><button type="button" class="chip" data-reopen-rejected="${esc(r.relation_index)}">${esc(tr('notes3d.reopenRejected'))}</button><button type="button" class="chip" data-archive-relation="${esc(r.relation_index)}">${esc(tr('notes3d.archiveRelationship'))}</button></div>${relationEditor(r)}` : ''}</div>`).join('')}`);
        if (detail.withdrawn_relationships?.length) parts.push(`<div class="muted" style="font-size:12px;margin-top:12px"><b>${esc(tr('notes3d.withdrawnRelationships'))}</b></div><p class="muted">${esc(tr('notes3d.withdrawnHint'))}</p>${detail.withdrawn_relationships.map((r) => `<div class="card" style="margin:6px 0"><div><b>${esc(r.predicate)}</b></div><div class="row">${chip(r.note, tr('notes3d.suggestedTarget'))}</div><small class="muted">${esc(r.evidence)} · ${esc(tr('notes3d.confidence', { confidence: r.confidence }))}</small>${detail.writable ? `<div style="margin-top:8px"><button type="button" class="chip" data-restore-withdrawn="${esc(r.relation_index)}">${esc(tr('notes3d.restoreWithdrawn'))}</button></div>` : ''}</div>`).join('')}`);
        if (detail.discovered_relationships?.length) parts.push(`<div class="muted" style="font-size:12px;margin-top:12px"><b>${esc(tr('notes3d.discoveredRelationships'))}</b></div><p class="muted">${esc(tr('notes3d.discoveredHint'))}</p>${detail.discovered_relationships.map((r) => `<div class="card" style="margin:6px 0"><div><b>${esc(r.predicate)}</b></div><div class="row">${chip(r.note, tr('notes3d.suggestedTarget'))}</div><small class="muted">${esc(r.evidence)} · ${esc(tr('notes3d.patternOnly'))}</small>${detail.writable ? `<div style="margin-top:8px"><button type="button" class="chip" data-save-suggestion="${esc(r.target_id)}" data-predicate="${esc(r.predicate)}" data-evidence="${esc(r.evidence)}">${esc(tr('notes3d.saveSuggestion'))}</button></div>` : ''}</div>`).join('')}`);
        if (detail.writable && currentNode?.entity_id && currentNode?.scope) {
          const targets = nodesById.filter((item) => item.entity_id && item.scope === currentNode.scope && item.entity_id !== currentNode.entity_id && item.vault === detail.vault);
          if (targets.length) parts.push(`<details class="card" style="margin-top:12px"><summary>${esc(tr('notes3d.addRelationship'))}</summary><p class="muted">${esc(tr('notes3d.addRelationshipHint'))}</p><label class="muted">${esc(tr('notes3d.targetEntity'))}<select data-manual-target>${targets.map((item) => `<option value="${esc(item.entity_id)}" data-entity-type="${esc(item.type)}">${esc(item.title)} · ${esc(item.type)}</option>`).join('')}</select></label><label class="muted">${esc(tr('notes3d.relationshipType'))}<select data-manual-predicate>${['owned_by','runs','consumes','produces','depends_on','part_of','assigned_to','informed_by','communicates_with'].map((item) => `<option value="${item}">${item}</option>`).join('')}</select></label><label class="muted">${esc(tr('notes3d.evidenceExcerpt'))}<textarea data-manual-evidence maxlength="320" rows="3" placeholder="${esc(tr('notes3d.evidencePlaceholder'))}"></textarea></label><button type="button" class="chip" data-propose-manual>${esc(tr('notes3d.addRelationshipButton'))}</button></details>`);
        }
        document.getElementById('notes3d-links').innerHTML = parts.join('');
        document.getElementById('notes3d-links').querySelectorAll('details:has([data-manual-target])').forEach(updateManualTargetOptions);
      }).catch((e) => {
        if (selectedId !== node.id) return;
        if (currentDetail) document.getElementById('notes3d-links').innerHTML = `<p class="error-box">${esc(e.message)}</p>`;
        else document.getElementById('notes3d-body').innerHTML = `<p class="error-box">Could not open this note: ${esc(e.message)}</p>`;
      });
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
        .sort((a, b) => (b.modified || 0) - (a.modified || 0) || a.title.localeCompare(b.title));
      const visible = matches.slice(0, 50);
      const groupColor = (group) => {
        const counts = new Map();
        for (const node of nodesById) counts.set(node.group, (counts.get(node.group) || 0) + 1);
        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
        const rank = ranked.indexOf(group);
        const vars = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
        const css = getComputedStyle(document.documentElement);
        return rank >= 0 && rank < vars.length ? css.getPropertyValue(`--${vars[rank]}`).trim() : css.getPropertyValue('--muted').trim();
      };
      const folders = new Map();
      for (const node of visible) {
        const parts = String(node.path || '').split('/').filter(Boolean);
        const folder = parts.length > 1 ? `${parts[0]}/${parts[1]}` : (parts[0] || 'Root notes');
        if (!folders.has(folder)) folders.set(folder, []);
        folders.get(folder).push(node);
      }
      list.innerHTML = [...folders.entries()].map(([folder, nodes]) => `<section class="notes3d-folder-group" role="group" aria-label="${esc(folder)}"><h4><i style="--legend-color:${esc(groupColor(nodes[0].group))}"></i><span title="${esc(folder)}">${esc(folder)}</span><small>${nodes.length}</small></h4><div>${nodes.map((node) => `<div role="listitem"><button type="button" class="notes3d-node" data-graph-note-id="${esc(node.id)}" aria-pressed="${node.id === selectedId ? 'true' : 'false'}"><span>${esc(node.title)}</span><small>${esc(node.type || node.group || '')}${node.modified ? ` · ${new Date(node.modified).toLocaleDateString()}` : ''}</small></button></div>`).join('')}</div></section>`).join('');
      status.textContent = matches.length > 50 ? tr('notes3d.browseMore', { count: matches.length, limit: 50 }) : tr('notes3d.browseCount', { count: matches.length });
      if (query && !matches.length) status.textContent = tr('notes3d.browseEmpty');
    }

    async function loadReviewQueue({ append = false } = {}) {
      const list = document.getElementById('notes3d-review-list');
      const status = document.getElementById('notes3d-review-status');
      if (!list || !status) return;
      try {
        const offset = append ? (list._nextOffset || 0) : 0;
        const result = await api('/api/graph3d/reviews', { offset, vault: vaultFilter && vaultFilter !== '*' ? vaultFilter : undefined });
        const proposals = append ? [...(list._pendingReviews || []), ...result.proposals] : result.proposals;
        list._pendingReviews = proposals;
        list._nextOffset = result.offset + result.proposals.length;
        status.textContent = result.limited
          ? tr('notes3d.reviewLimited', { shown: proposals.length, total: result.total })
          : tr('notes3d.reviewCount', { count: result.total });
        list.innerHTML = proposals.map((item, i) => `<article class="card notes3d-review-item">
          <b>${esc(item.title)}</b><span class="mono muted">${esc(item.vault)} · ${esc(item.path)}</span>
          <div>${esc(item.predicate)} → ${esc(item.target.title)}</div>
          <small class="muted">${esc(item.evidence)} · ${esc(tr('notes3d.confidence', { confidence: item.confidence }))}</small>
          ${item.can_review ? `<div class="row"><button type="button" class="chip" data-approve-queued="${i}">${esc(tr('notes3d.approveRelationship'))}</button><button type="button" class="chip" data-reject-queued="${i}">${esc(tr('notes3d.rejectRelationship'))}</button></div>` : `<small class="muted">${esc(tr('notes3d.reviewReadOnly'))}</small>`}
        </article>`).join('') + (result.limited ? `<button type="button" class="chip" data-review-load-more>${esc(tr('notes3d.reviewLoadMore'))}</button>` : '');
      } catch (error) {
        status.textContent = tr('notes3d.reviewFailed', { error: error.message });
        if (!append) list.innerHTML = '';
      }
    }

    async function runDiscovery({ append = false } = {}) {
      const list = document.getElementById('notes3d-discover-list');
      const status = document.getElementById('notes3d-discover-status');
      const button = document.getElementById('notes3d-discover-run');
      if (!list || !status || !button) return;
      button.disabled = true;
      try {
        const offset = append ? (list._nextOffset || 0) : 0;
        const result = await api('/api/graph3d/discover', { offset, vault: vaultFilter && vaultFilter !== '*' ? vaultFilter : undefined, scan_id: append ? list._scanId : undefined });
        const items = append ? [...(list._candidates || []), ...result.candidates] : result.candidates;
        list._candidates = items;
        list._scanId = result.scan_id;
        list._nextOffset = result.next_offset;
        list._done = result.done;
        list.innerHTML = items.map((item, i) => `<article class="card notes3d-review-item">
          <b>${esc(item.title)}</b><span class="mono muted">${esc(item.vault)} · ${esc(item.path)}</span>
          <div>${esc(item.predicate)} → ${esc(item.target.title)}</div><small class="muted">${esc(item.evidence)} · ${esc(tr('notes3d.patternOnly'))}</small>
          ${item.can_save ? `<div class="row"><button type="button" class="chip" data-discover-save="${i}">${esc(tr('notes3d.saveSuggestion'))}</button></div>` : `<small class="muted">${esc(tr('notes3d.discoverReadOnly'))}</small>`}
        </article>`).join('');
        status.textContent = result.done ? tr('notes3d.discoverDone', { count: items.length, scanned: result.next_offset, total: result.total_sources })
          : tr('notes3d.discoverProgress', { count: items.length, scanned: result.next_offset, total: result.total_sources });
        button.textContent = result.done ? tr('notes3d.discoverRun') : tr('notes3d.discoverMore');
      } catch (error) {
        if (/vault changed during this scan/i.test(error.message)) {
          status.textContent = tr('notes3d.discoverChanged');
          list._nextOffset = 0; list._done = true; list._candidates = []; list._scanId = null; list.innerHTML = ''; button.textContent = tr('notes3d.discoverRun');
        } else status.textContent = tr('notes3d.discoverFailed', { error: error.message });
      } finally { button.disabled = false; }
    }

    function updateManualTargetOptions(form) {
      const predicate = form.querySelector('[data-manual-predicate]')?.value;
      const select = form.querySelector('[data-manual-target]');
      if (!select) return;
      const allowed = new Set(relationTargets[predicate] || []);
      for (const option of select.options) option.hidden = !allowed.has(option.dataset.entityType);
      if (select.selectedOptions[0]?.hidden) select.selectedIndex = [...select.options].findIndex((option) => !option.hidden);
    }

    root.addEventListener('input', (e) => { if (e.target.id === 'notes3d-search') renderNodeList(); });
    root.addEventListener('change', (e) => {
      if (e.target.matches('[data-manual-predicate]')) { updateManualTargetOptions(e.target.closest('details')); return; }
      if (e.target.id !== 'notes3d-vault-select') return;
      vaultFilter = e.target.value || '*';
      activeGroup = null;
      selectedId = null; currentDetail = null; currentNode = null;
      document.getElementById('notes3d-panel-detail').close();
      const suggestions = document.getElementById('notes3d-discover-list');
      suggestions._nextOffset = 0; suggestions._done = true; suggestions._candidates = []; suggestions._scanId = null; suggestions.innerHTML = '';
      document.getElementById('notes3d-discover-status').textContent = '';
      document.getElementById('notes3d-discover-run').textContent = tr('notes3d.discoverRun');
      loadGraph();
    });
    window.addEventListener('brainlink:locale-changed', () => {
      root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = tr(el.dataset.i18n); });
      root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = tr(el.dataset.i18nPlaceholder); });
      renderVaultOptions();
      renderNodeList();
    });

    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-notes3d-retry]')) { loadGraph(); return; }
      if (e.target.closest('#notes3d-reset-view')) { graphInstance?.zoomToFit(700, 50); return; }
      if (e.target.closest('[data-review-load-more]')) { loadReviewQueue({ append: true }); return; }
      const graphNote = e.target.closest('[data-graph-note-id]');
      if (graphNote) { openById(graphNote.dataset.graphNoteId); return; }
      const saveGraphRecord = e.target.closest('[data-save-graph-record]');
      if (saveGraphRecord) {
        if (!currentDetail) return;
        const fields = Object.fromEntries([...document.getElementById('notes3d-links').querySelectorAll('[data-graph-record-field]')].map((field) => [field.dataset.graphRecordField, field.value]));
        if (fields.type === 'workflow') for (const field of document.getElementById('notes3d-links').querySelectorAll('[data-graph-workflow-field]')) fields[field.getAttribute('data-graph-workflow-field')] = field.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
        saveGraphRecord.disabled = true;
        api('/api/graph3d/entity/save', { vault: currentDetail.vault, path: currentDetail.path, etag: currentDetail.etag, graph_record: fields })
          .then(async (result) => { toast(tr('notes3d.graphRecordSaved')); await loadGraph(); const updated = nodesById.find((node) => node.vault === currentDetail?.vault && node.path === currentDetail?.path); if (updated) openById(updated.id); })
          .catch((err) => { toast(err.message, true); saveGraphRecord.disabled = false; });
        return;
      }
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
        if (pendingVaultRefresh) { pendingVaultRefresh = false; refreshGraph(); }
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
          pendingVaultRefresh = false;
          toast('Note saved.');
          return loadGraph();
        }).catch((err) => { document.getElementById('notes3d-save-status').textContent = err.message; }).finally(() => { button.disabled = false; });
        return;
      }
      if (e.target.id === 'notes3d-discover-run') { runDiscovery({ append: Boolean(document.getElementById('notes3d-discover-list')._nextOffset && !document.getElementById('notes3d-discover-list')._done) }); return; }
      const review = e.target.closest('[data-review-relation]');
      if (review) {
        if (!currentDetail || !window.confirm(tr('notes3d.approveConfirm'))) return;
        review.disabled = true;
        api('/api/graph3d/relationship/approve', { vault: currentDetail.vault, path: currentDetail.path, etag: currentDetail.etag, relation_index: Number(review.dataset.reviewRelation) })
          .then(() => { toast(tr('notes3d.approvedToast')); return refreshGraph(); })
          .catch((err) => { review.disabled = false; toast(err.message, true); });
        return;
      }
      const reject = e.target.closest('[data-reject-relation]');
      if (reject) {
        if (!currentDetail || !window.confirm(tr('notes3d.rejectConfirm'))) return;
        reject.disabled = true;
        api('/api/graph3d/relationship/reject', { vault: currentDetail.vault, path: currentDetail.path, etag: currentDetail.etag, relation_index: Number(reject.dataset.rejectRelation) })
          .then(() => { toast(tr('notes3d.rejectedToast')); return refreshGraph(); })
          .catch((err) => { reject.disabled = false; toast(err.message, true); });
        return;
      }
      const reopen = e.target.closest('[data-reopen-relation]');
      if (reopen) {
        if (!currentDetail || !window.confirm(tr('notes3d.undoApprovalConfirm'))) return;
        reopen.disabled = true;
        api('/api/graph3d/relationship/reopen', { vault: currentDetail.vault, path: currentDetail.path, etag: currentDetail.etag, relation_index: Number(reopen.dataset.reopenRelation) })
          .then(() => { toast(tr('notes3d.undoApprovalToast')); return refreshGraph(); })
          .catch((err) => { reopen.disabled = false; toast(err.message, true); });
        return;
      }
      const reopenRejected = e.target.closest('[data-reopen-rejected]');
      if (reopenRejected) {
        if (!currentDetail || !window.confirm(tr('notes3d.reopenRejectedConfirm'))) return;
        reopenRejected.disabled = true;
        api('/api/graph3d/relationship/reopen', { vault: currentDetail.vault, path: currentDetail.path, etag: currentDetail.etag, relation_index: Number(reopenRejected.dataset.reopenRejected) })
          .then(() => { toast(tr('notes3d.reopenRejectedToast')); return refreshGraph(); })
          .catch((err) => { reopenRejected.disabled = false; toast(err.message, true); });
        return;
      }
      const archiveRelation = e.target.closest('[data-archive-relation]');
      if (archiveRelation) {
        if (!currentDetail || !window.confirm(tr('notes3d.archiveRelationshipConfirm'))) return;
        archiveRelation.disabled = true;
        api('/api/graph3d/relationship/archive', { vault: currentDetail.vault, path: currentDetail.path, etag: currentDetail.etag, relation_index: Number(archiveRelation.dataset.archiveRelation) })
          .then(() => { toast(tr('notes3d.archivedToast')); return refreshGraph(); })
          .catch((err) => { archiveRelation.disabled = false; toast(err.message, true); });
        return;
      }
      const saveRelation = e.target.closest('[data-save-relation]');
      if (saveRelation) {
        if (!currentDetail) return;
        const editor = saveRelation.closest('details');
        saveRelation.disabled = true;
        api('/api/graph3d/relationship/edit', {
          vault: currentDetail.vault, path: currentDetail.path, etag: currentDetail.etag,
          relation_index: Number(saveRelation.dataset.saveRelation),
          predicate: editor.querySelector('[data-edit-predicate]').value,
          target_id: editor.querySelector('[data-edit-target]').value,
          evidence: editor.querySelector('[data-edit-evidence]').value,
          confidence: editor.querySelector('[data-edit-confidence]').value,
        }).then((result) => {
          toast(tr('notes3d.editedRelationshipToast'));
          return refreshGraph();
        }).catch((err) => { saveRelation.disabled = false; toast(err.message, true); });
        return;
      }
      const restoreWithdrawn = e.target.closest('[data-restore-withdrawn]');
      if (restoreWithdrawn) {
        if (!currentDetail || !window.confirm(tr('notes3d.restoreWithdrawnConfirm'))) return;
        restoreWithdrawn.disabled = true;
        api('/api/graph3d/relationship/reopen', { vault: currentDetail.vault, path: currentDetail.path, etag: currentDetail.etag, relation_index: Number(restoreWithdrawn.dataset.restoreWithdrawn) })
          .then(() => { toast(tr('notes3d.restoredWithdrawnToast')); return refreshGraph(); })
          .catch((err) => { restoreWithdrawn.disabled = false; toast(err.message, true); });
        return;
      }
      const queuedReview = e.target.closest('[data-approve-queued]');
      if (queuedReview) {
        const item = document.getElementById('notes3d-review-list')._pendingReviews?.[Number(queuedReview.dataset.approveQueued)];
        if (!item || !window.confirm(tr('notes3d.approveConfirm'))) return;
        queuedReview.disabled = true;
        api('/api/graph3d/note', { vault: item.vault, path: item.path })
          .then((detail) => api('/api/graph3d/relationship/approve', { vault: item.vault, path: item.path, etag: detail.etag, relation_index: item.relation_index }))
          .then(() => { toast(tr('notes3d.approvedToast')); return refreshGraph(); })
          .catch((err) => { queuedReview.disabled = false; toast(err.message, true); loadReviewQueue(); });
        return;
      }
      const queuedReject = e.target.closest('[data-reject-queued]');
      if (queuedReject) {
        const item = document.getElementById('notes3d-review-list')._pendingReviews?.[Number(queuedReject.dataset.rejectQueued)];
        if (!item || !window.confirm(tr('notes3d.rejectConfirm'))) return;
        queuedReject.disabled = true;
        api('/api/graph3d/note', { vault: item.vault, path: item.path })
          .then((detail) => api('/api/graph3d/relationship/reject', { vault: item.vault, path: item.path, etag: detail.etag, relation_index: item.relation_index }))
          .then(() => { toast(tr('notes3d.rejectedToast')); return refreshGraph(); })
          .catch((err) => { queuedReject.disabled = false; toast(err.message, true); loadReviewQueue(); });
        return;
      }
      const suggestion = e.target.closest('[data-save-suggestion]');
      if (suggestion) {
        if (!currentDetail || !window.confirm(tr('notes3d.saveSuggestionConfirm'))) return;
        suggestion.disabled = true;
        api('/api/graph3d/relationship/propose', { vault: currentDetail.vault, path: currentDetail.path, etag: currentDetail.etag,
          target_id: suggestion.dataset.saveSuggestion, predicate: suggestion.dataset.predicate, evidence: suggestion.dataset.evidence })
          .then(() => { toast(tr('notes3d.suggestionSaved')); return refreshGraph(); })
          .catch((err) => { suggestion.disabled = false; toast(err.message, true); });
        return;
      }
      const discovered = e.target.closest('[data-discover-save]');
      if (discovered) {
        const item = document.getElementById('notes3d-discover-list')._candidates?.[Number(discovered.dataset.discoverSave)];
        if (!item || !window.confirm(tr('notes3d.saveSuggestionConfirm'))) return;
        discovered.disabled = true;
        api('/api/graph3d/note', { vault: item.vault, path: item.path })
          .then((detail) => api('/api/graph3d/relationship/propose', { vault: item.vault, path: item.path, etag: detail.etag,
            target_id: item.target_id, predicate: item.predicate, evidence: item.evidence }))
          .then(() => { toast(tr('notes3d.suggestionSaved')); return refreshGraph(); })
          .catch((err) => { discovered.disabled = false; toast(err.message, true); });
        return;
      }
      const manual = e.target.closest('[data-propose-manual]');
      if (manual) {
        if (!currentDetail || !window.confirm(tr('notes3d.saveSuggestionConfirm'))) return;
        const form = manual.closest('details');
        manual.disabled = true;
        api('/api/graph3d/relationship/propose-manual', { vault: currentDetail.vault, path: currentDetail.path, etag: currentDetail.etag,
          target_id: form.querySelector('[data-manual-target]')?.value, predicate: form.querySelector('[data-manual-predicate]')?.value,
          evidence: form.querySelector('[data-manual-evidence]')?.value })
          .then(() => { toast(tr('notes3d.suggestionSaved')); return refreshGraph(); })
          .catch((err) => { manual.disabled = false; toast(err.message, true); });
        return;
      }
      if (e.target.id === 'notes3d-close') {
        document.getElementById('notes3d-panel-detail').close();
        return;
      }
      if (e.target.id === 'notes3d-panel-detail') { e.target.close(); return; }
      const wiki = e.target.closest('[data-wikilink]');
      if (wiki) { e.preventDefault(); openByTitle(wiki.dataset.wikilink); return; }
      const chip = e.target.closest('[data-focus-title]');
      if (chip) { openByTitle(chip.dataset.focusTitle); return; }
    });
    let graphLoadSequence = 0;
    async function loadGraph() {
      const sequence = ++graphLoadSequence;
      const canvas = document.getElementById('notes3d-canvas');
      const resetView = document.getElementById('notes3d-reset-view');
      if (resetView) resetView.disabled = true;
      if (!graphInstance) canvas.innerHTML = `<p class="skeleton">${esc(tr('notes3d.loading'))}</p>`;
      let g;
      try {
        const optionData = await api('/api/graph3d/vaults', {});
        graphVaultOptions = optionData.vaults;
        if (vaultFilter === null && optionData.vaults.length) vaultFilter = optionData.vaults[0].name;
        if (vaultFilter && vaultFilter !== '*' && !optionData.vaults.some((vault) => vault.name === vaultFilter)) vaultFilter = optionData.vaults[0]?.name || '*';
        renderVaultOptions();
        g = await api('/api/graph3d', { vault: vaultFilter && vaultFilter !== '*' ? vaultFilter : undefined });
      }
      catch (e) {
        if (sequence !== graphLoadSequence) return;
        try { graphInstance?._destructor?.(); } catch {}
        graphInstance = null; loadedOk = false;
        canvas.innerHTML = `<p class="error-box">${esc(tr('notes3d.loadError', { error: e.message }))}</p><button type="button" data-notes3d-retry>${esc(tr('boot.retry'))}</button>`;
        return;
      }
      if (sequence !== graphLoadSequence) return;
      // The health endpoint builds the full search index, and review suggestions can be slow on
      // large vaults. Neither should hold the 3D canvas behind a loading message.
      const refreshAuxiliary = () => {
        loadReviewQueue().catch(() => {});
      };
      stat('st-notes', g.total ?? g.nodes.length);
      stat('st-links', g.linkCount ?? g.links.length);
      stat('st-orphans', g.unlinked ?? g.nodes.filter((node) => node.degree === 0).length);
      nodesById = g.nodes;
      graphDataAll = { nodes: g.nodes, links: g.links };
      byTitle = new Map(g.nodes.map((n) => [n.title.toLowerCase(), n]));
      renderNodeList();
      const css = getComputedStyle(document.documentElement);
      const colorVars = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
      const counts = new Map();
      for (const n of g.nodes) counts.set(n.group, (counts.get(n.group) || 0) + 1);
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
      const colorOf = (grp) => { const r = ranked.indexOf(grp); return r >= 0 && r < 8 ? css.getPropertyValue(`--${colorVars[r]}`).trim() : css.getPropertyValue('--muted').trim(); };
      const selectedColor = css.getPropertyValue('--accent').trim() || css.getPropertyValue('--ink').trim() || '#fff';
      renderGraphLegend(ranked, colorOf);
      if (activeGroup !== null && !ranked.includes(activeGroup)) activeGroup = null;
      if (activeGroup !== null) root.querySelectorAll('[data-graph-group-index]').forEach((button) => button.setAttribute('aria-pressed', String(ranked[Number(button.dataset.graphGroupIndex)] === activeGroup)));
      if (!g.nodes.length) {
        if (graphInstance) graphInstance.graphData({ nodes: [], links: [] });
        else canvas.innerHTML = `<p class="muted" data-i18n="notes3d.empty">${esc(tr('notes3d.empty'))}</p>`;
        loadedOk = false; refreshAuxiliary(); return;
      }
      if (graphInstance) {
        try {
          graphInstance.graphData(graphPayloadForActiveGroup());
          loadedOk = true;
          if (resetView) resetView.disabled = false;
          fitGraphAfterLayout();
        } catch (e) {
          graphInstance = null;
          loadedOk = false;
          canvas.innerHTML = `<p class="error-box">Could not draw the 3D map: ${esc(e.message || e)}. Reload BrainLink and try again.</p>`;
        }
        refreshAuxiliary();
        return;
      }
      if (typeof ForceGraph3D !== 'function') { canvas.innerHTML = '<p class="error-box">Could not load the 3D map (missing viewer). Try reloading.</p>'; return; }
      canvas.innerHTML = '';
      // nodeLabel is rendered as the hover tooltip's innerHTML (3d-force-graph's documented
      // behavior), so a note title must be escaped the same way any other note-derived text going
      // into innerHTML is (see renderInline/renderMarkdown above) — otherwise a crafted title could
      // inject HTML into the tooltip.
      try {
        graphInstance = ForceGraph3D()(canvas)
          .graphData(graphPayloadForActiveGroup())
          .backgroundColor(css.getPropertyValue('--bg').trim() || '#000')
          .nodeLabel((n) => `${esc(n.title)}${n.type ? `<br><small>${esc(n.type)}</small>` : ''}`)
          .nodeColor((n) => (n.id === selectedId ? selectedColor : colorOf(n.group)))
          .nodeVal((n) => (n.id === selectedId ? 1.6 : 1) + Math.sqrt(n.degree || 0))
          .linkColor((l) => l.kind === 'typed' ? selectedColor : css.getPropertyValue('--muted').trim())
          .linkCurvature((l) => l.parallel_count > 1 ? (l.parallel_index - (l.parallel_count - 1) / 2) * 0.12 : 0)
          .linkLabel((l) => l.predicate ? `${esc(l.predicate)}${l.evidence ? `<br><small>${esc(l.evidence)}</small>` : ''}${Number.isFinite(l.confidence) ? `<br><small>Confidence ${esc(l.confidence)}</small>` : ''}` : '')
          .linkOpacity(0.35)
          .onNodeClick((n) => openById(n.id));
      } catch (e) {
        graphInstance = null;
        canvas.innerHTML = `<p class="error-box">Could not draw the 3D map: ${esc(e.message || e)}. Reload BrainLink and try again.</p>`;
        return;
      }
      if (resetView) resetView.disabled = false;
      loadedOk = true;
      fitGraphAfterLayout();
      refreshAuxiliary();
    }

    async function refreshGraph() {
      if (brainPanel.hidden || !loaded) { pendingVaultRefresh = true; return; }
      const editor = document.getElementById('notes3d-editor');
      if (editor && !editor.hidden) { pendingVaultRefresh = true; return; }
      const selected = currentNode && { vault: currentNode.vault, path: currentNode.path };
      selectedId = null;
      await loadGraph();
      if (!selected) return;
      const updated = nodesById.find((node) => node.vault === selected.vault && node.path === selected.path);
      if (updated) openById(updated.id);
      else document.getElementById('notes3d-panel-detail').close();
    }
    window.addEventListener('brainlink:vault-changed', () => { pendingVaultRefresh = false; refreshGraph(); });

    // canvas.clientWidth/clientHeight can read 0 (or a stale pre-layout value) the instant
    // #brain-panel stops being hidden, so this is called once right after the graph is created,
    // again one frame later (requestAnimationFrame, after layout has definitely settled), and on
    // every subsequent ResizeObserver tick — never just once at construction time.
    function resizeToContainer() {
      const c = document.getElementById('notes3d-canvas');
      if (!graphInstance || !c) return;
      graphInstance.width(c.clientWidth || 600).height(c.clientHeight || 450);
    }

    function fitGraphAfterLayout() {
      const instance = graphInstance;
      if (!instance) return;
      requestAnimationFrame(() => {
        resizeToContainer();
        requestAnimationFrame(() => {
          if (graphInstance === instance) instance.zoomToFit(700, 60);
        });
      });
    }

    buildLayout(root);
    document.getElementById('notes3d-panel-detail').addEventListener('close', () => {
      selectedId = null;
      currentDetail = null;
      currentNode = null;
      graphInstance?.refresh();
    });
    const ro = new ResizeObserver(resizeToContainer);
    ro.observe(root);

    function maybeLoad() {
      if (brainPanel.hidden || (brainPanel.tagName === 'DETAILS' && !brainPanel.open)) return;
      if (!loaded) { loaded = true; loadGraph().then(() => requestAnimationFrame(resizeToContainer)); }
      else if (pendingVaultRefresh) { pendingVaultRefresh = false; refreshGraph(); }
    }
    maybeLoad();
    brainPanel.addEventListener('toggle', maybeLoad);
    new MutationObserver(maybeLoad).observe(brainPanel, { attributes: true, attributeFilter: ['hidden'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
