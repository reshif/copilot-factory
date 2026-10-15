function describe(it, job = LV.job) {
  switch (it.type) {
    case 'created': return [`Request submitted`, `“${job.title}” · ${job.work_type}, ${job.risk} risk${job.risk_proposed && job.risk_proposed !== job.risk ? ` (proposed ${job.risk_proposed})` : ''} → recipe ${job.recipe}`];
    case 'route': {
      const where = it.step ? stepName(it.step) : it.raw_step || it.chosen;
      const head = it.action === 'wait' ? `Waiting for you: ${where}` : it.action === 'gate' ? `Gate ${where}: your turn` : it.action === 'parked' ? 'Router parked the job' : it.action === 'done' ? 'Recipe complete' : `Router → ${where}${it.scope && it.scope !== 'all' ? ` (${it.scope} round)` : ''}`;
      return [head, `${RULES[it.rule] || it.rule}${it.reason ? ` — ${it.reason}` : ''}`];
    }
    case 'human': {
      const g = it.gate || stepName(it.step);
      const t = { approve: `You approved ${g}${it.via ? ` (${it.via})` : ''}`, deny: `You asked for changes at ${g}`, merged: `You merged${it.commit ? ` ${it.commit}` : ''}`, resume: 'You resumed the job', waive: 'You waived a floor', confirm_ac: 'You confirmed a criterion', cancelled: 'You cancelled the job', abandoned: 'You abandoned the job', change_assumption: `You overrode ${it.assumption || 'an assumption'}`, drop_assumption: `You dropped ${it.assumption || 'an assumption'}` }[it.action] || `You: ${it.action}`;
      return [t, it.reason || (it.action === 'change_assumption' ? `${it.value || ''}${it.was ? ` (research said: ${it.was})` : ''}` : it.action === 'drop_assumption' ? it.was || '' : '')];
    }
    case 'result': return [`${stepName(it.step || it.raw_step)}: ${it.ok ? 'passed' : it.outcome === 'ask' ? 'needs you' : 'not passed'}`, it.text];
    case 'agents': return [`${it.workflow ? `${it.workflow}${it.config ? ` · ${it.config}` : ''}` : 'Agents (seen by the hooks)'} ran ${it.runs} agent run${it.runs === 1 ? '' : 's'}`, it.from === 'hooks' ? 'Seen through the hooks (no roster in the envelope)' : `Workflow status: ${it.status}`];
    case 'park': return ['Parked', it.text];
    case 'stopped': return ['Stopped', it.text];
    case 'error': return ['Workflow error', it.text];
    case 'guard': return [`Guard blocked ${it.who || 'a tool call'}`, `${it.text}${it.target ? ` — command: ${it.target}` : ''}`];
    case 'refused': return ['A reply was refused', it.text];
    case 'hook_error': return ['A hook failed', it.text];
    case 'stop_block': return ['Stop gate: not done yet', it.text];
    case 'unparsed': return ['A reply was not understood', it.text];
    case 'amend': return [it.phase === 'start' ? `Amendment ${it.id || ''} started`.replace('  ', ' ') : it.phase === 'submit' ? 'Amendment submitted' : 'Amendment applied', it.text];
    case 'spawn': return [`Follow-up ${it.job} opened`, it.text];
    case 'end': return job.status === 'closed' ? ['Off the line', `Closed ${fmtDate(job.closed_at || it.t)}`] : ['Now', `Last activity ${ago(it.t)}`];
    default: return [it.type, it.text || ''];
  }
}
function who(it) {
  if (it.type === 'route') return ['router', 'route'];
  if (it.type === 'human') return ['you', 'you'];
  if (it.type === 'agents') return ['agents', 'agents'];
  if (it.type === 'result') return [it.ok ? 'passed' : it.outcome === 'ask' ? 'asks' : 'failed', it.ok ? 'ok' : it.outcome === 'ask' ? 'you' : 'bad'];
  if (['park', 'error', 'guard', 'stopped', 'refused', 'hook_error', 'stop_block', 'unparsed'].includes(it.type)) return [it.type.replace('_', ' '), 'bad'];
  if (it.type === 'created') return ['request', 'you'];
  if (it.type === 'amend') return ['amend', 'you'];
  if (it.type === 'spawn') return ['follow-up', 'route'];
  return [it.type === 'end' ? (LV.job.status === 'closed' ? 'closed' : 'now') : it.type, ''];
}
function agentRowsHtml(list) {
  return `<div class="alist">${list.map((a) => {
    const fam = modelFamily(a.model);
    const verdict = a.verdict && a.verdict !== a.outcome ? a.verdict : null; // agent_run's verdict, when the roster's outcome is not already it
    return `<div class="arow"><span class="mdot ${fam}" title="${esc(a.model || 'session model')}">${esc(modelLetter(a.model))}</span><b title="${esc(a.label)}">${esc(a.label)}</b><span class="o ${outcomeClass(a.outcome)}">${esc(a.outcome || '')}${verdict ? ` <span class="${outcomeClass(verdict)}">· ${esc(verdict)}</span>` : ''}${a.ms ? ` · ${fmtDur(a.ms)}` : ''}</span></div>`;
  }).join('')}</div>`;
}
function paintNow(i, S) {
  if (LV.sel) return paintStep(LV.sel);
  const job = LV.job;
  const it = i >= 0 ? LV.items[i] : null;
  const pos = S.pos;
  const def = job.steps.find((s) => s.id === pos);
  const status = def ? S.steps[pos].status : job.status === 'closed' && pos === 'finish' ? 'done' : 'pending';
  const [head, sub] = it ? describe(it) : ['Ready', 'Press Replay to drive this job down the line.'];
  const first = LV.items[0] ? Date.parse(LV.items[0].t) : 0;
  const parts = [];
  parts.push(`<div class="nowtop"><span class="label">${def ? `stage ${ORDER.indexOf(def.stage) + 1} · ${esc(STAGE_NAME[def.stage])}` : pos === 'finish' ? 'off the line' : 'start'}</span><span class="state-word w-${status}">${esc(WORD[status] || status)}</span></div>`);
  parts.push(`<h3>${esc(head)}</h3>`);
  if (sub) parts.push(`<p>${esc(sub)}</p>`);
  if (it) parts.push(`<p class="mono">${esc(fmtDate(it.t))} · +${esc(fmtDur(Date.parse(it.t) - first))} from the request</p>`);
  const r = S.lastRoute;
  if (r && r.alignment) {
    parts.push(`<div class="label">Router checks at ${esc(r.id || '')}</div><div class="checks">${CHECKS.map(([k, n], q) => { const v = r.alignment[k]; return `<span class="${v === true ? 'pass' : v === false ? (r.first_failing === k ? 'fail' : '') : ''}" title="${v === null ? 'not applicable yet' : v ? 'passes' : 'fails'}">${q + 1} ${esc(n)}</span>`; }).join('')}</div>`);
  }
  if (it && it.type === 'agents') parts.push(`<div class="label">Agents in this run</div>${agentRowsHtml(it.agents)}`);
  else if (def) {
    const here = LV.crew.filter((c) => c.item <= i && c.step === pos);
    if (here.length) parts.push(`<div class="label">Agents at ${esc(stepName(pos))} so far</div>${agentRowsHtml(here.slice(-8))}`);
  }
  if (it && it.type === 'result' && it.findings && it.findings.length) parts.push(`<div class="label">Findings</div>${findingsHtml(it.findings)}`);
  if (i === LV.items.length - 1 && job.running_agents && job.running_agents.length) parts.push(`<div class="label">Running now</div><div class="chips">${job.running_agents.map((a) => `<span class="chip agent">${esc(a.agent_type)}</span>`).join('')}</div>`);
  if (i === LV.items.length - 1 && job.stale_agents && job.stale_agents.length && job.status !== 'closed') parts.push(`<div class="label">Started, never reported back</div><div class="chips">${job.stale_agents.map((a) => `<span class="chip off" title="started ${esc(fmtDate(a.since))}; its session probably ended">${esc(a.agent_type)} · stale</span>`).join('')}</div>`);
  if (i === LV.items.length - 1 && job.pending_gate && job.pending_gate.id !== 'P') parts.push(`<div class="label">Your move</div><p>Reply <b>approve</b> or <b>deny &lt;what must change&gt;</b> in chat to answer ${esc(job.pending_gate.id)}.</p>`);
  if (i === LV.items.length - 1 && job.status === 'parked') parts.push(`<div class="label">Your move</div><p>Fix what the reason names, then reply <b>resume</b>.</p>`);
  $('#now').innerHTML = parts.join('');
}
function findingsHtml(list) {
  return `<div class="tblwrap"><table class="tbl"><tr><th>Lane</th><th>Severity</th><th>Status</th><th>Finding</th></tr>${list.map((f) => `<tr><td class="n">${esc(f.lane || '')}</td><td><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span></td><td class="stt ${esc(f.status || '')}">${esc(f.status || '')}${f.status === 'unverified' ? '<br><span class="label">blocking</span>' : ''}</td><td>${esc(f.summary)}${f.file ? ` <span class="mono">${esc(f.file)}${f.line ? `:${esc(f.line)}` : ''}</span>` : ''}${verifierNote(f) ? `<br><span class="vnote">${esc(verifierNote(f))}</span>` : ''}</td></tr>`).join('')}</table></div>`;
}
// what the finding-verifier said, when it said something: its verdict, its reason, its evidence
function verifierNote(f) {
  if (!f.verifier_status && !f.verification && !f.verification_evidence) return '';
  return `Verifier: ${f.verifier_status || 'no verdict'}${f.verification ? ` — ${f.verification}` : ''}${f.verification_evidence ? ` (evidence: ${f.verification_evidence})` : ''}`;
}
function paintStep(id) {
  const job = LV.job;
  const def = job.steps.find((s) => s.id === id);
  const i = LV.shown;
  const S = i >= 0 ? LV.states[i] : initState(job);
  const st = S.steps[id];
  const parts = [`<button type="button" class="back" id="back">← Now</button>`];
  parts.push(`<div class="nowtop"><span class="label">stage ${ORDER.indexOf(def.stage) + 1} · ${esc(STAGE_NAME[def.stage])}</span><span class="state-word w-${st.status}">${esc(WORD[st.status] || st.status)}</span></div>`);
  parts.push(`<h3>${esc(stepName(id))}</h3><p>${esc((STEP_INFO[id] || [, ''])[1])}</p>`);
  parts.push(`<p class="mono">${esc(def.run)}${def.lanes ? ` · lanes ${esc(def.lanes.join(', '))}` : ''}${st.visits ? ` · ${st.visits} visit${st.visits > 1 ? 's' : ''}` : ''}${st.note ? ` · ${esc(st.note)}` : ''}</p>`);
  if (st.text) parts.push(`<p>${esc(st.text)}</p>`);
  const here = LV.crew.filter((c) => c.item <= i && c.step === id);
  if (here.length) parts.push(`<div class="label">Agents (${here.length} runs)</div>${agentRowsHtml(here)}`);
  else if (def.kind === 'workflow') parts.push('<p>No agents have run here yet at this point in the replay.</p>');
  const evs = LV.items.map((it, k) => ({ it, k })).filter(({ it }) => (it.step || (it.type === 'route' ? it.raw_step : null)) === id);
  if (evs.length) parts.push(`<div class="label">Events here</div><ul class="log">${evs.map(({ it, k }) => logRow(it, k)).join('')}</ul>`);
  $('#now').innerHTML = parts.join('');
  $('#back').addEventListener('click', () => { LV.sel = null; LV.shown = -2; renderAt(LV.t); });
  $('#now').querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => seekItem(+b.dataset.k)));
}
function selectStep(id) {
  LV.sel = LV.sel === id ? null : id;
  LV.shown = -2;
  renderAt(LV.t);
  if (window.innerWidth < 1780) $('#now').scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
}

// ---------- log, scrubber, transport
