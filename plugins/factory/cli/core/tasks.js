'use strict';
// Task worktrees: each task builds in its own git worktree on its own branch.
// `task verify` is the only way a task gets evidence: the CLI runs the commands.

const path = require('path');
const { readJson, writeJson, exists, nowIso, fail } = require('../lib/util');
const { jobPaths, taskWorktree } = require('../lib/paths');
const { matchesAny } = require('../lib/glob');
const git = require('../lib/git');
const { runCommand } = require('../lib/run');
const job = require('./job');
const steps = require('./steps');
const contractMod = require('./contract');
const planMod = require('./plan');
const lessons = require('./lessons');

function planTask(root, state, taskId) {
  const plan = readJson(jobPaths(root, state.id).plan, null);
  if (!plan) fail(`${state.id} has no plan.json`, 'no_plan');
  const t = plan.tasks.find((x) => x.id === taskId);
  if (!t) fail(`${taskId} is not in ${state.id}'s plan`, 'bad_input');
  return { plan, task: t };
}

function ensureJobWorktree(root, state) {
  const wt = jobPaths(root, state.id).worktree;
  if (!exists(path.join(wt, '.git'))) git.run(root, ['worktree', 'add', wt, state.branch]);
  return wt;
}

function start(root, jobId, taskId) {
  const state = job.resolve(root, jobId);
  const { task } = planTask(root, state, taskId);
  const branch = steps.taskBranch(state, taskId);
  const wt = taskWorktree(root, state.id, taskId);
  const ctx = steps.context(root, state, job.load);
  for (const d of task.depends_on || []) {
    if (!steps.taskDone(ctx, d)) fail(`${taskId} depends on ${d}, which is not done yet`, 'dependency_not_done');
  }
  if (!git.branchExists(root, branch)) git.run(root, ['branch', branch, state.branch]);
  if (!exists(path.join(wt, '.git'))) git.run(root, ['worktree', 'add', wt, branch]);
  for (const d of task.depends_on || []) {
    const db = steps.taskBranch(state, d);
    if (!git.isAncestor(root, db, branch)) {
      const r = git.run(wt, ['merge', '--no-ff', '--no-edit', '-m', `factory: bring ${d} into ${taskId}`, db], { allowFail: true });
      if (r.code !== 0) {
        git.run(wt, ['merge', '--abort'], { allowFail: true });
        fail(`Merging dependency ${d} into ${taskId} conflicts; this needs a plan change.`, 'dependency_conflict');
      }
    }
  }
  const fresh = job.load(root, state.id);
  const t = fresh.tasks[taskId] || {};
  const head = git.revParse(wt, 'HEAD');
  fresh.tasks[taskId] = {
    ...t,
    started_at: t.started_at || nowIso(),
    start_commit: t.start_commit && git.isAncestor(root, t.start_commit, head) ? t.start_commit : head,
    attempts: (t.attempts || 0) + 1,
    last_attempt_at: nowIso(),
  };
  job.save(root, fresh);
  return { job: state.id, task: taskId, worktree: wt, branch, attempt: fresh.tasks[taskId].attempts, allowed_paths: task.allowed_paths };
}

function show(root, jobId, taskId) {
  const state = job.resolve(root, jobId);
  const { task } = planTask(root, state, taskId);
  const parsed = contractMod.parse(contractMod.read(root, state.id));
  const t = state.tasks[taskId] || {};
  const evidence = t.evidence ? readJson(t.evidence.file, null) : null;
  const fixFindings = state.fix && state.fix.kind === 'fix' && (state.fix.tasks || []).includes(taskId) ? currentFindings(root, state, task) : [];
  const verifyFailures = state.fix && state.fix.kind === 'verifyFix' && (state.fix.tasks || []).includes(taskId) ? lastProveFailures(root, state) : [];
  return {
    job: state.id,
    task,
    goal: parsed.goal,
    criteria: parsed.acs.filter((a) => task.criteria_ids.includes(a.id)),
    constraints: parsed.constraints,
    non_goals: parsed.nonGoals,
    worktree: taskWorktree(root, state.id, taskId),
    branch: steps.taskBranch(state, taskId),
    attempts: t.attempts || 0,
    needs_work: t.needs_work || null,
    last_evidence: evidence ? { pass: evidence.pass, failures: evidence.commands.filter((c) => !c.pass), scope_violations: evidence.scope_violations } : null,
    fix_findings: fixFindings,
    verify_failures: verifyFailures,
    lessons: lessons.inScope(root, task.allowed_paths),
  };
}

function currentFindings(root, state, task) {
  const ledger = require('./ledger');
  const rec = ledger.lastStep(root, state.id, 'challenge');
  const all = (rec && rec.detail && rec.detail.findings) || [];
  const serious = all.filter((f) => ['blocker', 'major'].includes(f.severity) && f.status === 'confirmed');
  const mine = serious.filter((f) => f.file && matchesAny(f.file, task.allowed_paths));
  return mine.length ? mine : serious;
}

function lastProveFailures(root, state) {
  const ledger = require('./ledger');
  const rec = ledger.lastStep(root, state.id, 'prove');
  return rec && rec.detail ? (rec.detail.commands || []).filter((c) => !c.pass).map((c) => ({ cmd: c.cmd, code: c.code, flaky: c.flaky, output: c.output })) : [];
}

function verify(root, jobId, taskId) {
  const state = job.resolve(root, jobId);
  const { task } = planTask(root, state, taskId);
  const wt = taskWorktree(root, state.id, taskId);
  if (!exists(path.join(wt, '.git'))) fail(`${taskId} has no worktree; run factory task start first`, 'no_worktree');
  const dirty = git.status(wt);
  if (dirty) fail(`${taskId} has uncommitted changes. Commit them on the task branch first:\n${dirty}`, 'dirty_worktree');
  const t = state.tasks[taskId] || {};
  const head = git.revParse(wt, 'HEAD');
  const changed = t.start_commit ? git.changedFiles(wt, t.start_commit, head) : [];
  const scopeViolations = changed.filter((f) => !matchesAny(f, task.allowed_paths) || matchesAny(f, state.policy.protected_paths));
  const L = state.policy.limits;
  const commands = task.verify_commands.map((c) => runCommand(planMod.cmdOf(c), wt, { timeoutSec: L.command_timeout_seconds, reruns: L.flaky_reruns }));
  const pass = scopeViolations.length === 0 && commands.every((c) => c.pass) && changed.length > 0;
  const branch = steps.taskBranch(state, taskId);
  const id = `${taskId}-${(t.attempts || 1)}-${Date.now()}`;
  const file = path.join(jobPaths(root, state.id).evidenceDir, `${id}.json`);
  const ev = {
    id,
    task: taskId,
    at: nowIso(),
    head,
    tree: git.fingerprint(root, branch),
    changed_files: changed,
    scope_violations: scopeViolations,
    no_changes: changed.length === 0,
    commands,
    pass,
  };
  writeJson(file, ev);
  const fresh = job.load(root, state.id);
  fresh.tasks[taskId] = { ...(fresh.tasks[taskId] || {}), evidence: { id, file, pass, tree: ev.tree, at: ev.at } };
  if (pass) delete fresh.tasks[taskId].needs_work;
  job.save(root, fresh);
  return {
    job: state.id,
    task: taskId,
    pass,
    evidence_id: id,
    failures: commands.filter((c) => !c.pass).map((c) => ({ cmd: c.cmd, code: c.code, flaky: c.flaky, output: c.output })),
    scope_violations: scopeViolations,
    no_changes: changed.length === 0,
  };
}

function setState(root, jobId, taskId, value, reason) {
  if (!['blocked', 'exhausted'].includes(value)) fail('task state must be blocked or exhausted', 'bad_input');
  const state = job.resolve(root, jobId);
  state.tasks[taskId] = { ...(state.tasks[taskId] || {}), outcome: value, outcome_reason: reason || '', outcome_at: nowIso() };
  job.save(root, state);
  return { job: state.id, task: taskId, state: value };
}

module.exports = { start, show, verify, setState, ensureJobWorktree, planTask };
