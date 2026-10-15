const LV = { fit: true, zoom: 1, jobs: [], job: null, geo: null, items: [], states: [], sched: [], crew: [], rows: [], rowOf: [], END: 1, t: 0, playing: false, speed: 1, follow: true, raf: 0, last: 0, shown: -2, sel: null, chipsSeen: new Set(), userScrollAt: -1e9 };
try { LV.speed = Number(localStorage.getItem('fc-speed')) || 1; LV.fit = localStorage.getItem('fc-fit') !== '0'; } catch (e) { LV.fit = true; }
if (![0.5, 1, 2, 4].includes(LV.speed)) LV.speed = 1;

function prepare(job) {
  const items = job.timeline.slice();
  items.push({ t: job.closed_at || job.updated_at || (items.length ? items[items.length - 1].t : job.created_at), type: 'end' });
  const states = [];
  let S = initState(job);
  items.forEach((it, i) => { S = cloneState(S); applyItem(job, S, it, i); states.push(S); });
  const crew = [];
  items.forEach((it, i) => {
    if (it.type !== 'agents') return;
    const step = it.step || (i > 0 ? states[i - 1].pos : null);
    for (const a of it.agents || []) crew.push({ ...a, step, item: i, workflow: it.workflow, config: it.config });
  });
  return { items, states, crew };
}
function finalState(job) { const p = prepare(job); return p.states[p.states.length - 1]; }

function jobSummary(job, S) {
  if (job.status === 'closed') return ['done', job.pr && job.pr.merged ? 'Merged · closed' : 'Closed'];
  if (job.status === 'cancelled') return ['blocked', 'Cancelled'];
  if (job.status === 'abandoned') return ['blocked', 'Abandoned'];
  if (job.status === 'parked') return ['blocked', `Parked at ${stepName(S.pos)}`];
  const p = S.steps[S.pos];
  if (!p) return ['pending', 'Starting'];
  if (p.status === 'waiting') return ['waiting', `Your turn · ${stepName(S.pos)}`];
  if (p.status === 'failed') return ['failed', `Stopped at ${stepName(S.pos)}`];
  return ['running', `${stepName(S.pos)} running`];
}
const SORT = { waiting: 0, running: 1, failed: 2, blocked: 3, pending: 4, done: 5 };

// ---------- svg helpers
