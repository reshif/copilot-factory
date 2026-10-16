'use strict';
// Release review of Phases 1 and 2: each test pins a defect found in review (it failed before
// its fix) or an upgrade-safety property for jobs that were mid-build on 0.5.3.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');
// the machine these tests assume: python3 -m venv works; no uv, poetry or virtualenv (fix 0.10.1)
require('./helpers/machine').use(require('./helpers/machine').VENV_ONLY);

const core = (m) => require(`../cli/core/${m}`);
const stateOf = (root, J) => core('job').load(root, J);

// clarify → H1 → ground; the plan is the test's.
function grounded(root, { risk = 'low' } = {}) {
  const J = F.cli(root, ['job', 'new', '--title', 'Two tasks', '--type', 'bug', '--risk', risk]).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.clarify(root);
  let b;
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

test('local ci verify (the merge result re-verified for ci_reverify) runs inside the confirmed build environment, like task verify and prove', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Env job', '--type', 'bug', '--risk', 'low']).job;
  // a verify command that passes only inside the environment (as `python -m pytest` needs the venv)
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText({ verify: '`test "$FACTORY_REVIEW_MARK" = inside` (AC-1)' }));
  const envFile = require("./helpers/tmp").track(path.join(root, '..', `${path.basename(root)}-env.json`));
  fs.writeFileSync(envFile, JSON.stringify({ version: 1, name: 'marked', setup: [], env: { FACTORY_REVIEW_MARK: 'inside' } }));
  core('environment').confirm(root, { file: envFile, channel: 'chat' });
  const s = stateOf(root, J);
  s.pr = { merged: true, merge_commit: F.sh(root, 'git rev-parse HEAD').trim() };
  core('job').save(root, s);
  const r = core('ship').ciVerify(root, { jobId: J });
  assert.equal(r.ok, true, JSON.stringify(r.failed));
});

test('environment teardown: what setup started per worktree (a compose project per worktree) is torn down when the job\'s worktrees are removed; the Nautobot preset uses invoke destroy', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  customPlan(root, J, [
    { id: 'T1', objective: 'fix add', allowed_paths: ['src/add.js'], criteria_ids: ['AC-1'], verify_commands: VC },
    { id: 'T2', objective: 'never started', allowed_paths: ['src/b.js'], criteria_ids: ['AC-1'], verify_commands: VC },
  ]);
  const envFile = require("./helpers/tmp").track(path.join(root, '..', `${path.basename(root)}-env.json`));
  const marks = require("./helpers/tmp").track(path.join(root, '..', `${path.basename(root)}-torn`));
  fs.mkdirSync(marks);
  fs.writeFileSync(envFile, JSON.stringify({ version: 1, name: 'compose', setup: ['true'], teardown: `touch ${marks}/{slug}` }));
  assert.deepEqual(core('environment').problems(JSON.parse(fs.readFileSync(envFile, 'utf8'))), []);
  core('environment').confirm(root, { file: envFile, channel: 'chat' });
  const state = stateOf(root, J);
  const wt = core('tasks').prepareWorktree(root, state, 'T1');
  assert.equal(core('environment').ensure(root, state, { taskId: 'T1', wt }).ok, true);
  core('tasks').prepareWorktree(root, state, 'T2'); // a worktree setup never ran in: nothing to tear down
  core('lifecycle').cleanup(root, stateOf(root, J));
  assert.deepEqual(fs.readdirSync(marks), [`${J.toLowerCase()}-t1`]);
  // the Nautobot app preset: one compose project per worktree, removed with invoke destroy
  const nb = F.makeRepo();
  F.write(nb, 'pyproject.toml', '[tool.poetry]\nname = "nautobot-app-x"\n[tool.poetry.dependencies]\nnautobot = "^2"\n');
  F.write(nb, 'tasks.py', 'from invoke import Collection\nnamespace = Collection("nautobot_app_x")\n');
  assert.equal(core('environment').detect(nb).teardown, 'invoke destroy');
});

test('environment detection never builds a setup command from a file name that carries shell syntax', () => {
  const root = F.makeRepo();
  F.write(root, 'requirements-dev.txt', 'pytest\n');
  F.write(root, 'requirements$(touch pwned).txt', 'x\n');
  F.write(root, 'requirements-test;touch pwned;.txt', 'x\n');
  const p = core('environment').detect(root);
  assert.equal(p.name, 'python-venv');
  assert.ok(p.setup.includes('.factory-venv/bin/python -m pip install -q --retries 5 --timeout 60 -r requirements-dev.txt'), JSON.stringify(p.setup));
  for (const c of p.setup) assert.doesNotMatch(c, /[;$`|&()]/, c);
  assert.ok(!p.evidence.some((e) => /[;$]/.test(e)), JSON.stringify(p.evidence));
});

test('job.mutate: a state lock left by a process that died (Ctrl+C during task verify) is taken over at once, not after a 30 s wait and a failure', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  const file = `${require('../cli/lib/paths').jobPaths(root, J).state}.lock`;
  // what a CLI killed inside mutate leaves: a fresh lock naming a pid that no longer runs
  const dead = require('child_process').spawnSync('node', ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(file, JSON.stringify({ pid: Number(dead), host: require('os').hostname(), at: new Date().toISOString() }));
  const t0 = Date.now();
  core('job').mutate(root, J, (s) => { s.tasks.T9 = { note: 'written' }; });
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.equal(stateOf(root, J).tasks.T9.note, 'written');
  assert.ok(!fs.existsSync(file), 'released');
  // a live holder is still waited for (here: this process, for a short while, then refused)
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: require('os').hostname(), at: new Date().toISOString() }));
  assert.throws(() => core('job').mutate(root, J, () => {}, { waitMs: 300 }), /stayed locked/);
  fs.rmSync(file, { force: true });
});

test('environment services: when the health check fails after the job brought them up (a reboot, docker restarted), they are brought up again, not parked on every resume', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  customPlan(root, J, [{ id: 'T1', objective: 'fix add', allowed_paths: ['src/add.js'], criteria_ids: ['AC-1'], verify_commands: VC }]);
  const svc = require("./helpers/tmp").track(path.join(root, '..', `${path.basename(root)}-svc`));
  const envFile = require("./helpers/tmp").track(path.join(root, '..', `${path.basename(root)}-env.json`));
  fs.writeFileSync(envFile, JSON.stringify({ version: 1, name: 'svc', setup: ['true'], services: { up: `mkdir -p ${svc} && touch ${svc}/running && echo x >> ${svc}/ups`, health: `test -f ${svc}/running`, down: `rm -f ${svc}/running` } }));
  core('environment').confirm(root, { file: envFile, channel: 'chat' });
  const wt = core('tasks').prepareWorktree(root, stateOf(root, J), 'T1');
  assert.equal(core('environment').ensure(root, stateOf(root, J), { taskId: 'T1', wt }).ok, true);
  assert.equal(core('environment').ensure(root, stateOf(root, J), { taskId: 'T1', wt }).ok, true);
  assert.equal(fs.readFileSync(path.join(svc, 'ups'), 'utf8').trim().split('\n').length, 1, 'up once per job while healthy');
  fs.rmSync(path.join(svc, 'running')); // the machine rebooted: the containers are gone
  const r = core('environment').ensure(root, stateOf(root, J), { taskId: 'T1', wt });
  assert.equal(r.ok, true, JSON.stringify(r.broken));
  assert.equal(fs.readFileSync(path.join(svc, 'ups'), 'utf8').trim().split('\n').length, 2, 'brought up again once');
  // still unhealthy after a fresh up: that is a broken environment
  fs.writeFileSync(envFile, JSON.stringify({ version: 1, name: 'svc', setup: ['true'], services: { up: 'true', health: 'false' } }));
  core('environment').confirm(root, { file: envFile, channel: 'chat' });
  const b = core('environment').ensure(root, stateOf(root, J), { taskId: 'T1', wt });
  assert.equal(b.ok, false);
  assert.match(b.broken.reason, /^environment broken: false exit 1/);
});

test('worktrees: one prune-and-add at a time per repository (a parallel prune deleted another task\'s half-made worktree: the flaky "prepared in parallel")', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  customPlan(root, J, [{ id: 'T1', objective: 'fix add', allowed_paths: ['src/add.js'], criteria_ids: ['AC-1'], verify_commands: VC }]);
  const lock = path.join(root, '.factory', 'worktrees.lock');
  // another live process is adding a worktree: this one waits for it instead of pruning under it
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: require('os').hostname(), at: new Date().toISOString() }));
  const { spawn, spawnSync } = require('child_process');
  const release = spawn('node', ['-e', `setTimeout(() => require('fs').rmSync(${JSON.stringify(lock)}, { force: true }), 1500)`]);
  const t0 = Date.now();
  const script = `const t = require(${JSON.stringify(path.join(__dirname, '..', 'cli', 'core', 'tasks.js'))}); const j = require(${JSON.stringify(path.join(__dirname, '..', 'cli', 'core', 'job.js'))}); console.log(t.prepareWorktree(${JSON.stringify(root)}, j.load(${JSON.stringify(root)}, ${JSON.stringify(J)}), 'T1'));`;
  const r = spawnSync('node', ['-e', script], { cwd: root, encoding: 'utf8' });
  release.kill();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 >= 1400, `waited for the lock (${Date.now() - t0} ms)`);
  assert.ok(fs.existsSync(path.join(r.stdout.trim(), '.git')), 'the worktree was made');
  assert.ok(!fs.existsSync(lock), 'released');
});

test('environment services: a wave\'s tasks prepared in parallel bring the job\'s services up once, not concurrently', async () => {
  const root = F.makeRepo();
  const J = grounded(root);
  const ids = ['T1', 'T2', 'T3', 'T4'];
  customPlan(root, J, ids.map((id) => ({ id, objective: `task ${id}`, allowed_paths: [`src/${id}.js`], criteria_ids: ['AC-1'], verify_commands: VC })));
  const svc = require("./helpers/tmp").track(path.join(root, '..', `${path.basename(root)}-svc`));
  fs.mkdirSync(svc);
  const envFile = require("./helpers/tmp").track(path.join(root, '..', `${path.basename(root)}-env.json`));
  // like two `docker compose up` on one project at once: the second fails while the first works
  const up = `if [ -e ${svc}/busy ]; then exit 1; fi; touch ${svc}/busy; sleep 1; touch ${svc}/running; echo x >> ${svc}/ups; rm ${svc}/busy`;
  fs.writeFileSync(envFile, JSON.stringify({ version: 1, name: 'svc', setup: ['true'], services: { up, health: `test -f ${svc}/running` } }));
  core('environment').confirm(root, { file: envFile, channel: 'chat' });
  const { spawn } = require('child_process');
  const prep = (id) => new Promise((res) => {
    let out = '';
    const c = spawn('node', [F.BIN, 'env', 'prepare', id, '--job', J], { cwd: root, env: { ...process.env, FACTORY_ROOT: '' } });
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => res(JSON.parse(out)));
  });
  const rs = await Promise.all(ids.map(prep));
  assert.deepEqual(rs.map((r) => r.ok), [true, true, true, true], JSON.stringify(rs.filter((r) => !r.ok)));
  assert.equal(fs.readFileSync(path.join(svc, 'ups'), 'utf8').trim().split('\n').length, 1);
});
