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

// A worktree folder removed without `git worktree prune` stays registered, and git then
// refuses to add it again ("already checked out"): prune first. The build-cache excludes are
// (re)written here too, for repositories initialised before they existed.
function addWorktree(root, wt, branch) {
  require('./setup').ensureGitSetup(root);
  if (exists(path.join(wt, '.git'))) return;
  git.run(root, ['worktree', 'prune'], { allowFail: true });
  git.run(root, ['worktree', 'add', wt, branch]);
}

function ensureJobWorktree(root, state) {
  const wt = jobPaths(root, state.id).worktree;
  addWorktree(root, wt, state.branch);
  return wt;
}

// The task's branch and worktree, created if missing. No state changes: `factory run`
// uses it to start a builder inside its worktree before the builder runs `task start`.
function prepareWorktree(root, state, taskId) {
  const branch = steps.taskBranch(state, taskId);
  const wt = taskWorktree(root, state.id, taskId);
  if (!git.branchExists(root, branch)) git.run(root, ['branch', branch, state.branch]);
  addWorktree(root, wt, branch);
  return wt;
}

// Files this task itself changed since it started: changed overall (an edit reverted later
// doesn't count) and touched by its own commits (the first-parent line of its branch, merges
// skipped), so what a dependency or the job branch brought in by merge is never counted as
// the task's change or as a scope violation.
function ownChangedFiles(wt, from, to) {
  const o = git.out(wt, ['log', '--first-parent', '--no-merges', '--name-only', '--format=', `${from}..${to}`]);
  const own = new Set(o.split('\n').map((l) => l.trim()).filter(Boolean));
  return git.changedFiles(wt, from, to).filter((f) => own.has(f));
}

// In a fix round the commit-msg hook adds a Factory-Fix trailer (reconcile protects those
// lines); the marker lives in the worktree's own git dir.
function fixMarker(wt, kind) {
  const gd = path.resolve(wt, git.out(wt, ['rev-parse', '--git-dir']));
  const f = path.join(gd, 'factory-fix');
  if (kind) require('fs').writeFileSync(f, `${kind}\n`);
  else require('fs').rmSync(f, { force: true });
}

// Outcomes after which a task's branch is not worth building on: the next `task start` (a
// resume, an amendment) restarts it from the job branch plus its dependencies. An exhausted
// task is not among them: its retries ran out, but its commits (a `wip:` one included) are
// what the next attempt continues from, in the same Copilot session (P2.4); a scope
// violation in its last attempt still restarts it (restartReason).
const FAILED = ['blocked', 'not_verified', 'skipped_dependency'];

// Why this start must restart the task's branch (once per failure), or null: the task ended
// failed in an earlier run, or its last attempt changed files outside its paths.
function restartReason(t) {
  if (FAILED.includes(t.outcome)) {
    const key = `outcome:${t.outcome}@${t.outcome_at || ''}`;
    return t.restarted_for === key ? null : { reason: t.outcome, key };
  }
  const ev = t.evidence ? readJson(t.evidence.file, null) : null;
  if (ev && (ev.scope_violations || []).length) {
    const key = `scope:${ev.id}`;
    return t.restarted_for === key ? null : { reason: 'scope_violation', key };
  }
  return null;
}

// Restart the task branch at the job branch. The old head is kept on a backup ref and any
// uncommitted leftovers in a stash, so nothing a failed attempt did is lost to the user.
function resetToJobBranch(root, state, wt, taskId, attempt) {
  if (git.status(wt)) git.run(wt, ['stash', 'push', '-u', '-m', `factory: leftovers of ${taskId} before its restart`], { allowFail: true });
  const backup = `refs/factory/restarts/${steps.taskBranch(state, taskId)}/${attempt}-${Date.now()}`;
  git.run(wt, ['update-ref', backup, 'HEAD']);
  git.run(wt, ['reset', '-q', '--hard', state.branch]);
  return backup;
}

function conflict(root, state, taskId, message) {
  const fresh = job.load(root, state.id);
  fresh.tasks[taskId] = { ...(fresh.tasks[taskId] || {}), start_error: { code: 'dependency_conflict', message, at: nowIso() } };
  job.save(root, fresh);
  fail(`${message} This is not a build failure: stop and reply with status "blocked", blocked_reason "dependency_conflict" and this message as the summary. It needs a plan change (paths or dependencies).`, 'dependency_conflict');
}

function start(root, jobId, taskId) {
  const state = job.resolve(root, jobId);
  const { plan, task } = planTask(root, state, taskId);
  const branch = steps.taskBranch(state, taskId);
  const wt = taskWorktree(root, state.id, taskId);
  const ctx = steps.context(root, state, job.load);
  // Explicit depends_on plus earlier-wave tasks with overlapping paths (plan.effectiveDeps).
  const deps = planMod.effectiveDeps(plan.tasks, taskId, plan.interfaces);
  for (const d of deps) {
    const via = (task.consumes || []).find((n) => ((plan.interfaces || []).find((i) => i.name === n) || {}).owner === d);
    if (!steps.taskDone(ctx, d)) fail(`${taskId} depends on ${d}${(task.depends_on || []).includes(d) ? '' : via ? ` (it produces "${via}", which ${taskId} consumes)` : ' (an earlier wave touching the same paths)'}, which is not done yet`, 'dependency_not_done');
  }
  prepareWorktree(root, state, taskId);
  const prev = state.tasks[taskId] || {};
  const restart = restartReason(prev);
  const backup = restart ? resetToJobBranch(root, state, wt, taskId, prev.attempts || 0) : null;
  const bring = (ref, what) => {
    if (git.isAncestor(root, ref, branch)) return;
    const r = git.run(wt, ['merge', '--no-ff', '--no-edit', '-m', `factory: bring ${what} into ${taskId}`, ref], { allowFail: true });
    if (r.code !== 0) {
      git.run(wt, ['merge', '--abort'], { allowFail: true });
      conflict(root, state, taskId, `Merging ${what} into ${taskId} conflicts${restart ? ' even on a branch restarted from the job branch' : ''}; this needs a plan change.`);
    }
  };
  // A rebuild (fix round, amendment) starts from what is integrated now, never from the
  // task's stale branch: other tasks' merged work must not be reverted by this one.
  bring(state.branch, `the job branch (${state.branch})`);
  for (const d of deps) bring(steps.taskBranch(state, d), d);
  const inFix = Boolean(state.fix && (state.fix.tasks || []).includes(taskId));
  fixMarker(wt, inFix ? state.fix.kind : null);
  const fresh = job.load(root, state.id);
  const t = fresh.tasks[taskId] || {};
  const head = git.revParse(wt, 'HEAD');
  const { start_error: _e, ...rest } = t;
  fresh.tasks[taskId] = {
    ...rest,
    started_at: t.started_at || nowIso(),
    // after a restart the task's own changes are counted from the restarted branch
    start_commit: !restart && t.start_commit && git.isAncestor(root, t.start_commit, head) ? t.start_commit : head,
    attempts: (t.attempts || 0) + 1,
    last_attempt_at: nowIso(),
    // This start ran under a factory that records each attempt's builder reply: from here on
    // task verify needs that reply (see legacyAttempt for tasks started before it did).
    builder_tracking: BUILDER_TRACKING,
    ...(restart ? { restarted_for: restart.key, restarted: { reason: restart.reason, backup, at: nowIso() } } : {}),
  };
  job.save(root, fresh);
  return { job: state.id, task: taskId, worktree: wt, branch, attempt: fresh.tasks[taskId].attempts, allowed_paths: task.allowed_paths, ...(restart ? { restarted: { reason: restart.reason, backup } } : {}) };
}

// The runner calls this when a task's builder ends (tests that play the builder call it too):
// it records what this attempt's builder returned, which `task verify` and taskDone require.
// A builder that returned nothing after `task start` refused with dependency_conflict did not
// crash: its result becomes the typed blocked result it should have replied with.
function afterBuilder(root, jobId, taskId, result, { startedAt, label, sessionId, resumed, wip, outcome: run } = {}) {
  const state = job.load(root, jobId);
  const t = state.tasks[taskId] || {};
  let r = result || null;
  const se = t.start_error;
  if (!r && se && se.code === 'dependency_conflict' && (!startedAt || se.at >= startedAt)) {
    r = { status: 'blocked', blocked_reason: 'dependency_conflict', summary: se.message, needs_paths: [] };
  }
  const outcome = !r ? 'no_result' : r.status === 'done' ? 'done' : 'blocked';
  const attempt = t.attempts || 0;
  const builder = { attempt, outcome, at: nowIso(), label: label || null, ...(r && r.blocked_reason ? { blocked_reason: r.blocked_reason } : {}), ...(sessionId ? { session_id: sessionId } : {}), ...(wip ? { wip_commit: wip } : {}) };
  const entry = { builder: outcome, ...(run && run !== 'ok' ? { run } : {}), ...(r && r.summary ? { summary: String(r.summary).slice(0, 400) } : {}), ...(r && (r.needs_paths || []).length ? { needs_paths: r.needs_paths } : {}), ...(sessionId ? { session_id: sessionId, resumed: Boolean(resumed) } : {}), ...(wip ? { wip_commit: wip } : {}), builder_at: builder.at };
  state.tasks[taskId] = { ...t, builder, history: noteAttempt(t.history, attempt, entry) };
  job.save(root, state);
  return r;
}

// The task's attempt history, one entry per attempt (builder reply, then task verify's
// result), across `factory run` invocations: task show returns it and a later realize
// continues from it. The last HISTORY attempts are kept.
const HISTORY = 6;
function noteAttempt(history, attempt, fields) {
  const h = Array.isArray(history) ? history.map((x) => ({ ...x })) : [];
  let e = h.find((x) => x.attempt === attempt);
  if (!e) {
    e = { attempt };
    h.push(e);
  }
  Object.assign(e, fields);
  return h.sort((a, b) => a.attempt - b.attempt).slice(-HISTORY);
}

// What the last attempt left for the next one: the raw verify failures (command, exit code,
// output tail) or what its builder said, as text lines. Empty when there is nothing to carry.
function lastFailures(t) {
  const h = (t && t.history) || [];
  const e = h[h.length - 1];
  if (!e) return [];
  const out = [];
  if (e.builder && e.builder !== 'done') out.push(`Attempt ${e.attempt}: the builder ${e.builder === 'no_result' ? `returned no result${e.run ? ` (${e.run})` : ''}` : `replied ${e.builder}`}${e.summary ? `: ${e.summary}` : ''}.${e.wip_commit ? ` Its uncommitted work was saved as ${e.wip_commit.slice(0, 10)} (wip:) on the task branch.` : ''}`);
  if (e.verify && !e.verify.pass) {
    if (e.verify.refused) out.push(`Attempt ${e.attempt}: task verify refused (${e.verify.refused})${e.verify.message ? `: ${e.verify.message}` : ''}`);
    for (const f of e.verify.failures || []) out.push(`Attempt ${e.attempt}: \`${f.cmd}\` exited ${f.code}. Output (tail):\n${String(f.tail || '').split('\n').map((l) => `      ${l}`).join('\n')}`);
    for (const p of e.verify.scope_violations || []) out.push(`Attempt ${e.attempt}: ${p} was changed but is outside this task's allowed paths (or protected).`);
    if (e.verify.no_changes) out.push(`Attempt ${e.attempt}: no change was committed on the task branch.`);
  }
  return out;
}

function show(root, jobId, taskId) {
  const state = job.resolve(root, jobId);
  const { plan, task } = planTask(root, state, taskId);
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
    // every recorded attempt: the builder's reply (and its Copilot session), task verify's raw result
    history: t.history || [],
    needs_work: t.needs_work || null,
    last_evidence: evidence ? { pass: evidence.pass, failures: evidence.commands.filter((c) => !c.pass), scope_violations: evidence.scope_violations } : null,
    fix_findings: fixFindings,
    verify_failures: verifyFailures,
    // the per-wave integration check that failed on this task's files (P2.3)
    integration_failures: t.needs_work === 'integration' && t.integration_failure ? t.integration_failure.failures || [] : [],
    lessons: lessons.inScope(root, task.allowed_paths),
    // the approved design as this task needs it, and where it sits in the plan
    packet: require('./packet').build(root, state, plan, task),
  };
}

function currentFindings(root, state, task) {
  const ledger = require('./ledger');
  const rec = ledger.lastStep(root, state.id, 'challenge');
  const all = (rec && rec.detail && rec.detail.findings) || [];
  const serious = all.filter((f) => ['blocker', 'major'].includes(f.severity) && f.status === 'confirmed');
  const owners = (state.fix && state.fix.owners) || null;
  if (owners) return serious.filter((f) => owners[f.id] === task.id || owners[f.id] === '*').map((f) => (owners[f.id] === '*' ? { ...f, shared: true } : f));
  const mine = serious.filter((f) => f.file && matchesAny(f.file, task.allowed_paths));
  return mine.length ? mine : serious;
}

function lastProveFailures(root, state) {
  const ledger = require('./ledger');
  const rec = ledger.lastStep(root, state.id, 'prove');
  return rec && rec.detail ? (rec.detail.commands || []).filter((c) => !c.pass).map((c) => ({ cmd: c.cmd, code: c.code, flaky: c.flaky, output: c.output })) : [];
}

// Builder replies are recorded by factory run (tasks.afterBuilder) since after 0.5.3. A task whose attempts were
// started by an older factory (no builder_tracking, no builder record at all) is legacy: a
// job that was mid-build when the factory was upgraded. Its current attempt may be verified
// once without a builder record (an event says so); its next `task start` tracks it.
const BUILDER_TRACKING = 1;
function legacyAttempt(t) {
  return Boolean(t && !t.builder && (t.attempts || 0) > 0 && !t.builder_tracking);
}

function verify(root, jobId, taskId) {
  const state = job.resolve(root, jobId);
  const { task } = planTask(root, state, taskId);
  const wt = taskWorktree(root, state.id, taskId);
  if (!exists(path.join(wt, '.git'))) fail(`${taskId} has no worktree; run factory task start first`, 'no_worktree');
  const dirty = git.status(wt);
  if (dirty) fail(`${taskId} has uncommitted changes. Commit them on the task branch first:\n${dirty}`, 'dirty_worktree');
  const t = state.tasks[taskId] || {};
  // Done means this attempt's builder succeeded: a crashed, blocked or timed-out builder
  // leaves an older branch state, which must not be counted as its work.
  const legacy = legacyAttempt(t);
  if (legacy && t.legacy_verify && t.legacy_verify.attempt === (t.attempts || 0)) {
    fail(`${taskId} was started before this factory recorded builder replies, and its one verification without a builder record (attempt ${t.legacy_verify.attempt}, ${t.legacy_verify.at}) is used. Rebuild it: factory next routes realize, whose builder records its reply.`, 'no_builder_result', { builder: null, attempt: t.attempts || 0, legacy: true });
  }
  const b = legacy ? { attempt: t.attempts || 0, outcome: 'done', at: `legacy:${t.last_attempt_at || t.started_at || ''}`, legacy: true } : t.builder;
  if (legacy) {
    const fresh0 = job.load(root, state.id);
    fresh0.tasks[taskId] = { ...(fresh0.tasks[taskId] || {}), legacy_verify: { attempt: t.attempts || 0, at: nowIso() } };
    job.save(root, fresh0);
    require('./events').append(root, { event: 'legacy_verify', job: state.id, task: taskId, attempt: t.attempts || 0, reason: 'task started before builder replies were recorded (factory upgraded mid-build): verified once without a builder record' });
  }
  if (!b || b.attempt !== (t.attempts || 0) || b.outcome !== 'done') {
    const why = !b ? 'no builder has replied for it yet' : b.attempt !== (t.attempts || 0) ? `its builder's last reply was for attempt ${b.attempt}, not this attempt (${t.attempts || 0})` : `this attempt's builder ${b.outcome === 'no_result' ? 'returned no result (crashed, timed out or replied without the JSON)' : `returned ${b.outcome}${b.blocked_reason ? ` (${b.blocked_reason})` : ''}`}`;
    fail(`${taskId} cannot be verified: ${why}. Only work its builder finished counts; the next attempt builds again.`, 'no_builder_result', { builder: b || null, attempt: t.attempts || 0 });
  }
  // Every declared and implied dependency must be in the branch that is verified.
  const branch = steps.taskBranch(state, taskId);
  const plan = readJson(jobPaths(root, state.id).plan, { tasks: [] });
  const missingDeps = planMod.effectiveDeps(plan.tasks || [], taskId, plan.interfaces).filter((d) => {
    const db = steps.taskBranch(state, d);
    return !git.branchExists(root, db) || !git.isAncestor(root, db, branch);
  });
  if (missingDeps.length) fail(`${taskId}'s branch does not contain ${missingDeps.join(', ')} as built now; run task start ${taskId} again to bring ${missingDeps.length > 1 ? 'them' : 'it'} in, then build and verify.`, 'dependency_not_merged', { missing: missingDeps });
  const head = git.revParse(wt, 'HEAD');
  const changed = t.start_commit ? ownChangedFiles(wt, t.start_commit, head) : [];
  const scopeViolations = changed.filter((f) => !matchesAny(f, task.allowed_paths) || matchesAny(f, state.policy.protected_paths));
  // The build environment (.factory/environment.json): set up in this worktree (cached by its
  // lockfiles), and every command runs inside it, against this worktree's code. A broken
  // environment is not the build's failure: it refuses with environment_broken.
  const envMod = require('./environment');
  const E = envMod.ensure(root, state, { taskId, wt });
  if (!E.ok) fail(`${E.broken.reason}\nThe environment, not this task's code, is broken: fix it (factory env check, factory env set) and resume.`, 'environment_broken', E.broken);
  const L = state.policy.limits;
  const commands = task.verify_commands.map((c) => ({ ...runCommand(envMod.wrap(E.env, E.vars, planMod.cmdOf(c)), wt, { timeoutSec: L.command_timeout_seconds, reruns: L.flaky_reruns }), cmd: planMod.cmdOf(c) }));
  const pass = scopeViolations.length === 0 && commands.every((c) => c.pass) && changed.length > 0;
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
    builder_at: b.at,
    ...(legacy ? { legacy: true } : {}),
    ...(E.env && !E.none ? { environment: { name: E.env.name || null, key: E.key, cached: E.cached } } : {}),
  };
  writeJson(file, ev);
  const fresh = job.load(root, state.id);
  const tail = (x, n) => (String(x || '').length > n ? `…${String(x).slice(-n)}` : String(x || ''));
  const verifyEntry = { pass, at: ev.at, evidence_id: id, failures: commands.filter((c) => !c.pass).map((c) => ({ cmd: c.cmd, code: c.code, ...(c.flaky ? { flaky: true } : {}), tail: tail(c.output, 1500) })), ...(scopeViolations.length ? { scope_violations: scopeViolations } : {}), ...(changed.length ? {} : { no_changes: true }) };
  fresh.tasks[taskId] = { ...(fresh.tasks[taskId] || {}), evidence: { id, file, pass, tree: ev.tree, at: ev.at, builder_at: b.at }, history: noteAttempt((fresh.tasks[taskId] || {}).history, t.attempts || 0, { verify: verifyEntry }) };
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
    ...(legacy ? { legacy: 'verified once without a builder record: this task was started before the factory recorded builder replies' } : {}),
  };
}

function setState(root, jobId, taskId, value, reason) {
  if (!['blocked', 'exhausted'].includes(value)) fail('task state must be blocked or exhausted', 'bad_input');
  const state = job.resolve(root, jobId);
  state.tasks[taskId] = { ...(state.tasks[taskId] || {}), outcome: value, outcome_reason: reason || '', outcome_at: nowIso() };
  job.save(root, state);
  return { job: state.id, task: taskId, state: value };
}

module.exports = { start, show, verify, setState, ensureJobWorktree, planTask, prepareWorktree, ownChangedFiles, afterBuilder, legacyAttempt, lastFailures, noteAttempt, FAILED };
