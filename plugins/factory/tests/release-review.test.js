'use strict';
// Release review of Phases 1 and 2: each test pins a defect found in review (it failed before
// its fix) or an upgrade-safety property for jobs that were mid-build on 0.5.3.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');

const core = (m) => require(`../cli/core/${m}`);
const stateOf = (root, J) => core('job').load(root, J);

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

for (const limit of [1, 2]) test(`per-wave integration: a wave whose integrated build stays broken stops later waves from building on it (retry_limit ${limit})`, async () => {
  const root = F.makeRepo();
  const J = grounded(root);
  // T2 passes on its own branch but breaks once T1 is integrated; it has one attempt only, so
  // the integration failure exhausts it (at once, or after a rebuild that fails its own verify). T3 (wave 2) depends on T1 only.
  customPlan(root, J, [
    { id: 'T1', objective: 'fix add', allowed_paths: ['src/add.js'], criteria_ids: ['AC-1'], verify_commands: VC },
    { id: 'T2', objective: 'b helper', allowed_paths: ['src/b.js', 'tests/b.test.js'], criteria_ids: ['AC-1'], retry_limit: limit, verify_commands: [{ cmd: 'node tests/b.test.js', covers: ['AC-1'] }] },
    { id: 'T3', objective: 'c helper', allowed_paths: ['src/c.js'], depends_on: ['T1'], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node src/c.js', covers: ['AC-1'] }] },
  ]);
  assert.equal(F.cli(root, ['next']).workflow, 'realize');
  const brief = F.cli(root, ['wfargs', 'realize']);
  assert.equal(brief.integrate_each_wave, true);
  const H = require('./helpers/workflow-harness');
  const { result, calls } = await H.run(path.join(F.PLUGIN, 'workflows', 'realize.js'), brief, (prompt, opts) => {
    const id = /^build (T\d+)/.exec(opts.label)[1];
    const wt = F.cli(root, ['task', 'start', id, '--job', J], { allowFail: false }).worktree;
    if (id === 'T1') F.write(wt, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
    if (id === 'T2') {
      F.write(wt, 'src/b.js', 'module.exports = 1;\n');
      F.write(wt, 'tests/b.test.js', "const add = require('../src/add');\nif (add(2, 3) === 5) { console.error('src/b.js is wrong with the fixed add'); process.exit(1); }\n");
    }
    if (id === 'T3') F.write(wt, 'src/c.js', 'module.exports = 3;\n');
    F.sh(wt, `git add -A && git commit -q --allow-empty -m "${opts.label}"`);
    return { status: 'done', summary: opts.label, swept: [] };
  });
  const built = calls.filter((c) => /^build /.test(c.opts.label)).map((c) => c.opts.label);
  assert.ok(!built.some((l) => /^build T3/.test(l)), `T3 must not be built on a broken integrated branch (built: ${built.join(', ')})`);
  const out = Object.fromEntries(result.data.tasks.map((t) => [t.id, t]));
  assert.equal(out.T2.outcome, 'exhausted');
  assert.equal(out.T3.outcome, 'skipped_dependency');
  assert.match(out.T3.summary, /integrat/i);
  assert.equal(result.status, 'park');
});

test('per-wave integration routes a break to this wave\'s tasks named in the output, not to an earlier wave\'s done producer that a traceback passes through', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  const P = "module.exports = { total: (rows) => rows.reduce((s, r) => { if (typeof r.qty !== 'number') throw new Error('bad row'); return s + r.qty; }, 0) };\n";
  const C = "const fs = require('fs');\nconst path = require('path');\nconst p = require('./p');\nconst f = path.join(__dirname, '..', 'data', 'rows.json');\nmodule.exports = () => p.total(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [{ qty: 1 }, { qty: 2 }]);\n";
  customPlan(root, J, [
    { id: 'T1', objective: 'fix add, and total()', allowed_paths: ['src/add.js', 'src/p.js'], criteria_ids: ['AC-1'], verify_commands: VC },
    { id: 'T2', objective: 'consumer', allowed_paths: ['src/c.js', 'tests/c.test.js'], depends_on: ['T1'], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node tests/c.test.js', covers: ['AC-1'] }] },
    { id: 'T3', objective: 'rows data', allowed_paths: ['data/**'], depends_on: ['T1'], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'test -f data/rows.json', covers: ['AC-1'] }] },
  ]);
  const build = (id, files) => {
    const wt = F.cli(root, ['task', 'start', id, '--job', J], { allowFail: false }).worktree;
    for (const [f, text] of Object.entries(files)) F.write(wt, f, text);
    F.sh(wt, `git add -A && git commit -qm ${id}`);
    F.built(root, id, { job: J });
    const v = F.cli(root, ['task', 'verify', id, '--job', J]);
    assert.equal(v.pass, true, JSON.stringify(v));
  };
  build('T1', { 'src/add.js': 'module.exports = (a, b) => a + b;\n', 'src/p.js': P });
  assert.equal(core('reconcile').integrateWave(root, J, ['T1'], { wave: 1 }).ok, true);
  build('T2', { 'src/c.js': C, 'tests/c.test.js': "if (require('../src/c')() !== 3) process.exit(1);\n" });
  build('T3', { 'data/rows.json': '[{"quantity": 1}, {"quantity": 2}]\n' }); // the sibling's data breaks T2's code path
  const r = core('reconcile').integrateWave(root, J, ['T2', 'T3'], { wave: 2 });
  assert.equal(r.ok, false);
  assert.match(r.failures[0].output, /src\/p\.js/, 'the traceback passes through T1\'s file');
  assert.deepEqual(Object.keys(r.route), ['T2'], 'this wave\'s task named in the output, not the earlier wave\'s producer');
  assert.equal(stateOf(root, J).tasks.T1.needs_work, undefined, 'T1 (done, integrated, unchanged) is not reopened');
});
