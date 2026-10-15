'use strict';
// Clarify v2, review fixes: numbered chat replies that must not settle the wrong issue, the
// contract editor that must not drop criteria silently, a revision the CLI refuses that God
// Eye approved, revisions that are not progress, dedup that folds issues differing in one
// telling word (and its undo, factory clarify split), the ceiling for pre-v2 jobs, and what
// clarify status shows about migrated answers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const J2 = require('./helpers/j0002');
const clarify = require('../cli/core/clarify');
const intent = require('../cli/core/intent');
const guardRules = require('../hooks/guard-rules');

const APPROVE = { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, checklist: { intent_clear: true, scope_bounded: true, acs_testable: true, no_open_blockers: true, constraints_consistent: true }, items: [], researchable_questions: [] };

function newJob(root, { risk = 'medium', policy } = {}) {
  if (policy) fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify(policy));
  const J = F.cli(root, ['job', 'new', '--title', 'Nautobot interface VLAN sync', '--type', 'feature', '--risk', risk]).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), J2.CONTRACT);
  return J;
}
function round(root, data, status = 'needs_user') {
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  return F.record(root, F.envelope(b, status, { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, ...data }));
}
const issue = (id, text, kind, extra = {}) => ({ id, text, kind, impact: 'high', draft: text, research: kind === 'repo' ? 'repo' : kind === 'world' ? 'web' : 'none', evidence: [], assumption: null, question_id: null, answer: null, note: null, researched: false, source: 'mapper', round: 1, ...extra });
const scoutData = (unknowns, extra = {}) => ({ ran: true, round: 1, web: { enabled: true, available: true }, map: { ran: true, ok: true }, unknowns, evidence: [], assumptions: [], versions: [], scouts: [], verifiers: 0, degraded: [], ...extra });
const ledgerOf = (root, J) => intent.load(root, J);
const hook = (name, input, event) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', name), ...(event ? [event] : [])], { input: JSON.stringify(input), encoding: 'utf8' });
const say = (root, prompt, ts = Date.now()) => hook('prompt.js', { prompt, cwd: root, sessionId: 's', timestamp: ts }, 'userPromptSubmitted');
const contractOf = (root, J) => fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8');
const user = (id, text, extra = {}) => ({ ...issue(id, text, 'user'), owner: 'user', status: 'proposed', ...extra });

// ---------------------------------------------------------------- numbered chat replies
test('numbered replies: "Q-n" names the question itself, not its place in the list', () => {
  assert.deepEqual(clarify.parseNumbered('Q-4 no, Q-3 yes').items.map((x) => [x.q, x.text]), [['Q-4', 'no'], ['Q-3', 'yes']]);
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  round(root, { scout: scoutData([user('U-1', 'Should the sync prune VLANs not in Nautobot?', { default: 'yes' }), user('U-2', 'Is a dry run required before the first live run?', { default: 'yes' })]) });
  F.cli(root, ['answer', 'Q-1', 'yes']);
  F.cli(root, ['answer', 'Q-2', 'yes']);
  F.cli(root, ['next']);
  round(root, { scout: scoutData([...ledgerOf(root, J).unknowns, user('U-3', 'Which device roles are in scope for the sync?', { default: 'leaf only', round: 2 }), user('U-4', 'Who approves the first production run?', { default: 'the operations lead', round: 2 })]) });
  const set = clarify.questionSet(require('../cli/core/job').load(root, J)).map((q) => q.id);
  assert.deepEqual(set, ['Q-3', 'Q-4']);
  const out = say(root, 'Q-4 the change board');
  assert.match(JSON.parse(out.stdout).additionalContext, /Q-4 → the change board/);
  const d = ledgerOf(root, J);
  assert.equal(d.unknowns.find((u) => u.question_id === 'Q-4').answer, 'the change board');
  assert.equal(d.unknowns.find((u) => u.question_id === 'Q-3').status, 'proposed', 'Q-3 untouched');
});

test('numbered replies: ordinary messages are left alone; nothing already settled is overwritten by a pasted list', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  round(root, { scout: scoutData([user('U-1', 'Should the sync prune VLANs not in Nautobot?', { default: 'yes' }), user('U-2', 'Is a dry run required before the first live run?', { default: 'yes' }), user('U-3', 'Which device roles are in scope for the sync?', { default: 'leaf only' })]) });
  // a question to the agent is not an answer
  assert.equal(say(root, '3 tests are failing, can you look?').stdout, '');
  // a number no question has: not an answer set at all
  assert.equal(say(root, '10 minutes later it failed again').stdout, '');
  let d = ledgerOf(root, J);
  assert.ok(d.unknowns.every((u) => u.status === 'proposed'), 'nothing was settled');
  // a real answer
  assert.match(JSON.parse(say(root, '1 yes').stdout).additionalContext, /Recorded 1 answer/);
  // a pasted list over a question already answered: refused loudly, nothing changed
  const out = say(root, '1. Must support trunk ports\n2. Must not touch access ports');
  assert.match(JSON.parse(out.stdout).additionalContext, /NOT recorded.*already settled/);
  d = ledgerOf(root, J);
  assert.equal(d.unknowns.find((u) => u.question_id === 'Q-1').answer, 'yes');
  assert.equal(d.unknowns.find((u) => u.question_id === 'Q-2').status, 'proposed', 'all or nothing: Q-2 was not settled either');
  // the same number twice
  assert.match(JSON.parse(say(root, '2 yes, 2 no').stdout).additionalContext, /NOT recorded/);
});

