const PAL = { items: [], sel: 0 };
function palItems() {
  const items = [];
  const v = (label, view) => items.push({ k: 'view', label, sub: '', run: () => setView(view) });
  v('Board', 'board'); v('Line map', 'lines'); v('Recipe map', 'plan'); v('The crew', 'crew');
  for (const m of [...MODELS.values()].sort(urgencyCmp)) items.push({ k: 'job', label: `${m.id} · ${m.job.title}`, sub: m.sum[1], run: () => openJob(m.id, { user: true }), m });
  BUCKETS.forEach(([b, name], i) => items.push({ k: 'filter', label: `${facetSet('status').has(b) ? 'Hide' : 'Show only'} ${name.toLowerCase()}`, sub: `${i + 1}`, run: () => toggleFacet('status', b) }));
  for (const g of Object.keys(GROUPS)) items.push({ k: 'group', label: `Group by ${g}`, sub: UI.group === g ? 'current' : '', run: () => { UI.group = g; store.set('fc-group', g); $('#groupby').value = g; refreshFloor(); setView('board'); } });
  for (const s of Object.keys(SORTS)) items.push({ k: 'sort', label: `Sort by ${s}`, sub: UI.sort === s ? 'current' : '', run: () => { UI.sort = s; store.set('fc-sort', s); $('#sortby').value = s; refreshFloor(); setView('board'); } });
  for (const t of ['is:waiting', 'has:rework', 'has:finding', 'risk:high', 'since:1d']) items.push({ k: 'query', label: `Filter ${t}`, sub: '', run: () => { UI.q = t; $('#q').value = t; refreshFloor(); setView(UI.view === 'lines' ? 'lines' : 'board'); } });
  items.push({ k: 'toggle', label: 'Clear all filters', sub: '', run: clearFilters });
  items.push({ k: 'toggle', label: 'Next job waiting for you', sub: 'g w', run: nextWaiting });
  items.push({ k: 'toggle', label: UI.wirePaused ? 'Resume the wire' : 'Pause the wire', sub: '', run: () => { UI.wirePaused = !UI.wirePaused; renderWire(); } });
  items.push({ k: 'toggle', label: UI.collapsed.has('done') ? 'Expand done jobs' : 'Collapse done jobs', sub: '', run: () => { if (UI.collapsed.has('done')) UI.collapsed.delete('done'); else UI.collapsed.add('done'); refreshFloor(); } });
  items.push({ k: 'toggle', label: 'Change theme', sub: UI.theme, run: cycleTheme });
  items.push({ k: 'toggle', label: UI.notify ? 'Turn desktop notifications off' : 'Turn desktop notifications on', sub: '', run: toggleNotify });
  items.push({ k: 'toggle', label: 'Mark every job as read', sub: '', run: () => { for (const m of MODELS.values()) SEEN[m.id] = m.rev; store.set('fc-seen', JSON.stringify(SEEN)); for (const r of ROWS.values()) r.sig = ''; refreshFloor(); } });
  items.push({ k: 'toggle', label: 'Keyboard shortcuts', sub: '?', run: () => $('#keys').showModal() });
  return items;
}
function palFilter() {
  const q = $('#pal-q').value.trim().toLowerCase();
  const all = palItems();
  PAL.items = !q ? all : all.filter((x) => { const t = `${x.k} ${x.label} ${x.sub}`.toLowerCase(); return q.split(/\s+/).every((w) => t.includes(w) || fuzzy(w, t)); });
  PAL.sel = Math.min(PAL.sel, Math.max(0, PAL.items.length - 1));
  $('#pal-list').innerHTML = PAL.items.slice(0, 60).map((x, i) => `<li><button type="button" role="option" data-i="${i}" aria-selected="${i === PAL.sel}"><span class="pk2">${esc(x.k)}</span><span>${x.m ? `<i class="beacon" style="display:inline-block;margin-right:7px;--bk:${LINE_COLOR[x.m.bucket]}"></i>` : ''}${esc(x.label)}</span><span class="ps">${esc(x.sub)}</span></button></li>`).join('') || '<li style="padding:12px;color:var(--muted)">Nothing matches.</li>';
  $('#pal-list').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => palRun(+b.dataset.i)));
  const on = $('#pal-list').querySelector('[aria-selected="true"]');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
function palRun(i) { const x = PAL.items[i]; $('#palette').close(); if (x) x.run(); }
function openPalette() {
  if ($('#palette').open) return;
  $('#pal-q').value = '';
  PAL.sel = 0;
  palFilter();
  $('#palette').showModal();
  $('#pal-q').focus();
}
function qHelp(show) {
  const h = $('#qhelp');
  h.hidden = !show;
  if (!show) return;
  h.innerHTML = `<p>Tokens narrow the board and the line map; words match ids, titles and what happened.</p><div class="toks">${QTOKENS.map((t) => `<button type="button" data-t="${t}">${t}</button>`).join('')}</div><p>Prefix with <code>-</code> to exclude, e.g. <code>-is:done</code>. <kbd>esc</kbd> clears.</p>`;
  h.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const inp = $('#q');
    inp.value = `${inp.value.trim()} ${b.dataset.t}`.trim();
    onQuery();
  }));
}
let qT = 0;
function onQuery() {
  clearTimeout(qT);
  qT = setTimeout(() => {
    UI.q = $('#q').value;
    if (UI.view !== 'board' && UI.view !== 'lines') setView('board', { push: false });
    refreshFloor();
  }, 70);
}
function typing(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }
let gPending = 0;
function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openPalette(); return; }
    if ($('#palette').open || $('#keys').open) return;
    if (typing(e)) {
      if (e.target.id === 'q' && e.key === 'Escape') { if (e.target.value) { e.target.value = ''; onQuery(); } else e.target.blur(); }
      if (e.target.id === 'q' && e.key === 'Enter') { e.preventDefault(); if (VISIBLE.length === 1) openJob(VISIBLE[0], { user: true }); else { e.target.blur(); stepJob(0); } }
      if (e.target.id === 'q' && e.key === 'ArrowDown') { e.preventDefault(); e.target.blur(); stepJob(0); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (gPending && Date.now() - gPending < 1200) {
      gPending = 0;
      if (e.key === 'w') { e.preventDefault(); nextWaiting(); return; }
      if (e.key === 'b') { e.preventDefault(); setView('board'); return; }
      if (e.key === 'l') { e.preventDefault(); setView('lines'); return; }
      if (e.key === 'm') { e.preventDefault(); setView('plan'); return; }
      if (e.key === 'c') { e.preventDefault(); setView('crew'); return; }
    }
    if (e.key === 'g') { gPending = Date.now(); return; }
    const inCanvas = e.target && e.target.closest && e.target.closest('#street, #s-range, #canvas, #lm-scroll');
    if (e.key === '/') { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
    if (e.key === '?') { e.preventDefault(); $('#keys').showModal(); return; }
    if (e.key === 'j' || e.key === 'k') { e.preventDefault(); stepJob(e.key === 'j' ? 1 : -1); return; }
    if (e.key === 'Escape') {
      if (UI.view === 'job') { e.preventDefault(); const id = LV.job && LV.job.id; setView('board'); const r = ROWS.get(id); if (r) { r.el.focus({ preventScroll: true }); r.el.scrollIntoView({ block: 'nearest' }); } return; }
      if (UI.view !== 'board') { setView('board'); return; }
      return;
    }
    if (/^[1-5]$/.test(e.key) && !inCanvas && UI.view !== 'plan') { e.preventDefault(); toggleFacet('status', BUCKETS[+e.key - 1][0]); return; }
    if (e.key === 'Enter' && UI.view === 'board' && UI.cursor && !(e.target && e.target.closest && e.target.closest('button, a, select'))) { e.preventDefault(); openJob(UI.cursor, { user: true }); }
  });
  $('#pal-q').addEventListener('input', () => { PAL.sel = 0; palFilter(); });
  $('#pal-q').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); PAL.sel = Math.min(PAL.items.length - 1, PAL.sel + 1); palFilter(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); PAL.sel = Math.max(0, PAL.sel - 1); palFilter(); }
    if (e.key === 'Enter') { e.preventDefault(); palRun(PAL.sel); }
  });
  for (const d of [$('#palette'), $('#keys')]) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
}

// ---------- ingest: the first payload and every live one
