'use strict';
// Outcome integrity (Phase 1 of the agent audit): no step may lose work or findings between
// agents. Each test reproduces a behaviour the audit observed, then pins the fix.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');

const REALIZE = path.join(F.PLUGIN, 'workflows', 'realize.js');

// A realize brief by hand: one task, the real agent types, no CLI behind it.
function realizeBrief(tasks = { T1: {} }) {
  const t = {};
  for (const [id, o] of Object.entries(tasks)) {
    t[id] = {
      id,
      worktree: `/tmp/none-${id}`,
      depends_on: o.depends_on || [],
      retry_limit: o.retry_limit || 3,
      builder: { agent_type: 'factory:builder', escalate: [] },
      tester: { agent_type: 'factory:tester' },
      builder_prompt: `build ${id} attempt {{attempt}}\n{{failures}}`,
      tester_prompt: `test ${id} {{swept}}`,
    };
  }
  return { workflow: 'realize', job: 'J-0001', scope: 'all', input_hash: 'h', waves: [Object.keys(tasks)], tasks: t, max_parallel_tasks: 4, builder_schema: {}, tester_schema: {} };
}

test('P1.4: no tester runs after a builder that returned nothing (crash, timeout, invalid reply)', async () => {
  let builds = 0;
  const { result, calls } = await H.run(REALIZE, realizeBrief(), (prompt, opts) => {
    if (opts.agentType === 'factory:builder') {
      builds += 1;
      return builds === 1 ? null : { status: 'done', summary: 'built', swept: [] };
    }
    return { pass: true, failures: [] };
  });
  const testers = calls.filter((c) => c.opts.agentType === 'factory:tester');
  assert.equal(testers.length, 1, 'only the attempt whose builder replied is tested');
  assert.equal(result.data.tasks[0].outcome, 'done');
  assert.equal(result.data.tasks[0].attempts, 2, 'the empty builder still used an attempt');
  const second = calls.filter((c) => c.opts.agentType === 'factory:builder')[1];
  assert.match(second.prompt, /builder returned no result/i, 'the next builder is told why attempt 1 failed');
  assert.equal(result.agents.filter((a) => a.agent_type === 'factory:tester').length, 1);
});

test('P1.4: a builder that never replies exhausts the task without a single tester run', async () => {
  const { result, calls } = await H.run(REALIZE, realizeBrief({ T1: { retry_limit: 2 } }), (prompt, opts) => (opts.agentType === 'factory:builder' ? null : { pass: true, failures: [] }));
  assert.equal(calls.filter((c) => c.opts.agentType === 'factory:tester').length, 0);
  assert.equal(result.data.tasks[0].outcome, 'exhausted');
  assert.match(result.data.tasks[0].summary, /builder returned no result/i);
  assert.equal(result.status, 'park');
});

// ------------------------------------------------------------------------------- P1.2

const fs = require('fs');
const core = (m) => require(`../cli/core/${m}`);
const stateOf = (root, J) => core('job').load(root, J);

// clarify → H1 → ground; the plan is the test's.
function grounded(root) {
  const J = F.cli(root, ['job', 'new', '--title', 'Two tasks', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 'codebase', claims: [{ claim: 'x', source: 'src/add.js:1' }], unknowns: [] }], degraded: [] }));
  F.cli(root, ['next']);
  return J;
}
function customPlan(root, J, tasks) {
  F.cli(root, ['plan', 'from-contract']);
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks }));
  const v = F.cli(root, ['plan', 'validate', '--job', J]);
  assert.equal(v.valid, true, JSON.stringify(v));
  const b = core('invalidation').current(root, stateOf(root, J));
  core('ledger').append(root, J, { kind: 'step', step: 'decompose', ok: true, bound: { plan: b.plan, contract: b.contract }, detail: { source: 'test' } });
}
const VC = [{ cmd: 'true', covers: ['AC-1'] }];
const TWO = [
  { id: 'T1', objective: 'csv module', allowed_paths: ['src/csv.js', 'src/index.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: VC },
  { id: 'T2', objective: 'alerts', allowed_paths: ['src/alerts.js', 'src/index.js'], depends_on: ['T1'], criteria_ids: ['AC-1'], verify_commands: VC },
];

test('P1.2: task verify needs this attempt\'s builder to have succeeded; a crashed attempt is not done even when the branch passes', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  customPlan(root, J, [TWO[0]]);
  const s = F.cli(root, ['task', 'start', 'T1', '--job', J], { allowFail: false });
  F.write(s.worktree, 'src/csv.js', 'module.exports = {}\n');
  F.sh(s.worktree, 'git add -A && git commit -qm csv');
  // no builder result for attempt 1 yet (the builder has not replied): refused
  assert.equal(F.cli(root, ['task', 'verify', 'T1', '--job', J]).code, 'no_builder_result');
  F.built(root, 'T1', { job: J });
  assert.equal(F.cli(root, ['task', 'verify', 'T1', '--job', J]).pass, true);
  const ctx = () => core('steps').context(root, stateOf(root, J), core('job').load);
  assert.equal(core('steps').taskDone(ctx(), 'T1'), true);
  // attempt 2: its builder crashes after task start; the branch is unchanged and would pass
  F.cli(root, ['task', 'start', 'T1', '--job', J], { allowFail: false });
  F.built(root, 'T1', { job: J, result: null });
  assert.equal(stateOf(root, J).tasks.T1.builder.outcome, 'no_result');
  const v = F.cli(root, ['task', 'verify', 'T1', '--job', J]);
  assert.equal(v.code, 'no_builder_result', JSON.stringify(v));
  assert.equal(core('steps').taskDone(ctx(), 'T1'), false, 'not done, although its last evidence passed on this tree');
  // a builder that crashed before even running task start spends no attempt but still voids the done
  F.built(root, 'T1', { job: J });
  assert.equal(core('steps').taskDone(ctx(), 'T1'), false, 'a pass from before this attempt does not count');
  assert.equal(F.cli(root, ['task', 'verify', 'T1', '--job', J]).pass, true);
  F.built(root, 'T1', { job: J, result: null });
  assert.equal(core('steps').taskDone(ctx(), 'T1'), false);
});

test('P1.2: task verify refuses a branch that does not contain every dependency', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  customPlan(root, J, TWO);
  const s1 = F.cli(root, ['task', 'start', 'T1', '--job', J], { allowFail: false });
  F.write(s1.worktree, 'src/csv.js', 'module.exports = {}\n');
  F.sh(s1.worktree, 'git add -A && git commit -qm csv');
  F.built(root, 'T1', { job: J });
  assert.equal(F.cli(root, ['task', 'verify', 'T1', '--job', J]).pass, true);
  const s2 = F.cli(root, ['task', 'start', 'T2', '--job', J], { allowFail: false });
  F.write(s2.worktree, 'src/alerts.js', 'module.exports = {}\n');
  F.sh(s2.worktree, 'git add -A && git commit -qm alerts');
  F.built(root, 'T2', { job: J });
  // T1 is rebuilt after T2 started: T2's branch no longer holds the T1 that is done
  F.cli(root, ['task', 'start', 'T1', '--job', J], { allowFail: false });
  F.write(s1.worktree, 'src/csv.js', 'module.exports = { toCsv() {} }\n');
  F.sh(s1.worktree, 'git add -A && git commit -qm csv2');
  F.built(root, 'T1', { job: J });
  assert.equal(F.cli(root, ['task', 'verify', 'T1', '--job', J]).pass, true);
  const v = F.cli(root, ['task', 'verify', 'T2', '--job', J]);
  assert.equal(v.code, 'dependency_not_merged', JSON.stringify(v));
  assert.match(v.message, /T1/);
});

test('P1.2: a failed task restarts from the job branch plus its dependencies; a real conflict is a typed blocked result', () => {
  const root = F.makeRepo();
  F.write(root, 'src/index.js', "module.exports = { ...require('./add') }\n");
  F.sh(root, 'git add -A && git commit -qm index');
  const J = grounded(root);
  customPlan(root, J, TWO);
  // T1 adds its export to index.js
  const s1 = F.cli(root, ['task', 'start', 'T1', '--job', J], { allowFail: false });
  F.write(s1.worktree, 'src/csv.js', 'module.exports = { toCsv() {} }\n');
  F.write(s1.worktree, 'src/index.js', "module.exports = { ...require('./add'), ...require('./csv') }\n");
  F.sh(s1.worktree, 'git add -A && git commit -qm csv');
  F.built(root, 'T1', { job: J });
  assert.equal(F.cli(root, ['task', 'verify', 'T1', '--job', J]).pass, true);
  // T2's branch was built before T1 (stale), touched index.js too, and the task was blocked
  const wt2 = core('tasks').prepareWorktree(root, stateOf(root, J), 'T2');
  F.write(wt2, 'src/index.js', "module.exports = { ...require('./add'), ...require('./alerts') }\n");
  F.write(wt2, 'src/alerts.js', 'module.exports = {}\n');
  F.sh(wt2, 'git add -A && git commit -qm stale-alerts');
  const st = stateOf(root, J);
  st.tasks.T2 = { ...(st.tasks.T2 || {}), attempts: 1, outcome: 'blocked', outcome_reason: 'crashed', outcome_at: new Date().toISOString() };
  core('job').save(root, st);
  const stale = F.sh(root, `git rev-parse ${core('steps').taskBranch(st, 'T2')}`);
  // the restart: no conflict, the branch now is the job branch plus T1, the stale head is kept on a ref
  const r = F.cli(root, ['task', 'start', 'T2', '--job', J]);
  assert.ok(!r.code, JSON.stringify(r));
  assert.equal(r.restarted.reason, 'blocked');
  assert.equal(F.sh(root, `git rev-parse ${r.restarted.backup}`), stale);
  assert.match(fs.readFileSync(path.join(wt2, 'src/index.js'), 'utf8'), /require\('\.\/csv'\)/, 'T1\'s export is there');
  assert.ok(!fs.existsSync(path.join(wt2, 'src/alerts.js')), 'the failed attempt\'s work is not carried over');
  // a second start in the same run does not restart again
  assert.ok(!F.cli(root, ['task', 'start', 'T2', '--job', J]).restarted);
  // dependency_conflict: the job branch itself conflicts with T1 (someone merged a clash)
  const st2 = stateOf(root, J);
  st2.tasks.T2 = { ...st2.tasks.T2, outcome: 'exhausted', outcome_at: new Date(Date.now() + 1000).toISOString() };
  core('job').save(root, st2);
  const jw = core('tasks').ensureJobWorktree(root, st2);
  F.write(jw, 'src/index.js', "module.exports = { ...require('./add'), clash: 1 }\n");
  F.sh(jw, 'git commit -qam clash');
  const c = F.cli(root, ['task', 'start', 'T2', '--job', J]);
  assert.equal(c.code, 'dependency_conflict');
  assert.match(c.message, /blocked_reason/);
  assert.equal(stateOf(root, J).tasks.T2.start_error.code, 'dependency_conflict');
  // the runner turns the builder's empty reply into a typed blocked result, not a crash to retry
  const res = core('tasks').afterBuilder(root, J, 'T2', null, { startedAt: new Date(Date.now() - 60000).toISOString(), label: 'build T2 #2' });
  assert.deepEqual([res.status, res.blocked_reason], ['blocked', 'dependency_conflict']);
  assert.equal(stateOf(root, J).tasks.T2.builder.outcome, 'blocked');
});

test('P1.2: realize reports a dependency_conflict builder as blocked at once, never retried', async () => {
  const { result, calls } = await H.run(REALIZE, realizeBrief(), (prompt, opts) => (opts.agentType === 'factory:builder' ? { status: 'blocked', blocked_reason: 'dependency_conflict', summary: 'Merging T1 into T2 conflicts' } : { pass: true, failures: [] }));
  assert.equal(calls.length, 1);
  assert.equal(result.data.tasks[0].outcome, 'blocked');
  assert.match(result.data.tasks[0].summary, /dependency_conflict/);
});
