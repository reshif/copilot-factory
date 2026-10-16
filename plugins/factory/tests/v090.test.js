'use strict';
// factory 0.9.0 "loops, not parks": the shared loop engine (cli/core/loop.js), clarify's readiness
// loop (writer ⇄ God Eye on progress, the tie-break, the diagnosis, H1 instead of a park), the
// user's words (later ones win, unmapped ones kept, scope as items, a reworded constraint cited,
// words sent while parked stored), parks that ask a question and resume with the reply, the
// absolute budget, the ship review (the human's checks, unsettled findings, the push, HS), HS deny
// as a fix round, merge detection, scope reverts, HS in local mode, the end-of-job digest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const Loop = require('../cli/core/loop');
const C = require('../cli/core/clarify');
const { drive } = require('./helpers/clarify3-drive');

const core = (m) => require(`../cli/core/${m}`);
const next = (root) => F.cli(root, ['next']);
const stateOf = (root, J) => JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'state.json'), 'utf8'));
const quiet = { log: process.env.CLARIFY_ACCEPTANCE_VERBOSE ? (m) => process.stderr.write(`${m}\n`) : () => {} };

// ---------------------------------------------------------------- A. the loop engine
test('loop engine: continues while the open set shrinks; two rounds without → the stronger model; one more → diagnosis; then stop with its question', () => {
  let s = null;
  const step = (b) => {
    const d = Loop.shouldContinue(s, b, { ceiling: 9 });
    s = d.state;
    return d;
  };
  assert.deepEqual([step(['a', 'b', 'c']).rule, step(['a', 'b']).rule, step(['a']).rule].join(), 'first_round,progress,progress');
  assert.equal(step([]).action, 'done', 'nothing open: done');
  s = null;
  const seq = [step(['x', 'y']), step(['x', 'y']), step(['y', 'x'])];
  assert.deepEqual(seq.map((d) => d.action), ['continue', 'continue', 'escalate'], 'the same set twice more: escalate');
  assert.equal(seq[2].model, 'opus');
  const dg = step(['x', 'y']);
  assert.deepEqual([dg.action, dg.escalation], ['diagnose', 'diagnosis']);
  // the same observation while the diagnosis is pending is not a new round
  const again = step(['x', 'y']);
  assert.equal(again.action, 'diagnose');
  assert.equal(again.state.rounds, dg.state.rounds);
  s = Loop.recordDiagnosis(s, { cause: 'x and y conflict', needs_user: false, approach: 'drop x', question: '', options: [], recommendation: '' });
  const after = step(['x', 'y']);
  assert.deepEqual([after.action, after.rule, after.approach], ['continue', 'diagnosed', 'drop x'], 'the diagnosis\'s approach gets one more round');
  const stop = step(['x', 'y']);
  assert.deepEqual([stop.action, stop.rule], ['stop', 'no_progress']);
  const q = Loop.question(s, { what: 'the test loop', blockers: ['x', 'y'], fallbackOptions: ['do a', 'do b'], fallbackRecommendation: 'a' });
  assert.match(q.text, /the test loop: stopped because [\s\S]*Diagnosis: x and y conflict[\s\S]*a\) do a \(recommended\)/);
  assert.equal(q.diagnosed, true);
});

test('loop engine: the ceiling stops a loop that is still converging (after a diagnosis); a diagnosis that needs the user stops at once; keys are check+ref', () => {
  let s = null;
  let d;
  for (const b of [['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd'], ['a', 'b', 'c']]) {
    d = Loop.shouldContinue(s, b, { ceiling: 3 });
    s = d.state;
  }
  d = Loop.shouldContinue(s, ['a', 'b'], { ceiling: 3 });
  assert.deepEqual([d.action, d.rule], ['diagnose', 'ceiling'], 'the ceiling: diagnosis first');
  s = Loop.recordDiagnosis(d.state, { cause: 'big', needs_user: false, approach: '', question: 'Split the job?', options: [{ key: 'a', text: 'split' }], recommendation: 'a' });
  d = Loop.shouldContinue(s, ['a', 'b'], { ceiling: 3 });
  assert.deepEqual([d.action, d.rule], ['stop', 'ceiling']);
  // needs_user: stops right after the diagnosis
  s = null;
  for (const b of [['k'], ['k'], ['k'], ['k']]) s = Loop.shouldContinue(s, b, {}).state;
  s = Loop.recordDiagnosis(s, { cause: 'only you know', needs_user: true, question: 'Which one?', options: ['this', 'that'], recommendation: 'b' });
  d = Loop.shouldContinue(s, ['k'], {});
  assert.equal(d.action, 'stop');
  assert.equal(Loop.question(d.state).recommendation, 'b');
  assert.equal(Loop.keyOf({ check: 'acs_testable', ref: 'ac-1' }), 'acs_testable|AC-1');
  // policy: no stronger model, no diagnosis → stop after the stall rounds
  s = null;
  for (const b of [['k'], ['k'], ['k']]) d = Loop.shouldContinue(s, b, { escalate_model: null, diagnose: false }), (s = d.state);
  assert.equal(d.action, 'stop');
  assert.deepEqual(Loop.policyFor({ loops: { ceiling: 7, escalate_model: 'sonnet' } }), { ceiling: 7, stall_rounds: 2, escalate_model: 'sonnet', diagnose: true });
});

// ---------------------------------------------------------------- C. clarify: who fixes a blocker
test('clarify: fixableBy and classify sort blockers to the writer or the user; the signature tells progress from none', () => {
  const data = { items: [{ id: 'I-1', strength: 'user', kind: 'fact' }, { id: 'I-2', strength: 'evidence', kind: 'fact' }] };
  const fb = (b) => C.fixableBy(b, data);
  assert.equal(fb({ by: 'god-eye', check: 'decisions_closed', stage: 'sheet', fixable_by: 'writer' }), 'writer', 'God Eye\'s word wins');
  assert.equal(fb({ by: 'cli', check: 'acs_testable', stage: 'assemble' }), 'writer');
  assert.equal(fb({ by: 'cli', check: 'decisions_closed', stage: 'sheet' }), 'user');
  assert.equal(fb({ by: 'god-eye', check: 'acs_testable', stage: 'sheet' }), 'writer', 'a weak verify command is never the user\'s');
  assert.equal(fb({ by: 'god-eye', check: 'self_consistent', stage: 'sheet', ref: 'I-2' }), 'writer');
  assert.equal(fb({ by: 'god-eye', check: 'self_consistent', stage: 'sheet', ref: 'I-1' }), 'user', 'it points at what the user said');
  assert.equal(fb({ by: 'god-eye', check: 'intent_clear', stage: 'readback' }), 'user');
  const cl = C.classify(data, [{ by: 'god-eye', check: 'intent_clear', stage: 'readback' }, { by: 'god-eye', check: 'facts_honoured', stage: 'research' }, { by: 'cli', check: 'acs_testable', stage: 'assemble' }]);
  assert.deepEqual(cl.map((b) => b.route), ['readback', 'research', 'assemble']);
  assert.equal(C.signature([{ check: 'a', ref: 'x' }, { check: 'a', ref: 'X' }]), C.signature([{ check: 'a', ref: 'x' }]), 'refs compare without case');
});

function job({ risk = 'low', request = 'fix add so the cart totals add up; negative numbers must work too', policy = null } = {}) {
  const root = F.makeRepo();
  if (policy) {
    const pf = path.join(root, '.factory', 'policy.json');
    const pol = JSON.parse(fs.readFileSync(pf, 'utf8'));
    for (const [k, v] of Object.entries(policy)) pol[k] = { ...(pol[k] || {}), ...v };
    fs.writeFileSync(pf, JSON.stringify(pol, null, 2));
  }
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', risk, '--request', request]).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText({ ac: '- AC-1: add(2, 3) returns 5 (evidence: test)\n- AC-2: add(-1, -2) returns -3 (evidence: test)', verify: '`node tests/add.test.js` (AC-1, AC-2)' }));
  return { root, J, JD: F.jobDir(root, J) };
}
const record = (root, J) => JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'clarify.json'), 'utf8'));
const READY = Object.fromEntries(C.CHECKLIST.map((k) => [k, true]));
const RB = { intent: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, scope: { in: ['add'], out: ['subtraction'] }, took: [{ item: 'new', text: 'Negative numbers must work', quote: 'negative numbers must work too' }], pins: [], plan: [], questions: [], design_may_choose: [] };

// Drives clarify stage by stage with scripted outputs (as clarify-v3-review.test.js does).
function run(root, J, { readback = RB, writer, check = () => [], interpret, reply = () => 'ok', dispute, diagnosis, redirect, max = 40, results = [] } = {}) {
  const JD = F.jobDir(root, J);
  let checks = 0;
  for (let i = 0; i < max; i++) {
    const n = next(root);
    if (!(n.action === 'skill' && n.skill === 'clarify')) return n;
    const c = n.clarify || {};
    if (c.waiting_for_user) {
      const said = reply(c.stage, c.screen, record(root, J));
      if (said === null) return n;
      const r = F.cli(root, ['clarify', 'reply', said]);
      if (r.error) throw new Error(JSON.stringify(r));
      continue;
    }
    const brief = F.cli(root, ['wfargs', 'clarify']);
    const d = record(root, J);
    const text = fs.readFileSync(path.join(JD, 'contract.md'), 'utf8');
    const objections = brief.stage === 'check' ? check(++checks, d) : [];
    const make = {
      readback: () => ({ 'read-back': readback }),
      assemble: () => ({ contract: { contract: text, covers: d.items.map((x) => ({ item: x.id, where: x.kind === 'fact' && /negative/i.test(x.text) ? 'AC-2' : 'Goal' })), uncovered: [], ...(writer ? writer(text, d, brief) : {}) } }),
      check: () => ({ readiness: { verdict: objections.some((o) => o.severity === 'blocker') ? 'blocked' : 'ready', restatement: { problem: 'p', outcome: 'o' }, checklist: { ...READY, ...Object.fromEntries(objections.filter((o) => o.severity === 'blocker').map((o) => [o.check, false])) }, objections } }),
      interpret: () => ({ interpret: interpret ? interpret(d) : { answers: [], facts: [], unclear: [] } }),
      redirect: () => ({ redirect: redirect ? redirect(d) : { clauses: [] } }),
      research: () => Object.fromEntries([...brief.groups.flat().filter((a) => a.label !== 'research brief').map((a) => [a.label, { mode: a.mode, evidence: [], unresolved: [] }]), ['research brief', { summary: 's', records: [], facts: [], gaps: [] }]]),
      dispute: () => Object.fromEntries(brief.groups.flat().map((a) => [a.label, dispute ? dispute(a, d) : { finding_id: 'x', status: 'confirmed', evidence: 'contract.md', reason: 'it holds' }])),
      diagnose: () => ({ diagnosis: diagnosis ? diagnosis(d) : { cause: 'c', needs_user: false, approach: '', question: '', options: [], recommendation: '' } }),
    }[brief.stage];
    const outputs = make();
    const r = F.record(root, F.envelope(brief, 'ok', { stage: brief.stage, rev: brief.rev, outputs }));
    results.push({ ...r, ran: brief.stage });
    if (r.status === 'park') return next(root);
  }
  throw new Error('max steps');
}

test('clarify (hello-world e2e): God Eye\'s three writer-fixable findings, then one, then none: the writer rounds run by themselves and the job reaches H1 with no park and no user turn', () => {
  const rec = drive({
    crew: 'hello',
    title: 'Hello world script',
    request: 'a small node script that prints Hello, world',
    repo: { 'package.json': '{ "name": "hello", "version": "1.0.0" }\n', 'README.md': '# hello\n' },
    sheet: () => 'ok',
    gate: () => ({ approve: true }),
    onPark: () => null,
  }, quiet);
  assert.equal(rec.end.action, 'approved', JSON.stringify(rec.end));
  assert.equal(rec.parks.length, 0, 'no park');
  assert.equal(rec.turns.length - 1, 1, 'the only user turn is H1');
  assert.equal(rec.turns[1].at_stage, 'H1');
  const writers = rec.calls.filter((c) => c.agent === 'factory:contract-writer').length;
  const checks = rec.calls.filter((c) => c.agent === 'factory:god-eye').length;
  assert.deepEqual([writers, checks], [3, 3], 'the first version and two automatic fix rounds');
  assert.equal(rec.ledger.writer_loop.rounds, 2);
  assert.ok(!rec.ledger.parked);
  assert.match(rec.contract, /node tests\/hello\.test\.js/, 'the writer applied God Eye\'s fixes');
  const h1 = rec.h1[0].h1;
  assert.ok(!h1.objections.some((o) => o.open), 'God Eye approved the contract');
  // the read-back was shown at H1 (nothing on it needed the user, and there was no sheet)
  assert.match(h1.screen, /What I understood[\s\S]*Goal/);
  // the writer was told it was an automatic round, with God Eye's fixes
  const second = rec.calls.filter((c) => c.agent === 'factory:contract-writer')[1];
  const brief = fs.readFileSync(second.argv[second.argv.indexOf('-p') + 1].split('\n').map((l) => l.trim()).find((l) => l.startsWith('/')), 'utf8');
  const runFile = fs.readFileSync(brief.split('\n').map((l) => l.trim()).find((l) => l.startsWith('/') && l.endsWith('.md')), 'utf8');
  assert.match(runFile, /"round": \{\s*"n": 1,\s*"of": 5/);
  assert.match(runFile, /"fix": "Add tests\/hello\.test\.js/);
});

test('clarify: a disputed blocker (raised again after the writer had its fix) gets one finding-verifier tie-break; refuted, it is a note and the loop ends at H1', () => {
  const { root, J } = job();
  const results = [];
  let verifier = 0;
  const n = run(root, J, {
    results,
    check: () => [{ check: 'scope_bounded', severity: 'blocker', stage: 'assemble', ref: 'Non-goals', issue: 'say what is out', fix: 'add a non-goal' }],
    dispute: (a) => {
      verifier += 1;
      return { finding_id: a.label, status: 'refuted', evidence: 'contract.md: "## Non-goals - Other arithmetic"', reason: 'the contract already says what is out' };
    },
  });
  assert.equal(n.step, 'H1', JSON.stringify(n).slice(0, 300));
  assert.equal(verifier, 1, 'one tie-break');
  assert.deepEqual(results.map((r) => r.ran), ['readback', 'assemble', 'check', 'assemble', 'check', 'dispute']);
  assert.deepEqual(results[5].disputes, [{ key: 'scope_bounded|NON-GOALS', status: 'refuted' }]);
  const v = n.clarify_h1;
  assert.notEqual(v.approved, false, 'nothing open');
  assert.match(v.screen, /remarks: say what is out \(raised as a blocker; the finding-verifier refuted it/);
  assert.equal(record(root, J).disputes['scope_bounded|NON-GOALS'].status, 'refuted');
});

test('clarify: a diagnosis that says only the user can settle it puts its question (options, recommendation) on the sheet, never a park', () => {
  const { root, J } = job();
  const screens = [];
  let checks = 0;
  const n = run(root, J, {
    check: () => (++checks <= 4 ? [{ check: 'self_consistent', severity: 'blocker', stage: 'assemble', ref: 'AC-2', issue: 'AC-2 and the Goal disagree on negatives', fix: 'make them agree' }] : []),
    diagnosis: () => ({ cause: 'the user said negatives must work, the Goal says all numbers: both readings fit', needs_user: true, approach: '', question: 'Do negative numbers include -0?', options: [{ key: 'a', text: 'Yes: add(-0, 0) is 0', consequences: 'one more case' }, { key: 'b', text: 'No: -0 is not a case', consequences: 'none' }], recommendation: 'a' }),
    reply: (stage, screen) => {
      screens.push(screen);
      return 'ok';
    },
  });
  assert.equal(n.step, 'H1', JSON.stringify(n).slice(0, 300));
  const sheet = screens.find((s) => /Decisions/.test(s));
  assert.match(sheet, /Do negative numbers include -0\?[\s\S]*a\) Yes: add\(-0, 0\) is 0 \*\*\(recommended\)\*\*/);
  const d = record(root, J);
  const q = d.items.find((x) => /include -0/.test(x.text));
  assert.deepEqual([q.status, q.value], ['decided', 'Yes: add(-0, 0) is 0']);
  assert.ok(!d.parked);
});

test('clarify: a God Eye blocker only the user can settle (fixable_by user) becomes one sheet question with God Eye\'s options and recommendation; its writer blockers wait for the writer after the answer', () => {
  const { root, J } = job();
  const screens = [];
  let checks = 0;
  const n = run(root, J, {
    check: () => (++checks === 1 ? [
      { check: 'decisions_closed', severity: 'blocker', stage: 'sheet', ref: 'Goal', issue: 'Nothing says whether add accepts floats.', fix: 'Ask the user.', fixable_by: 'user', question: 'Should add accept floats?', options: [{ text: 'Yes: floats are summed', consequences: 'prices work' }, { text: 'No: floats throw', consequences: 'prices break' }], recommendation: 'Yes: floats are summed' },
      { check: 'acs_testable', severity: 'blocker', stage: 'assemble', ref: 'AC-1', issue: 'AC-1 names one input', fix: 'add a second example', fixable_by: 'writer' },
    ] : []),
    reply: (stage, screen) => {
      screens.push(screen);
      return 'ok';
    },
  });
  assert.equal(n.step, 'H1', JSON.stringify(n).slice(0, 300));
  const sheet = screens.find((x) => /\*\*Decisions/.test(x));
  assert.match(sheet, /Should add accept floats\?\*\*\n   - a\) Yes: floats are summed \*\*\(recommended\)\*\*\n   - b\) No: floats throw/);
  const d = record(root, J);
  const q = d.items.find((x) => x.text === 'Should add accept floats?');
  assert.deepEqual([q.kind, q.status, q.value, q.strength], ['decision', 'decided', 'Yes: floats are summed', 'accepted']);
  assert.equal(d.checks[0].objections.find((o) => o.check === 'acs_testable').fixable_by, 'writer');
});

test('clarify: the user\'s later words win over their earlier ones, shown as "changed: X → Y because you said …"; unmapped words on the sheet are kept verbatim as instructions', () => {
  const { root, J } = job();
  const screens = [];
  let sheets = 0;
  const n = run(root, J, {
    readback: { ...RB, questions: [{ item: 'new', question: 'Do totals round to cents?', why: 'only you know' }] },
    // the interviewer maps "2 decimals" to the question and cannot map the rest
    interpret: (d) => {
      const w = d.words.find((x) => x.id === d.pending_reply);
      return { answers: [{ decision: 1, choice: 'other', text: 'round to 2 decimals', quote: 'round to 2 decimals' }], facts: [], unclear: [w.text.includes('log') ? 'and log every rounding' : ''] };
    },
    reply: (stage, screen) => {
      screens.push(screen);
      if (stage !== 'sheet_wait') return 'ok'; // a question only the user can answer: the read-back waits
      sheets += 1;
      return 'round to 2 decimals and log every rounding';
    },
  });
  assert.equal(n.step, 'H1', JSON.stringify(n).slice(0, 300));
  const d = record(root, J);
  const ins = d.items.find((x) => x.kind === 'instruction' && /log every rounding/.test(x.value));
  assert.ok(ins, JSON.stringify(d.items.map((x) => [x.kind, x.text])));
  assert.equal(ins.strength, 'user');
  // later words: the user restates a fact they gave before (the redirect links it by id)
  F.reply(root, `deny ${J} negative numbers must work, and zero too`);
  const n2 = run(root, J, {
    redirect: (dd) => ({ clauses: [{ quote: 'negative numbers must work, and zero too', item: dd.items.find((x) => /Negative numbers/.test(x.text)).id, action: 'fact', text: 'Negative numbers and zero must work' }] }),
    reply: (stage, screen) => {
      screens.push(screen);
      return 'ok';
    },
  });
  assert.equal(n2.step, 'H1', JSON.stringify(n2).slice(0, 300));
  assert.match(n2.clarify_h1.screen, /Changed by your later words[\s\S]*changed: Negative numbers must work → Negative numbers and zero must work because you said "negative numbers must work, and zero too"/);
  void sheets;
});

test('clarify: scope lines are items (a redirect can change one by id); a reworded constraint is a cited change, not a drop', () => {
  const { root, J } = job();
  let n = run(root, J);
  assert.equal(n.step, 'H1');
  const d = record(root, J);
  const out = d.items.find((x) => x.kind === 'scope' && x.scope === 'out');
  assert.equal(out.value, 'subtraction');
  // the writer rewords the constraint, citing the user's words: recorded as a change
  const W = d.words[0].id;
  F.reply(root, `deny ${J} keep it dependency free but dev dependencies are fine`);
  n = run(root, J, {
    redirect: () => ({ clauses: [{ quote: 'keep it dependency free but dev dependencies are fine', item: 'new', action: 'instruction', text: 'no runtime dependencies; dev dependencies are fine' }] }),
    writer: (text, dd) => {
      if (!/No new dependencies/.test(text)) return {};
      const w = dd.words[dd.words.length - 1].id;
      return { contract: text.replace('- No new dependencies', '- No new runtime dependencies (dev dependencies are fine)'), changed: [{ ref: 'Constraints', from: 'No new dependencies', to: 'No new runtime dependencies (dev dependencies are fine)', because: w, why: 'the user said dev dependencies are fine' }] };
    },
  });
  assert.equal(n.step, 'H1', JSON.stringify(n).slice(0, 300));
  assert.ok(n.clarify_h1.reworded.some((x) => /^Constraints: "No new dependencies" → "No new runtime dependencies \(dev dependencies are fine\)" because W-\d+/.test(x)), JSON.stringify(n.clarify_h1.reworded));
  assert.match(n.clarify_h1.screen, /Reworded in the contract/);
  assert.match(fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8'), /No new runtime dependencies/);
  void W;
});

test('clarify: a park from before 0.9.0 on findings the writer can fix: factory next says resume continues by itself, and resume restarts the automatic rounds', () => {
  const { root, J } = job();
  run(root, J, { reply: () => null, check: () => [] });
  // forge an old-style writer park (as 0.8.2 left it) through the record's own save
  const data = C.load(root, J);
  data.parked = { kind: 'writer', stage: 'assemble', reason: 'The contract still fails its readiness check after 2 writer attempt(s)' };
  data.blockers = [{ check: 'acs_testable', severity: 'blocker', stage: 'assemble', ref: 'AC-1', issue: 'no range', fix: 'say which numbers', by: 'god-eye' }];
  data.stage = 'assemble';
  C.save(root, J, data);
  core('decision-table').park(root, core('job').load(root, J), data.parked.reason, 'clarify');
  const n = next(root);
  assert.equal(n.action, 'parked');
  assert.equal(n.park.clarify.upgraded, true);
  assert.match(n.park.next, /continues automatically/);
  F.reply(root, 'resume');
  const after = record(root, J);
  assert.equal(after.stage, 'assemble');
  assert.ok(!after.parked);
  assert.equal(after.writer_loop.rounds, 0, 'the automatic writer rounds start again');
});

// ---------------------------------------------------------------- B. parks and resume
test('a reply to a park through the prompt hook is resume + content: the job resumes and the words reach the next agents; a question to the assistant is not a reply', () => {
  const { root, J } = job();
  assert.equal(run(root, J).step, 'H1');
  F.reply(root, 'approve');
  assert.equal(next(root).workflow, 'ground');
  F.cli(root, ['park', '--reason', 'waiting for the vendor API']);
  assert.equal(stateOf(root, J).status, 'parked');
  const hook = (prompt) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'prompt.js'), 'userPromptSubmitted'], { input: JSON.stringify({ prompt, cwd: root, sessionId: 's', timestamp: 1 }), encoding: 'utf8' });
  hook('why is it parked?');
  assert.equal(stateOf(root, J).status, 'parked', 'a question is the user talking to the assistant');
  hook('/factory:console');
  assert.equal(stateOf(root, J).status, 'parked', 'a factory command is not an answer');
  const r = hook('the vendor API is live now, use the v2 endpoint');
  assert.match(r.stdout, /Applied your reply to the park/);
  const st = stateOf(root, J);
  assert.equal(st.status, 'active');
  assert.deepEqual([st.human_notes[0].text, st.human_notes[0].from], ['the vendor API is live now, use the v2 endpoint', 'manual']);
  const last = JSON.parse(fs.readFileSync(path.join(root, '.factory', 'last-reply.json'), 'utf8'));
  assert.deepEqual([last.status, last.reply], ['applied', 'park']);
  assert.ok(core('decisions').forJob(root, J).some((d) => d.action === 'human.resume' && /vendor API is live/.test(d.words || '')));
  // every brief carries the human's answer
  assert.equal(next(root).workflow, 'ground');
  const b = F.cli(root, ['wfargs', 'ground']);
  const ptr = /\/[^"\\\s]+\.md/.exec(JSON.stringify(b));
  assert.ok(ptr && /The human answered the factory's question while the job was parked[\s\S]*the vendor API is live now/.test(fs.readFileSync(ptr[0], 'utf8')), 'the agents get the words');
});

test('the budget is absolute: no automatic +50%; resume +100% doubles it; a reply "b" to the budget question grants +100% too', () => {
  const root = F.makeRepo();
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ limits: { max_agent_runs_per_job: 4 } }));
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  next(root);
  const s = core('job').load(root, J);
  s.counters.agent_runs = 9;
  core('job').save(root, s);
  const n = next(root);
  assert.equal(n.action, 'parked');
  assert.equal(n.park.question, 'Grant more agent runs for this job?');
  assert.deepEqual(n.park.options.map((o) => o.key), ['a', 'b', 'c']);
  assert.throws(() => F.reply(root, 'resume'), /budget is absolute/);
  assert.throws(() => require('../cli/core/human').replyToPark(root, { text: 'go on', channel: 'chat' }), /budget is absolute/);
  F.reply(root, 'resume +100%');
  assert.equal(stateOf(root, J).policy.limits.max_agent_runs_per_job, 8);
  // parks again (9 > 8): "b" is the +100% option
  next(root);
  require('../cli/core/human').replyToPark(root, { text: 'b', channel: 'chat' });
  assert.equal(stateOf(root, J).policy.limits.max_agent_runs_per_job, 16);
  assert.equal(core('human').budgetGrant('+50%'), 1.5);
  assert.equal(core('human').budgetGrant('double it'), 2);
  assert.equal(core('human').budgetGrant('go on'), null);
});

test('several exact replies in one message are applied in order ("confirm AC-1; approve"); one that fails stops the rest and says what was applied', () => {
  const h = core('human');
  assert.equal(h.parseBatch('confirm AC-1; approve').parts.length, 2);
  assert.equal(h.parseBatch('accept lesson L4\nreject lesson L5 too broad\naccept brief P1').parts.length, 3);
  assert.equal(h.parseBatch('confirm AC-1; and also this'), null, 'every part must be an exact reply');
  assert.equal(h.parseBatch('approve'), null, 'one reply is not a batch');
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.clarify(root);
  assert.equal(next(root).step, 'H1');
  const r = h.applyReply(root, h.parseBatch('approve; resume'), 'chat');
  assert.equal(r.partial, true);
  assert.match(r.message, /Applied 1 of 2[\s\S]*NOT applied: "resume"/);
  assert.ok(stateOf(root, J).approvals.H1);
});

// ---------------------------------------------------------------- D. prove → ship
function grounded(root, { ac, allowed = ['src/**', 'tests/**', 'README.md'] } = {}) {
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText({ ac, allowed, verify: '`node tests/add.test.js` (AC-1)' }));
  F.clarify(root);
  next(root);
  F.reply(root, 'approve');
  next(root);
  const b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 't', claims: [], unknowns: [] }], degraded: [] }));
  next(root);
  return J;
}
function build(root, J, files, tasks = ['T1']) {
  for (const t of tasks) {
    const s = F.cli(root, ['task', 'start', t]);
    for (const [rel, text] of Object.entries(files[t] || files)) if (typeof text === 'string') F.write(s.worktree, rel, text);
    F.sh(s.worktree, `git add -A && git commit -qm "${t}" --allow-empty`);
    F.built(root, t);
    assert.equal(F.cli(root, ['task', 'verify', t]).pass, true);
  }
  assert.equal(F.cli(root, ['reconcile', 'run', '--job', J]).status, 'merged');
}
function challenge(root, lanes = null) {
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  return F.record(root, F.envelope(b, 'ok', { lanes: lanes || b.fanout.map((f) => ({ lane: f.id, findings: [] })), degraded: [], verifications: [] }, { fingerprint: b.fingerprint }));
}

test('ship review: the human\'s check of a criterion is asked once, after review, in one ship review; a later fix round that leaves its files keeps it', () => {
  const root = F.makeRepo();
  const J = grounded(root, { ac: '- AC-1: add(2, 3) returns 5 (evidence: test)\n- AC-2: the README names add (evidence: human)' });
  // two tasks: T1 the code (AC-1), T2 the README (AC-2, the human's check)
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks: [
    { id: 'T1', objective: 'fix add', allowed_paths: ['src/**', 'tests/**'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node tests/add.test.js', covers: ['AC-1'] }] },
    { id: 'T2', objective: 'readme', allowed_paths: ['README.md'], depends_on: [], criteria_ids: ['AC-2'], verify_commands: [{ cmd: 'test -f README.md', covers: [] }] },
  ] }));
  assert.equal(F.cli(root, ['plan', 'validate']).valid, true);
  const b0 = core('invalidation').current(root, stateOf(root, J));
  core('ledger').append(root, J, { kind: 'step', step: 'decompose', ok: true, bound: { plan: b0.plan, contract: b0.contract }, detail: { source: 'test' } });
  next(root);
  build(root, J, { T1: { 'src/add.js': 'module.exports = (a, b) => a + b;\n' }, T2: { 'README.md': '# tiny\n\nadd(a, b)\n' } }, ['T1', 'T2']);
  assert.match(next(root).command, /verify run/);
  assert.equal(F.cli(root, ['verify', 'run']).acs['AC-2'], 'unproven');
  // not asked now: review first
  let n = next(root);
  assert.equal(n.config, 'challenge', JSON.stringify(n).slice(0, 300));
  challenge(root);
  n = next(root);
  assert.deepEqual([n.action, n.step, n.rule], ['wait', 'ship_review', 'ship.review']);
  assert.deepEqual(n.ship_review.acs, ['AC-2']);
  // the drive's stop for it: one line, the reply forms
  const d = core('drive').stopDetail('wait', n);
  assert.ok(!/\n/.test(d.summary), d.summary);
  assert.match(d.reply, /confirm AC-2/);
  // the inbox lists it as the ship review
  assert.equal(F.cli(root, ['inbox']).items.find((x) => x.job === J).kind, 'ship_review');
  F.reply(root, 'confirm AC-2');
  assert.match(next(root).command, /verify run/);
  assert.equal(F.cli(root, ['verify', 'run']).ok, true);
  // a later build that changes only T1's code keeps the human's check of the README
  const st = stateOf(root, J);
  st.tasks.T1.needs_work = 'review';
  core('job').save(root, st);
  build(root, J, { T1: { 'src/add.js': 'module.exports = (a, b) => Number(a) + Number(b);\n' } }, ['T1']);
  const v = F.cli(root, ['verify', 'run']);
  assert.equal(v.acs['AC-2'], 'proven', 'its files did not change');
  // ... and asks again once they do
  st.tasks = stateOf(root, J).tasks;
  const s2 = stateOf(root, J);
  s2.tasks.T2.needs_work = 'review';
  core('job').save(root, s2);
  build(root, J, { T2: { 'README.md': '# tiny\n\nadd(a, b) sums\n' } }, ['T2']);
  assert.equal(F.cli(root, ['verify', 'run']).acs['AC-2'], 'unproven');
});

test('local mode: the human merges and the factory notices (no "merged <sha>" needed; it still works); HS is skipped at high risk when ship pushes nothing', () => {
  const root = F.makeRepo();
  const J = grounded(root, { ac: '- AC-1: add(2, 3) returns 5 (evidence: test)' });
  F.cli(root, ['plan', 'from-contract']);
  next(root);
  build(root, J, { 'src/add.js': 'module.exports = (a, b) => a + b;\n' });
  F.cli(root, ['verify', 'run']);
  next(root);
  challenge(root);
  assert.equal(next(root).skill, 'ship');
  assert.equal(F.cli(root, ['ship']).mode, 'local', 'no remote: local mode');
  let n = next(root);
  assert.equal(n.action, 'wait');
  assert.match(n.reason, /notices the merge by itself/);
  const st = stateOf(root, J);
  F.sh(root, `git checkout -q ${st.base_branch} && git merge -q --no-ff -m "merge ${J}" ${st.branch}`);
  n = next(root);
  assert.notEqual(n.action, 'wait', JSON.stringify(n).slice(0, 300));
  const after = stateOf(root, J);
  assert.equal(after.pr.merged, true);
  assert.equal(after.pr.merged_via, 'detected');
  assert.equal(after.pr.merge_commit, F.sh(root, 'git rev-parse HEAD').trim());
  assert.ok(core('decisions').forJob(root, J).some((x) => x.action === 'merge.detected'));
  assert.match(n.command || '', /ci verify/, 'the CI re-verify floor runs next');
  // HS in local mode: the irreversible sign-off has nothing outward to sign off
  const root2 = F.makeRepo();
  const J2 = F.cli(root2, ['job', 'new', '--title', 'x', '--type', 'feature', '--risk', 'high']).job;
  const ctx = core('steps').context(root2, core('job').load(root2, J2), core('job').load);
  assert.equal(core('steps').shipsLocally(ctx), true);
  assert.equal(core('steps').isDone(ctx, { step: 'HS' }), true);
  assert.equal(require('../cli/core/floors').check(ctx, 'irreversible_signoff'), true);
});

test('HS deny is a fix round: the reason becomes the builders\' finding (every task reopened), then prove and review again and HS on the new build', () => {
  const root = F.makeRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-origin-'));
  F.sh(bare, 'git init -q --bare');
  F.sh(root, `git remote add origin "${bare}"`);
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', 'high']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks: [{ id: 'T1', objective: 'x', allowed_paths: ['src/**'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: ['node tests/add.test.js'] }, { id: 'T2', objective: 'y', allowed_paths: ['tests/**'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: ['node tests/add.test.js'] }] }));
  const load = () => core('job').load(root, J);
  let ctx = core('steps').context(root, load(), core('job').load);
  assert.equal(core('steps').shipsLocally(ctx), false, 'a remote: ship would push, so HS signs it off');
  assert.equal(core('steps').isDone(ctx, { step: 'HS' }), false);
  const st = load();
  st.denials.push({ gate: 'HS', hash: core('steps').gateHash(ctx, 'HS'), at: new Date().toISOString(), reason: 'add must reject strings' });
  core('job').save(root, st);
  ctx = core('steps').context(root, load(), core('job').load);
  const a = core('decision-table').deniedShip(ctx);
  assert.deepEqual([a.workflow, a.scope], ['realize', 'fix']);
  assert.match(a.reason, /You denied HS: "add must reject strings"[\s\S]*fix round/);
  const after = load();
  assert.deepEqual(after.fix.tasks, ['T1', 'T2'], 'every task reopened');
  assert.deepEqual(after.fix.human_findings.map((f) => f.summary), ['add must reject strings']);
  const shown = F.cli(root, ['task', 'show', 'T1']);
  assert.ok(shown.fix_findings.some((f) => f.id === 'human-1' && f.summary === 'add must reject strings' && f.shared), JSON.stringify(shown.fix_findings));
  // once its fix round ran, the same build shows HS again (no loop)
  ctx = core('steps').context(root, load(), core('job').load);
  assert.equal(core('decision-table').deniedShip(ctx), null);
});

test('scope drift: changes into a protected path are reverted on the job branch by the CLI (never widened), and the record says so', () => {
  const root = F.makeRepo();
  const J = grounded(root, { ac: '- AC-1: add(2, 3) returns 5 (evidence: test)' });
  F.cli(root, ['plan', 'from-contract']);
  next(root);
  build(root, J, { 'src/add.js': 'module.exports = (a, b) => a + b;\n' });
  const wt = path.join(root, '.factory', 'worktrees', J);
  F.write(wt, '.github/workflows/x.yml', 'on: push\n');
  F.sh(wt, 'git add -A && git commit -qm "sneak a workflow"');
  const n = next(root);
  assert.match(n.command || '', /verify run/, JSON.stringify(n).slice(0, 300));
  const st = stateOf(root, J);
  assert.deepEqual(st.scope_reverts[0].files, ['.github/workflows/x.yml']);
  assert.ok(!fs.existsSync(path.join(wt, '.github/workflows/x.yml')));
  assert.match(F.sh(wt, 'git log -1 --format=%B'), /factory: revert changes outside the allowed paths/);
});

test('push approval and draft PRs: at low/medium a PR the drive opens on its own is a draft and only after the repo opted in (policy ship.auto_pr "draft"); "approve ship" is the human\'s go', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  const ship = core('ship');
  let st = core('job').load(root, J);
  const ctx = { b: { fingerprint: 'fp1' } };
  assert.equal(ship.wantsDraft(root, st, ctx, null), false, 'no opt-in: not an automatic draft');
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ ship: { auto_pr: 'draft' } }));
  assert.equal(ship.wantsDraft(root, st, ctx, null), true, 'opted in: the drive\'s PR is a draft');
  st.ship_approval = { fingerprint: 'fp1' };
  assert.equal(ship.wantsDraft(root, st, ctx, null), false, 'the human approved this build: a normal PR');
  st.risk = 'high';
  st.ship_approval = null;
  assert.equal(ship.wantsDraft(root, st, ctx, null), false, 'high risk: HS is the approval');
  // approve ship is a human-only reply, bound to the build
  assert.deepEqual(core('human').parseReply('approve ship'), { cmd: 'approve_ship', jobId: undefined });
  assert.equal(F.cli(root, ['approve', 'ship']).code, 'human_only');
  st = core('job').load(root, J);
  assert.ok(!st.ship_approval);
});

test('the end-of-job digest: lessons and brief proposals in one stop with one batch reply; factory inbox lists proposed lessons next to briefs', () => {
  const d = core('drive').stopDetail('done', { job: 'J-0001', reason: 'closed' }, { job: 'J-0001', lessons: [{ id: 'L4', text: 'x' }, { id: 'L5', text: 'y' }], briefs: [{ id: 'P1' }] });
  assert.equal(d.digest.reply, 'accept lesson L4; accept lesson L5; accept brief P1');
  assert.ok(core('human').parseBatch(d.digest.reply), 'the suggested reply is one exact batch');
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  core('lessons').add(root, { jobId: J, text: 'In src/**, check argument types before use.', scope: 'src/**', why: 'code-1' });
  const items = F.cli(root, ['inbox']).items.filter((x) => x.kind === 'lesson');
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].reply, ['accept lesson L1', 'reject lesson L1 <why>']);
});

test('a router loop\'s diagnosis runs as fanout-judge --config diagnose: God Eye with focus diagnosis; the workflow returns its answer for factory record', async () => {
  const H = require('./helpers/workflow-harness');
  const brief = { workflow: 'fanout-judge', config: 'diagnose', mode: 'review', job: 'J-0001', input_hash: 'h', fanout: [], judge: { agent_type: 'factory:god-eye', prompt: 'diagnose', schema: {} }, critique: null, verifier: null };
  const d = { cause: 'c', needs_user: true, approach: '', question: 'q?', options: [{ key: 'a', text: 'x' }], recommendation: 'a' };
  const { result, calls } = await H.run(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), brief, async () => d);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.agentType, 'factory:god-eye');
  assert.deepEqual(result.data, { loop: 'review', diagnosis: d });
  assert.equal(result.status, 'ok');
  // a carried finding's verifier: the stronger model and the reproduce note
  const cb = { workflow: 'fanout-judge', config: 'challenge', job: 'J-0001', input_hash: 'h', fingerprint: 'f', fanout: [{ id: 'code', agent_type: 'factory:code-reviewer', label: 'review · code', prompt: 'review' }], judge: null, critique: null, carried: [{ id: 'code-1', from_round: 1, severity: 'major' }], verifier: { agent_type: 'factory:finding-verifier', prompt_template: 'verify {{finding}}', severities: ['blocker', 'major'], reverify_scale: 2, carried_model: 'opus', carried_note: 'You are the second verifier.' } };
  const r2 = await H.run(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), cb, async (p, o) => (o.agentType === 'factory:code-reviewer' ? { lane: 'code', findings: [] } : { finding_id: 'code-1', status: 'unverifiable', evidence: 'e', reason: 'r' }));
  const v = r2.calls.find((c) => c.opts.agentType === 'factory:finding-verifier');
  assert.equal(v.opts.model, 'opus');
  assert.match(v.prompt, /You are the second verifier/);
});
