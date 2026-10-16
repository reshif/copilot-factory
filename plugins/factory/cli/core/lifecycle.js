'use strict';
// Closing jobs, follow-ups, distill bookkeeping and `factory why`.

const { readJson, nowIso, fail } = require('../lib/util');
const { jobPaths, taskWorktree } = require('../lib/paths');
const git = require('../lib/git');
const job = require('./job');
const steps = require('./steps');
const floors = require('./floors');
const ledger = require('./ledger');
const decisions = require('./decisions');
const contractMod = require('./contract');

function finalize(root, { jobId, mode = 'full' }) {
  const state = job.resolve(root, jobId);
  const ctx = steps.context(root, state, job.load);
  return { job: state.id, ...floors.evaluate(ctx, mode) };
}

function cleanup(root, state) {
  const plan = readJson(jobPaths(root, state.id).plan, { tasks: [] });
  const envMod = require('./environment');
  const torn = (r) => r && require('./events').append(root, { event: 'environment_teardown', job: state.id, cmd: r.cmd, code: r.code });
  for (const t of plan.tasks || []) {
    // what the build environment started for this worktree (a compose project…), then the worktree
    torn(envMod.teardown(root, state, { taskId: t.id, wt: taskWorktree(root, state.id, t.id) }));
    git.run(root, ['worktree', 'remove', '--force', taskWorktree(root, state.id, t.id)], { allowFail: true });
    git.run(root, ['branch', '-D', steps.taskBranch(state, t.id)], { allowFail: true });
  }
  torn(envMod.teardown(root, state, { taskId: null, wt: jobPaths(root, state.id).worktree }));
  git.run(root, ['worktree', 'remove', '--force', jobPaths(root, state.id).worktree], { allowFail: true });
  git.run(root, ['worktree', 'prune'], { allowFail: true });
}

function close(root, { jobId }) {
  const state = job.resolve(root, jobId);
  const ctx = steps.context(root, state, job.load);
  const fl = floors.evaluate(ctx, 'full');
  if (!fl.ok) {
    const hint = fl.missing.includes('ci_reverify')
      ? ' For a local merge, run factory ci verify to re-verify the merge result (or reply "waive ci_reverify <reason>").'
      : '';
    fail(`Cannot close ${state.id}: floors not met: ${fl.missing.join(', ')}.${hint}`, 'floor', fl);
  }
  const notDone = ctx.recipe.steps.filter((s) => s.step !== 'close' && !steps.isDone(ctx, s)).map((s) => s.step);
  if (notDone.length) fail(`Cannot close ${state.id}: steps not done: ${notDone.join(', ')}`, 'not_ready');
  if (state.branch) cleanup(root, state);
  const down = require('./environment').servicesDown(root, state);
  if (down) require('./events').append(root, { event: 'environment_services_down', job: state.id, cmd: down.cmd, code: down.code });
  state.status = 'closed';
  state.closed_at = nowIso();
  state.pending_gate = null;
  job.save(root, state);
  ledger.append(root, state.id, { kind: 'step', step: 'close', ok: true, bound: {} });
  let next = null;
  if (state.parent) {
    job.setCurrent(root, state.parent);
    next = `Back to epic ${state.parent}.`;
  }
  return { job: state.id, status: 'closed', next };
}

// What went wrong while the job was built, for distill (P4.4): parks (every kind, read
// generically: a router park's rule, a workflow's park, a park by hand, clarify's, and any later
// event whose name says park or drive stop, by its `type` / `reason`), resumes, retries, scope
// violations, a broken environment, agents that timed out (finding verifiers among them),
// integration failures, tasks that ended blocked or exhausted, and manual repairs (amendments,
// task states set by hand, findings settled by hand, waivers). Each list is capped; `count` is
// how many items there were in all.
const CAP = 12;
const clip = (v, n = 240) => (v === undefined || v === null ? null : String(v).slice(0, n));
function troubleOf(root, state) {
  const { readJsonl } = require('../lib/util');
  const { project } = require('../lib/paths');
  const evs = readJsonl(project(root).eventsFile).filter((e) => e && e.job === state.id);
  const decs = decisions.forJob(root, state.id);
  const led = ledger.all(root, state.id);
  const typed = (e) => clip(e.kind || e.park_kind || e.type || e.park_type || e.code || e.rule || e.from || null, 80);
  const parks = [
    ...decs.filter((d) => d.action === 'parked' || d.action === 'park').map((d) => ({ at: d.ts, source: 'router', type: clip((d.park && d.park.kind) || d.rule || d.type || null, 80), reason: clip(d.reason) })),
    ...evs.filter((e) => e.event === 'cli' && e.ok !== false && ((e.cmd === 'record' && e.status === 'park') || e.cmd === 'park')).map((e) => ({ at: e.ts, source: e.cmd === 'park' ? 'by hand' : `${e.workflow || 'workflow'} result`, type: clip(e.park_from || e.park_type || null, 80), reason: clip(e.park_reason || e.reason || null) })),
    ...led.filter((e) => e.kind === 'clarify' && e.outcome === 'park').map((e) => ({ at: e.at, source: 'clarify', type: 'clarify', reason: clip((e.detail || {}).reason) })),
    // typed park and drive-stop events (any name with "park", or drive_stop): read by their type and reason
    ...evs.filter((e) => typeof e.event === 'string' && (/park/i.test(e.event) || e.event === 'drive_stop') && e.event !== 'cli').map((e) => ({ at: e.ts, source: e.event, type: typed(e), reason: clip(e.reason || e.message || e.park_reason || null) })),
  ].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  if (state.park && !parks.some((p) => p.reason && state.park.reason && p.reason === clip(state.park.reason))) parks.push({ at: state.park.at, source: 'current', type: clip(state.park.type || state.park.from || null, 80), reason: clip(state.park.reason) });
  const resumes = decs.filter((d) => d.action === 'human.resume').map((d) => ({ at: d.ts, from: d.from || null, reason: clip(d.reason) }));
  const runs = evs.filter((e) => e.event === 'agent_run');
  const retries = runs.filter((e) => e.retry || e.grace_turn || /#([2-9]|\d{2,})$/.test(String(e.label || '')) || /\(retry\)$/.test(String(e.label || ''))).map((e) => ({ label: clip(e.label, 80), role: e.role || null, outcome: e.outcome || null, why: e.retry ? 'format correction' : e.grace_turn ? 'time-up turn' : 'another attempt' }));
  const timeouts = runs.filter((e) => e.outcome === 'timeout').map((e) => ({ label: clip(e.label, 80), role: e.role || null, cap_sec: e.time_cap_sec || null }));
  const scope = [];
  const envBroken = evs.filter((e) => e.event === 'environment_broken').map((e) => ({ task: e.task || null, cmd: clip(e.cmd, 120), reason: clip(e.reason) }));
  const tasks = [];
  for (const [id, t] of Object.entries(state.tasks || {})) {
    for (const h of t.history || []) {
      const v = h.verify || {};
      if ((v.scope_violations || []).length) scope.push({ task: id, attempt: h.attempt, paths: v.scope_violations.slice(0, 6) });
      if (v.refused === 'environment_broken') envBroken.push({ task: id, cmd: null, reason: clip(v.message) });
    }
    if (['blocked', 'exhausted', 'skipped_dependency'].includes(t.outcome)) tasks.push({ task: id, outcome: t.outcome, attempts: t.attempts || 0, reason: clip(t.outcome_reason || (t.builder && t.builder.blocked_reason) || null) });
    else if ((t.attempts || 0) > 1) tasks.push({ task: id, outcome: t.outcome || null, attempts: t.attempts, reason: 'needed more than one attempt' });
  }
  const integration = led.filter((e) => e.kind === 'step' && ['integrate', 'reconcile'].includes(e.step) && e.ok === false).map((e) => {
    const d = e.detail || {};
    return { step: e.step, kind: d.kind || (d.regression ? 'regression' : null), wave: d.wave || null, task: d.task || null, files: (d.files || (d.regression && d.regression.files) || []).slice(0, 6), commands: (d.commands || []).filter((c) => c.pass === false).map((c) => clip(c.cmd, 120)).slice(0, 4), message: clip(d.message) };
  });
  const manual = [
    ...evs.filter((e) => e.event === 'cli' && e.ok !== false && e.via !== 'run' && ((e.cmd === 'amend' && e.sub === 'submit') || (e.cmd === 'task' && e.sub === 'state'))).map((e) => ({ at: e.ts, what: `factory ${e.cmd} ${e.sub}` })),
    ...decs.filter((d) => ['human.waive', 'human.accept_finding', 'human.dismiss_finding', 'human.finding'].includes(d.action) || /finding/.test(String(d.action || '')) && /^human\./.test(String(d.action || ''))).map((d) => ({ at: d.ts, what: String(d.action).replace(/^human\./, ''), reason: clip(d.reason) })),
  ];
  const lists = { parks, resumes, retries, timeouts, scope_violations: scope, environment_broken: envBroken, integration_failures: integration, tasks, manual_repairs: manual };
  const count = Object.values(lists).reduce((n, l) => n + l.length, 0);
  const out = { count };
  for (const [k, l] of Object.entries(lists)) out[k] = l.slice(-CAP);
  out.verifier_timeouts = timeouts.filter((t) => t.role === 'finding-verifier').length;
  return out;
}

function distillContext(root, { jobId }) {
  const state = job.resolve(root, jobId);
  const recs = ledger.all(root, state.id).filter((e) => e.kind === 'step' && /challenge/.test(e.step) && e.detail && e.detail.findings);
  const findings = recs.flatMap((r) => r.detail.findings.map((f) => ({ ...f, round: r.detail.round })));
  const lessons = require('./lessons').load(root).lessons.filter((l) => l.source_job === state.id);
  const others = job
    .listJobIds(root)
    .filter((id) => id !== state.id)
    .flatMap((id) => {
      const rec = ledger.all(root, id).filter((e) => e.kind === 'step' && e.step === 'challenge' && e.detail && e.detail.findings);
      return rec.flatMap((r) => r.detail.findings.filter((f) => f.severity === 'minor').map((f) => ({ job: id, file: f.file, summary: f.summary })));
    });
  return {
    job: state.id,
    confirmed: findings.filter((f) => f.status === 'confirmed'),
    minor: findings.filter((f) => f.severity === 'minor'),
    minor_in_other_jobs: others.slice(-50),
    verify_fix_rounds: state.counters.verify_fix_rounds,
    review_fix_rounds: state.counters.review_rounds,
    already_proposed: lessons,
    cap: state.policy.lessons_max_per_job,
    // build trouble: lessons about the process and the environment, not only the code
    trouble: troubleOf(root, state),
  };
}

function distillDone(root, { jobId }) {
  const state = job.resolve(root, jobId);
  try {
    require('./project-brief').refresh(root, state.policy); // this job's ADRs and newly accepted lessons join the index
  } catch {
    /* a convenience */
  }
  ledger.append(root, state.id, { kind: 'step', step: 'distill', ok: true, bound: {} });
  return { job: state.id, ok: true };
}

function followup(root, { jobId, findings, workType }) {
  const parent = job.resolve(root, jobId);
  const type = workType || (parent.work_type === 'hotfix' ? 'hotfix' : 'bug');
  const list = findings || [];
  const contract = [
    `# Follow-up to ${parent.id}: ${parent.title}`,
    '',
    `<!-- factory contract · follow-up of ${parent.id} · the merged job is never reopened -->`,
    '',
    '## Intent',
    ...contractMod.intentLines({
      problem: list.length ? `Confirmed after ${parent.id} merged: ${list.map((f) => f.summary).join('; ')}` : null,
      outcome: list.length ? `None of these problems occur any more, and nothing else in ${parent.id} changes` : null,
      why_now: `Found after ${parent.id} (${parent.title}) merged`,
      success: list.length ? 'Every AC below passes on the merged follow-up' : null,
    }),
    '',
    '## Goal',
    `Fix the confirmed problems found after ${parent.id} merged.`,
    '',
    '## Non-goals',
    `- Re-doing anything else in ${parent.id}`,
    '',
    '## Acceptance criteria',
    ...(list.length ? list.map((f, i) => `- AC-${i + 1}: ${f.summary}${f.file ? ` (${f.file})` : ''} no longer occurs (evidence: test)`) : ['- AC-1: <observable behaviour> (evidence: test)']),
    '',
    '## Constraints',
    '- <compatibility, performance, security or style constraints>',
    '',
    '## Allowed paths',
    ...([...new Set(list.map((f) => f.file).filter(Boolean))].map((f) => `- ${f}`).concat(list.length ? [] : ['- <path/glob/**>'])),
    '',
    '## Verify commands',
    '- `<command>` (AC-1)',
    '',
    '## Assumptions',
    '- <anything assumed rather than confirmed>',
    '',
  ].join('\n');
  const prevCurrent = job.current(root);
  const child = job.create(root, { title: `Follow-up to ${parent.id}`, workType: type, risk: parent.risk, contractText: contract, followupOf: parent.id });
  if (prevCurrent) job.setCurrent(root, prevCurrent);
  return { job: parent.id, followup: child.id, recipe: child.recipe.id };
}

function why(root, { jobId }) {
  const state = job.resolve(root, jobId);
  const rows = decisions.forJob(root, state.id);
  return { job: state.id, title: state.title, recipe: `${state.recipe.id} v${state.recipe.version}`, risk: state.risk, status: state.status, decisions: rows };
}

function whyMarkdown(w) {
  const L = [`# Why ${w.job} took this path`, '', `${w.title} · ${w.recipe} · risk ${w.risk} · ${w.status}`, '', '| # | Time | Chosen | Rule | First failing check | Reason |', '|---|---|---|---|---|---|'];
  w.decisions.forEach((d, i) => {
    L.push(`| ${i + 1} | ${String(d.ts).replace('T', ' ').slice(0, 19)} | ${d.chosen || d.action} | ${d.rule || ''} | ${d.first_failing || '—'} | ${String(d.reason || '').replace(/\|/g, '\\|').slice(0, 140)} |`);
  });
  return L.join('\n');
}

module.exports = { troubleOf, finalize, close, distillContext, distillDone, followup, why, whyMarkdown, cleanup };
