const LM = { k: 0, v0: 0, squeeze: true, rowH: 34, scale: null, rows: [], raf: 0, fitted: false, hov: null };
function lmScale(models) {
  const T = new Set();
  const now = Math.max(nowMs(), Date.parse((DATA && DATA.generated_at) || 0) || 0);
  for (const m of models) { T.add(m.created); for (const t of m.times) T.add(t); }
  T.add(now);
  const ts = [...T].filter((x) => x === x).sort((a, b) => a - b);
  const CAP = 25 * 60e3;
  const V = [0];
  const breaks = [];
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    const g2 = LM.squeeze ? Math.min(gap, CAP + Math.log1p(gap / CAP) * 4 * 60e3) : gap;
    V.push(V[i - 1] + g2);
    if (LM.squeeze && gap > CAP * 2) breaks.push({ v: V[i - 1] + g2 / 2, gap });
  }
  const find = (arr, x) => { let lo = 0; let hi = arr.length - 1; let r = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) { r = mid; lo = mid + 1; } else hi = mid - 1; } return r; };
  const toV = (t) => {
    const i = find(ts, t);
    if (i < 0) return V[0] - (ts[0] - t);
    if (i >= ts.length - 1) return V[V.length - 1] + (t - ts[ts.length - 1]);
    const span = ts[i + 1] - ts[i];
    return V[i] + (span ? ((t - ts[i]) / span) * (V[i + 1] - V[i]) : 0);
  };
  const fromV = (v) => {
    const i = find(V, v);
    if (i < 0) return ts[0] - (V[0] - v);
    if (i >= V.length - 1) return ts[ts.length - 1] + (v - V[V.length - 1]);
    const span = V[i + 1] - V[i];
    return ts[i] + (span ? ((v - V[i]) / span) * (ts[i + 1] - ts[i]) : 0);
  };
  return { toV, fromV, vmin: V[0], vmax: V[V.length - 1], breaks, now };
}
const LINE_COLOR = { turn: 'var(--signal)', running: 'var(--live)', parked: 'var(--skill)', stopped: 'var(--stop)', done: 'var(--track)' };
const TRACK = (stage) => Math.max(0, ORDER.indexOf(stage));
function lmWidth() { return Math.max(200, $('#lm-plot').clientWidth); }
function lmFit() {
  const s = LM.scale;
  if (!s) return;
  const w = lmWidth() - 36;
  const span = Math.max(60e3, s.vmax - s.vmin);
  LM.k = w / span;
  LM.v0 = s.vmin - 14 / LM.k;
  LM.fitted = true;
}
const lmX = (t) => (LM.scale.toV(t) - LM.v0) * LM.k;
function lmZoom(f, px) {
  const w = lmWidth();
  px = px === undefined ? w / 2 : px;
  const v = LM.v0 + px / LM.k;
  const s = LM.scale;
  const minK = (w - 36) / Math.max(60e3, s.vmax - s.vmin) / 1.5;
  LM.k = Math.max(minK, Math.min(w / (5 * 60e3), LM.k * f));
  LM.v0 = v - px / LM.k;
  lmPaint();
}
function renderLines() {
  if (UI.view !== 'lines') return;
  computeGroups();
  const ms = VISIBLE.map((id) => MODELS.get(id)).filter(Boolean);
  LM.rows = ms;
  LM.scale = lmScale(ms.length ? ms : [...MODELS.values()]);
  if (!LM.fitted) lmFit();
  $('#lmcount').textContent = `${ms.length} line${ms.length === 1 ? '' : 's'} · ${LM.squeeze ? 'quiet hours squeezed' : 'linear time'} · drag to pan, ctrl + scroll to zoom`;
  $('#lm-sizer').style.height = `${ms.length * LM.rowH}px`;
  $('#lm-sq').setAttribute('aria-pressed', String(LM.squeeze));
  $('#lm-lin').setAttribute('aria-pressed', String(!LM.squeeze));
  lmPaint();
}
function lmStations(m) {
  // stations, waits, parks and the end of the line, from the job's own timeline
  const j = m.job;
  const tl = j.timeline;
  const st = [];
  let track = 0;
  st.push({ t: m.created, track: 0, kind: 'start', i: 0, step: 'request' });
  const waits = [];
  const parks = [];
  let openWait = null;
  let openPark = null;
  tl.forEach((it, i) => {
    const t = Date.parse(it.t);
    if (it.type === 'route' && it.step) {
      const def = j.steps.find((s) => s.id === it.step);
      const nt = TRACK((def && def.stage) || it.stage || 'build');
      const back = j.steps.findIndex((s) => s.id === it.step) < j.steps.findIndex((s) => s.id === (st[st.length - 1].step || 'request'));
      if (openWait) { openWait.t1 = t; openWait = null; }
      const gate = Boolean(def && (def.human || def.kind === 'gate'));
      st.push({ t, track: nt, kind: gate ? 'gate' : 'stop', i, step: it.step, back, rule: it.rule });
      if (gate || it.action === 'gate' || it.action === 'wait') { openWait = { t0: t, t1: null, track: nt }; waits.push(openWait); }
      track = nt;
    } else if (it.type === 'human') {
      if (openWait && ['approve', 'deny', 'merged'].includes(it.action)) { openWait.t1 = t; openWait = null; }
      if (it.action === 'resume' && openPark) { openPark.t1 = t; openPark = null; }
    } else if (it.type === 'result' && !it.ok && it.step) {
      const last = st[st.length - 1];
      if (last && last.step === it.step) last.bad = true;
      if (it.outcome === 'ask' && !openWait) { openWait = { t0: t, t1: null, track }; waits.push(openWait); }
    } else if (it.type === 'park') {
      openPark = { t0: t, t1: null, track, i };
      parks.push(openPark);
    } else if (it.type === 'spawn') st.push({ t, track, kind: 'spawn', i, job: it.job, step: st[st.length - 1].step });
  });
  const end = m.bucket === 'done' ? (m.closed || m.updated) : (m.job.status === 'cancelled' || m.job.status === 'abandoned') ? Math.max(m.updated, st[st.length - 1].t) : LM.scale.now;
  return { st, waits, parks, end, track };
}
function lmPaint() {
  cancelAnimationFrame(LM.raf);
  LM.raf = requestAnimationFrame(lmPaintNow);
}
function lmPaintNow() {
  const s = LM.scale;
  if (!s || UI.view !== 'lines') return;
  const W = lmWidth();
  const rowH = LM.rowH;
  const scroller = $('#lm-scroll');
  const top = scroller.scrollTop;
  const vh = scroller.clientHeight || 600;
  const a = Math.max(0, Math.floor(top / rowH) - 6);
  const b = Math.min(LM.rows.length, Math.ceil((top + vh) / rowH) + 6);
  // labels (only those in view)
  $('#lm-labels').innerHTML = LM.rows.slice(a, b).map((m, q) => `<button type="button" class="lml b-${m.bucket}${LM.hov === m.id ? ' hov' : ''}" style="top:${(a + q) * rowH}px" data-id="${esc(m.id)}" aria-label="${esc(rowLabel(m))}"><i class="beacon"></i><span class="bid">${esc(m.id)}</span><span class="bti">${esc(m.job.title)}</span></button>`).join('');
  const svg = $('#lm-svg');
  svg.setAttribute('width', W);
  svg.setAttribute('height', Math.max(1, (b - a) * rowH));
  svg.style.top = `${a * rowH}px`;
  const out = [];
  const pos = new Map();
  const X = (t) => lmX(t);
  const yOf = (r, track) => (r - a) * rowH + 5 + track * 3.45;
  for (let r = a; r < b; r++) {
    const m = LM.rows[r];
    const y0 = (r - a) * rowH;
    out.push(`<rect class="rowbg${r % 2 ? ' alt' : ''}${LM.hov === m.id ? ' hov' : ''}" x="0" y="${y0}" width="${W}" height="${rowH}"/>`);
    const L = lmStations(m);
    pos.set(m.id, { r, L });
    const lc = LINE_COLOR[m.bucket];
    const g = [`<g style="--lc:${lc}">`];
    // the line: horizontal at each stage's track, 45° bends into the next station
    let d = '';
    const backs = [];
    L.st.forEach((p, q) => {
      const x = X(p.t);
      const y = yOf(r, p.track);
      if (!q) { d = `M${x.toFixed(1)},${y.toFixed(1)}`; return; }
      const prev = L.st[q - 1];
      const py = yOf(r, prev.track);
      const dy = Math.abs(y - py);
      const px = X(prev.t);
      const bx = Math.max(px, x - dy);
      const seg = `M${px.toFixed(1)},${py.toFixed(1)} L${bx.toFixed(1)},${py.toFixed(1)} L${x.toFixed(1)},${y.toFixed(1)}`;
      if (p.back) backs.push({ seg, x, y, px, py });
      d += ` L${bx.toFixed(1)},${py.toFixed(1)} L${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const last = L.st[L.st.length - 1];
    const ex = X(L.end);
    const ey = yOf(r, last.track);
    d += ` L${Math.max(ex, X(last.t)).toFixed(1)},${ey.toFixed(1)}`;
    g.push(`<path class="ln" d="${d}"/>`);
    for (const bk of backs) {
      g.push(`<path class="ln rtn" d="${bk.seg}"/>`);
      const lx = Math.min(bk.x, bk.px + 4);
      g.push(`<path class="loop" d="M${(bk.x - 1).toFixed(1)},${(bk.y - 4).toFixed(1)} C${(bk.x - 2).toFixed(1)},${(y0 + 1).toFixed(1)} ${(lx - 10).toFixed(1)},${(y0 + 1).toFixed(1)} ${(lx - 9).toFixed(1)},${(bk.py - 3).toFixed(1)}"/>`);
    }
    for (const w of L.waits) {
      const x0 = X(w.t0);
      const x1 = X(w.t1 === null ? L.end : w.t1);
      if (x1 - x0 < 3) continue;
      const yy = yOf(r, w.track);
      g.push(`<path class="ln erase" d="M${(x0 + 5).toFixed(1)},${yy.toFixed(1)} H${(x1 - 4).toFixed(1)}"/><path class="ln wait" d="M${(x0 + 5).toFixed(1)},${yy.toFixed(1)} H${(x1 - 4).toFixed(1)}"/>`);
    }
    for (const p of L.parks) {
      const x0 = X(p.t0);
      const x1 = X(p.t1 === null ? L.end : p.t1);
      const yy = yOf(r, p.track);
      if (x1 - x0 > 6) g.push(`<path class="ln erase" d="M${(x0 + 4).toFixed(1)},${yy.toFixed(1)} H${(x1 - 3).toFixed(1)}"/><path class="ln parkd" d="M${(x0 + 4).toFixed(1)},${yy.toFixed(1)} H${(x1 - 3).toFixed(1)}"/>`);
      g.push(`<text class="pk" x="${(x0 - 3).toFixed(1)}" y="${(yy - 5).toFixed(1)}">⏸</text>`);
    }
    // stations
    L.st.forEach((p) => {
      const x = X(p.t);
      const y = yOf(r, p.track);
      if (x < -20 || x > W + 20) return;
      const attrs = `data-j="${esc(m.id)}" data-i="${p.i}"`;
      if (p.kind === 'gate') g.push(`<circle class="gate1" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" ${attrs}/><circle class="gate2" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2"/>`);
      else if (p.kind === 'spawn') g.push(`<circle class="stn" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" ${attrs}/>`);
      else g.push(`<circle class="stn${p.bad ? ' bad' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${p.kind === 'start' ? 3.6 : 3}" ${attrs}/>`);
    });
    // end of the line
    if (m.bucket === 'done') g.push(`<circle class="term" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="5.5"/><circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="2" style="fill:var(--paper)"/>`);
    else if (m.job.status === 'cancelled' || m.job.status === 'abandoned') g.push(`<path class="buf" d="M${(ex + 3).toFixed(1)},${(ey - 6).toFixed(1)} V${(ey + 6).toFixed(1)}"/><path class="buf" d="M${(ex + 7).toFixed(1)},${(ey - 3).toFixed(1)} V${(ey + 3).toFixed(1)}" style="stroke-width:1.6"/>`);
    else {
      g.push(`<circle class="head2" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.6"/>`);
      if (m.bucket === 'running' || m.bucket === 'turn') g.push(`<circle class="headp" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="7"/>`);
    }
    g.push('</g>');
    out.push(g.join(''));
  }
  // transfers to follow-ups, when both lines are in view
  for (const [, { r, L }] of pos) for (const p of L.st.filter((x) => x.kind === 'spawn')) {
    const to = pos.get(p.job);
    if (!to) continue;
    const x0 = X(p.t);
    const y0 = yOf(r, p.track);
    const f = MODELS.get(p.job);
    const x1 = X(f.created);
    const y1 = yOf(to.r, 0);
    out.push(`<path class="xfer" d="M${x0.toFixed(1)},${y0.toFixed(1)} C${x0.toFixed(1)},${((y0 + y1) / 2).toFixed(1)} ${x1.toFixed(1)},${((y0 + y1) / 2).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}"/>`);
  }
  const nx = X(s.now);
  out.push(`<line class="nowl" x1="${nx.toFixed(1)}" x2="${nx.toFixed(1)}" y1="0" y2="${(b - a) * rowH}"/>`);
  svg.innerHTML = out.join('');
  lmAxis(W);
  $('#lm-labels').querySelectorAll('.lml').forEach((btn) => btn.addEventListener('click', () => openJob(btn.dataset.id, { user: true })));
}
function lmAxis(W) {
  const s = LM.scale;
  const ax = $('#lm-axis');
  const out = [];
  const step = W < 500 ? 96 : 140;
  let lastDay = '';
  const nx = (s.toV(s.now) - LM.v0) * LM.k;
  const placed = [[nx - 22, nx + 22]]; // the top row: day names, gap sizes and NOW never overlap
  const label = (x, txt, cls) => { const w = txt.length * 6.2 + 6; if (placed.some(([a, b]) => x < b + 4 && x + w > a - 4)) return; out.push(`<text x="${x.toFixed(1)}" y="13"${cls ? ` class="${cls}"` : ''}>${esc(txt)}</text>`); placed.push([x, x + w]); };
  const marks = [];
  for (const bk of s.breaks) {
    const x = (bk.v - LM.v0) * LM.k;
    if (x < 6 || x > W - 6 || bk.gap < 3600e3) continue;
    marks.push({ x, bk });
  }
  for (let x = 24; x < W - 30; x += step) {
    const t = s.fromV(LM.v0 + x / LM.k);
    const d = new Date(t);
    const day = d.toDateString();
    out.push(`<line class="tk" x1="${x}" x2="${x}" y1="22" y2="34"/><text x="${x + 4}" y="30">${esc(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))}</text>`);
    if (day !== lastDay) label(x + 4, d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }), 'day');
    lastDay = day;
  }
  for (const { x, bk } of marks) {
    if (Math.abs(((x - 24) % step + step) % step) < 8 || Math.abs(((x - 24) % step + step) % step - step) < 8) continue;
    out.push(`<path class="brk" d="M${(x - 5).toFixed(1)},21 l2.5,-4 l2.5,4 l2.5,-4 l2.5,4"/>`);
    if (bk.gap > 2 * 3600e3) label(x - 4, `+${fmtDur(bk.gap).split(' ')[0]}`);
  }
  if (nx > 0 && nx < W) out.push(`<g class="nowt"><rect x="${nx - 18}" y="3" width="36" height="14" rx="3"/><text x="${nx}" y="13.5" text-anchor="middle">NOW</text></g>`);
  ax.innerHTML = out.join('');
}
function lmTip(e) {
  const t = e.target.closest && e.target.closest('[data-j][data-i]');
  const tip = $('#lm-tip');
  const plot = $('#lm-plot');
  if (!t) { tip.hidden = true; return; }
  const m = MODELS.get(t.dataset.j);
  if (!m) { tip.hidden = true; return; }
  const i = +t.dataset.i;
  const tl = m.job.timeline;
  const it = tl[i];
  const step = it.step || 'request';
  const parts = [`<div class="k2">${esc(m.id)} · ${esc(fmtDate(it.t))}</div><h4>${esc(stepName(step))}</h4>`];
  if (it.type === 'route') parts.push(`<p>${esc(RULES[it.rule] || it.rule || '')}${it.reason ? ` — ${esc(it.reason)}` : ''}</p>`);
  else if (it.type === 'created') parts.push(`<p>${esc(m.job.title)} → ${esc(m.job.recipe)}</p>`);
  else if (it.type === 'spawn') parts.push(`<p>${esc(it.text)}</p>`);
  const ags = [];
  let res = null;
  for (let k = i + 1; k < tl.length; k++) {
    const x = tl[k];
    if (x.type === 'route') break;
    if (x.type === 'agents') ags.push(...(x.agents || []));
    if (x.type === 'result') res = x;
  }
  if (ags.length) parts.push(`<div class="ag">${chipsFor(ags).map((c) => `<span class="pip ${modelFamily(c.models[0])}">${esc(modelLetter(c.models[0]))}</span><span class="nest">${esc(c.role)}${esc(c.suffix)}</span>`).join(' ')}</div>`);
  if (res) parts.push(`<p style="color:${res.ok ? 'var(--track)' : 'var(--stop)'}">${res.ok ? '✓' : '✕'} ${esc(res.text)}</p>`);
  tip.innerHTML = parts.join('');
  tip.hidden = false;
  const box = $('#lm').getBoundingClientRect();
  const r = t.getBoundingClientRect();
  let x = r.left - box.left + 14;
  if (x + 310 > box.width) x = r.left - box.left - 314;
  let y = r.top - box.top + 14;
  if (y + tip.offsetHeight > box.height - 6) y = r.top - box.top - tip.offsetHeight - 8;
  tip.style.left = `${Math.max(6, x)}px`;
  tip.style.top = `${Math.max(6, y)}px`;
  void plot;
}
function bindLines() {
  const plot = $('#lm-plot');
  const scroller = $('#lm-scroll');
  scroller.addEventListener('scroll', lmPaint, { passive: true });
  let drag = null;
  let moved = false;
  plot.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, v0: LM.v0 }; moved = false; });
  plot.addEventListener('pointermove', (e) => {
    if (drag) {
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) { moved = true; plot.classList.add('dragging'); if (!plot.hasPointerCapture(e.pointerId)) plot.setPointerCapture(e.pointerId); }
      if (moved) { LM.v0 = drag.v0 - dx / LM.k; $('#lm-tip').hidden = true; lmPaint(); }
      return;
    }
    lmTip(e);
    const t = e.target.closest && e.target.closest('[data-j]');
    const id = t ? t.dataset.j : null;
    if (id !== LM.hov) { LM.hov = id; lmPaint(); }
  });
  const end = () => { drag = null; plot.classList.remove('dragging'); };
  plot.addEventListener('pointerup', end);
  plot.addEventListener('pointercancel', end);
  plot.addEventListener('pointerleave', () => { $('#lm-tip').hidden = true; if (LM.hov) { LM.hov = null; lmPaint(); } });
  plot.addEventListener('click', (e) => {
    if (moved) return;
    const t = e.target.closest && e.target.closest('[data-j][data-i]');
    if (t) openJob(t.dataset.j, { user: true, item: +t.dataset.i, tab: 'line' });
  });
  plot.addEventListener('wheel', (e) => {
    const box = plot.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); lmZoom(Math.exp(-e.deltaY * 0.0025), e.clientX - box.left); return; }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { e.preventDefault(); LM.v0 += (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) / LM.k; lmPaint(); }
  }, { passive: false });
  $('#lm-in').addEventListener('click', () => lmZoom(1.4));
  $('#lm-out').addEventListener('click', () => lmZoom(1 / 1.4));
  $('#lm-fit').addEventListener('click', () => { lmFit(); lmPaint(); });
  $('#lm-sq').addEventListener('click', () => { LM.squeeze = true; LM.fitted = false; renderLines(); });
  $('#lm-lin').addEventListener('click', () => { LM.squeeze = false; LM.fitted = false; renderLines(); });
  scroller.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') { e.preventDefault(); lmZoom(1.4); }
    else if (e.key === '-') { e.preventDefault(); lmZoom(1 / 1.4); }
    else if (e.key === '0') { e.preventDefault(); lmFit(); lmPaint(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); LM.v0 += (e.key === 'ArrowLeft' ? -80 : 80) / LM.k; lmPaint(); }
  });
  window.addEventListener('resize', () => { if (UI.view === 'lines') { LM.fitted = false; renderLines(); } });
  const sw = (cls, extra = '') => `<svg width="34" height="10" aria-hidden="true"><path d="M2,5 H32" class="${cls}" style="fill:none;stroke-width:3;stroke-linecap:round;${extra}"/></svg>`;
  $('#lmlegend').innerHTML = [
    `<span>${sw('', 'stroke:var(--live)')}running</span>`,
    `<span>${sw('', 'stroke:var(--signal);stroke-dasharray:4 4')}waiting on you</span>`,
    `<span>${sw('', 'stroke:var(--skill);stroke-dasharray:1 5')}parked</span>`,
    `<span>${sw('', 'stroke:var(--stop)')}return trip</span>`,
    '<span><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5" style="fill:var(--paper);stroke:var(--signal);stroke-width:1.6"/><circle cx="7" cy="7" r="2.2" style="fill:none;stroke:var(--signal);stroke-width:1.4"/></svg>your gate</span>',
    '<span><svg width="14" height="14" aria-hidden="true"><path d="M5,1 V13 M10,4 V10" style="stroke:var(--stop);stroke-width:3"/></svg>cancelled · abandoned</span>',
    '<span><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" style="fill:var(--track)"/><circle cx="7" cy="7" r="2" style="fill:var(--paper)"/></svg>closed</span>',
    `<span>${sw('', 'stroke:var(--muted);stroke-dasharray:1 4;stroke-width:1.6')}follow-up</span>`,
    '<span class="mono">each line steps down one track per stage: request → learn</span>',
  ].join('');
}

// ---------- the job: narrow list, header tiles and the five tabs
