function renderAt(t) {
  if (!LV.job) return;
  LV.t = Math.max(0, Math.min(LV.END, t));
  const loc = locate(LV.t);
  const idx = loc.idx;
  const curRow = loc.j >= 0 ? LV.sched[loc.j].row : 0;
  // route: full for rows reached, partial for the row being entered
  LV.segs.forEach((s, r) => {
    if (!s) return;
    const first = LV.rows[r].first;
    let k = 0;
    if (first <= idx) k = 1;
    else if (loc.moving && first === loc.j) k = ease(loc.k);
    s.path.style.strokeDashoffset = `${s.len * (1 - k)}`;
    s.g.style.visibility = k > 0 ? 'visible' : 'hidden';
    if (s.label) s.label.style.opacity = k >= 1 ? 1 : 0;
  });
  // puck
  let x;
  let y;
  if (loc.j >= 0 && loc.moving && LV.sched[loc.j].seg) {
    const { path: p, len } = LV.sched[loc.j].seg;
    const a = p.getPointAtLength(ease(loc.k) * len);
    x = a.x; y = a.y;
  } else {
    const r = LV.rows[Math.max(0, curRow)];
    x = r.x; y = r.ny;
  }
  LV.puck.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
  LV.plate.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
  if (idx !== LV.shown) { LV.shown = idx; paintState(idx, curRow); }
  paintScrub();
  if (LV.follow) followCar(x, y);
}

function paintState(i, curRow) {
  const job = LV.job;
  const S = i >= 0 ? LV.states[i] : initState(job);
  // rows and their lines appear as they happen
  LV.rowEls.forEach((re, r) => {
    const row = LV.rows[r];
    const on = row.first <= i;
    re.g.style.visibility = on ? 'visible' : 'hidden';
    re.g.classList.toggle('current', on && r === curRow);
    for (const ln of re.lines) ln.el.style.visibility = ln.i <= i ? 'visible' : 'hidden';
    // node colour from that step's state when the row ended (or now, for the current row)
    const last = Math.min(i, row.items[row.items.length - 1]);
    const st = row.kind === 'halt' ? 'blocked' : row.kind === 'finish' ? 'done' : row.kind === 'park' ? (r === curRow && S.parked ? 'blocked' : 'parked') : row.kind === 'resume' || row.kind === 'amend' ? 'done' : row.kind === 'start' ? 'done' : (LV.states[Math.max(0, last)].steps[row.step] || {}).status || 'pending';
    re.node.setAttribute('class', `fnode s-${st}${r === curRow ? ' here' : ''}`);
  });
  document.querySelectorAll('#street .trow').forEach((g) => { g.style.visibility = LV.rows[+g.dataset.r].first <= i ? 'visible' : 'hidden'; });
  LV.inspEls.forEach((c) => { c.g.style.visibility = c.k <= i ? 'visible' : 'hidden'; });
  // header signals
  for (const s of job.steps) {
    const st = S.steps[s.id];
    setSig(LV.stepSig[s.id], st.status === 'again' ? 'pending' : st.status);
  }
  for (const id of ORDER) {
    const ss = stageStatus(job, S, id);
    LV.stageBar[id].setAttribute('class', `stagebar is-${ss}`);
  }
  paintCrew(i);
  paintOdo(i, S);
  paintNow(i, S);
  paintLog(i);
}

function crewAt(i, step) {
  const by = new Map();
  for (const c of LV.crew) {
    if (c.item > i || (step && c.step !== step)) continue;
    const k = c.role;
    const a = by.get(k) || { role: k, n: 0, models: [], retries: 0, fails: 0, ms: 0, labels: [] };
    a.n += 1;
    if (c.model && !a.models.includes(c.model)) a.models.push(c.model);
    if (c.retry || /^build \S+ #([2-9]|\d{2,})/.test(c.label || '')) a.retries += 1;
    if (BAD_OUTCOME.has(c.outcome)) a.fails += 1;
    a.ms += c.ms || 0;
    a.labels.push(c);
    by.set(k, a);
  }
  return [...by.values()];
}
// the crew band: every agent that has worked in each stage so far
function paintCrew(i) {
  const g = LV.crewG;
  g.innerHTML = '';
  const seen = new Set();
  for (const st of LV.geo.stages) {
    if (!st.steps.length) continue;
    const by = new Map();
    for (const c of LV.crew) {
      if (c.item > i || !st.steps.some((s) => s.id === c.step)) continue;
      const a = by.get(c.role) || { role: c.role, n: 0, models: [], retries: 0, fails: 0 };
      a.n += 1;
      if (c.model && !a.models.includes(c.model)) a.models.push(c.model);
      if (c.retry || /^build \S+ #([2-9]|\d{2,})/.test(c.label || '')) a.retries += 1;
      if (BAD_OUTCOME.has(c.outcome)) a.fails += 1;
      by.set(c.role, a);
    }
    [...by.values()].forEach((a, q) => {
      const suffix = ` ×${a.n}`;
      const w = st.w - 6;
      const key = `${st.id}:${a.role}:${a.n}`;
      seen.add(key);
      const y = 10 + q * (FG.CHIP_H + 4);
      const cg = drawChip(g, st.x + 3, y, { ...a, suffix: `${a.retries ? ` ↻${a.retries}` : ''}${a.fails ? ` ✕${a.fails}` : ''}${suffix}`, w }, w);
      if (!LV.chipsSeen.has(key) && !reduceMotion) { cg.classList.add('pop'); cg.style.animationDelay = `${q * 80}ms`; }
    });
  }
  LV.chipsSeen = seen;
}

function paintOdo(i, S) {
  const upto = LV.items.slice(0, i + 1);
  const decisions = upto.filter((x) => x.type === 'route').length;
  const runs = upto.filter((x) => x.type === 'agents').reduce((n, x) => n + (x.runs || 0), 0);
  const backs = LV.rows.filter((r) => r.first <= i && ((r.kind === 'stop' && r.back) || r.kind === 'amend')).length;
  const finds = (LV.job.inspector || []).length ? LV.inspEls.filter((c) => c.k <= i).length : null;
  const first = LV.items[0] ? Date.parse(LV.items[0].t) : 0;
  const cur = i >= 0 ? Date.parse(LV.items[i].t) : first;
  const vals = [['decisions', decisions], ['agent runs', runs], ['went back', backs], ['elapsed', fmtDur(cur - first)]];
  if (finds !== null) vals.push(['inspector', finds]);
  const host = $('#odo');
  if (host.children.length !== vals.length) host.innerHTML = vals.map(([k]) => `<div><b data-k="${k}">0</b><span>${k}</span></div>`).join('');
  for (const [k, v] of vals) {
    const b = host.querySelector(`[data-k="${k}"]`);
    if (b.textContent !== String(v)) { b.textContent = String(v); if (!reduceMotion) { b.classList.remove('tick'); void b.getBoundingClientRect(); b.classList.add('tick'); } }
  }
}

// ---------- the panel
