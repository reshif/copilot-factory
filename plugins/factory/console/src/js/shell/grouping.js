function urgencyCmp(a, b) {
  return (ATTN[a.bucket] - ATTN[b.bucket])
    || (a.bucket === 'turn' ? (a.waitSince || 0) - (b.waitSince || 0) : 0)
    || (b.updated - a.updated);
}
const SORTS = {
  urgency: urgencyCmp,
  updated: (a, b) => b.updated - a.updated,
  created: (a, b) => b.created - a.created,
  id: (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
};
const dayKey = (ms) => { const d = new Date(ms); return Number.isNaN(+d) ? '—' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }); };
const GROUPS = {
  attention: (m) => [ATTN[m.bucket], m.bucket, BUCKET_NAME[m.bucket]],
  status: (m) => [['active', 'parked', 'closed', 'cancelled', 'abandoned'].indexOf(m.job.status), m.job.status, m.job.status],
  recipe: (m) => [0, m.job.recipe || '—', m.job.recipe || 'no recipe'],
  risk: (m) => [RISK_ORDER[m.job.risk] ?? 9, m.job.risk || '—', `${m.job.risk || 'no'} risk`],
  stage: (m) => (m.bucket === 'done' ? [99, 'off', 'Off the line'] : [ORDER.indexOf(m.stage), m.stage, `${String(ORDER.indexOf(m.stage) + 1).padStart(2, '0')} ${STAGE_NAME[m.stage]}`]),
  epic: (m) => { const e = m.job.epic ? m.id : m.job.parent; return e ? [0, `e:${e}`, `Epic ${e}`] : [1, 'none', 'Not in an epic']; },
  day: (m) => [-m.updated, dayKey(m.updated), `Updated ${dayKey(m.updated)}`],
};
function computeGroups() {
  const pq = parseQ(UI.q);
  const all = [...MODELS.values()];
  const vis = all.filter((m) => qOk(m, pq) && facetOk(m));
  const by = new Map();
  for (const m of vis) {
    const [rank, key, label] = GROUPS[UI.group](m);
    const g = by.get(key) || { key, label, rank, ms: [], bucket: UI.group === 'attention' ? key : null };
    if (UI.group === 'day') g.rank = Math.min(g.rank, rank);
    g.ms.push(m);
    by.set(key, g);
  }
  const groups = [...by.values()].sort((a, b) => (a.rank - b.rank) || (a.key < b.key ? -1 : 1));
  const cmp = SORTS[UI.sort] || urgencyCmp;
  for (const g of groups) {
    g.ms.sort(cmp);
    // epics nest their slices when both are in the group
    const ids = new Set(g.ms.map((m) => m.id));
    const kids = new Map();
    const roots = [];
    for (const m of g.ms) {
      const par = m.job.parent;
      if (par && ids.has(par)) { const l = kids.get(par) || []; l.push(m); kids.set(par, l); } else roots.push(m);
    }
    g.rows = [];
    for (const m of roots) { g.rows.push({ m, depth: 0 }); for (const k of kids.get(m.id) || []) g.rows.push({ m: k, depth: 1 }); }
  }
  VISIBLE = groups.flatMap((g) => g.rows.map((r) => r.m.id));
  return { groups, pq, vis, all };
}

// ---------- board rows
