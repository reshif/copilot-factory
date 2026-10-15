function siglegend() {
  const items = [['done', 'v', 'clear'], ['running', 'v', 'running'], ['waiting', 'ped', 'your turn (flashing)'], ['failed', 'v', 'stopped · blocked'], ['pending', 'v', 'ahead'], ['skipped', 'v', 'not needed']];
  $('#siglegend').innerHTML = items.map(([s, , w], k) => `<span><svg width="${18}" height="${44}" viewBox="-3 -3 20 46" id="lg${k}" aria-hidden="true"></svg>${esc(w)}</span>`).join('')
    + '<span class="mono">agents: <span class="mdot opus" style="display:inline-grid;width:14px;height:14px;border-radius:3px;place-items:center;color:#fff;font:700 9px var(--mono);vertical-align:middle">O</span> opus <span class="mdot sonnet" style="display:inline-grid;width:14px;height:14px;border-radius:3px;place-items:center;color:#fff;font:700 9px var(--mono);vertical-align:middle">S</span> sonnet <span class="mdot haiku" style="display:inline-grid;width:14px;height:14px;border-radius:3px;place-items:center;color:#fff;font:700 9px var(--mono);vertical-align:middle">H</span> haiku · ×runs ↻retries ✕failed ↑escalated</span>';
  items.forEach(([s, kind], k) => {
    const host = $(`#lg${k}`);
    if (kind === 'ped') { host.setAttribute('viewBox', '-3 -12 26 46'); }
    const g = signal(host, kind, 0, 0);
    setSig(g, s);
  });
}
function renderHead(job) {
  $('#j-title').textContent = `${job.id} · ${job.title}`;
  const S = LV.states[LV.states.length - 1];
  const sum = jobSummary(job, S);
  const models = Object.entries(job.models || {});
  $('#j-meta').innerHTML = [
    `<span>recipe <b class="mono">${esc(job.recipe)}</b></span>`,
    `<span>${esc(job.work_type)} · ${esc(job.risk)} risk</span>`,
    `<span class="w-${sum[0]}"><b>${esc(sum[1])}</b></span>`,
    `<span>opened ${esc(fmtDate(job.created_at))}</span>`,
    job.pr ? `<span>${job.pr.mode === 'github' ? 'PR' : 'local merge'}${job.pr.merged ? ' · merged' : ''}</span>` : '',
    models.length ? `<span title="policy.agents.models">models: ${esc(models.map(([r, m]) => `${r}=${m}`).join(', '))}${job.escalation && job.escalation.length ? ` · builder retries → ${esc(job.escalation.join(', '))}` : ''}</span>` : '<span>models: session default</span>',
  ].join('');
  $('#odo').innerHTML = '';
}
function renderBelow(job) {
  const S = LV.states[LV.states.length - 1];
  const tasks = job.tasks || [];
  const lastChallenge = [...LV.items].reverse().find((x) => x.type === 'result' && x.findings);
  const crew = crewAt(LV.items.length, null).sort((a, b) => b.n - a.n);
  const totalMs = crew.reduce((n, a) => n + a.ms, 0);
  const html = [];
  html.push(`<section class="panel"><h3>Crew used</h3>${crew.length ? `<div class="tblwrap"><table class="tbl"><tr><th>Agent</th><th>Runs</th><th>Model</th><th>Retries</th><th>Failed</th><th>Time</th></tr>${crew.map((a) => `<tr><td class="n">${esc(a.role)}</td><td class="n">${a.n}</td><td class="n">${esc(a.models.join(' → ') || 'session')}</td><td class="n">${a.retries || ''}</td><td class="n">${a.fails ? `<span class="stt fail">${a.fails}</span>` : ''}</td><td class="n">${a.ms ? esc(fmtDur(a.ms)) : '—'}</td></tr>`).join('')}</table></div><p class="label">${crew.reduce((n, a) => n + a.n, 0)} runs · ${crew.length} agent types${totalMs ? ` · ${esc(fmtDur(totalMs))} of agent time` : ''}</p>` : '<p class="lede" style="margin:0">No agents have run for this job yet.</p>'}</section>`);
  if (tasks.length) html.push(`<section class="panel"><h3>Tasks</h3><div class="tblwrap"><table class="tbl"><tr><th>Task</th><th>Objective</th><th>Tries</th><th>Outcome</th></tr>${tasks.map((t) => `<tr><td class="n">${esc(t.id)}${t.depends_on.length ? `<br><span class="label">after ${esc(t.depends_on.join(', '))}</span>` : ''}</td><td>${esc(t.objective)}</td><td class="n">${t.attempts || '—'}</td><td class="stt ${t.outcome === 'done' ? 'done' : t.outcome ? 'fail' : ''}">${esc(t.outcome || 'not started')}</td></tr>`).join('')}</table></div></section>`);
  if (lastChallenge) html.push(`<section class="panel"><h3>Latest review</h3><p>${esc(lastChallenge.text)}</p>${findingsHtml(lastChallenge.findings)}</section>`);
  if ((job.lessons || []).length) html.push(`<section class="panel"><h3>Lessons</h3>${job.lessons.map((l) => `<p><span class="mono">${esc(l.id)} · ${esc(l.status)}</span><br>${esc(l.text)}</p>`).join('')}</section>`);
  if ((job.inspector || []).length) html.push(`<section class="panel"><h3>Inspector</h3><p>An independent audit of this job against the rulebook it promised to follow. Findings are questions for you, not blocks.</p><div class="tblwrap"><table class="tbl"><tr><th>Finding</th><th>Severity</th><th>What it saw</th><th>Status</th></tr>${job.inspector.map((f) => `<tr><td class="n">${esc(f.id)}<br><span class="label">${esc(f.rule)}</span></td><td><span class="sev ${f.severity === 'high' || f.severity === 'critical' ? 'major' : 'minor'}">${esc(f.severity)}</span></td><td>${esc(f.summary)}<br><span class="label" style="text-transform:none;letter-spacing:0">${esc(f.question)}</span></td><td class="stt">${esc(f.status)}</td></tr>`).join('')}</table></div><p class="label" style="text-transform:none;letter-spacing:0">Settle one by replying in chat: <code>ack finding ${esc(job.inspector[0].id)}</code>, <code>fixed finding ${esc(job.inspector[0].id)}</code> or <code>wontfix finding ${esc(job.inspector[0].id)} &lt;why&gt;</code>.</p></section>`);
  if (S.guards) html.push(`<section class="panel"><h3>Guard</h3><p>The guard hook blocked ${S.guards} tool call(s) during this job. They show in the event log.</p></section>`);
  $('#below').innerHTML = html.join('');
}
// ===================================================================== switchboard
