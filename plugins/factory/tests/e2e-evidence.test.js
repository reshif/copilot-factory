'use strict';
// 0.10.0 end to end, through `factory run` with the fake Copilot CLI (tests/helpers/evidence-crew.js):
//   1. a design defect that only the pinned dependency's source shows (a flag that keeps what the
//      design says it deletes) is caught, verified and fixed before the human sees the design (H2);
//   2. a plan whose verify command cannot run (a binary nobody installs) is fixed before the gate;
//   3. a medium job reaches ONE combined gate for design + plan + build environment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const A = require('./helpers/archives');
const T = require('./helpers/tmp');
const { LIB } = require('./helpers/evidence-crew');

const FAKE = path.join(__dirname, 'helpers', 'fake-copilot.js');
const CREW = path.join(__dirname, 'helpers', 'evidence-crew.js');

function harness(t, extraEnv) {
  const dir = T.mkdtemp('factory-e2e-ev-', t);
  const log = path.join(dir, 'copilot.jsonl');
  const env = { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: FAKE, FAKE_COPILOT_SCRIPT: CREW, FAKE_COPILOT_LOG: log, ...extraEnv };
  return {
    env,
    log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []),
    run(root, args) {
      const r = spawnSync('node', [F.BIN, 'run', ...args, '--json'], { cwd: root, encoding: 'utf8', env, timeout: 240000 });
      let out;
      try {
        out = JSON.parse(r.stdout);
      } catch {
        out = { raw: r.stdout, stderr: r.stderr };
      }
      return Object.assign(out, { __code: r.status });
    },
    cli(root, args) {
      return F.cli(root, args, { env: extraEnv });
    },
  };
}

function runArgs(n) {
  const a = [n.workflow];
  if (n.config) a.push('--config', n.config);
  if (n.mode) a.push('--mode', n.mode);
  if (n.scope) a.push('--scope', n.scope);
  if (n.lanes) a.push('--lanes', [].concat(n.lanes).join(','));
  if (n.threat_model === true) a.push('--threat-model');
  if (n.threat_model === false) a.push('--no-threat-model');
  return a;
}

// What the start skill does: factory next, then the step it names, until a gate (H1 approved on
// the way); the results of every factory run, by workflow.
function driveToGate(h, root, { pastH1 = true } = {}) {
  const runs = [];
  for (let i = 0; i < 40; i++) {
    const n = h.cli(root, ['next']);
    if (n.action === 'skill' && n.skill === 'clarify') {
      if (n.clarify.waiting_for_user) h.cli(root, ['clarify', 'reply', 'ok']);
      else assert.equal(h.run(root, ['clarify']).__code, 0);
      continue;
    }
    if (n.action === 'gate' && n.step === 'H1' && pastH1) {
      F.reply(root, 'approve');
      continue;
    }
    if (n.action === 'gate') return { gate: n, runs };
    if (n.action === 'cli') {
      const w = n.command.split(/\s+/).slice(1).filter((x, k, a) => x !== '--job' && a[k - 1] !== '--job');
      const r = h.cli(root, w);
      assert.ok(!r.error, JSON.stringify(r));
      runs.push({ cli: w.join(' '), result: r });
      continue;
    }
    if (n.action === 'workflow') {
      const r = h.run(root, runArgs(n));
      assert.equal(r.__code, 0, JSON.stringify(r).slice(0, 3000));
      runs.push({ workflow: n.workflow, config: n.config || null, result: r });
      continue;
    }
    return { gate: null, stopped: n, runs };
  }
  throw new Error('no gate reached');
}

function pinnedJob(t, risk) {
  const root = F.makeRepo(t);
  F.write(root, 'requirements.txt', 'diffsync==2.0.1\n');
  F.sh(root, 'git add -A && git commit -qm "pin diffsync"');
  const idx = A.fakeIndex(path.join(T.mkdtemp('factory-e2e-idx-', t), 'idx'));
  idx.add('pypi', 'diffsync', '2.0.1', LIB);
  const J = F.cli(root, ['job', 'new', '--title', 'VLAN sync', '--type', 'feature', '--risk', risk]).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText({ goal: 'Sync VLANs with diffsync: VLANs missing from the source are deleted.' }));
  return { root, J, h: harness(t, idx.env) };
}

test('e2e: a design defect only visible in the pinned dependency source is caught, verified and fixed before H2', (t) => {
  const { root, J, h } = pinnedJob(t, 'high');
  const { gate, runs } = driveToGate(h, root);
  assert.equal(gate.step, 'H2', JSON.stringify(gate).slice(0, 500));
  // the source was fetched (not run) and read by the agents
  const deps = runs.find((r) => r.cli && /^deps fetch/.test(r.cli));
  assert.deepEqual(deps.result.packages.map((p) => [p.package, p.status]), [['pypi:diffsync@2.0.1', 'fetched']]);
  const researcher = h.log().find((c) => c.agent === 'factory:researcher' && c.argv.includes('--add-dir') && c.argv.join(' ').includes(`.factory/deps/${J}`));
  assert.ok(researcher, 'the researchers read the dependency source (a read dir of theirs)');
  // ground: the first quote was off by a line, the CLI asked once more, the ledger holds the fix
  const ground = runs.find((r) => r.workflow === 'ground').result;
  assert.ok(ground.agents.some((a) => a.label === 'ground · interfaces (ledger)'), 'asked once more');
  const ledger = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'api-ledger.json'), 'utf8'));
  assert.deepEqual(ledger.entries.map((e) => [e.id, e.symbol, e.line]), [['L-1', 'diffsync.DiffSyncFlags.SKIP_UNMATCHED_DST', 6]]);
  // decide: the API critic objected with file:line, a verifier confirmed it, the architect revised,
  // the critics approved the revision — before H2
  const decide = runs.find((r) => r.workflow === 'fanout-judge' && r.config === 'decide').result;
  const labels = decide.agents.map((a) => a.label);
  for (const l of ['api-conformance · design #1', 'verify api-conformance-1-1', 'architect · revise #1', 'api-conformance · design #2']) assert.ok(labels.includes(l), `${l} in ${labels.join(', ')}`);
  const crit = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'critiques', 'design.json'), 'utf8'));
  assert.equal(crit.verdict, 'approve');
  assert.equal(crit.rounds, 2);
  const adr = fs.readFileSync(path.join(F.jobDir(root, J), 'adr-001-sync.md'), 'utf8');
  assert.ok(!/flags=SKIP_UNMATCHED_DST/.test(adr), 'the design H2 shows no longer relies on the flag');
  assert.match(adr, /## External API usage[\s\S]*flags=DiffSyncFlags\.NONE[^\n]*L-1/);
  // what H2 shows: approved critics, the ledger quoted from the pinned source
  assert.equal(gate.review.design_critique.verdict, 'approve');
  assert.deepEqual(gate.review.design_critique.open, []);
  assert.equal(gate.review.api_ledger.entries, 1);
  assert.match(gate.review.api_ledger.symbols[0], /L-1 diffsync\.DiffSyncFlags\.SKIP_UNMATCHED_DST \(pypi:diffsync 2\.0\.1, \.factory\/deps\/J-0001\/pypi\/diffsync-2\.0\.1\/diffsync\/enum\.py:6\)/);
  assert.equal(F.cli(root, ['job', 'show']).status, 'active', 'nothing parked on the way');
});

test('e2e: a medium job reaches ONE combined gate (design + plan + environment); a plan whose verify command cannot run is fixed before it', (t) => {
  const { root, J, h } = pinnedJob(t, 'medium');
  const { gate, runs } = driveToGate(h, root);
  assert.equal(gate.step, 'H3', 'medium risk: no H2 on the way');
  assert.ok(!runs.some((r) => r.gate), 'no other gate was shown');
  assert.deepEqual(gate.review.approves, ['design', 'plan', 'environment']);
  // the design defect was caught before this gate too
  assert.equal(gate.review.design_critique.verdict, 'approve');
  assert.ok(gate.gate.docs.some((d) => d.endsWith('adr-001-sync.md')) && gate.gate.docs.some((d) => d.endsWith('plan.json')) && gate.gate.docs.some((d) => d.endsWith('probe.json')));
  // decompose: the first plan's verify command could not run; the probe said so, the planner fixed it
  const dec = runs.find((r) => r.workflow === 'decompose').result;
  const labels = dec.agents.map((a) => a.label);
  assert.deepEqual(labels.filter((l) => /planner/.test(l)), ['planner #1', 'planner · probe fix #1']);
  assert.ok(labels.includes('god-eye · plan #1'), 'God Eye critiqued the plan at medium risk');
  assert.ok((dec.checks || []).filter((c) => c.step === 'probe').length >= 2, 'probed, fixed, probed again');
  const plan = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'plan.json'), 'utf8'));
  assert.deepEqual(plan.tasks[0].verify_commands.map((c) => c.cmd), ['node tests/add.test.js']);
  assert.equal(gate.review.probe.ok, true);
  assert.equal(gate.review.probe.current, true);
  assert.ok(gate.review.probe.commands.some((c) => /node tests\/add\.test\.js` → fails_as_expected/.test(c)));
  const probeEvents = fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.event === 'plan_probe');
  assert.deepEqual(probeEvents.map((e) => e.ok), [false, true], 'the broken command was seen before the gate, and fixed');
  // the build environment the planner proposed with the plan is part of this one gate: approving
  // it seals the environment, so the build starts without a separate "confirm environment"
  assert.equal(gate.review.environment.status, 'proposed');
  assert.equal(gate.review.environment.name, 'node-test');
  assert.ok(gate.gate.docs.some((d) => d.endsWith('environment.proposed.json')));
  assert.equal(require('../cli/core/environment').load(root), null);
  F.reply(root, 'approve');
  assert.equal(require('../cli/core/environment').load(root).name, 'node-test');
  // fix 0.10.1: the sealed environment sets up once in a scratch worktree before any task
  assert.equal(F.cli(root, ['next']).step, 'env_check');
  assert.equal(F.cli(root, ['env', 'check', '--job', J]).ok, true);
  const n = F.cli(root, ['next']);
  assert.equal(n.workflow, 'realize', JSON.stringify(n).slice(0, 400));
  assert.equal(F.sh(root, 'git worktree list').split('\n').filter((l) => /_probe-/.test(l)).length, 0, 'the probe left no worktree behind');
});
