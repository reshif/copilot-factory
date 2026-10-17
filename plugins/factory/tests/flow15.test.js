'use strict';
// Code-vs-intent mismatches found while mapping copilot-factory's flow from its code
// (COPILOT-FACTORY-FLOW.md §15): a terminal seal for a repaired environment (a bare resume never
// discards it), "Stop here (cancel job)" cancels, the unreachable degraded stop and
// --accept-degraded are gone, an integrator with no result reaches the integrator loop, and the
// intent_grounded floor runs the clarify v3 check.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');

const core = (m) => require(`../cli/core/${m}`);
const human = core('human');
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !human.AGENT_ENV.some(([a]) => a === k)));
// the user's own terminal, through the test seam (a typed code is still required)
const terminal = (root, args) => JSON.parse(spawnSync('node', [F.BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...clean, FACTORY_ROOT: '', NODE_ENV: 'test', FACTORY_TEST_HUMAN: human.testToken(), FACTORY_TEST_HUMAN_INPUT: '{code}' } }).stdout);
const BROKEN = { version: 1, name: 'broken', setup: ['echo "ERROR: No matching distribution found for x==9.9" >&2; exit 3'] };

function repairPark(t, candidate = { version: 1, name: 'fixed', setup: ['true'] }) {
  const root = F.makeRepo(t);
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'feature', '--risk', 'medium']).job;
  core('environment').confirm(root, { env: BROKEN, channel: 'tty' });
  assert.equal(F.cli(root, ['env', 'check', '--job', J]).ok, false);
  core('job').mutate(root, J, (x) => {
    x.last_decision = 'workflow:env_repair::';
  });
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'env_repair']);
  fs.writeFileSync(core('env-repair').REPAIR(root, J), JSON.stringify(candidate));
  const r = F.recordRepair(root, J, b, { repair: { path: core('env-repair').REPAIR(root, J), summary: 'fix' } });
  return { root, J, r };
}

test('§15.2: a bare terminal resume never discards a repaired environment; factory env seal --job J <hash> seals it from the terminal (human-only, with the typed code)', (t) => {
  const { root, J, r } = repairPark(t);
  assert.equal(r.park.kind, 'environment_repair', JSON.stringify(r));
  const short = core('job').load(root, J).env_repair.short;
  const bare = terminal(root, ['resume', '--job', J]);
  assert.equal(bare.code, 'seal_or_words', JSON.stringify(bare));
  assert.match(bare.message, new RegExp(`factory env seal --job ${J} ${short}`));
  assert.equal(core('job').load(root, J).env_repair.short, short, 'nothing was discarded');
  assert.equal(terminal(root, ['env', 'seal', '--job', J, 'deadbeef']).code, 'stale_environment');
  assert.equal(terminal(root, ['env', 'seal', '--job', J]).code, 'explicit_seal_needed');
  // not for agents, nor for the main session's shell
  assert.equal(F.cli(root, ['env', 'seal', '--job', J, short], { env: { FACTORY_RUNNER: '1' } }).code, 'agent_not_allowed');
  assert.match(String(require('../hooks/guard-rules').checkBash(root, `factory env seal --job ${J} ${short}`) || ''), /human-only/);
  const s = terminal(root, ['env', 'seal', '--job', J, short]);
  assert.equal(s.sealed, short, JSON.stringify(s));
  assert.equal(core('environment').load(root).name, 'fixed');
  assert.equal(core('job').load(root, J).status, 'active');
  assert.match(core('decision-table').PARK_NEXT.environment_repair, /factory env seal --job <job> <hash>/);
});

test('§15.3: "Stop here (cancel job)" on an environment_broken question cancels the job (a reply "c", or factory resume c), never re-checks', (t) => {
  const root = F.makeRepo(t);
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'feature', '--risk', 'medium']).job;
  core('environment').confirm(root, { env: BROKEN, channel: 'tty' });
  const ER = core('env-repair');
  ER.checkForJob(root, core('job').load(root, J));
  let last = null;
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(ER.REPAIR(root, J), JSON.stringify(BROKEN));
    core('job').mutate(root, J, (x) => {
      x.last_decision = 'workflow:env_repair::';
    });
    last = ER.record(root, core('job').load(root, J), {});
    if (last.pending_check) last = ER.checkRepair(root, core('job').load(root, J));
    if (last.status === 'park') break;
  }
  assert.equal(core('job').load(root, J).park.kind, 'environment_broken');
  assert.equal(core('job').load(root, J).park.options[2].text, 'Stop here (cancel job)');
  const r = human.replyToPark(root, { jobId: J, text: 'c', channel: 'chat' });
  assert.match(r.message, /cancelled/);
  assert.equal(core('job').load(root, J).status, 'cancelled');
});

test('§15.4: the degraded drive stop (no record returned it) and --accept-degraded (never read) are gone', () => {
  const read = (f) => fs.readFileSync(path.join(F.PLUGIN, f), 'utf8');
  assert.doesNotMatch(read('cli/core/drive.js'), /ctx\.stop\('degraded'|case 'degraded'/);
  assert.doesNotMatch(read('cli/main.js'), /accept-degraded|acceptDegraded/);
  assert.doesNotMatch(read('cli/core/wfargs.js'), /acceptDegraded/);
  for (const f of ['docs/DRIVE.md', 'skills/start/SKILL.md']) assert.doesNotMatch(read(f), /accept-degraded/, f);
});

test('§15.5: an integrator that returned nothing goes to the integrator loop (retry, then a specific question), not to the generic error', (t) => {
  const root = F.makeRepo(t);
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'feature', '--risk', 'medium']).job;
  const brief = { workflow: 'reconcile', job: J, input_hash: 'x' };
  const r1 = F.record(root, F.envelope(brief, 'error', { integrator: null }, { summary: 'The integrator returned nothing twice.' }));
  assert.equal(r1.status, 'retry', JSON.stringify(r1));
  assert.equal(r1.recovery.kind, 'integration');
  assert.equal(core('job').load(root, J).loops.integrator.rounds, 1);
  let r = r1;
  for (let i = 0; i < 5 && r.status !== 'park'; i++) r = F.record(root, F.envelope(brief, 'error', { integrator: null }, { summary: 'nothing' }));
  assert.equal(r.status, 'park', JSON.stringify(r));
  assert.equal(r.park.kind, 'integration');
  // any other workflow error is still the generic error
  const J2 = F.cli(root, ['job', 'new', '--title', 'y', '--type', 'feature', '--risk', 'medium']).job;
  const g = F.record(root, F.envelope({ workflow: 'reconcile', job: J2, input_hash: 'x' }, 'error', { integrator: { status: 'conflict', summary: 'x' } }));
  assert.equal(g.status, 'error', JSON.stringify(g));
});

test('§15.6: the intent_grounded floor runs the clarify v3 check; no record at all fails it (012D m-6)', (t) => {
  assert.match(fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'floors.js'), 'utf8'), /case 'intent_grounded':\s*\n\s*\/\/[^\n]*\n\s*return require\('\.\/clarify'\)\.floorOk\(ctx\)/);
  const root = F.makeRepo(t);
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'feature', '--risk', 'medium']).job;
  const C = core('clarify');
  const floors = core('floors');
  const state = core('job').load(root, J);
  const ctx = { root, state, b: {} };
  const jp = require(path.join(F.PLUGIN, 'cli', 'lib', 'paths')).jobPaths(root, J);
  assert.ok(JSON.stringify(require(jp.recipeLock).floors.floors).includes('intent_grounded'), 'a medium job carries the floor');
  // neither clarify.json nor a v1/v2 intent-evidence.json: nothing grounds the contract
  assert.equal(C.load(root, J), null);
  assert.equal(floors.check(ctx, 'intent_grounded'), false);
  // a v3 record whose contract cites an unusable source fails; once that source is usable it passes
  const d = C.empty(state);
  d.evidence = [{ id: 'E-9', source: 'https://example.invalid/unusable-source', verdict: 'unpinned' }];
  C.save(root, J, d);
  fs.writeFileSync(jp.contract, '# Contract\n\n## Goal\n\nDo it as https://example.invalid/unusable-source says.\n');
  assert.equal(floors.check(ctx, 'intent_grounded'), false);
  const d2 = C.load(root, J);
  d2.evidence[0].verdict = 'docs';
  C.save(root, J, d2);
  assert.equal(floors.check(ctx, 'intent_grounded'), true);
  // a hand-edited record fails its seal: the floor fails
  const f = C.file(root, J);
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  raw.evidence[0].verdict = 'pinned';
  fs.writeFileSync(f, JSON.stringify(raw));
  assert.equal(floors.check(ctx, 'intent_grounded'), false);
});
