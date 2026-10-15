function openJob(id, { user = false, item = null, tab = null, push = true } = {}) {
  const job = DATA && DATA.jobs && DATA.jobs.find((j) => j.id === id);
  if (!job) return;
  UI.cursor = id;
  setView('job', { push: false });
  if (tab) UI.jobTab = tab;
  stopPlay();
  // the Line tab must be laid out to measure the canvas
  $('#live-body').hidden = false;
  buildFlow(job);
  renderHead(job);
  renderBelow(job);
  $('#j-eyebrow').innerHTML = (() => { const m = MODELS.get(id); return m ? `<span class="rchip rk-${esc(String(job.risk || '').toLowerCase())}"><i></i><span>${esc(job.recipe)}</span></span><span class="state-word w-${m.sum[0]}">${esc(m.sum[1])}</span>` : ''; })();
  $('#street').scrollLeft = 0;
  renderAt(LV.END);
  markSeen(id);
  renderJList();
  setJobTab(UI.jobTab, { keep: true });
  if (item !== null && item !== undefined && UI.jobTab === 'line') seekItem(item);
  if (UI.wireJob || UI.wireOpen) renderWire();
  $('#jdetail').scrollTop = 0;
  if (push) saveHash();
  void user;
}
function stepJob(d) {
  const ids = VISIBLE.length ? VISIBLE : [...MODELS.keys()];
  if (!ids.length) return;
  if (UI.view === 'job') {
    const i = ids.indexOf(LV.job && LV.job.id);
    const n = ids[Math.max(0, Math.min(ids.length - 1, (i < 0 ? 0 : i + d)))];
    if (n && n !== (LV.job && LV.job.id)) openJob(n, { user: true, tab: UI.jobTab });
    return;
  }
  const flat = [...ROWS.keys()].filter((id) => ROWS.get(id).el.isConnected);
  const order = VISIBLE.filter((id) => flat.includes(id));
  if (!order.length) return;
  const i = order.indexOf(UI.cursor);
  const n = order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + d))];
  UI.cursor = n;
  paintCursor();
  const r = ROWS.get(n);
  if (r) { r.el.focus({ preventScroll: true }); r.el.scrollIntoView({ block: 'nearest' }); }
  if (UI.wireJob) renderWire();
  saveHash();
}
function nextWaiting() {
  const turn = [...MODELS.values()].filter((m) => m.bucket === 'turn').sort(urgencyCmp).map((m) => m.id);
  if (!turn.length) return;
  const cur = UI.view === 'job' && LV.job ? LV.job.id : UI.cursor;
  const i = turn.indexOf(cur);
  openJob(turn[(i + 1) % turn.length], { user: true, tab: 'story' });
}

// ---------- palette, query help, keys
