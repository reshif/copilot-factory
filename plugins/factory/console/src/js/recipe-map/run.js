let run = null;
const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function path() {
  return STAGES.flatMap((st) => st.nodes.filter((n) => nodeActive(n) && n.type !== 'artifact' && n.id !== 'inspector'));
}
function stopRun() {
  if (!run) return;
  cancelAnimationFrame(run.raf);
  clearTimeout(run.t);
  run = null;
  const layer = $('#token-layer');
  if (layer) layer.innerHTML = '';
  document.querySelectorAll('.token-here').forEach((x) => x.classList.remove('token-here'));
  $('#z-play').textContent = 'Run a request';
  $('#nowcap').hidden = true;
  if (selected && LAYOUT.nodes[selected]) select(selected); else showIntro();
}
// The token drives along each bay's left margin, from stop to stop; between bays it
// crosses under the bay headers, through the gutter, like the hand-off arrows.
function hopPoints(a, b) {
  const lane = (n) => n.x - 8;
  const mid = (n) => n.y + n.h / 2;
  if (a.stage === b.stage) return [[lane(a), mid(a)], [lane(b), mid(b)]];
  const sa = STAGES.find((s) => s.id === a.stage);
  const y = sa.y + 68;
  return [[lane(a), mid(a)], [lane(a), y], [lane(b), y], [lane(b), mid(b)]];
}
function startRun() {
  stopRun();
  const stops = path();
  const layer = $('#token-layer');
  const tok = el('g', { class: 'token' }, layer);
  const halo = el('circle', { class: 'halo', r: 13 }, tok);
  const core = el('circle', { class: 'core', r: 6.5 }, tok);
  run = { i: 0, raf: 0, t: 0 };
  $('#z-play').textContent = 'Stop';
  if (view.s < 0.8) { const b = canvasBox(); zoomAt(0.85 / view.s, b.width / 2, b.height / 2); }
  const place = (x, y) => { for (const c of [halo, core]) { c.setAttribute('cx', x); c.setAttribute('cy', y); } };
  const arrive = (k) => {
    const n = stops[k];
    document.querySelectorAll('.token-here').forEach((x) => x.classList.remove('token-here'));
    const g = document.querySelector(`.node[data-id="${n.id}"]`);
    if (g) g.classList.add('token-here');
    const cap = $('#nowcap');
    cap.hidden = false;
    cap.textContent = `${k + 1}/${stops.length} · ${n.title}`;
    showNode(n);
    centerOn(n, { force: true });
  };
  place(stops[0].x - 8, stops[0].y + stops[0].h / 2);
  arrive(0);
  const hop = () => {
    if (!run) return;
    if (run.i >= stops.length - 1) { run.t = setTimeout(stopRun, 2400); return; }
    const pts = hopPoints(stops[run.i], stops[run.i + 1]);
    const lens = pts.slice(1).map((p, q) => Math.hypot(p[0] - pts[q][0], p[1] - pts[q][1]));
    const total = lens.reduce((x, y) => x + y, 0) || 1;
    if (reduce) { run.i += 1; place(...pts[pts.length - 1]); arrive(run.i); run.t = setTimeout(hop, 1500); return; }
    const t0 = performance.now();
    const dur = Math.max(500, Math.min(1500, total * 1.6));
    const step = (now) => {
      if (!run) return;
      const k = Math.min(1, (now - t0) / dur);
      let d = (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2) * total;
      let q = 0;
      while (q < lens.length - 1 && d > lens[q]) { d -= lens[q]; q += 1; }
      const f = lens[q] ? Math.min(1, d / lens[q]) : 1;
      place(pts[q][0] + (pts[q + 1][0] - pts[q][0]) * f, pts[q][1] + (pts[q + 1][1] - pts[q][1]) * f);
      if (k < 1) run.raf = requestAnimationFrame(step);
      else { run.i += 1; arrive(run.i); run.t = setTimeout(hop, 1200); }
    };
    run.raf = requestAnimationFrame(step);
  };
  run.t = setTimeout(hop, 1200);
}
$('#z-play').addEventListener('click', () => (run ? stopRun() : startRun()));
$('#canvas').addEventListener('click', () => { if (!run) { selected = null; document.querySelectorAll('.node.sel').forEach((x) => x.classList.remove('sel')); showIntro(); } });

// ===================================================================== recipe picker
