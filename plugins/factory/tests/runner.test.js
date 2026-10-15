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
  'factory:intent-mapper': { unknowns: [] },
  'factory:intent-analyst': ANALYST,
  'factory:judge': { questions: [], dismissed: [] },
  'factory:god-eye': { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'add subtracts', outcome: 'add sums' }, items: [], researchable_questions: [] },
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
  for (const f of ['-s', '--no-ask-user', '--session-id']) assert.ok(cmd.includes(f), f);
  assert.ok(!cmd.includes('--allow-all-tools'), 'no blanket pre-approval: each role gets its own --allow-tool / --deny-tool');
  assert.deepEqual(judge.tools, runner.agentTools('judge'), 'tools come from the agent file');
  assert.ok(cmd.includes('--deny-tool=shell') && cmd.includes('--deny-tool=write') && cmd.includes('--deny-tool=url'), 'the judge only reads');
  assert.ok(!cmd.some((a) => a.startsWith('--allow-tool=')), 'nothing pre-approved for a read-only, shell-less role');
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
  assert.deepEqual(calls.map((c) => c.agent).sort(), ['factory:god-eye', 'factory:intent-analyst', 'factory:intent-analyst', 'factory:intent-analyst', 'factory:intent-analyst', 'factory:intent-mapper', 'factory:judge']);
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
  assert.equal(runs.length, 7, 'one sealed agent_run per agent');
  const starts = ev.filter((e) => e.event === 'agent_start');
  assert.equal(starts.length, 7, 'one agent_start per agent, so the console can show it at work');
  assert.deepEqual(starts.map((e) => e.run_id).sort(), runs.map((e) => e.run_id).sort(), 'each agent_run closes its agent_start (same run_id)');
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
  assert.equal(ledger.filter((e) => e.kind === 'agents').pop().agents.length, 7);
  // the console shows each agent's wall time from the agent_run lines
  const data = require('../cli/core/console').build(root, { job: J });
  const a = data.jobs.find((j) => j.id === J).timeline.find((t) => t.type === 'agents');
  assert.equal(a.step, 'clarify');
  assert.ok(a.agents.length === 7 && a.agents.every((x) => typeof x.ms === 'number'), JSON.stringify(a.agents));
});

test('factory run logs each workflow step as it starts (workflow_phase), the run\'s start and end, and tags each agent with its run and step', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  const h = harness(CLARIFY);
  const r = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.__code, 0, JSON.stringify(r) + r.__stderr);
  const ev = events(root);
  const mine = ev.filter((e) => /^workflow_/.test(e.event));
  assert.deepEqual(mine.map((e) => e.event), ['workflow_start', ...r.workflow.phases.map(() => 'workflow_phase'), 'workflow_end'], 'start, one line per step, end');
  const phases = mine.filter((e) => e.event === 'workflow_phase');
  assert.deepEqual(phases.map((e) => e.text), r.workflow.phases, 'the steps in the order the workflow ran them');
  assert.deepEqual(phases.map((e) => e.text), ['clarify: scout · map the unknowns', 'clarify: intent gate (1)', 'clarify: fan-out (3)', 'clarify: judge', 'clarify: God Eye (intent)']);
  assert.deepEqual(phases.map((e) => e.index), [0, 1, 2, 3, 4]);
  const run = mine[0].wf_run;
  assert.match(run, /^[0-9a-f-]{36}$/);
  for (const e of mine) {
    assert.equal(e.job, J);
    assert.equal(e.decision_id, r.decision_id, 'tied to the routing decision in force');
    assert.equal(e.workflow, 'fanout-judge');
    assert.equal(e.config, 'clarify');
    assert.equal(e.wf_run, run, 'one id for the whole run');
    assert.equal(require('../cli/lib/seal').valid(e), true, 'sealed like every log line');
  }
  assert.equal(mine[0].round, 1);
  assert.equal(mine[0].pid > 0, true);
  const endLine = mine[mine.length - 1];
  assert.deepEqual([endLine.outcome, endLine.status, endLine.phases, endLine.agents], ['ok', 'ok', 5, 7]);
  // every agent line names its run and the step it was started in, in log order after that step's line
  const agents = ev.filter((e) => e.event === 'agent_start' || e.event === 'agent_run');
  assert.ok(agents.every((e) => e.wf_run === run && Number.isInteger(e.step)), JSON.stringify(agents.map((e) => [e.label, e.step])));
  const stepOf = Object.fromEntries(agents.filter((e) => e.event === 'agent_start').map((e) => [e.label, e.step]));
  assert.deepEqual(stepOf, { 'intent map': 0, 'analyst · intent': 1, 'analyst · ambiguity': 2, 'analyst · constraints': 2, 'analyst · testability': 2, judge: 3, 'god-eye · intent': 4 });
  const pos = (pred) => ev.findIndex(pred);
  for (const a of agents.filter((e) => e.event === 'agent_start')) assert.ok(pos((e) => e === a) > pos((e) => e.event === 'workflow_phase' && e.index === a.step), `${a.label} starts after its step`);
  // and the console folds them into the run's steps
  const job = require('../cli/core/console').build(root, { job: J }).jobs[0];
  assert.equal(job.runs.length, 1);
  assert.equal(job.runs[0].step, 'clarify');
  assert.equal(job.runs[0].stage, 'contract');
  assert.equal(job.runs[0].status, 'done');
  assert.deepEqual(job.runs[0].steps.map((s) => [s.state, s.label, s.roles.map((x) => `${x.role}×${x.total}`).join(',')]), [
    ['done', 'map the unknowns', 'intent-mapper×1'], ['skipped', 'research the unknowns', ''], ['skipped', 'verify findings', ''], ['done', 'intent gate (1)', 'intent-analyst×1'],
    ['done', 'fan-out (3)', 'intent-analyst×3'], ['done', 'judge', 'judge×1'], ['done', 'God Eye (intent)', 'god-eye×1'],
  ]);
  assert.deepEqual(job.runs_live, { running: null, last_by_stage: { contract: run } });
});

test('a run that cannot finish (Copilot missing) ends as failed in the log, so the console never shows it at work', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  const h = harness(CLARIFY, { COPILOT_BIN: path.join(os.tmpdir(), 'no-such-copilot-bin') });
  const r = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.notEqual(r.__code, 0);
  const mine = events(root).filter((e) => /^workflow_/.test(e.event));
  assert.deepEqual(mine.map((e) => e.event), ['workflow_start', 'workflow_phase', 'workflow_end']);
  assert.equal(mine[2].outcome, 'failed');
  assert.match(mine[2].error, /copilot unavailable/);
  const run = require('../cli/core/console').build(root, { job: J }).jobs[0].runs[0];
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.steps.filter((x) => x.text).map((x) => [x.state, x.label]), [['failed', 'map the unknowns']]);
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
  const first = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(first.__code, 0, JSON.stringify(first));
  // clarify v2: a degraded round is retried once automatically and does not count
  assert.equal(first.status, 'retry', JSON.stringify(first));
  assert.equal(first.workflow.status, 'degraded', 'the workflow envelope is nested under workflow');
  F.cli(root, ['next']);
  const r = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.status, 'park', 'two degraded clarify rounds in a row park the job (0.6.1), naming the agent');
  assert.match(r.park_reason, /intent-analyst/);
  // going on without the angle: the user resumes, then the run with --accept-degraded
  F.reply(root, 'resume');
  F.cli(root, ['next']);
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
  assert.equal(r.status, 'retry', 'clarify v2: the first degraded round is retried automatically');
  assert.equal(r.workflow.status, 'degraded', JSON.stringify(r));
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

test('factory run realize: builders start in their task worktree, task verify decides, the result is recorded', () => {
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

  // attempt 1: the builder commits nothing useful, so task verify fails it; attempt 2 (escalated) fixes it
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
    return { exit: 1, stderr: 'unexpected ' + c.agent };
  };`);
  const r = h.run(root, ['realize']);
  assert.equal(r.__code, 0, JSON.stringify(r) + r.__stderr);
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.tasks[0].outcome, 'done', JSON.stringify(r));
  const wt = fs.realpathSync(path.join(root, '.factory', 'worktrees', `${J}-T1`));
  const calls = h.log();
  assert.deepEqual(calls.map((c) => c.agent), ['factory:builder', 'factory:builder'], 'no LLM tester: the runner runs task verify');
  assert.deepEqual(r.checks.filter((x) => x.step === 'verify').map((x) => [x.step, x.task, x.pass]), [['verify', 'T1', false], ['verify', 'T1', true]]);
  const second = fs.readFileSync(calls[1].argv[calls[1].argv.indexOf('-p') + 1].split('\n').map((l) => l.trim()).find((l) => l.startsWith('/')), 'utf8');
  assert.match(second, /`node tests\/add.test.js` exited 1/, 'attempt 2 gets the failing command');
  assert.match(second, /add\(2,3\) = -1/, 'and its raw output');
  for (const c of calls) {
    assert.equal(c.cwd, wt, `${c.agent} runs in the task worktree`);
    assert.deepEqual(c.argv.map((a, i) => (a === '--add-dir' ? c.argv[i + 1] : null)).filter(Boolean), [root, F.PLUGIN], 'and may still read the job folder and run the factory CLI');
  }
  assert.equal(calls[0].model, null, 'attempt 1: the builder\'s own model');
  assert.equal(calls[1].model, 'claude-opus-5.5', 'attempt 2: escalated, alias mapped to the Copilot id');
  // the wave was integrated (merged, checks run on the job branch), which is reconcile's result too
  assert.deepEqual(r.checks.filter((x) => x.step === 'integrate').map((x) => [x.wave, x.ok]), [[1, true]]);
  assert.match(F.cli(root, ['next']).command, /verify run/, 'no reconcile run left to do');
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
  assert.ok(d.checks.some((c) => c.name === 'copilot allow-all flags' && c.ok), 'per-role --allow-tool is not suppressed by the setting');
  fs.mkdirSync(path.join(root, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ copilot: { permissions: 'allow-all' } }));
  d = doc({ COPILOT_BIN: FAKE, COPILOT_ALLOW_ALL: '' });
  assert.ok(d.checks.some((c) => c.name === 'copilot allow-all flags' && c.level === 'warning'), 'allow-all mode is suppressed by it');
  assert.ok(d.checks.some((c) => c.name === 'copilot askUser' && c.level === 'warning'));
});

// ---------------------------------------------------------------- run output, preflight, lock, Copilot missing

test('the printed result is the RECORDED result: envelope ok but the contract has problems → revise with the problems (the editor fixes them)', () => {
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
  assert.equal(r.status, 'revise', 'but what the skill must act on is the recorded result');
  assert.ok(r.problems.length);
  assert.match(r.message, /contract editor fixes them/);
  assert.equal(r.clarify.round.progress, false, 'nothing settled, nothing asked');
  // the default (no --json) output is a short summary with the same status first; round 2's
  // contract editor fixes the problem (the CLI writes its revision) and the round is ok
  F.cli(root, ['next']);
  const fixed = F.contractText({ ac: '- AC-1: add(2, 3) returns 5 (evidence: test)' });
  const h2 = harness({ ...CLARIFY, 'factory:contract-editor': { contract: fixed, applied: [{ ref: 'AC-1', section: 'Acceptance criteria', change: 'evidence type test' }], skipped: [] } });
  const t = h2.text(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(t.status, 0, t.stdout + t.stderr);
  const lines = t.stdout.trim().split('\n');
  assert.equal(lines[0], 'status: ok');
  assert.match(fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8'), /add\(2, 3\) returns 5 \(evidence: test\)/);
  assert.match(t.stdout, /workflow: fanout-judge --config clarify → ok/);
  assert.match(t.stdout, /agents: 7 \(7 ok\)/, 'round 2 reuses round 1\'s map (no intent mapper again) and runs the contract editor');
  assert.match(t.stdout, /full result: .*\.result\.json/);
  assert.ok(lines.length < 25, `compact: ${lines.length} lines`);
});

test('God Eye asks for revisions: an item with no pointer is a note (approve with notes); a pointed blocker is revised, then asked with its default', () => {
  // clarify v2: "revise" with nothing actionable never leaves the user with nothing to answer
  let root = F.makeRepo();
  newJob(root);
  F.cli(root, ['next']);
  const note = { verdict: 'revise', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, items: [{ issue: 'AC-1 does not say what add(-1, 1) returns', severity: 'major' }], researchable_questions: [] };
  let h = harness({ ...CLARIFY, 'factory:god-eye': note });
  let t = h.text(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(t.status, 0, t.stdout + t.stderr);
  assert.match(t.stdout, /^status: ok/);
  assert.match(t.stdout, /approve with notes/);
  let full = JSON.parse(fs.readFileSync(t.stdout.match(/full result: (\S+)/)[1], 'utf8'));
  assert.equal(full.notes[0].text, 'AC-1 does not say what add(-1, 1) returns');
  // a blocker that points at AC-1: the contract editor revises, God Eye looks again; still a
  // blocker → one question whose default is God Eye's suggestion
  root = F.makeRepo();
  newJob(root);
  F.cli(root, ['next']);
  const blocker = { verdict: 'revise', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, items: [{ issue: 'AC-1 does not say what add(-1, 1) returns', severity: 'blocker', suggestion: 'add(-1, 1) returns 0', ref: 'AC-1', same_as: 'new', subject: 'add.negative' }], researchable_questions: [] };
  const contract = fs.readFileSync(path.join(F.jobDir(root, 'J-0001'), 'contract.md'), 'utf8');
  h = harness({ ...CLARIFY, 'factory:god-eye': blocker, 'factory:contract-editor': { contract: contract.replace('(evidence: test)', 'and add(-1, 1) returns 0 (evidence: test)'), applied: [{ ref: 'AC-1', section: 'Acceptance criteria', change: 'add(-1, 1) returns 0' }], skipped: [] } });
  t = h.text(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(t.status, 0, t.stdout + t.stderr);
  assert.match(t.stdout, /^status: needs_user/);
  assert.match(t.stdout, /Q-1 \[acceptance\] AC-1 does not say what add\(-1, 1\) returns.*default: add\(-1, 1\) returns 0/);
  full = JSON.parse(fs.readFileSync(t.stdout.match(/full result: (\S+)/)[1], 'utf8'));
  assert.deepEqual(full.agents.map((a) => a.label).filter((l) => /god-eye|editor/.test(l)), ['god-eye · intent', 'contract editor · God Eye\'s items', 'god-eye · intent (after the revision)']);
  assert.match(fs.readFileSync(path.join(F.jobDir(root, 'J-0001'), 'contract.md'), 'utf8'), /add\(-1, 1\) returns 0 \(evidence: test\)/, 'the CLI wrote the editor\'s revision');
});

test('questions are at the top level and in the summary', () => {
  const root = F.makeRepo();
  newJob(root);
  F.cli(root, ['next']);
  const q = { id: 'q1', category: 'intent', question: 'Should add accept strings?', why: 'changes the contract', options: ['yes', 'no'], default: 'no', unknown: 'new', kind: 'user', preference: true };
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
  assert.equal(h.log().length, 7, 'only the one allowed run spawned agents (the intent mapper and six more)');
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
  const signedOut = harness({ 'factory:intent-mapper': { exit: 1, stderr: 'Error: No authentication information found.\n\nTo authenticate, you can use any of the following methods:' } });
  r = signedOut.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.code, 'copilot_unavailable', JSON.stringify(r));
  assert.equal(r.details.why, 'not_signed_in');
  assert.match(r.message, /not signed in[\s\S]*\/login/);
  assert.equal(signedOut.log().length, 1, 'the first failure stops the run: no retries, no other agents');
  assert.ok(!events(root).some((e) => e.event === 'cli' && e.cmd === 'record'), 'nothing recorded');
  const ev = events(root);
  assert.ok(ev.some((e) => e.event === 'cli' && e.cmd === 'run' && e.code === 'copilot_unavailable' && e.ok === false), 'the failed run is logged with its code');
  assert.ok(ev.some((e) => e.event === 'agent_run' && e.outcome === 'copilot_unavailable' && e.code === 'copilot_unavailable'), 'and the agent that could not start');
  const open = ev.filter((e) => e.event === 'agent_start').filter((s) => !ev.some((e) => e.event === 'agent_run' && e.run_id === s.run_id));
  assert.deepEqual(open, [], 'no agent is left looking at work');
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

test('bug@low through factory run: clarify, ground, realize (integrating its wave), challenge (a finding verified), each dry-run first', () => {
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
  step({ workflow: 'fanout-judge', dry: ['contract-editor', 'god-eye', 'intent-analyst', 'intent-analyst', 'intent-analyst', 'intent-analyst', 'intent-mapper', 'judge', 'researcher', 'researcher', 'verifier'] }, (r) => {
    // the scout phase ran first: map → repo scout → verifier, then the usual clarify crew
    assert.deepEqual(roles(r), ['god-eye', 'intent-analyst', 'intent-analyst', 'intent-analyst', 'intent-analyst', 'intent-mapper', 'judge', 'researcher', 'verifier']);
    assert.deepEqual(r.agents.map((a) => a.label).slice(0, 3), ['intent map', 'scout · repo #1', 'verify evidence #1'], 'research comes before the analysts');
    assert.ok(r.agents.filter((a) => /^(scout|verify)/.test(a.label)).every((a) => a.time_cap_sec === 120), 'scouts and the verifier run under the low-risk 2-minute cap');
    assert.deepEqual(r.findings.map((f) => [f.id, f.verdict, f.source]), [['E-1', 'confirmed', 'src/add.js:1']]);
    assert.deepEqual(r.assumptions.map((a) => [a.id, a.evidence]), [['A-1', ['E-1']]]);
    assert.ok(fs.existsSync(r.intent_findings) && fs.existsSync(r.intent_evidence));
    assert.match(fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8'), /## Assumptions \(evidence-backed\)\n<!--[^\n]*-->\n- A-1: add is implemented in src\/add\.js and subtracts \(evidence: E-1\)/);
    const doc = require('../cli/core/doc');
    assert.deepEqual(doc.checkFile(r.intent_findings, { type: 'intent-findings' }).problems, []);
  });
  assert.equal(F.cli(root, ['next']).step, 'H1');
  F.reply(root, 'approve');
  step({ workflow: 'ground', dry: ['researcher', 'researcher', 'researcher', 'researcher'] }, (r) => {
    assert.deepEqual(roles(r), ['researcher', 'researcher', 'researcher', 'researcher'], 'one probe per topic');
    const runnerFile = fs.readFileSync(h.log().filter((c) => c.agent === 'factory:researcher').pop().argv.find((a) => /instructions for this run/.test(a)).split('\n')[1].trim(), 'utf8');
    const brief = fs.readFileSync(runnerFile.split('\n')[1].trim(), 'utf8');
    assert.match(brief, /Intent research from clarify[\s\S]*U-1 \[repo\][\s\S]*assumed \(A-1\)[\s\S]*E-1 \(U-1, confirmed\)/, 'ground reuses the clarify evidence');
    assert.match(fs.readFileSync(path.join(F.jobDir(root, J), 'findings.md'), 'utf8'), /related: \[intent-findings\.md\][\s\S]*Builds on the intent research from clarify/);
    assert.match(fs.readFileSync(path.join(F.jobDir(root, J), 'findings.md'), 'utf8'), /add subtracts/);
  });
  assert.match(F.cli(root, ['next']).command, /plan from-contract/);
  F.cli(root, ['plan', 'from-contract'], { allowFail: false });
  step({ workflow: 'realize', dry: ['builder'] }, (r) => {
    assert.deepEqual(roles(r), ['builder'], 'task verify decides: no tester agent');
    assert.deepEqual(r.checks.filter((x) => x.step === 'verify').map((x) => [x.step, x.task, x.pass]), [['verify', 'T1', true]]);
  });
  // realize integrated the wave and recorded reconcile: no integrator agent is needed
  assert.match(F.cli(root, ['next']).command, /verify run/);
  assert.equal(require('../cli/core/ledger').lastStep(root, J, 'reconcile').ok, true);
  assert.equal(F.cli(root, ['verify', 'run']).ok, true);
  step({ workflow: 'fanout-judge', dry: ['code-reviewer', 'finding-verifier'] }, (r) => {
    assert.deepEqual(roles(r), ['code-reviewer', 'finding-verifier'], 'the major finding got a verifier');
    assert.equal(r.workflow.config, 'challenge');
    assert.match(r.message, /All required lanes pass/);
  });
  assert.equal(F.cli(root, ['next']).skill, 'ship');
  // Every process got exactly its role's pre-approvals (no --allow-all-tools anywhere).
  const flagsOf = (argv, f) => argv.filter((a) => a.startsWith(`${f}=`)).map((a) => a.slice(f.length + 1));
  const seen = new Set();
  for (const c of h.log()) {
    const role = c.agent.replace('factory:', '');
    seen.add(role);
    assert.ok(!c.argv.includes('--allow-all-tools'), `${role}: no blanket pre-approval`);
    const p = runner.toolPermissions(role, runner.agentTools(role), {});
    assert.deepEqual(flagsOf(c.argv, '--allow-tool'), p.allow, `${role}: --allow-tool`);
    assert.deepEqual(flagsOf(c.argv, '--deny-tool'), p.deny, `${role}: --deny-tool`);
  }
  for (const r of ['builder', 'code-reviewer', 'finding-verifier', 'researcher', 'judge', 'verifier']) assert.ok(seen.has(r), `${r} ran`);
  assert.ok(!seen.has('integrator'), 'every wave was integrated by the CLI; the integrator only runs when that could not finish');
  const argvOf = (role) => h.log().find((c) => c.agent === `factory:${role}`).argv;
  const builder = argvOf('builder');
  assert.deepEqual(flagsOf(builder, '--allow-tool'), ['shell', 'write'], 'the builder edits and runs tests in its worktree');
  assert.ok(flagsOf(builder, '--deny-tool').includes('shell(git push:*)') && !flagsOf(builder, '--deny-tool').includes('shell(git commit:*)'), 'it commits on its task branch, never pushes');
  const reviewer = argvOf('code-reviewer');
  assert.deepEqual(flagsOf(reviewer, '--allow-tool'), ['shell'], 'a reviewer may run commands…');
  for (const d of ['write', 'url', 'memory', 'shell(git commit:*)', 'shell(touch:*)', 'shell(sed -i:*)']) assert.ok(flagsOf(reviewer, '--deny-tool').includes(d), `…but not ${d}`);
  assert.deepEqual(flagsOf(argvOf('researcher'), '--allow-tool'), ['shell', 'url'], 'web roles get url');
  assert.deepEqual(flagsOf(argvOf('judge'), '--allow-tool'), [], 'the judge only reads');
  // Tier 4: the quality signals come out of what this run logged.
  const t = F.cli(root, ['telemetry', 'report']);
  const q = t.quality;
  assert.ok(q.roles.builder.runs >= 1 && q.roles.builder.correction_turn_rate === 0 && q.roles.builder.null_result_rate === 0, JSON.stringify(q.roles.builder));
  assert.equal(q.god_eye.intent.approve, q.god_eye.intent.verdicts, 'God Eye approved the contract; its verdict is logged with the agent_run');
  assert.equal(q.god_eye.intent.revise_rate, 0);
  assert.deepEqual(q.lanes.code, { raised: 1, verified: 1, refuted: 1, unverified: 0, refute_rate: 1, unverified_rate: 0 }, 'the finding-verifier refuted the one code finding');
  assert.deepEqual(q.parks, {});
  const md = spawnSync('node', [F.BIN, 'telemetry', 'report', '--format', 'md'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } }).stdout;
  assert.match(md, /## Quality signals[\s\S]*\| builder \|[\s\S]*\| code \| 1 \| 1 \| 1 \| 1 \|[\s\S]*\| intent \|/);
});

test('tool permissions follow the tools: list of each agent; policy adds patterns or restores allow-all', () => {
  const dir = path.join(F.PLUGIN, 'agents');
  for (const f of fs.readdirSync(dir)) {
    const role = f.replace(/\.agent\.md$/, '');
    const tools = runner.agentTools(role);
    assert.ok(tools.length > 0, `${role}: tools read from its frontmatter`);
    const p = runner.toolPermissions(role, tools, {});
    const shell = tools.includes('execute');
    const write = tools.includes('edit');
    const web = tools.includes('web') || tools.includes('web_fetch');
    assert.equal(p.allow.includes('shell'), shell, `${role}: shell pre-approved iff execute`);
    assert.equal(p.deny.includes('shell'), !shell, `${role}: shell denied iff no execute`);
    assert.equal(p.allow.includes('write'), write, `${role}: write iff edit`);
    assert.equal(p.deny.includes('write'), !write, `${role}: write denied for read-only roles`);
    assert.equal(p.allow.includes('url'), web, `${role}: url iff web`);
    assert.equal(p.deny.includes('url'), !web);
    assert.ok(p.deny.includes('memory'));
    if (shell) assert.ok(p.deny.includes('shell(git push)') && p.deny.includes('shell(git push:*)'), `${role}: never pushes`);
    if (shell && !write) assert.ok(p.deny.includes('shell(git commit:*)') && p.deny.includes('shell(rm:*)'), `${role}: read-only shell can't change the repo`);
    for (const a of p.allow) assert.ok(!p.deny.includes(a), `${role}: ${a} is not both allowed and denied`);
    const args = runner.copilotArgs({ prompt: 'x', agentType: `factory:${role}`, root: '/r', flags: [], permissions: p });
    assert.ok(!args.includes('--allow-all-tools'));
    assert.deepEqual(args.filter((a) => a.startsWith('--allow-tool=')).length, p.allow.length);
  }
  const extra = runner.toolPermissions('builder', ['read', 'edit', 'execute'], { allow_tools: { builder: ['url(http://localhost:3000)'], '*': [] }, deny_tools: { '*': ['shell(docker:*)'] } });
  assert.ok(extra.allow.includes('url(http://localhost:3000)') && extra.deny.includes('shell(docker:*)'));
  const legacy = runner.toolPermissions('judge', ['read'], { permissions: 'allow-all' });
  const largs = runner.copilotArgs({ prompt: 'x', agentType: 'factory:judge', root: '/r', flags: [], permissions: legacy });
  assert.ok(largs.includes('--allow-all-tools'), 'policy.copilot.permissions "allow-all" is the old behaviour');
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

test('inside a factory run agent (FACTORY_RUNNER=1) the CLI refuses driving and human-only commands', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const asAgent = (args) => {
    const r = spawnSync('node', [F.BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '', FACTORY_RUNNER: '1' } });
    let out;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      out = { raw: r.stdout };
    }
    return Object.assign(out, { __code: r.status });
  };
  for (const args of [['next'], ['run', 'ground'], ['record', '--file', 'x.json'], ['wfargs', 'ground'], ['ship', '--local'], ['close'], ['init'], ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low'], ['amend', 'start'], ['park', '--reason', 'r'], ['followup'], ['epic', 'spawn'], ['distill', 'done'], ['evidence', 'add', 'AC-1', '--type', 'doc'], ['verify', 'run'], ['approve'], ['deny', 'no'], ['resume'], ['cancel'], ['abandon'], ['waive', 'ci_reverify', 'x'], ['merged', 'abc1234'], ['confirm', 'AC-1'], ['reseal'], ['lessons', 'accept', 'L1'], ['ci', 'install'], ['doctor']]) {
    const r = asAgent(args);
    assert.equal(r.code, 'agent_not_allowed', `${args.join(' ')}: ${JSON.stringify(r)}`);
    assert.equal(r.__code, 1);
  }
  const st = F.cli(root, ['job', 'show']);
  assert.equal(st.last_decision_id, undefined, 'next did not run');
  assert.equal(st.status, 'active', 'park did not run');
  for (const args of [['help'], ['why'], ['job', 'show'], ['job', 'list'], ['contract', 'check'], ['contract', 'show'], ['plan', 'validate'], ['lessons', 'list'], ['doc', 'list'], ['telemetry', 'report'], ['task', 'show', 'T1']]) {
    const r = asAgent(args);
    assert.notEqual(r.code, 'agent_not_allowed', `${args.join(' ')} is allowed: ${JSON.stringify(r)}`);
  }
  assert.ok(events(root).some((e) => e.event === 'cli' && e.cmd === 'next' && e.code === 'agent_not_allowed'), 'refusals are logged');
  assert.ok(J);
});

// --- factory distill write --------------------------------------------------------------------

test('distill write: runs the lesson-writer through copilot -p like factory run, and reports the lessons it recorded', () => {
  const root = F.makeRepo();
  const policy = { agents: { models: { 'lesson-writer': 'haiku' } } };
  const J = newJob(root, policy);
  const env = (h) => ({ ...process.env, FACTORY_ROOT: '', COPILOT_BIN: FAKE, FAKE_COPILOT_SCRIPT: h.file, FAKE_COPILOT_LOG: h.logFile });
  // The fake lesson-writer runs the exact `lessons add` command its prompt gives (as an agent:
  // FACTORY_RUNNER=1 reaches it), then replies with the JSON the run asks for.
  const script = `module.exports = (call) => {
    const { execSync } = require('child_process');
    const line = call.instructions.split('\\n').find((l) => /lessons add --job/.test(l)).trim();
    const cmd = line.replace('"<lesson>"', '"In src/**, check argument types before use."').replace('"<glob>,<glob>"', '"src/**"').replace('"<finding id: what went wrong>"', '"code-1: add trusted its inputs"');
    const out = JSON.parse(execSync(cmd, { encoding: 'utf8', env: { ...process.env } }));
    return { lessons: [{ id: out.id, text: out.text }, { id: 'L9', text: 'never recorded' }] };
  };`;
  const h = harness(script);
  h.logFile = path.join(path.dirname(h.file), 'copilot.jsonl');
  const run = (extra = {}) => {
    const r = spawnSync('node', [F.BIN, 'distill', 'write'], { cwd: root, encoding: 'utf8', env: { ...env(h), ...extra }, timeout: 120000 });
    return Object.assign(JSON.parse(r.stdout), { __stderr: r.stderr });
  };
  // only when factory next asked for distill
  assert.equal(run().code, 'not_waiting_for_distill');
  const job = require('../cli/core/job');
  const decisions = require('../cli/core/decisions');
  const ledger = require('../cli/core/ledger');
  decisions.write(root, { id: 'D-distill-1', job: J, action: 'skill', skill: 'distill', step: 'distill' });
  const s = job.load(root, J);
  s.last_decision_id = 'D-distill-1';
  job.save(root, s);
  // nothing to learn from: no agent
  let r = run();
  assert.equal(r.skipped, true);
  assert.equal(h.log().length, 0);
  // a confirmed finding: the agent runs, records its lesson through the CLI
  ledger.append(root, J, { kind: 'step', step: 'challenge', ok: true, bound: {}, detail: { round: 1, findings: [{ id: 'code-1', status: 'confirmed', severity: 'major', file: 'src/add.js', summary: 'add trusts its inputs' }] } });
  r = run();
  assert.equal(r.outcome, 'ok', JSON.stringify(r));
  assert.deepEqual(r.lessons.map((l) => [l.id, l.text, l.scope, l.why]), [['L1', 'In src/**, check argument types before use.', ['src/**'], 'code-1: add trusted its inputs']]);
  assert.deepEqual(r.unrecorded, ['L9'], 'a lesson the agent claims but never recorded is called out');
  assert.match(r.message, /accept lesson Ln/);
  const [call] = h.log();
  assert.equal(call.agent, 'factory:lesson-writer');
  assert.equal(call.model, 'claude-haiku-5.5', 'policy.agents.models → model_ids, as in factory run');
  for (const f of ['--output-format', '-s', '--no-ask-user', '--session-id']) assert.ok(call.argv.includes(f), f);
  assert.ok(!call.argv.includes('--allow-all-tools'));
  const dirs = call.argv.filter((a, i) => call.argv[i - 1] === '--add-dir');
  assert.ok(dirs.includes(path.resolve(F.PLUGIN)), 'the plugin root, as in factory run');
  assert.equal(dirs.length, 2, 'the project and the plugin');
  assert.equal(call.env.FACTORY_RUNNER, '1');
  assert.equal(call.env.FACTORY_AGENT_ROLE, 'lesson-writer');
  const ev = events(root);
  assert.ok(ev.some((e) => e.event === 'agent_run' && e.agent_type === 'factory:lesson-writer' && e.decision_id === 'D-distill-1'));
  const dw = ev.filter((e) => e.event === 'distill_write');
  assert.deepEqual(dw.map((e) => e.outcome), ['skipped', 'ok']);
  assert.deepEqual(dw[1].lessons, ['L1']);
  // the Learn bank's step list: one run, one step, the lesson-writer in it
  const wf = ev.filter((e) => /^workflow_/.test(e.event));
  assert.deepEqual(wf.map((e) => [e.event, e.workflow, e.text || e.outcome || null]), [['workflow_start', 'distill', null], ['workflow_phase', 'distill', 'distill: write lessons'], ['workflow_end', 'distill', 'ok']], 'skipped distills start no run');
  const lr = require('../cli/core/console').build(root, { job: J }).jobs[0].runs[0];
  assert.deepEqual([lr.workflow, lr.stage, lr.status, lr.steps[0].label, lr.steps[0].roles[0].role], ['distill', 'learn', 'done', 'write lessons', 'lesson-writer']);
  // the lesson is proposed, for the human
  assert.equal(F.cli(root, ['lessons', 'list']).lessons[0].status, 'proposed');
  // Copilot missing: a clear error, nothing recorded
  const missing = run({ COPILOT_BIN: path.join(os.tmpdir(), 'no-such-copilot-bin') });
  assert.equal(missing.code, 'copilot_unavailable');
});

test('telemetry quality: correction turns, null results and park reasons are counted per role and rule', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const ev = require('../cli/core/events');
  ev.append(root, { event: 'agent_run', job: J, role: 'judge', agent_type: 'factory:judge', outcome: 'ok', retry: true });
  ev.append(root, { event: 'agent_run', job: J, role: 'judge', agent_type: 'factory:judge', outcome: 'invalid', retry: true });
  ev.append(root, { event: 'agent_run', job: J, role: 'judge', agent_type: 'factory:judge', outcome: 'ok', retry: false });
  ev.append(root, { event: 'agent_run', job: J, role: 'god-eye', label: 'god-eye · design #1', outcome: 'ok', verdict: 'revise' });
  ev.append(root, { event: 'agent_run', job: J, role: 'god-eye', label: 'god-eye · design #2', outcome: 'ok', verdict: 'approve' });
  ev.append(root, { event: 'agent_run', job: 'J-9999', role: 'judge', outcome: 'failed' }); // another job, not in the window's jobs
  require('../cli/core/decisions').write(root, { id: `${J}-D9`, job: J, action: 'parked', rule: 'cap.review_rounds', reason: 'Review rounds exhausted' });
  const q = F.cli(root, ['telemetry', 'report']).quality;
  assert.deepEqual(q.roles.judge, { runs: 3, correction_turns: 2, null_results: 1, outcomes: { ok: 2, invalid: 1 }, correction_turn_rate: 0.67, null_result_rate: 0.33 });
  assert.deepEqual(q.god_eye.design, { verdicts: 2, approve: 1, revise: 1, revise_rate: 0.5 });
  assert.deepEqual(q.parks['cap.review_rounds'], { parks: 1, jobs: [J], example: 'Review rounds exhausted' });
});
