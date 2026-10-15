'use strict';
// Outcome integrity (Phase 1 of the agent audit): no step may lose work or findings between
// agents. Each test reproduces a behaviour the audit observed, then pins the fix.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');

const REALIZE = path.join(F.PLUGIN, 'workflows', 'realize.js');

// A realize brief by hand: one task, the real agent types, no CLI behind it.
function realizeBrief(tasks = { T1: {} }) {
  const t = {};
  for (const [id, o] of Object.entries(tasks)) {
    t[id] = {
      id,
      worktree: `/tmp/none-${id}`,
      depends_on: o.depends_on || [],
      retry_limit: o.retry_limit || 3,
      builder: { agent_type: 'factory:builder', escalate: [] },
      tester: { agent_type: 'factory:tester' },
      builder_prompt: `build ${id} attempt {{attempt}}\n{{failures}}`,
      tester_prompt: `test ${id} {{swept}}`,
    };
  }
  return { workflow: 'realize', job: 'J-0001', scope: 'all', input_hash: 'h', waves: [Object.keys(tasks)], tasks: t, max_parallel_tasks: 4, builder_schema: {}, tester_schema: {} };
}

test('P1.4: no tester runs after a builder that returned nothing (crash, timeout, invalid reply)', async () => {
  let builds = 0;
  const { result, calls } = await H.run(REALIZE, realizeBrief(), (prompt, opts) => {
    if (opts.agentType === 'factory:builder') {
      builds += 1;
      return builds === 1 ? null : { status: 'done', summary: 'built', swept: [] };
    }
    return { pass: true, failures: [] };
  });
  const testers = calls.filter((c) => c.opts.agentType === 'factory:tester');
  assert.equal(testers.length, 1, 'only the attempt whose builder replied is tested');
  assert.equal(result.data.tasks[0].outcome, 'done');
  assert.equal(result.data.tasks[0].attempts, 2, 'the empty builder still used an attempt');
  const second = calls.filter((c) => c.opts.agentType === 'factory:builder')[1];
  assert.match(second.prompt, /builder returned no result/i, 'the next builder is told why attempt 1 failed');
  assert.equal(result.agents.filter((a) => a.agent_type === 'factory:tester').length, 1);
});

test('P1.4: a builder that never replies exhausts the task without a single tester run', async () => {
  const { result, calls } = await H.run(REALIZE, realizeBrief({ T1: { retry_limit: 2 } }), (prompt, opts) => (opts.agentType === 'factory:builder' ? null : { pass: true, failures: [] }));
  assert.equal(calls.filter((c) => c.opts.agentType === 'factory:tester').length, 0);
  assert.equal(result.data.tasks[0].outcome, 'exhausted');
  assert.match(result.data.tasks[0].summary, /builder returned no result/i);
  assert.equal(result.status, 'park');
});
