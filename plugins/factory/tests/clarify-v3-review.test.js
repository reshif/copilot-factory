'use strict';
// Clarify v3, the release review: the user's guarantees attacked one by one (a reply that mixes
// ok with answers, a hand edit that deletes an acceptance criterion, a redirect at H1 that names
// another version than the pin, a God Eye that never runs out of things to ask, a job upgraded
// mid-clarify from v2, a record edited by hand), plus the v2/0.6.1 guarantees whose tests went
// with the v2 suites (writer removals, web off by policy, an unexplained "false" on God Eye's
// checklist, answers after H1, the search tool, design's hand-over).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');
const C = require('../cli/core/clarify');
const { drive } = require('./helpers/clarify3-drive');

const NB = 'https://docs.nautobot.com/projects/core/en';
const quiet = { log: process.env.CLARIFY_ACCEPTANCE_VERBOSE ? (m) => process.stderr.write(`${m}\n`) : () => {} };

function job({ risk = 'low', request = 'fix add so the cart totals add up; negative numbers must work too', policy = null } = {}) {
  const root = F.makeRepo();
  if (policy) {
    // before the job: a job keeps the policy it was created with
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

// Drives clarify with scripted stage outputs; `writer(text, data)` may change what the writer
// returns; `check(n)` gives God Eye's objections for the n-th check. Stops at a wait when
// `reply` returns null, at H1, or at a park.
function run(root, J, { readback, writer, redirect, check = () => [], reply = () => 'ok', stopAt = [], results = [], max = 30, dispute = null, diagnosis = null } = {}) {
  const JD = F.jobDir(root, J);
  let checks = 0;
  for (let i = 0; i < max; i++) {
    const n = F.cli(root, ['next']);
    if (!(n.action === 'skill' && n.skill === 'clarify')) return n;
    const c = n.clarify || {};
    if (c.waiting_for_user) {
      const said = reply(c.stage, c.screen, record(root, J));
      if (said === null) return n;
      const r = F.cli(root, ['clarify', 'reply', said]);
      if (r.error) throw new Error(JSON.stringify(r));
      continue;
    }
    if (stopAt.includes(c.stage)) return n;
    const brief = F.cli(root, ['wfargs', 'clarify']);
    if (brief.error) throw new Error(JSON.stringify(brief));
    const d = record(root, J);
    const text = fs.readFileSync(path.join(JD, 'contract.md'), 'utf8');
    const w = writer && brief.stage === 'assemble' ? writer(text, d) : { contract: text };
    const objections = brief.stage === 'check' ? check(++checks, d) : [];
    const outputs = {
      readback: { 'read-back': readback || { intent: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, scope: { in: [], out: [] }, took: [{ item: 'new', text: 'Negative numbers must work', quote: 'negative numbers must work too' }], pins: [], plan: [], questions: [], design_may_choose: [] } },
      assemble: { contract: { covers: d.items.map((x) => ({ item: x.id, where: x.kind === 'fact' && /negative/i.test(x.text) ? 'AC-2' : 'Goal' })), uncovered: [], ...w } },
      check: { readiness: { verdict: objections.some((o) => o.severity === 'blocker') ? 'blocked' : 'ready', checklist: { ...READY, ...Object.fromEntries(objections.map((o) => [o.check, false])) }, objections } },
      // a redirect read as one clause per sentence, linked to nothing; research that finds nothing
      redirect: { redirect: redirect || { clauses: C.sentences((d.redirects[d.redirects.length - 1] || {}).text || '').map((q) => ({ quote: q, item: 'new', action: 'instruction', text: q })) } },
      // prose on the sheet read as "as you recommend" for every open decision, quoting the reply
      interpret: brief.stage !== 'interpret' ? null : { interpret: (() => { const s = d.sheets[d.sheets.length - 1]; const w = d.words.find((x) => x.id === d.pending_reply) || { text: '' }; return { answers: s.decisions.filter((x) => !x.answered).map((x) => ({ decision: x.no, choice: 'recommended', text: '', quote: w.text })), facts: [], unclear: [] }; })() },
      research: Object.fromEntries([...brief.groups.flat().filter((a) => a.label !== 'research brief').map((a) => [a.label, { mode: a.mode, evidence: [], unresolved: [] }]), ['research brief', { summary: 'nothing found', records: [], facts: [], gaps: [] }]]),
      // the readiness loop's tie-break and diagnosis (0.9.0)
      dispute: Object.fromEntries(brief.groups.flat().map((a) => [a.label, dispute ? dispute(a, d) : { finding_id: 'x', status: 'confirmed', evidence: 'contract.md', reason: 'it holds' }])),
      diagnose: { diagnosis: diagnosis ? diagnosis(d) : { cause: 'the same objection every round', needs_user: false, approach: '', question: '', options: [], recommendation: '' } },
    }[brief.stage];
    if (!outputs) throw new Error(`no script for ${brief.stage}`);
    const r = F.record(root, F.envelope(brief, 'ok', { stage: brief.stage, rev: brief.rev, outputs }));
    results.push(r);
    if (r.status === 'park') return F.cli(root, ['next']);
  }
  throw new Error('max steps');
}

// ---------------------------------------------------------------- 1. the user's words
test('sheet replies that mix ok with answers: every part applied as said, or the whole reply goes to the interviewer; never half-read words recorded as the user\'s', () => {
  const sheet = { decisions: [1, 2, 3].map((no) => ({ no, options: [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }], recommendation: 'a' })), facts: [{ no: 1, text: 'f' }] };
  const p = (t) => C.parseSheetReply(t, sheet);
  assert.deepEqual(p('ok but 2 b and 3 defer'), { accept: true, answers: [{ no: 2, choice: 'b' }, { no: 3, defer: true }], facts: [] }, 'the user\'s "3 defer" is not overridden by the ok');
  assert.deepEqual(p('2 b, otherwise ok'), { accept: true, answers: [{ no: 2, choice: 'b' }], facts: [] });
  assert.deepEqual(p('2 b; the rest as recommended'), { accept: true, answers: [{ no: 2, choice: 'b' }], facts: [] });
  assert.deepEqual(p('1 a 2 b').answers, [{ no: 1, choice: 'a' }, { no: 2, choice: 'b' }]);
  assert.deepEqual(p('1a, 2b').answers, [{ no: 1, choice: 'a' }, { no: 2, choice: 'b' }]);
  assert.deepEqual(p('ok, fact 1: we use Netmiko, 2 b'), { accept: true, answers: [{ no: 2, choice: 'b' }], facts: [{ no: 1, text: 'we use Netmiko' }] });
  assert.deepEqual(p('ok, but 2: log it, never rename').answers, [{ no: 2, text: 'log it, never rename' }], 'words after "2:" are the user\'s own');
  // ambiguous: the interviewer reads it (one call, every mapping quoted), nothing is guessed here
  for (const t of ['2: b please', 'yes but 3 is b', '2 b please', '2 a, 2 b', '3: keep 2 a week', '2 report only']) assert.equal(p(t), null, t);
  // "proceed" is the human-only park verb, never an ok
  assert.equal(p('proceed'), null);
  assert.equal(C.ACCEPT.test('proceed'), false);
});

test('a redirect keeps every part of the user\'s words: what no clause quotes becomes its own tracked instruction, even inside a sentence', () => {
  const data = { redirects: [{ id: 'R-1', text: 'research the 2.4 scoping docs, and decide how credentials are supplied. Also keep the README short', status: 'interpreting', clauses: [] }], items: [], history: [] };
  C.applyRedirect(data, { clauses: [{ quote: 'research the 2.4 scoping docs', item: 'new', action: 'research', text: 'scoping' }] });
  assert.deepEqual(data.redirects[0].clauses.map((c) => [c.action, c.quote, Boolean(c.unread)]), [
    ['research', 'research the 2.4 scoping docs', false],
    ['instruction', 'decide how credentials are supplied', true],
    ['instruction', 'keep the README short', true],
  ]);
});

test('the user\'s words relayed by the main session are marked as relayed at H1 and in status (the factory cannot tell them from the user\'s own)', () => {
  const { root, J } = job({ policy: { clarify: { readback: 'wait' } } });
  const n = run(root, J);
  assert.equal(n.step, 'H1');
  const v = n.clarify_h1;
  assert.ok(v.words.relayed.some((w) => w.via === 'request'), 'the request came through job new --request');
  assert.ok(v.words.relayed.some((w) => w.via === 'reply' && w.text === 'ok'), 'the read-back ok came through clarify reply');
  assert.ok(v.checked.some((c) => c.relayed && /negative numbers/.test(c.quote)));
  assert.match(v.screen, /reached the factory through the assistant/);
  assert.match(F.cli(root, ['clarify', 'status']).raw, /relayed them/);
});

// ---------------------------------------------------------------- 2. versions
test('verdicts: a page that names no system is judged against the pins; a moving page or a page outside the repo\'s range never confirms a ranged system', () => {
  const root = F.makeRepo();
  const data = { items: [{ id: 'I-1', kind: 'fact', pins: [] }, { id: 'I-2', kind: 'pin', system: 'nautobot', status: 'open', allows: [{ range: '>=2.0,<4.0' }] }], evidence: [] };
  const v = (e, pins) => C.verdictOf(root, { item: 'I-1', tier: null, quote: 'q', ...e }, pins, data);
  assert.equal(v({ source: `${NB}/stable/x/` }, { nautobot: '2.4.x' }), 'unpinned', 'a migrated /stable/ finding with no system');
  assert.equal(v({ source: `${NB}/v3.0/x/` }, { nautobot: '2.4.x' }), 'other_version');
  assert.equal(v({ source: `${NB}/v3.0/x/`, system: 'Nautobot' }, { nautobot: '2.4.x' }), 'other_version', 'system names compare without case');
  assert.equal(v({ source: `${NB}/v2.4.x/x/`, system: 'Nautobot' }, { nautobot: '2.4.x' }), 'pinned');
  assert.equal(v({ source: 'https://flask-limiter.readthedocs.io/en/3.5.0/', system: 'flask-limiter' }, { flask: '2.3.3' }), 'docs', 'another system is not judged against a pin');
  // no exact pin, only the repository's range
  assert.equal(v({ source: `${NB}/stable/x/` }, {}), 'unpinned');
  assert.equal(v({ source: `${NB}/v4.1/x/` }, {}), 'other_version');
  assert.equal(v({ source: `${NB}/v2.4.x/x/` }, {}), 'docs');
});

test('(av) a redirect at H1 that names another version than the pin: read back, re-pinned, every finding judged again, the decisions that rested on the old version researched again', () => {
  const acc = fs.readFileSync(path.join(__dirname, 'clarify-v3-acceptance.test.js'), 'utf8');
  // the J-0001 scenario's repository and request, as the acceptance suite defines them
  const A = eval(`(() => { ${acc.slice(acc.indexOf('const A = {'), acc.indexOf("test('(a)"))}; return A; })()`); // eslint-disable-line no-eval
  const rec = drive({ ...A, crew: 'av', sheet: (s, v, n) => require('./helpers/clarify3-crew').SCENARIOS.av.sheet(s, v, n), gate: (n) => (n === 1 ? { deny: 'we actually run Nautobot 2.3.x, not 2.4' } : { approve: true }) }, quiet);
  assert.equal(rec.end.action, 'approved', JSON.stringify(rec.end));
  const pins = rec.ledger.items.filter((x) => x.kind === 'pin' && x.status === 'decided');
  assert.deepEqual(pins.map((p) => [p.system, p.value]), [['nautobot', '2.3.x']], 'the pin is a version, never the clause text');
  // the version change was read back before anything was researched against it (the first
  // read-back is shown, not waited on: nothing on it needed the user)
  const rb = rec.screens.filter((s) => s.stage === 'readback_wait');
  assert.equal(rb.length, 1);
  assert.match(rb[0].screen, /2\.3\.x/);
  // no finding for 2.4 counts any more; the scoping decision was researched on 2.3 pages
  const ev = rec.ledger.evidence;
  assert.ok(ev.filter((e) => /v2\.4\.x/.test(e.source)).every((e) => e.verdict === 'other_version'), JSON.stringify(ev.map((e) => [e.source, e.verdict])));
  const scoping = rec.ledger.items.find((x) => x.kind === 'decision' && /scoping model/i.test(x.text));
  assert.equal(scoping.status, 'decided');
  assert.ok(scoping.evidence.some((id) => /v2\.3\.x/.test((ev.find((e) => e.id === id) || {}).source)), 'decided on the 2.3 docs');
  assert.ok((scoping.history || []).some((h) => h.event === 'reopened' && /another version/.test(h.text || '')));
  // the contract and H1 follow the user's version; the clause is reported done
  assert.match(rec.contract, /Nautobot 2\.3\.x/);
  assert.doesNotMatch(rec.contract.replace(/## (Research gaps|Decisions)[\s\S]*?(?=\n## |$)/g, ''), /v2\.4\.x/);
  const last = rec.h1[rec.h1.length - 1].h1;
  const clause = last.redirects[0].clauses[0];
  assert.equal(clause.done, true, JSON.stringify(clause));
  assert.match(clause.how, /nautobot 2\.3\.x/);
});

// ---------------------------------------------------------------- 3. hand edits
test('the user deletes an acceptance criterion by hand at H1: the deterministic checks run again, H1 never shows it as honoured, and the user decides to put it back or leave it out', () => {
  const { root, J, JD } = job();
  assert.equal(run(root, J).step, 'H1');
  const cf = path.join(JD, 'contract.md');
  fs.writeFileSync(cf, fs.readFileSync(cf, 'utf8').replace(/- AC-2:.*\n/, '').replace('(AC-1, AC-2)', '(AC-1)'));
  // the edit is noticed: the item it honoured is no longer covered, and the user is asked
  const n = F.cli(root, ['next']);
  assert.equal(n.skill, 'clarify', JSON.stringify(n).slice(0, 300));
  assert.equal(n.clarify.stage, 'sheet_wait');
  assert.match(n.clarify.screen, /You took AC-2 out of the contract by hand/);
  assert.match(n.clarify.screen, /Leave it out/);
  assert.match(n.clarify.screen, /No recommendation/, 'the user\'s own words are not dropped on a recommendation');
  const fact = record(root, J).items.find((x) => /negative/i.test(x.text));
  assert.equal(fact.covered, null);
  // ok alone does not drop what the user said
  F.cli(root, ['clarify', 'reply', 'ok']);
  assert.equal(record(root, J).stage, 'sheet_wait');
  // the user leaves it out: the item is dropped by them, with the reason, and H1 says so
  const s = record(root, J).sheets.pop();
  F.cli(root, ['clarify', 'reply', `${s.decisions[0].no} b`]);
  const h = run(root, J);
  assert.equal(h.step, 'H1', JSON.stringify(h).slice(0, 300));
  const after = record(root, J).items.find((x) => x.id === fact.id);
  assert.equal(after.status, 'dropped');
  assert.ok(h.clarify_h1.dropped.some((d) => /dropped by user \(hand edit\)/.test(d)), JSON.stringify(h.clarify_h1.dropped));
  assert.ok(!h.clarify_h1.checked.some((c) => c.ok && c.where === 'AC-2'), 'no ✓ for an AC that is gone');
  assert.ok(h.clarify_h1.hand_edits >= 1);
  assert.match(h.clarify_h1.screen, /You edited the contract by hand/);
});

test('a hand edit that breaks a deterministic check after the readiness check passed goes back before God Eye runs', () => {
  const { root, J, JD } = job();
  assert.equal(run(root, J).step, 'H1');
  const cf = path.join(JD, 'contract.md');
  // the user adds a criterion no verify command covers
  fs.writeFileSync(cf, fs.readFileSync(cf, 'utf8').replace('- AC-2:', '- AC-3: add(0.1, 0.2) is 0.3 to 10 places (evidence: test)\n- AC-2:'));
  const n = F.cli(root, ['next']);
  assert.equal(n.clarify.stage, 'assemble', 'straight back to the writer: God Eye was not spent');
  const d = record(root, J);
  const last = d.checks[d.checks.length - 1];
  assert.equal(last.checklist, null);
  assert.ok(last.deterministic.some((b) => /AC-3 needs test/.test(b.why)));
});

test('a hand edit while research runs does not throw the research away; the writer is told to keep the edit', () => {
  const { root, J, JD } = job({ risk: 'low' });
  const cf = path.join(JD, 'contract.md');
  const readback = { intent: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, scope: { in: [], out: [] }, took: [], pins: [], plan: [{ item: 'new', what: 'Where add lives', tag: 'repo', pins: [], impact: 'high' }], questions: [], design_may_choose: [] };
  run(root, J, { readback, stopAt: ['research'] });
  const brief = F.cli(root, ['wfargs', 'clarify']);
  assert.equal(brief.stage, 'research');
  fs.appendFileSync(cf, '\n<!-- the user\'s note -->\n');
  const P = record(root, J).plan[0].id;
  const r = F.record(root, F.envelope(brief, 'ok', { stage: 'research', rev: brief.rev, outputs: { 'research · repo': { mode: 'repo', evidence: [{ plan: P, claim: 'add is in src/add.js', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports = (a, b) => a - b;', confidence: 'high' }], unresolved: [] }, 'research brief': { summary: 's', records: [], facts: [{ plan: P, statement: 'add is in src/add.js', evidence: ['src/add.js:1'] }], gaps: [] } } }));
  assert.notEqual(r.status, 'stale', JSON.stringify(r).slice(0, 300));
  assert.equal(record(root, J).research.passes.length, 1);
});

test('the writer cannot drop an acceptance criterion, constraint or non-goal without saying which item, blocker or redirect it rests on', () => {
  const { root, J } = job();
  let attempt = 0;
  const results = [];
  const drop = (text) => text.replace(/- AC-2:.*\n/, '').replace('(AC-1, AC-2)', '(AC-1)');
  const explained = (d) => ({ removed: [{ ref: 'AC-2', text: 'add(-1, -2) returns -3', because: 'Non-goals', why: 'God Eye asked' }], covers: d.items.map((x) => ({ item: x.id, where: 'Goal' })) });
  const h = run(root, J, {
    results,
    check: (k) => (k === 1 ? [{ check: 'scope_bounded', severity: 'blocker', stage: 'assemble', ref: 'Non-goals', issue: 'say what is out', fix: 'add a non-goal' }] : []),
    writer: (text, d) => {
      attempt += 1;
      if (attempt === 1) return { contract: text };
      // the second version drops AC-2 silently (refused), the third explains it
      return attempt === 2 ? { contract: drop(text) } : { contract: drop(text), ...explained(d) };
    },
  });
  // refused, and the refusal is a finding the writer can fix: an automatic round fixed it, no park
  assert.ok(results.some((r) => /drops AC-2 with no reason/.test(r.refused || '')), JSON.stringify(results.map((r) => [r.stage, r.status, r.refused])));
  assert.ok(!results.some((r) => r.status === 'park'), 'no park: the writer could fix it');
  assert.equal(h.step, 'H1', JSON.stringify(h).slice(0, 300));
  assert.equal(attempt, 3);
  assert.doesNotMatch(fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8'), /- AC-2:/, 'written once explained');
  assert.ok(h.clarify_h1.removed.some((x) => /^AC-2 \(add\(-1, -2\) returns -3\): because Non-goals/.test(x)), JSON.stringify(h.clarify_h1.removed));
  assert.match(h.clarify_h1.screen, /Taken out of the contract/);
});

test('a writer that keeps dropping a criterion silently: the loop engine stops on no progress (stronger model, diagnosis first) and H1 shows the refusal open, never a park', () => {
  const { root, J } = job();
  const results = [];
  let attempt = 0;
  const n = run(root, J, {
    results,
    check: (k) => (k === 1 ? [{ check: 'scope_bounded', severity: 'blocker', stage: 'assemble', ref: 'Non-goals', issue: 'say what is out', fix: 'add a non-goal' }] : []),
    writer: (text) => (++attempt === 1 ? { contract: text } : { contract: text.replace(/- AC-2:.*\n/, '').replace('(AC-1, AC-2)', '(AC-1)') }),
  });
  assert.equal(n.step, 'H1', JSON.stringify(n).slice(0, 400));
  assert.ok(!results.some((r) => r.status === 'park'), 'no park');
  // the first version, then rounds while nothing shrank: two on the writer's model, one on the
  // stronger one, one after the diagnosis
  assert.equal(attempt, 5);
  const d = record(root, J);
  assert.equal(d.loop_end.rule, 'no_progress');
  assert.ok(d.writer_loop.diagnosis, 'the diagnosis ran before the loop ended');
  assert.equal(d.writer_loop.model, 'opus');
  assert.match(fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8'), /- AC-2:/, 'never written: nothing left silently');
  const v = n.clarify_h1;
  assert.equal(v.approved, false);
  assert.ok(v.god_eye_objects.some((o) => /drops AC-2 with no reason/.test(o)), JSON.stringify(v.god_eye_objects));
  assert.ok(v.god_eye_objects.some((o) => /say what is out/.test(o)), 'the blocker its text was meant to fix still stands');
  assert.match(v.screen, /The readiness loop ended\*\* \(no_progress/);
});

// ---------------------------------------------------------------- 4. loops and parks
test('an ok on a decision with no recommendation: the sheet says so once, a second ok hands it to design (never an endless re-show)', () => {
  const { root, J } = job();
  const readback = { intent: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, scope: { in: [], out: [] }, took: [], pins: [], plan: [], questions: [{ item: 'new', question: 'Who reviews the totals?', why: 'only you know' }], design_may_choose: [] };
  const screens = [];
  const n = run(root, J, { readback, reply: (stage, screen) => { screens.push(screen); return 'ok'; } });
  assert.equal(n.step, 'H1', JSON.stringify(n).slice(0, 300));
  const sheets = screens.filter((s) => /\*\*Decisions/.test(s));
  assert.equal(sheets.length, 2, 'shown, then shown once more with the warning');
  assert.match(sheets[1], /reply \*\*ok\*\* again and design decides/);
  const q = record(root, J).items.find((x) => /reviews the totals/.test(x.text));
  assert.deepEqual([q.status, q.owner], ['deferred', 'design']);
  assert.ok(q.history.some((h) => /ok twice/.test(h.text || '')));
  assert.ok(n.clarify_h1.design_may_choose.includes('Who reviews the totals?'));
});

test('prose read as "as you recommend" on a decision with no recommendation counts as an ok: the second time design decides it (the upgraded J-0002 shape looped here)', () => {
  const { root, J } = job();
  const readback = { intent: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, scope: { in: [], out: [] }, took: [], pins: [], plan: [], questions: [{ item: 'new', question: 'Who reviews the totals?', why: 'only you know' }], design_may_choose: [] };
  let sheets = 0;
  const n = run(root, J, { readback, reply: (stage) => (stage === 'sheet_wait' ? (sheets++, "whatever's standard") : 'ok') });
  assert.equal(n.step, 'H1', JSON.stringify(n).slice(0, 300));
  assert.equal(sheets, 2);
  const q = record(root, J).items.find((x) => /reviews the totals/.test(x.text));
  assert.deepEqual([q.status, q.owner], ['deferred', 'design']);
});

test('a God Eye that keeps sending new decisions to the sheet: past the readiness cycle ceiling the contract goes to H1 with the objections open, never a park', () => {
  const { root, J } = job();
  const n = run(root, J, {
    check: (k) => [{ check: 'decisions_closed', severity: 'blocker', stage: 'sheet', ref: 'contract', issue: `Who owns the totals? (${k})`, fix: 'ask' }],
    reply: (stage, screen, d) => (stage === 'sheet_wait' ? `${d.sheets[d.sheets.length - 1].decisions.find((x) => !x.answered).no}: the finance team` : 'ok'),
  });
  assert.equal(n.step, 'H1', JSON.stringify(n).slice(0, 300));
  const d = record(root, J);
  assert.equal(d.checks.length, 4);
  assert.equal(d.loop_end.rule, 'readiness_cycles');
  assert.ok(!d.parked);
  assert.equal(n.clarify_h1.approved, false);
  assert.ok(n.clarify_h1.god_eye_objects.some((o) => /Who owns the totals/.test(o)));
  assert.match(n.clarify_h1.screen, /The readiness loop ended\*\* \(readiness_cycles/);
});

test('words sent while clarify is parked are stored, never refused; the user\'s own reply resumes it with them (read back as a redirect); proceed stays the user\'s', () => {
  const { root, J } = job();
  // God Eye's agent fails twice: the one clarify park left (an agent that returned nothing)
  run(root, J, { stopAt: ['check'] });
  const brief = F.cli(root, ['wfargs', 'clarify']);
  const r0 = F.record(root, F.envelope(brief, 'degraded', { stage: 'check', rev: brief.rev, outputs: {} }));
  assert.equal(r0.status, 'park');
  assert.equal(F.cli(root, ['next']).action, 'parked');
  // relayed by the main session: stored, not refused, and the job stays parked (resume is the user's)
  for (const words of ['go on with the gaps', 'also cover zero']) {
    const r = F.cli(root, ['clarify', 'reply', words]);
    assert.equal(r.stored, true, JSON.stringify(r));
    assert.ok(!r.error);
  }
  assert.equal(F.cli(root, ['clarify', 'redirect', 'also do subtraction']).stored, true);
  assert.equal(F.cli(root, ['job', 'show']).status, 'parked');
  assert.equal(record(root, J).parked_words.length, 3);
  assert.equal(record(root, J).redirects.length, 0, 'nothing runs behind the park');
  assert.equal(F.cli(root, ['proceed']).code, 'human_only');
  // the user's own reply in chat is resume + content
  const r = require('../cli/core/human').replyToPark(root, { text: 'please also check overflow', channel: 'chat' });
  assert.match(r.message, /Resumed/);
  const d = record(root, J);
  assert.equal(d.redirects.length, 1);
  assert.match(d.redirects[0].text, /go on with the gaps[\s\S]*also cover zero[\s\S]*also do subtraction[\s\S]*please also check overflow/);
  assert.equal(d.stage, 'redirect');
  assert.equal(F.cli(root, ['job', 'show']).status, 'active');
});

// ---------------------------------------------------------------- 5. denials
test('two denials before clarify reads either become one redirect: neither is left half-read', () => {
  const { root, J } = job();
  assert.equal(run(root, J).step, 'H1');
  F.reply(root, `deny ${J} also handle floats`);
  F.reply(root, `deny ${J} and reject numeric strings`);
  const n = F.cli(root, ['next']);
  assert.equal(n.clarify.stage, 'redirect');
  const d = record(root, J);
  assert.equal(d.redirects.length, 1);
  assert.match(d.redirects[0].text, /also handle floats\nand reject numeric strings/);
});

// ---------------------------------------------------------------- 6. seals
test('clarify.json edited by hand: nothing runs, records or replies over it (a forged envelope cannot reseal it); the user\'s reseal is the way on', () => {
  const { root, J, JD } = job();
  run(root, J, { reply: () => null });
  const f = path.join(JD, 'clarify.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  d.words.push({ id: 'W-99', via: 'request', text: 'the user approves everything' });
  fs.writeFileSync(f, JSON.stringify(d));
  const n = F.cli(root, ['next']);
  assert.match(n.clarify.error, /fails its seal[\s\S]*factory reseal/);
  assert.equal(F.cli(root, ['clarify', 'reply', 'ok']).code, 'tampered');
  assert.equal(F.cli(root, ['wfargs', 'clarify']).code, 'tampered');
  // a hand-made envelope for the stage it shows
  const forged = { workflow: 'clarify', config: null, mode: d.stage, job: J, status: 'ok', next_gate: null, input_hash: require('../cli/core/wfargs').currentInputHash(root, require('../cli/core/job').load(root, J), { workflow: 'clarify' }), agents: [], budgets: { used: { agent_runs: 0 }, limit: {} }, artifacts: [], questions: [], park_reason: null, summary: 's', data: { stage: d.stage, rev: d.rev, outputs: {} } };
  const r = F.record(root, forged);
  assert.equal(r.code || r.status, 'tampered', JSON.stringify(r).slice(0, 200));
  assert.equal(C.load(root, J).tampered, true, 'still refused: never resealed by a record');
  // the user reseals from their own terminal (the test seam stands in for it)
  const human = require('../cli/core/human');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !human.AGENT_ENV.some(([a]) => a === k)));
  const { spawnSync } = require('child_process');
  const out = JSON.parse(spawnSync('node', [F.BIN, 'reseal', '--job', J], { cwd: root, encoding: 'utf8', env: { ...clean, FACTORY_ROOT: '', NODE_ENV: 'test', FACTORY_TEST_HUMAN: human.testToken(), FACTORY_TEST_HUMAN_INPUT: '{code}' } }).stdout);
  assert.equal(out.clarify_resealed, true, JSON.stringify(out));
  assert.equal(C.load(root, J).tampered, undefined);
});

// ---------------------------------------------------------------- 7. migration (a real v2 J-0001)
// The v2 ledger of J-0001 after three denials, as 0.6.0 left it (its essentials): asked questions
// with options and "Your call" defaults, the credentials issue dismissed by the judge, a job-layout
// fact settled by a /stable/ (3.x) page that names no system.
function v2J0001(J) {
  const h = (event, actor, text) => ({ round: 1, event, actor, ...(text ? { text } : {}) });
  return {
    version: 2, job: J, rounds: [{ round: 1 }, { round: 2 }, { round: 3 }],
    unknowns: [
      { id: 'U-1', text: 'Which Nautobot version does this repository target?', kind: 'repo', impact: 'high', status: 'settled', settled_by: 'user', answer: '2.4.x', evidence: ['E-1'], history: [h('opened', 'mapper')] },
      { id: 'U-2', text: 'Which Cisco platforms must the job support?', kind: 'user', impact: 'high', status: 'proposed', options: ['IOS / IOS-XE only', 'IOS / IOS-XE / NX-OS', 'All Cisco incl. IOS-XR'], default: 'Your call: IOS / IOS-XE only', evidence: [], history: [h('opened', 'mapper')] },
      { id: 'U-3', text: 'How should synced VLANs be scoped?', kind: 'decision', impact: 'high', status: 'proposed', options: ['Global', 'Per Location', 'Per VLAN Group'], default: 'Per VLAN Group', evidence: [], history: [h('opened', 'mapper')] },
      { id: 'U-6', text: 'How must a Job be laid out to be loaded from a Git repository?', kind: 'world', impact: 'high', status: 'settled', settled_by: 'evidence', assumption: 'A-1', evidence: ['E-2'], history: [h('opened', 'mapper')] },
      { id: 'U-7', text: 'How does the job obtain device credentials?', kind: 'decision', impact: 'medium', status: 'dropped', note: 'dismissed by the judge: README will cover it', evidence: [], history: [h('opened', 'mapper'), h('dropped', 'judge', 'Out of scope for the contract: the README will cover it')] },
    ],
    evidence: [
      { id: 'E-1', claim: 'pyproject allows >=2.0,<4.0', source: 'pyproject.toml:7', quote: 'nautobot = ">=2.0,<4.0"', scout: 'repo', source_tier: 'repo' },
      { id: 'E-2', claim: 'Jobs register from jobs/__init__.py with register_jobs', source: `${NB}/stable/development/jobs/`, quote: 'register_jobs(...)', scout: 'web', source_tier: 'official' },
    ],
    assumptions: [{ id: 'A-1', unknown: 'U-6', statement: 'Jobs register from jobs/__init__.py with register_jobs', evidence: ['E-2'] }],
  };
}

test('migration of a real v2 J-0001: options and real defaults kept, the judge\'s reason kept, a 3.x page never confirms 2.4, every denial since the last approval read back, and the upgraded job reaches H1 without looping', () => {
  const { root, J, JD } = job({ request: 'Nautobot VLAN sync' });
  require('../cli/core/intent').save(root, J, v2J0001(J));
  fs.writeFileSync(path.join(JD, 'pyproject.toml'), '');
  F.write(root, 'pyproject.toml', '[tool.poetry.dependencies]\npython = ">=3.9"\nnautobot = ">=2.0,<4.0"\n');
  const jobs = require('../cli/core/job');
  const st = jobs.load(root, J);
  st.denials = [
    { gate: 'H1', at: '2026-10-02T09:00:00.000Z', reason: 'research the 2.4 scoping docs' },
    { gate: 'H1', at: '2026-10-02T10:00:00.000Z', reason: 'decide how device credentials are supplied' },
    { gate: 'H1', at: '2026-10-02T11:00:00.000Z', reason: 'base the test approach on Nautobot 2.4, not 3.x' },
  ];
  jobs.save(root, st);
  F.cli(root, ['next']);
  F.cli(root, ['wfargs', 'clarify'], { allowFail: false });
  const d = record(root, J);
  const by = (v2) => d.items.find((it) => it.v2_id === v2);
  assert.deepEqual(by('U-2').options.map((o) => o.text), ['IOS / IOS-XE only', 'IOS / IOS-XE / NX-OS', 'All Cisco incl. IOS-XR']);
  assert.equal(by('U-2').recommendation, null, '"Your call" was never a recommendation');
  assert.equal(by('U-3').recommendation, 'c', 'a default that names an option is kept as the recommendation');
  const drop = by('U-7').history.find((x) => x.event === 'dropped');
  assert.deepEqual([drop.actor, drop.text], ['judge (clarify v2)', 'Out of scope for the contract: the README will cover it']);
  assert.equal(d.redirects.length, 1);
  for (const r of ['research the 2.4 scoping docs', 'decide how device credentials are supplied', 'base the test approach on Nautobot 2.4, not 3.x']) assert.ok(d.redirects[0].text.includes(r), r);
  assert.match(d.migration.summary, /your 3 denials since the last approval are R-1/);
  // the read-back pins 2.4.x from the user's own answer; the /stable/ page then confirms nothing
  const readback = { intent: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, scope: { in: [], out: [] }, took: [], pins: [{ system: 'nautobot', version: '2.4.x', source: 'user', quote: '2.4.x' }], plan: [], questions: [], design_may_choose: [] };
  const n = run(root, J, {
    readback,
    reply: (stage, screen, rec) => {
      if (stage === 'redirect_wait') return 'ok';
      if (stage === 'sheet_wait') return 'ok';
      return 'ok';
    },
    writer: (text) => ({ contract: text }),
  });
  const after = record(root, J);
  const e2 = after.evidence.find((e) => e.migrated_from === 'E-2');
  assert.equal(e2.verdict, 'unpinned', 'the 3.x page does not confirm a fact for 2.4');
  assert.notEqual(after.items.find((it) => it.v2_id === 'U-6').strength, 'evidence');
  assert.ok(['H1', undefined].includes(n.step) || n.action === 'parked', JSON.stringify(n).slice(0, 300));
  assert.ok(after.sheets.length <= 4, `${after.sheets.length} sheets: the upgraded job converges`);
});

// ---------------------------------------------------------------- 8. v2/0.6.1 guarantees kept
test('web research off by policy: no docs researcher runs, and the gap says so on the sheet and at H1', () => {
  const { root, J } = job({ policy: { intent_research: { web: false } } });
  const readback = { intent: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, scope: { in: [], out: [] }, took: [], pins: [], plan: [{ item: 'new', what: 'How JavaScript adds floats', tag: 'docs', pins: [], impact: 'high' }], questions: [], design_may_choose: [] };
  run(root, J, { readback, stopAt: ['research'] });
  const brief = F.cli(root, ['wfargs', 'clarify']);
  assert.equal(brief.stage, 'research');
  assert.ok(!brief.groups.flat().some((a) => a.mode === 'docs'), 'no docs researcher');
  const screens = [];
  const h = run(root, J, { reply: (stage, screen) => { screens.push(screen); return 'ok'; } });
  assert.ok(record(root, J).failures.some((f) => f.what === 'the web' && /off by policy/.test(f.reason)));
  assert.ok(screens.some((s) => /off by policy/.test(s)), 'on the sheet');
  assert.equal(h.step, 'H1');
  assert.ok(h.clarify_h1.gaps.some((g) => /off by policy/.test(g.reason)), 'at H1');
});

test('the search tool and the research time box reach the docs researcher\'s brief', () => {
  const { root, J } = job({ risk: 'high', policy: { intent_research: { search_mcp: 'brave-search' } } });
  const readback = { intent: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, scope: { in: [], out: [] }, took: [], pins: [], plan: [{ item: 'new', what: 'How JavaScript adds floats', tag: 'docs', pins: [], impact: 'high' }], questions: [], design_may_choose: [] };
  run(root, J, { readback, stopAt: ['research'] });
  const plan = C.stagePlan(root, require('../cli/core/job').load(root, J));
  const docs = plan.groups.flat().find((a) => a.mode === 'docs');
  assert.equal(docs.input.search_tool, 'brave-search');
  assert.equal(docs.timeout_sec, 15 * 60, 'high risk: 15 minutes');
});

test('God Eye answering a checklist item false without an objection is a blocker, never a silent pass', () => {
  const data = { checks: [], items: [], history: [], contract: {} };
  const rec = C.applyCheck('/nonexistent', { id: 'J-0001' }, data, { checklist: { ...READY, self_consistent: false }, objections: [] }, {});
  assert.equal(rec.ok, false);
  assert.ok(rec.objections.some((o) => o.check === 'self_consistent' && o.severity === 'blocker'));
});

test('after H1 is approved, clarify takes no more words: reply and redirect are refused, factory answer goes to ground\'s questions', () => {
  const { root, J } = job();
  assert.equal(run(root, J).step, 'H1');
  F.reply(root, `approve ${J} H1`);
  assert.equal(F.cli(root, ['clarify', 'reply', '2 b']).code, 'approved');
  assert.equal(F.cli(root, ['clarify', 'redirect', 'also floats']).code, 'approved');
  const a = F.cli(root, ['answer', '--question', 'Which file?', '--answer', 'src/add.js']);
  assert.equal(a.answers, 1, JSON.stringify(a));
  assert.equal(record(root, J).words.filter((w) => /src\/add\.js/.test(w.text)).length, 0);
});

test('what clarify leaves to design reaches ground and decide', () => {
  const { root, J } = job();
  const readback = { intent: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, scope: { in: [], out: [] }, took: [], pins: [], plan: [], questions: [], design_may_choose: ['The error message wording'] };
  assert.equal(run(root, J, { readback }).step, 'H1');
  const text = C.deferredText(root, require('../cli/core/job').load(root, J));
  assert.match(text, /Design may choose[\s\S]*The error message wording/);
});
