function buildSchedule() {
  const { items, rowOf } = LV;
  const sched = [];
  let t = 0;
  items.forEach((it, i) => {
    const r = rowOf[i];
    const entering = i > 0 && LV.rows[r].first === i && r > 0;
    const seg = entering ? LV.segs[r] : null;
    const move = seg ? Math.max(380, Math.min(2200, seg.len / 0.34)) : 0;
    const dwell = { created: 900, route: 600, human: 1000, result: 800, agents: 650 + 90 * Math.min((it.agents || []).length, 10), park: 1400, stopped: 1400, amend: 1100, spawn: 1100, end: 700 }[it.type] || 550;
    sched.push({ t0: t, tm: t + move, t1: t + move + dwell, seg, row: r });
    t += move + dwell;
  });
  LV.sched = sched;
  LV.END = Math.max(1, t);
}
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
function locate(t) {
  const s = LV.sched;
  let j = -1;
  let lo = 0;
  let hi = s.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m].t0 <= t) { j = m; lo = m + 1; } else hi = m - 1; }
  if (j < 0) return { j: -1, idx: -1, moving: false, k: 0 };
  const e = s[j];
  if (t < e.tm) return { j, idx: j - 1, moving: true, k: (t - e.t0) / (e.tm - e.t0) };
  return { j, idx: j, moving: false, k: 1 };
}

// ---------- render at playhead t (pure)
