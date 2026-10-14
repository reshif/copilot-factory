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
function harness(script, extraEnv = {}) {
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
  const env = { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: FAKE, FAKE_COPILOT_SCRIPT: file, FAKE_COPILOT_LOG: log, ...extraEnv };
  return {
    file,
    log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []),
    text(root, args) {
      return spawnSync('node', [F.BIN, 'run', ...args], { cwd: root, encoding: 'utf8', env, timeout: 120000 });
    },
    run(root, args) {
      const r = spawnSync('node', [F.BIN, 'run', ...args, ...(args.includes('--dry-run') ? [] : ['--json'])], { cwd: root, encoding: 'utf8', env, timeout: 120000 });
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
  const dirs = cmd.map((a, i) => (a === '--add-dir' ? cmd[i + 1] : null)).filter(Boolean);
  assert.deepEqual(dirs, [root, F.PLUGIN], 'the project and the plugin (bin/factory) are always added: -p cannot ask for path permissions');
  assert.match(judge.prompt, /Reply format \(strict\)[\s\S]*"questions"/, 'the strict reply block carries the schema');
  assert.ok(judge.prompt_file.startsWith(path.join(root, '.factory', 'scratch', 'runner', 'J-0001')), judge.prompt_file);
  assert.match(flagOf(cmd, '-p'), /instructions for this run are in this file[\s\S]*\.md/, '-p only points at the prompt file');
  assert.ok(flagOf(cmd, '-p').length < 600);
  assert.equal(r.preflight.ok, false, 'a dry run shows that factory next has not asked for it yet');
  assert.equal(r.preflight.code, 'not_waiting_for_workflow');
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
  assert.equal(r.next_gate, 'H1', 'the recorded result is at the top level');
  assert.equal(r.workflow.status, 'ok', 'the workflow envelope is nested');
  assert.equal(r.workflow.name, 'fanout-judge');
  assert.ok(fs.existsSync(r.workflow.envelope_file));
  assert.ok(fs.existsSync(r.result_file));
  assert.ok(!fs.existsSync(path.join(F.jobDir(root, J), 'run.lock')), 'the run lock is released');
  assert.match(r.__stderr, /\[factory run\] phase: clarify: intent gate/);
  const calls = h.log();
  assert.deepEqual(calls.map((c) => c.agent).sort(), ['factory:god-eye', 'factory:intent-analyst', 'factory:intent-analyst', 'factory:intent-analyst', 'factory:intent-analyst', 'factory:judge']);
  for (const c of calls) {
    assert.equal(c.cwd, fs.realpathSync(root), 'analysts and judges run at the project root');
    assert.deepEqual(c.argv.map((a, i) => (a === '--add-dir' ? c.argv[i + 1] : null)).filter(Boolean), [root, F.PLUGIN]);
    const file = flagOf(c.argv, '-p').split('\n')[1].trim();
    assert.ok(file.startsWith(path.join(root, '.factory', 'scratch', 'runner', J)) && fs.existsSync(file), 'the full prompt is in a file inside the project');
    assert.match(fs.readFileSync(file, 'utf8'), /Reply format \(strict\)/);
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
  F.cli(root, ['next']);
  const h = harness(`module.exports = (c) => {
    const base = ${JSON.stringify(CLARIFY)};
    if (c.agent === 'factory:judge' && c.turn === 1) return { text: 'I think there are no questions. {"questions": "none"}' };
    if (c.agent === 'factory:judge' && c.turn === 2) {
      if (!/not one JSON object matching/.test(c.instructions) || !/questions/.test(c.instructions)) return { text: 'unexpected correction: ' + c.instructions };
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
  F.cli(root, ['next']);
  const h = harness({ ...CLARIFY, 'factory:intent-analyst': [ANALYST, { text: 'prose only' }] });
  const r = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.__code, 0, JSON.stringify(r));
  assert.equal(r.status, 'degraded', JSON.stringify(r));
  assert.equal(r.workflow.status, 'degraded', 'the workflow envelope is nested under workflow');
  // going on without the angle: the same run again with --accept-degraded is allowed under the same decision
  const again = h.run(root, ['fanout-judge', '--config', 'clarify', '--accept-degraded']);
  assert.notEqual(again.code, 'not_waiting_for_workflow', JSON.stringify(again));
  const bad = r.agents.filter((a) => a.outcome === 'invalid');
  assert.ok(bad.length >= 2, 'the analyst and its workflow retry both came back invalid');
  assert.ok(bad.every((a) => a.retry && a.spawns === 2 && a.errors.length));
});

test('a crashing or hanging agent is a failed agent: exit code and timeout logged, the run degrades', () => {
  const root = F.makeRepo();
  newJob(root, { copilot: { agent_timeout_seconds: 1 } });
  F.cli(root, ['next']);
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
  F.cli(root, ['next']);
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
  assert.equal(r.tasks[0].outcome, 'done', JSON.stringify(r));
  const wt = fs.realpathSync(path.join(root, '.factory', 'worktrees', `${J}-T1`));
  const calls = h.log();
  assert.deepEqual(calls.map((c) => c.agent), ['factory:builder', 'factory:tester', 'factory:builder', 'factory:tester']);
  for (const c of calls) {
    assert.equal(c.cwd, wt, `${c.agent} runs in the task worktree`);
    assert.deepEqual(c.argv.map((a, i) => (a === '--add-dir' ? c.argv[i + 1] : null)).filter(Boolean), [root, F.PLUGIN], 'and may still read the job folder and run the factory CLI');
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

// ---------------------------------------------------------------- run output, preflight, lock, Copilot missing

test('the printed result is the RECORDED result: envelope ok but the contract has problems → needs_user with the problems', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  // God Eye approves, so the workflow says ok, but the CLI's own contract check finds a problem
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText({ ac: '- AC-1: add(2, 3) returns 5 (evidence: vibes)' }));
  assert.ok(F.cli(root, ['contract', 'check']).problems.length, 'precondition: the contract has a problem');
  F.cli(root, ['next']);
  const h = harness(CLARIFY);
  const r = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.__code, 0, JSON.stringify(r));
  assert.equal(r.workflow.status, 'ok', 'the workflow finished fine');
  assert.equal(r.status, 'needs_user', 'but what the skill must act on is the recorded result');
  assert.ok(r.problems.length);
  assert.match(r.message, /Fix these contract problems/);
  // the default (no --json) output is a short summary with the same status first
  F.cli(root, ['next']);
  const t = h.text(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(t.status, 0, t.stdout + t.stderr);
  const lines = t.stdout.trim().split('\n');
  assert.equal(lines[0], 'status: needs_user');
  assert.match(t.stdout, /^problems:\n  - /m);
  assert.match(t.stdout, /workflow: fanout-judge --config clarify → ok/);
  assert.match(t.stdout, /agents: 6 \(6 ok\)/);
  assert.match(t.stdout, /full result: .*\.result\.json/);
  assert.ok(lines.length < 25, `compact: ${lines.length} lines`);
});

test('God Eye asks for revisions: needs_user with the critique, in the JSON and the summary', () => {
  const root = F.makeRepo();
  newJob(root);
  F.cli(root, ['next']);
  const critique = { verdict: 'revise', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, items: [{ issue: 'AC-1 does not say what add(-1, 1) returns', severity: 'major' }] };
  const h = harness({ ...CLARIFY, 'factory:god-eye': critique });
  const t = h.text(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(t.status, 0, t.stdout + t.stderr);
  assert.match(t.stdout, /^status: needs_user/);
  assert.match(t.stdout, /critique: verdict revise/);
  assert.match(t.stdout, /AC-1 does not say what add\(-1, 1\) returns/);
  const full = JSON.parse(fs.readFileSync(t.stdout.match(/full result: (\S+)/)[1], 'utf8'));
  assert.equal(full.critique.verdict, 'revise');
  assert.equal(full.workflow.status, 'needs_user');
});

test('questions are at the top level and in the summary', () => {
  const root = F.makeRepo();
  newJob(root);
  F.cli(root, ['next']);
  const q = { id: 'q1', category: 'intent', question: 'Should add accept strings?', why: 'changes the contract', options: ['yes', 'no'], default: 'no' };
  const h = harness({ ...CLARIFY, 'factory:intent-analyst': { focus: 'intent', questions: [q] }, 'factory:judge': { questions: [q], dismissed: [] } });
  const t = h.text(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(t.status, 0, t.stdout + t.stderr);
  assert.match(t.stdout, /^status: needs_user/);
  assert.match(t.stdout, /questions \(1\)[\s\S]*1\. Q-1 \[intent\] Should add accept strings\?.*options: yes \/ no.*default: no/);
  const full = JSON.parse(fs.readFileSync(t.stdout.match(/full result: (\S+)/)[1], 'utf8'));
  assert.equal(full.status, 'needs_user');
  assert.equal(full.questions[0].id, 'Q-1');
  assert.equal(full.intent_first, true);
});

test('factory run refuses unless factory next asked for exactly that workflow on an active job with no gate pending', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const h = harness(CLARIFY);
  const refused = (r, reason) => {
    assert.equal(r.__code, 1, JSON.stringify(r));
    assert.equal(r.code, 'not_waiting_for_workflow', JSON.stringify(r));
    assert.equal(r.details.reason, reason, JSON.stringify(r));
  };
  // no decision yet
  refused(h.run(root, ['fanout-judge', '--config', 'clarify']), 'not_asked');
  assert.equal(F.cli(root, ['next']).skill, 'clarify');
  // the wrong workflow, or the right one with the wrong config
  refused(h.run(root, ['ground']), 'not_asked');
  refused(h.run(root, ['fanout-judge', '--config', 'decide']), 'not_asked');
  assert.deepEqual(h.log(), [], 'nothing was spawned');
  // the right one runs; running it again for the same decision is refused
  assert.equal(h.run(root, ['fanout-judge', '--config', 'clarify']).status, 'ok');
  refused(h.run(root, ['fanout-judge', '--config', 'clarify']), 'already_recorded');
  // at a gate
  assert.equal(F.cli(root, ['next']).step, 'H1');
  refused(h.run(root, ['ground']), 'gate_pending');
  // parked
  F.reply(root, 'approve');
  assert.equal(F.cli(root, ['next']).workflow, 'ground');
  F.cli(root, ['park', '--reason', 'waiting on the API team']);
  refused(h.run(root, ['ground']), 'parked');
  assert.equal(h.log().length, 6, 'only the one allowed run spawned agents');
  assert.ok(!fs.existsSync(path.join(F.jobDir(root, J), 'run.lock')));
});

test('one factory run per job at a time: a live run.lock refuses with run_in_progress; a stale one is taken over', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  const h = harness(CLARIFY);
  const lock = path.join(F.jobDir(root, J), 'run.lock');
  // a live holder (this test process is a node process)
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), started_at: '2026-01-01T00:00:00Z', workflow: 'fanout-judge', config: 'clarify' }));
  const r = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.code, 'run_in_progress', JSON.stringify(r));
  assert.match(r.message, /still running[\s\S]*don't start it again/);
  assert.deepEqual(h.log(), []);
  // a holder that is gone
  const dead = spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.writeFileSync(lock, JSON.stringify({ pid: Number(dead), host: os.hostname(), started_at: '2026-01-01T00:00:00Z' }));
  assert.equal(h.run(root, ['fanout-judge', '--config', 'clarify']).status, 'ok');
  assert.ok(!fs.existsSync(lock));
  // two runs started together: one runs, the other is refused
  const root2 = F.makeRepo();
  newJob(root2);
  F.cli(root2, ['next']);
  const slow = harness(`module.exports = (c) => ({ sleep_ms: 300, json: ${JSON.stringify(CLARIFY)}[c.agent] });`);
  const { spawn } = require('child_process');
  const go = () => new Promise((res) => {
    const p = spawn('node', [F.BIN, 'run', 'fanout-judge', '--config', 'clarify', '--json'], { cwd: root2, env: { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: FAKE, FAKE_COPILOT_SCRIPT: slow.file } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => res(JSON.parse(out)));
  });
  return Promise.all([go(), go()]).then((rs) => {
    const codes = rs.map((x) => x.status || x.code).sort();
    assert.deepEqual(codes, ['ok', 'run_in_progress'], JSON.stringify(rs.map((x) => x.message || x.status)));
  });
});

test('Copilot missing or not signed in: the run aborts with copilot_unavailable and records nothing', () => {
  const root = F.makeRepo();
  newJob(root);
  F.cli(root, ['next']);
  const missing = harness(CLARIFY, { COPILOT_BIN: path.join(os.tmpdir(), 'no-such-copilot-bin') });
  let r = missing.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.__code, 1, JSON.stringify(r));
  assert.equal(r.code, 'copilot_unavailable', JSON.stringify(r));
  assert.equal(r.details.why, 'not_found');
  assert.match(r.message, /could not be started[\s\S]*COPILOT_BIN[\s\S]*Nothing was recorded/);
  const signedOut = harness({ 'factory:intent-analyst': { exit: 1, stderr: 'Error: No authentication information found.\n\nTo authenticate, you can use any of the following methods:' } });
  r = signedOut.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.code, 'copilot_unavailable', JSON.stringify(r));
  assert.equal(r.details.why, 'not_signed_in');
  assert.match(r.message, /not signed in[\s\S]*\/login/);
  assert.equal(signedOut.log().length, 1, 'the first failure stops the run: no retries, no other agents');
  assert.ok(!events(root).some((e) => e.event === 'cli' && e.cmd === 'record'), 'nothing recorded');
  const n = F.cli(root, ['next']);
  assert.equal(n.skill, 'clarify', 'the job is where it was, not parked');
  assert.equal(n.requery, true, 'a run Copilot could not start is no attempt: no new decision, no repeat counted');
});

test('resolveBin: copilot.cmd on Windows runs its npm-loader.js with Node; copilot.exe directly; others unchanged', () => {
  const W = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  const files = new Map([
    [`${W}\\copilot.cmd`, '@ECHO off\r\nGOTO start\r\n:start\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@github\\copilot\\npm-loader.js" %*\r\n'],
    [`${W}\\node_modules\\@github\\copilot\\npm-loader.js`, ''],
    ['C:\\Tools\\copilot.exe', ''],
    ['D:\\odd\\copilot.bat', '@echo off\r\nsomething.exe %*\r\n'],
  ]);
  const opts = (PATH) => ({ platform: 'win32', env: { PATH, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, existsFn: (f) => files.has(f), readFn: (f) => files.get(f) });
  assert.deepEqual(runner.resolveBin('copilot', opts(`C:\\Windows;${W}`)), { file: process.execPath, pre: [`${W}\\node_modules\\@github\\copilot\\npm-loader.js`], shell: false });
  assert.deepEqual(runner.resolveBin('copilot', opts(`C:\\Tools;${W}`)), { file: 'C:\\Tools\\copilot.exe', pre: [], shell: false });
  assert.deepEqual(runner.resolveBin('copilot', opts('D:\\odd')), { file: 'D:\\odd\\copilot.bat', pre: [], shell: true });
  assert.deepEqual(runner.resolveBin('copilot', opts('C:\\nowhere')), { file: 'copilot', pre: [], shell: false });
  const [cmd, args, shell] = runner.command('copilot', ['-p', 'say "hi"'], opts('D:\\odd'));
  assert.equal(shell, true);
  assert.deepEqual(args, []);
  assert.equal(cmd, '"D:\\odd\\copilot.bat" "-p" "say ""hi"""');
  assert.deepEqual(runner.resolveBin('copilot', { platform: 'linux' }), { file: 'copilot', pre: [], shell: false });
  assert.deepEqual(runner.resolveBin('/x/fake.js', { platform: 'win32' }), { file: process.execPath, pre: ['/x/fake.js'], shell: false });
});

// ---------------------------------------------------------------- every workflow through factory run

const CREW = path.join(__dirname, 'helpers', 'crew.js');
const roles = (r) => r.agents.map((a) => a.agent_type.replace('factory:', '')).sort();

// The router's own workflow decision, as factory run arguments (what the start skill passes).
function runArgs(n) {
  const a = [n.workflow];
  if (n.config) a.push('--config', n.config);
  if (n.mode) a.push('--mode', n.mode);
  if (n.scope) a.push('--scope', n.scope);
  if (n.lanes) a.push('--lanes', [].concat(n.lanes).join(','));
  if (n.threat_model === true) a.push('--threat-model');
  if (n.threat_model === false) a.push('--no-threat-model');
  if (n.plan_critique) a.push('--plan-critique');
  return a;
}

test('bug@low through factory run: clarify, ground, realize, reconcile, challenge (a finding verified), each dry-run first', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const h = harness(CREW, { FAKE_CREW: JSON.stringify({ finding: 'major', verdict: 'refuted' }) });
  const step = (expect, check) => {
    let n = F.cli(root, ['next']);
    if (n.action === 'skill' && n.skill === 'clarify') n = { workflow: 'fanout-judge', config: 'clarify' }; // the clarify skill's round
    else assert.equal(n.action, 'workflow', JSON.stringify(n));
    assert.equal(n.workflow, expect.workflow, JSON.stringify(n));
    const args = runArgs(n);
    const dry = h.run(root, [...args, '--dry-run']);
    assert.equal(dry.__code, 0, JSON.stringify(dry));
    assert.equal(dry.preflight.ok, true, JSON.stringify(dry.preflight));
    assert.deepEqual(dry.agents.map((a) => a.agent_type.replace('factory:', '')).sort(), expect.dry, `${n.workflow} dry run`);
    const before = h.log().length;
    const r = h.run(root, args);
    assert.equal(r.__code, 0, JSON.stringify(r) + r.__stderr);
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.equal(h.log().length - before, r.agents.reduce((s, a) => s + a.spawns, 0), 'one process per spawn');
    if (check) check(r);
    return r;
  };
  step({ workflow: 'fanout-judge', dry: ['god-eye', 'intent-analyst', 'intent-analyst', 'intent-analyst', 'intent-analyst', 'judge'] });
  assert.equal(F.cli(root, ['next']).step, 'H1');
  F.reply(root, 'approve');
  step({ workflow: 'ground', dry: ['researcher', 'researcher', 'researcher', 'researcher'] }, (r) => {
    assert.deepEqual(roles(r), ['researcher', 'researcher', 'researcher', 'researcher'], 'one probe per topic');
    assert.match(fs.readFileSync(path.join(F.jobDir(root, J), 'findings.md'), 'utf8'), /add subtracts/);
  });
  assert.match(F.cli(root, ['next']).command, /plan from-contract/);
  F.cli(root, ['plan', 'from-contract'], { allowFail: false });
  step({ workflow: 'realize', dry: ['builder', 'tester'] }, (r) => assert.deepEqual(roles(r), ['builder', 'tester']));
  step({ workflow: 'reconcile', dry: ['integrator'] }, (r) => assert.deepEqual(roles(r), ['integrator']));
  assert.match(F.cli(root, ['next']).command, /verify run/);
  assert.equal(F.cli(root, ['verify', 'run']).ok, true);
  step({ workflow: 'fanout-judge', dry: ['code-reviewer', 'finding-verifier'] }, (r) => {
    assert.deepEqual(roles(r), ['code-reviewer', 'finding-verifier'], 'the major finding got a verifier');
    assert.equal(r.workflow.config, 'challenge');
    assert.match(r.message, /All required lanes pass/);
  });
  assert.equal(F.cli(root, ['next']).skill, 'ship');
});

test('standard@medium through factory run: decide with --threat-model, H2, decompose with --plan-critique, H3', () => {
  const root = F.makeRepo();
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), '{}');
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  const h = harness(CREW);
  let n = F.cli(root, ['next']);
  assert.equal(h.run(root, runArgs({ workflow: 'fanout-judge', config: 'clarify' })).status, 'ok');
  assert.equal(F.cli(root, ['next']).step, 'H1');
  F.reply(root, 'approve');
  n = F.cli(root, ['next']);
  assert.equal(n.workflow, 'ground');
  assert.equal(h.run(root, runArgs(n)).status, 'ok');
  n = F.cli(root, ['next']);
  assert.equal(n.config, 'decide');
  // decide, with the threat model asked for explicitly
  const args = [...runArgs({ ...n, threat_model: true })];
  const dry = h.run(root, [...args, '--dry-run']);
  assert.equal(dry.preflight.ok, true);
  const dryRoles = dry.agents.map((a) => a.agent_type.replace('factory:', '')).sort();
  for (const r of ['option-generator', 'threat-modeler', 'architect', 'god-eye']) assert.ok(dryRoles.includes(r), `${r} in ${dryRoles}`);
  let r = h.run(root, args);
  assert.equal(r.__code, 0, JSON.stringify(r) + r.__stderr);
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.match(r.message, /Design critique approved/);
  for (const role of ['option-generator', 'threat-modeler', 'architect', 'god-eye']) assert.ok(roles(r).includes(role), `${role} ran: ${roles(r)}`);
  assert.ok(fs.existsSync(path.join(F.jobDir(root, J), 'threat-model.md')));
  n = F.cli(root, ['next']);
  assert.equal(n.step, 'H2', JSON.stringify(n));
  F.reply(root, 'approve');
  // decompose, with the plan critique
  n = F.cli(root, ['next']);
  assert.equal(n.workflow, 'decompose');
  const dargs = runArgs({ ...n, plan_critique: true });
  const ddry = h.run(root, [...dargs, '--dry-run']);
  assert.deepEqual(ddry.agents.map((a) => a.agent_type.replace('factory:', '')).sort(), ['god-eye', 'planner']);
  r = h.run(root, dargs);
  assert.equal(r.status, 'ok', JSON.stringify(r) + r.__stderr);
  assert.deepEqual(roles(r), ['god-eye', 'planner']);
  assert.match(r.message, /Plan valid: 1 tasks/);
  n = F.cli(root, ['next']);
  assert.equal(n.step, 'H3', JSON.stringify(n));
  // after "deny" at H3 the router sends decompose again (the reason goes into its brief)
  F.reply(root, 'deny split the test change into its own task');
  n = F.cli(root, ['next']);
  assert.equal(n.workflow, 'decompose');
  assert.equal(n.rule, 'gate.denied_revise');
  const again = h.run(root, [...runArgs(n), '--dry-run']);
  assert.equal(again.preflight.ok, true);
  const planner = again.agents.find((a) => a.agent_type === 'factory:planner');
  assert.match(fs.readFileSync(planner.prompt.split('\n').find((l) => l.trim().startsWith('/') && l.trim().endsWith('.md')).trim(), 'utf8') + planner.prompt, /split the test change into its own task/);
});
