function renderKpis() {
  const all = [...MODELS.values()];
  const n = (b) => all.filter((m) => m.bucket === b);
  const sel = facetSet('status');
  const sub = {
    turn: (l) => (l.length ? `oldest waits ${shortAgo(nowMs() - Math.min(...l.map((m) => m.waitSince || m.updated)))}` : 'nothing waits on you'),
    running: (l) => { const a = l.reduce((k, m) => k + (m.job.running_agents || []).length, 0); return l.length ? `${a} agent${a === 1 ? '' : 's'} on the floor` : 'the floor is quiet'; },
    parked: (l) => (l.length ? `${l.map((m) => m.id).slice(0, 3).join(' · ')}` : 'none parked'),
    stopped: (l) => (l.length ? `${l.filter((m) => m.job.status === 'cancelled').length} cancelled · ${l.filter((m) => m.job.status === 'abandoned').length} abandoned` : 'none stopped'),
    done: (l) => { const d = l.filter((m) => m.closed && nowMs() - m.closed < 864e5).length; return l.length ? `${d} closed in the last day` : 'none closed yet'; },
  };
  $('#kpis').innerHTML = BUCKETS.map(([k, name], i) => {
    const l = n(k);
    return `<button type="button" class="kpi k-${k}${l.length ? '' : ' zero'}" data-b="${k}" aria-pressed="${sel.has(k)}" aria-label="${esc(name)}: ${l.length}. Press to ${sel.has(k) ? 'remove' : 'add'} this filter (key ${i + 1})"><span class="n">${l.length}</span><span class="k"><i></i>${esc(name)}</span><span class="s">${esc(sub[k](l))}</span><span class="hk" aria-hidden="true"><kbd>${i + 1}</kbd></span></button>`;
  }).join('');
  $('#kpis').querySelectorAll('.kpi').forEach((b) => b.addEventListener('click', () => toggleFacet('status', b.dataset.b)));
  const turn = n('turn').length;
  document.title = `${turn ? `(${turn}) ` : ''}Factory Console${DATA && DATA.project ? ` · ${DATA.project}` : ''}`;
  $('#mark-a').className = turn ? 'a' : '';
}
function renderRail() {
  const all = [...MODELS.values()];
  const pq = parseQ(UI.q);
  const base = all.filter((m) => qOk(m, pq));
  const html = [];
  for (const [k, title, fn, name, order] of FACETS) {
    const sub = base.filter((m) => facetOk(m, k));
    const counts = new Map();
    for (const m of all) { const v = fn(m); if (v !== null && v !== undefined && !counts.has(v)) counts.set(v, 0); }
    for (const m of sub) { const v = fn(m); if (v !== null && v !== undefined) counts.set(v, (counts.get(v) || 0) + 1); }
    if (!counts.size) continue;
    const keys = [...counts.keys()].sort((a, b) => (order ? (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) : 0) || (counts.get(b) - counts.get(a)) || String(a).localeCompare(String(b)));
    const max = Math.max(1, ...counts.values());
    const s = UI.facets[k];
    html.push(`<section class="facet"><h3><span>${esc(title)}</span>${s && s.size ? `<button type="button" data-clear="${k}">clear</button>` : ''}</h3>${keys.map((v) => {
      const c = counts.get(v);
      const on = Boolean(s && s.has(v));
      return `<button type="button" class="fopt${c ? '' : ' zero'}" data-f="${k}" data-v="${esc(v)}" aria-pressed="${on}" style="--w:${Math.round((c / max) * 100)}%"><span class="sw2"></span><span class="fl${k === 'recipe' || k === 'gate' ? ' mono' : ''}">${esc(name ? name(v) : v)}</span><span class="fc">${c}</span></button>`;
    }).join('')}</section>`);
  }
  html.push(`<section class="facet"><h3><span>Tokens</span></h3><p class="label" style="text-transform:none;letter-spacing:0;line-height:1.5;margin:0">Type in the box above, e.g. <code>is:waiting</code> <code>has:rework</code> <code>agent:builder</code> <code>since:2d</code>, or <kbd>⌘K</kbd> for everything.</p></section>`);
  $('#rail').innerHTML = html.join('');
  $('#rail').querySelectorAll('.fopt').forEach((b) => b.addEventListener('click', () => toggleFacet(b.dataset.f, b.dataset.v)));
  $('#rail').querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => { UI.facets[b.dataset.clear] = new Set(); refreshFloor(); }));
}
function toggleFacet(k, v) {
  const s = facetSet(k);
  if (s.has(v)) s.delete(v); else s.add(v);
  if (k === 'status' && s.has(v)) UI.collapsed.delete(v);
  if (UI.view !== 'board' && UI.view !== 'lines') setView('board');
  refreshFloor();
}
function clearFilters() { UI.facets = {}; UI.q = ''; $('#q').value = ''; refreshFloor(); }
function renderQchips() {
  const chips = [];
  for (const [k, title, , name] of FACETS) for (const v of UI.facets[k] || []) chips.push(`<button type="button" class="qchip" data-f="${k}" data-v="${esc(v)}" aria-label="Remove filter ${esc(title)} ${esc(v)}"><b>${esc(title.toLowerCase())}</b>${esc(name ? name(v) : v)} ×</button>`);
  $('#qchips').innerHTML = chips.join('');
  $('#qchips').querySelectorAll('.qchip').forEach((b) => b.addEventListener('click', () => toggleFacet(b.dataset.f, b.dataset.v)));
}
function refreshFloor(opts = {}) {
  if (!UI.booted) return;
  renderKpis();
  renderRail();
  renderQchips();
  renderBoard(opts);
  if (UI.view === 'lines') renderLines();
  if (UI.view === 'job') renderJList();
  saveHash();
}

// ---------- the wire: every timeline item of every job, newest first
