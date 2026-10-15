'use strict';
// Phase 2 through `factory run` with a fake Copilot CLI: retries that continue (P2.4).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');

const FAKE = path.join(__dirname, 'helpers', 'fake-copilot.js');
const core = (m) => require(`../cli/core/${m}`);

function harness(script, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-p2-'));
  const log = path.join(dir, 'copilot.jsonl');
  const file = path.join(dir, 'script.js');
  fs.writeFileSync(file, script);
  const env = { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: FAKE, FAKE_COPILOT_SCRIPT: file, FAKE_COPILOT_LOG: log, ...extraEnv };
  return {
    log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []),
    run(root, args) {
      const r = spawnSync('node', [F.BIN, 'run', ...args, '--json'], { cwd: root, encoding: 'utf8', env, timeout: 180000 });
      let out;
      try {
        out = JSON.parse(r.stdout);
      } catch {
        out = { raw: r.stdout };
      }
      return Object.assign(out, { __code: r.status, __stderr: r.stderr });
    },
  };
}
const events = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const promptOf = (call) => {
  const p = call.argv[call.argv.indexOf('-p') + 1];
  const file = p.split('\n').map((l) => l.trim()).find((l) => l.startsWith('/') && fs.existsSync(l));
  const text = fs.readFileSync(file, 'utf8');
  const nested = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith('/') && l.endsWith('.md') && fs.existsSync(l));
  return `${text}\n${nested ? fs.readFileSync(nested, 'utf8') : ''}`;
};

// bug@low up to realize, with the test's policy.
function toRealize(root, policy) {
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify(policy));
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 'codebase', claims: [{ claim: 'add subtracts', source: 'src/add.js:1' }], unknowns: [] }], degraded: [] }));
  F.cli(root, ['next']);
  F.cli(root, ['plan', 'from-contract'], { allowFail: false });
  assert.equal(F.cli(root, ['next']).workflow, 'realize');
  return J;
}

test('P2.4: a timed-out builder gets a time-up turn in its session; its work is saved as wip:, and the next run resumes the session at attempt 2 with the history', () => {
  const root = F.makeRepo();
  F.cli(root, ['init']);
  const J = toRealize(root, { copilot: { agent_timeout_seconds: 4 }, limits: { retry_limit: 1 } });
  const fixture = JSON.stringify(path.join(__dirname, 'helpers', 'fixture.js'));
  const h = harness(`const F = require(${fixture});
  module.exports = async (c) => {
    if (c.agent !== 'factory:builder') return { exit: 1, stderr: 'unexpected ' + c.agent };
    const root = c.env.FACTORY_ROOT;
    if (c.turn === 1) {
      // attempt 1: fixes add but never commits, then runs out of time
      F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
      F.write(c.cwd, 'src/add.js', 'module.exports = (a, b) => a + b;\\n');
      await new Promise((r) => setTimeout(r, 15000));
      return { status: 'done', summary: 'too late', swept: [] };
    }
    if (c.turn === 2) return 'Sorry, I was still thinking.'; // the time-up turn: no JSON, no commit
    // attempt 2 (resumed session): the fix is already committed as wip:, nothing left to do
    F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
    return { status: 'done', summary: 'continued from the wip commit; tests pass', swept: [] };
  };`);
  let r = h.run(root, ['realize']);
  assert.equal(r.status, 'park', JSON.stringify(r).slice(0, 2000) + r.__stderr);
  let calls = h.log();
  // the killed first turn leaves no log line (the fake logs on exit); its time-up turn does
  assert.equal(calls.length, 1, 'the time-up turn');
  assert.equal(calls[0].turn, 2, 'turn 2 of the builder\'s session');
  assert.match(promptOf(calls[0]), /Time is up for this attempt[\s\S]*Commit what works now/);
  const st = core('job').load(root, J).tasks.T1;
  assert.equal(st.builder.outcome, 'no_result');
  assert.ok(st.builder.session_id, 'the session id is kept for the next attempt');
  assert.ok(st.builder.wip_commit, 'the runner committed the uncommitted work');
  const wt = path.join(root, '.factory', 'worktrees', `${J}-T1`);
  assert.match(F.sh(wt, 'git log -1 --format=%s'), /^wip: build T1 #1 \(timeout; uncommitted work saved by factory run\)/);
  assert.equal(F.sh(wt, 'git status --porcelain'), '');
  assert.deepEqual(st.history.map((e) => [e.attempt, e.builder, e.run, Boolean(e.wip_commit)]), [[1, 'no_result', 'timeout', true]]);
  const run1 = events(root).filter((e) => e.event === 'agent_run' && e.label === 'build T1 #1');
  assert.equal(run1.length, 1);
  assert.equal(run1[0].session_id, calls[0].session, 'agent_run records the Copilot session id, the time-up turn used it');
  assert.equal(run1[0].spawns, 2);
  assert.equal(run1[0].grace_turn, true);
  assert.match(run1[0].errors[0], /timed out after 4s; its time-up turn replied without a valid result/);
  const show = F.cli(root, ['task', 'show', 'T1']);
  assert.equal(show.history[0].wip_commit, st.builder.wip_commit, 'task show returns the attempt history');

  // the human resumes: the next run continues at attempt 2, in the same Copilot session
  F.reply(root, 'resume');
  assert.equal(F.cli(root, ['next']).workflow, 'realize');
  r = h.run(root, ['realize', '--scope', 'resume']);
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 2000) + r.__stderr);
  calls = h.log();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].session, calls[0].session, 'attempt 2 resumes attempt 1\'s session (--session-id)');
  assert.equal(calls[1].turn, 3);
  assert.equal(calls[1].argv[calls[1].argv.indexOf('--session-id') + 1], st.builder.session_id);
  const p2 = promptOf(calls[1]);
  assert.match(p2, /Attempt 2\./, 'numbering continues across factory run invocations');
  assert.match(p2, /Attempt 1: the builder returned no result \(timeout\)[\s\S]*saved as [0-9a-f]{10} \(wip:\)/, 'with what attempt 1 left');
  assert.match(p2, /Time: about 0 minutes|Time: about 1 minutes/, 'the deadline is in the brief');
  const run2 = events(root).filter((e) => e.event === 'agent_run' && e.label === 'build T1 #2');
  assert.equal(run2[0].resumed_session, true);
  const done = core('job').load(root, J).tasks.T1;
  assert.deepEqual(done.history.map((e) => [e.attempt, e.builder, e.verify && e.verify.pass]), [[1, 'no_result', undefined], [2, 'done', true]]);
});
