'use strict';
// Regressions from a real job: worktrees left "dirty" by the verify commands' own caches,
// a security fix lost between overlapping tasks (stale base, conflict resolved by picking a
// side, a re-found finding downgraded), doc criteria sent to builders, clarify question rounds
// counted as failures, an optional analyst field, and agents denied reading their own job.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');

const core = (m) => require(`../cli/core/${m}`);
const ledgerOf = (root, J) => core('ledger').all(root, J);
const state = (root, J) => core('job').load(root, J);

// clarify → H1 → ground done; returns the job id. The plan is up to the test.
function grounded(root, contract = {}) {
  const J = F.cli(root, ['job', 'new', '--title', 'Sync VLAN', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText(contract));
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 'codebase', claims: [{ claim: 'x', source: 'src/add.js:1' }], unknowns: [] }], degraded: [] }));
  F.cli(root, ['next']);
  return J;
}

// A hand-written plan, validated and recorded as the decompose step.
function customPlan(root, J, tasks) {
  F.cli(root, ['plan', 'from-contract']);
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks }));
  const v = F.cli(root, ['plan', 'validate', '--job', J]);
  assert.equal(v.valid, true, JSON.stringify(v));
  const st = state(root, J);
  const b = core('invalidation').current(root, st);
  core('ledger').append(root, J, { kind: 'step', step: 'decompose', ok: true, bound: { plan: b.plan, contract: b.contract }, detail: { source: 'test' } });
  return v;
}

// One task built by hand: start, write files, commit, verify.
function build(root, J, id, files, msg = `${id} build`) {
  const s = F.cli(root, ['task', 'start', id, '--job', J], { allowFail: false });
  for (const [f, c] of Object.entries(files)) F.write(s.worktree, f, typeof c === 'function' ? c(fs.existsSync(path.join(s.worktree, f)) ? fs.readFileSync(path.join(s.worktree, f), 'utf8') : '') : c);
  F.sh(s.worktree, `git add -A && git commit -qm "${msg}"`);
  F.built(root, id, { job: J }); // the builder replied done (the runner records it)
  const v = F.cli(root, ['task', 'verify', id, '--job', J]);
  assert.equal(v.pass, true, JSON.stringify(v));
  return s;
}

const VC = [{ cmd: 'true', covers: ['AC-1'] }];

// ------------------------------------------------------------------- 1 dirty_worktree

test('1 dirty_worktree: a python verify command never dirties the task or job worktree; excludes reach repositories initialised earlier', () => {
  const root = F.makeRepo();
  const J = grounded(root, { verify: '`python3 -c "import sys; sys.path.insert(0, \'src\'); import vlan"` (AC-1)' });
  F.cli(root, ['plan', 'from-contract'], { allowFail: false });
  // a repository initialised before the cache excludes existed
  const exclude = path.join(root, '.git', 'info', 'exclude');
  fs.writeFileSync(exclude, '.factory/\n');
  const s = F.cli(root, ['task', 'start', 'T1', '--job', J], { allowFail: false });
  const ex = fs.readFileSync(exclude, 'utf8');
  for (const p of ['__pycache__/', '*.py[cod]', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.tox/', 'node_modules/.cache/', '.DS_Store']) assert.ok(ex.split('\n').includes(p), `${p} excluded`);
  assert.equal(ex.split('\n').filter((l) => l === '.factory/').length, 1, 'not duplicated');
  F.write(s.worktree, 'src/vlan.py', 'VLANS = []\n');
  F.sh(s.worktree, 'git add -A && git commit -qm vlan');
  // a cache written by the build itself (not by the factory's verify) is ignored too
  F.sh(s.worktree, 'python3 -c "import sys; sys.path.insert(0, \'src\'); import vlan"');
  F.built(root, 'T1', { job: J }); // the builder replied done (the runner records it)
  assert.equal(F.cli(root, ['task', 'verify', 'T1', '--job', J]).pass, true);
  const again = F.cli(root, ['task', 'verify', 'T1', '--job', J]);
  assert.equal(again.pass, true, `verify #2: ${JSON.stringify(again)}`);
  assert.equal(F.cli(root, ['reconcile', 'run', '--job', J]).status, 'merged');
  assert.equal(F.cli(root, ['verify', 'run', '--job', J]).ok, true);
  const v2 = F.cli(root, ['verify', 'run', '--job', J]);
  assert.equal(v2.ok, true, `verify run #2: ${JSON.stringify(v2)}`);
  // verify commands run with PYTHONDONTWRITEBYTECODE=1
  assert.equal(require('../cli/lib/run').runCommand('echo "$PYTHONDONTWRITEBYTECODE"', root).output.trim(), '1');
});

test('1 dirty_worktree: a worktree folder deleted without git worktree prune is recreated (prune before add)', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  F.cli(root, ['plan', 'from-contract'], { allowFail: false });
  core('tasks').prepareWorktree(root, state(root, J), 'T1');
  fs.rmSync(path.join(root, '.factory', 'worktrees'), { recursive: true, force: true });
  const s = F.cli(root, ['task', 'start', 'T1', '--job', J]);
  assert.equal(s.__code, 0, JSON.stringify(s));
  assert.ok(fs.existsSync(path.join(s.worktree, '.git')));
});

test('1 dirty_worktree: factory run never starts a task agent at the project root when its worktree cannot be prepared', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  F.cli(root, ['plan', 'from-contract'], { allowFail: false });
  assert.equal(F.cli(root, ['next']).workflow, 'realize');
  // something that is not a worktree sits where T1's worktree goes
  fs.mkdirSync(path.join(root, '.factory', 'worktrees'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'worktrees', `${J}-T1`), 'not a worktree');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-runner-'));
  const log = path.join(dir, 'copilot.jsonl');
  const script = path.join(dir, 'script.js');
  fs.writeFileSync(script, 'module.exports = (c) => ({ status: "done", summary: "built at " + c.cwd, swept: [] });');
  const r = spawnSync('node', [F.BIN, 'run', 'realize', '--json'], { cwd: root, encoding: 'utf8', timeout: 120000, env: { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: path.join(__dirname, 'helpers', 'fake-copilot.js'), FAKE_COPILOT_SCRIPT: script, FAKE_COPILOT_LOG: log } });
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'park', r.stdout);
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.equal(calls.length, 0, 'no builder or tester was started (least of all at the root)');
  const runs = fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.event === 'agent_run');
  assert.ok(runs.length && runs.every((e) => e.code === 'no_worktree' && e.outcome === 'error' && e.cwd === null), JSON.stringify(runs[0]));
  assert.match(runs[0].errors[0], /could not prepare the worktree for T1/);
  assert.equal(F.sh(root, 'git status --porcelain --untracked-files=no'), '', 'the root checkout is untouched');
});

// ------------------------------------------------------------------- 2 lost fix

test('2 lost fix: an earlier-wave task on overlapping paths is an implicit dependency; the later task starts from its change', () => {
  const root = F.makeRepo();
  F.write(root, 'src/b.py', 'def check(x):\n    return True  # TODO validate\n');
  F.sh(root, 'git add -A && git commit -qm py');
  const J = grounded(root);
  const v = customPlan(root, J, [
    { id: 'T2', objective: 'validate input', allowed_paths: ['src/b.py'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: VC },
    { id: 'T4', objective: 'add sync', allowed_paths: ['src/b.py', 'src/d.py'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: VC },
    { id: 'T5', objective: 'other module', allowed_paths: ['src/e.py'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: VC },
  ]);
  assert.deepEqual(v.waves, [['T2', 'T5'], ['T4']]);
  assert.deepEqual(core('plan').effectiveDeps(JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'plan.json'), 'utf8')).tasks, 'T4'), ['T2']);
  const brief = F.cli(root, ['wfargs', 'realize']);
  assert.deepEqual(brief.tasks.T4.depends_on, ['T2'], 'a failed T2 skips T4 in the workflow');
  assert.deepEqual(brief.tasks.T5.depends_on, []);
  const early = F.cli(root, ['task', 'start', 'T4', '--job', J]);
  assert.equal(early.code, 'dependency_not_done');
  assert.match(early.message, /earlier wave touching the same paths/);
  build(root, J, 'T2', { 'src/b.py': 'def check(x):\n    return isinstance(x, int) and 1 <= x <= 4094  # SECURITY FIX\n' });
  build(root, J, 'T4', {
    'src/b.py': (cur) => {
      assert.match(cur, /SECURITY FIX/, 'T4 starts from T2\'s change');
      return `${cur}\n\ndef sync():\n    return check(5)\n`;
    },
    'src/d.py': 'D = 1\n',
  });
  build(root, J, 'T5', { 'src/e.py': 'E = 1\n' });
  // T2's file came into T4 by merge: not T4's change, not a scope violation
  const ev = JSON.parse(fs.readFileSync(state(root, J).tasks.T4.evidence.file, 'utf8'));
  assert.deepEqual(ev.changed_files, ['src/b.py', 'src/d.py']);
  assert.equal(F.cli(root, ['reconcile', 'run', '--job', J]).status, 'merged');
  assert.match(F.sh(root, `git show ${state(root, J).branch}:src/b.py`), /SECURITY FIX[\s\S]*def sync/);
});

test('2 lost fix: reconcile refuses a conflict resolution that drops an already-merged task\'s lines (regression → park)', () => {
  const root = F.makeRepo();
  F.write(root, 'src/b.py', 'def check(x):\n    return True  # TODO validate\n');
  F.sh(root, 'git add -A && git commit -qm py');
  const J = grounded(root);
  customPlan(root, J, [
    { id: 'T2', objective: 'validate input', allowed_paths: ['src/b.py'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: VC },
    { id: 'T4', objective: 'add sync', allowed_paths: ['src/b.py'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: VC },
  ]);
  // T4's branch was built from the stale base (as before implicit dependencies existed)
  const wt4 = core('tasks').prepareWorktree(root, state(root, J), 'T4');
  F.write(wt4, 'src/b.py', 'def check(x):\n    return True  # TODO validate (T4)\n\n\ndef sync():\n    return check(5)\n');
  F.sh(wt4, 'git commit -qam T4');
  build(root, J, 'T2', { 'src/b.py': 'def check(x):\n    return isinstance(x, int) and 1 <= x <= 4094  # SECURITY FIX\n' });
  // the CLI won't build T4 on top of T2 silently: bringing T2 in conflicts
  assert.equal(F.cli(root, ['task', 'start', 'T4', '--job', J]).code, 'dependency_conflict');
  const st = state(root, J);
  st.tasks.T4 = { ...(st.tasks.T4 || {}), started_at: new Date().toISOString(), start_commit: st.base_commit };
  core('job').save(root, st);
  F.built(root, 'T4', { job: J }); // the builder replied done (the runner records it)
  // task verify no longer passes a branch without its implied dependency T2 (outcome
  // integrity, P1.2); the guard below is still tested on such a branch, as an older factory
  // (or a hand edit) could have left it: its passing evidence is written directly.
  assert.equal(F.cli(root, ['task', 'verify', 'T4', '--job', J]).code, 'dependency_not_merged');
  const st4 = state(root, J);
  const tb = core('steps').taskBranch(st4, 'T4');
  st4.tasks.T4.evidence = { id: 'T4-forced', file: null, pass: true, tree: require('../cli/lib/git').fingerprint(root, tb), at: new Date().toISOString(), builder_at: st4.tasks.T4.builder.at };
  core('job').save(root, st4);
  const brief = F.cli(root, ['wfargs', 'reconcile']);
  assert.match(fs.readFileSync(brief.integrator.prompt.split('\n')[1].trim(), 'utf8'), /reconcile continue/);
  assert.match(fs.readFileSync(path.join(F.PLUGIN, 'agents', 'integrator.agent.md'), 'utf8'), /never picks a side[\s\S]*Never `git checkout --ours\/--theirs`/);
  const r = F.cli(root, ['reconcile', 'run', '--job', J]);
  assert.equal(r.status, 'textual_conflict');
  const t2merge = F.sh(root, `git rev-parse ${st.branch}`);
  // an integrator "keeping T4's intent" takes T4's side of the whole file
  F.sh(r.worktree, 'git checkout --theirs src/b.py && git add src/b.py');
  const c = F.cli(root, ['reconcile', 'continue', '--job', J]);
  assert.equal(c.status, 'regression', JSON.stringify(c));
  assert.deepEqual(c.files, ['src/b.py']);
  assert.match(c.message, /SECURITY FIX/);
  assert.equal(F.sh(root, `git rev-parse ${st.branch}`), t2merge, 'the bad merge was undone');
  assert.match(F.sh(root, `git show ${st.branch}:src/b.py`), /SECURITY FIX/);
  const last = core('ledger').lastStep(root, J, 'reconcile');
  assert.equal(last.ok, false);
  assert.deepEqual(last.detail.regression.files, ['src/b.py']);
  const rec = F.record(root, F.envelope(brief, 'park', { integrator: { status: 'regression', summary: c.message } }));
  assert.equal(rec.status, 'park');
  assert.equal(state(root, J).status, 'parked');
  assert.match(state(root, J).park.reason, /^Reconcile regression: .*SECURITY FIX/);
});

test('2 lost fix: one owner per finding (blame + Factory-Task); a fix round merges the job branch first; a fix-round line another task drops is a regression', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  customPlan(root, J, [
    { id: 'T1', objective: 'fix add', allowed_paths: ['src/add.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: VC },
    { id: 'T2', objective: 'add sync', allowed_paths: ['src/add.js', 'src/sync.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: VC },
    { id: 'T3', objective: 'other', allowed_paths: ['src/other.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: VC },
  ]);
  build(root, J, 'T1', { 'src/add.js': 'module.exports = (a, b) => a + b;\n' });
  build(root, J, 'T3', { 'src/other.js': 'module.exports = 1;\n' });
  build(root, J, 'T2', { 'src/add.js': (cur) => `${cur}module.exports.sync = () => 1;\n`, 'src/sync.js': 'module.exports = 2;\n' });
  assert.equal(F.cli(root, ['reconcile', 'run', '--job', J]).status, 'merged');
  const review = core('review');
  review.record(root, { jobId: J, payload: { lanes: [{ lane: 'code', findings: [
    { id: 'code-1', severity: 'major', file: 'src/add.js', line: 1, summary: 'Non-numbers are not rejected' },
    { id: 'code-2', severity: 'major', file: 'src/sync.js', line: 1, summary: 'sync is a constant' },
  ] }], verifications: [{ finding_id: 'code-1', status: 'confirmed' }, { finding_id: 'code-2', status: 'confirmed' }] } });
  const n = F.cli(root, ['next']);
  assert.equal(n.scope, 'fix');
  const fix = state(root, J).fix;
  assert.deepEqual(fix.owners, { 'code-1': 'T1', 'code-2': 'T2' }, 'src/add.js line 1 was written by T1, though T2 may touch it too');
  assert.deepEqual(fix.tasks.sort(), ['T1', 'T2']);
  assert.deepEqual(F.cli(root, ['task', 'show', 'T1', '--job', J]).fix_findings.map((f) => f.id), ['code-1']);
  assert.deepEqual(F.cli(root, ['task', 'show', 'T2', '--job', J]).fix_findings.map((f) => f.id), ['code-2']);
  // T1's fix: its commit carries Factory-Fix
  const s1 = build(root, J, 'T1', { 'src/add.js': "module.exports = (a, b) => { if (typeof a !== 'number') throw new TypeError('numbers only'); return a + b; };\nmodule.exports.sync = () => 1;\n" }, 'validate');
  assert.match(F.sh(s1.worktree, 'git log -1 --format=%B'), /Factory-Fix: fix/);
  assert.match(F.sh(s1.worktree, 'git log -1 --format=%B'), /Factory-Task: T1/);
  // T2 starts from the job branch and T1's fix ... and rewrites add.js from stale content
  build(root, J, 'T2', {
    'src/add.js': (cur) => {
      assert.match(cur, /numbers only/, 'the fix round started from the integrated build and T1');
      return 'module.exports = (a, b) => a + b;\nmodule.exports.sync = () => 1;\n';
    },
    'src/sync.js': 'module.exports = () => 2;\n',
  });
  const r = F.cli(root, ['reconcile', 'run', '--job', J]);
  assert.equal(r.status, 'regression', JSON.stringify(r));
  assert.match(r.message, /TypeError.*\(fix commit [0-9a-f]+ \(T1\)\)/);
  assert.ok(r.dropped.some((d) => /numbers only/.test(d.line) && d.file === 'src/add.js'), JSON.stringify(r.dropped));
});

test('2 lost fix: review compares to every earlier round; a re-found confirmed finding is a regression that blocks; "unchanged" means no commit touched the file', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  F.cli(root, ['plan', 'from-contract'], { allowFail: false });
  const VULN = 'module.exports = (a, b) => a + b; // no validation\n';
  const once = (files) => {
    build(root, J, 'T1', files);
    return F.cli(root, ['reconcile', 'run', '--job', J]).status;
  };
  const review = core('review');
  const rec = (findings, verifications = []) => review.record(root, { jobId: J, payload: { lanes: [{ lane: 'code', findings }], verifications } });
  assert.equal(once({ 'src/add.js': VULN }), 'merged');
  const r1 = rec([{ id: 'code-1', severity: 'major', file: 'src/add.js', line: 1, summary: 'Non-numbers are not rejected' }, { id: 'code-2', severity: 'minor', file: 'tests/add.test.js', line: 1, summary: 'nit' }], [{ finding_id: 'code-1', status: 'confirmed' }]);
  assert.equal(r1.round, 1);
  assert.equal(once({ 'src/add.js': "module.exports = (a, b) => { if (typeof a !== 'number') throw new TypeError(); return a + b; };\n" }), 'merged');
  assert.equal(rec([]).round, 2);
  // a later build reverts the fix (and adds a file): the bug is back, reported reworded and as minor
  assert.equal(once({ 'src/add.js': VULN, 'src/sync.js': 'module.exports = 1;\n' }), 'merged');
  const r3 = rec([
    { id: 'code-1', severity: 'minor', file: 'src/add.js', line: 3, summary: 'add() accepts strings', rule: null },
    { id: 'code-2', severity: 'major', file: 'src/add.js', line: 2, summary: 'add() accepts strings and other non-numeric input' },
    { id: 'code-3', severity: 'major', file: 'tests/add.test.js', line: 40, summary: 'test is thin' },
  ]);
  assert.equal(r3.round, 3);
  assert.equal(r3.ok, false);
  const f = core('ledger').lastStep(root, J, 'challenge').detail.findings;
  const by = Object.fromEntries(f.map((x) => [x.id, x]));
  assert.equal(by['code-2'].severity, 'major', 'compared with round 1, not just round 2: never downgraded');
  assert.equal(by['code-2'].status, 'confirmed', 'confirmed before and found again: blocks without a new verification');
  assert.deepEqual(by['code-2'].regression, { round: 1, id: 'code-1', severity: 'major' });
  assert.equal(by['code-1'].severity, 'minor', 'a minor nit near a fixed bug matches only by rule or summary');
  assert.equal(by['code-3'].severity, 'minor', 'new on a file no commit touched since the last round: still a minor follow-up');
  assert.match(r3.regressions[0], /code-2 \[major\] src\/add\.js:2 was code-1/);
  const n = F.cli(root, ['next']);
  assert.equal(n.rule, 'row4.confirmed_serious');
  assert.equal(n.scope, 'fix');
});

test('2 lost fix: a new major on a file a fix touched and a revert restored is not "unchanged"', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  F.cli(root, ['plan', 'from-contract'], { allowFail: false });
  const once = (files) => {
    build(root, J, 'T1', files);
    return F.cli(root, ['reconcile', 'run', '--job', J]).status;
  };
  const review = core('review');
  const ORIG = 'module.exports = (a, b) => a + b;\n';
  once({ 'src/add.js': ORIG });
  review.record(root, { jobId: J, payload: { lanes: [{ lane: 'code', findings: [] }] } });
  once({ 'src/add.js': 'module.exports = (a, b) => b + a;\n' });
  once({ 'src/add.js': ORIG, 'src/x.js': 'x\n' }); // net: add.js unchanged since round 1
  const r = review.record(root, { jobId: J, payload: { lanes: [{ lane: 'code', findings: [{ id: 'code-1', severity: 'major', file: 'src/add.js', line: 1, summary: 'overflow' }] }] } });
  assert.equal(r.round, 2);
  const f = core('ledger').lastStep(root, J, 'challenge').detail.findings[0];
  assert.equal(f.severity, 'major');
  assert.equal(f.status, 'unverified');
});

// ------------------------------------------------------------------- 3 doc / human criteria

test('3 doc/human ACs: no fix round — doc gaps route to factory evidence add, human gaps to a confirm wait; doc evidence follows the file, not the build', () => {
  const root = F.makeRepo();
  const J = grounded(root, {
    allowed: ['src/**', 'tests/**', 'README.md'],
    ac: '- AC-1: add(2, 3) returns 5 (evidence: test)\n- AC-2: README.md documents add (evidence: doc)\n- AC-3: the totals screen looks right (evidence: human)',
  });
  F.cli(root, ['plan', 'from-contract'], { allowFail: false });
  const once = (files) => {
    build(root, J, 'T1', files);
    assert.equal(F.cli(root, ['reconcile', 'run', '--job', J]).status, 'merged');
  };
  once({ 'src/add.js': 'module.exports = (a, b) => a + b;\n' });
  assert.match(F.cli(root, ['next']).command, /verify run/);
  const v = F.cli(root, ['verify', 'run', '--job', J]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.acs, { 'AC-1': 'proven', 'AC-2': 'unproven', 'AC-3': 'unproven' });
  assert.deepEqual(core('ledger').lastStep(root, J, 'prove').detail.missing, { 'AC-2': ['doc'], 'AC-3': ['human'] });
  let n = F.cli(root, ['next']);
  assert.equal(n.action, 'evidence', JSON.stringify(n));
  assert.equal(n.rule, 'row5.evidence_missing');
  assert.deepEqual(n.acs, ['AC-2']);
  assert.match(n.command, /^factory evidence add AC-2 --type doc --path <.*> --job J-\d+$/);
  let st = state(root, J);
  assert.ok(!st.fix, 'no fix round');
  assert.equal(st.counters.verify_fix_rounds, 0, 'no counter');
  assert.equal(st.tasks.T1.needs_work, undefined, 'no task reopened');
  assert.equal(F.cli(root, ['next']).requery, true, 'asked again with nothing done: the same decision');
  // the main session records it, pointing at a file this job did not change
  const e = F.cli(root, ['evidence', 'add', 'AC-2', '--type', 'doc', '--path', 'README.md', '--job', J]);
  assert.match(e.blob, /^[0-9a-f]{40,64}$/);
  assert.equal(F.cli(root, ['evidence', 'add', 'AC-2', '--type', 'diff', '--path', 'README.md', '--job', J]).code, 'bad_input', 'diff evidence must point at a changed file');
  assert.equal(F.cli(root, ['evidence', 'add', 'AC-2', '--type', 'doc', '--path', 'NOPE.md', '--job', J]).code, 'bad_input');
  n = F.cli(root, ['next']);
  assert.equal(n.action, 'wait');
  assert.equal(n.rule, 'row5.human_confirm');
  assert.match(n.reason, /reply "confirm AC-3"/);
  F.reply(root, 'confirm AC-3');
  n = F.cli(root, ['next']);
  assert.equal(n.rule, 'row5.evidence_recorded');
  assert.match(n.command, /verify run/);
  assert.equal(F.cli(root, ['verify', 'run', '--job', J]).ok, true);
  // a later build (new fingerprint) keeps the doc proof while README.md is unchanged
  once({ 'src/add.js': 'module.exports = (a, b) => Number(a) + Number(b);\n' });
  let v2 = F.cli(root, ['verify', 'run', '--job', J]);
  assert.equal(v2.acs['AC-2'], 'proven', JSON.stringify(v2.why));
  assert.equal(v2.acs['AC-3'], 'unproven', 'a human check is for the build it was made on');
  // ... and loses it when README.md changes
  once({ 'README.md': '# tiny\n\nadd(a, b) returns the sum.\n' });
  v2 = F.cli(root, ['verify', 'run', '--job', J]);
  assert.equal(v2.acs['AC-2'], 'unproven');
  st = state(root, J);
  assert.equal(st.counters.verify_fix_rounds, 0);
});

test('3 doc/human ACs: owners of failures ignore evidence-only criteria and never fall back to every task for them', () => {
  const dt = core('decision-table');
  const g = dt.proveGaps({ acs: { 'AC-1': 'failed', 'AC-2': 'unproven', 'AC-3': 'unproven', 'AC-4': 'unproven', 'AC-5': 'proven' }, why: { 'AC-2': ['doc: record it'], 'AC-3': ['human: reply'], 'AC-4': ['test: no command covers it'] } });
  assert.deepEqual(g, { build: ['AC-1', 'AC-4'], evidence: [{ ac: 'AC-2', types: ['doc'] }], human: ['AC-3'] });
  const root = F.makeRepo();
  const J = grounded(root, { ac: '- AC-1: add(2, 3) returns 5 (evidence: test)\n- AC-2: README.md documents add (evidence: doc)' });
  customPlan(root, J, [
    { id: 'T1', objective: 'fix add', allowed_paths: ['src/add.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node tests/add.test.js', covers: ['AC-1'] }] },
    { id: 'T2', objective: 'docs', allowed_paths: ['src/other.js'], depends_on: [], criteria_ids: ['AC-2'], verify_commands: VC },
  ]);
  const ctx = core('steps').context(root, state(root, J), core('job').load);
  assert.deepEqual(dt.ownersOfFailures(ctx, { acs: { 'AC-1': 'proven', 'AC-2': 'unproven' }, why: { 'AC-2': ['doc: x'] }, commands: [] }), [], 'a doc gap has no builder owner');
  assert.deepEqual(dt.ownersOfFailures(ctx, { acs: { 'AC-1': 'failed', 'AC-2': 'unproven' }, why: { 'AC-2': ['doc: x'] }, commands: [{ cmd: 'node tests/add.test.js', pass: false }] }), ['T1']);
  assert.deepEqual(dt.ownersOfFailures(ctx, { acs: { 'AC-1': 'proven', 'AC-2': 'proven' }, commands: [{ cmd: 'npm run lint', pass: false }] }).sort(), ['T1', 'T2'], 'a failing policy check no task owns still goes to every task');
});

// ------------------------------------------------------------------- 4 clarify / ground question rounds

test('4 question rounds: clarify and ground rounds that ask the user stay ok:false with outcome needs_user', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Sync VLAN', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.cli(root, ['next']);
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  const r = F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [{ question: 'Scope?', why: 'w', blocking: false, category: 'scope', default: 'd' }], dismissed: [] }, critique: { verdict: 'approve', intent_confirmed: true, items: [] } }));
  assert.equal(r.status, 'needs_user');
  const c = core('ledger').lastStep(root, J, 'clarify');
  assert.equal(c.ok, false);
  assert.equal(c.detail.outcome, 'needs_user');
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  const ok = core('ledger').lastStep(root, J, 'clarify');
  assert.equal(ok.ok, true);
  assert.equal(ok.detail.outcome, undefined);
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  b = F.cli(root, ['wfargs', 'ground']);
  const g = F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 'codebase', claims: [], unknowns: [{ question: 'Which VLAN range?', blocking: true }] }], degraded: [] }));
  assert.equal(g.status, 'needs_user');
  const gr = core('ledger').lastStep(root, J, 'ground');
  assert.deepEqual([gr.ok, gr.detail.outcome], [false, 'needs_user']);
});

// ------------------------------------------------------------------- 5 analyst focus

test('5 analyst output: focus is optional', () => {
  const { validate } = require('../cli/lib/schema');
  const schema = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'schemas', 'agent-outputs', 'analyst.json'), 'utf8'));
  assert.deepEqual(validate(schema, { questions: [] }), []);
  assert.deepEqual(validate(schema, { focus: 'scope', questions: [] }), []);
  assert.notDeepEqual(validate(schema, { focus: 'scope' }), []);
});

// ------------------------------------------------------------------- 6 agents reading their own job

test('6 guard: an agent may read its own job folder in inline code; other jobs, factory logs, writes and code loading stay denied', () => {
  const { checkBash } = require('../hooks/guard-rules');
  const root = F.makeRepo();
  const as = (cmd, job = 'J-0001') => checkBash(root, cmd, null, { agent: true, job });
  for (const c of [
    `python3 -c "import json; print(json.load(open('.factory/jobs/J-0001/plan.json'))['tasks'])"`,
    `node -e "console.log(require('fs').readFileSync('.factory/jobs/J-0001/contract.md', 'utf8'))"`,
    `python3 -c "import os; print(os.listdir('.factory/jobs/J-0001'))"`,
    `python3 - <<'PY'\nprint(open('${root}/.factory/jobs/J-0001/findings.md').read())\nPY`,
  ]) assert.equal(as(c), null, c);
  for (const c of [
    `python3 -c "print(open('.factory/jobs/J-0002/plan.json').read())"`,
    `python3 -c "print(open('.factory/jobs/J-0001/../J-0002/plan.json').read())"`,
    `python3 -c "print(open('.factory/jobs/J-00012/plan.json').read())"`,
    `python3 -c "print(open('.factory/log/events.jsonl').read())"`,
    `python3 -c "open('.factory/jobs/J-0001/plan.json', 'w').write('{}')"`,
    `node -e "require('fs').writeFileSync('.factory/jobs/J-0001/state.json', '{}')"`,
    `node -e "require('${F.PLUGIN}/cli/core/job')"`,
    `python3 tools/read.py .factory/jobs/J-0001/plan.json`,
  ]) assert.ok(as(c), `denied: ${c}`);
  // without a job of its own nothing changes
  assert.ok(as(`python3 -c "print(open('.factory/jobs/J-0001/plan.json').read())"`, null));
});
