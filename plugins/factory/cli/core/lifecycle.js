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
  for (const t of plan.tasks || []) {
    git.run(root, ['worktree', 'remove', '--force', taskWorktree(root, state.id, t.id)], { allowFail: true });
    git.run(root, ['branch', '-D', steps.taskBranch(state, t.id)], { allowFail: true });
  }
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
  };
}

function distillDone(root, { jobId }) {
  const state = job.resolve(root, jobId);
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

module.exports = { finalize, close, distillContext, distillDone, followup, why, whyMarkdown, cleanup };
