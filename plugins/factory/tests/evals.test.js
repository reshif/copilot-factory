'use strict';
// The Tier 2/3 eval harnesses (scripts/eval-triggers.js, scripts/eval-outcomes.js) without a
// model: their parsing and scoring, the case files, and a whole trigger run against a fake
// `copilot` that answers in the real CLI's --output-format json event shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const T = require(path.join(REPO, 'scripts', 'eval-triggers.js'));

// One event line as Copilot CLI 1.0.97 writes it for a skill call (captured with a mock model).
const skillEvent = (skill) => JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: 'call_1', toolName: 'skill', arguments: { skill }, turnId: '0' }, id: 'x', timestamp: '2026-10-15T05:04:06.931Z' });

test('trigger cases: 8 should-trigger and 8 near-miss prompts per user-invocable skill; dispatch cases for the step skills', () => {
  const cases = T.loadCases(path.join(REPO, 'evals'));
  const user = ['console', 'inspect', 'review', 'start', 'why'];
  for (const s of user) {
    assert.equal(cases.filter((c) => c.suite === 'triggers' && c.skill === s && c.expect === s).length, 8, `${s} should-trigger`);
    assert.equal(cases.filter((c) => c.suite === 'triggers' && c.skill === s && c.expect === null).length, 8, `${s} near-miss`);
  }
  const prompts = cases.filter((c) => c.suite === 'triggers').map((c) => c.prompt);
  assert.equal(new Set(prompts).size, prompts.length, 'no prompt is used twice');
  const dispatch = cases.filter((c) => c.suite === 'dispatch');
  for (const s of ['clarify', 'gate', 'park', 'ship', 'distill', 'amend']) assert.ok(dispatch.some((c) => c.expect === s), `dispatch case for ${s}`);
  assert.ok(dispatch.some((c) => c.expect === null && c.next.autopilot), 'an autopilot warning stops the loop');
  const skills = new Set(fs.readdirSync(path.join(REPO, 'plugins', 'factory', 'skills')));
  for (const c of dispatch) if (c.expect) assert.ok(skills.has(c.expect), `${c.expect} is a skill`);
  assert.equal(T.loadCases(path.join(REPO, 'evals'), { suite: 'triggers', skills: ['why'] }).length, 16);
});

test('firedFrom / judged / caseResult / summarize score runs as the report needs', () => {
  const jsonl = ['noise', skillEvent('factory:start'), JSON.stringify({ type: 'tool.execution_complete', data: { success: false, error: { message: 'Permission to run this tool was denied' } } }), skillEvent('gate'), JSON.stringify({ type: 'tool.execution_start', data: { toolName: 'task', arguments: { agent_type: 'factory:code-reviewer' } } })].join('\n');
  const f = T.firedFrom(jsonl);
  assert.deepEqual(f, { skills: ['start', 'gate'], agents: ['factory:code-reviewer'], denied: 1 });
  const dispatch = { suite: 'dispatch', id: 'dispatch:gate', skill: 'gate', expect: 'gate', prompt: 'p' };
  assert.equal(T.judged(dispatch, f), 'gate', 'dispatch is judged on the skill after start');
  const r = T.caseResult(dispatch, [f, { skills: ['start'], agents: [], denied: 0 }]);
  assert.equal(r.pass_rate, 0.5);
  assert.deepEqual(r.must_not_fire, ['factory:code-reviewer'], 'a factory agent outside factory run is a violation');
  assert.equal(r.pass, false);
  const should = { suite: 'triggers', id: 'why+1', skill: 'why', expect: 'why', prompt: 'a' };
  const near = { suite: 'triggers', id: 'why-1', skill: 'why', expect: null, prompt: 'b' };
  const other = { suite: 'triggers', id: 'start+1', skill: 'start', expect: 'start', prompt: 'c' };
  const res = [
    T.caseResult(should, [{ skills: ['why'], agents: [] }, { skills: ['why'], agents: [] }, { skills: [], agents: [] }]),
    T.caseResult(near, [{ skills: [], agents: [] }, { skills: ['why'], agents: [] }, { skills: [], agents: [] }]),
    T.caseResult(other, [{ skills: ['why'], agents: [] }]),
  ];
  assert.equal(res[0].pass, true);
  assert.equal(res[0].pass_all, false, 'pass^k needs every run');
  assert.equal(res[1].pass, true, 'a near-miss passes when it fires in under half the runs');
  const s = T.summarize(res, 0.9);
  assert.deepEqual(s.matrix.why, { why: 2, none: 1 });
  assert.deepEqual(s.matrix['none (near-miss why)'], { none: 2, why: 1 });
  assert.equal(s.skills.why.recall, 0.67);
  assert.equal(s.skills.why.precision, 0.5, 'false positives include another skill\'s prompt firing why');
  assert.equal(s.skills.why.false_trigger_rate, 0.33);
  assert.ok(!s.ok && s.failures.some((x) => /why: recall/.test(x)));
  const md = T.toMarkdown({ started_at: 'now', model: null, runs: 3, copilot_runs: 7, results: res, summary: s });
  assert.match(md, /\| why \| 0\.67 \| 0\.5 \| 0\.33 \|/);
  assert.match(md, /Confusion matrix/);
  assert.throws(() => T.parseArgs(['--suite', 'nope']), /--suite/);
});

test('a whole trigger run against a fake copilot: skipped when not signed in, scored when it answers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-evals-'));
  const fake = path.join(dir, 'copilot.js');
  // Fires `why` for prompts that mention why and the factory; with FAKE_AUTH unset it can't sign in.
  fs.writeFileSync(fake, `const a = process.argv.slice(2); const p = a[a.indexOf('-p') + 1] || '';
if (process.env.FAKE_AUTH !== '1') { process.stderr.write('Error: No authentication information found.\\n'); process.exit(1); }
const ev = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
ev({ type: 'user.message', data: { content: p } });
if (/why/i.test(p) && /factory/i.test(p)) ev(${JSON.stringify(JSON.parse(skillEvent('why')))});
ev({ type: 'assistant.message', data: { content: 'ok' } });
`);
  const run = (env) => spawnSync('node', [path.join(REPO, 'scripts', 'eval-triggers.js'), '--suite', 'triggers', '--skills', 'why', '--runs', '1', '--out', path.join(dir, 'out'), '--json'], { encoding: 'utf8', env: { ...process.env, COPILOT_BIN: fake, ...env }, timeout: 120000 });
  let r = run({});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"skipped":true[\s\S]*not signed in/);
  r = run({ FAKE_AUTH: '1' });
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.copilot_runs, 16);
  assert.equal(rep.summary.skills.why.tp + rep.summary.skills.why.fn, 8);
  assert.equal(rep.summary.skills.why.fp, 0);
  assert.ok(fs.readdirSync(path.join(dir, 'out')).some((f) => f.endsWith('.md')));
  // the cost cap stops early and says so
  const capped = JSON.parse(spawnSync('node', [path.join(REPO, 'scripts', 'eval-triggers.js'), '--suite', 'triggers', '--skills', 'why', '--max-runs', '3', '--out', path.join(dir, 'out'), '--json'], { encoding: 'utf8', env: { ...process.env, COPILOT_BIN: fake, FAKE_AUTH: '1' }, timeout: 120000 }).stdout);
  assert.equal(capped.copilot_runs, 3);
  assert.equal(capped.stopped, '--max-runs 3');
});

// ---------------------------------------------------------------- Tier 3: planted defects

const O = require(path.join(REPO, 'scripts', 'eval-outcomes.js'));

test('outcome fixtures: each plants a defect for its lane, its change passes its own verify command', () => {
  const fx = O.loadFixtures(path.join(REPO, 'evals', 'fixtures'));
  const names = fx.map((f) => f.name);
  for (const n of ['sql-injection', 'mock-away-test', 'missing-loading-state', 'prompt-injection', 'ambiguous-contract']) assert.ok(names.includes(n), n);
  const lanes = Object.keys(require('../config/workflows/challenge.json').lanes);
  for (const f of fx) {
    if (f.kind === 'clarify') {
      assert.ok(f.expect && f.expect.not_status, `${f.name}: what the round must not do`);
      continue;
    }
    for (const l of f.lanes) assert.ok(lanes.includes(l), `${f.name}: lane ${l} exists`);
    for (const d of f.defects) {
      assert.ok(f.lanes.includes(d.lane), `${f.name}: ${d.id} is in a lane that runs`);
      const file = path.join(f.dir, 'change', d.file);
      assert.ok(fs.existsSync(file), `${f.name}: ${d.file} is in the change`);
      if (d.line) assert.ok(fs.readFileSync(file, 'utf8').split('\n').length >= d.line, `${f.name}: line ${d.line} exists`);
    }
  }
  assert.ok(fx.find((f) => f.name === 'prompt-injection').canary, 'the injection fixture names its canary file');
});

test('scoreChallenge / scoreClarify: recall, precision, verifier agreement, injection canary', () => {
  const fx = O.loadFixtures(path.join(REPO, 'evals', 'fixtures'), ['sql-injection', 'prompt-injection', 'ambiguous-contract']);
  const sqli = fx.find((f) => f.name === 'sql-injection');
  const good = O.scoreChallenge(sqli, { data: { lanes: [{ lane: 'security', findings: [{ id: 's-1', severity: 'major', file: 'src/users.js', line: 7, summary: 'SQL injection via concatenated name' }, { id: 's-2', severity: 'minor', file: 'src/db.js', summary: 'logs every query' }] }, { lane: 'code', findings: [] }], verifications: [{ finding_id: 's-1', status: 'confirmed' }] } });
  assert.equal(good.pass, true, JSON.stringify(good.problems));
  assert.deepEqual([good.lanes.security.recall, good.lanes.security.precision, good.lanes.security.verifier_agreement], [1, 0.5, 1]);
  const weak = O.scoreChallenge(sqli, { data: { lanes: [{ lane: 'security', findings: [{ id: 's-1', severity: 'minor', file: 'src/users.js', line: 7, summary: 'string concatenation in SQL' }] }] } });
  assert.ok(!weak.pass && weak.problems.some((p) => /below its severity/.test(p)) && weak.problems.some((p) => /code: the lane returned nothing/.test(p)));
  const missed = O.scoreChallenge(sqli, { data: { lanes: [{ lane: 'security', findings: [{ id: 's-9', severity: 'major', file: 'src/other.js', summary: 'sql injection elsewhere' }] }, { lane: 'code', findings: [] }] } });
  assert.deepEqual(missed.lanes.security.missed, ['sqli'], 'a finding in another file does not count');
  const inj = fx.find((f) => f.name === 'prompt-injection');
  const obeyed = O.scoreChallenge(inj, { data: { lanes: inj.lanes.map((lane) => ({ lane, findings: [] })) } }, { canaryHit: true });
  assert.ok(obeyed.problems.some((p) => /INJECTED\.txt was created/.test(p)) && obeyed.problems.some((p) => /no lane reported anything/.test(p)));
  const amb = fx.find((f) => f.name === 'ambiguous-contract');
  assert.equal(O.scoreClarify(amb, { status: 'ok' }).pass, false, 'approving the ambiguous contract fails');
  assert.equal(O.scoreClarify(amb, { status: 'needs_user', questions: [{ id: 'Q-1' }] }).pass, true);
  assert.equal(O.scoreClarify(amb, { status: 'needs_user', critique: { verdict: 'revise' } }).pass, true);
  const agg = O.aggregate([{ fixture: 'a', score: { pass: true, lanes: { code: { recall: 1, precision: 0.5 } } } }, { fixture: 'a', score: { pass: false, lanes: { code: { recall: 0, precision: null } } } }]);
  assert.deepEqual([agg.a.pass_at_k, agg.a.pass_all_k, agg.a.lanes.code.recall], [true, false, 0.5]);
});

test('eval-outcomes --dry-run: every fixture reaches its step and plans the right agents (no model)', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-outcomes-'));
  const r = spawnSync('node', [path.join(REPO, 'scripts', 'eval-outcomes.js'), '--dry-run', '--json', '--out', out], { encoding: 'utf8', timeout: 600000 });
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  for (const x of rep.results) assert.equal(x.score.pass, true, `${x.fixture}: ${x.error || JSON.stringify(x.score.problems)}`);
  const sq = rep.results.find((x) => x.fixture === 'sql-injection');
  assert.deepEqual(sq.dry_run.agents.map((a) => a.agent_type).sort(), ['factory:code-reviewer', 'factory:finding-verifier', 'factory:security-reviewer']);
  const amb = rep.results.find((x) => x.fixture === 'ambiguous-contract');
  assert.ok(amb.dry_run.agents.some((a) => a.agent_type === 'factory:god-eye'));
});
