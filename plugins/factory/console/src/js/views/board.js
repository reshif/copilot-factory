function lampsHtml(m) { return `<span class="lamps" aria-hidden="true">${m.lamps.map((s) => `<i class="${s}"></i>`).join('')}</span>`; }
function sparkHtml(m, w0, w1) {
  const N = 28;
  const bins = new Array(N).fill(0);
  for (const t of m.times) { if (t < w0 || t > w1) continue; bins[Math.min(N - 1, Math.floor(((t - w0) / (w1 - w0)) * N))] += 1; }
  const max = Math.max(1, ...bins);
  const pts = bins.map((b, i) => [((i + 0.5) / N) * 100, 17 - (Math.sqrt(b) / Math.sqrt(max)) * 15]);
  const d = `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L')}`;
  return `<svg viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${d} L100,18 L0,18 Z"/><path d="${d}" vector-effect="non-scaling-stroke"/></svg>`;
}
function pipsHtml(m) {
  const j = m.job;
  const fam = (t) => modelFamily((j.models || {})[roleShort(t)]);
  const run = (j.running_agents || []).slice(0, 3).map((a) => `<span class="pip live ${fam(a.agent_type)}" title="${esc(roleShort(a.agent_type))} running since ${esc(fmtClock(a.since))}">${esc(modelLetter((j.models || {})[roleShort(a.agent_type)]))}</span>`);
  const stale = (j.stale_agents || []).length && m.bucket !== 'done' ? [`<span class="pip stale" title="${(j.stale_agents || []).length} agent(s) started but never reported back: their session probably ended">?</span>`] : [];
  const more = (j.running_agents || []).length > 3 ? `<span class="nest">+${j.running_agents.length - 3}</span>` : '';
  return run.concat(stale).join('') + more;
}
function nowCell(m) {
  const j = m.job;
  if (m.bucket === 'turn') return `<b>${esc(m.gate ? stepName(m.gate) : m.stepLabel)}</b><span class="w" data-since="${m.waitSince || ''}">waits ${esc(shortAgo(nowMs() - (m.waitSince || m.updated)))}</span>`;
  if (m.bucket === 'parked') return `<b>Parked · ${esc(stepName(m.S.pos))}</b><span class="w">${esc(((j.park && j.park.reason) || '').slice(0, 60))}</span>`;
  if (m.bucket === 'done') return `<b>${esc(j.pr && j.pr.merged ? 'Merged · closed' : 'Closed')}</b><span class="w">${esc(m.closed ? fmtDate(j.closed_at) : '')}</span>`;
  if (j.status === 'cancelled' || j.status === 'abandoned') return `<b>${esc(j.status === 'cancelled' ? 'Cancelled' : 'Abandoned')}</b><span class="w">at ${esc(stepName(m.S.pos))}</span>`;
  return `<b>${esc(m.stepLabel)}</b><span class="w">${esc(m.sum[1].replace(/^.*· /, ''))}</span>`;
}
function rowHtml(m, depth, win) {
  const j = m.job;
  const risk = String(j.risk || '').toLowerCase();
  const nest = depth ? '<span class="nest" aria-hidden="true">↳</span>' : j.followup_of ? `<span class="nest" title="Follow-up to ${esc(j.followup_of)}">⇢ ${esc(j.followup_of)}</span>` : j.epic ? '<span class="nest">EPIC</span>' : '';
  const flags = [m.loops ? `<span class="rw" title="${m.loops} return trip(s): fix rounds, re-proofs, denials">↺${m.loops}</span>` : '', m.retries ? `<span class="rt" title="${m.retries} agent retry(ies)">↻${m.retries}</span>` : '', m.findingsTotal ? `<span class="${m.findings ? 'fd' : ''}" title="${m.findingsTotal} inspector finding(s), ${m.findings} open">⚑${m.findingsTotal}</span>` : ''].join('');
  const tasks = m.tasksTotal ? `<span class="tbar" aria-hidden="true"><i style="width:${Math.round((m.tasksPassed / m.tasksTotal) * 100)}%"></i></span><span>${m.tasksPassed}/${m.tasksTotal} tasks</span>` : '<span>—</span>';
  return `<span class="bc"><i class="beacon"></i></span>
    <span class="bid">${esc(m.id)}${unreadOf(m) ? '<i class="unread" title="Changed since you last opened it"></i>' : ''}</span>
    <span class="btt">${nest}<span class="bti" title="${esc(j.title)}">${esc(j.title)}</span></span>
    <span class="brc"><span class="rchip rk-${esc(risk)}" title="recipe ${esc(j.recipe || '')} · ${esc(j.risk || '')} risk"><i></i><span>${esc(j.recipe || '—')}</span></span></span>
    ${lampsHtml(m)}
    <span class="bnow">${nowCell(m)}</span>
    <span class="bpip">${pipsHtml(m)}</span>
    <span class="btask">${tasks}</span>
    <span class="bflags">${flags}</span>
    <span class="bspark" title="Activity over the last three days">${sparkHtml(m, win[0], win[1])}</span>
    <span class="bago" data-ago="${m.updated}" title="Updated ${esc(fmtDate(j.updated_at))}">${esc(shortAgo(nowMs() - m.updated))}</span>`;
}
const ROWS = new Map(); // id → { el, sig }
const GHEAD = new Map();
function rowLabel(m) { return `${m.id}, ${m.job.title}. ${BUCKET_NAME[m.bucket]}: ${m.sum[1]}. Recipe ${m.job.recipe}.`; }
function renderBoard({ live = false } = {}) {
  const host = $('#board');
  const { groups, vis, all } = computeGroups();
  $('#bcount').textContent = `${vis.length} of ${all.length} job${all.length === 1 ? '' : 's'}`;
  if (!DATA || !DATA.jobs || !DATA.jobs.length) { boardEmpty(host); return; }
  if (!vis.length) {
    ROWS.clear(); GHEAD.clear();
    host.innerHTML = `<div class="bempty"><h2>Nothing matches</h2><p>No job fits <code>${esc(UI.q || 'these filters')}</code>${Object.values(UI.facets).some((s) => s.size) ? ' with the filters on the left' : ''}.</p><button type="button" class="tbtn" data-act="clear">Clear filters</button></div>`;
    host.querySelector('[data-act="clear"]').addEventListener('click', clearFilters);
    return;
  }
  const end = Date.parse(DATA.generated_at) || nowMs();
  const win = [end - 3 * 864e5, end];
  const animate = live && !reduceMotion && UI.view === 'board';
  const before = new Map();
  if (animate) for (const [id, r] of ROWS) if (r.el.isConnected) before.set(id, r.el.getBoundingClientRect().top);
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.brow, .bgh');
  const nodes = [];
  const keep = new Set();
  const changed = [];
  for (const g of groups) {
    const collapsed = UI.collapsed.has(g.key) && !UI.q;
    let h = GHEAD.get(g.key);
    if (!h) {
      h = document.createElement('button');
      h.type = 'button';
      h.className = 'bgh';
      h.dataset.g = g.key;
      h.addEventListener('click', () => { if (UI.collapsed.has(g.key)) UI.collapsed.delete(g.key); else UI.collapsed.add(g.key); renderBoard(); saveHash(); });
      GHEAD.set(g.key, h);
    }
    h.className = `bgh${g.bucket ? ` g-${g.bucket}` : ''}`;
    h.setAttribute('aria-expanded', String(!collapsed));
    const sub = g.bucket === 'turn' ? `oldest waits ${shortAgo(nowMs() - Math.min(...g.ms.map((m) => m.waitSince || m.updated)))}` : g.bucket === 'running' ? `${g.ms.reduce((n, m) => n + (m.job.running_agents || []).length, 0)} agent(s) on the floor` : g.bucket === 'done' && collapsed ? 'collapsed · click to show' : '';
    h.innerHTML = `<svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 3 L5 7 L8.5 3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg><span class="gl">${esc(g.label)}</span><span class="gn">${g.ms.length}</span><span class="gs">${esc(sub)}</span><span class="gr"></span>`;
    nodes.push(h);
    keep.add(`g:${g.key}`);
    if (collapsed) continue;
    for (const { m, depth } of g.rows) {
      const sig = `${m.rev}|${unreadOf(m)}|${depth}|${m.bucket}|${UI.cursor === m.id}`;
      let r = ROWS.get(m.id);
      if (!r) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'listitem');
        b.dataset.id = m.id;
        b.addEventListener('click', () => openJob(m.id, { user: true }));
        b.addEventListener('focus', () => { if (UI.cursor !== m.id) { UI.cursor = m.id; paintCursor(); if (UI.wireJob) renderWire(); } });
        r = { el: b, sig: '' };
        ROWS.set(m.id, r);
      }
      if (r.sig !== sig) {
        const wasRev = r.sig.split('|')[0];
        r.el.className = `brow b-${m.bucket}${depth ? ' d1' : ''}${UI.cursor === m.id ? ' cur' : ''}`;
        r.el.innerHTML = rowHtml(m, depth, win);
        r.el.setAttribute('aria-label', rowLabel(m));
        if (live && wasRev && wasRev !== m.rev) changed.push(r.el);
        r.sig = sig;
      }
      nodes.push(r.el);
      keep.add(m.id);
    }
  }
  for (const id of [...ROWS.keys()]) if (!keep.has(id)) ROWS.delete(id);
  for (const k of [...GHEAD.keys()]) if (!keep.has(`g:${k}`)) GHEAD.delete(k);
  host.replaceChildren(...nodes);
  if (focused && focused.isConnected) focused.focus({ preventScroll: true });
  for (const el2 of changed) { el2.classList.remove('sweep'); void el2.offsetWidth; el2.classList.add('sweep'); setTimeout(() => el2.classList.remove('sweep'), 1000); }
  if (animate) {
    for (const [id, top] of before) {
      const r = ROWS.get(id);
      if (!r || !r.el.isConnected) continue;
      const dy = top - r.el.getBoundingClientRect().top;
      if (Math.abs(dy) > 2) r.el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
  }
}
function paintCursor() {
  for (const [id, r] of ROWS) r.el.classList.toggle('cur', id === UI.cursor);
}
function boardEmpty(host) {
  ROWS.clear(); GHEAD.clear();
  host.innerHTML = !DATA
    ? `<div class="bempty"><h2>No factory data in this page</h2><p>This is the console's template. Run <code>factory console</code> in a repository that uses the factory: it writes <code>.factory/console.html</code> with every job. Or run <code>factory console --serve</code> to watch them live.</p><div class="reply"><code>factory console --serve</code><button type="button" class="copy" data-copy="factory console --serve">Copy</button></div><p>Meanwhile the recipe map shows the whole factory.</p><button type="button" class="tbtn" data-go="plan">Open the recipe map</button></div>`
    : `<div class="bempty"><h2>No jobs on the floor yet</h2><p>Start one in the Copilot CLI. ${LIVE.on ? 'It appears here as soon as the CLI writes it.' : 'Then run <code>factory console</code> again, or <code>factory console --serve</code> to watch it live.'}</p><div class="reply"><code>/factory:start &lt;what you want&gt;</code><button type="button" class="copy" data-copy="/factory:start ">Copy</button></div><button type="button" class="tbtn" data-go="plan">Open the recipe map</button></div>`;
  bindCopies(host);
  host.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.go)));
}
function bindCopies(root) {
  root.querySelectorAll('[data-copy]').forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = '1';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const txt = b.dataset.copy;
      const label0 = b.textContent;
      const done = () => { b.textContent = 'Copied'; b.classList.add('done'); setTimeout(() => { b.textContent = label0; b.classList.remove('done'); }, 1400); };
      const fallback = () => { const c = b.previousElementSibling; if (c) { const r = document.createRange(); r.selectNodeContents(c); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } b.textContent = 'Selected: press ⌘C'; };
      try { navigator.clipboard.writeText(txt).then(done, fallback); } catch (err) { fallback(); }
    });
  });
}

// ---------- KPI tiles and facet rail
