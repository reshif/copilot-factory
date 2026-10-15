const WIRE_CACHE = new Map(); // id → { rev, items }
const WIRE_SEEN = new Set();
let wireQueued = 0;
function wireGlyph(it) {
  switch (it.type) {
    case 'route': return it.action === 'parked' ? ['⏸', 'park'] : it.action === 'gate' || it.action === 'wait' ? ['◇', 'you'] : ['→', 'route'];
    case 'result': return it.ok ? ['✓', 'ok'] : it.outcome === 'ask' ? ['?', 'you'] : ['✕', 'bad'];
    case 'agents': return ['◆', 'agents'];
    case 'human': return it.action === 'deny' ? ['✋', 'bad'] : it.action === 'resume' ? ['▶', 'you'] : ['✓', 'you'];
    case 'guard': case 'refused': case 'stop_block': return ['⛔', 'bad'];
    case 'hook_error': return ['⚠', 'bad'];
    case 'unparsed': return ['?', 'you'];
    case 'park': return ['⏸', 'park'];
    case 'stopped': return ['■', 'bad'];
    case 'amend': return ['✎', 'amend'];
    case 'spawn': return ['⇢', 'route'];
    case 'created': return ['＋', 'you'];
    case 'error': return ['!', 'bad'];
    case 'finding': return ['⚑', 'insp'];
    default: return ['·', ''];
  }
}
function wireItems(job) {
  const rev = jobRev(job);
  const c = WIRE_CACHE.get(job.id);
  if (c && c.rev === rev) return c.items;
  const items = job.timeline.map((it, i) => {
    const [head, sub] = describe(it, job);
    return { key: `${job.id}|${i}|${it.t}|${it.type}`, job: job.id, i, t: Date.parse(it.t), it, head, sub };
  });
  for (const f of job.inspector || []) {
    const t = Date.parse(f.anchor_t || '') || Date.parse(job.updated_at);
    items.push({ key: `${job.id}|F|${f.id}`, job: job.id, i: null, t, it: { type: 'finding' }, head: `Inspector ${f.id} (${f.severity}): ${f.summary}`, sub: f.question, finding: f });
  }
  WIRE_CACHE.set(job.id, { rev, items });
  return items;
}
function wireAll() {
  const out = [];
  for (const job of (DATA && DATA.jobs) || []) out.push(...wireItems(job));
  // factory-wide: hook errors and unparsed replies outside any job, and the inspector's health findings
  ((DATA && DATA.factory_events) || []).forEach((e, k) => out.push({ key: `F|e|${k}|${e.t}`, job: null, i: null, t: Date.parse(e.t), it: { type: e.type }, head: e.text, sub: '' }));
  for (const f of (DATA && DATA.inspector && DATA.inspector.health) || []) out.push({ key: `F|h|${f.id}`, job: null, i: null, t: Date.parse(f.at || '') || Date.parse(DATA.generated_at), it: { type: 'finding' }, head: `Health ${f.id} (${f.severity}, ${f.status}): ${f.summary}`, sub: f.question, finding: f });
  return out.sort((a, b) => b.t - a.t || (b.i || 0) - (a.i || 0));
}
function wireFocusJob() { return UI.view === 'job' && LV.job ? LV.job.id : UI.cursor; }
function renderWire({ live = false } = {}) {
  const wire = $('#wire');
  wire.classList.toggle('paused', UI.wirePaused);
  wire.classList.toggle('static', !LIVE.on);
  $('#w-pause').setAttribute('aria-pressed', String(UI.wirePaused));
  $('#w-pause').textContent = UI.wirePaused ? 'Paused' : 'Pause';
  $('#w-job').setAttribute('aria-pressed', String(UI.wireJob));
  let items = wireAll();
  const fj = wireFocusJob();
  $('#w-job').textContent = UI.wireHealth ? 'Health only' : UI.wireJob && fj ? `Only ${fj}` : 'This job';
  if (UI.wireHealth) items = items.filter((x) => !x.job || x.it.type === 'hook_error' || x.it.type === 'stop_block' || x.it.type === 'unparsed');
  else if (UI.wireJob && fj) items = items.filter((x) => x.job === fj);
  if (live && UI.wirePaused) {
    wireQueued = items.filter((x) => !WIRE_SEEN.has(x.key)).length;
    const b = $('#w-new');
    b.hidden = !wireQueued;
    b.textContent = `${wireQueued} new event${wireQueued === 1 ? '' : 's'} · resume`;
    return;
  }
  $('#w-new').hidden = true;
  const firstPaint = !WIRE_SEEN.size;
  const html = [];
  let day = '';
  for (const x of items.slice(0, UI.wireLimit)) {
    const d = dayKey(x.t);
    if (d !== day) { html.push(`<li class="wday">${esc(d)}</li>`); day = d; }
    const [g, cls] = wireGlyph(x.it);
    const fresh = !firstPaint && live && !WIRE_SEEN.has(x.key);
    const m = MODELS.get(x.job);
    html.push(`<li><button type="button" class="witem w-${cls}${fresh ? ' fresh' : ''}" data-j="${esc(x.job)}" data-i="${x.i === null ? '' : x.i}" title="${esc(x.sub || '')}"><span class="wt">${esc(fmtClock(new Date(x.t).toISOString()).slice(0, 5))}</span><span class="wg" aria-hidden="true">${g}</span><span class="wb"><span class="wh">${esc(x.head)}</span><span class="wj">${x.job ? `<b>${esc(x.job)}</b> · ${esc(m ? m.job.title : '')}` : '<b>factory</b> · health'}</span></span></button></li>`);
  }
  for (const x of items) WIRE_SEEN.add(x.key);
  if (items.length > UI.wireLimit) html.push(`<li><button type="button" class="tbtn wmore" id="w-more">Show ${Math.min(200, items.length - UI.wireLimit)} more of ${items.length - UI.wireLimit}</button></li>`);
  if (!items.length) html.push(`<li class="wday" style="position:static">${DATA ? 'Nothing on the wire yet.' : 'No factory data in this page.'}</li>`);
  $('#wlist').innerHTML = html.join('');
  $('#wlist').querySelectorAll('.witem').forEach((b) => b.addEventListener('click', () => {
    if (!b.dataset.j) return;
    const i = b.dataset.i === '' ? null : +b.dataset.i;
    openJob(b.dataset.j, { user: true, item: i, tab: 'line' });
  }));
  const more = $('#w-more');
  if (more) more.addEventListener('click', () => { UI.wireLimit += 200; renderWire(); });
}

// ---------- line map: every job as a transit line on one time axis
