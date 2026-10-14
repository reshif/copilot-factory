'use strict';
// reconcile: merge every done task branch into the job branch in dependency order.
// Textual conflicts inside the tasks' own scopes may be resolved by the integrator;
// anything else is aborted and parks the job.

const { readJson, nowIso, fail } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const { matchesAny } = require('../lib/glob');
const git = require('../lib/git');
const job = require('./job');
const steps = require('./steps');
const ledger = require('./ledger');
const planMod = require('./plan');
const tasks = require('./tasks');

function orderedTasks(root, state) {
  const plan = readJson(jobPaths(root, state.id).plan, { tasks: [] });
  const { layers } = planMod.layers(plan.tasks || []);
  const byId = Object.fromEntries((plan.tasks || []).map((t) => [t.id, t]));
  return (layers || []).flat().map((id) => byId[id]);
}

function conflicted(wt) {
  const o = git.out(wt, ['diff', '--name-only', '--diff-filter=U']);
  return o ? o.split('\n').filter(Boolean) : [];
}

function finish(root, state) {
  const ctx = steps.context(root, job.load(root, state.id), job.load);
  const heads = {};
  for (const t of steps.planTasks(ctx)) heads[t.id] = git.revParse(root, steps.taskBranch(state, t.id));
  const fresh = job.load(root, state.id);
  fresh.integration = { fingerprint: ctx.b.fingerprint, commit: git.revParse(root, state.branch), at: nowIso(), task_heads: heads };
  job.save(root, fresh);
  ledger.append(root, state.id, { kind: 'step', step: 'reconcile', ok: true, bound: { fingerprint: ctx.b.fingerprint }, detail: { commit: fresh.integration.commit, task_heads: heads } });
  return { job: state.id, status: 'merged', fingerprint: ctx.b.fingerprint, commit: fresh.integration.commit };
}

function run(root, jobId) {
  const state = job.resolve(root, jobId);
  const ctx = steps.context(root, state, job.load);
  const ordered = orderedTasks(root, state);
  const notDone = ordered.filter((t) => !steps.taskDone(ctx, t.id));
  if (notDone.length) fail(`Tasks not done yet: ${notDone.map((t) => t.id).join(', ')}`, 'not_ready');
  const wt = tasks.ensureJobWorktree(root, state);
  if (conflicted(wt).length) return { job: state.id, status: 'conflict_pending', files: conflicted(wt), message: 'A merge is in progress; resolve it and run factory reconcile continue, or factory reconcile abort.' };
  if (git.status(wt)) fail(`The job worktree has uncommitted changes:\n${git.status(wt)}`, 'dirty_worktree');
  for (const t of ordered) {
    const br = steps.taskBranch(state, t.id);
    if (git.isAncestor(root, br, state.branch)) continue;
    const r = git.run(wt, ['merge', '--no-ff', '--no-edit', '-m', `factory: merge ${t.id} into ${state.id}\n\nFactory-Job: ${state.id}\nFactory-Task: ${t.id}`, br], { allowFail: true });
    if (r.code !== 0) {
      const files = conflicted(wt);
      const scope = ordered.flatMap((x) => x.allowed_paths || []);
      const inScope = files.length > 0 && files.every((f) => matchesAny(f, scope));
      if (!inScope) {
        git.run(wt, ['merge', '--abort'], { allowFail: true });
        return { job: state.id, status: 'behavioural_conflict', task: t.id, files, message: 'Conflict outside the tasks\' scopes; merge aborted. This needs a plan change or your decision.' };
      }
      return { job: state.id, status: 'textual_conflict', task: t.id, files, worktree: wt, message: 'Resolve the conflict markers in these files (inside the job worktree), then run factory reconcile continue. If it is not purely textual, run factory reconcile abort.' };
    }
  }
  return finish(root, state);
}

function cont(root, jobId) {
  const state = job.resolve(root, jobId);
  const wt = jobPaths(root, state.id).worktree;
  const files = conflicted(wt);
  if (files.length) fail(`Still unmerged: ${files.join(', ')}. Resolve and git add them in the job worktree.`, 'unresolved');
  const markers = git.run(wt, ['grep', '-n', '-E', '^(<<<<<<<|>>>>>>>)( |$)'], { allowFail: true });
  if (markers.code === 0 && markers.stdout) fail(`Conflict markers remain:\n${markers.stdout}`, 'unresolved');
  if (git.ok(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) git.run(wt, ['commit', '--no-edit']);
  return run(root, jobId);
}

function abort(root, jobId) {
  const state = job.resolve(root, jobId);
  const wt = jobPaths(root, state.id).worktree;
  git.run(wt, ['merge', '--abort'], { allowFail: true });
  return { job: state.id, status: 'aborted' };
}

module.exports = { run, cont, abort };
