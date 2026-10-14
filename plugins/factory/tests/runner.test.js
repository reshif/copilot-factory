'use strict';
// factory run: the real workflow scripts executed by the CLI, with every agent a
// (fake) Copilot CLI process started as `copilot -p … --agent factory:<role>`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const runner = require('../cli/core/runner');

const FAKE = path.join(__dirname, 'helpers', 'fake-copilot.js');

// A scratch dir with the fake's log and script; run() calls the CLI with COPILOT_BIN set.
function harness(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-runner-'));
  const log = path.join(dir, 'copilot.jsonl');
  let file = script;
  if (typeof script === 'object') {
    file = path.join(dir, 'script.json');
    fs.writeFileSync(file, JSON.stringify(script));
  } else if (typeof script === 'string' && !fs.existsSync(script)) {
    file = path.join(dir, 'script.js');
    fs.writeFileSync(file, script);
  }
  const env = { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: FAKE, FAKE_COPILOT_SCRIPT: file, FAKE_COPILOT_LOG: log };
  return {
    log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []),
    run(root, args) {
      const r = spawnSync('node', [F.BIN, 'run', ...args], { cwd: root, encoding: 'utf8', env, timeout: 120000 });
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

const ANALYST = { focus: 'x', questions: [] };
const CLARIFY = {
  'factory:intent-analyst': ANALYST,
  'factory:judge': { questions: [], dismissed: [] },
  'factory:god-eye': { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'add subtracts', outcome: 'add sums' }, items: [] },
};

function newJob(root, policy) {
  if (policy) fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify(policy));
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  return J;
}

const events = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const flagOf = (argv, name) => argv[argv.indexOf(name) + 1];

test('extractJson / replyText: the JSON answer out of prose, fences and JSONL', () => {
  assert.deepEqual(runner.extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(runner.extractJson('Here you go:\n```json\n{"a":2}\n```\nDone.'), { a: 2 });
  assert.deepEqual(runner.extractJson('I looked at {x} and {"b": "}"} then {"a":3}'), { a: 3 });
  assert.equal(runner.extractJson('no json here'), null);
  assert.equal(runner.extractJson('[1,2]'), null);
  const jsonl = [{ type: 'assistant.message', data: { content: '{"a":1}' } }, { type: 'assistant.message', agentId: 's', data: { content: '{"sub":1}' } }, { type: 'assistant.message', data: { content: '' } }].map((x) => JSON.stringify(x)).join('\n');
  assert.equal(runner.replyText(jsonl), '{"a":1}');
  assert.equal(runner.replyText('plain answer'), 'plain answer');
  assert.equal(runner.modelId({ opus: 'claude-opus-5.5' }, 'opus'), 'claude-opus-5.5');
  assert.equal(runner.modelId({}, 'gpt-5.4'), 'gpt-5.4');
  assert.equal(runner.modelId({}, null), null);
});

test('factory run --dry-run prints the brief and the copilot commands, maps model aliases, spawns nothing', () => {
  const root = F.makeRepo();
  newJob(root, { agents: { models: { judge: 'opus', 'intent-analyst': 'haiku', 'god-eye': 'gpt-5.4' }, model_ids: { haiku: 'claude-haiku-4.5' } }, copilot: { flags: ['--plugin-dir', '{plugin_root}'] } });
  const h = harness(CLARIFY);
  const r = h.run(root, ['fanout-judge', '--config', 'clarify', '--dry-run']);
  assert.equal(r.__code, 0, JSON.stringify(r));
  assert.equal(r.dry_run, true);
  assert.equal(r.brief.workflow, 'fanout-judge');
  assert.equal(r.brief.config, 'clarify');
  assert.equal(r.copilot, FAKE);
  assert.equal(r.max_parallel_agents, 4, 'default cap');
  const judge = r.agents.find((a) => a.agent_type === 'factory:judge');
  assert.equal(judge.model, 'opus');
  assert.equal(judge.model_id, 'claude-opus-5.5', 'default model_ids from the supported-models list');
  const cmd = judge.command;
  assert.equal(cmd[0], FAKE);
  assert.equal(flagOf(cmd, '--agent'), 'factory:judge');
  assert.equal(flagOf(cmd, '--model'), 'claude-opus-5.5');
  assert.equal(flagOf(cmd, '--output-format'), 'json');
  for (const f of ['-s', '--no-ask-user', '--allow-all-tools', '--session-id']) assert.ok(cmd.includes(f), f);
  assert.equal(flagOf(cmd, '--plugin-dir'), F.PLUGIN, 'policy.copilot.flags, with {plugin_root} filled in');
  assert.ok(!cmd.includes('--add-dir'), 'cwd is the project root: no --add-dir');
  assert.match(flagOf(cmd, '-p'), /Reply format \(strict\)[\s\S]*"questions"/, 'the strict reply block carries the schema');
  assert.equal(r.agents.filter((a) => a.agent_type === 'factory:intent-analyst').length, 4);
  assert.ok(r.agents.filter((a) => a.agent_type === 'factory:intent-analyst').every((a) => a.model_id === 'claude-haiku-4.5'), 'project model_ids override the default');
  assert.equal(r.agents.find((a) => a.agent_type === 'factory:god-eye').model_id, 'gpt-5.4', 'an unknown alias is passed as a model id');
  assert.deepEqual(h.log(), [], 'nothing was spawned');
});

test('factory run fanout-judge --config clarify: agents as copilot processes, envelope recorded in-process', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  assert.equal(F.cli(root, ['next']).skill, 'clarify');
  const h = harness(CLARIFY);
  const r = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.__code, 0, JSON.stringify(r) + r.__stderr);
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.record.status, 'ok', JSON.stringify(r.record));
  assert.ok(fs.existsSync(r.envelope_file));
  assert.match(r.__stderr, /\[factory run\] phase: clarify: intent gate/);
  const calls = h.log();
  assert.deepEqual(calls.map((c) => c.agent).sort(), ['factory:god-eye', 'factory:intent-analyst', 'factory:intent-analyst', 'factory:intent-analyst', 'factory:intent-analyst', 'factory:judge']);
  for (const c of calls) {
    assert.equal(c.cwd, fs.realpathSync(root), 'analysts and judges run at the project root');
    assert.equal(c.env.FACTORY_RUNNER, '1');
    assert.equal(c.env.FACTORY_JOB, J);
    assert.ok(!c.argv.includes('--model'), 'no model unless policy names one');
  }
  // the routing moved on, and the logs show what ran
  assert.equal(F.cli(root, ['next']).step, 'H1');
  const ev = events(root);
  const runs = ev.filter((e) => e.event === 'agent_run');
  assert.equal(runs.length, 6, 'one sealed agent_run per agent');
  for (const e of runs) {
    assert.equal(require('../cli/lib/seal').valid(e), true, 'sealed');
    assert.equal(typeof e.ms, 'number');
    assert.equal(e.exit, 0);
    assert.equal(e.retry, false);
    assert.equal(e.job, J);
    assert.match(e.decision_id, /^J-0001-D\d+$/, 'tied to the routing decision in force');
    assert.ok(e.role && e.agent_type && 'model' in e);
  }
  const cli = ev.filter((e) => e.event === 'cli');
  assert.ok(cli.some((e) => e.cmd === 'wfargs' && e.workflow === 'fanout-judge' && e.config === 'clarify' && e.via === 'run'), 'wfargs logged for the inspector');
  assert.ok(cli.some((e) => e.cmd === 'record' && e.workflow === 'fanout-judge' && e.status === 'ok' && e.via === 'run'), 'record logged for the inspector');
  assert.ok(!cli.some((e) => e.cmd === 'run'), 'no separate run line (R7 would see it as an unexpected command)');
  // the roster sealed into the ledger matches the agents spawned
  const ledger = fs.readFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.filter((e) => e.kind === 'agents').pop().agents.length, 6);
  // the console shows each agent's wall time from the agent_run lines
  const data = require('../cli/core/console').build(root, { job: J });
  const a = data.jobs.find((j) => j.id === J).timeline.find((t) => t.type === 'agents');
  assert.equal(a.step, 'clarify');
  assert.ok(a.agents.length === 6 && a.agents.every((x) => typeof x.ms === 'number'), JSON.stringify(a.agents));
});

test('a reply that misses the schema gets one corrective turn in the same session', () => {
  const root = F.makeRepo();
  newJob(root);
  const h = harness(`module.exports = (c) => {
    const base = ${JSON.stringify(CLARIFY)};
    if (c.agent === 'factory:judge' && c.turn === 1) return { text: 'I think there are no questions. {"questions": "none"}' };
    if (c.agent === 'factory:judge' && c.turn === 2) {
      if (!/not one JSON object matching/.test(c.prompt) || !/questions/.test(c.prompt)) return { text: 'unexpected correction: ' + c.prompt };
      return { text: 'Sorry! ' + JSON.stringify(base['factory:judge']) };
    }
    return base[c.agent];
  };`);
  const r = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.status, 'ok', JSON.stringify(r) + r.__stderr);
  const judge = h.log().filter((c) => c.agent === 'factory:judge');
  assert.equal(judge.length, 2);
  assert.equal(judge[0].session, judge[1].session, 'the retry resumes the same session id');
  assert.deepEqual(judge.map((c) => c.turn), [1, 2]);
  const ev = events(root).filter((e) => e.event === 'agent_run' && e.role === 'judge');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].retry, true);
  assert.equal(ev[0].spawns, 2);
  assert.equal(ev[0].outcome, 'ok');
  assert.match(r.__stderr, /judge \(factory:judge\) ok after a format retry/);
});

test('still invalid after the corrective turn → null, like a failed agent: the workflow retries, then degrades', () => {
  const root = F.makeRepo();
  newJob(root);
  const h = harness({ ...CLARIFY, 'factory:intent-analyst': [ANALYST, { text: 'prose only' }] });
  const r = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.__code, 0, JSON.stringify(r));
  assert.equal(r.status, 'degraded', JSON.stringify(r));
  assert.equal(r.record.status, 'degraded', JSON.stringify(r.record));
  const bad = r.agents.filter((a) => a.outcome === 'invalid');
  assert.ok(bad.length >= 2, 'the analyst and its workflow retry both came back invalid');
  assert.ok(bad.every((a) => a.retry && a.spawns === 2 && a.errors.length));
});

test('a crashing or hanging agent is a failed agent: exit code and timeout logged, the run degrades', () => {
  const root = F.makeRepo();
  newJob(root, { copilot: { agent_timeout_seconds: 1 } });
  // the scope/constraint/acceptance analysts crash; their workflow retries hang past the timeout
  const h2 = harness(`module.exports = (c) => {
    const base = ${JSON.stringify(CLARIFY)};
    if (c.agent === 'factory:intent-analyst' && c.n >= 1 && c.n <= 2) return { exit: 3, stderr: 'model quota exhausted' };
    if (c.agent === 'factory:intent-analyst' && c.n >= 3 && c.n <= 4) return { sleep_ms: 4000, json: base[c.agent] };
    return base[c.agent];
  };`);
  const r = h2.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.__code, 0, JSON.stringify(r));
  assert.equal(r.status, 'degraded', JSON.stringify(r));
  const outcomes = r.agents.map((a) => a.outcome);
  assert.ok(outcomes.includes('failed'), outcomes.join());
  assert.ok(outcomes.includes('timeout'), outcomes.join());
  const failed = events(root).filter((e) => e.event === 'agent_run' && e.outcome === 'failed');
  assert.ok(failed.length && failed.every((e) => e.exit === 3 && /quota/.test(e.errors[0])));
});

test('concurrency is capped by policy.limits.max_parallel_agents', () => {
  const root = F.makeRepo();
  newJob(root, { limits: { max_parallel_agents: 2 } });
  const h = harness(`module.exports = (c) => ({ sleep_ms: 400, json: ${JSON.stringify(CLARIFY)}[c.agent] });`);
  const r = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.max_parallel_agents, 2);
  const calls = h.log();
  let peak = 0;
  for (const c of calls) peak = Math.max(peak, calls.filter((o) => o.start <= c.start && o.end > c.start).length);
  assert.equal(peak, 2, 'three analysts after the intent gate, never more than two at once');
});

test('factory run realize: builders and testers start in their task worktree; the result is recorded', () => {
  const root = F.makeRepo();
  const J = newJob(root, { agents: { builder_escalation: ['opus'] } });
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 'codebase', claims: [{ claim: 'add subtracts', source: 'src/add.js:1' }], unknowns: [] }], degraded: [] }));
  F.cli(root, ['next']);
  F.cli(root, ['plan', 'from-contract'], { allowFail: false });
  assert.equal(F.cli(root, ['next']).workflow, 'realize');

  // attempt 1: the builder commits nothing useful, so the tester fails it; attempt 2 (escalated) fixes it
  const fixture = JSON.stringify(path.join(__dirname, 'helpers', 'fixture.js'));
  const h = harness(`const F = require(${fixture});
  module.exports = (c) => {
    const root = c.env.FACTORY_ROOT;
    if (c.agent === 'factory:builder') {
      const s = F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
      if (require('fs').realpathSync(s.worktree) !== c.cwd) return { exit: 9, stderr: 'not started in the worktree: ' + c.cwd };
      if (c.model) F.write(c.cwd, 'src/add.js', 'module.exports = (a, b) => a + b;\\n');
      else F.write(c.cwd, 'src/add.js', 'module.exports = (a, b) => a - b; // still wrong\\n');
      F.sh(c.cwd, 'git commit -qam "attempt"');
      return { status: 'done', summary: 'changed add', swept: ['src/add.js'] };
    }
    if (c.agent === 'factory:tester') {
      const v = F.cli(root, ['task', 'verify', 'T1']);
      return { pass: v.pass, evidence_id: v.evidence_id, failures: (v.failures || []).map((f) => f.cmd) };
    }
    return { exit: 1, stderr: 'unexpected ' + c.agent };
  };`);
  const r = h.run(root, ['realize']);
  assert.equal(r.__code, 0, JSON.stringify(r) + r.__stderr);
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.record.status, 'ok', JSON.stringify(r.record));
  const wt = fs.realpathSync(path.join(root, '.factory', 'worktrees', `${J}-T1`));
  const calls = h.log();
  assert.deepEqual(calls.map((c) => c.agent), ['factory:builder', 'factory:tester', 'factory:builder', 'factory:tester']);
  for (const c of calls) {
    assert.equal(c.cwd, wt, `${c.agent} runs in the task worktree`);
    assert.equal(flagOf(c.argv, '--add-dir'), root, 'and may still read the job folder at the project root');
  }
  assert.equal(calls[0].model, null, 'attempt 1: the builder\'s own model');
  assert.equal(calls[2].model, 'claude-opus-5.5', 'attempt 2: escalated, alias mapped to the Copilot id');
  assert.equal(F.cli(root, ['next']).workflow, 'reconcile');
});

test('factory shim links factory and factory-inspect into a directory; doctor checks the Copilot CLI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-shim-'));
  const r = F.cli(dir, ['shim', '--dir', path.join(dir, 'bin')]);
  assert.equal(r.__code, 0, JSON.stringify(r));
  assert.deepEqual(r.linked.map((l) => l.name), ['factory', 'factory-inspect']);
  assert.equal(fs.realpathSync(path.join(dir, 'bin', 'factory')), fs.realpathSync(F.BIN));
  assert.equal(r.on_path, false);
  assert.match(r.hint, /PATH/);
  const v = spawnSync(path.join(dir, 'bin', 'factory'), ['help'], { encoding: 'utf8' });
  assert.match(v.stdout, /run <ground\|fanout-judge/);
  assert.equal(F.cli(dir, ['shim', '--dir', path.join(dir, 'bin')]).linked.length, 2, 'idempotent');
  fs.rmSync(path.join(dir, 'bin', 'factory'));
  fs.writeFileSync(path.join(dir, 'bin', 'factory'), 'mine');
  assert.match(F.cli(dir, ['shim', '--dir', path.join(dir, 'bin')]).skipped[0].reason, /--force/);

  const root = F.makeRepo();
  const doc = (env) => JSON.parse(spawnSync('node', [F.BIN, 'doctor'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '', COPILOT_HOME: dir, ...env } }).stdout);
  let d = doc({ COPILOT_BIN: FAKE, COPILOT_ALLOW_ALL: '' });
  const cp = d.checks.find((c) => c.name === 'copilot cli');
  assert.equal(cp.ok, true);
  assert.match(cp.detail, /1\.0\.97 \(fake\)/);
  assert.ok(!d.checks.some((c) => c.name === 'copilot allow-all'));
  d = doc({ COPILOT_BIN: path.join(dir, 'no-such-copilot'), COPILOT_ALLOW_ALL: 'true' });
  assert.equal(d.checks.find((c) => c.name === 'copilot cli').level, 'warning');
  assert.equal(d.checks.find((c) => c.name === 'copilot allow-all').level, 'warning');
  fs.writeFileSync(path.join(dir, 'settings.json'), '// jsonc\n{ "askUser": false, "permissions": { "disableBypassPermissionsMode": "disable" }, }\n');
  d = doc({ COPILOT_BIN: FAKE, COPILOT_ALLOW_ALL: '' });
  assert.ok(d.checks.some((c) => c.name === 'copilot allow-all flags' && c.level === 'warning'));
  assert.ok(d.checks.some((c) => c.name === 'copilot askUser' && c.level === 'warning'));
});
