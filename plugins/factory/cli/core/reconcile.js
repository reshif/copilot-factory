'use strict';
// reconcile: merge every done task branch into the job branch in dependency order.
// Textual conflicts inside the tasks' own scopes may be resolved by the integrator;
// anything else is aborted and parks the job.

const { readJson, nowIso, fail } = require('../lib/util');
const { runCommand } = require('../lib/run');
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
  const byId = Object.fromEntries((plan.tasks || []).map((t) => [t.id, t]));
  return planMod.buildOrder(plan.tasks || [], plan.interfaces).map((id) => byId[id]);
}

function conflicted(wt) {
  const o = git.out(wt, ['diff', '--name-only', '--diff-filter=U']);
  return o ? o.split('\n').filter(Boolean) : [];
}

// ---- regression guard: a merge (or a conflict resolution) may not silently drop work.
// Protected: lines the job branch had gained from already-merged tasks (relative to the
// merge base), and lines added by fix-round commits (Factory-Fix trailer) that their own
// task still has. A protected line missing from the result is a regression.
const TRIVIAL = /^[\s{}()[\];,]*$/;
const MARKER = /^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)( |$)/;
const keep = (l) => !TRIVIAL.test(l) && !MARKER.test(l.trim());

function fileLines(wt, rev, file) {
  const r = git.run(wt, ['show', `${rev}:${file}`], { allowFail: true });
  return new Set(r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()) : []);
}

function addedLines(wt, from, to, file) {
  const r = git.run(wt, ['diff', '-U0', '--no-color', '--no-ext-diff', from, to, '--', file], { allowFail: true });
  return r.code === 0 ? r.stdout.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trim()).filter(keep) : [];
}

function names(wt, args) {
  const o = git.run(wt, args, { allowFail: true }).stdout;
  return o ? o.split('\n').filter(Boolean) : [];
}

function trailer(wt, commit, key) {
  const o = git.run(wt, ['log', '-1', `--format=%(trailers:key=${key},valueonly)`, commit], { allowFail: true }).stdout;
  return (o || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || null;
}

function regressions(root, state, wt) {
  const since = state.integration && state.integration.commit && git.isAncestor(root, state.integration.commit, state.branch) ? state.integration.commit : state.base_commit;
  const range = since ? `${since}..HEAD` : 'HEAD';
  const out = [];
  const subject = (c) => git.run(wt, ['log', '-1', '--format=%s', c], { allowFail: true }).stdout;
  // 1. every merge reconcile made since the last integration, oldest first
  for (const m of names(wt, ['rev-list', '--first-parent', '--merges', '--reverse', range])) {
    const p1 = `${m}^1`;
    const p2 = `${m}^2`;
    const base = git.run(wt, ['merge-base', p1, p2], { allowFail: true }).stdout;
    if (!base) continue;
    const task = (/factory: merge (T\d+)/.exec(subject(m)) || [])[1] || trailer(wt, m, 'Factory-Task');
    const dropped = [];
    for (const file of names(wt, ['diff', '--name-only', p1, m])) {
      const now = fileLines(wt, m, file);
      for (const l of addedLines(wt, base, p1, file)) if (!now.has(l)) dropped.push({ file, line: l, by: 'already-merged work' });
    }
    if (dropped.length) out.push({ kind: 'merge', merge: m, reset_to: git.revParse(wt, p1), task: task || null, dropped });
  }
  // 2. fix-round commits since the last integration: their lines must reach the job branch
  for (const c of names(wt, ['log', '--no-merges', '--format=%H', '--grep=^Factory-Fix:', range])) {
    const t = trailer(wt, c, 'Factory-Task');
    const tip = t && git.branchExists(root, steps.taskBranch(state, t)) ? steps.taskBranch(state, t) : null;
    const dropped = [];
    for (const file of names(wt, ['diff-tree', '--no-commit-id', '--name-only', '-r', c])) {
      const now = fileLines(wt, 'HEAD', file);
      const still = tip ? fileLines(wt, tip, file) : null;
      for (const l of addedLines(wt, `${c}^`, c, file)) if (!now.has(l) && (!still || still.has(l))) dropped.push({ file, line: l, by: `fix commit ${c.slice(0, 10)}${t ? ` (${t})` : ''}` });
    }
    if (dropped.length) out.push({ kind: 'fix', commit: c, task: t, dropped });
  }
  return out;
}

function regressionResult(root, state, wt, found) {
  const ctx = steps.context(root, job.load(root, state.id), job.load);
  const first = found.find((x) => x.kind === 'merge');
  // A bad merge is undone so the job branch never carries it; the reconcile can be redone.
  if (first) git.run(wt, ['reset', '--hard', first.reset_to]);
  const dropped = found.flatMap((x) => x.dropped.map((d) => ({ ...d, task: x.kind === 'merge' ? x.task || null : null }))).slice(0, 40);
  const files = [...new Set(dropped.map((d) => d.file))];
  const message = `Integration would drop work already merged or fixed: ${dropped.slice(0, 5).map((d) => `${d.file}: "${d.line.slice(0, 80)}" (${d.by}${d.task ? `, lost while merging ${d.task}` : ''})`).join('; ')}${dropped.length > 5 ? ` and ${dropped.length - 5} more line(s)` : ''}.${first ? ` The merge was undone (job branch reset to ${first.reset_to.slice(0, 10)}).` : ''}`;
  ledger.append(root, state.id, { kind: 'step', step: 'reconcile', ok: false, bound: { fingerprint: ctx.b.fingerprint }, detail: { regression: { dropped, files, merges: found.filter((x) => x.kind === 'merge').map((x) => x.merge), fix_commits: found.filter((x) => x.kind === 'fix').map((x) => x.commit) }, message } });
  return { job: state.id, status: 'regression', files, dropped, message: `${message} This needs a fix (a task rebuilt on the merged code) or your decision; never resolve it by dropping lines.` };
}

function finish(root, state) {
  const ctx = steps.context(root, job.load(root, state.id), job.load);
  const heads = {};
  for (const t of steps.planTasks(ctx)) heads[t.id] = git.revParse(root, steps.taskBranch(state, t.id));
  const fresh = job.load(root, state.id);
  fresh.integration = { fingerprint: ctx.b.fingerprint, commit: git.revParse(root, state.branch), at: nowIso(), task_heads: heads };
  fresh.integration_green = fresh.integration.commit;
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
      const scope = ordered.flatMap((x) => require('./tasks').taskPaths(state, x));
      const inScope = files.length > 0 && files.every((f) => matchesAny(f, scope));
      if (!inScope) {
        git.run(wt, ['merge', '--abort'], { allowFail: true });
        return { job: state.id, status: 'behavioural_conflict', task: t.id, files, message: 'Conflict outside the tasks\' scopes; merge aborted. This needs a plan change or your decision.' };
      }
      return { job: state.id, status: 'textual_conflict', task: t.id, files, worktree: wt, message: 'Resolve the conflict markers in these files (inside the job worktree), keeping every line both sides added (an already-merged task\'s lines and fix-round lines must survive), then run factory reconcile continue. If it is not purely textual, run factory reconcile abort.' };
    }
  }
  const found = regressions(root, state, wt);
  if (found.length) return regressionResult(root, state, wt, found);
  return finish(root, state);
}

// ---- per-wave integration (P2.3) ----------------------------------------------------------
// After each realize wave, `factory run` merges the wave's finished tasks into the job branch
// and runs the job-level checks on the integrated tree, inside the build environment: every
// integrated task's verify commands, the contract's verify commands whose criteria are all
// integrated, and the policy checks. The next wave's tasks start from that branch. A failure
// routes to the task(s) whose files the output names (else the ones owning the failing
// command, else the wave), with the raw output; they are rebuilt on the integrated branch.

// Repo paths named in a command's output ("src/x.py", "src/x.py:12", "./src/x.js").
function pathsIn(output) {
  return [...new Set((String(output || '').match(/(?:\.\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z]{1,6}\b/g) || []).map((p) => p.replace(/^\.\//, '')))];
}

function integrationCommands(root, state, plan, integratedIds) {
  const parsed = require('./contract').parse(require('./contract').read(root, state.id));
  const byCmd = new Map();
  const add = (cmd, owners, from) => {
    if (!cmd) return;
    const e = byCmd.get(cmd) || { cmd, owners: new Set(), from };
    owners.forEach((o) => e.owners.add(o));
    byCmd.set(cmd, e);
  };
  const tasksIn = (plan.tasks || []).filter((t) => integratedIds.includes(t.id));
  for (const t of tasksIn) for (const c of t.verify_commands || []) add(planMod.cmdOf(c), [t.id], 'task');
  const covered = new Set(tasksIn.flatMap((t) => t.criteria_ids || []));
  for (const v of parsed.verifyCommands) {
    if (v.covers.length && v.covers.every((a) => covered.has(a))) add(v.cmd, tasksIn.filter((t) => (t.criteria_ids || []).some((a) => v.covers.includes(a))).map((t) => t.id), 'contract');
  }
  for (const c of state.policy.checks || []) add(typeof c === 'string' ? c : c.cmd, [], 'policy');
  return [...byCmd.values()].map((e) => ({ cmd: e.cmd, owners: [...e.owners], from: e.from }));
}

function integrateWave(root, jobId, ids, { wave = null } = {}) {
  const state = job.resolve(root, jobId);
  const ctx = steps.context(root, state, job.load);
  const plan = readJson(jobPaths(root, state.id).plan, { tasks: [] });
  const ordered = orderedTasks(root, state).filter((t) => t && ids.includes(t.id));
  const notDone = ordered.filter((t) => !steps.taskDone(ctx, t.id));
  if (notDone.length) fail(`Not done, so not integrated: ${notDone.map((t) => t.id).join(', ')}`, 'not_ready');
  const wt = tasks.ensureJobWorktree(root, state);
  if (conflicted(wt).length) git.run(wt, ['merge', '--abort'], { allowFail: true });
  if (git.status(wt)) fail(`The job worktree has uncommitted changes:\n${git.status(wt)}`, 'dirty_worktree');
  const before = git.revParse(wt, 'HEAD');
  const record = (ok, detail) => ledger.append(root, state.id, { kind: 'step', step: 'integrate', ok, bound: {}, detail: { wave, tasks: ids, before, ...detail } });
  const routeTo = (fresh, route) => {
    for (const [id, lines] of Object.entries(route)) {
      fresh.tasks[id] = { ...(fresh.tasks[id] || {}), needs_work: 'integration', integration_failure: { at: nowIso(), wave, failures: lines } };
    }
  };
  const merged = [];
  for (const t of ordered) {
    const br = steps.taskBranch(state, t.id);
    if (git.isAncestor(root, br, state.branch)) continue;
    const r = git.run(wt, ['merge', '--no-ff', '--no-edit', '-m', `factory: merge ${t.id} into ${state.id}\n\nFactory-Job: ${state.id}\nFactory-Task: ${t.id}`, br], { allowFail: true });
    if (r.code !== 0) {
      const files = conflicted(wt);
      git.run(wt, ['merge', '--abort'], { allowFail: true });
      git.run(wt, ['reset', '--hard', before]);
      const line = { cmd: `merge ${t.id} into the job branch`, code: 1, output: `Merging ${t.id} into the integrated job branch conflicts in ${files.join(', ') || 'its files'}: rebuild it on the integrated branch.` };
      job.mutate(root, state.id, (fresh) => routeTo(fresh, { [t.id]: [line] }));
      record(false, { kind: 'conflict', task: t.id, files });
      return { job: state.id, ok: false, kind: 'conflict', wave, task: t.id, files, route: { [t.id]: [line] } };
    }
    merged.push(t.id);
  }
  const found = regressions(root, state, wt);
  if (found.length) {
    git.run(wt, ['reset', '--hard', before]);
    const dropped = found.flatMap((x) => x.dropped.map((d) => ({ ...d, task: x.task || null })));
    const route = {};
    for (const d of dropped) {
      const id = d.task && ids.includes(d.task) ? d.task : ids[0];
      (route[id] = route[id] || []).push({ cmd: `merge ${id} into the job branch`, code: 1, output: `Merging would drop ${d.file}: "${String(d.line).slice(0, 120)}" (${d.by}). Rebuild on the integrated branch and keep that line.` });
    }
    job.mutate(root, state.id, (fresh) => routeTo(fresh, route));
    record(false, { kind: 'regression', dropped: dropped.slice(0, 20) });
    return { job: state.id, ok: false, kind: 'regression', wave, dropped: dropped.slice(0, 20), route };
  }
  // the job-level checks on the integrated tree, inside the build environment
  const envMod = require('./environment');
  const E = envMod.ensure(root, state, { taskId: null, wt });
  if (!E.ok) {
    record(false, { kind: 'environment', broken: E.broken });
    return { job: state.id, ok: false, kind: 'environment', wave, broken: E.broken, message: E.broken.reason };
  }
  const head = git.revParse(wt, 'HEAD');
  // Integrated: done tasks whose branch is in the job branch. A task branch that merely
  // points into the job branch (just created, or restarted from it after a failure) is not.
  const ctxNow = steps.context(root, job.load(root, state.id), job.load);
  const integratedIds = (plan.tasks || []).filter((t) => steps.taskDone(ctxNow, t.id) && git.branchExists(root, steps.taskBranch(state, t.id)) && git.isAncestor(root, steps.taskBranch(state, t.id), state.branch)).map((t) => t.id);
  const L = state.policy.limits;
  const cmds = integrationCommands(root, state, plan, integratedIds);
  const results = cmds.map((c) => ({ ...runCommand(envMod.wrap(E.env, E.vars, c.cmd), wt, { timeoutSec: L.command_timeout_seconds, reruns: L.flaky_reruns }), cmd: c.cmd, owners: c.owners, from: c.from }));
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    // Route each failure: the integrated tasks whose files its output names (this wave's
    // first: the build passed before their merge, so a traceback that also passes through an
    // earlier wave's file names a caller, not a cause), else the tasks owning the command, else
    // this wave's tasks.
    const tasksIn = (plan.tasks || []).filter((t) => integratedIds.includes(t.id));
    const route = {};
    for (const f of failed) {
      const named = pathsIn(f.output);
      // a path in a stack trace is often absolute (…/worktrees/J-0001/src/x.js): any suffix counts
      const hits = (t) => named.some((p) => p.split('/').some((_, i, a) => matchesAny(a.slice(i).join('/'), t.allowed_paths || [])));
      const namedTasks = tasksIn.filter(hits).map((t) => t.id);
      const inWave = namedTasks.filter((id) => ids.includes(id));
      let to = inWave.length ? inWave : namedTasks;
      if (!to.length) to = f.owners.filter((o) => integratedIds.includes(o));
      if (!to.length) to = ids.slice();
      const line = { cmd: f.cmd, code: f.code, ...(f.flaky ? { flaky: true } : {}), output: f.output.length > 3000 ? `…${f.output.slice(-3000)}` : f.output, named_files: named.slice(0, 10) };
      for (const id of to) (route[id] = route[id] || []).push(line);
    }
    job.mutate(root, state.id, (fresh) => routeTo(fresh, route));
    record(false, { kind: 'commands', commit: head, merged, commands: results.map((r) => ({ cmd: r.cmd, pass: r.pass, code: r.code, from: r.from })), route: Object.fromEntries(Object.entries(route).map(([k, v]) => [k, v.map((x) => x.cmd)])) });
    return { job: state.id, ok: false, kind: 'commands', wave, commit: head, merged, failures: failed.map((f) => ({ cmd: f.cmd, code: f.code, output: f.output })), route };
  }
  job.mutate(root, state.id, (fresh) => {
    for (const id of ids) if (fresh.tasks[id] && fresh.tasks[id].integration_failure) delete fresh.tasks[id].integration_failure;
    // the job branch as integrated and checked: where the next task starts (tasks.startBase)
    fresh.integration_green = head;
  });
  record(true, { commit: head, merged, commands: results.map((r) => ({ cmd: r.cmd, pass: r.pass, from: r.from })) });
  // Every task is built and integrated: this is the reconcile step's result too (no
  // integrator agent needed; the regression guard ran above).
  const ctx2 = steps.context(root, job.load(root, state.id), job.load);
  let reconciled = false;
  if (steps.allTasksDone(ctx2) && steps.allTasksMerged(ctx2)) {
    finish(root, job.load(root, state.id));
    reconciled = true;
  }
  return { job: state.id, ok: true, wave, commit: head, merged, commands: results.length, reconciled };
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

module.exports = { run, cont, abort, integrateWave, integrationCommands, pathsIn };
