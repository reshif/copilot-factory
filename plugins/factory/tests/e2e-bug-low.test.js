'use strict';
// End to end: one bug@low job through every step, with the test playing the agents
// (doing the git work they would do) and the human (chat replies).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');

function next(root) {
  return F.cli(root, ['next']);
}

test('bug@low: request to closed job, with a fix round and a local merge', () => {
  const root = F.makeRepo();
  const job = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low'], { allowFail: false });
  assert.equal(job.recipe, 'bug@low v1');
  const J = job.job;

  // clarify
  let n = next(root);
  assert.equal(n.action, 'skill');
  assert.equal(n.skill, 'clarify');
  assert.equal(n.first_failing, 'contract_approved');
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  assert.equal(F.cli(root, ['contract', 'check', '--plan-fields']).ok, true);

  // first clarify round asks a question
  let brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify'], { allowFail: false });
  assert.equal(brief.fanout.length, 4);
  assert.deepEqual(brief.fanout.map((f) => f.category), ['intent', 'scope', 'constraint', 'acceptance'], 'intent gate first');
  assert.equal(brief.limits.max_questions, 5, 'round 1 budget');
  assert.match(brief.fanout[0].prompt, /read this run's context/);
  assert.equal(brief.fanout[0].agent_type, 'factory:intent-analyst');
  assert.ok(fs.existsSync(brief.fanout[0].prompt.split('\n')[1].trim()), 'instruction file exists');
  let r = F.record(root, F.envelope(brief, 'needs_user', { analysts: [], degraded: [], judge: { questions: [{ question: 'Floats too?', why: 'scope' }], dismissed: [] }, critique: null }));
  assert.equal(r.status, 'needs_user');
  // second round: no questions, God Eye approves
  n = next(root);
  assert.equal(n.skill, 'clarify');
  brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.match(fs.readFileSync(brief.judge.prompt.split('\n')[1].trim(), 'utf8'), /Floats too\?/, 'already-asked questions are passed on');
  r = F.record(root, F.envelope(brief, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  assert.equal(r.status, 'ok');

  // H1
  n = next(root);
  assert.equal(n.action, 'gate');
  assert.equal(n.step, 'H1');
  assert.throws(() => F.reply(root, 'approve H3'), /waiting at H1/);
  const ap = F.reply(root, 'approve');
  assert.match(ap.message, /Approved H1/);

  // ground
  n = next(root);
  assert.equal(n.action, 'workflow');
  assert.equal(n.workflow, 'ground');
  brief = F.cli(root, ['wfargs', 'ground']);
  r = F.record(root, F.envelope(brief, 'ok', { topics: [{ topic: 'codebase', claims: [{ claim: 'add subtracts', source: 'src/add.js:1' }], unknowns: [] }], degraded: [] }));
  assert.equal(r.status, 'ok');
  assert.match(fs.readFileSync(path.join(F.jobDir(root, J), 'findings.md'), 'utf8'), /src\/add\.js:1/);

  // plan from contract
  n = next(root);
  assert.equal(n.action, 'cli');
  assert.match(n.command, /plan from-contract/);
  assert.equal(F.cli(root, ['plan', 'from-contract']).ok, true);

  // realize: the "builder" does the work in its worktree, the "tester" runs task verify
  n = next(root);
  assert.equal(n.workflow, 'realize');
  assert.equal(n.scope, 'all');
  brief = F.cli(root, ['wfargs', 'realize']);
  assert.deepEqual(brief.waves, [['T1']]);
  const start = F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
  // an out-of-scope edit is caught by task verify
  F.write(start.worktree, 'README.md', '# changed\n');
  F.write(start.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
  F.sh(start.worktree, 'git add -A && git commit -qm "fix add"');
  let tv = F.cli(root, ['task', 'verify', 'T1']);
  assert.equal(tv.pass, false);
  assert.deepEqual(tv.scope_violations, ['README.md']);
  F.sh(start.worktree, 'git checkout HEAD~1 -- README.md && git commit -qam "revert readme"');
  tv = F.cli(root, ['task', 'verify', 'T1']);
  assert.equal(tv.pass, true, JSON.stringify(tv));
  r = F.record(root, F.envelope(brief, 'ok', { tasks: [{ id: 'T1', outcome: 'done', attempts: 1, summary: 'fixed' }] }));
  assert.equal(r.status, 'ok');

  // reconcile
  n = next(root);
  assert.equal(n.workflow, 'reconcile');
  brief = F.cli(root, ['wfargs', 'reconcile']);
  assert.equal(F.cli(root, ['reconcile', 'run']).status, 'merged');
  r = F.record(root, F.envelope(brief, 'ok', { integrator: { status: 'merged', summary: 'clean' } }));
  assert.equal(r.status, 'ok');

  // prove
  n = next(root);
  assert.equal(n.action, 'cli');
  assert.match(n.command, /verify run/);
  const pv = F.cli(root, ['verify', 'run']);
  assert.equal(pv.ok, true, JSON.stringify(pv));
  assert.equal(pv.acs['AC-1'], 'proven');

  // challenge round 1: a confirmed major finding opens a fix round
  n = next(root);
  assert.equal(n.config, 'challenge');
  brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  assert.deepEqual(brief.fanout.map((f) => f.id), ['code']);
  r = F.record(root, F.envelope(brief, 'ok', { lanes: [{ lane: 'code', findings: [{ id: 'code-1', severity: 'major', file: 'src/add.js', line: 1, summary: 'No input validation for non-numbers', rule: null }] }], degraded: [], verifications: [{ finding_id: 'code-1', status: 'confirmed', reason: 'add("2",3) returns "23"' }] }, { fingerprint: brief.fingerprint }));
  assert.equal(r.status, 'fix');
  n = next(root);
  assert.equal(n.workflow, 'realize');
  assert.equal(n.scope, 'fix');
  assert.equal(n.rule, 'row4.confirmed_serious');
  const show = F.cli(root, ['task', 'show', 'T1']);
  assert.equal(show.fix_findings.length, 1);
  brief = F.cli(root, ['wfargs', 'realize', '--scope', 'fix']);
  F.cli(root, ['task', 'start', 'T1']);
  F.write(start.worktree, 'src/add.js', "module.exports = (a, b) => { if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('numbers only'); return a + b; };\n");
  F.sh(start.worktree, 'git commit -qam "validate inputs"');
  assert.equal(F.cli(root, ['task', 'verify', 'T1']).pass, true);
  F.record(root, F.envelope(brief, 'ok', { tasks: [{ id: 'T1', outcome: 'done', attempts: 1, summary: 'validated' }] }));
  n = next(root);
  assert.equal(n.workflow, 'reconcile');
  brief = F.cli(root, ['wfargs', 'reconcile']);
  assert.equal(F.cli(root, ['reconcile', 'run']).status, 'merged');
  F.record(root, F.envelope(brief, 'ok', { integrator: { status: 'merged', summary: 'clean' } }));
  n = next(root);
  assert.match(n.command, /verify run/);
  assert.equal(F.cli(root, ['verify', 'run']).ok, true);
  n = next(root);
  assert.equal(n.config, 'challenge');
  brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  assert.match(fs.readFileSync(brief.fanout[0].prompt.split('\n')[1].trim(), 'utf8'), /round 2/i);
  r = F.record(root, F.envelope(brief, 'ok', { lanes: [{ lane: 'code', findings: [{ id: 'code-9', severity: 'minor', file: 'src/add.js', line: 1, summary: 'Message could name the arguments' }] }], degraded: [], verifications: [] }, { fingerprint: brief.fingerprint }));
  assert.equal(r.status, 'ok');

  // ship (local: no remote)
  n = next(root);
  assert.equal(n.skill, 'ship');
  const sp = F.cli(root, ['ship', '--local']);
  assert.equal(sp.mode, 'local', JSON.stringify(sp));
  assert.ok(fs.existsSync(sp.report));
  const report = fs.readFileSync(sp.report, 'utf8');
  assert.match(report, /AC-1.*proven/);
  n = next(root);
  assert.equal(n.action, 'wait');

  // the human merges and says so
  F.sh(root, `git merge -q --no-ff -m "merge ${J}" factory/${J}`);
  const sha = F.sh(root, 'git rev-parse HEAD');
  assert.match(F.reply(root, `merged ${sha}`).message, /Recorded merge/);

  // a local merge still owes the CI re-verify floor: the router asks for it before distill
  n = next(root);
  assert.equal(n.action, 'cli');
  assert.equal(n.command, `factory ci verify --job ${J}`);
  assert.equal(n.rule, 'order.ci_reverify');
  assert.equal(n.step, 'H4');
  const blocked = F.cli(root, ['close']);
  assert.equal(blocked.error, true);
  assert.match(blocked.message, /ci_reverify/);
  const ci = F.cli(root, ['ci', 'verify', '--job', J]);
  assert.equal(ci.ok, true, JSON.stringify(ci));
  n = next(root);
  assert.equal(n.skill, 'distill');
  const dc = F.cli(root, ['distill', 'context']);
  assert.equal(dc.confirmed.length, 1);
  F.cli(root, ['lessons', 'add', '--job', J, '--text', 'In src/**, public functions validate argument types before use.', '--scope', 'src/**']);
  F.cli(root, ['distill', 'done']);
  n = next(root);
  assert.match(n.command, /close/);
  const closed = F.cli(root, ['close']);
  assert.equal(closed.status, 'closed', JSON.stringify(closed));
  n = next(root);
  assert.equal(n.action, 'done');

  // lessons need a human to accept; why and telemetry render
  assert.match(F.reply(root, 'accept lesson L1').message, /accepted/);
  const why = F.cli(root, ['why']);
  assert.ok(why.decisions.length >= 12);
  assert.ok(why.decisions.some((d) => d.rule === 'row4.confirmed_serious'));
  const tel = F.cli(root, ['telemetry', 'report']);
  assert.equal(tel.by_recipe['bug@low'].jobs, 1);
  assert.equal(tel.by_recipe['bug@low'].lanes.code.confirmed, 1);
  // worktrees and task branches are cleaned up
  assert.equal(F.sh(root, 'git branch --list "factory/*-T*"'), '');
});
