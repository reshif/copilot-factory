'use strict';
// Decision table rows, caps, the repeat guard, resume, drift and amendments.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');

const next = (root) => F.cli(root, ['next']);

function toProve(root, { policyChecks } = {}) {
  if (policyChecks) fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ checks: policyChecks }));
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  next(root);
  F.reply(root, 'approve');
  next(root);
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 't', claims: [], unknowns: [] }], degraded: [] }));
  next(root);
  F.cli(root, ['plan', 'from-contract']);
  next(root);
  b = F.cli(root, ['wfargs', 'realize']);
  const s = F.cli(root, ['task', 'start', 'T1']);
  F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
  F.sh(s.worktree, 'git commit -qam fix');
  F.cli(root, ['task', 'verify', 'T1']);
  F.record(root, F.envelope(b, 'ok', { tasks: [{ id: 'T1', outcome: 'done', attempts: 1 }] }));
  next(root);
  b = F.cli(root, ['wfargs', 'reconcile']);
  F.cli(root, ['reconcile', 'run']);
  F.record(root, F.envelope(b, 'ok', { integrator: { status: 'merged', summary: '' } }));
  return { J, worktree: s.worktree };
}

test('row 5: a failing proof opens a verify-fix round; the cap parks; resume allows one more', () => {
  const root = F.makeRepo();
  const { J } = toProve(root, { policyChecks: ['test -f POLICY_OK'] });
  assert.match(next(root).command, /verify run/);
  const pv = F.cli(root, ['verify', 'run']);
  assert.equal(pv.ok, false);
  let n = next(root);
  assert.equal(n.rule, 'row5.acs_unproven');
  assert.equal(n.scope, 'verifyFix');
  // the next call does not count another round for the same failed proof
  n = next(root);
  assert.equal(n.workflow, 'realize');
  assert.equal(F.cli(root, ['job', 'show']).counters.verify_fix_rounds, 1);
  // three more failing rounds hit the cap (3) and park
  for (let i = 0; i < 3; i++) {
    const s = F.cli(root, ['task', 'start', 'T1']);
    F.write(s.worktree, 'src/add.js', `module.exports = (a, b) => a + b; // try ${i}\n`);
    F.sh(s.worktree, 'git commit -qam retry');
    F.cli(root, ['task', 'verify', 'T1']);
    F.cli(root, ['reconcile', 'run']);
    const b = F.cli(root, ['wfargs', 'reconcile']);
    F.record(root, F.envelope(b, 'ok', { integrator: { status: 'merged', summary: '' } }));
    F.cli(root, ['verify', 'run']);
    n = next(root);
  }
  assert.equal(n.action, 'parked');
  assert.equal(n.rule, 'cap.verify_fix_rounds');
  assert.equal(next(root).action, 'parked');
  assert.match(F.reply(root, 'resume').message, /one more verify round/);
  n = next(root);
  assert.equal(n.scope, 'verifyFix');
  assert.ok(F.cli(root, ['why']).decisions.some((d) => d.rule === 'cap.verify_fix_rounds'));
});

test('repeat guard: the same step from the same state three times parks', () => {
  const root = F.makeRepo();
  toProve(root);
  F.cli(root, ['verify', 'run']);
  let n = next(root);
  assert.equal(n.config, 'challenge');
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  // the workflow errors twice: nothing changes, so the router stops instead of looping
  F.record(root, F.envelope(b, 'error', {}));
  n = next(root);
  assert.equal(n.config, 'challenge');
  F.record(root, F.envelope(b, 'error', {}));
  n = next(root);
  assert.equal(n.action, 'parked');
  assert.equal(n.rule, 'cap.repeat_guard');
});

test('row 2: editing an approved contract routes to an amendment; approval re-binds and reopens only affected tasks', () => {
  const root = F.makeRepo();
  const { J } = toProve(root);
  F.cli(root, ['verify', 'run']);
  const cfile = path.join(F.jobDir(root, J), 'contract.md');
  fs.writeFileSync(cfile, fs.readFileSync(cfile, 'utf8').replace('add(2, 3) returns 5', 'add(2, 3) returns 5 and add(-1, 1) returns 0'));
  let n = next(root);
  assert.equal(n.skill, 'amend');
  assert.equal(n.rule, 'row2.drift_contract');
  assert.equal(F.cli(root, ['amend', 'start', '--reason', 'negatives too', '--by', 'PM']).amendment, 'A-1');
  const sub = F.cli(root, ['amend', 'submit']);
  assert.deepEqual(sub.amendment.changed_criteria, [{ id: 'AC-1', change: 'changed' }]);
  n = next(root);
  assert.equal(n.action, 'gate');
  assert.equal(n.step, 'A');
  F.reply(root, 'approve');
  const state = F.cli(root, ['job', 'show']);
  assert.equal(state.approvals.H1.rebound_by, 'A-1');
  assert.equal(state.tasks.T1.needs_work, 'amendment');
  n = next(root);
  assert.equal(n.workflow, 'realize');
  assert.equal(n.scope, 'amendment');
  assert.ok(!F.cli(root, ['why']).decisions.some((d) => d.chosen === 'clarify' && d.ts > state.amendment.applied_at), 'no re-clarify after an approved amendment');
});

test('row 2: files outside the allowed paths on the job branch park the job', () => {
  const root = F.makeRepo();
  const { J } = toProve(root);
  // someone commits straight onto the job branch outside the plan's paths
  const wt = path.join(root, '.factory', 'worktrees', J);
  F.write(wt, 'docs/notes.md', 'x\n');
  F.sh(wt, 'git add -A && git commit -qm sneaky');
  const n = next(root);
  assert.equal(n.action, 'parked');
  assert.equal(n.rule, 'row2.drift_scope');
  assert.match(n.reason, /docs\/notes\.md/);
});

test('review rounds cap parks with confirmed findings still open', () => {
  const root = F.makeRepo();
  toProve(root);
  F.cli(root, ['verify', 'run']);
  let n;
  for (let round = 1; round <= 4; round++) {
    n = next(root);
    if (n.action === 'parked') break;
    if (n.workflow === 'realize') {
      const s = F.cli(root, ['task', 'start', 'T1']);
      F.write(s.worktree, 'src/add.js', `module.exports = (a, b) => a + b; // r${round}\n`);
      F.sh(s.worktree, 'git commit -qam r');
      F.cli(root, ['task', 'verify', 'T1']);
      F.cli(root, ['reconcile', 'run']);
      const b = F.cli(root, ['wfargs', 'reconcile']);
      F.record(root, F.envelope(b, 'ok', { integrator: { status: 'merged', summary: '' } }));
      F.cli(root, ['verify', 'run']);
      n = next(root);
    }
    assert.equal(n.config, 'challenge');
    const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
    F.record(root, F.envelope(b, 'ok', { lanes: [{ lane: 'code', findings: [{ id: `code-${round}`, severity: 'blocker', file: 'src/add.js', line: 1, summary: `Problem ${round} in changed code` }] }], degraded: [], verifications: [{ finding_id: `code-${round}`, status: 'confirmed', reason: 'reproduced' }] }, { fingerprint: b.fingerprint }));
  }
  n = next(root);
  assert.equal(n.action, 'parked');
  assert.equal(n.rule, 'cap.review_rounds');
});

test('convergence: from round 2 a new major on unchanged code becomes minor', () => {
  const root = F.makeRepo();
  toProve(root);
  F.cli(root, ['verify', 'run']);
  next(root);
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  F.record(root, F.envelope(b, 'ok', { lanes: [{ lane: 'code', findings: [{ id: 'code-1', severity: 'major', file: 'src/add.js', summary: 'A' }] }], degraded: [], verifications: [{ finding_id: 'code-1', status: 'confirmed', reason: 'yes' }] }, { fingerprint: b.fingerprint }));
  next(root);
  const s = F.cli(root, ['task', 'start', 'T1']);
  F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a + b; // fixed A\n');
  F.sh(s.worktree, 'git commit -qam fixA');
  F.cli(root, ['task', 'verify', 'T1']);
  F.cli(root, ['reconcile', 'run']);
  b = F.cli(root, ['wfargs', 'reconcile']);
  F.record(root, F.envelope(b, 'ok', { integrator: { status: 'merged', summary: '' } }));
  F.cli(root, ['verify', 'run']);
  next(root);
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  const r = F.record(root, F.envelope(b, 'ok', { lanes: [{ lane: 'code', findings: [{ id: 'code-7', severity: 'major', file: 'tests/add.test.js', summary: 'New complaint about untouched test file' }] }], degraded: [], verifications: [] }, { fingerprint: b.fingerprint }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.minor, 1);
});

test('stale results are refused: a contract edited while clarify ran', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  fs.appendFileSync(path.join(F.jobDir(root, J), 'contract.md'), '\n- extra assumption\n');
  const r = F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  assert.equal(r.status, 'stale');
});

test('budget cap parks; resume raises the cap by half', () => {
  const root = F.makeRepo();
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ limits: { max_agent_runs_per_job: 5 } }));
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  const env = F.envelope(b, 'needs_user', { analysts: [], degraded: [], judge: { questions: [{ question: 'q?', why: 'w' }], dismissed: [] }, critique: null });
  env.budgets.used.agent_runs = 9;
  F.record(root, env);
  const n = next(root);
  assert.equal(n.action, 'parked');
  assert.equal(n.rule, 'cap.budget');
  F.reply(root, 'resume');
  assert.equal(F.cli(root, ['job', 'show']).policy.limits.max_agent_runs_per_job, 8);
});

test('human-only actions refuse the agent path', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  const r = F.cli(root, ['approve']);
  assert.equal(r.code, 'human_only');
  assert.equal(F.cli(root, ['resume']).code, 'human_only');
  assert.equal(F.cli(root, ['waive', 'ci_reverify', '--reason', 'x']).code, 'human_only');
  // chat replies that are not exact commands are ignored
  const human = require('../cli/core/human');
  assert.equal(human.parseReply('looks good to me, approve it'), null);
  assert.equal(human.parseReply('approve\nand more'), null);
  assert.deepEqual(human.parseReply('approve J-0001 H1'), { cmd: 'approve', jobId: 'J-0001', gate: 'H1' });
  assert.equal(human.parseReply('deny add negatives').reason, 'add negatives');
  // tone is tolerated, sentences are not
  for (const t of ['Approve!', 'approve 👍', 'approve.', 'APPROVE 👍🏽']) assert.deepEqual(human.parseReply(t), { cmd: 'approve', jobId: undefined, gate: undefined }, t);
  assert.deepEqual(human.parseReply('approve j-0001 h1!'), { cmd: 'approve', jobId: 'J-0001', gate: 'H1' });
  assert.equal(human.parseReply('merged abc1234.').commit, 'abc1234');
  assert.equal(human.parseReply('approve the plan please'), null);
  // near misses are recognised (to say "not applied"), never parsed
  for (const t of ['aprove', 'approve the plan please', 'cancel', 'Approved!', 'merge it']) assert.ok(human.nearMiss(t), t);
  for (const t of ['please continue', 'approve', 'what does the approve gate check in this repo for us today', 'hello']) assert.equal(human.nearMiss(t), null, t);
});

test('an open GitHub PR alternates sync and wait instead of busy-looping', () => {
  const root = F.makeRepo();
  const { J } = toProve(root);
  F.cli(root, ['verify', 'run']);
  F.cli(root, ['next']);
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  F.record(root, F.envelope(b, 'ok', { lanes: [{ lane: 'code', findings: [] }], degraded: [], verifications: [] }, { fingerprint: b.fingerprint }));
  F.cli(root, ['next']);
  assert.equal(F.cli(root, ['ship', '--local']).mode, 'local');
  // pretend it went to GitHub (as the CLI would have recorded it)
  const job = require('../cli/core/job');
  const s = job.load(root, J);
  s.pr = { ...s.pr, mode: 'github', url: 'https://github.com/x/y/pull/1' };
  job.save(root, s);
  const a = next(root);
  assert.equal(a.action, 'cli');
  assert.match(a.command, /pr sync/);
  const w = next(root);
  assert.equal(w.action, 'wait');
  assert.match(w.reason, /still open/);
  assert.equal(next(root).action, 'cli', 'after "continue", it syncs again');
});

test('a deny reason reaches the agents who redo the work', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  assert.equal(next(root).step, 'H1');
  F.reply(root, 'deny cover negative numbers too');
  const cfile = path.join(F.jobDir(root, J), 'contract.md');
  fs.writeFileSync(cfile, fs.readFileSync(cfile, 'utf8').replace('(evidence: test)', '(evidence: test)\n- AC-2: add(-1, 1) returns 0 (evidence: test)'));
  assert.equal(next(root).skill, 'clarify');
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  const file = b.fanout[0].prompt.split('\n')[1].trim();
  assert.match(fs.readFileSync(file, 'utf8'), /At H1 the human said: cover negative numbers too/);
  assert.equal(b.fanout[0].role, 'intent-analyst');
});

test('deny needs a reason; after deny the producing step runs again before the gate is shown again', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  const clarify = () => {
    const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
    return F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  };
  next(root);
  clarify();
  const g = next(root);
  assert.equal(g.step, 'H1');
  // a bare "deny" is refused (nothing is denied); "deny: <reason>" is a reply
  assert.throws(() => F.reply(root, 'deny'), (e) => e.code === 'needs_reason' && /deny <what must change>/.test(e.message));
  assert.equal(F.cli(root, ['job', 'show']).denials.length, 0);
  assert.equal(require('../cli/core/human').parseReply('deny: too big').reason, 'too big');
  F.reply(root, 'deny: cover negative numbers too');
  // the contract is unchanged, but the gate isn't shown again: clarify runs with the reason
  let n = next(root);
  assert.equal(n.action, 'skill');
  assert.equal(n.skill, 'clarify');
  assert.equal(n.rule, 'gate.denied_revise');
  assert.match(n.reason, /You denied H1: "cover negative numbers too"/);
  assert.equal(n.denied.gate, 'H1');
  assert.equal(F.cli(root, ['job', 'show']).pending_gate, null, 'the gate is no longer pending while it is revised');
  // once clarify has run again, the gate is presented again (even if the document came out the same)
  clarify();
  n = next(root);
  assert.equal(n.action, 'gate');
  assert.equal(n.gate.hash, g.gate.hash);
  assert.match(F.reply(root, 'approve').message, /Approved H1/);
});

test('factory next is a query: asked again with nothing tried, it returns the same decision and never parks', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  const first = next(root);
  assert.equal(first.skill, 'clarify');
  for (let i = 0; i < 4; i++) {
    const n = next(root);
    assert.equal(n.action, 'skill', JSON.stringify(n));
    assert.equal(n.decision_id, first.decision_id, 'no new decision');
    assert.equal(n.requery, true);
  }
  assert.equal(F.cli(root, ['why']).decisions.filter((d) => d.rule !== 'human').length, 1, 'one decision written');
  assert.equal(F.cli(root, ['job', 'show']).repeat.count, 1, 'no repeat counted');
  // looking around (why, contract check, job show) is not an attempt either
  F.cli(root, ['contract', 'check']);
  assert.equal(next(root).decision_id, first.decision_id);
  // a step that was tried is: the next decision is a new one
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  const after = next(root);
  assert.notEqual(after.decision_id, first.decision_id);
  assert.equal(after.step, 'H1');
});

test('gate A refuses if the contract changed after the amendment was submitted', () => {
  const root = F.makeRepo();
  const { J } = toProve(root);
  const cfile = path.join(F.jobDir(root, J), 'contract.md');
  F.cli(root, ['amend', 'start', '--reason', 'r']);
  fs.writeFileSync(cfile, fs.readFileSync(cfile, 'utf8').replace('add(2, 3) returns 5', 'add(2, 3) returns 5 exactly'));
  F.cli(root, ['amend', 'submit']);
  assert.equal(next(root).step, 'A');
  fs.appendFileSync(cfile, '\n- sneaky extra assumption\n');
  assert.throws(() => F.reply(root, 'approve'), /changed after the amendment was submitted/);
  assert.equal(F.cli(root, ['amend', 'submit']).job, J, 'resubmitting is allowed');
  next(root);
  assert.match(F.reply(root, 'approve').message, /Approved A/);
});

test('go on without a failed analyst: --accept-degraded runs the critique anyway', async () => {
  const H = require('./helpers/workflow-harness');
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  const brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify', '--accept-degraded']);
  assert.equal(brief.accept_degraded, true);
  const { result } = await H.run(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), brief, (prompt, opts) => {
    const file = fs.readFileSync(prompt.split('\n')[1].trim(), 'utf8');
    if (/Your focus: \*\*testability/.test(file)) return null;
    if (opts.agentType === 'factory:intent-analyst') return { focus: 'x', questions: [] };
    if (opts.agentType === 'factory:judge') return { questions: [], dismissed: [] };
    return { verdict: 'approve', items: [] };
  });
  assert.deepEqual(result.data.degraded, ['intent-analyst:testability']);
  assert.equal(result.status, 'ok');
  assert.equal(F.record(root, result).status, 'ok');
});

test('clarify protocol through the CLI: intent questions first with ids, answers by id, park when intent stays unclear, resume', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  const iq = (q) => ({ question: q, category: 'intent', why: 'w', default: 'd' });
  const round = (qs) => {
    const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
    return F.record(root, F.envelope(b, 'needs_user', { analysts: [], degraded: [], judge: { questions: qs, dismissed: [] }, critique: null }));
  };
  // round 1: a judge that ignores the protocol is corrected by record
  let r = round([{ question: 'Which DB?', category: 'constraint', why: 'w', default: 'pg' }, iq('Who is it for?')]);
  assert.equal(r.status, 'needs_user');
  assert.equal(r.intent_first, true);
  assert.equal(r.held, 1);
  assert.deepEqual(r.questions.map((q) => [q.id, q.category]), [['Q-1', 'intent']]);
  assert.equal(F.cli(root, ['answer', '--id', 'Q-1', '--answer', 'ops on call']).id, 'Q-1');
  assert.equal(F.cli(root, ['answer', '--id', 'Q-9', '--answer', 'x']).code, 'bad_input');
  // round 2: the answered question is never re-asked; a new intent question is
  r = round([iq('Who is it for?'), iq('What does done look like?')]);
  assert.deepEqual(r.questions.map((q) => q.id), ['Q-2']);
  // round 3: intent still unclear after 2 intent rounds → park, nothing assumed
  r = round([iq('Why now?')]);
  assert.equal(r.status, 'park');
  assert.equal(next(root).action, 'parked');
  assert.match(F.cli(root, ['job', 'show']).park.reason, /intent is still unclear.*Why now\?/);
  // resume: one more intent round, with a budget
  F.reply(root, 'resume');
  assert.equal(next(root).skill, 'clarify');
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.equal(b.limits.max_questions, 3);
  assert.deepEqual(b.asked.slice().sort(), ['What does done look like?', 'Who is it for?']);
  r = F.record(root, F.envelope(b, 'needs_user', { analysts: [], degraded: [], judge: { questions: [iq('Why now?')], dismissed: [] }, critique: null }));
  assert.deepEqual(r.questions.map((q) => q.id), ['Q-3']);
  assert.deepEqual(F.cli(root, ['job', 'show']).question_log.map((q) => q.id), ['Q-1', 'Q-2', 'Q-3']);
});

test('clarify: God Eye must confirm the intent; contract check names the Intent section', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  let c = F.cli(root, ['contract', 'check']);
  assert.ok(c.problems.includes('Intent: Problem is missing or still a placeholder'));
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText({ intent: null }));
  c = F.cli(root, ['contract', 'check']);
  assert.match(c.problems.join('\n'), /No "## Intent" section/);
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  let r = F.record(root, F.envelope(b, 'needs_user', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', intent_confirmed: false, restatement: { problem: 'p', outcome: 'o' }, items: [] } }));
  assert.equal(r.status, 'needs_user');
  assert.match(r.message, /could not confirm the intent/);
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  r = F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, items: [] } }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.restatement, { problem: 'p', outcome: 'o' });
  // a follow-up contract carries an Intent section the check understands
  F.write(root, '.factory/scratch/findings.json', JSON.stringify([{ summary: 'add overflows', file: 'src/add.js' }]));
  const fu = F.cli(root, ['followup', '--findings-file', path.join(root, '.factory', 'scratch', 'findings.json')]).followup;
  const text = fs.readFileSync(path.join(F.jobDir(root, fu), 'contract.md'), 'utf8');
  assert.match(text, /## Intent\n- Problem: Confirmed after J-\d+ merged: add overflows/);
  F.cli(root, ['use', fu]);
  assert.deepEqual(F.cli(root, ['contract', 'check']).problems.filter((p) => /^Intent/.test(p)), ['Intent: Who is missing or still a placeholder'], 'only who is left to clarify');
});
