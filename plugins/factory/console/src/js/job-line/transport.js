function logRow(it, k) {
  const first = LV.items[0] ? Date.parse(LV.items[0].t) : 0;
  const [w, cls] = who(it);
  const [head] = describe(it);
  return `<li><button type="button" data-k="${k}"><span class="lt">+${esc(fmtDur(Date.parse(it.t) - first))}</span><span class="lw ${cls}">${esc(w)}</span><span>${esc(head)}</span></button></li>`;
}
function buildLog() {
  LV.logHtml = `<div class="logwrap"><div class="label">Every event (${LV.items.length})</div><ul class="log" id="log">${LV.items.map(logRow).join('')}</ul></div>`;
}
function paintLog(i) {
  if (LV.sel) return;
  $('#now').insertAdjacentHTML('beforeend', LV.logHtml);
  const log = $('#log');
  log.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => seekItem(+b.dataset.k));
    if (+b.dataset.k === i) { b.setAttribute('aria-current', 'true'); const top = b.offsetTop - log.offsetTop; if (top < log.scrollTop || top > log.scrollTop + log.clientHeight - 30) log.scrollTop = top - 60; }
  });
}
function buildScrubber() {
  const ticks = $('#s-ticks');
  const stages = {};
  ticks.innerHTML = LV.items.map((it, k) => {
    const e = LV.sched[k];
    const pct = (e.tm / LV.END) * 100;
    const S = LV.states[k];
    const def = LV.job.steps.find((s) => s.id === S.pos);
    if (def && stages[def.stage] === undefined) stages[def.stage] = pct;
    const cls = it.type === 'human' || (it.type === 'route' && S.steps[S.pos] && S.steps[S.pos].status === 'waiting') ? 'gate' : it.type === 'route' && S.loops.length && S.loops[S.loops.length - 1].item === k ? 'loop' : (it.type === 'result' && !it.ok) || ['park', 'error', 'stopped'].includes(it.type) ? 'fail' : it.type === 'agents' ? 'agents' : '';
    return `<span class="tk ${cls}" style="left:${pct.toFixed(2)}%"></span>`;
  }).join('') + Object.entries(stages).map(([id, pct]) => `<span class="st" style="left:${pct.toFixed(2)}%">${String(ORDER.indexOf(id) + 1).padStart(2, '0')}</span>`).join('');
}
function paintScrub() {
  const pct = (LV.t / LV.END) * 100;
  $('#s-fill').style.width = `${pct}%`;
  $('#s-head').style.left = `${pct}%`;
  $('#s-range').value = String(Math.round((LV.t / LV.END) * 1000));
  const loc = locate(LV.t);
  $('#clock').textContent = `${Math.max(0, loc.idx) + 1} / ${LV.items.length}`;
  $('#t-play').textContent = LV.playing ? '❚❚ Pause' : LV.t >= LV.END ? '▶ Replay' : '▶ Play';
}
function seekItem(k) {
  k = Math.max(0, Math.min(LV.items.length - 1, k));
  stopPlay();
  renderAt(LV.sched[k].tm + 1);
}
function curIndex() { return locate(LV.t).idx; }
function frame(now) {
  if (!LV.playing) return;
  const dt = Math.min(64, now - LV.last);
  LV.last = now;
  let t = LV.t + dt * LV.speed;
  if (reduceMotion) {
    // jump stop to stop: skip the moving part of each segment
    const loc = locate(t);
    if (loc.moving) t = LV.sched[loc.j].tm;
  }
  if (t >= LV.END) { renderAt(LV.END); stopPlay(); return; }
  renderAt(t);
  LV.raf = requestAnimationFrame(frame);
}
function play() {
  if (LV.t >= LV.END) { LV.t = 0; LV.shown = -2; }
  LV.playing = true;
  LV.sel = null;
  LV.last = performance.now();
  LV.raf = requestAnimationFrame(frame);
  paintScrub();
}
function stopPlay() { LV.playing = false; cancelAnimationFrame(LV.raf); paintScrub(); }
function applyZoom() {
  const host = $('#street');
  if (!LV.geo) return;
  const fitZ = Math.min(1, (host.clientWidth - 2) / LV.geo.width);
  LV.zoom = LV.fit && fitZ >= 0.72 ? fitZ : 1;
  host.querySelectorAll('svg').forEach((g) => { g.style.zoom = String(LV.zoom); });
  $('#t-zoom').setAttribute('aria-pressed', String(LV.fit));
  $('#t-zoom').textContent = LV.fit ? 'Fit' : '1:1';
}
function followCar(x, y) {
  const host = $('#street');
  x *= LV.zoom || 1;
  y *= LV.zoom || 1;
  if (performance.now() - LV.userScrollAt < 2500) return;
  const head = FG.HEAD_H * (LV.zoom || 1);
  const vx = host.scrollLeft;
  const vy = host.scrollTop;
  const w = host.clientWidth;
  const h = host.clientHeight - head;
  let tx = vx;
  let ty = vy;
  if (x < vx + w * 0.12 || x > vx + w * 0.7) tx = Math.max(0, x - w * 0.3);
  if (y < vy + 30 || y > vy + h * 0.72) ty = Math.max(0, y - h * 0.35);
  if (tx !== vx || ty !== vy) host.scrollTo({ left: tx, top: ty, behavior: LV.playing && !reduceMotion ? 'smooth' : 'auto' });
}
function bindTransport() {
  $('#t-play').addEventListener('click', () => (LV.playing ? stopPlay() : play()));
  $('#t-prev').addEventListener('click', () => { const i = curIndex(); seekItem(i - 1); });
  $('#t-next').addEventListener('click', () => { const i = curIndex(); seekItem(i + 1); });
  $('#t-zoom').addEventListener('click', () => { LV.fit = !LV.fit; try { localStorage.setItem('fc-fit', LV.fit ? '1' : '0'); } catch (e) { /* ignore */ } applyZoom(); LV.userScrollAt = -1e9; renderAt(LV.t); });
  window.addEventListener('resize', () => { if (LV.job) applyZoom(); });
  $('#t-follow').addEventListener('click', () => { LV.follow = !LV.follow; LV.userScrollAt = -1e9; $('#t-follow').setAttribute('aria-pressed', String(LV.follow)); if (LV.follow) renderAt(LV.t); });
  $('#speed').innerHTML = [0.5, 1, 2, 4].map((s) => `<button type="button" data-s="${s}" aria-pressed="${s === LV.speed}">${s === 0.5 ? '½' : s}×</button>`).join('');
  $('#speed').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    LV.speed = +b.dataset.s;
    try { localStorage.setItem('fc-speed', String(LV.speed)); } catch (e) { /* ignore */ }
    $('#speed').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(+x.dataset.s === LV.speed)));
  }));
  const range = $('#s-range');
  range.addEventListener('input', () => { stopPlay(); renderAt((+range.value / 1000) * LV.END); });
  range.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const i = curIndex(); seekItem(e.key === 'ArrowLeft' ? i - 1 : i + 1); }
    if (e.key === ' ') { e.preventDefault(); LV.playing ? stopPlay() : play(); }
  });
  const host = $('#street');
  const userScroll = () => { LV.userScrollAt = performance.now(); };
  host.addEventListener('wheel', userScroll, { passive: true });
  host.addEventListener('touchstart', userScroll, { passive: true });
  host.addEventListener('pointerdown', userScroll);
  host.addEventListener('keydown', (e) => {
    if (e.target !== host) return;
    if (e.key === ' ') { e.preventDefault(); LV.playing ? stopPlay() : play(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { userScroll(); }
  });
}

// ---------- page: picker, header, below
