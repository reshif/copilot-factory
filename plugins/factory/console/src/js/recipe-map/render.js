let selected = null;

function drawNode(g, n, active) {
  const ng = el('g', { class: `node ${n.type === 'agentnode' ? 'agentnode' : n.type}${active ? '' : ' dim'}${selected === n.id ? ' sel' : ''}`, tabindex: active ? 0 : -1, role: 'button', 'aria-label': `${n.title}${active ? '' : ' (not in this recipe)'}`, 'data-id': n.id }, g);
  if (n.type === 'gate') {
    el('rect', { class: 'box', x: n.x, y: n.y, width: n.w, height: n.h, rx: 4 }, ng);
    const cx = n.x + 22;
    const cy = n.y + n.h / 2;
    el('path', { class: 'diamond', d: `M${cx},${cy - 17} L${cx + 17},${cy} L${cx},${cy + 17} L${cx - 17},${cy} Z` }, ng);
    el('text', { class: 'type', x: n.x + 50, y: n.y + 16 }, ng).textContent = 'gate · you decide';
    n.lines.forEach((l, i) => { el('text', { class: 'title', x: n.x + 50, y: n.y + 33 + i * 17 }, ng).textContent = l; });
    return ng;
  }
  const rx = n.type === 'you' ? 16 : 4;
  el('rect', { class: 'box', x: n.x, y: n.y, width: n.w, height: n.h, rx }, ng);
  const typeLabel = { you: 'you', skill: 'skill', workflow: 'workflow', cli: 'factory cli', artifact: 'output', agentnode: 'agent' }[n.type];
  el('text', { class: 'type', x: n.x + 10, y: n.y + 17 }, ng).textContent = typeLabel;
  (n.titleLines || []).forEach((l, i) => { el('text', { class: 'title', x: n.x + 10, y: n.y + 34 + i * 17 }, ng).textContent = l; });
  (n.subLines || []).forEach((l, i) => { el('text', { class: 'sub', x: n.x + 10, y: n.y + 34 + n.titleLines.length * 17 + i * 15 }, ng).textContent = l; });
  if (n.type === 'workflow') drawGroups(ng, n);
  return ng;
}

function drawGroups(g, n) {
  const top = n.y + n.headH;
  let cx = n.x + 10;
  const cols = n.groups.map((grp, ci) => {
    const x0 = cx;
    cx += n.colWs[ci] + n.colGap;
    const total = grp.length * 28 - 6;
    const maxH = Math.max(...n.groups.map((gg) => gg.length)) * 28 - 6;
    const y0 = top + (maxH - total) / 2;
    return grp.map((p, i) => ({ p, x: x0, y: y0 + i * 28, w: n.colWs[ci], h: 22 }));
  });
  // buses between columns: fan-out and fan-in
  for (let c = 0; c < cols.length - 1; c++) {
    const a = cols[c];
    const b = cols[c + 1];
    const mx = a[0].x + a[0].w + n.colGap / 2;
    const ys = [...a, ...b].map((q) => q.y + q.h / 2);
    for (const q of a) el('path', { class: 'bus', d: `M${q.x + q.w},${q.y + 11} H${mx}` }, g);
    el('path', { class: 'bus', d: `M${mx},${Math.min(...ys)} V${Math.max(...ys)}` }, g);
    for (const q of b) el('path', { class: 'bus', d: `M${mx},${q.y + 11} H${q.x - 1}`, 'marker-end': 'url(#arr)' }, g);
  }
  for (const col of cols) {
    for (const q of col) {
      const ro = q.p.role && AGENTS[q.p.role] && !AGENTS[q.p.role][3];
      const pg = el('g', { class: `pill ${q.p.kind}${ro ? ' read' : ''}${pillActive(q.p) ? '' : ' off'}` }, g);
      el('rect', { x: q.x, y: q.y, width: q.w, height: q.h, rx: 11 }, pg);
      el('text', { x: q.x + 9, y: q.y + 15 }, pg).textContent = fit(q.p.label, FONT_P, q.w - 14);
      el('title', {}, pg).textContent = q.p.role ? `${q.p.label} — factory:${q.p.role}${ro ? ' · read-only' : ' · can write'}${pillActive(q.p) ? '' : ' · not in this recipe'}` : q.p.label;
    }
  }
}

function anchor(n, side) {
  if (side === 'top') return [n.x + n.w / 2, n.y];
  if (side === 'bottom') return [n.x + n.w / 2, n.y + n.h];
  if (side === 'left') return [n.x, n.y + n.h / 2];
  return [n.x + n.w, n.y + n.h / 2];
}

function label(g, x, y, text, kind) {
  const w = textW(text, FONT_P) + 10;
  el('rect', { class: 'elabel-bg', x: x - w / 2, y: y - 9, width: w, height: 16, rx: 2 }, g);
  el('text', { class: `elabel ${kind}`, x, y: y + 3, 'text-anchor': 'middle' }, g).textContent = text;
}

function render() {
  layout();
  const world = $('#world');
  world.innerHTML = '';
  const N = LAYOUT.nodes;
  const act = Object.fromEntries(Object.values(N).map((n) => [n.id, nodeActive(n)]));

  // router rail
  const rail = el('g', { class: 'rail' }, world);
  el('rect', { class: 'band', x: 24, y: 14, width: LAYOUT.width - 48, height: 70, rx: 6 }, rail);
  el('text', { class: 'rname', x: 42, y: 44 }, rail).textContent = 'Router · factory next';
  el('text', { class: 'rsub', x: 42, y: 66 }, rail).textContent = 'Chooses every step from the job\'s sealed state. The first failing check wins; otherwise the recipe\'s next step.';
  let tx = 42 + Math.max(textW('ROUTER · FACTORY NEXT', '800 20px "Big Shoulders Display", "Arial Narrow", "Roboto Condensed", sans-serif'), textW('Chooses every step from the job\'s sealed state. The first failing check wins; otherwise the recipe\'s next step.', '400 12px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif')) + 44;
  for (const t of ROUTER) {
    const w = textW(t, '500 11px "IBM Plex Mono", monospace') + 18;
    const tg = el('g', { class: 'tag' }, rail);
    el('rect', { x: tx, y: 36, width: w, height: 24, rx: 12 }, tg);
    el('text', { x: tx + 9, y: 52 }, tg).textContent = t;
    tx += w + 8;
  }

  // bays
  STAGES.forEach((st, si) => {
    const live = st.nodes.some((n) => act[n.id]);
    const zg = el('g', { class: `zone${live ? '' : ' dim'}`, 'data-stage': st.id }, world);
    el('line', { class: `wire${live ? '' : ' dim'}`, x1: st.x + st.w / 2, y1: 84, x2: st.x + st.w / 2, y2: st.y }, world);
    el('rect', { class: 'bay', x: st.x, y: st.y, width: st.w, height: st.h, rx: 6 }, zg);
    el('text', { class: 'num', x: st.x + PAD, y: st.y + 36 }, zg).textContent = String(si + 1).padStart(2, '0');
    el('text', { class: 'zname', x: st.x + PAD + 40, y: st.y + 33 }, zg).textContent = st.name;
    el('text', { class: 'zsub', x: st.x + PAD, y: st.y + 58 }, zg).textContent = st.sub;
    const hit = el('rect', { class: 'hit', x: st.x, y: st.y, width: st.w, height: 66, tabindex: 0, role: 'button', 'aria-label': `Stage ${st.name}` }, zg);
    hit.addEventListener('click', (e) => { e.stopPropagation(); showStage(st); });
    hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showStage(st); } });
    // hand-off chevron to the next bay
    if (si < STAGES.length - 1) {
      const nx = STAGES[si + 1].x;
      const y = st.y + 30;
      const nextLive = STAGES[si + 1].nodes.some((n) => act[n.id]);
      el('path', { class: `edge flow${live && nextLive ? '' : ' dim'}`, d: `M${st.x + st.w + 4},${y} H${nx - 6}`, 'marker-end': 'url(#arr-ink)' }, world);
    }
  });

  // edges inside bays
  const edgeG = el('g', {}, world);
  for (const st of STAGES) {
    const auto = new Set(st.noAuto || []);
    for (let i = 0; i < st.nodes.length - 1; i++) {
      const a = st.nodes[i];
      const b = st.nodes[i + 1];
      if (auto.has(`${a.id}>${b.id}`)) continue;
      const [x1, y1] = anchor(a, 'bottom');
      const [, y2] = anchor(b, 'top');
      const dim = !(act[a.id] && act[b.id]);
      el('path', { class: `edge${dim ? ' dim' : ''}`, d: `M${x1},${y1 + 2} V${y2 - 3}`, 'marker-end': 'url(#arr)' }, edgeG);
    }
    for (const [from, to, kind, text] of st.edges || []) {
      const a = N[from];
      const b = N[to];
      const dim = !(act[a.id] && act[b.id]);
      if (kind === 'human') {
        const [x1, y1] = anchor(a, 'bottom');
        const [, y2] = anchor(b, 'top');
        el('path', { class: `edge human${dim ? ' dim' : ''}`, d: `M${x1},${y1 + 2} V${y2 - 3}`, 'marker-end': 'url(#arr-human)' }, edgeG);
        label(edgeG, x1, (y1 + y2) / 2, text, 'human');
      } else if (kind === 'loopR') {
        const [x1, y1] = anchor(a, 'right');
        const [x2, y2] = anchor(b, 'right');
        const mx = st.x + st.w - 5;
        el('path', { class: `edge human${dim ? ' dim' : ''}`, d: `M${x1},${y1} H${mx} V${y2} H${x2 + 3}`, 'marker-end': 'url(#arr-human)' }, edgeG);
        if (!dim) {
          const lg = el('g', { transform: `translate(${mx},${(y1 + y2) / 2}) rotate(-90)` }, edgeG);
          label(lg, 0, 0, text, 'human');
        }
      } else if (kind === 'skipL') {
        const [x1, y1] = anchor(a, 'left');
        const x2 = b.type === 'gate' ? b.x + 5 : b.x;
        const y2 = b.y + b.h / 2;
        const mx = st.x + 6;
        el('path', { class: `edge${dim ? ' dim' : ''}`, d: `M${x1},${y1} H${mx} V${y2} H${x2 - 2}`, 'marker-end': 'url(#arr)' }, edgeG);
        if (!dim) {
          const lg = el('g', { transform: `translate(${mx},${y2 - 46}) rotate(-90)` }, edgeG);
          label(lg, 0, 0, text, 'plain');
        }
      }
    }
  }
  // loop-backs between bays
  for (const st of STAGES) {
    (st.cross || []).forEach(([from, to, why, what], ci) => {
      const a = N[from];
      const b = N[to];
      const dim = !(act[a.id] && act[b.id]);
      const [x1, y1] = anchor(a, 'left');
      const [x2, y2c] = anchor(b, 'right');
      const y2 = y2c + (ci === 0 ? -14 : 14);
      const g = el('g', { class: dim ? 'edge-g dim' : 'edge-g' }, edgeG);
      el('path', { class: 'edge loop', d: `M${x1 - 2},${y1} C${x1 - 70},${y1} ${x2 + 70},${y2} ${x2 + 4},${y2}`, 'marker-end': 'url(#arr-loop)' }, g);
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2 + (ci === 0 ? -22 : 22);
      if (!dim) { label(g, mx, my - 9, why, 'loop'); label(g, mx, my + 9, `→ ${what}`, 'loop'); }
    });
  }

  // nodes on top
  const nodeG = el('g', {}, world);
  for (const st of STAGES) for (const n of st.nodes) {
    const ng = drawNode(nodeG, n, act[n.id]);
    ng.addEventListener('click', (e) => { e.stopPropagation(); select(n.id); });
    ng.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(n.id); } });
  }

  // enforcement rail
  const er = el('g', { class: 'rail enf' }, world);
  const ey = LAYOUT.zoneBottom + 30;
  el('rect', { class: 'band', x: 24, y: ey, width: LAYOUT.width - 48, height: 64, rx: 6 }, er);
  el('text', { class: 'rname', x: 42, y: ey + 28 }, er).textContent = 'Always on · enforcement';
  el('text', { class: 'rsub', x: 42, y: ey + 50 }, er).textContent = 'Agents propose; the CLI, hooks and CI decide.';
  let ex = 42 + Math.max(textW('ALWAYS ON · ENFORCEMENT', '800 20px "Big Shoulders Display", "Arial Narrow", "Roboto Condensed", sans-serif'), textW('Agents propose; the CLI, hooks and CI decide.', '400 12px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif')) + 44;
  for (const t of ENFORCE) {
    const w = textW(t, '500 11px "IBM Plex Mono", monospace') + 18;
    const tg = el('g', { class: 'tag' }, er);
    el('rect', { x: ex, y: ey + 20, width: w, height: 24, rx: 12 }, tg);
    el('text', { x: ex + 9, y: ey + 36 }, tg).textContent = t;
    ex += w + 8;
  }

  // token layer (for "Run a request")
  el('g', { id: 'token-layer' }, world);
  $('#svg').setAttribute('aria-label', `Factory floor plan for recipe ${recipe}`);
}

// ===================================================================== inspector panel
