'use strict';
// The real chain: factory next → factory wfargs → workflow script (run by the harness with
// scripted agents that do what real agents would) → factory record. Proves the brief,
// the scripts and the envelope agree with each other.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');

const instructions = (prompt) => {
  const line = prompt.split('\n').find((l) => l.trim().startsWith('/'));
  return line ? fs.readFileSync(line.trim(), 'utf8') : prompt;
};

async function runWorkflow(root, next, agents) {
  const args = ['wfargs', next.workflow];
  if (next.config) args.push('--config', next.config);
  if (next.mode) args.push('--mode', next.mode);
  if (next.scope) args.push('--scope', next.scope);
  const brief = F.cli(root, args, { allowFail: false });
  // The brief must survive being passed as a string, the way the Workflow tool passes args.
  const { result } = await H.run(path.join(F.PLUGIN, 'workflows', `${next.workflow}.js`), JSON.stringify(brief), (prompt, opts) => agents(opts.agentType, instructions(prompt)));
  return F.record(root, result);
}

test('bug@low through the real workflow scripts', async () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());

  // Agents are told apart by the factory agent type the workflow started them as.
  const agents = (type, full) => {
    if (type === 'factory:intent-analyst') return { focus: 'x', questions: [] };
    if (type === 'factory:judge') return { questions: [], dismissed: [] };
    if (type === 'factory:god-eye') return { verdict: 'approve', items: [] };
    if (type === 'factory:researcher') return { topic: 'codebase', claims: [{ claim: 'add subtracts', source: 'src/add.js:1' }], unknowns: [] };
    if (type === 'factory:builder') {
      const s = F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
      F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
      F.sh(s.worktree, 'git commit -qam fix');
      return { status: 'done', summary: 'fixed', swept: ['src/add.js'] };
    }
    if (type === 'factory:tester') {
      const v = F.cli(root, ['task', 'verify', 'T1']);
      return { pass: v.pass, evidence_id: v.evidence_id, failures: v.failures.map((f) => f.cmd) };
    }
    if (type === 'factory:integrator') {
      const r = F.cli(root, ['reconcile', 'run']);
      return { status: r.status === 'merged' ? 'merged' : 'failed', summary: r.status };
    }
    if (type === 'factory:code-reviewer') return { lane: 'code', findings: [] };
    throw new Error(`unexpected agent ${type}: ${full.slice(0, 120)}`);
  };

  let n = F.cli(root, ['next']);
  assert.equal(n.skill, 'clarify');
  let r = await runWorkflow(root, { workflow: 'fanout-judge', config: 'clarify' }, agents);
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(F.cli(root, ['next']).step, 'H1');
  F.reply(root, 'approve');

  for (let guard = 0; guard < 20; guard++) {
    n = F.cli(root, ['next']);
    if (n.action === 'workflow') {
      r = await runWorkflow(root, n, agents);
      assert.ok(['ok'].includes(r.status), `${n.workflow}: ${JSON.stringify(r)}`);
    } else if (n.action === 'cli') {
      const out = F.cli(root, n.command.replace(/^factory /, '').split(' ').filter((x) => x && x !== '--job' && !/^J-\d+$/.test(x)));
      assert.ok(!out.error, `${n.command}: ${JSON.stringify(out)}`);
    } else if (n.action === 'skill' && n.skill === 'ship') {
      break;
    } else {
      assert.fail(`unexpected ${JSON.stringify(n)}`);
    }
  }
  assert.equal(n.skill, 'ship');
  const fin = F.cli(root, ['finalize', '--mode', 'before_ship']);
  assert.equal(fin.ok, true, JSON.stringify(fin.missing));
  const state = F.cli(root, ['job', 'show']);
  assert.ok(state.counters.agent_runs >= 8, 'agent runs are counted from envelopes');
  const steps = F.cli(root, ['why']).decisions.map((d) => d.chosen);
  for (const s of ['clarify', 'H1', 'ground', 'decompose', 'realize', 'reconcile', 'prove', 'challenge', 'ship']) assert.ok(steps.includes(s), `path includes ${s}`);
  // every workflow run left a sealed roster of the agents it started
  const ledger = fs.readFileSync(path.join(F.jobDir(root, F.cli(root, ['job', 'show']).id), 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const ran = ledger.filter((e) => e.kind === 'agents').flatMap((e) => e.agents.map((a) => a.agent_type));
  for (const t of ['factory:intent-analyst', 'factory:researcher', 'factory:builder', 'factory:tester', 'factory:integrator', 'factory:code-reviewer']) assert.ok(ran.includes(t), `roster names ${t}`);
  assert.equal(ran.length, state.counters.agent_runs, 'the roster matches the counted agent runs');
});
