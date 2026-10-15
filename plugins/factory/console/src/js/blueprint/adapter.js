// ===================================================================== blueprint: the display document
// The Blueprint draws a job as a walk through states (received → intent → … → closed) on nine
// stations. Copilot Factory records steps instead: the router's routes, results, your replies,
// parks, amendments. toDisplay() folds each job's timeline into that walk, read-only, from the
// same DATA every other view reads. Nothing here goes back to the CLI.
const BP_STAGES = [
  { key: 'intake', label: 'Intake', states: ['received'] },
  { key: 'intent', label: 'Contract', states: ['intent', 'awaiting_intent_approval'] },
  { key: 'design', label: 'Design', states: ['designing', 'awaiting_design_approval', 'awaiting_findings_approval'] },
  { key: 'plan', label: 'Plan', states: ['planning', 'awaiting_plan_approval'] },
  { key: 'build', label: 'Build', states: ['building', 'integrating'] },
  { key: 'verify', label: 'Prove', states: ['verifying'] },
  { key: 'review', label: 'Challenge', states: ['reviewing'] },
  { key: 'ship', label: 'Ship', states: ['ready_to_ship', 'awaiting_ship_approval', 'pr_open', 'merged', 'post_merge_review'] },
  { key: 'done', label: 'Learn', states: ['closed', 'findings_delivered'] },
];
const BP_SIDES = [
  { key: 'change', label: 'Changing', states: ['amending', 'awaiting_amendment_approval', 'needs_replan'] },
  { key: 'parked', label: 'Parked', states: ['parked'] },
  { key: 'stopped', label: 'Stopped', states: ['cancelled', 'abandoned'] },
];
// the recipe step the router chose → the state the job is in while it runs
const BP_STEP_STATE = {
  request: 'received', clarify: 'intent', H1: 'awaiting_intent_approval', EH1: 'awaiting_intent_approval',
  ground: 'designing', decide: 'designing', H2: 'awaiting_design_approval', EH2: 'awaiting_design_approval', HF: 'awaiting_findings_approval',
  decompose: 'planning', plan_critique: 'planning', H3: 'awaiting_plan_approval', EH3: 'awaiting_plan_approval',
  realize: 'building', children: 'building', reconcile: 'integrating', prove: 'verifying', challenge: 'reviewing', epic_gate: 'verifying',
  ship: 'ready_to_ship', HS: 'awaiting_ship_approval', H4: 'pr_open', post_merge_challenge: 'post_merge_review', distill: 'merged', close: 'merged',
  amend: 'amending', A: 'awaiting_amendment_approval',
};
const BP_GATE_OF = { awaiting_intent_approval: 'H1', awaiting_design_approval: 'H2', awaiting_findings_approval: 'HF', awaiting_plan_approval: 'H3', awaiting_ship_approval: 'HS', awaiting_amendment_approval: 'A', pr_open: 'H4', parked: 'P' };
const BP_MEANING = {
  received: 'the request is in; the router picks the first step', intent: 'clarify drafts the contract and asks only what the repo cannot answer',
  awaiting_intent_approval: 'you approve the contract (H1)', designing: 'ground and decide: sourced facts, then a design record',
  awaiting_design_approval: 'you approve the design (H2)', awaiting_findings_approval: 'you accept the findings (HF)',
  planning: 'decompose writes the task waves', awaiting_plan_approval: 'you approve the plan (H3)', building: 'builders work in their own worktrees, testers verify each task',
  integrating: 'reconcile merges the task branches into the job branch', verifying: 'prove runs every check on the exact build',
  reviewing: 'challenge: the review lanes and the finding verifier', ready_to_ship: 'ship writes the report and opens the pull request',
  awaiting_ship_approval: 'you sign off the ship (HS)', pr_open: 'CI runs, then you merge (H4)', merged: 'merged; distill proposes lessons',
  post_merge_review: 'the review after merge', closed: 'closed', findings_delivered: 'findings delivered',
  amending: 'the contract or plan is changing', awaiting_amendment_approval: 'you approve the amendment (A)', needs_replan: 'needs a new plan',
  parked: 'nothing moves until you decide', cancelled: 'cancelled', abandoned: 'abandoned',
};

function bpHistory(job) {
  const hist = [];
  let cur = 'received';
  let parkedFrom = null;
  const go = (at, to, by, reason) => { if (!at || !to || to === cur) return; hist.push({ at, from: cur, to, by, reason: reason || '' }); cur = to; };
  for (const it of job.timeline || []) {
    if (it.type === 'route') {
      const step = it.step || it.raw_step;
      if (cur === 'parked') parkedFrom = null;
      go(it.t, BP_STEP_STATE[step] || cur, 'router', it.reason || (it.rule ? `rule ${it.rule}` : ''));
    } else if (it.type === 'park') {
      parkedFrom = cur; go(it.t, 'parked', it.from === 'manual' ? 'you' : 'router', it.text);
    } else if (it.type === 'human' && it.action === 'resume' && cur === 'parked') {
      go(it.t, parkedFrom || 'received', 'you', 'you resumed the job'); parkedFrom = null;
    } else if (it.type === 'human' && it.action === 'merged') {
      go(it.t, 'merged', 'you', `you merged${it.commit ? ` ${it.commit}` : ''}`);
    } else if (it.type === 'amend' && it.phase === 'start') {
      go(it.t, 'amending', 'you', it.text);
    } else if (it.type === 'amend' && it.phase === 'submit') {
      go(it.t, 'awaiting_amendment_approval', 'router', it.text);
    }
  }
  const end = job.closed_at || job.updated_at || job.created_at;
  if (job.status === 'cancelled' || job.status === 'abandoned') {
    const st = (job.timeline || []).filter((t) => t.type === 'stopped').pop();
    go(st ? st.t : end, job.status, 'you', st ? st.text : job.status);
  } else if (job.status === 'closed') {
    go(end, job.work_type === 'spike' && !job.pr ? 'findings_delivered' : 'closed', 'router', 'job closed');
  } else if (job.status === 'parked' || (job.pending_gate && job.pending_gate.id === 'P')) {
    if (cur !== 'parked') { parkedFrom = cur; go((job.park && job.park.at) || end, 'parked', 'router', job.park && job.park.reason); }
  } else if (job.pending_gate) {
    const want = BP_STEP_STATE[job.pending_gate.id];
    if (want) go(job.pending_gate.at, want, 'router', 'waiting on you');
  }
  return { hist, state: cur, parkedFrom };
}

function bpTaskStatus(t) {
  if (t.pass === true) return 'passing';
  if (t.pass === false) return 'failing';
  if (t.outcome === 'done') return 'built';
  if (t.outcome === 'blocked' || t.outcome === 'exhausted') return 'failing';
  return t.attempts ? 'building' : 'todo';
}

function bpReviews(job) {
  const out = [];
  for (const it of job.timeline || []) {
    if (it.type !== 'result' || !/challenge/.test(it.raw_step || '') || !it.findings) continue;
    const lanes = {};
    for (const f of it.findings) (lanes[f.lane] = lanes[f.lane] || []).push(f);
    const verdicts = {};
    const round = /Round \d+: (.*?)(?: —|$)/.exec(it.text || ''); // "Round 2: code ✓ · tests ✗ — 1 confirmed finding(s)"
    for (const part of round ? round[1].split(' · ') : []) {
      const [lane, mark] = part.split(' ');
      if (lane) verdicts[lane] = mark === '✓' ? 'pass' : 'changes';
    }
    for (const lane of new Set([...Object.keys(verdicts), ...Object.keys(lanes)])) {
      const fs = lanes[lane] || [];
      out.push({
        lane, verdict: verdicts[lane] || (fs.some((f) => f.status === 'confirmed') ? 'changes' : 'pass'), at: it.t, model: null,
        findings: fs.filter((f) => f.status !== 'refuted').map((f) => ({ severity: f.severity, summary: f.summary, file: f.file || undefined, line: f.line || undefined })),
        dismissed: fs.filter((f) => f.status === 'refuted').length,
      });
    }
  }
  return out;
}

function bpCriteria(job) {
  const proofs = (job.timeline || []).filter((t) => t.type === 'result' && t.raw_step === 'prove' && t.acs);
  const last = proofs.pop();
  return last ? Object.entries(last.acs).map(([id, v]) => ({ id, text: '', status: v === 'proven' ? 'proven' : v || 'not_proven', tasks: [] })) : [];
}

// agent runs: each roster entry with a duration becomes a start and a stop, tagged with the state
// the job was in, so the drawing can light the bank of the station the agent worked for.
function bpActivity(job, hist) {
  const stateAt = (ms) => { let s = 'received'; for (const h of hist) { if (Date.parse(h.at) <= ms) s = h.to; else break; } return s; };
  const out = [];
  for (const it of job.timeline || []) {
    const end = Date.parse(it.t);
    if (it.type === 'agents') {
      for (const a of it.agents || []) {
        const ms = a.ms || 0;
        const st = new Date(end - ms).toISOString();
        const state = stateAt(end - ms);
        out.push({ at: st, agent: `factory:${a.role}`, job: job.id, phase: 'start', state, kind: it.workflow || null });
        out.push({ at: it.t, agent: `factory:${a.role}`, job: job.id, phase: 'stop', state, kind: it.workflow || null });
      }
    } else if (it.type === 'guard') {
      out.push({ at: it.t, agent: it.who && it.who.startsWith('factory:') ? it.who : null, job: job.id, phase: 'denied', tool: 'tool call', reason: it.text, command: it.target || null, state: stateAt(end) });
    }
  }
  for (const a of job.running_agents || []) out.push({ at: a.since, agent: a.agent_type, job: job.id, phase: 'start', state: stateAt(Date.parse(a.since)) });
  return out;
}

function bpWaiting(job, state) {
  const g = BP_GATE_OF[state];
  if (job.status !== 'active' && job.status !== 'parked') return { who: 'nobody', what: BP_MEANING[state] || state };
  if (!g) return { who: 'agent', what: BP_MEANING[state] || state };
  const reply = g === 'P' ? `resume ${job.id} · cancel ${job.id} · abandon ${job.id}` : g === 'H4' ? `merged ${job.id} <commit>` : `approve ${job.id} ${g} · deny ${job.id} <what must change>`;
  return { who: 'you', gate: g, what: BP_MEANING[state] || '', reply, command: null };
}

function toDisplay(data) {
  data = data || {};
  const all = data.jobs || [];
  const jobs = [];
  let activity = [];
  const lessons = [];
  for (const j of all) {
    if (j.epic) continue; // an epic is its own drawing series, not a job on the line
    const { hist, state, parkedFrom } = bpHistory(j);
    const parent = j.parent ? all.find((x) => x.id === j.parent) : null;
    const challenge = (j.steps || []).find((s) => s.lanes);
    const amend = (j.timeline || []).filter((t) => t.type === 'amend' && t.phase === 'start').pop();
    jobs.push({
      id: j.id, slug: j.title || j.id, type: j.work_type || 'feature', risk: j.risk || 'low', state,
      epic: parent && parent.epic ? parent.id : null, slice: parent && parent.epic ? j.id : null,
      created_at: j.created_at, updated_at: j.updated_at, parked_from: parkedFrom,
      waiting_on: bpWaiting(j, state), rework_loops: hist.filter((h) => h.to === 'building' && ['verifying', 'reviewing', 'integrating', 'ready_to_ship', 'pr_open'].includes(h.from)).length,
      history: hist,
      tasks: (j.tasks || []).map((t) => ({ id: t.id, objective: t.objective, depends_on: t.depends_on || [], criteria: [], allowed_paths: [], verify_commands: [], status: bpTaskStatus(t), runs: t.attempts || 0 })),
      criteria: bpCriteria(j), reviews: bpReviews(j), gate: null,
      required_lanes: challenge ? challenge.lanes : [], docs: [],
      amendment: amend ? { reason: amend.text, from: 'you' } : null,
      evidence_count: (j.tasks || []).filter((t) => t.pass !== null && t.pass !== undefined).length,
    });
    activity = activity.concat(bpActivity(j, hist));
    for (const l of j.lessons || []) lessons.push({ id: l.id, rule: l.text, why: `from ${j.id}`, status: l.status, created_at: j.closed_at || j.updated_at, scope: [], lanes: [], evidence: [j.id] });
  }
  activity.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    generated_at: data.generated_at, repo: data.project || 'repository',
    stages: BP_STAGES, side_lanes: BP_SIDES, meaning: BP_MEANING,
    jobs, activity, lessons, standards: { adopted: [], checks: [], rules: [] }, epics: [], autopilot: null,
  };
}
