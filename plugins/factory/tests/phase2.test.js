'use strict';
// Phase 2 of the agent audit (builds that can actually work), and the two Phase 1 follow-ups:
// jobs that were mid-build when the factory was upgraded, and the human's way to settle a
// carried unverified finding. Each test pins one behaviour.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');

const core = (m) => require(`../cli/core/${m}`);
const stateOf = (root, J) => core('job').load(root, J);
const events = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// clarify → H1 → ground; the plan is the test's.
function grounded(root, { risk = 'low' } = {}) {
  const J = F.cli(root, ['job', 'new', '--title', 'Two tasks', '--type', 'bug', '--risk', risk]).job;
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
function customPlan(root, J, plan) {
  F.cli(root, ['plan', 'from-contract']);
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify(Array.isArray(plan) ? { tasks: plan } : plan));
  const v = F.cli(root, ['plan', 'validate', '--job', J]);
  assert.equal(v.valid, true, JSON.stringify(v));
  const b = core('invalidation').current(root, stateOf(root, J));
  core('ledger').append(root, J, { kind: 'step', step: 'decompose', ok: true, bound: { plan: b.plan, contract: b.contract }, detail: { source: 'test' } });
  return v;
}
const VC = [{ cmd: 'node tests/add.test.js', covers: ['AC-1'] }];
const T1 = { id: 'T1', objective: 'fix add', allowed_paths: ['src/add.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: VC };

// ------------------------------------------------------------------ upgrade: in-flight jobs

// A task started by 0.5.3: the state has attempts but neither a builder record nor the marker
// that this factory's `task start` writes.
function asIfStartedBefore(root, J, id) {
  const s = stateOf(root, J);
  const { builder_tracking: _t, builder: _b, ...rest } = s.tasks[id];
  s.tasks[id] = rest;
  core('job').save(root, s);
}

test('upgrade: a task started before builder replies were recorded verifies once, with an event, then needs a rebuild', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  customPlan(root, J, [T1]);
  const s = F.cli(root, ['task', 'start', 'T1', '--job', J], { allowFail: false });
  F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
  F.sh(s.worktree, 'git commit -qam fix');
  asIfStartedBefore(root, J, 'T1');
  const v = F.cli(root, ['task', 'verify', 'T1', '--job', J]);
  assert.equal(v.pass, true, JSON.stringify(v));
  assert.match(v.legacy, /without a builder record/);
  const ev = events(root).filter((e) => e.event === 'legacy_verify');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].task, 'T1');
  const ctx = core('steps').context(root, stateOf(root, J), core('job').load);
  assert.equal(core('steps').taskDone(ctx, 'T1'), true, 'the legacy pass counts');
  // once: a second verify of the same attempt is refused
  const again = F.cli(root, ['task', 'verify', 'T1', '--job', J]);
  assert.equal(again.code, 'no_builder_result');
  assert.match(again.message, /one verification without a builder record/);
  // a task this factory started is never legacy
  F.cli(root, ['task', 'start', 'T1', '--job', J], { allowFail: false });
  assert.equal(stateOf(root, J).tasks.T1.builder_tracking, 1);
  assert.equal(F.cli(root, ['task', 'verify', 'T1', '--job', J]).code, 'no_builder_result');
});

test('upgrade: a task this factory started without a builder reply is not legacy', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  customPlan(root, J, [T1]);
  const s = F.cli(root, ['task', 'start', 'T1', '--job', J], { allowFail: false });
  F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
  F.sh(s.worktree, 'git commit -qam fix');
  assert.equal(F.cli(root, ['task', 'verify', 'T1', '--job', J]).code, 'no_builder_result');
  assert.equal(events(root).filter((e) => e.event === 'legacy_verify').length, 0);
});
