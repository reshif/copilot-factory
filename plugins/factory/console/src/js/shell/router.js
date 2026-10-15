function setView(v, { push = true } = {}) {
  if (v === 'live') v = LV.job ? 'job' : 'board';
  UI.view = v;
  const app = $('#app');
  app.dataset.view = v;
  app.classList.toggle('wire-open', v === 'job' && UI.wireOpen);
  for (const b of document.querySelectorAll('.nav [data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === v || (v === 'job' && b.dataset.view === 'board')));
  $('#view-board').hidden = v !== 'board';
  $('#view-lines').hidden = v !== 'lines';
  $('#view-job').hidden = v !== 'job';
  $('#view-plan').hidden = v !== 'plan';
  $('#view-crew').hidden = v !== 'crew';
  $('#view-blueprint').hidden = v !== 'blueprint';
  if (v !== 'plan') stopRun();
  if (v !== 'job') stopPlay();
  if (v === 'plan') {
    if (LV.job && RECIPES[LV.job.recipe] && !planReady) { recipe = LV.job.recipe; renderPicker(); render(); }
    planReady = true;
    requestAnimationFrame(startView);
  }
  if (v === 'lines') { LM.fitted = false; renderLines(); }
  if (v === 'board') { renderBoard(); if (UI.cursor) { const r = ROWS.get(UI.cursor); if (r) r.el.scrollIntoView({ block: 'nearest' }); } }
  if (v === 'job') renderJList();
  if (v === 'blueprint') showBlueprint();
  if (UI.wireJob) renderWire();
  if (push) saveHash();
}
let planReady = false;
let hashWritten = '';
function hashOf() {
  const p = new URLSearchParams();
  if (UI.q) p.set('q', UI.q);
  const f = Object.entries(UI.facets).filter(([, s]) => s.size).map(([k, s]) => `${k}:${[...s].join(',')}`).join(';');
  if (f) p.set('f', f);
  if (UI.group !== 'attention') p.set('g', UI.group);
  if (UI.sort !== 'urgency') p.set('s', UI.sort);
  if (UI.cursor && UI.view !== 'job') p.set('c', UI.cursor);
  const qs = p.toString();
  const base = UI.view === 'job' && LV.job ? `/job/${LV.job.id}${UI.jobTab !== 'line' ? `/${UI.jobTab}` : ''}` : UI.view === 'plan' ? '/map' : `/${UI.view}`;
  return `#${base}${qs ? `?${qs}` : ''}`;
}
let hashT = 0;
function saveHash() {
  clearTimeout(hashT);
  hashT = setTimeout(() => {
    const h = hashOf();
    if (h === location.hash) return;
    hashWritten = h;
    try { history.replaceState(null, '', h); } catch (e) { /* sandboxed */ }
  }, 60);
}
function readHash() {
  const raw = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  if (/^J-\d+$/.test(raw)) return { view: 'job', job: raw };
  if (raw === 'map' || raw === 'plan') return { view: 'plan' };
  if (raw === 'crew') return { view: 'crew' };
  if (raw === 'blueprint') return { view: 'blueprint' };
  const [pathPart, qs] = raw.split('?');
  const seg = pathPart.split('/').filter(Boolean);
  const p = new URLSearchParams(qs || '');
  const out = { q: p.get('q') || '', g: p.get('g'), s: p.get('s'), c: p.get('c'), f: p.get('f') };
  if (seg[0] === 'job' && seg[1]) { out.view = 'job'; out.job = seg[1]; out.tab = seg[2] || 'line'; }
  else if (seg[0] === 'map' || seg[0] === 'plan') out.view = 'plan';
  else if (['board', 'lines', 'crew', 'blueprint'].includes(seg[0])) out.view = seg[0];
  return out;
}
function applyHash(h) {
  if (h.q !== undefined) { UI.q = h.q; $('#q').value = h.q; }
  if (h.g && GROUPS[h.g]) UI.group = h.g;
  if (h.s && SORTS[h.s]) UI.sort = h.s;
  if (h.c) UI.cursor = h.c;
  if (h.f !== undefined) {
    UI.facets = {};
    for (const part of String(h.f || '').split(';').filter(Boolean)) { const [k, v] = [part.slice(0, part.indexOf(':')), part.slice(part.indexOf(':') + 1)]; if (FACETS.some((x) => x[0] === k)) UI.facets[k] = new Set(v.split(',').filter(Boolean)); }
  }
  $('#groupby').value = UI.group;
  $('#sortby').value = UI.sort;
  if (h.view === 'job' && h.job && MODELS.has(h.job)) { refreshFloor(); openJob(h.job, { tab: h.tab || 'line', push: false }); return; }
  refreshFloor();
  setView(h.view && h.view !== 'job' ? h.view : 'board', { push: false });
}

// ---------- opening a job
