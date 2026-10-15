function ingest(next, { live = false } = {}) {
  const prev = new Map(((DATA && DATA.jobs) || []).map((j) => [j.id, j]));
  DATA = next;
  if (live) LIVE.lastAt = nowMs();
  const ids = new Set();
  for (const job of (DATA && DATA.jobs) || []) { ids.add(job.id); modelOf(job); }
  for (const id of [...MODELS.keys()]) if (!ids.has(id)) MODELS.delete(id);
  if (!UI.booted) return;
  if (live) {
    for (const job of DATA.jobs || []) {
      const was = prev.get(job.id);
      const g = job.pending_gate;
      if (g && (!was || !was.pending_gate || was.pending_gate.id !== g.id || was.pending_gate.at !== g.at)) {
        const m = MODELS.get(job.id);
        if (m && (m.bucket === 'turn' || g.id !== 'P')) toastGate(m);
      }
    }
  }
  paintFlags();
  renderCrew();
  refreshFloor({ live });
  renderWire({ live });
  updateBlueprint();
  if (UI.view === 'job' && LV.job) {
    const job = DATA.jobs.find((j) => j.id === LV.job.id);
    if (!job) { setView('board'); return; }
    const was = prev.get(job.id);
    if (!was || jobRev(was) !== jobRev(job)) refreshOpenJob(job);
  }
}
// The open job stays open; if you were watching its latest moment, the new steps play in;
// if you were scrubbing back, you keep your place.
function refreshOpenJob(job) {
  const host = $('#street');
  const scroll = [host.scrollLeft, host.scrollTop];
  const wasPlaying = LV.playing;
  const atEnd = LV.t >= LV.END - 1;
  const oldLen = LV.items.length;
  const t = LV.t;
  const onLine = UI.jobTab === 'line';
  stopPlay();
  $('#live-body').hidden = false;
  buildFlow(job);
  renderHead(job);
  renderBelow(job);
  host.scrollLeft = scroll[0];
  host.scrollTop = scroll[1];
  LV.shown = -2;
  if (onLine && atEnd && LV.items.length > oldLen && oldLen > 0 && !reduceMotion) {
    renderAt(LV.sched[oldLen - 1].t1);
    play();
  } else {
    renderAt(atEnd ? LV.END : Math.min(t, LV.END));
    if (wasPlaying && onLine) play();
  }
  $('#live-body').hidden = !onLine;
  markSeen(job.id);
  paintJobTab();
}

function bindShell() {
  document.querySelectorAll('.nav [data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  document.querySelectorAll('.nav [role="tab"]').forEach((b, i, all) => b.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = all[(i + d + all.length) % all.length];
    n.focus();
    setView(n.dataset.view);
  }));
  document.querySelectorAll('.jtabs [data-jt]').forEach((b) => b.addEventListener('click', () => setJobTab(b.dataset.jt)));
  document.querySelectorAll('.mtabs [data-mpane]').forEach((b) => b.addEventListener('click', () => {
    UI.mpane = b.dataset.mpane;
    $('#app').dataset.mpane = UI.mpane;
    document.querySelectorAll('.mtabs [data-mpane]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    if (UI.mpane === 'main' && UI.view === 'lines') renderLines();
  }));
  $('#q').addEventListener('input', onQuery);
  $('#q').addEventListener('focus', () => qHelp(!$('#q').value));
  $('#q').addEventListener('blur', () => qHelp(false));
  $('#q').addEventListener('input', () => qHelp(!$('#q').value));
  $('#groupby').addEventListener('change', (e) => { UI.group = e.target.value; store.set('fc-group', UI.group); for (const r of ROWS.values()) r.sig = ''; refreshFloor(); });
  $('#sortby').addEventListener('change', (e) => { UI.sort = e.target.value; store.set('fc-sort', UI.sort); refreshFloor(); });
  $('#w-pause').addEventListener('click', () => { UI.wirePaused = !UI.wirePaused; renderWire(); });
  $('#w-new').addEventListener('click', () => { UI.wirePaused = false; renderWire({ live: true }); });
  $('#w-job').addEventListener('click', () => { if (UI.wireHealth) { UI.wireHealth = false; paintFlags(); } else UI.wireJob = !UI.wireJob; renderWire(); });
  $('#j-wire').addEventListener('click', () => { UI.wireOpen = !UI.wireOpen; $('#j-wire').setAttribute('aria-pressed', String(UI.wireOpen)); $('#app').classList.toggle('wire-open', UI.wireOpen); renderWire(); applyZoom(); });
  $('#j-back').addEventListener('click', () => setView('board'));
  $('#j-prev').addEventListener('click', () => stepJob(-1));
  $('#j-next').addEventListener('click', () => stepJob(1));
  $('#b-theme').addEventListener('click', cycleTheme);
  $('#b-notify').addEventListener('click', toggleNotify);
  $('#b-keys').addEventListener('click', () => $('#keys').showModal());
  window.addEventListener('hashchange', () => { if (location.hash === hashWritten) return; applyHash(readHash()); });
  bindKeys();
  bindLines();
  paintTheme();
  paintNotify();
  setInterval(tickAgo, 30000);
}

// ===================================================================== header flags, live link
