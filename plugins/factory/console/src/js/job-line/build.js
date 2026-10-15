function buildFlow(job) {
  const geo = geometry(job);
  LV.geo = geo;
  const { items, states, crew } = prepare(job);
  Object.assign(LV, { job, items, states, crew, shown: -2, sel: null, chipsSeen: new Set() });
  const { rows, rowOf } = buildRows(job, items);
  LV.rows = rows;
  LV.rowOf = rowOf;
  // crew band per stage (final size, so the layout never jumps during replay)
  const stageCrew = {};
  for (const st of geo.stages) {
    const roles = [...new Set(crew.filter((c) => st.steps.some((s) => s.id === c.step)).map((c) => c.role))];
    stageCrew[st.id] = roles;
  }
  const crewRows = Math.max(1, ...Object.values(stageCrew).map((r) => r.length));
  const CREW_TOP = 10;
  const crewH = CREW_TOP + crewRows * (FG.CHIP_H + 4) + 14;
  let y = crewH + 12;
  for (const r of rows) {
    Object.assign(r, measureRow(job, r, geo));
    r.top = y;
    r.ny = y + FG.NODE_Y;
    y += r.h;
  }
  const H = y + FG.BOTTOM;
  const W = geo.width;
  LV.crewH = crewH;

  const host = $('#street');
  host.innerHTML = '';
  // sticky header: stage plates, step lanes and their signals
  const head = sv('svg', { width: W, height: FG.HEAD_H, class: 'st-street flowhead', role: 'group', 'aria-label': 'Stages and steps' });
  host.appendChild(head);
  sv('rect', { class: 'headbg', x: 0, y: 0, width: W, height: FG.HEAD_H }, head);
  const defs = sv('defs', {}, head);
  defs.innerHTML = `<symbol id="g-hand" viewBox="0 0 10 10" width="10" height="9"><path d="M2.2 4.2V1.6a.8.8 0 0 1 1.6 0V4h.4V.9a.8.8 0 0 1 1.6 0V4h.4V1.4a.8.8 0 0 1 1.6 0V5h.3V3.1a.8.8 0 0 1 1.5 0v3.2C9.6 8.4 8.2 10 6.2 10H5.4C3.9 10 2.9 9.2 2.4 8L1 5.6a.8.8 0 0 1 1.2-.9z"/></symbol>
    <symbol id="g-walk" viewBox="0 0 10 10" width="10" height="9"><circle cx="5.6" cy="1.3" r="1.3"/><path d="M4.3 3.2h2.2l1.4 2.4-.9.5-1-1.6-.5 2.1 1.6 1.7V10H6V8.6L4.6 7.2 4 10H2.9l1-5.2-1 .7V7H1.9V5z"/></symbol>`;
  sv('text', { class: 'colhead', x: 12, y: 22 }, head).textContent = 'TIME';
  LV.stageBar = {};
  LV.stepSig = {};
  geo.stages.forEach((st, i) => {
    const num = String(i + 1).padStart(2, '0');
    const g = sv('g', {}, head);
    sv('rect', { class: 'signpost', x: st.x + 2, y: 8, width: st.w - 4, height: 22, rx: 3 }, g);
    const full = `${num} ${STAGE_NAME[st.id].toUpperCase()}`;
    sv('text', { class: 'signtext', x: st.x + 9, y: 23.5 }, g).textContent = fit(full, '800 12px Overpass, "Arial Narrow", sans-serif', st.w - 16);
    el('title', {}, g).textContent = `Stage ${num}: ${STAGE_NAME[st.id]}`;
    LV.stageBar[st.id] = sv('rect', { class: 'stagebar', x: st.x + 2, y: 32, width: st.w - 4, height: 3, rx: 1.5 }, g);
    for (const s of st.steps) {
      const cx = geo.col[s.id];
      const sg = sv('g', { class: 'stephead', tabindex: 0, role: 'button', 'data-step': s.id }, head);
      sv('text', { class: 'steplabel', x: cx, y: 49, 'text-anchor': 'middle' }, sg).textContent = fit((s.id === 'request' ? 'REQUEST' : stepName(s.id).replace(/ · .*/, '')).toUpperCase(), '600 9.5px "IBM Plex Mono", monospace', FG.STEP_W - 6);
      LV.stepSig[s.id] = (s.human || s.kind === 'gate') ? signal(sg, 'ped', cx - 10, 52 - 2, 'Your gate') : signal(sg, 'mini', cx - 13, 55);
      el('title', {}, sg).textContent = `${stepName(s.id)}: ${(STEP_INFO[s.id] || [, ''])[1]}`;
      sg.addEventListener('click', () => selectStep(s.id));
      sg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectStep(s.id); } });
    }
  });
  if (geo.insp) {
    sv('rect', { class: 'signpost insp', x: geo.inspX, y: 8, width: FG.INSP_W, height: 22, rx: 3 }, head);
    sv('text', { class: 'signtext', x: geo.inspX + 9, y: 23.5 }, head).textContent = 'INSPECTOR';
    sv('text', { class: 'steplabel', x: geo.inspX + 4, y: 49 }, head).textContent = 'FINDINGS · ANCHORED TO WHERE THEY HAPPENED';
  }

  // body
  const svg = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'st-street flowbody', role: 'group', 'aria-label': `Flow of ${job.id}` });
  host.appendChild(svg);
  const bdefs = sv('defs', {}, svg);
  bdefs.innerHTML = '<marker id="fl-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--live)"/></marker><marker id="fl-back" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--stop)"/></marker>';
  // stage bands and step lanes
  const bands = sv('g', {}, svg);
  geo.stages.forEach((st, i) => {
    sv('rect', { class: `band${i % 2 ? ' alt' : ''}`, x: st.x, y: 0, width: st.w, height: H }, bands);
    for (const s of st.steps) sv('line', { class: 'lane', x1: geo.col[s.id], x2: geo.col[s.id], y1: crewH, y2: H }, bands);
  });
  if (geo.insp) sv('rect', { class: 'band insp', x: geo.inspX - 6, y: 0, width: FG.INSP_W + 12, height: H }, bands);
  sv('line', { class: 'crewrule', x1: FG.TIME_W, x2: geo.gridRight, y1: crewH, y2: crewH }, bands);
  sv('text', { class: 'colhead', x: 12, y: 24 }, bands).textContent = 'CREW';
  sv('text', { class: 'colsub', x: 12, y: 38 }, bands).textContent = 'by stage';
  LV.crewG = sv('g', {}, svg);
  LV.stageCrew = stageCrew;

  // time column: clock per row, day breaks, long waits
  const timeG = sv('g', {}, svg);
  let lastDay = '';
  rows.forEach((r, k) => {
    const t = new Date(items[r.first].t);
    const day = t.toDateString();
    const g = sv('g', { class: 'trow', 'data-r': k }, timeG);
    if (day !== lastDay) {
      sv('line', { class: 'dayline', x1: 6, x2: geo.gridRight, y1: r.top - 4, y2: r.top - 4 }, g);
      sv('text', { class: 'daylabel', x: 10, y: r.top - 8 }, g).textContent = t.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      lastDay = day;
    }
    sv('text', { class: 'tclock', x: FG.TIME_W - 8, y: r.ny + 4, 'text-anchor': 'end' }, g).textContent = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (k > 0) {
      const gap = Date.parse(items[r.first].t) - Date.parse(items[rows[k - 1].first].t);
      if (gap > 30 * 60000) sv('text', { class: 'gap', x: FG.TIME_W - 8, y: r.ny + 17, 'text-anchor': 'end' }, g).textContent = `+${fmtDur(gap)}`;
    }
  });

  // the route between rows
  LV.trailG = sv('g', {}, svg);
  LV.segs = rows.map((r, k) => {
    if (k === 0) return null;
    const p = rows[k - 1];
    const xa = p.x;
    const ya = p.ny + 8;
    const xb = r.x;
    const yb = r.ny - 8;
    const ty = r.top - 10;
    const pts = xa === xb ? [[xa, ya], [xb, yb]] : [[xa, ya], [xa, ty], [xb, ty], [xb, yb]];
    const kind = r.kind === 'stop' && r.back ? 'back' : r.kind === 'halt' ? 'halt' : r.kind === 'park' || r.kind === 'resume' ? 'park' : r.kind === 'amend' ? 'amendl' : 'fwd';
    const g = sv('g', { class: `seg ${kind}` }, LV.trailG);
    sv('path', { class: 'ghost', d: roundPath(pts) }, g);
    const path = sv('path', { class: 'line', d: roundPath(pts), 'marker-end': kind === 'back' ? 'url(#fl-back)' : 'url(#fl-arr)' }, g);
    let label = null;
    if (kind === 'back' || kind === 'amendl') {
      const denied = rows[k - 1].items.map((q) => LV.items[q]).find((q) => q.type === 'human' && q.action === 'deny');
      const txt = kind === 'amendl' ? '↩ amendment: back to the contract' : denied ? `↩ back · you denied ${denied.gate || stepName(denied.step)}` : `↩ ${r.fixRound ? `${/^row5/.test(r.rule) ? 'verify-fix' : 'fix'} round ${r.fixRound}` : /^row6/.test(r.rule) ? 'prove again' : 'back'} · ${(RULES[r.rule] || r.rule || '').split(':')[0].toLowerCase()}`;
      const lx = (xa + xb) / 2;
      const w = textW(txt, '600 10.5px "IBM Plex Mono", monospace') + 12;
      label = sv('g', { class: `seglabel ${kind}` }, g);
      sv('rect', { x: lx - w / 2, y: ty - 9, width: w, height: 17, rx: 3 }, label);
      sv('text', { x: lx, y: ty + 3.5, 'text-anchor': 'middle' }, label).textContent = txt;
    }
    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len}`;
    return { g, path, len, label };
  });

  // rows
  const rowsG = sv('g', {}, svg);
  LV.rowEls = rows.map((r, k) => {
    const g = sv('g', { class: `frow k-${r.kind}`, 'data-r': k }, rowsG);
    const hl = sv('rect', { class: 'rowhl', x: FG.TIME_W - 2, y: r.top - 2, width: geo.gridRight - FG.TIME_W + 2, height: r.h - FG.TRANSIT + 4, rx: 4 }, g);
    const def = job.steps.find((s) => s.id === r.step);
    const gate = def && (def.human || def.kind === 'gate');
    const node = sv('g', { class: 'fnode', transform: `translate(${r.x},${r.ny})`, tabindex: 0, role: 'button', 'aria-label': `${r.title} at ${fmtClock(items[r.first].t)}` }, g);
    sv('circle', { class: 'pulse', r: 13 }, node);
    if (r.kind === 'halt') { sv('rect', { class: 'nshape', x: -8, y: -8, width: 16, height: 16, rx: 3 }, node); sv('path', { class: 'nglyph', d: 'M-4,-4 L4,4 M4,-4 L-4,4' }, node); }
    else if (r.kind === 'finish') { sv('circle', { class: 'nshape', r: 9 }, node); sv('path', { class: 'nglyph', d: 'M-4,0 L-1,3 L4,-3' }, node); }
    else if (r.kind === 'park') { sv('circle', { class: 'nshape', r: 8 }, node); sv('path', { class: 'nglyph', d: 'M-2.5,-4 V4 M2.5,-4 V4' }, node); }
    else if (r.kind === 'amend') { sv('path', { class: 'nshape', d: 'M0,-10 L10,0 L0,10 L-10,0 Z' }, node); sv('text', { class: 'nletter', y: 3.6, 'text-anchor': 'middle' }, node).textContent = 'A'; }
    else if (gate) sv('path', { class: 'nshape', d: 'M0,-9 L9,0 L0,9 L-9,0 Z' }, node);
    else sv('circle', { class: 'nshape', r: 7 }, node);
    node.addEventListener('click', () => seekItem(r.items[r.items.length - 1]));
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); seekItem(r.items[r.items.length - 1]); } });
    // label block
    const lx = r.left ? r.x - 18 : r.x + 18;
    const anchor = r.left ? 'end' : 'start';
    const tg = sv('text', { class: 'rtitle', x: lx, y: r.ny + 5, 'text-anchor': anchor }, g);
    tg.textContent = r.title;
    let tagX = lx + (r.left ? -1 : 1) * (textW(r.title, TITLE_FONT) + 8);
    for (const tag of r.tags) {
      const w = textW(tag.toUpperCase(), '600 9.5px "IBM Plex Mono", monospace') + 10;
      const x0 = r.left ? tagX - w : tagX;
      const tgg = sv('g', { class: `rtag${/round|back|again|prove/.test(tag) ? ' hot' : ''}` }, g);
      sv('rect', { x: x0, y: r.ny - 7, width: w, height: 15, rx: 2 }, tgg);
      sv('text', { x: x0 + 5, y: r.ny + 4 }, tgg).textContent = tag.toUpperCase();
      tagX += (r.left ? -1 : 1) * (w + 4);
    }
    const lines = [];
    for (const ln of r.laid) {
      const lg = sv('g', { class: `rline ${ln.cls || ''}`, 'data-i': ln.i }, g);
      if (ln.kind === 'text') {
        ln.wrapped.forEach((txt, q) => { sv('text', { x: lx, y: r.top + ln.y + 12 + q * FG.LINE_H, 'text-anchor': anchor }, lg).textContent = txt; });
        if (ln.job) { lg.classList.add('linkable'); lg.addEventListener('click', () => openJob(ln.job, true)); el('title', {}, lg).textContent = `Open ${ln.job}`; }
      } else {
        const total = Math.max(...ln.chips.map((c) => c.dx + c.w));
        for (const c of ln.chips) {
          const x0 = r.left ? lx - total + c.dx : lx + c.dx;
          drawChip(lg, x0, r.top + c.y, c);
        }
      }
      lines.push({ el: lg, i: ln.i });
    }
    return { g, node, hl, lines };
  });

  // inspector findings, anchored to the row they cite
  LV.inspEls = [];
  if (geo.insp) {
    const ig = sv('g', {}, svg);
    let floor = 0;
    const anchored = job.inspector.map((f) => {
      let k = f.anchor_decision ? items.findIndex((it) => it.type === 'route' && it.id === f.anchor_decision) : -1;
      if (k < 0 && f.anchor_t) { const at = Date.parse(f.anchor_t); for (let q = 0; q < items.length; q++) if (Date.parse(items[q].t) <= at + 1000) k = q; }
      if (k < 0) k = items.length - 1;
      return { f, k, row: rowOf[k] };
    }).sort((a, b) => a.row - b.row);
    for (const { f, k, row } of anchored) {
      const r = rows[row];
      const lines = wrap(f.summary, '400 11.5px "IBM Plex Sans", system-ui, sans-serif', FG.INSP_W - 22).slice(0, 4);
      const h = 34 + lines.length * 14 + 8;
      const y0 = Math.max(r.ny - 12, floor);
      floor = y0 + h + 8;
      const g = sv('g', { class: `icard sev-${f.severity} st-${f.status}`, 'data-i': k }, ig);
      sv('path', { class: 'iconn', d: `M${r.x + 12},${r.ny} H${geo.inspX - 10} L${geo.inspX},${y0 + 14}` }, g);
      sv('rect', { class: 'ibox', x: geo.inspX, y: y0, width: FG.INSP_W, height: h, rx: 4 }, g);
      sv('rect', { class: 'ibar', x: geo.inspX, y: y0, width: 4, height: h, rx: 2 }, g);
      sv('text', { class: 'ihead', x: geo.inspX + 12, y: y0 + 16 }, g).textContent = `⚑ ${f.id} · ${f.severity} · ${f.class}`;
      sv('text', { class: 'irule', x: geo.inspX + FG.INSP_W - 8, y: y0 + 16, 'text-anchor': 'end' }, g).textContent = f.status;
      lines.forEach((l, q) => { sv('text', { class: 'itext', x: geo.inspX + 12, y: y0 + 34 + q * 14 }, g).textContent = l; });
      sv('text', { class: 'irule', x: geo.inspX + 12, y: y0 + h - 6 }, g).textContent = fit(f.rule, '500 9.5px "IBM Plex Mono", monospace', FG.INSP_W - 24);
      el('title', {}, g).textContent = `${f.id}: ${f.summary}\n${f.question}`;
      LV.inspEls.push({ g, k });
    }
  }

  // the job's puck
  const puck = sv('g', { class: 'puck' }, svg);
  sv('circle', { class: 'halo', r: 15 }, puck);
  sv('circle', { class: 'core', r: 6 }, puck);
  const plate = sv('g', { class: 'plate' }, svg);
  const pw = textW(job.id, '600 10px "IBM Plex Mono", monospace') + 12;
  sv('rect', { x: -pw / 2, y: -31, width: pw, height: 15, rx: 2 }, plate);
  sv('text', { x: 0, y: -20.5, 'text-anchor': 'middle' }, plate).textContent = job.id;
  LV.puck = puck;
  LV.plate = plate;
  buildSchedule();
  buildScrubber();
  buildLog();
  applyZoom();
}

function drawChip(parent, x, y, c, maxW) {
  const ro = AGENTS[c.role] && !AGENTS[c.role][3];
  const g = sv('g', { class: `achip${ro ? ' ro' : ''}${c.fails ? ' failed' : ''}` }, parent);
  sv('rect', { class: 'abox', x, y, width: c.w, height: FG.CHIP_H, rx: 10 }, g);
  let lx = x + 7;
  if (c.models.length) {
    const mg = sv('g', { class: `mdl ${modelFamily(c.models[0])}` }, g);
    sv('rect', { x: lx - 2, y: y + 3, width: 14, height: 14, rx: 3 }, mg);
    sv('text', { x: lx + 5, y: y + 13.4, 'text-anchor': 'middle' }, mg).textContent = modelLetter(c.models[0]);
    lx += 16;
  }
  const t = sv('text', { class: 'aname', x: lx, y: y + 14 }, g);
  t.textContent = maxW ? fit(c.role, CHIP_FONT, Math.max(20, x + maxW - lx - textW(c.suffix, CHIP_FONT) - 8)) : c.role;
  const s = sv('tspan', { class: c.fails ? 'afailt' : 'acount' }, t);
  s.textContent = c.suffix;
  el('title', {}, g).textContent = `factory:${c.role} · ${c.n} run(s)${c.models.length ? ` · ${c.models.join(' → ')}` : ' · session model'}${c.retries ? ` · ${c.retries} retry` : ''}${c.fails ? ` · ${c.fails} failed` : ''}${ro ? ' · read-only' : ' · can write'}`;
  return g;
}

// ---------- schedule: moves between rows and dwells, on one playhead
