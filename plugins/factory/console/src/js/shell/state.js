// The operations floor around the line: every job as a dense board row (or a transit line
// on one time axis), five KPI housings that double as filters, a facet rail, a query box,
// and the wire. Each job is derived once per rev; a live update re-renders only the rows
// whose rev changed.
const BUCKETS = [['turn', 'Your turn'], ['running', 'Running'], ['parked', 'Parked'], ['stopped', 'Stopped'], ['done', 'Done']];
const BUCKET_NAME = Object.fromEntries(BUCKETS);
const ATTN = { turn: 0, stopped: 1, running: 2, parked: 3, done: 4 };
const RISK_ORDER = { high: 0, medium: 1, low: 2 };
const UI = {
  view: 'board', jobTab: 'line', q: '', facets: {}, group: 'attention', sort: 'urgency', collapsed: new Set(['done']), cursor: null,
  wirePaused: false, wireJob: false, wireHealth: false, wireOpen: false, wireLimit: 160, mpane: 'main', notify: false, theme: 'auto', booted: false,
};
const MODELS = new Map(); // id → derived model (cached by rev)
let VISIBLE = []; // ids in board order, after filters
let SEEN = {};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
};
try { SEEN = JSON.parse(store.get('fc-seen', '{}')) || {}; } catch (e) { SEEN = {}; }
UI.notify = store.get('fc-notify', '0') === '1';
UI.theme = store.get('fc-theme', 'auto');
UI.group = store.get('fc-group', 'attention');
UI.sort = store.get('fc-sort', 'urgency');

const hashStr = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); };
const jobRev = (job) => job.rev || hashStr(JSON.stringify(job));
const nowMs = () => Date.now();
const durTok = (s) => { const m = /^(\d+(?:\.\d+)?)(m|h|d|w)$/i.exec(String(s || '')); return m ? +m[1] * { m: 60e3, h: 3600e3, d: 864e5, w: 6048e5 }[m[2].toLowerCase()] : null; };
const shortAgo = (ms) => (!(ms >= 0) ? '' : ms < 60000 ? 'now' : fmtDur(ms).split(' ')[0]);
const roleShort = (t) => String(t || '').replace(/^factory:/, '');
const gateReply = (job, gate) => (!gate ? null : gate === 'P' ? `resume ${job.id}` : gate === 'H4' ? `merged ${job.id} <commit>` : `approve ${job.id} ${gate}`);

function bucketOf(job, sum) {
  if (job.status === 'closed') return 'done';
  if (job.status === 'cancelled' || job.status === 'abandoned') return 'stopped';
  if (job.status === 'parked' || (job.pending_gate && job.pending_gate.id === 'P')) return 'parked';
  if (job.pending_gate || sum[0] === 'waiting') return 'turn';
  if (sum[0] === 'failed' || sum[0] === 'blocked') return 'stopped';
  return 'running';
}

function modelOf(job) {
  const rev = jobRev(job);
  const old = MODELS.get(job.id);
  if (old && old.rev === rev) { old.job = job; return old; }
  const p = prepare(job);
  const S = p.states[p.states.length - 1];
  const sum = jobSummary(job, S);
  const bucket = bucketOf(job, sum);
  const def = job.steps.find((s) => s.id === S.pos);
  const roles = new Set();
  let runs = 0;
  let retries = 0;
  for (const c of p.crew) { roles.add(c.role); runs += 1; if (c.retry || /^build \S+ #([2-9]|\d{2,})/.test(c.label || '')) retries += 1; }
  const tasks = job.tasks || [];
  const hay = [job.id, job.title, job.recipe, job.work_type, ...job.timeline.map((t) => [t.text, t.reason, t.raw_step, t.workflow, t.gate].filter(Boolean).join(' ')), ...(job.inspector || []).map((f) => `${f.summary} ${f.rule}`)].join(' \u0001 ').toLowerCase();
  const gate = job.pending_gate && job.pending_gate.id !== 'P' ? job.pending_gate.id : null;
  const m = {
    id: job.id, job, rev, S, sum, bucket, p,
    lamps: ORDER.map((st) => stageStatus(job, S, st)),
    stage: def ? def.stage : job.status === 'closed' ? 'learn' : 'request',
    stepLabel: S.pos === 'finish' ? 'Off the line' : stepName(S.pos),
    gate, waitSince: job.pending_gate ? Date.parse(job.pending_gate.at) : null,
    created: Date.parse(job.created_at), updated: Date.parse(job.updated_at || job.created_at), closed: job.closed_at ? Date.parse(job.closed_at) : null,
    loops: S.loops.length, retries, runs, roles,
    tasksTotal: tasks.length, tasksPassed: tasks.filter((t) => t.pass === true || t.outcome === 'done').length,
    findings: (job.inspector || []).filter((f) => f.status === 'open').length, findingsTotal: (job.inspector || []).length,
    times: job.timeline.map((t) => Date.parse(t.t)).filter((x) => x === x),
    guards: S.guards, amends: S.amendments || 0, spawned: job.timeline.filter((t) => t.type === 'spawn').map((t) => t.job),
    hay, titleL: String(job.title || '').toLowerCase(),
  };
  MODELS.set(job.id, m);
  return m;
}

// ---------- query: tokens + fuzzy words
