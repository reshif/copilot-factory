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
  F.clarify(root);
  let b;
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
  F.built(root, 'T1'); // the builder replied done (the runner records it)
  F.cli(root, ['task', 'verify', 'T1']);
  F.record(root, F.envelope(b, 'ok', { tasks: [{ id: 'T1', outcome: 'done', attempts: 1 }] }));
  next(root);
  b = F.cli(root, ['wfargs', 'reconcile']);
  F.cli(root, ['reconcile', 'run']);
  F.record(root, F.envelope(b, 'ok', { integrator: { status: 'merged', summary: '' } }));
  return { J, worktree: s.worktree };
}

// The loop engine's diagnosis, as factory run fanout-judge --config diagnose records it.
function diagnose(root, diagnosis) {
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'diagnose']);
  assert.equal(b.config, 'diagnose', JSON.stringify(b).slice(0, 300));
  return F.record(root, F.envelope(b, 'ok', { loop: b.mode, diagnosis }));
}
const ASK = { cause: 'the policy check needs a file no task may create', needs_user: true, approach: '', question: 'Who creates POLICY_OK: a task (amend its paths) or you?', options: [{ key: 'a', text: 'A task creates it: amend T1 to allow POLICY_OK', consequences: 'T1 may write it' }, { key: 'b', text: 'I create it myself', consequences: 'the check passes once it exists' }], recommendation: 'a' };

test('row 5: a failing proof opens a verify-fix round; the loop engine escalates, diagnoses, then parks with the diagnosis\'s question; any reply resumes with the words', () => {
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
  const rules = [n.rule];
  // the same command keeps failing: no progress
  for (let i = 0; i < 6 && n.action !== 'parked'; i++) {
    if (n.config === 'diagnose') {
      assert.equal(diagnose(root, ASK).status, 'ok');
      n = next(root);
      rules.push(n.rule);
      continue;
    }
    const s = F.cli(root, ['task', 'start', 'T1']);
    F.write(s.worktree, 'src/add.js', `module.exports = (a, b) => a + b; // try ${i}\n`);
    F.sh(s.worktree, 'git commit -qam retry');
    F.built(root, 'T1'); // the builder replied done (the runner records it)
    F.cli(root, ['task', 'verify', 'T1']);
    F.cli(root, ['reconcile', 'run']);
    const b = F.cli(root, ['wfargs', 'reconcile']);
    F.record(root, F.envelope(b, 'ok', { integrator: { status: 'merged', summary: '' } }));
    F.cli(root, ['verify', 'run']);
    n = next(root);
    rules.push(n.rule);
  }
  // round 1, a round without progress, then the builders on the stronger model, then the diagnosis
  assert.deepEqual(rules, ['order.next_step', 'row5.acs_unproven', 'loop.verify.escalate', 'loop.verify.diagnose', 'loop.verify.no_progress'], rules.join(', '));
  assert.equal(n.action, 'parked');
  assert.equal(n.park.kind, 'verify_fix_rounds');
  assert.equal(n.park.question, ASK.question, 'the park asks the diagnosis\'s question, never a bare resume');
  assert.deepEqual(n.park.options.map((o) => o.key), ['a', 'b']);
  assert.equal(n.park.recommendation, 'a');
  assert.match(n.reason, /Question: Who creates POLICY_OK[\s\S]*a\) A task creates it[^\n]*\(recommended\)/);
  const st = F.cli(root, ['job', 'show']);
  assert.ok(st.loops.verify.diagnosis.needs_user);
  // the escalated round ran its builders on the stronger model
  assert.ok(F.cli(root, ['why']).decisions.some((d) => d.rule === 'loop.verify.escalate'));
  // any reply of the human's resumes it, with their words for the next round
  const r = require('../cli/core/human').replyToPark(root, { text: 'I created POLICY_OK myself; try again', channel: 'chat' });
  assert.match(r.message, /Resumed/);
  const after = F.cli(root, ['job', 'show']);
  assert.equal(after.status, 'active');
  assert.equal(after.human_notes[0].text, 'I created POLICY_OK myself; try again');
  assert.equal(after.human_notes[0].question, ASK.question);
  assert.equal(after.loops.verify.rounds, 0, 'a new loop segment');
  assert.equal(after.loops.verify.segments, 1);
  void J;
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

test('row 2: files outside the allowed paths on the job branch are reverted by the CLI, with a record; the same files again park with the question', () => {
  const root = F.makeRepo();
  const { J } = toProve(root);
  // someone commits straight onto the job branch outside the plan's paths
  const wt = path.join(root, '.factory', 'worktrees', J);
  F.write(wt, 'docs/notes.md', 'x\n');
  F.sh(wt, 'git add -A && git commit -qm sneaky');
  let n = next(root);
  assert.notEqual(n.action, 'parked', JSON.stringify(n).slice(0, 300));
  assert.match(n.command || '', /verify run/, 'proven again on the reverted build');
  const st = F.cli(root, ['job', 'show']);
  assert.deepEqual(st.scope_reverts[0].files, ['docs/notes.md']);
  assert.ok(F.cli(root, ['why']).decisions.some((d) => d.rule === 'row2.scope_reverted'));
  assert.equal(require('../cli/lib/git').run(root, ['cat-file', '-e', `${st.branch}:docs/notes.md`], { allowFail: true }).code !== 0, true, 'gone from the job branch');
  assert.ok(require('../cli/core/ledger').all(root, J).some((e) => e.kind === 'scope_revert'));
  // again: the CLI never widens nor reverts twice; the human decides
  F.write(wt, 'docs/notes.md', 'y\n');
  F.sh(wt, 'git add -A && git commit -qm again');
  n = next(root);
  assert.equal(n.action, 'parked');
  assert.equal(n.rule, 'row2.drift_scope');
  assert.match(n.reason, /docs\/notes\.md/);
  assert.match(n.park.question, /outside its allowed paths\. Allow it\?/);
});

test('review-fix loop: confirmed findings that never shrink escalate, are diagnosed, then park with the specific question; a contract-level finding goes straight to an amendment', () => {
  const root = F.makeRepo();
  toProve(root);
  F.cli(root, ['verify', 'run']);
  let n;
  const rules = [];
  for (let round = 1; round <= 8; round++) {
    n = next(root);
    if (n.action === 'parked') break;
    if (n.config === 'diagnose') {
      rules.push(n.rule);
      diagnose(root, { cause: 'each round adds a new problem in the same line', needs_user: true, approach: '', question: 'Should add reject non-numbers, or coerce them?', options: [{ key: 'a', text: 'Reject them with a TypeError', consequences: 'callers must pass numbers' }, { key: 'b', text: 'Coerce them with Number()', consequences: 'strings work' }], recommendation: 'a' });
      continue;
    }
    if (n.workflow === 'realize') {
      rules.push(n.rule);
      // an escalated fix round runs its builders on the stronger model from the first attempt
      if (n.rule === 'loop.review.escalate') assert.equal(F.cli(root, ['wfargs', 'realize']).tasks.T1.builder.model, 'opus');
      else assert.ok(!F.cli(root, ['wfargs', 'realize']).tasks.T1.builder.model);
      const s = F.cli(root, ['task', 'start', 'T1']);
      F.write(s.worktree, 'src/add.js', `module.exports = (a, b) => a + b; // r${round}\n`);
      F.sh(s.worktree, 'git commit -qam r');
      F.built(root, 'T1'); // the builder replied done (the runner records it)
      F.cli(root, ['task', 'verify', 'T1']);
      F.cli(root, ['reconcile', 'run']);
      const b = F.cli(root, ['wfargs', 'reconcile']);
      F.record(root, F.envelope(b, 'ok', { integrator: { status: 'merged', summary: '' } }));
      F.cli(root, ['verify', 'run']);
      n = next(root);
    }
    assert.equal(n.config, 'challenge', JSON.stringify(n).slice(0, 300));
    const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
    F.record(root, F.envelope(b, 'ok', { lanes: [{ lane: 'code', findings: [{ id: `code-${round}`, severity: 'blocker', file: 'src/add.js', line: 1, summary: `Problem ${round} in changed code` }] }], degraded: [], verifications: [{ finding_id: `code-${round}`, status: 'confirmed', reason: 'reproduced' }] }, { fingerprint: b.fingerprint }));
  }
  assert.equal(n.action, 'parked');
  assert.equal(n.rule, 'loop.review.no_progress');
  assert.equal(next(root).action, 'parked');
  assert.deepEqual(rules, ['row4.confirmed_serious', 'row4.confirmed_serious', 'loop.review.escalate', 'loop.review.diagnose']);
  assert.equal(n.park.question, 'Should add reject non-numbers, or coerce them?');
  assert.ok(F.cli(root, ['job', 'show']).loops.review.diagnosis, 'diagnosed before it parked');
  // a confirmed finding at the contract level: no fix round, an amendment
  const root2 = F.makeRepo();
  toProve(root2);
  F.cli(root2, ['verify', 'run']);
  next(root2);
  const b2 = F.cli(root2, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  F.record(root2, F.envelope(b2, 'ok', { lanes: [{ lane: 'code', findings: [{ id: 'code-1', severity: 'major', file: 'src/add.js', line: 1, summary: 'AC-1 asks for integer addition, but the callers pass prices in floats' }] }], degraded: [], verifications: [{ finding_id: 'code-1', status: 'confirmed', reason: 'the AC is wrong for the callers', level: 'contract' }] }, { fingerprint: b2.fingerprint }));
  const a = next(root2);
  assert.deepEqual([a.action, a.skill, a.rule], ['skill', 'amend', 'row4.contract_level']);
  assert.match(a.reason, /at the contract level[\s\S]*propose an amendment/);
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
  F.built(root, 'T1'); // the builder replied done (the runner records it)
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
  next(root);
  const b = F.cli(root, ['wfargs', 'clarify']);
  fs.appendFileSync(path.join(F.jobDir(root, J), 'contract.md'), '\n- extra assumption\n');
  const r = F.record(root, F.envelope(b, 'ok', { stage: b.stage, rev: b.rev, outputs: { 'read-back': { intent: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, scope: { in: [], out: [] }, took: [], pins: [], plan: [], questions: [] } } }));
  assert.equal(r.status, 'stale');
});

test('budget cap parks; the budget is absolute: only a resume that names the grant (resume +50%) raises it', () => {
  const root = F.makeRepo();
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ limits: { max_agent_runs_per_job: 5 } }));
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  next(root);
  const b = F.cli(root, ['wfargs', 'clarify']);
  const env = F.envelope(b, 'ok', { stage: b.stage, rev: b.rev, outputs: { 'read-back': { intent: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, scope: { in: [], out: [] }, took: [], pins: [], plan: [], questions: [] } } });
  env.budgets.used.agent_runs = 9;
  F.record(root, env);
  const n = next(root);
  assert.equal(n.action, 'parked');
  assert.equal(n.rule, 'cap.budget');
  // 0.9.0: the budget is absolute; a bare resume grants nothing and is refused (nothing changes)
  assert.throws(() => F.reply(root, 'resume'), /budget is absolute: say how much more/);
  assert.equal(F.cli(root, ['job', 'show']).status, 'parked');
  assert.equal(F.cli(root, ['job', 'show']).policy.limits.max_agent_runs_per_job, 5);
  F.reply(root, 'resume +50%');
  assert.equal(F.cli(root, ['job', 'show']).policy.limits.max_agent_runs_per_job, 8);
  assert.equal(F.cli(root, ['job', 'show']).status, 'active');
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

test('terminal human actions: a random code shown on the terminal only, no bypass, agent shells refused, one test-only seam', () => {
  const root = F.makeRepo();
  const { spawnSync } = require('child_process');
  const human = require('../cli/core/human');
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !human.AGENT_ENV.some(([a]) => a === k)));
  const cli = (args, env = {}) => {
    const r = spawnSync('node', [F.BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...clean, FACTORY_ROOT: '', ...env } });
    return JSON.parse(r.stdout);
  };
  const token = human.testToken();
  const seam = (input) => ({ NODE_ENV: 'test', FACTORY_TEST_HUMAN: token, FACTORY_TEST_HUMAN_INPUT: input });
  const status = () => F.cli(root, ['job', 'show']).status;
  // without a terminal and without the seam: refused, as before
  assert.equal(cli(['cancel']).code, 'human_only');
  assert.equal(cli(['cancel'], { ...seam('{code}'), FACTORY_TEST_HUMAN: 'guess' }).code, 'human_only', 'the seam needs the token');
  assert.equal(cli(['cancel'], { ...seam('{code}'), NODE_ENV: 'production' }).code, 'human_only', 'the seam needs NODE_ENV=test');
  assert.equal(cli(['cancel'], { ...seam('{code}'), FACTORY_RUNNER: '1' }).code, 'agent_not_allowed', 'never in a factory agent');
  assert.equal(human.agentContext({ CLAUDECODE: '1' }), 'CLAUDECODE');
  assert.equal(human.agentContext({ FACTORY_RUNNER: '0' }), null);
  // VS Code's agent terminals (AI_AGENT ≥ 1.124, COPILOT_AGENT ≥ 1.121), Copilot CLI's shell
  for (const [k, v] of [['AI_AGENT', 'github_copilot_vscode_agent'], ['COPILOT_AGENT', '1'], ['VSCODE_AGENT_ZSH_FIXUPS', '1'], ['COPILOT_CLI', '1']]) {
    assert.equal(human.agentContext({ [k]: v }), k);
    assert.match(cli(['cancel'], { [k]: v }).message, new RegExp(`belongs to an agent \\(${k} is set\\)`));
  }
  assert.equal(human.agentContext({ TERM_PROGRAM: 'vscode', VSCODE_INJECTION: '1' }), null, 'your own VS Code terminal is not an agent');
  // the job id is no confirmation any more (every agent knows it); --yes is no bypass
  assert.equal(cli(['cancel'], seam(J)).code, 'not_confirmed');
  const wrong = cli(['cancel', '--yes'], seam('y'));
  assert.equal(wrong.code, 'not_confirmed');
  assert.match(wrong.message, /^Not confirmed: that was not the code shown on your terminal\. Nothing was done/, 'the refusal never shows the code');
  assert.equal(status(), 'active');
  assert.equal(cli(['cancel'], seam(' {code} ')).job, J, 'the code shown, spaces aside');
  assert.equal(status(), 'cancelled');
  // lessons too: the code, not the lesson id
  F.cli(root, ['lessons', 'add', '--text', 'Run the linter before review', '--scope', 'review']);
  assert.equal(cli(['lessons', 'accept', 'L1'], seam('L1')).code, 'not_confirmed');
  assert.equal(cli(['lessons', 'accept', 'L1'], seam('{code}')).lesson.status, 'accepted');
  // codes are random: short, from the unambiguous alphabet, not repeating
  const codes = new Set(Array.from({ length: 50 }, () => human.confirmationCode()));
  assert.ok(codes.size > 45);
  for (const c of codes) assert.match(c, /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/);
  // chat replies need no confirmation: the reply is the human's own words
  const J2 = F.cli(root, ['job', 'new', '--title', 'y', '--type', 'bug', '--risk', 'low']).job;
  assert.match(F.reply(root, `abandon job ${J2}`).message, /abandoned/);
  // a real terminal: a pty (python's pty module) reads the code off the screen and types it
  const py = spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' }).status === 0;
  if (py && process.platform !== 'win32') {
    const J3 = F.cli(root, ['job', 'new', '--title', 'z', '--type', 'bug', '--risk', 'low']).job;
    const drive = path.join(root, '..', `pty-${J3}.py`);
    fs.writeFileSync(drive, [
      'import os, pty, re, sys, json',
      'mode = sys.argv[1]',
      'pid, fd = pty.fork()',
      'if pid == 0:',
      '    os.execvp(sys.argv[2], sys.argv[2:])',
      'buf = b""',
      'while True:',
      '    try: chunk = os.read(fd, 1024)',
      '    except OSError: break',
      '    if not chunk: break',
      '    buf += chunk',
      '    m = re.search(rb"type the code ([A-Z0-9]{4}): ", buf)',
      '    if m and b"\\x00sent" not in buf:',
      '        reply = m.group(1) if mode == "right" else (b"J-0001" if mode == "jobid" else b"ZZZZ")',
      '        os.write(fd, reply + b"\\n")',
      '        buf += b"\\x00sent"',
      'os.waitpid(pid, 0)',
      'print(json.dumps(buf.decode("utf8", "replace")))',
    ].join('\n'));
    const term = (mode) => JSON.parse(spawnSync('python3', [drive, mode, 'node', F.BIN, 'cancel'], { cwd: root, encoding: 'utf8', env: { ...clean, FACTORY_ROOT: '' }, timeout: 20000 }).stdout);
    for (const mode of ['wrong', 'jobid']) {
      const out = term(mode);
      assert.match(out, new RegExp(`To cancel it \\(${J3}\\), type the code [A-Z2-9]{4}: `));
      assert.match(out, /not_confirmed/);
      assert.equal(F.cli(root, ['job', 'show', '--job', J3]).status, 'active');
    }
    const ok = term('right');
    const code = /type the code ([A-Z2-9]{4}): /.exec(ok)[1];
    assert.match(ok, new RegExp(`${J3} cancelled`));
    assert.equal(F.cli(root, ['job', 'show', '--job', J3]).status, 'cancelled');
    // the code went to the terminal only: no factory file or log holds it
    const hits = spawnSync('grep', ['-rl', code, path.join(root, '.factory')], { encoding: 'utf8' }).stdout.trim();
    assert.equal(hits, '', `the code is in ${hits}`);
    // stderr never holds it (stdout must be the terminal itself, or the command is refused)
    const J4 = F.cli(root, ['job', 'new', '--title', 'w', '--type', 'bug', '--risk', 'low']).job;
    const out = path.join(root, '..', `out-${J4}.txt`);
    const err = path.join(root, '..', `err-${J4}.txt`);
    const shown = JSON.parse(spawnSync('python3', [drive, 'right', 'bash', '-c', `node "${F.BIN}" cancel --job ${J4} 2>"${err}"; echo done >"${out}"`], { cwd: root, encoding: 'utf8', env: { ...clean, FACTORY_ROOT: '' }, timeout: 20000 }).stdout);
    const code4 = /type the code ([A-Z2-9]{4}): /.exec(shown)[1];
    assert.equal(F.cli(root, ['job', 'show', '--job', J4]).status, 'cancelled');
    for (const f of [out, err]) assert.ok(!fs.readFileSync(f, 'utf8').includes(code4), `${path.basename(f)} does not hold the code`);
  }
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
  F.clarify(root);
  let b;
  assert.equal(next(root).step, 'H1');
  F.reply(root, 'deny cover negative numbers too');
  const cfile = path.join(F.jobDir(root, J), 'contract.md');
  fs.writeFileSync(cfile, fs.readFileSync(cfile, 'utf8').replace('(evidence: test)', '(evidence: test)\n- AC-2: add(-1, 1) returns 0 (evidence: test)'));
  const n = next(root);
  assert.equal(n.skill, 'clarify');
  assert.equal(n.clarify.stage, 'redirect', 'clarify v3: the denial is read back as tracked items first');
  b = F.cli(root, ['wfargs', 'clarify']);
  const file = b.groups[0][0].prompt.split('\n')[1].trim();
  assert.match(fs.readFileSync(file, 'utf8'), /"text": "cover negative numbers too"/);
  assert.equal(b.groups[0][0].role, 'interviewer');
});

test('deny needs a reason; after deny the producing step runs again before the gate is shown again', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  const clarify = () => F.clarify(root);
  next(root);
  clarify();
  const g = next(root);
  assert.equal(g.step, 'H1');
  // a bare "deny" is refused (nothing is denied); "deny: <reason>" is a reply
  assert.throws(() => F.reply(root, 'deny'), (e) => e.code === 'needs_reason' && /deny <what must change>/.test(e.message));
  assert.equal(F.cli(root, ['job', 'show']).denials.length, 0);
  assert.equal(require('../cli/core/human').parseReply('deny: too big').reason, 'too big');
  F.reply(root, 'deny: cover negative numbers too');
  // the contract is unchanged, but the gate isn't shown again: clarify reads the denial back
  let n = next(root);
  assert.equal(n.action, 'skill');
  assert.equal(n.skill, 'clarify');
  assert.equal(n.clarify.stage, 'redirect');
  assert.equal(F.cli(root, ['job', 'show']).pending_gate, null, 'the gate is no longer pending while it is revised');
  const b = F.cli(root, ['wfargs', 'clarify']);
  let r = F.record(root, F.envelope(b, 'ok', { stage: 'redirect', rev: b.rev, outputs: { redirect: { clauses: [{ quote: 'cover negative numbers too', item: 'new', action: 'fix', text: 'Cover negative numbers', tag: null }] } } }));
  assert.equal(r.status, 'needs_user');
  assert.match(r.screen, /"cover negative numbers too" → change the contract/);
  assert.match(F.cli(root, ['clarify', 'reply', 'ok']).message, /Redirect confirmed: 1 item/);
  // once clarify has run again, the gate is presented again (even if the document came out the same)
  clarify();
  n = next(root);
  assert.equal(n.action, 'gate');
  assert.equal(n.clarify_h1.redirects[0].done, 1, 'the clause is reported done');
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
  F.clarify(root);
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

test('clarify read-back: questions only the user can answer; an edit re-runs it keeping ids; an answered question becomes their fact', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low', '--request', 'make add faster']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  const readback = (out) => {
    const b = F.cli(root, ['wfargs', 'clarify']);
    assert.equal(b.stage, 'readback');
    return F.record(root, F.envelope(b, 'ok', { stage: 'readback', rev: b.rev, outputs: { 'read-back': { intent: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, scope: { in: [], out: [] }, pins: [], plan: [], design_may_choose: [], ...out } } }));
  };
  next(root);
  let r = readback({ took: [{ item: 'new', text: 'add should be faster', quote: 'make add faster' }, { item: 'new', text: 'invented', quote: 'nobody said this' }], questions: [{ item: 'new', question: 'How fast must it be?', why: 'faster needs a number' }] });
  assert.equal(r.status, 'needs_user');
  assert.match(r.screen, /Only you can tell me\*\*\n1\. How fast must it be\?/);
  assert.match(r.screen, /Not taken \(no source\): invented \(its quote is not in your words\)/, 'a quote that is not in the user\'s words is dropped');
  const L0 = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'clarify.json'), 'utf8'));
  const q = L0.items.find((x) => x.kind === 'question');
  // an edit in the user's own words: the read-back runs again with them
  r = F.cli(root, ['clarify', 'reply', 'under 2 ms per call']);
  assert.equal(r.stage, 'readback');
  assert.equal(next(root).clarify.run, 'factory run clarify');
  r = readback({ took: [{ item: q.id, text: 'Under 2 ms per call', quote: 'under 2 ms per call' }], questions: [] });
  const L = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'clarify.json'), 'utf8'));
  const it = L.items.find((x) => x.id === q.id);
  assert.deepEqual([it.kind, it.status, it.strength, it.value], ['fact', 'decided', 'user', 'Under 2 ms per call'], 'the question is answered under its own id');
  assert.ok(L.items.some((x) => x.value === 'add should be faster' && x.strength === 'user' && x.status !== 'dropped'), 'what the user said earlier is carried, never dropped');
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
  // God Eye's "intent unclear" is a blocker for the read-back: it runs again with the objection
  let r = F.clarify(root, { after: 'check', checklist: { intent_clear: false }, objections: [{ check: 'intent_clear', severity: 'blocker', stage: 'readback', ref: 'Goal', issue: 'the Goal and the Intent disagree', fix: 'ask who it is for' }] });
  assert.equal(r.status, 'continue');
  const n = next(root);
  assert.equal(n.clarify.stage, 'readback');
  const b = F.cli(root, ['wfargs', 'clarify']);
  assert.match(fs.readFileSync(b.groups[0][0].prompt.split('\n')[1].trim(), 'utf8'), /the Goal and the Intent disagree/);
  r = F.clarify(root);
  assert.equal(r.status, 'ok');
  // a follow-up contract carries an Intent section the check understands
  F.write(root, '.factory/scratch/findings.json', JSON.stringify([{ summary: 'add overflows', file: 'src/add.js' }]));
  const fu = F.cli(root, ['followup', '--findings-file', path.join(root, '.factory', 'scratch', 'findings.json')]).followup;
  const text = fs.readFileSync(path.join(F.jobDir(root, fu), 'contract.md'), 'utf8');
  assert.match(text, /## Intent\n- Problem: Confirmed after J-\d+ merged: add overflows/);
  F.cli(root, ['use', fu]);
  assert.deepEqual(F.cli(root, ['contract', 'check']).problems.filter((p) => /^Intent/.test(p)), ['Intent: Who is missing or still a placeholder'], 'only who is left to clarify');
});
