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

// ---------------------------------------------------------------- the contract editor
const editorEnv = (text, extra = {}) => ({ contract: { text, edits: [{ label: 'apply what was settled', ok: true, applied: [], skipped: [], removed: [], ...extra }] } });

test('contract editor: a revision that drops an acceptance criterion, a constraint or a non-goal without a recorded reason is refused', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  const before = contractOf(root, J);
  const noAc2 = J2.CONTRACT.replace(/- AC-2:[^\n]*\n/, '');
  let r = round(root, { scout: scoutData([user('U-1', 'Should the sync prune VLANs not in Nautobot?')]), ...editorEnv(noAc2) });
  assert.match(r.clarify.contract_revision.rejected, /AC-2/);
  assert.equal(contractOf(root, J).includes('AC-2:'), true, 'not written');
  assert.equal(contractOf(root, J).replace(/## Clarifications[\s\S]*?(?=\n## )/, ''), before.replace(/## Clarifications[\s\S]*?(?=\n## )/, ''));
  // a constraint gone, no reason
  F.cli(root, ['next']);
  r = round(root, { scout: scoutData(ledgerOf(root, J).unknowns), ...editorEnv(J2.CONTRACT.replace('- Runs from the existing automation container (Python 3.11)\n', '')) });
  assert.match(r.clarify.contract_revision.rejected, /Constraints/);
  // a non-goal gone, "justified" by an issue that is not settled
  F.cli(root, ['next']);
  r = round(root, { scout: scoutData(ledgerOf(root, J).unknowns), ...editorEnv(J2.CONTRACT.replace('- Access-port VLANs\n', ''), { removed: [{ ref: 'Non-goals', because: 'U-1', text: 'Access-port VLANs' }] }) });
  assert.match(r.clarify.contract_revision.rejected, /Non-goals/);
  // the user settled it: the removal names that issue and is written
  F.cli(root, ['answer', 'Q-1', 'yes, and drop AC-2: no dry run']);
  F.cli(root, ['next']);
  r = round(root, { scout: scoutData(ledgerOf(root, J).unknowns), ...editorEnv(noAc2, { applied: [{ ref: 'U-1', section: 'Acceptance criteria', change: 'AC-2 removed' }], removed: [{ ref: 'AC-2', because: 'U-1' }] }) });
  assert.equal(r.clarify.contract_revision.written, true, JSON.stringify(r.clarify.contract_revision));
  assert.ok(!/- AC-2:/.test(contractOf(root, J)));
  assert.deepEqual(r.clarify.contract_revision.removed, [{ ref: 'AC-2', because: 'U-1' }]);
});

test('contract editor: a removal God Eye asked for is justified by its item; a truncated revision is refused', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  const noAc2 = J2.CONTRACT.replace(/- AC-2:[^\n]*\n/, '');
  let r = round(root, { scout: scoutData([]), critique: APPROVE, contract: { text: noAc2, edits: [{ label: "God Eye's items", ok: true, requested: [{ from: 'god-eye', ref: 'AC-2' }], applied: [{ ref: 'AC-2', section: 'Acceptance criteria', change: 'removed: duplicate of AC-1' }], skipped: [], removed: [{ ref: 'AC-2', because: 'god-eye' }] }] } }, 'ok');
  assert.equal(r.clarify.contract_revision.written, true, JSON.stringify(r.clarify.contract_revision));
  // a reply cut off mid-contract
  const r2 = F.makeRepo();
  const J3 = newJob(r2);
  F.cli(r2, ['next']);
  r = round(r2, { scout: scoutData([]), critique: APPROVE, ...editorEnv(J2.CONTRACT.slice(0, J2.CONTRACT.indexOf('- AC-2'))) }, 'ok');
  assert.ok(r.clarify.contract_revision.rejected);
  assert.equal(contractOf(r2, J3).includes('- AC-2:'), true);
});

test('contract editor: when the CLI refuses the revision God Eye approved, the round is not ok (H1 never shows a text God Eye did not see)', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  const r = round(root, { scout: scoutData([]), critique: APPROVE, ...editorEnv(J2.CONTRACT.replace(/- AC-2:[^\n]*\n/, '')) }, 'ok');
  assert.notEqual(r.status, 'ok');
  assert.equal(r.status, 'revise');
  assert.match(r.message, /refused the contract editor's revision/);
  assert.notEqual(F.cli(root, ['next']).action, 'gate');
  assert.ok(J);
});

test('progress: a revision that changes nothing, or rewords without applying anything, is not progress; a gate denial goes to the editor once', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  const ge = { ...APPROVE, verdict: 'revise', items: [{ ref: 'Goal', severity: 'minor', issue: 'wordy' }] };
  // the same text back: written or not, it is not progress
  let r = round(root, { scout: scoutData([]), critique: ge, ...editorEnv(J2.CONTRACT) }, 'ok');
  assert.equal(r.clarify.round.revised, false);
  // a reworded goal that applies nothing it was asked for
  F.cli(root, ['next']);
  r = round(root, { scout: scoutData([]), critique: ge, ...editorEnv(J2.CONTRACT.replace('A sync job reads', 'A synchronisation job reads')) }, 'ok');
  assert.equal(r.clarify.round.revised, false);
  assert.equal(r.clarify.round.progress, false);
  // two rounds with no progress: not converging (the rewording did not keep it going)
  assert.equal(r.status, 'park');
  F.reply(root, 'resume');
  F.cli(root, ['next']);
  // a denial: the editor gets it in the round right after, not in every round after that
  const job = require('../cli/core/job');
  const st = job.load(root, J);
  st.denials = [...(st.denials || []), { gate: 'H1', reason: 'say which VLANs are reserved', at: new Date().toISOString() }];
  job.save(root, st);
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.ok(b.editor.todo.some((t) => t.from === 'gate denial'));
  r = F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, scout: scoutData([]), critique: ge, ...editorEnv(J2.CONTRACT.replace('## Constraints\n', '## Constraints\n- VLANs 3968-4094 are reserved and never synced\n'), { requested: [{ from: 'gate denial' }] }) }));
  assert.equal(r.clarify.round.revised, true, 'applying the denial is progress');
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.ok(!b.editor.todo.some((t) => t.from === 'gate denial'), 'the denial was handled last round');
});

// ---------------------------------------------------------------- dedup and its undo
test('dedup: issues that differ in one telling word are not folded; long paraphrases still are', () => {
  const same = (a, b) => clarify.sameIssue({ ...clarify.subjectOf(a), subject_explicit: Boolean(a.subject), text: a.text, subject: clarify.subjectOf(a).subject }, { ...clarify.subjectOf(b), subject_explicit: Boolean(b.subject), text: b.text, subject: clarify.subjectOf(b).subject });
  assert.equal(same({ text: 'Which VLAN is the native VLAN on trunk ports?' }, { text: 'Which VLANs are allowed on trunk ports?' }), false);
  assert.equal(same({ subject: 'nxos.native-vlan', text: 'Which VLAN is the native VLAN on NX-OS trunk ports?' }, { subject: 'nxos.allowed-vlans', text: 'Which VLANs are allowed on NX-OS trunk ports?' }), false);
  assert.equal(same({ text: 'Should the sync remove VLANs on the trunk that are not in Nautobot?' }, { text: 'Should the sync add VLANs on the trunk that are in Nautobot?' }), false);
  assert.equal(same({ text: 'Does the sync run on leaf switches?' }, { text: 'Does the sync run on spine switches?' }), false);
  assert.equal(same({ text: 'Does the Nautobot interface VLAN API list tagged members?' }, { text: 'Does the Nautobot interface VLAN API need a token?' }), false, 'a derived subject (the same first words) is not identity');
  // the limit of a word rule: longer texts one telling word apart still fold (as the NX-OS
  // paraphrases below must); factory clarify split undoes such a fold
  assert.equal(same({ text: 'Does Nautobot interface VLAN API expose tagged VLANs?' }, { text: 'Does Nautobot interface VLAN API expose the native VLAN?' }), true);
  // the J-0002 paraphrases still fold
  assert.equal(same({ text: 'Which NX-OS CLI command sets the allowed VLAN list on a trunk interface?' }, { text: 'What is the exact NX-OS syntax for switchport trunk allowed vlan?' }), true);
  assert.equal(same({ text: 'Confirm the NX-OS command form for configuring trunk allowed VLANs' }, { text: 'Which command does NX-OS accept to set allowed VLANs on trunk ports?' }), true);
  // the workflow's copy agrees
  const wf = fs.readFileSync(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), 'utf8');
  assert.match(wf, /onlyA && onlyA === onlyB && shared < 5/);
});

test('factory clarify split U-n <alias>: a wrong fold is undone (human-only), and the issue is asked again', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  round(root, { scout: scoutData([
    user('U-1', 'Which NX-OS CLI command sets the allowed VLAN list on a trunk interface?', { kind: 'decision', aliases: [{ id: 'U-2', text: 'Which NX-OS command sets the native VLAN on a trunk interface?' }] }),
  ]) });
  let d = ledgerOf(root, J);
  assert.deepEqual(d.unknowns.map((u) => u.id), ['U-1']);
  // status names the way to undo a fold
  const txt = spawnSync('node', [F.BIN, 'clarify', 'status'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } }).stdout;
  assert.match(txt, /\[aliases U-2\][\s\S]*factory clarify split <U-n> <alias>/);
  // the user's own terminal (the CLI's test seam stands in for it); not a pipe, not an agent shell
  const human = require('../cli/core/human');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !human.AGENT_ENV.some(([a]) => a === k)));
  const term = (args, env = {}) => JSON.parse(spawnSync('node', [F.BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...clean, FACTORY_ROOT: '', ...env } }).stdout);
  assert.equal(term(['clarify', 'split', 'U-1', 'U-2']).code, 'human_only');
  const r = term(['clarify', 'split', 'U-1', 'U-2'], { FACTORY_TEST_HUMAN: human.testToken() });
  assert.equal(r.issue, 'U-2', JSON.stringify(r));
  d = ledgerOf(root, J);
  const u2 = d.unknowns.find((u) => u.id === 'U-2');
  assert.ok(u2, 'U-2 is an issue again');
  assert.deepEqual([u2.status, u2.owner], ['proposed', 'user']);
  assert.equal(d.unknowns.find((u) => u.id === 'U-1').aliases.length, 0);
  assert.ok(u2.history.some((h) => h.event === 'split'));
  assert.ok(d.unknowns.find((u) => u.id === 'U-1').history.some((h) => h.event === 'split'));
  // the next round asks it
  F.cli(root, ['next']);
  const r2 = round(root, { scout: scoutData(d.unknowns) });
  assert.ok(r2.questions.some((q) => q.unknown === 'U-2'), JSON.stringify(r2.questions));
  // human-only: the guard refuses it from the chat agent and from factory agents; the CLI refuses agents
  assert.ok(guardRules.checkBash(root, 'factory clarify split U-1 U-2', guardRules.loadPolicy(root), { agent: false }));
  const agent = spawnSync('node', [F.BIN, 'clarify', 'split', 'U-1', 'U-2'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '', FACTORY_RUNNER: '1' } });
  assert.equal(JSON.parse(agent.stdout).code, 'agent_not_allowed');
});

// ---------------------------------------------------------------- pre-v2 jobs and migration
test('a pre-v2 job: rounds run before the upgrade do not count against the v2 ceiling', () => {
  const root = F.makeRepo();
  const J = J2.build(root);
  const job = require('../cli/core/job');
  const st = job.load(root, J);
  const L = clarify.limits(st);
  assert.equal(L.counted, 0, `rounds before v2 are not counted (${st.counters.clarify_rounds} ran)`);
  F.reply(root, `resume ${J}`);
  F.cli(root, ['next']);
  round(root, { scout: scoutData(clarify.ensure(root, job.load(root, J), intent.load(root, J)).unknowns) });
  const s2 = job.load(root, J);
  assert.equal(clarify.limits(s2).counted, 1);
  assert.ok(clarify.limits(s2).ceiling >= 10);
});

