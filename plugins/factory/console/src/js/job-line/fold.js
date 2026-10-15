function initState(job) {
  const s = { pos: 'start', steps: {}, loops: [], lap: 0, parked: null, stopped: null, finished: false, lastRoute: null, entered: {}, guards: 0 };
  for (const st of job.steps) s.steps[st.id] = { status: 'pending', visits: 0, text: null, note: null };
  return s;
}
function cloneState(s) {
  const steps = {};
  for (const [k, v] of Object.entries(s.steps)) steps[k] = { ...v };
  return { ...s, steps, loops: s.loops.slice(), entered: { ...s.entered } };
}
function applyItem(job, S, it, i) {
  const idx = (id) => job.steps.findIndex((s) => s.id === id);
  const def = (id) => job.steps[idx(id)];
  const set = (id, status, note) => { if (S.steps[id]) { S.steps[id].status = status; if (note) S.steps[id].note = note; } };
  switch (it.type) {
    case 'created':
      set('request', 'done');
      S.steps.request.visits = 1;
      S.pos = 'request';
      S.entered.request = it.t;
      break;
    case 'route': {
      S.lastRoute = it;
      if (it.action === 'parked') { set(S.pos, 'blocked'); break; }
      if (!it.step) break;
      const ti = idx(it.step);
      const pi = S.pos === 'start' ? 0 : idx(S.pos);
      if (ti < pi) {
        S.lap += 1;
        S.loops.push({ from: S.pos, to: it.step, rule: it.rule, item: i, lap: S.lap, scope: it.scope });
        for (let k = ti + 1; k <= pi; k++) { const s = S.steps[job.steps[k].id]; if (['done', 'auto', 'failed', 'waiting', 'running'].includes(s.status)) s.status = 'again'; }
      } else if (ti > pi) {
        const prev = S.steps[S.pos];
        if (prev && (prev.status === 'running' || prev.status === 'waiting')) prev.status = 'done';
        for (let k = pi + 1; k < ti; k++) {
          const d = job.steps[k];
          const s = S.steps[d.id];
          if (s.status === 'pending') s.status = d.auto ? 'auto' : 'skipped';
          else if (s.status === 'again') s.status = 'done';
        }
      }
      const d = job.steps[ti];
      S.steps[it.step].status = d.human || it.action === 'gate' || it.action === 'wait' ? 'waiting' : 'running';
      S.steps[it.step].visits += 1;
      S.pos = it.step;
      if (!S.entered[d.stage]) S.entered[d.stage] = it.t;
      break;
    }
    case 'human':
      if (it.action === 'approve' && it.step) set(it.step, 'done', `approved${it.via ? ` via ${it.via}` : ''}`);
      else if (it.action === 'deny' && it.step) set(it.step, 'failed', 'you asked for changes');
      else if (it.action === 'merged') set('H4', 'done', `merged ${it.commit || ''}`.trim());
      else if (it.action === 'resume') { S.parked = null; if (S.steps[S.pos]) S.steps[S.pos].status = 'running'; }
      else if (it.action === 'cancelled' || it.action === 'abandoned') { S.stopped = it; set(S.pos, 'blocked'); }
      break;
    case 'result': {
      if (!it.step) break;
      const id = it.step;
      const st = S.steps[id];
      if (!st) break;
      st.text = it.text;
      const d = def(id);
      st.status = it.ok ? (d && d.auto ? 'auto' : 'done') : it.outcome === 'ask' ? 'waiting' : 'failed';
      break;
    }
    case 'clarify': {
      // clarify v3's stage lines: waiting on your reply, or at work again
      const st = it.step && S.steps[it.step];
      if (st && st.status !== 'done' && st.status !== 'auto') { st.status = it.waiting ? 'waiting' : it.outcome === 'park' ? 'blocked' : 'running'; st.text = it.text; }
      break;
    }
    case 'agents': {
      const st = S.steps[it.step || S.pos];
      if (st && st.status === 'pending') st.status = 'running';
      break;
    }
    case 'error': set(S.pos, 'failed', 'workflow error'); break;
    case 'park': S.parked = it; set(S.pos, 'blocked'); break;
    case 'stopped': S.stopped = it; set(S.pos, 'blocked'); break;
    case 'guard': S.guards += 1; break;
    case 'amend': S.amendments = (S.amendments || 0) + (it.phase === 'start' ? 1 : 0); break;
    case 'spawn': S.spawned = it.job; break;
    case 'end':
      if (job.status === 'closed') {
        for (const st of Object.values(S.steps)) {
          if (st.status === 'pending' || st.status === 'again') st.status = 'skipped';
          if (st.status === 'running' || st.status === 'waiting') st.status = 'done';
        }
        S.pos = 'finish';
        S.finished = true;
      }
      break;
    default: break;
  }
}
function stageStatus(job, S, stage) {
  const ids = job.steps.filter((s) => s.stage === stage).map((s) => s.id);
  if (!ids.length) return 'none';
  const sts = ids.map((id) => S.steps[id].status);
  const settled = (x) => ['done', 'auto', 'skipped'].includes(x);
  if (ids.includes(S.pos)) {
    const p = S.steps[S.pos].status;
    if (p === 'done' || p === 'auto') return sts.every(settled) ? 'done' : 'running';
    return p === 'again' ? 'running' : p;
  }
  if (sts.some((x) => x === 'blocked')) return 'blocked';
  if (sts.some((x) => x === 'failed')) return 'failed';
  if (sts.every(settled)) return sts.every((x) => x === 'skipped') ? 'skipped' : 'done';
  return 'pending';
}

const isFixLoop = (lp) => /^row[45]\./.test(lp.rule || '');
function loopLabel(lp, loops) {
  const kind = /^row4\./.test(lp.rule) ? 'FIX ROUND' : /^row5\./.test(lp.rule) ? 'VERIFY-FIX ROUND' : null;
  if (!kind) return /^row6\./.test(lp.rule) ? 'RE-PROVE' : `BACK TO ${stepName(lp.to).toUpperCase()}`;
  return `${kind} ${loops.filter((x) => x.lap <= lp.lap && isFixLoop(x)).length}`;
}

// ---------- geometry: the flow canvas
