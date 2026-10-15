function sv(tag, attrs, parent) { return el(tag, attrs || {}, parent); }
function signal(parent, kind, x, y, label) {
  const g = sv('g', { class: `sig sig-${kind}${kind === 'ped' ? ' ped' : ''}`, transform: `translate(${x},${y})` }, parent);
  if (kind === 'ped') {
    sv('rect', { class: 'housing', width: 20, height: 21, rx: 3 }, g);
    sv('use', { href: '#g-hand', x: 5, y: 2, class: 'hand' }, g);
    sv('use', { href: '#g-walk', x: 5, y: 11.5, class: 'walk' }, g);
    sv('rect', { class: 'bag', x: -2, y: -2, width: 24, height: 25, rx: 4 }, g);
  } else if (kind === 'v') {
    sv('rect', { class: 'plate', x: -2, y: -2, width: 18, height: 42, rx: 5 }, g);
    sv('rect', { class: 'pole', x: 6, y: 38, width: 2, height: 12 }, g);
    sv('rect', { class: 'housing', width: 14, height: 38, rx: 4 }, g);
    ['red', 'amber', 'green'].forEach((c, i) => {
      const cy = 7.5 + i * 11.5;
      sv('circle', { class: `halo ${c}`, cx: 7, cy, r: 7.4 }, g);
      sv('circle', { class: `lamp ${c}`, cx: 7, cy, r: 4.2 }, g);
      sv('path', { class: 'visor', d: `M${7 - 5.3},${cy - 1.9} A5.6,5.6 0 0 1 ${7 + 5.3},${cy - 1.9}` }, g);
    });
    sv('rect', { class: 'bag', x: -3, y: -3, width: 20, height: 44, rx: 5 }, g);
  } else {
    sv('rect', { class: 'housing', width: 26, height: 10, rx: 5 }, g);
    ['red', 'amber', 'green'].forEach((c, i) => {
      sv('circle', { class: `halo ${c}`, cx: 5.5 + i * 7.5, cy: 5, r: 4.6 }, g);
      sv('circle', { class: `lamp ${c}`, cx: 5.5 + i * 7.5, cy: 5, r: 2.7 }, g);
    });
    sv('rect', { class: 'bag', x: -2, y: -2, width: 30, height: 14, rx: 6 }, g);
  }
  if (label) g.appendChild(document.createElementNS(NS, 'title')).textContent = label;
  return g;
}
const setSig = (g, status) => { if (g) g.setAttribute('class', g.getAttribute('class').replace(/\bis-\S+/g, '').trim() + ` is-${status}`); };
function roundPath(pts, r = 10) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const l1 = Math.hypot(x1 - x0, y1 - y0);
    const l2 = Math.hypot(x2 - x1, y2 - y1);
    if (!l1 || !l2) continue;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const a = [x1 - ((x1 - x0) / l1) * rr, y1 - ((y1 - y0) / l1) * rr];
    const b = [x1 + ((x2 - x1) / l2) * rr, y1 + ((y2 - y1) / l2) * rr];
    d += ` L${a[0]},${a[1]} Q${x1},${y1} ${b[0]},${b[1]}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last[0]},${last[1]}`;
}

// ---------- rows: one per visit, park, resume, amendment, stop or finish
