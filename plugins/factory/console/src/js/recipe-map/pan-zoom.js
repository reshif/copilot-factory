const view = { s: 1, x: 0, y: 0 };
function apply() { $('#world').setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.s})`); }
function canvasBox() { return $('#canvas').getBoundingClientRect(); }
function zoomAt(f, cx, cy) {
  const s = Math.max(0.2, Math.min(2.2, view.s * f));
  view.x = cx - ((cx - view.x) * s) / view.s;
  view.y = cy - ((cy - view.y) * s) / view.s;
  view.s = s;
  apply();
}
function fitAll() {
  const b = canvasBox();
  view.s = Math.max(0.16, Math.min(b.width / LAYOUT.width, (b.height - HINT_H - 8) / LAYOUT.height));
  view.x = Math.max(8, (b.width - LAYOUT.width * view.s) / 2);
  view.y = Math.max(HINT_H, (b.height - LAYOUT.height * view.s) / 2);
  apply();
}
const HINT_H = 34; // the hint line over the canvas' top-left corner: the floor plan starts below it
function startView() {
  const b = canvasBox();
  view.s = Math.max(0.42, Math.min(1, (b.height - HINT_H - 8) / LAYOUT.height));
  view.x = 8;
  view.y = Math.max(HINT_H, (b.height - LAYOUT.height * view.s) / 2);
  apply();
}
let camRaf = 0;
function centerOn(n, { force = false, smooth = true } = {}) {
  const b = canvasBox();
  const cx = (n.x + n.w / 2) * view.s + view.x;
  const cy = (n.y + n.h / 2) * view.s + view.y;
  if (!force && cx > 80 && cx < b.width - 80 && cy > 60 && cy < b.height - 60) return;
  const tx = view.x + b.width / 2 - cx;
  const ty = view.y + b.height / 2 - cy;
  cancelAnimationFrame(camRaf);
  if (!smooth || reduce) { view.x = tx; view.y = ty; apply(); return; }
  const fx = view.x;
  const fy = view.y;
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 480);
    const e = 1 - (1 - k) ** 3;
    view.x = fx + (tx - fx) * e;
    view.y = fy + (ty - fy) * e;
    apply();
    if (k < 1) camRaf = requestAnimationFrame(step);
  };
  camRaf = requestAnimationFrame(step);
}
(function bindPan() {
  const c = $('#canvas');
  const pts = new Map();
  let last = null;
  let pinch = null;
  let moved = false;
  c.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pts.size === 1) { last = { x: e.clientX, y: e.clientY }; }
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
  });
  c.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const box = canvasBox();
      zoomAt(d / pinch, (a.x + b.x) / 2 - box.left, (a.y + b.y) / 2 - box.top);
      pinch = d;
      moved = true;
    } else if (pts.size === 1 && last) {
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) { moved = true; c.classList.add('dragging'); if (!c.hasPointerCapture(e.pointerId)) c.setPointerCapture(e.pointerId); }
      if (moved) { view.x += dx; view.y += dy; apply(); }
      last = { x: e.clientX, y: e.clientY };
    }
  });
  const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) { last = null; c.classList.remove('dragging'); } };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, true);
  // A plain vertical wheel scrolls the page; shift or a sideways swipe pans; ctrl/cmd zooms.
  c.addEventListener('wheel', (e) => {
    const box = canvasBox();
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX - box.left, e.clientY - box.top); return; }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      view.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      if (!e.shiftKey) view.y -= e.deltaY;
      apply();
    }
  }, { passive: false });
  const zin = () => { const b = canvasBox(); zoomAt(1.2, b.width / 2, b.height / 2); };
  const zout = () => { const b = canvasBox(); zoomAt(1 / 1.2, b.width / 2, b.height / 2); };
  $('#z-in').addEventListener('click', zin);
  $('#z-out').addEventListener('click', zout);
  $('#z-fit').addEventListener('click', fitAll);
  c.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('.node, .hit')) { if (!['+', '=', '-', '0'].includes(e.key)) return; }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zin(); }
    else if (e.key === '-') { e.preventDefault(); zout(); }
    else if (e.key === '0') { e.preventDefault(); fitAll(); }
    else if (e.key.startsWith('Arrow') && e.target === c) {
      e.preventDefault();
      const d = 60;
      if (e.key === 'ArrowLeft') view.x += d; if (e.key === 'ArrowRight') view.x -= d;
      if (e.key === 'ArrowUp') view.y += d; if (e.key === 'ArrowDown') view.y -= d;
      apply();
    }
  });
  c.tabIndex = 0;
  c.addEventListener('focusin', (e) => {
    const g = e.target.closest && e.target.closest('.node');
    if (g && LAYOUT.nodes[g.dataset.id]) centerOn(LAYOUT.nodes[g.dataset.id]);
  });
})();

// ===================================================================== run a request
