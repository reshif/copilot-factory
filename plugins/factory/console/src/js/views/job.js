function renderJList() {
  const ids = VISIBLE.length ? VISIBLE : [...MODELS.keys()];
  const cur = LV.job && LV.job.id;
  $('#jlist').innerHTML = `<div class="jlh"><span class="label">${ids.length} job${ids.length === 1 ? '' : 's'}</span><span class="hint2" aria-hidden="true"><kbd>j</kbd><kbd>k</kbd></span></div>${ids.map((id) => {
    const m = MODELS.get(id);
    if (!m) return '';
    return `<button type="button" class="jrow b-${m.bucket}" data-id="${esc(id)}" aria-current="${id === cur}" aria-label="${esc(rowLabel(m))}"><i class="beacon"></i><span class="bid">${esc(id)}${unreadOf(m) && id !== cur ? '<i class="unread"></i>' : ''}</span>${lampsHtml(m)}<span class="jt2">${esc(m.job.title)}</span><span class="jw2">${esc(m.bucket === 'turn' ? `Your turn · ${turnLabel(m)}` : m.sum[1])}</span></button>`;
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
    if ((g === 'H1' || g === 'EH1') && job.h1) parts.push(h1Html(job.h1));
    if (['H2', 'EH2', 'H3', 'HF'].includes(g) && job.gate_review) parts.push(gateReviewHtml(job.gate_review));
    // 0.11: what / how / where — decisions, the diagrams drawn, the layout with its owner tasks
    if (['H2', 'EH2', 'H3'].includes(g) && job.design) parts.push(designHtml(job.design));
    if (g && g !== 'P') { parts.push(reply(gateReply(job, g))); if (g !== 'H4') parts.push(reply(`deny ${job.id} <what must change>`)); }
    else parts.push(`<p>Reply to clarify in chat, in plain words${job.clarify && job.clarify.questions && job.clarify.questions.length ? ` (${job.clarify.questions.length} decision${job.clarify.questions.length === 1 ? '' : 's'} on the sheet): <code>ok</code> takes the recommendations, <code>ok, but 2 b</code> changes one` : ': <code>ok</code>, or what to change'}. The main session can record it too: <code>factory clarify reply "…"</code>.</p>`);
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
// At H1 / EH1, what clarify shows besides the contract (factory next's clarify_h1): the contract
// checked against your words, the decisions and who made them, what design may choose, research
// gaps, what was dropped (who, why), and God Eye's objections, which are never approval.
function h1Html(h) {
  const list = (head, items, note, cls) => (items && items.length ? `<div class="eh${cls ? ` ${cls}` : ''}">${esc(head)}</div>${note ? `<p class="meta">${esc(note)}</p>` : ''}<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : '');
  const checked = (h.checked || []).map((c) => `<span class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'}</span> “${esc(c.quote)}” → ${esc(c.where)}`);
  const decisions = (h.decisions || []).map((d) => `<b>${esc(d.item)}</b> ${esc(d.text)}: ${esc(d.value || '')} <span class="meta">(${esc(d.by)})</span>`);
  const redirects = (h.redirects || []).map((R) => `<b>${esc(R.id)}</b> ${R.done} of ${R.of} done: ${R.clauses.map((c) => `${c.done ? '✓' : '✗'} “${esc(c.quote)}”`).join('; ')}`);
  return `${list('God Eye objects', (h.god_eye_objects || []).map(esc), 'God Eye did not approve this contract; clarify could not settle these. Approve only to go on over them.', 'bad')}${list('Checked against what you said', checked)}${list('Decisions and who made them', decisions)}${list('Design may choose', (h.design_may_choose || []).map(esc))}${list('Your redirects', redirects)}${list('Research gaps', (h.gaps || []).map((g) => `${esc(g.what)}: ${esc(g.reason)}`), null, 'bad')}${list('Dropped', (h.dropped || []).map(esc))}${h.edited_by_hand ? '<p class="meta">You edited contract.md by hand; the readiness check ran on your text.</p>' : ''}`;
}
// At the design gate, or the combined design + plan + environment gate (0.10.0): what it approves,
// the critics' open objections (verified, with their evidence; never shown as approval), the API
// ledger quoted from the pinned dependency source, the plan probe's dry-run, and the environment
// approving it confirms.
function gateReviewHtml(r) {
  const list = (head, items, note, cls) => (items && items.length ? `<div class="eh${cls ? ` ${cls}` : ''}">${esc(head)}</div>${note ? `<p class="meta">${esc(note)}</p>` : ''}<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : '');
  const item = (i) => `<b>${esc(i.critic || '')}</b> [${esc(i.severity)}${i.verified ? `, ${esc(i.verified)}` : ''}] ${esc(i.issue)}${i.evidence ? ` <span class="src"><code>${esc(typeof i.evidence === 'string' ? i.evidence : `${i.evidence.ref || ''}${i.evidence.quote ? ` “${i.evidence.quote}”` : ''}`)}</code></span>` : ''}`;
  const dc = r.design_critique;
  const pc = r.plan_critique;
  const L = r.api_ledger;
  const P = r.probe;
  const E = r.environment;
  const parts = [];
  if (r.approves) parts.push(`<p class="meta">One approval covers: ${esc(r.approves.join(' + '))}.</p>`);
  if (dc) parts.push(list(`Design critics: ${dc.verdict}${dc.stop && dc.stop !== 'approved' ? ` (${dc.stop === 'no_progress' ? 'stopped: no progress' : dc.stop === 'critic_failed' ? 'a critic returned no result' : 'stopped at the ceiling'})` : ''}`, (dc.open || []).map(item), dc.open && dc.open.length ? `Open after ${dc.rounds} round(s)${dc.revised_after_last ? '; final revision not re-checked by the critics (the architect revised after the last critique)' : ''}: your call.` : null, dc.open && dc.open.length ? 'bad' : null));
  if (pc && (pc.open || []).length) parts.push(list(`Plan critique: ${pc.verdict}`, pc.open.map(item), null, 'bad'));
  if (L) parts.push(list(`API ledger: ${L.entries} verified quote(s) from the pinned source${L.rejected ? `, ${L.rejected} rejected` : ''}`, [...(L.symbols || []).map(esc), ...(L.gaps || []).map((g) => `<span class="bad">gap: ${esc(g)}</span>`)]));
  if (P) parts.push(list(`Plan probe: ${P.ok ? 'every verify command can run' : `${(P.problems || []).length} problem(s)`}${P.current ? '' : ' (for an earlier plan)'}`, [...(P.problems || []).map((x) => `<span class="bad">${esc(x)}</span>`), ...(P.commands || []).map(esc)]));
  if (E) parts.push(`<p class="meta">Build environment: <b>${esc(E.name || 'none')}</b> (${esc(E.status)})${(E.setup || []).length ? ` — setup: <code>${esc(E.setup.join(' && '))}</code>` : ''}${E.note ? `. ${esc(E.note)}` : ''}</p>`);
  return parts.join('');
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
// Clarify v3 (factory clarify status): where clarify is, every item with who decided it, every
// finding with its source and the CLI's verdict, the research gaps, drops and redirects.
const CL_STAGE = { readback: 'reading your words back', readback_wait: 'waiting for your ok on the read-back', research: 'researching', sheet_wait: 'waiting for your answer to the decision sheet', interpret: 'reading your sheet answer', redirect: 'reading your redirect', redirect_wait: 'waiting for your ok on the redirect', assemble: 'writing the contract', check: 'readiness check', dispute: 'checking a disputed objection', diagnose: 'diagnosing the readiness loop', ready: 'done: H1 next' };
const CL_STATUS = { open: 'open', to_decide: 'on the sheet', decided: 'decided', done: 'done', assumed: 'assumed', deferred: 'to design', dropped: 'dropped' };
const EV_WORD = { repo: 'repo, quote checked', pinned: 'docs for the confirmed version', docs: 'docs (no version to pin)', other_version: 'documents another version: not used', unpinned: 'a moving page (stable/latest): not used', bad_quote: 'quote not at the cited line: not used', unsourced: 'no source quote: not used' };
function clarifyHtml(job) {
  const c = job.clarify;
  if (!c || c.version !== 3 || !(c.items || []).length) return '';
  const t = c.totals || {};
  const rows = c.items.map((r) => `<tr class="cl-${esc(r.status)}"><td class="n">${esc(r.id)}</td><td>${esc(r.text)}${r.value && r.value !== r.text ? `<br><span class="meta">${esc(r.value)}</span>` : ''}</td><td class="n">${esc(r.kind)}</td><td><span class="stt ${['decided', 'done'].includes(r.status) ? 'done' : r.status === 'to_decide' ? 'you' : ''}">${esc(CL_STATUS[r.status] || r.status)}</span></td><td>${esc(r.by || '—')}</td></tr>`).join('');
  const qs = (c.questions || []).length ? `<div class="eh">Waiting on you (one reply answers them all)</div><ul>${c.questions.map((q) => `<li><b>${esc(q.id)}</b> ${esc(q.question)}${q.recommendation ? ` <span class="meta">recommended: ${esc(q.recommendation)}</span>` : ''}</li>`).join('')}</ul><div class="reply"><code>factory clarify reply "ok"</code><code>factory clarify reply "ok, but 2 b"</code></div>` : '';
  const ev = (c.evidence || []).filter((e) => e.claim);
  const evh = ev.length ? `<div class="eh">What research found</div><ul>${ev.map((e) => `<li${e.usable ? '' : ' class="unv"'}><b>${esc(e.id)}</b> ${e.usable ? esc(e.claim) : `“${esc(e.claim)}”`} <span class="src"><code>${esc(e.source)}</code>${e.version ? ` · ${esc(e.version)}` : ''}${e.retrieved_at ? ` · ${esc(e.retrieved_at)}` : ''} · ${esc(EV_WORD[e.verdict] || e.verdict || 'not judged yet')}</span></li>`).join('')}</ul>` : '';
  const pins = (c.pins || []).length ? `<p class="meta">Versions research is pinned to: ${c.pins.map((p) => `${esc(p.text)} (${esc(p.by)})`).join(', ')}.</p>` : '';
  const gaps = (c.gaps || []).length ? `<div class="eh bad">Research gaps (what it could not find out)</div><ul>${c.gaps.map((f) => `<li class="unv">${esc(f.what)}: ${esc(f.reason)}</li>`).join('')}</ul>` : '';
  const drops = (c.dropped || []).length ? `<div class="eh">Dropped (you can reopen any of them)</div><ul>${c.dropped.map((d) => `<li><b>${esc(d.id)}</b> <s>${esc(d.text)}</s> <span class="meta">dropped by ${esc(d.actor || 'unknown')}: ${esc(d.reason || 'no reason recorded')}</span></li>`).join('')}</ul>` : '';
  const red = (c.redirects || []).length ? `<p class="meta">Redirects: ${c.redirects.map((R) => `${esc(R.id)} (${esc(R.status)}, ${R.clauses} clause${R.clauses === 1 ? '' : 's'})`).join(', ')}.</p>` : '';
  const mig = c.migration ? `<p class="meta">Migrated from clarify v${esc(c.migration.from)}: ${esc(c.migration.summary)}.</p>` : '';
  return `<article class="para clarify"><div class="ph"><h4>Clarify</h4><span class="tm">${esc(CL_STAGE[c.stage] || c.stage)} · ${t.items} items · ${t.decided} decided, ${t.assumed} assumed, ${t.deferred} to design, ${t.open} open · ${c.passes} research pass${c.passes === 1 ? '' : 'es'} · ${c.checks} readiness check${c.checks === 1 ? '' : 's'}</span></div>${qs}${pins}<div class="tblwrap"><table class="tbl cltbl"><tr><th>Item</th><th>What</th><th>Kind</th><th>Status</th><th>Decided by</th></tr>${rows}</table></div>${evh}${gaps}${drops}${red}${mig}</article>`;
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
  const out = [nowCard(job), clarifyHtml(job)];
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
        case 'result': if (it.research && it.research.unknowns) RS.push(researchHtml(it.research)); S.push(it.ok ? `<span class="ok">✓ ${esc(it.text)}.</span>` : it.outcome === 'ask' ? `<b class="y">? ${esc(it.text)}.</b>` : `<span class="bad">✕ ${esc(it.text)}.</span>`); for (const f of (it.findings || []).filter((x) => x.status === 'confirmed')) S.push(`<span class="bad">Confirmed ${esc(f.severity)} finding ${esc(f.id)}: ${esc(f.summary)}.</span>`); for (const f of (it.findings || []).filter((x) => x.status === 'unverified')) S.push(`<b class="y">Unverified ${esc(f.severity)} finding ${esc(f.id)}, still blocking: ${esc(f.summary)}.</b>${verifierNote(f) ? ` <span class="q">${esc(verifierNote(f))}.</span>` : ' No verifier settled it.'}`); break;
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
        case 'clarify': S.push(it.waiting ? `<b class="y">? ${esc(it.text)}.</b>` : it.outcome === 'park' ? `<span class="bad">${esc(it.text)}.</span>` : `${esc(it.text)}.`); break;
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
