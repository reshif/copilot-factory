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
      builder_prompt: `build ${id} attempt {{attempt}}\n{{failures}}`,
    };
  }
  return { workflow: 'realize', job: 'J-0001', scope: 'all', input_hash: 'h', waves: [Object.keys(tasks)], tasks: t, max_parallel_tasks: 4, builder_schema: {} };
}
// task verify as the runner runs it (factory.verify), scripted: always passes unless told.
const PASS = { verify: async (id) => ({ task: id, pass: true, failures: [] }) };

test('P1.4: nothing is verified after a builder that returned nothing (crash, timeout, invalid reply)', async () => {
  let builds = 0;
  const { result, calls } = await H.run(REALIZE, realizeBrief(), (prompt, opts) => {
    builds += 1;
    return builds === 1 ? null : { status: 'done', summary: 'built', swept: [] };
  }, PASS);
  assert.deepEqual(calls.verifies, ['T1'], 'only the attempt whose builder replied is verified');
  assert.equal(result.data.tasks[0].outcome, 'done');
  assert.equal(result.data.tasks[0].attempts, 2, 'the empty builder still used an attempt');
  const second = calls.filter((c) => c.opts.agentType === 'factory:builder')[1];
  assert.match(second.prompt, /builder returned no result/i, 'the next builder is told why attempt 1 failed');
  assert.equal(result.agents.length, 2, 'two builders, no tester agent');
});

test('P1.4: a builder that never replies exhausts the task without a single verify', async () => {
  const { result, calls } = await H.run(REALIZE, realizeBrief({ T1: { retry_limit: 2 } }), () => null, PASS);
  assert.equal(calls.verifies.length, 0);
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
  const { result, calls } = await H.run(REALIZE, realizeBrief(), () => ({ status: 'blocked', blocked_reason: 'dependency_conflict', summary: 'Merging T1 into T2 conflicts' }), PASS);
  assert.equal(calls.length, 1);
  assert.equal(result.data.tasks[0].outcome, 'blocked');
  assert.match(result.data.tasks[0].summary, /dependency_conflict/);
});

// ------------------------------------------------------------------------------- P1.1

// bug@low up to a passing proof (control.test.js's toProve, with the builder's reply recorded).
function toProve(root) {
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  F.cli(root, ['next']);
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 't', claims: [], unknowns: [] }], degraded: [] }));
  F.cli(root, ['next']);
  F.cli(root, ['plan', 'from-contract']);
  F.cli(root, ['next']);
  b = F.cli(root, ['wfargs', 'realize']);
  const s = F.cli(root, ['task', 'start', 'T1']);
  F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
  F.sh(s.worktree, 'git commit -qam fix');
  F.built(root, 'T1');
  F.cli(root, ['task', 'verify', 'T1']);
  F.record(root, F.envelope(b, 'ok', { tasks: [{ id: 'T1', outcome: 'done', attempts: 1 }] }));
  F.cli(root, ['next']);
  b = F.cli(root, ['wfargs', 'reconcile']);
  F.cli(root, ['reconcile', 'run']);
  F.record(root, F.envelope(b, 'ok', { integrator: { status: 'merged', summary: '' } }));
  F.cli(root, ['verify', 'run']);
  return J;
}
const CODE1 = { id: 'code-1', severity: 'major', file: 'src/add.js', line: 1, summary: 'an item without reorder_at is never alerted' };
const challengeRound = (root, data) => {
  const n = F.cli(root, ['next']);
  assert.equal(n.config, 'challenge', JSON.stringify(n));
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  return { brief: b, rec: F.record(root, F.envelope(b, 'ok', { degraded: [], verifications: [], ...data }, { fingerprint: b.fingerprint })) };
};

test('P1.1: an unverified major finding is carried to the next round when the reviewer does not raise it again (e2e finding 1)', () => {
  const root = F.makeRepo();
  const J = toProve(root);
  // round 1: the verifier timed out twice, so code-1 is unverified
  let { rec } = challengeRound(root, { lanes: [{ lane: 'code', findings: [CODE1] }] });
  assert.equal(rec.status, 'retry');
  assert.deepEqual(rec.unverified, ['code-1']);
  // round 2: the fresh reviewer does not repeat code-1 and nobody verified it
  const r2 = challengeRound(root, { lanes: [{ lane: 'code', findings: [] }] });
  assert.equal(r2.brief.carried.length, 1, 'the brief hands the open finding to the workflow');
  assert.equal(r2.brief.carried[0].id, 'code-1');
  assert.equal(r2.brief.verifier.reverify_scale, 2, 'it is re-verified with twice the time');
  rec = r2.rec;
  assert.equal(rec.status, 'retry', 'not "All required lanes pass"');
  assert.deepEqual(rec.unverified, ['code-1']);
  const last = core('ledger').lastStep(root, J, 'challenge');
  const f = last.detail.findings.find((x) => x.id === 'code-1');
  assert.equal(f.status, 'unverified');
  assert.ok(f.carried && f.carried.from_round >= 1);
  assert.equal(last.detail.lanes.code, 'changes');
  // ship refuses; the report lists it
  const ship = F.cli(root, ['ship', '--local']);
  assert.equal(ship.code, 'floor', JSON.stringify(ship));
  assert.ok(ship.details.missing.includes('no_unverified_serious'));
  const rep = F.cli(root, ['report']);
  const text = fs.readFileSync(rep.report || path.join(F.jobDir(root, J), 'completion-report.md'), 'utf8');
  assert.match(text, /Unverified serious review findings[^\n]*: 1 \(code-1/);
  // round 3: the carried finding's verifier settles it (confirmed) → a fix round, not a pass
  rec = challengeRound(root, { lanes: [{ lane: 'code', findings: [] }], verifications: [{ finding_id: 'code-1', carried: true, status: 'confirmed', reason: 'reproduced' }] }).rec;
  assert.equal(rec.status, 'fix', JSON.stringify(rec));
  assert.match(rec.confirmed[0], /^code-1 \[major\]/);
});

test('P1.1: a carried finding refuted by its verifier stops blocking; one never settled parks after the retry cap', () => {
  const root = F.makeRepo();
  toProve(root);
  challengeRound(root, { lanes: [{ lane: 'code', findings: [CODE1] }] });
  const rec = challengeRound(root, { lanes: [{ lane: 'code', findings: [] }], verifications: [{ finding_id: 'code-1', carried: true, status: 'refuted', reason: 'covered by the default' }] }).rec;
  assert.equal(rec.status, 'ok', JSON.stringify(rec));
  assert.equal(F.cli(root, ['finalize', '--mode', 'before_ship']).results.find((r) => r.floor === 'no_unverified_serious').ok, true);

  const root2 = F.makeRepo();
  toProve(root2);
  let last;
  for (let i = 0; i < 6; i++) {
    const n = F.cli(root2, ['next']);
    if (n.action === 'parked') { last = n; break; }
    last = challengeRound(root2, { lanes: [{ lane: 'code', findings: i === 0 ? [CODE1] : [] }] }).rec;
    if (last.status === 'park') break;
  }
  assert.equal(last.status === 'park' || last.action === 'parked', true, JSON.stringify(last));
  const st = F.cli(root2, ['job', 'show']);
  assert.equal(st.status, 'parked');
  assert.match(st.park.reason, /code-1/);
  assert.match(F.reply(root2, 'resume').message, /Resumed/);
  assert.equal(F.cli(root2, ['next']).config, 'challenge', 'resume allows one more re-verification');
});

test('P1.1: the challenge workflow re-verifies carried findings with twice the time cap', async () => {
  const brief = {
    workflow: 'fanout-judge', config: 'challenge', job: 'J-0001', input_hash: 'h', fingerprint: 'f',
    fanout: [{ id: 'code', agent_type: 'factory:code-reviewer', label: 'review · code', prompt: 'review' }],
    judge: null, critique: null,
    verifier: { agent_type: 'factory:finding-verifier', prompt_template: 'verify {{finding}}', severities: ['blocker', 'major'], reverify_scale: 2 },
    carried: [{ ...CODE1, lane: 'code', from_round: 1 }],
  };
  let verifies = 0;
  const { result, calls } = await H.run(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), brief, (prompt, opts) => {
    if (opts.agentType === 'factory:code-reviewer') return { lane: 'code', findings: [{ id: 'code-1', severity: 'major', file: 'src/other.js', summary: 'a different bug' }] };
    verifies += 1;
    return verifies === 1 ? null : { status: 'confirmed', reason: 'ok' };
  });
  const v = calls.filter((c) => c.opts.agentType === 'factory:finding-verifier');
  const carriedCalls = v.filter((c) => /carried/.test(c.opts.label));
  assert.ok(carriedCalls.length >= 1, v.map((c) => c.opts.label).join(', '));
  for (const c of carriedCalls) assert.equal(c.opts.timeoutScale, 2);
  const retry = v.find((c) => /\(retry\)$/.test(c.opts.label));
  assert.equal(retry.opts.timeoutScale, 2, 'a verifier that ran out of time once gets twice the time');
  assert.ok(result.data.verifications.some((x) => x.finding_id === 'code-1' && x.carried), 'the carried verdict is marked carried (ids can repeat across rounds)');
  assert.ok(result.data.verifications.some((x) => x.finding_id === 'code-1' && !x.carried));
});

test('P1.1: a carried finding keeps its own id when a new finding reuses it', () => {
  const root = F.makeRepo();
  const J = toProve(root);
  challengeRound(root, { lanes: [{ lane: 'code', findings: [CODE1] }] });
  const other = { id: 'code-1', severity: 'minor', file: 'README.md', summary: 'typo' };
  challengeRound(root, { lanes: [{ lane: 'code', findings: [other] }] });
  const ids = core('ledger').lastStep(root, J, 'challenge').detail.findings.map((f) => `${f.id}:${f.status}`);
  assert.deepEqual(ids.sort(), ['code-1:minor', 'code-1@r1:unverified']);
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  assert.deepEqual(b.carried.map((c) => c.id), ['code-1@r1']);
});

// ------------------------------------------------------------------------------- P1.3

test('P1.3: a confirmed finding with no file (or in no task\'s paths) reaches every reopened task\'s fix brief', () => {
  const root = F.makeRepo();
  const J = toProve(root);
  const orphan = { id: 'tests-1', severity: 'major', file: null, summary: 'no test covers negative numbers' };
  const outside = { id: 'code-2', severity: 'major', file: 'docs/usage.md', summary: 'the usage doc shows the old signature' };
  const { rec } = challengeRound(root, { lanes: [{ lane: 'code', findings: [orphan, outside] }], verifications: [{ finding_id: 'tests-1', status: 'confirmed' }, { finding_id: 'code-2', status: 'confirmed' }] });
  assert.equal(rec.status, 'fix');
  const n = F.cli(root, ['next']);
  assert.equal(n.scope, 'fix');
  const st = stateOf(root, J);
  assert.deepEqual(st.fix.tasks, ['T1']);
  assert.equal(st.fix.owners['tests-1'], '*', 'no owner: shared by every reopened task');
  const show = F.cli(root, ['task', 'show', 'T1']);
  assert.deepEqual(show.fix_findings.map((f) => f.id).sort(), ['code-2', 'tests-1']);
  assert.ok(show.fix_findings.every((f) => f.shared), 'marked shared, so the builder knows others got it too');
  const brief = F.cli(root, ['wfargs', 'realize', '--scope', 'fix']);
  assert.match(fs.readFileSync(brief.tasks.T1.builder_prompt.split('\n').find((l) => l.trim().startsWith('/')).trim(), 'utf8'), /no single owner/);
});

// ------------------------------------------------------------------------------- P1.5

test('P1.5: a stale-heartbeat run.lock is stale even when its pid is alive (pid reuse, a hung holder)', () => {
  const runner = require('../cli/core/runner');
  const os = require('os');
  const live = { pid: process.pid, host: os.hostname(), heartbeat_sec: 15 };
  assert.equal(runner.lockAlive(live, { mtimeMs: Date.now() }), true);
  assert.equal(runner.lockAlive(live, { mtimeMs: Date.now() - 10 * 60 * 1000 }), false, 'no heartbeat for 10 minutes');
  assert.equal(runner.lockAlive({ ...live, host: 'another-machine' }, { mtimeMs: Date.now() - 10 * 60 * 1000 }), false, 'a heartbeat settles other hosts too');
  assert.equal(runner.lockAlive({ ...live, host: 'another-machine' }, { mtimeMs: Date.now() }), true);
  // a lock from before heartbeats: as before (pid check)
  assert.equal(runner.lockAlive({ pid: process.pid, host: os.hostname() }, { mtimeMs: 0 }), true);
});

test('P1.5: killing factory run kills its agents\' process groups, logs workflow_end interrupted and releases the lock', { skip: process.platform === 'win32' }, async () => {
  const { spawn, execSync } = require('child_process');
  const os = require('os');
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.cli(root, ['next']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-kill-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  // each agent starts a grandchild (as Copilot starts shells) and then hangs
  const script = path.join(dir, 'script.js');
  fs.writeFileSync(script, `module.exports = () => { const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { stdio: 'ignore' }); require('fs').appendFileSync(${JSON.stringify(pidFile)}, c.pid + '\\n'); return { sleep_ms: 600000, json: {} }; };`);
  const env = { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: path.join(__dirname, 'helpers', 'fake-copilot.js'), FAKE_COPILOT_SCRIPT: script };
  const p = spawn('node', [F.BIN, 'run', 'fanout-judge', '--config', 'clarify'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((res) => p.on('exit', (code, signal) => res({ code, signal })));
  const lock = path.join(F.jobDir(root, J), 'run.lock');
  const eventsFile = path.join(root, '.factory', 'log', 'events.jsonl');
  const events = () => (fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse) : []);
  for (let i = 0; i < 200 && !(fs.existsSync(pidFile) && events().some((e) => e.event === 'agent_start')); i++) await new Promise((r) => setTimeout(r, 50));
  const agents = execSync(`pgrep -P ${p.pid} || true`).toString().split('\n').filter(Boolean).map(Number);
  assert.ok(agents.length >= 1, 'an agent is running');
  const lockBody = JSON.parse(fs.readFileSync(lock, 'utf8'));
  assert.ok(lockBody.heartbeat_sec > 0, 'the lock carries a heartbeat');
  p.kill('SIGTERM');
  const ex = await exited;
  assert.equal(ex.code, 143, JSON.stringify(ex));
  await new Promise((r) => setTimeout(r, 300));
  // a zombie (exited, not yet reaped by whatever adopted it) is gone too
  const alive = (pid) => {
    try { process.kill(pid, 0); } catch { return false; }
    try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
  };
  const grand = fs.readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number);
  try {
    for (const pid of agents) assert.equal(alive(pid), false, `agent ${pid} is gone`);
    for (const pid of grand) assert.equal(alive(pid), false, `its child ${pid} is gone`);
  } finally {
    for (const pid of [...agents, ...grand]) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  assert.ok(!fs.existsSync(lock), 'the lock is released');
  const end = events().filter((e) => e.event === 'workflow_end').pop();
  assert.equal(end.outcome, 'interrupted');
  assert.equal(end.signal, 'SIGTERM');
});

test('P1.5: a run killed with SIGKILL (no handler runs) leaves a lock naming its agents; the next run stops them', { skip: process.platform !== 'linux' }, async () => {
  const { spawn, spawnSync } = require('child_process');
  const os = require('os');
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.cli(root, ['next']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-kill9-'));
  const script = path.join(dir, 'script.js');
  fs.writeFileSync(script, 'module.exports = () => ({ sleep_ms: 600000, json: {} });');
  const env = { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: path.join(__dirname, 'helpers', 'fake-copilot.js'), FAKE_COPILOT_SCRIPT: script };
  const p = spawn('node', [F.BIN, 'run', 'fanout-judge', '--config', 'clarify'], { cwd: root, env, stdio: 'ignore' });
  const lock = path.join(F.jobDir(root, J), 'run.lock');
  const agentsOf = () => { try { return JSON.parse(fs.readFileSync(lock, 'utf8')).agents || []; } catch { return []; } };
  for (let i = 0; i < 200 && !agentsOf().length; i++) await new Promise((r) => setTimeout(r, 50));
  const orphans = agentsOf();
  assert.ok(orphans.length >= 1, 'the lock lists the running agent');
  p.kill('SIGKILL');
  await new Promise((r) => p.on('exit', r));
  const alive = (pid) => { try { process.kill(pid, 0); } catch { return false; } try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; } };
  try {
    assert.ok(orphans.every(alive), 'SIGKILL left the agent running');
    // the next run finds the holder dead, stops its agents and takes the lock (a dry run never takes it: use a real one that ends quickly)
    fs.writeFileSync(script, 'module.exports = () => ({ exit: 1, stderr: "stop" });');
    spawnSync('node', [F.BIN, 'run', 'fanout-judge', '--config', 'clarify'], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(orphans.every((pid) => !alive(pid)), 'the orphaned agent was stopped');
  } finally {
    for (const pid of orphans) try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

// ------------------------------------------------------------------------------- P1.6

test('P1.6: the guard refuses any agent command that sets the test-only human seam or the secret override', () => {
  const G = require('../hooks/guard-rules');
  for (const cmd of [
    'FACTORY_TEST_HUMAN=abc NODE_ENV=test factory approve',
    'env FACTORY_TEST_HUMAN_INPUT={code} node bin/factory approve',
    'export FACTORY_SECRET_FILE=/tmp/s; factory approve',
    '$env:FACTORY_TEST_HUMAN="x"; factory approve',
  ]) {
    assert.match(G.checkBash('/tmp', cmd, null, { agent: true }) || '', /test suite's seam/, cmd);
    assert.match(G.checkUnknownCommand('/tmp', cmd, null, {}) || '', /test suite's seam/, cmd);
  }
  assert.equal(G.checkBash('/tmp', 'npm test', null, {}), null);
});
