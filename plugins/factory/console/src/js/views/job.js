function renderJList() {
  const ids = VISIBLE.length ? VISIBLE : [...MODELS.keys()];
  const cur = LV.job && LV.job.id;
  $('#jlist').innerHTML = `<div class="jlh"><span class="label">${ids.length} job${ids.length === 1 ? '' : 's'}</span><span class="hint2" aria-hidden="true"><kbd>j</kbd><kbd>k</kbd></span></div>${ids.map((id) => {
    const m = MODELS.get(id);
    if (!m) return '';
    return `<button type="button" class="jrow b-${m.bucket}" data-id="${esc(id)}" aria-current="${id === cur}" aria-label="${esc(rowLabel(m))}"><i class="beacon"></i><span class="bid">${esc(id)}${unreadOf(m) && id !== cur ? '<i class="unread"></i>' : ''}</span>${lampsHtml(m)}<span class="jt2">${esc(m.job.title)}</span><span class="jw2">${esc(m.bucket === 'turn' ? `Your turn · ${m.gate ? stepName(m.gate) : m.stepLabel}` : m.sum[1])}</span></button>`;
  }).join('')}`;
  $('#jlist').querySelectorAll('.jrow').forEach((b) => b.addEventListener('click', () => openJob(b.dataset.id, { user: true })));
  const on = $('#jlist').querySelector('[aria-current="true"]');
  if (on) { const l = $('#jlist'); const t = on.offsetTop; if (t < l.scrollTop + 40 || t > l.scrollTop + l.clientHeight - 50) l.scrollTop = t - 120; }
}
function setJobTab(tab, { keep } = {}) {
  UI.jobTab = tab;
  document.querySelectorAll('.jtabs [data-jt]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.jt === tab)));
  $('#live-body').hidden = tab !== 'line';
  for (const t of ['story', 'tasks', 'events', 'lessons']) $(`#jt-${t}`).hidden = t !== tab;
  if (tab === 'line') { applyZoom(); if (!keep) renderAt(LV.t); } else stopPlay();
  paintJobTab();
  saveHash();
}
function paintJobTab() {
  const job = LV.job;
  if (!job) return;
  $('#n-tasks').textContent = (job.tasks || []).length || '';
  $('#n-events').textContent = job.timeline.length;
  $('#n-lessons').textContent = (job.lessons || []).length || '';
  if (UI.jobTab === 'story') renderStory();
  else if (UI.jobTab === 'tasks') renderTasks();
  else if (UI.jobTab === 'events') renderEvents();
  else if (UI.jobTab === 'lessons') renderLessons();
}
function nowCard(job) {
  const m = MODELS.get(job.id);
  if (!m || m.bucket === 'done') return '';
  const reply = (txt) => `<div class="reply"><code>${esc(txt)}</code><button type="button" class="copy" data-copy="${esc(txt)}">Copy</button></div>`;
  const parts = [];
  if (m.bucket === 'turn') {
    const g = m.gate || job.pending_gate && job.pending_gate.id;
    parts.push(`<div class="nk"><i class="beacon" style="--bk:var(--sig-amber)"></i>Now · your turn</div>`);
    parts.push(`<p>The job waits on you at <b>${esc(g ? `${g} · ${stepName(g).replace(/^\S+ · /, '')}` : m.stepLabel)}</b>, and has for <b data-since="${m.waitSince || ''}">${esc(fmtDur(nowMs() - (m.waitSince || m.updated)))}</b>. ${esc((STEP_INFO[g] || [, ''])[1])} Reply in the Copilot CLI:</p>`);
    if (g && g !== 'P') { parts.push(reply(gateReply(job, g))); if (g !== 'H4') parts.push(reply(`deny ${job.id} <what must change>`)); }
    else parts.push('<p>Answer the questions in chat; the round runs again with your answers.</p>');
  } else if (m.bucket === 'parked') {
    parts.push(`<div class="nk"><i class="beacon" style="--bk:var(--skill)"></i>Now · parked</div><p>${esc((job.park && job.park.reason) || 'Parked.')} Fix what the reason names, then reply:</p>${reply(`resume ${job.id}`)}`);
  } else if (m.bucket === 'stopped') {
    parts.push(`<div class="nk"><i class="beacon" style="--bk:var(--sig-red)"></i>Now · ${esc(m.sum[1].toLowerCase())}</div><p>${job.status === 'active' ? `${esc(m.sum[1])}. The router will send it back or park it; nothing is needed from you yet.` : `This job is ${esc(job.status)} and stays off the line.`}</p>`);
  } else {
    const ra = job.running_agents || [];
    parts.push(`<div class="nk"><i class="beacon" style="--bk:var(--live)"></i>Now · running</div><p><b>${esc(m.stepLabel)}</b> is running${ra.length ? ` with ${ra.length} agent${ra.length === 1 ? '' : 's'} on the floor (${esc(ra.map((a) => roleShort(a.agent_type)).join(', '))})` : ''}. Nothing is needed from you.${(job.stale_agents || []).length ? ` ${job.stale_agents.length} agent(s) started earlier never reported back; their session probably ended.` : ''}</p>`);
  }
  return `<div class="nowcard b-${m.bucket}">${parts.join('')}</div>`;
}
function agentsProse(agents) {
  const cs = chipsFor(agents);
  const fam = (mm) => ({ opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' })[modelFamily(mm)] || mm;
  return cs.map((c) => `${c.n > 1 ? `${c.n}× ` : ''}${c.role}${c.models.length ? ` on ${c.models.map(fam).join(' then ')}` : ''}${c.retries ? ` (${c.retries} retr${c.retries === 1 ? 'y' : 'ies'})` : ''}${c.fails ? ` (${c.fails} failed)` : ''}`).join(', ');
}
// Grounded intent in the Story: what clarify's scout phase researched, found and assumed.
// Only confirmed findings (and repo evidence) read as fact; the others say what they are.
const VERDICT_WORD = { confirmed: 'confirmed', contradicted: 'contradicted by another source', unverified: 'not verified', unchecked: 'repo, not re-checked' };
function researchHtml(x) {
  const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const web = x.web === 'off' ? ' Web research is off for this repository.' : x.web === 'unavailable' ? ' The scouts had no web access, so world facts were not verified.' : '';
  const reused = !x.scouts && !x.verifiers;
  const kinds = Object.entries(x.by_kind || {}).map(([k, n]) => `${n} ${k}`).join(', ');
  const H = [`<p class="lead"><b>${reused ? 'Research.' : 'Research first.'}</b> ${reused
    ? `Reused the earlier research: ${pl(x.unknowns, 'unknown')}, ${pl(x.evidence, 'finding')} (${x.confirmed} confirmed); nothing new to look up.`
    : `The intent mapper listed ${pl(x.unknowns, 'unknown')}${kinds ? ` (${esc(kinds)})` : ''}; ${pl(x.scouts, 'scout')} researched them${x.verifiers ? ' and the verifier re-checked the findings' : ''}: ${pl(x.evidence, 'finding')}, ${x.confirmed} confirmed.`}${web}${(x.degraded || []).length ? ` <span class="bad">Degraded: ${esc(x.degraded.join(', '))}.</span>` : ''}</p>`];
  const fs = (x.findings || []).filter((f) => f.claim);
  if (fs.length && !reused) {
    H.push(`<div class="eh">What it found</div><ul>${fs.map((f) => {
      const fact = f.verdict === 'confirmed' || f.verdict === 'unchecked';
      return `<li${fact ? '' : ' class="unv"'}><b>${esc(f.id)}</b> ${fact ? esc(f.claim) : `“${esc(f.claim)}” — ${esc(VERDICT_WORD[f.verdict] || f.verdict || 'unchecked')}, not stated as fact`} <span class="src"><code>${esc(f.source)}</code>${f.retrieved_at ? ` · ${esc(f.retrieved_at)}` : ''}${fact ? ` · ${esc(VERDICT_WORD[f.verdict])}${f.confidence ? `, ${esc(f.confidence)}` : ''}` : ''}</span></li>`;
    }).join('')}</ul>`);
  }
  const as = x.assumptions_list || [];
  if (reused && as.some((a) => a.overridden)) H.push(`<ul>${as.filter((a) => a.overridden).map((a) => `<li class="ovr"><b>${esc(a.id)}</b> <s>${esc(a.statement)}</s> <b class="y">overridden by you${a.value ? `: “${esc(a.value)}”` : ''}</b></li>`).join('')}</ul>`);
  if (as.length && !reused) H.push(`<div class="eh">Assumed, not asked</div><ul>${as.map((a) => a.overridden ? `<li class="ovr"><b>${esc(a.id)}</b> <s>${esc(a.statement)}</s> <b class="y">overridden by you${a.value ? `: “${esc(a.value)}”` : ''}</b></li>` : `<li><b>${esc(a.id)}</b> ${esc(a.statement)} <span class="src">evidence ${esc((a.evidence || []).join(', '))}</span></li>`).join('')}</ul>`);
  const asked = x.asked || [];
  if (asked.length) H.push(`<p>Asked you ${asked.length === 1 ? 'one question' : `${asked.length} questions`}: ${asked.map((q) => `${esc(q.id)}${q.researchable ? ` <span class="bad">(research could not settle it: ${esc(q.reason)})</span>` : q.evidence && q.evidence.length ? ` (default backed by ${esc(q.evidence.join(', '))})` : ' (your call)'}`).join(', ')}.</p>`);
  if (x.researchable_dropped) H.push(`<p>${pl(x.researchable_dropped, 'question')} research had already answered ${x.researchable_dropped === 1 ? 'was' : 'were'} not asked.</p>`);
  return `<div class="evid">${H.join('')}</div>`;
}
function renderStory() {
  const job = LV.job;
  const items = LV.items;
  const rows = LV.rows;
  const t0 = Date.parse(items[0].t);
  const anchored = new Map();
  for (const f of job.inspector || []) {
    let k = f.anchor_decision ? items.findIndex((it) => it.type === 'route' && it.id === f.anchor_decision) : -1;
    if (k < 0 && f.anchor_t) { const at = Date.parse(f.anchor_t); for (let q = 0; q < items.length; q++) if (Date.parse(items[q].t) <= at + 1000) k = q; }
    if (k < 0) k = items.length - 1;
    const r = LV.rowOf[k];
    (anchored.get(r) || anchored.set(r, []).get(r)).push(f);
  }
  const out = [nowCard(job)];
  rows.forEach((row, r) => {
    const first = items[row.first];
    const tm = Date.parse(first.t);
    const nextT = rows[r + 1] ? Date.parse(items[rows[r + 1].first].t) : null;
    const [title, tags] = rowTitle(job, row);
    const def = job.steps.find((s) => s.id === row.step);
    const gate = def && (def.human || def.kind === 'gate') && row.kind === 'stop';
    const S = [];
    const RS = [];
    const it0 = items[row.first];
    if (row.kind === 'start') S.push(`You asked for <span class="q">“${esc(job.title)}”</span>. It was filed as ${esc(job.work_type || 'work')} at <b>${esc(job.risk)}</b> risk${job.risk_proposed && job.risk_proposed !== job.risk ? ` (proposed ${esc(job.risk_proposed)})` : ''}, so the CLI chose the <code>${esc(job.recipe)}</code> recipe by rule.`);
    else if (row.kind === 'stop') {
      const why = RULES[row.rule] || row.rule || '';
      if (row.back) S.push(`<span class="bad">The router sent the job back to ${esc(stepName(row.step))}</span>: ${esc(why.charAt(0).toLowerCase() + why.slice(1))}.`);
      else if (row.rule === 'order.next_step') S.push(`Every check passed, so the router moved on to the recipe's next step${gate ? ', a gate where you decide' : ''}.`);
      else if (why) S.push(`${esc(why)}, so the router chose ${esc(stepName(row.step))}.`);
      if (it0.reason && it0.reason !== why) S.push(`Its note: <span class="q">“${esc(it0.reason)}”</span>.`);
    } else if (row.kind === 'park') S.push('');
    else if (row.kind === 'resume') S.push('');
    else if (row.kind === 'finish') S.push(`The job came off the line ${esc(fmtDate(job.closed_at || first.t))}${job.pr && job.pr.merged ? ', merged' : ''}, ${esc(fmtDur(tm - t0))} after you asked.`);
    for (const i of row.items) {
      const it = items[i];
      if (i === row.first && !['park', 'amend', 'stopped'].includes(it.type)) continue;
      const after = fmtDur(Date.parse(it.t) - tm);
      switch (it.type) {
        case 'agents': S.push(`${esc(it.workflow ? `${it.workflow}${it.config ? ` (${it.config})` : ''}` : 'The hooks saw')} ran ${it.runs} agent run${it.runs === 1 ? '' : 's'}: ${esc(agentsProse(it.agents))}, done ${esc(after)} in.`); break;
        case 'result': if (it.research && it.research.unknowns) RS.push(researchHtml(it.research)); S.push(it.ok ? `<span class="ok">✓ ${esc(it.text)}.</span>` : it.outcome === 'ask' ? `<b class="y">? ${esc(it.text)}.</b>` : `<span class="bad">✕ ${esc(it.text)}.</span>`); for (const f of (it.findings || []).filter((x) => x.status === 'confirmed')) S.push(`<span class="bad">Confirmed ${esc(f.severity)} finding ${esc(f.id)}: ${esc(f.summary)}.</span>`); break;
        case 'human': {
          const g = it.gate || stepName(it.step);
          if (it.action === 'approve') S.push(`<b class="y">You approved ${esc(g)}</b>${it.via ? ` (${esc(it.via)})` : ''}, ${esc(after)} after it was put to you.`);
          else if (it.action === 'deny') S.push(`<b class="y">You asked for changes at ${esc(g)}</b>${it.reason ? `: <span class="q">“${esc(it.reason)}”</span>` : ''}, after ${esc(after)}.`);
          else if (it.action === 'merged') S.push(`<b class="y">You merged it</b>${it.commit ? ` at <code>${esc(it.commit)}</code>` : ''}, ${esc(after)} after the pull request was ready.`);
          else if (it.action === 'resume') { const pk = rows[r - 1] && rows[r - 1].kind === 'park' ? Date.parse(items[rows[r - 1].first].t) : null; S.push(`<b class="y">You resumed the job</b>${pk ? ` after ${esc(fmtDur(Date.parse(it.t) - pk))} parked` : ''}.`); }
          else if (it.action === 'cancelled' || it.action === 'abandoned') S.push(`<b class="y">You ${esc(it.action === 'cancelled' ? 'cancelled' : 'abandoned')} the job</b>${it.reason ? `: <span class="q">“${esc(it.reason)}”</span>` : ''}.`);
          else if (it.action === 'change_assumption') S.push(`<b class="y">You overrode ${esc(it.assumption || 'an assumption')}</b>${it.value ? `: <span class="q">“${esc(it.value)}”</span>` : ''}${it.was ? ` (research said: ${esc(it.was)})` : ''}, so the contract changed and clarify checked it again.`);
          else if (it.action === 'drop_assumption') S.push(`<b class="y">You dropped ${esc(it.assumption || 'an assumption')}</b>${it.was ? ` (${esc(it.was)})` : ''}, so the contract changed.`);
          else S.push(`<b class="y">You: ${esc(it.action)}</b>${it.reason ? ` — ${esc(it.reason)}` : ''}.`);
          break;
        }
        case 'park': S.push(`<span style="color:var(--skill)">⏸ The job was parked: ${esc(it.text)}.</span>`); break;
        case 'stopped': S.push(`<span class="bad">${esc(it.text)}.</span>`); break;
        case 'amend': S.push(`✎ ${esc(it.text)}.`); break;
        case 'spawn': S.push(`⇢ ${esc(it.text)}.`); break;
        case 'guard': S.push(`<span class="bad">⚠ ${esc(it.text)}${it.who ? `, by ${esc(it.who)}` : ''}.</span>`); break;
        case 'refused': case 'error': S.push(`<span class="bad">${esc(it.text)}.</span>`); break;
        case 'route': if (it.action === 'parked') S.push(`<span class="bad">The router parked the job: ${esc(RULES[it.rule] || it.rule)}.</span>`); break;
        default: break;
      }
    }
    if (nextT && row.kind === 'stop' && gate && !row.items.some((i) => items[i].type === 'human')) S.push(`It waited ${esc(fmtDur(nextT - tm))} for you.`);
    const cls = `para${row.back || row.kind === 'amend' ? ' rtn' : ''}${row.kind === 'park' ? ' park' : ''}${gate ? ' gate you' : ''}`;
    const ret = row.back ? `<span class="rt2">${esc(tags[0] || 'back')}</span>` : row.kind === 'amend' ? '<span class="rt2">amendment</span>' : '';
    out.push(`<article class="${cls}" data-i="${row.first}"><div class="ph"><h4>${esc(title)}</h4>${ret}<span class="tm">${esc(fmtDate(first.t))} · +${esc(fmtDur(tm - t0))}${nextT ? ` · ${esc(fmtDur(nextT - tm))} here` : ''}</span></div><p>${S.filter(Boolean).join(' ')}</p>${RS.join('')}</article>`);
    for (const f of anchored.get(r) || []) out.push(`<aside class="mnote"><b>⚑ Inspector ${esc(f.id)} · ${esc(f.severity)} · ${esc(f.status)}</b>${esc(f.summary)}${f.question ? `<br><span style="color:var(--muted)">${esc(f.question)}</span>` : ''}</aside>`);
  });
  $('#jt-story').innerHTML = `<div class="story">${out.join('')}</div>`;
  bindCopies($('#jt-story'));
}
function renderTasks() {
  const job = LV.job;
  const tasks = job.tasks || [];
  const m = MODELS.get(job.id);
  $('#jt-tasks').innerHTML = tasks.length
    ? `<p class="lede" style="margin:0 0 12px">${m.tasksPassed} of ${tasks.length} task${tasks.length === 1 ? '' : 's'} passed their own verify. Each runs in its own worktree; only <code>factory task verify</code> produces evidence.</p><div class="tblwrap"><table class="tbl"><tr><th>Task</th><th>Objective</th><th>After</th><th>Tries</th><th>Evidence</th><th>Outcome</th></tr>${tasks.map((t) => `<tr class="taskrow"><td class="n">${esc(t.id)}</td><td>${esc(t.objective)}</td><td class="n">${esc((t.depends_on || []).join(', ') || '—')}</td><td class="n">${t.attempts || '—'}${t.attempts > 1 ? ' <span class="stt fail">↻</span>' : ''}</td><td><span class="tbar" style="width:70px"><i style="width:${t.pass ? 100 : t.pass === false ? 30 : 0}%;${t.pass === false ? 'background:var(--stop)' : ''}"></i></span></td><td class="stt ${t.outcome === 'done' ? 'done' : t.outcome ? 'fail' : ''}">${esc(t.outcome || 'not started')}</td></tr>`).join('')}</table></div>`
    : '<p class="lede">No plan yet: tasks appear once the plan is validated (or, for bug@low, written straight from the contract).</p>';
}
const EV = { q: '', type: '' };
function renderEvents() {
  const items = LV.items.slice(0, -1);
  const t0 = items[0] ? Date.parse(items[0].t) : 0;
  const types = [...new Set(items.map((x) => x.type))];
  const q = EV.q.toLowerCase();
  const rows = items.map((it, k) => ({ it, k })).filter(({ it }) => (!EV.type || it.type === EV.type) && (!q || JSON.stringify(it).toLowerCase().includes(q)));
  const host = $('#jt-events');
  const had = host.querySelector('input');
  if (!had) {
    host.innerHTML = `<div class="evbar"><input type="search" id="ev-q" placeholder="Filter events" aria-label="Filter events"><span class="segb" role="group" aria-label="Type" id="ev-types"></span><span class="label" id="ev-n"></span></div><div class="tblwrap" id="ev-t"></div>`;
    $('#ev-q').addEventListener('input', (e) => { EV.q = e.target.value; renderEvents(); });
  }
  $('#ev-types').innerHTML = ['', ...types].map((t) => `<button type="button" data-t="${t}" aria-pressed="${EV.type === t}">${t || 'all'}</button>`).join('');
  $('#ev-types').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { EV.type = b.dataset.t; renderEvents(); }));
  $('#ev-n').textContent = `${rows.length} of ${items.length}`;
  $('#ev-t').innerHTML = `<table class="tbl"><tr><th>When</th><th>+</th><th>Type</th><th>Step</th><th>What</th></tr>${rows.map(({ it, k }) => { const [h, sub] = describe(it); return `<tr class="clk2" data-k="${k}" tabindex="0"><td class="n">${esc(fmtDate(it.t))}</td><td class="n">${esc(fmtDur(Date.parse(it.t) - t0))}</td><td class="n">${esc(it.type)}${it.action ? ` · ${esc(it.action)}` : ''}</td><td class="n">${esc(it.step || it.raw_step || '')}</td><td><b style="font-weight:600">${esc(h)}</b>${sub ? `<br><span style="color:var(--muted)">${esc(sub)}</span>` : ''}</td></tr>`; }).join('')}</table>`;
  $('#ev-t').querySelectorAll('tr[data-k]').forEach((tr) => {
    const go = () => { setJobTab('line'); seekItem(+tr.dataset.k); };
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}
function renderLessons() {
  const job = LV.job;
  const ls = job.lessons || [];
  $('#jt-lessons').innerHTML = ls.length
    ? `<p class="lede" style="margin:0 0 12px">Lessons proposed from what went wrong in this job. Nothing is learned without you.</p>${ls.map((l) => `<section class="panel" style="padding:12px 14px;margin-bottom:10px;display:grid;gap:8px"><div><span class="kindtag ${l.status === 'accepted' ? 'k-workflow' : l.status === 'rejected' ? 'k-artifact' : 'k-you'}">${esc(l.id)} · ${esc(l.status)}</span></div><p style="margin:0">${esc(l.text)}</p>${l.status === 'proposed' ? `<div class="reply"><code>accept lesson ${esc(l.id)}</code><button type="button" class="copy" data-copy="accept lesson ${esc(l.id)}">Copy</button><code>reject lesson ${esc(l.id)} &lt;why&gt;</code></div>` : ''}</section>`).join('')}`
    : '<p class="lede">No lessons from this job (yet). Distill proposes them from confirmed findings and verify-fix rounds near the end of the line.</p>';
  bindCopies($('#jt-lessons'));
}

// ---------- seen / unread
