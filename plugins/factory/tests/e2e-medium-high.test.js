'use strict';
// standard@medium and full@high routes: design record + critique, H2 only when there's an ADR,
// planned tasks in waves with a dependency, all required lanes, threat model and HS at high risk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');

const next = (root) => F.cli(root, ['next']);

function clarifyAndApprove(root, J) {
  fs.writeFileSync(
    path.join(F.jobDir(root, J), 'contract.md'),
    F.contractText({ ac: '- AC-1: add(2, 3) returns 5 (evidence: test)\n- AC-2: sub(5, 3) returns 2 (evidence: test)', verify: '`node tests/add.test.js` (AC-1)' }),
  );
  const brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.equal(F.record(root, F.envelope(brief, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } })).status, 'ok');
  assert.equal(next(root).step, 'H1');
  F.reply(root, 'approve');
  const n = next(root);
  assert.equal(n.workflow, 'ground');
  const g = F.cli(root, ['wfargs', 'ground']);
  assert.equal(F.record(root, F.envelope(g, 'ok', { topics: [{ topic: 'codebase', claims: [{ claim: 'x', source: 'src/add.js:1' }], unknowns: [] }], degraded: [] })).status, 'ok');
}

function plan(root, J) {
  fs.writeFileSync(
    path.join(F.jobDir(root, J), 'plan.json'),
    JSON.stringify({
      tasks: [
        { id: 'T1', objective: 'Fix add', allowed_paths: ['src/add.js', 'tests/add.test.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node tests/add.test.js', covers: ['AC-1'] }] },
        { id: 'T2', objective: 'Add sub', allowed_paths: ['src/sub.js', 'tests/sub.test.js'], depends_on: [], criteria_ids: ['AC-2'], verify_commands: [{ cmd: 'node tests/sub.test.js', covers: ['AC-2'] }] },
        { id: 'T3', objective: 'Export both', allowed_paths: ['src/index.js'], depends_on: ['T1', 'T2'], criteria_ids: ['AC-1', 'AC-2'], verify_commands: [{ cmd: 'node -e "const m=require(\'./src/index.js\'); if (m.add(2,3)!==5||m.sub(5,3)!==2) process.exit(1)"', covers: ['AC-1', 'AC-2'] }] },
      ],
    }),
  );
}

function build(root, J, task, files) {
  const s = F.cli(root, ['task', 'start', task], { allowFail: false });
  for (const [rel, text] of Object.entries(files)) F.write(s.worktree, rel, text);
  F.sh(s.worktree, `git add -A && git commit -qm "${task}"`);
  const v = F.cli(root, ['task', 'verify', task]);
  assert.equal(v.pass, true, JSON.stringify(v));
}

function buildAll(root, J) {
  let n = next(root);
  assert.equal(n.workflow, 'realize');
  const brief = F.cli(root, ['wfargs', 'realize']);
  assert.deepEqual(brief.waves, [['T1', 'T2'], ['T3']], 'T1 and T2 share a wave; T3 waits for both');
  // T3 cannot start before its dependencies are done
  assert.match(F.cli(root, ['task', 'start', 'T3']).message, /depends on T1/);
  build(root, J, 'T1', { 'src/add.js': 'module.exports = (a, b) => a + b;\n' });
  build(root, J, 'T2', { 'src/sub.js': 'module.exports = (a, b) => a - b;\n', 'tests/sub.test.js': "if (require('../src/sub')(5,3)!==2) process.exit(1);\n" });
  build(root, J, 'T3', { 'src/index.js': "module.exports = { add: require('./add'), sub: require('./sub') };\n" });
  assert.equal(F.record(root, F.envelope(brief, 'ok', { tasks: ['T1', 'T2', 'T3'].map((id) => ({ id, outcome: 'done', attempts: 1 })) })).status, 'ok');
  n = next(root);
  assert.equal(n.workflow, 'reconcile');
  const rb = F.cli(root, ['wfargs', 'reconcile']);
  assert.equal(F.cli(root, ['reconcile', 'run']).status, 'merged');
  F.record(root, F.envelope(rb, 'ok', { integrator: { status: 'merged', summary: 'ok' } }));
  n = next(root);
  assert.match(n.command, /verify run/);
  const pv = F.cli(root, ['verify', 'run']);
  assert.equal(pv.ok, true, JSON.stringify(pv));
}

test('standard@medium: ADR → H2, plan → H3, three lanes, floors before ship', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Math module', '--type', 'feature', '--risk', 'medium']).job;
  clarifyAndApprove(root, J);

  let n = next(root);
  assert.equal(n.workflow, 'fanout-judge');
  assert.equal(n.config, 'decide');
  assert.equal(n.threat_model, false);
  let brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  assert.equal(brief.fanout.filter((f) => f.id.startsWith('option')).length, 3);
  assert.ok(!brief.fanout.some((f) => f.id === 'threat-modeler'));
  assert.match(fs.readFileSync(brief.judge.prompt.split('\n')[1].trim(), 'utf8'), /templates\/docs\/adr\.md[\s\S]*Mermaid architecture diagram[\s\S]*doc check/, 'the architect is told which template to follow and how to check it');
  // an ADR without the template's sections or an architecture diagram is sent back
  const adrPath = path.join(F.jobDir(root, J), 'adr-001-math.md');
  F.write(F.jobDir(root, J), 'adr-001-math.md', '# ADR 001\nDecision: separate modules.\n');
  const env = (critiques) => F.envelope(brief, 'ok', { options: [], degraded: [], judge: { kind: 'adr', paths: [adrPath], summary: 's' }, critiques });
  let r = F.record(root, env([{ verdict: 'approve', items: [] }]));
  assert.equal(r.status, 'retry');
  assert.ok(r.doc_problems.some((p) => /No front matter/.test(p)) && r.doc_problems.some((p) => /Missing section "## Architecture diagram"/.test(p)), JSON.stringify(r.doc_problems));
  assert.equal(next(root).step, 'decide', 'a rejected design record is decided again');
  F.write(F.jobDir(root, J), 'adr-001-math.md', F.adrText({ job: J, acs: ['AC-1', 'AC-2'], diagram: 'Two modules, add and sub.\n' }));
  brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  assert.match(fs.readFileSync(brief.judge.prompt.split('\n')[1].trim(), 'utf8'), /breaks the doc templates[\s\S]*needs a ```mermaid diagram/, 'the next architect run gets the template problems');
  r = F.record(root, env([{ verdict: 'approve', items: [] }]));
  assert.equal(r.status, 'retry');
  assert.match(r.message, /Architecture diagram/);
  // a diagram that is there but malformed is still refused; AC-2 must be covered too
  F.write(F.jobDir(root, J), 'adr-001-math.md', F.adrText({ job: J, acs: ['AC-1'], diagram: '```mermaid\nflowchart LR\n  subgraph m\n  add[add --> sub\n```\n' }));
  r = F.record(root, env([{ verdict: 'approve', items: [] }]));
  assert.equal(r.status, 'park', 'three template failures in a row park the job');
  assert.match(r.park_reason, /unbalanced brackets[\s\S]*does not cover AC-2|does not cover AC-2[\s\S]*unbalanced brackets/);
  F.reply(root, 'resume decide');
  // architect writes a valid ADR; the critique says revise twice → H2 shows it to the human
  F.write(F.jobDir(root, J), 'adr-001-math.md', F.adrText({ job: J, acs: ['AC-1', 'AC-2'], decision: 'We will add separate modules.' }));
  assert.equal(F.cli(root, ['doc', 'check', adrPath]).ok, true);
  brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  r = F.record(root, F.envelope(brief, 'ok', { options: [], degraded: [], judge: { kind: 'adr', paths: [path.join(F.jobDir(root, J), 'adr-001-math.md')], summary: 's' }, critiques: [{ verdict: 'revise', items: [{ issue: 'i', severity: 'minor' }] }, { verdict: 'revise', items: [] }] }));
  assert.equal(r.status, 'ok');
  assert.match(r.message, /you will see it at H2/);
  n = next(root);
  assert.equal(n.step, 'H2');
  assert.ok(n.gate.docs.some((d) => d.endsWith('design.json')));
  // a document edited after it was presented can't be approved
  F.write(F.jobDir(root, J), 'adr-001-math.md', F.adrText({ job: J, acs: ['AC-1', 'AC-2'], decision: 'We will add separate modules, edited.' }));
  assert.throws(() => F.reply(root, 'approve'), /changed after it was presented/);
  n = next(root);
  assert.equal(n.first_failing, null);
  assert.equal(n.step, 'decide', 'an edited design record must be re-decided and re-critiqued');
  brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  const optText = fs.readFileSync(brief.fanout[0].prompt.split('\n')[1].trim(), 'utf8');
  assert.match(optText, /not the first design round[^\n]*adr-001-math\.md/, 'a re-decide hands over the current design files');
  assert.match(optText, /## Working with files[\s\S]*Never run python, node/, 'agents are told to use Read/Write/Edit, not scripts');
  F.record(root, F.envelope(brief, 'ok', { options: [], degraded: [], judge: { kind: 'adr', paths: [path.join(F.jobDir(root, J), 'adr-001-math.md')], summary: 's' }, critiques: [{ verdict: 'approve', items: [] }] }));
  assert.equal(next(root).step, 'H2');
  F.reply(root, 'approve');

  // decompose → H3
  n = next(root);
  assert.equal(n.workflow, 'decompose');
  brief = F.cli(root, ['wfargs', 'decompose']);
  plan(root, J);
  assert.equal(F.cli(root, ['plan', 'validate']).valid, true);
  r = F.record(root, F.envelope(brief, 'ok', { planner: { valid: true, errors: [], path: 'plan.json' }, critique: null }));
  assert.equal(r.status, 'ok');
  n = next(root);
  assert.equal(n.step, 'H3');
  F.reply(root, 'approve');

  buildAll(root, J);

  n = next(root);
  assert.equal(n.config, 'challenge');
  brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  assert.deepEqual(brief.fanout.map((f) => f.id).sort(), ['code', 'security', 'tests']);
  // missing a lane: not ok, nothing confirmed → challenge runs again
  r = F.record(root, F.envelope(brief, 'degraded', { lanes: [{ lane: 'code', findings: [] }, { lane: 'tests', findings: [] }], degraded: ['security'], verifications: [] }, { fingerprint: brief.fingerprint }));
  assert.equal(r.status, 'retry');
  assert.deepEqual(r.missing, ['security']);
  assert.match(F.cli(root, ['ship', '--local']).message, /challenge:security/);
  n = next(root);
  assert.equal(n.config, 'challenge');
  brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  r = F.record(root, F.envelope(brief, 'ok', { lanes: ['code', 'tests', 'security'].map((lane) => ({ lane, findings: [] })), degraded: [], verifications: [] }, { fingerprint: brief.fingerprint }));
  assert.equal(r.status, 'ok');
  assert.equal(next(root).skill, 'ship');
  const fin = F.cli(root, ['finalize', '--mode', 'before_ship']);
  assert.equal(fin.ok, true, JSON.stringify(fin.missing));
});

test('full@high: threat model required, H2 and H3 human, HS before ship, trial recipes refused', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Auth math', '--type', 'feature', '--risk', 'high']).job;
  assert.equal(F.cli(root, ['job', 'show']).recipe.id, 'full@high');
  clarifyAndApprove(root, J);
  let n = next(root);
  assert.equal(n.threat_model, true);
  let brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  assert.ok(brief.fanout.some((f) => f.id === 'threat-modeler'));
  assert.match(fs.readFileSync(brief.fanout.find((f) => f.id === 'threat-modeler').prompt.split('\n')[1].trim(), 'utf8'), /templates\/docs\/threat-model\.md[\s\S]*subgraph[\s\S]*doc check/);
  F.write(F.jobDir(root, J), 'adr-001-x.md', F.adrText({ job: J, acs: ['AC-1', 'AC-2'], threats: ['TH-1'] }));
  const noThreat = F.record(root, F.envelope(brief, 'ok', { options: [], degraded: [], judge: { kind: 'adr', paths: [path.join(F.jobDir(root, J), 'adr-001-x.md')], summary: 's' }, critiques: [{ verdict: 'approve', items: [] }] }, { threat_model: true }));
  assert.equal(noThreat.error, true);
  assert.match(noThreat.message, /threat model is required/);
  // a threat model without a data-flow diagram, or a threat the ADR does not map, is sent back
  F.write(F.jobDir(root, J), 'threat-model.md', F.threatModelText({ job: J, ids: ['TH-1', 'TH-2'] }).replace(/```mermaid[\s\S]*?```\n/, 'See the code.\n'));
  brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  const bad = F.record(root, F.envelope(brief, 'ok', { options: [], degraded: [], judge: { kind: 'adr', paths: [path.join(F.jobDir(root, J), 'adr-001-x.md')], summary: 's' }, critiques: [{ verdict: 'approve', items: [] }] }, { threat_model: true }));
  assert.equal(bad.status, 'retry');
  assert.ok(bad.doc_problems.some((p) => /^threat-model\.md: .*Data-flow diagram/.test(p)), JSON.stringify(bad.doc_problems));
  assert.ok(bad.doc_problems.some((p) => /^adr-001-x\.md: .*does not map threat\(s\) TH-2/.test(p)), JSON.stringify(bad.doc_problems));
  F.write(F.jobDir(root, J), 'threat-model.md', F.threatModelText({ job: J }));
  brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  assert.equal(F.record(root, F.envelope(brief, 'ok', { options: [], degraded: [], judge: { kind: 'adr', paths: [path.join(F.jobDir(root, J), 'adr-001-x.md')], summary: 's' }, critiques: [{ verdict: 'approve', items: [] }] }, { threat_model: true })).status, 'ok');
  assert.equal(next(root).step, 'H2');
  F.reply(root, 'approve');
  n = next(root);
  brief = F.cli(root, ['wfargs', 'decompose']);
  plan(root, J);
  F.record(root, F.envelope(brief, 'ok', { planner: { valid: true, errors: [], path: 'plan.json' }, critique: null }));
  assert.equal(next(root).step, 'H3');
  F.reply(root, 'approve');
  buildAll(root, J);
  n = next(root);
  brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  assert.deepEqual(brief.fanout.map((f) => f.id).sort(), ['code', 'security', 'tests']);
  F.record(root, F.envelope(brief, 'ok', { lanes: ['code', 'tests', 'security'].map((lane) => ({ lane, findings: [] })), degraded: [], verifications: [] }, { fingerprint: brief.fingerprint }));
  n = next(root);
  assert.equal(n.step, 'HS', 'high risk signs off before the irreversible step');
  assert.match(F.cli(root, ['ship', '--local']).message, /irreversible_signoff/);
  F.cli(root, ['report']);
  F.reply(root, 'approve');
  assert.equal(next(root).skill, 'ship');
  assert.equal(F.cli(root, ['ship', '--local']).mode, 'local');
  // every doc of the job follows its template; the report and the index trace AC → design → task → proof
  const docs = F.cli(root, ['doc', 'check']);
  assert.equal(docs.ok, true, JSON.stringify(docs.docs.filter((d) => !d.ok)));
  assert.deepEqual(docs.docs.map((d) => d.type), ['findings', 'threat-model', 'adr', 'ship-report', 'index']);
  const report = fs.readFileSync(path.join(F.jobDir(root, J), 'completion-report.md'), 'utf8');
  assert.match(report, /^---\ndoc: ship-report\ntemplate: ship-report@1\njob: J-\d+/);
  assert.match(report, /## What changed[\s\S]*\| A \| src\/sub\.js \|[\s\S]*## Acceptance criteria → evidence[\s\S]*AC-2[^\n]*proven/);
  assert.match(report, /## Design record\n\n- adr: adr-001-x\.md — Fix add in place \(proposed\)\n  We will fix the operator in src\/add\.js\./);
  assert.match(report, /Threat model: threat-model\.md \(TH-1\)/);
  assert.equal(F.cli(root, ['report']).report, path.join(F.jobDir(root, J), 'completion-report.md'));
  assert.equal(fs.readFileSync(path.join(F.jobDir(root, J), 'completion-report.md'), 'utf8').replace(/status: \w+/, ''), report.replace(/status: \w+/, ''), 'the report is reproducible');
  const idx = fs.readFileSync(path.join(F.jobDir(root, J), 'docs-index.md'), 'utf8');
  assert.match(idx, /\| AC-2 sub\(5, 3\) returns 2 \| adr-001-x\.md \| T2, T3 \| proven \|/);
  assert.match(require(path.join(F.PLUGIN, 'cli', 'core', 'ship')).prBody(report), /^<!-- factory doc: ship-report · template: ship-report@1 · [^\n]*-->\n\n# Completion report/);
});

test('high-risk jobs refuse recipes that are not proven', () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-'));
  for (const f of fs.readdirSync(path.join(F.PLUGIN, 'recipes'))) fs.copyFileSync(path.join(F.PLUGIN, 'recipes', f), path.join(dir, f));
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'full@high.json'), 'utf8'));
  r.status = 'trial';
  fs.writeFileSync(path.join(dir, 'full@high.json'), JSON.stringify(r));
  const root = F.makeRepo();
  const { spawnSync } = require('child_process');
  const out = spawnSync('node', [F.BIN, 'job', 'new', '--title', 'x', '--type', 'feature', '--risk', 'high'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_RECIPES_DIR: dir } });
  assert.match(out.stdout, /no_trial_recipes|omits floor "no_trial_recipes"|only run proven recipes/);
});
