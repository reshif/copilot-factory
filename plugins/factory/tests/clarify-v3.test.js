'use strict';
// Clarify v3, unit by unit (docs/DESIGN-CLARIFY-v3.md): version pins and the verdict on every
// finding, sheet replies in plain words, chat replies without the prompt hook's guesswork,
// migration of v1/v2 records, the 0.6.1 guarantees (drops, gaps and God Eye objections are
// visible; objections are never approval; proceed is the user's alone), the guard letting the
// user edit contract.md (and the CLI checking it again), and the intent_grounded floor.
// The end-to-end scenarios are in clarify-v3-acceptance.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const F = require('./helpers/fixture');
const C = require('../cli/core/clarify');

const NB = 'https://docs.nautobot.com/projects/core/en';

test('versions: pins from repo or user words, compatible pages, moving pages, ranges', () => {
  assert.equal(C.pinOf('==2.4.3'), '2.4.3');
  assert.equal(C.pinOf('v2.4.*'), '2.4.x');
  assert.equal(C.pinOf('latest'), null);
  assert.equal(C.pinOf('>=2.4'), null, 'a range is not a pin');
  assert.equal(C.compatible('2.4.x', '2.4.3'), true);
  assert.equal(C.compatible('2.4', '2.4.4'), true);
  assert.equal(C.compatible('3.2.25', '3.2'), true);
  assert.equal(C.compatible('2.4', '3.0'), false);
  assert.equal(C.compatible('2.4', '2'), false, 'a major-only page does not prove a minor pin');
  assert.deepEqual(C.urlVersion(`${NB}/stable/user-guide/`), { moving: true });
  assert.deepEqual(C.urlVersion(`${NB}/latest/`), { moving: true });
  assert.deepEqual(C.urlVersion(`${NB}/v2.4.4/user-guide/`), { version: '2.4.4' });
  assert.equal(C.urlVersion('src/add.js:1'), null);
  assert.equal(C.inRange('2.4.3', '>=2.4,<3'), true);
  assert.equal(C.inRange('3.0', '>=2.4,<3'), false);
  assert.equal(C.inRange('2.3.9', '^2.4'), false);
});

test('verdicts: repo quotes at their line, pages for the confirmed version, other versions and moving pages are never used', () => {
  const root = F.makeRepo();
  const data = { items: [], evidence: [] };
  const pins = { nautobot: '2.4' };
  const v = (e) => C.verdictOf(root, { item: null, tier: null, ...e }, pins, data);
  assert.equal(v({ source: 'src/add.js:1', quote: 'module.exports = (a, b) => a - b;', tier: 'repo' }), 'repo');
  assert.equal(v({ source: 'src/add.js:2', quote: 'module.exports = (a, b) => a - b;', tier: 'repo' }), 'bad_quote', 'the quote must be at the cited line');
  assert.equal(v({ source: '../outside.js:1', quote: 'x', tier: 'repo' }), 'bad_quote', 'never outside the repo');
  assert.equal(v({ source: `${NB}/v2.4.4/ipam/`, quote: 'q', system: 'nautobot' }), 'pinned');
  assert.equal(v({ source: `${NB}/v3.0.0/ipam/`, quote: 'q', system: 'nautobot' }), 'other_version');
  assert.equal(v({ source: `${NB}/stable/ipam/`, quote: 'q', system: 'nautobot', version: '2.4' }), 'unpinned', 'stable is a moving page, whatever it claims');
  assert.equal(v({ source: 'https://example.com/guide', quote: 'q', system: 'nautobot', version: '3.1' }), 'other_version');
  assert.equal(v({ source: 'https://example.com/guide', quote: 'q', system: 'nautobot' }), 'unpinned', 'no version on a pinned system: not evidence for it');
  assert.equal(v({ source: 'https://www.rfc-editor.org/rfc/rfc6585', quote: 'q', system: 'http' }), 'docs', 'a system with no pin: usable docs');
  assert.equal(v({ source: 'https://example.com/guide', quote: '' }), 'unsourced');
  for (const [verdict, ok] of [['repo', true], ['pinned', true], ['docs', true], ['other_version', false], ['unpinned', false], ['bad_quote', false], ['unsourced', false]]) assert.equal(C.usable({ verdict }), ok, verdict);
});

test('sheet replies: ok, ok but, numbered choices, other, defer, fact corrections; anything else goes to the interviewer', () => {
  const sheet = {
    decisions: [1, 2, 3].map((no) => ({ no, options: [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }], recommendation: 'a' })),
    facts: [{ no: 1, text: 'f' }],
  };
  const p = (t) => C.parseSheetReply(t, sheet);
  assert.deepEqual(p('ok'), { accept: true, answers: [], facts: [] });
  assert.deepEqual(p('ok, but 2 b'), { accept: true, answers: [{ no: 2, choice: 'b' }], facts: [] });
  assert.deepEqual(p('1 b, 3: other: use the tenant field').answers, [{ no: 1, choice: 'b' }, { no: 3, text: 'use the tenant field' }]);
  assert.deepEqual(p('2 defer').answers, [{ no: 2, defer: true }]);
  assert.deepEqual(p('fact 1: it is 2.4.3').facts, [{ no: 1, text: 'it is 2.4.3' }]);
  assert.equal(p('7 a'), null, 'no decision 7 on the sheet');
  assert.equal(p("whatever's standard, but keep the old names"), null, 'prose: the interviewer reads it');
  assert.equal(p(''), null);
});

// a repo, a job with a request, clarify driven to a stage with the fixture's scripted agents
function job({ risk = 'medium', request = 'fix add so the cart totals add up', policy = null } = {}) {
  const root = F.makeRepo();
  if (policy) {
    const pf = path.join(root, '.factory', 'policy.json');
    const pol = JSON.parse(fs.readFileSync(pf, 'utf8'));
    for (const [k, v] of Object.entries(policy)) pol[k] = { ...(pol[k] || {}), ...v };
    fs.writeFileSync(pf, JSON.stringify(pol, null, 2));
  }
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', risk, '--request', request]).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  return { root, J, JD: F.jobDir(root, J) };
}
const record = (root) => JSON.parse(fs.readFileSync(path.join(F.jobDir(root, require('../cli/core/job').resolve(root).id), 'clarify.json'), 'utf8'));

test('replies without the prompt hook: factory clarify reply records the user\'s words; the chat hook takes only clear replies', () => {
  // the read-back waits only when policy says so (or a pin conflicts, or a question is only the user's)
  const { root } = job({ policy: { clarify: { readback: 'wait' } } });
  assert.equal(F.clarify(root, { until: 'readback_wait' }).stage, 'readback_wait');
  assert.equal(C.chatReply(root, 'should research also check the 3.x docs?'), null, 'a question is the user talking, not a reply');
  assert.equal(C.chatReply(root, 'I think the read-back missed that totals are cents'), null, 'prose at the read-back goes through the main session, which reads it back');
  const r = F.cli(root, ['clarify', 'reply', 'totals are in cents, not floats']);
  assert.ok(!r.error, JSON.stringify(r));
  const d = record(root);
  assert.ok(d.words.some((w) => w.text === 'totals are in cents, not floats' && w.via === 'reply'), 'the words are kept verbatim');
  assert.equal(F.cli(root, ['next']).clarify.stage, 'readback', 'an edit reads back again');
  assert.equal(F.clarify(root, { until: 'readback_wait' }).stage, 'readback_wait');
  const ok = C.chatReply(root, 'ok');
  assert.ok(ok && !ok.error, 'ok in chat is applied');
  assert.notEqual(record(root).stage, 'readback_wait');
  // the same words again from the other channel are not a second reply
  const again = F.cli(root, ['clarify', 'reply', 'ok']);
  assert.ok(again.error || /Already recorded|not waiting|nothing/i.test(again.message || ''), JSON.stringify(again));
});

test('the user may edit contract.md at any time: the guard allows it, and the CLI checks the edited text again before H1', () => {
  const { root, J, JD } = job({ risk: 'low' });
  const { checkWrite, loadPolicy } = require('../hooks/guard-rules');
  const pol = loadPolicy(root);
  assert.equal(checkWrite(root, path.join(JD, 'contract.md'), pol), null, 'contract.md is the user\'s to edit');
  assert.match(String(checkWrite(root, path.join(JD, 'clarify.json'), pol)), /factory state/, 'the record is not');
  F.clarify(root);
  assert.equal(F.cli(root, ['next']).step, 'H1');
  // an edit after the check: clarify runs its readiness check on the user's text before H1 again
  fs.appendFileSync(path.join(JD, 'contract.md'), '\n<!-- the user tightened AC-1 -->\n');
  const n = F.cli(root, ['next']);
  assert.equal(n.skill, 'clarify', JSON.stringify(n).slice(0, 300));
  assert.equal(n.clarify.stage, 'check');
  F.clarify(root);
  assert.equal(F.cli(root, ['next']).step, 'H1');
  assert.equal(record(root).contract.edited_by_hand, true);
  assert.equal(F.cli(root, ['clarify', 'status', '--json', '--h1']).edited_by_hand, true, 'H1 says the contract was edited by hand');
  void J;
});

test('God Eye objections are never approval: a blocker sends clarify back round after round; when the loop stops making progress H1 shows the objection open (no park, no proceed needed)', () => {
  const { root, J } = job({ risk: 'low' });
  const blocker = [{ check: 'acs_testable', severity: 'blocker', stage: 'assemble', ref: 'AC-1', issue: 'AC-1 names no input range', fix: 'say which numbers' }];
  const last = F.clarify(root, { objections: blocker, checklist: { acs_testable: false } });
  assert.equal(last.status, 'ok', JSON.stringify(last).slice(0, 400));
  assert.equal(last.loop_end.rule, 'no_progress');
  const h = F.cli(root, ['next']);
  assert.equal(h.step, 'H1', JSON.stringify(h).slice(0, 300));
  const view = h.clarify_h1;
  assert.equal(view.approved, false, 'H1 never reads as approved by God Eye');
  assert.equal(view.god_eye_objects.length, 1);
  assert.match(view.god_eye_objects[0], /AC-1 names no input range/);
  assert.match(view.screen, /God Eye objects/);
  assert.doesNotMatch(view.screen, /checks pass/, 'an open objection is never shown next to "all checks pass"');
  // proceed stays a human-only verb (for parks from before 0.9.0)
  assert.ok(require('../hooks/guard-rules').HUMAN_ONLY.has('proceed'), 'proceed is a human-only verb');
  const step = fs.readFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.kind === 'step' && e.step === 'clarify').pop();
  assert.equal(step.detail.approved, false);
  assert.equal(step.detail.god_eye_objects, 1);
  assert.equal(step.detail.loop_end.rule, 'no_progress');
});

test('a degraded run parks: an agent that returns nothing twice is named, and resume tries again', () => {
  const { root, J } = job({ risk: 'low' });
  F.cli(root, ['next']);
  const brief = F.cli(root, ['wfargs', 'clarify'], { allowFail: false });
  // the read-back's interviewer returned nothing (both attempts)
  let r = F.record(root, F.envelope(brief, 'degraded', { stage: brief.stage, rev: brief.rev, outputs: { 'read-back': null }, failed: ['read-back'] }));
  assert.notEqual(r.status, 'ok');
  let n = F.cli(root, ['next']);
  if (n.action !== 'parked') {
    const b2 = F.cli(root, ['wfargs', 'clarify'], { allowFail: false });
    r = F.record(root, F.envelope(b2, 'degraded', { stage: b2.stage, rev: b2.rev, outputs: { 'read-back': null }, failed: ['read-back'] }));
    n = F.cli(root, ['next']);
  }
  assert.equal(n.action, 'parked', JSON.stringify(n).slice(0, 300));
  assert.match(n.reason, /interviewer|read-back/i, 'the park names what failed');
  assert.ok(!/proceed/.test(n.reason), 'nothing to proceed with when an agent failed');
  F.reply(root, `resume ${J}`);
  const again = F.cli(root, ['next']);
  assert.equal(again.skill, 'clarify');
  assert.equal(again.clarify.stage, 'readback', 'resume runs the stage again');
});

// ---------------------------------------------------------------- migration
function legacyV2() {
  const at = '2026-10-01T10:00:00.000Z';
  return {
    version: 2,
    job: 'J-0001',
    rounds: [{ round: 1, at }],
    unknowns: [
      { id: 'U-1', text: 'Which Nautobot version?', kind: 'repo', impact: 'high', status: 'settled', settled_by: 'user', answer: 'Nautobot 2.4', evidence: [] },
      { id: 'U-2', text: 'How are devices reached?', kind: 'decision', impact: 'high', status: 'settled', settled_by: 'assumption_accepted', answer: 'netmiko over SSH', answered: { default_accepted: true }, evidence: [] },
      { id: 'U-3', text: 'Is a code comment enough documentation?', kind: 'user', impact: 'low', status: 'settled', settled_by: 'assumption_accepted', default: 'A code comment is enough', evidence: [] },
      { id: 'U-4', text: 'Where does the job live?', kind: 'repo', impact: 'medium', status: 'settled', settled_by: 'evidence', assumption: 'A-1', evidence: ['E-1'] },
      { id: 'U-5', text: 'Exact retry backoff', kind: 'decision', impact: 'low', status: 'deferred_to_design', evidence: [] },
      { id: 'U-6', text: 'Should VLAN names be lowercased?', kind: 'user', impact: 'low', status: 'dropped', note: 'not asked for', evidence: [] },
      { id: 'U-7', text: 'How does Nautobot scope VLANs?', kind: 'world', impact: 'high', status: 'open', evidence: [], aliases: [{ id: 'U-8', text: 'Can a VLAN belong to several locations?' }] },
    ],
    evidence: [{ id: 'E-1', unknown: 'U-4', claim: 'add lives in src/add.js', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports = (a, b) => a - b;', scout: 'repo' }],
    assumptions: [{ id: 'A-1', unknown: 'U-4', statement: 'add lives in src/add.js', evidence: ['E-1'] }],
  };
}

test('migration: a v2 job in clarify keeps every issue, with who settled it; folded aliases become their own items; the last denial is read back as a redirect', () => {
  const { root, J, JD } = job({ request: 'sync VLANs to Nautobot 2.4' });
  require('../cli/core/intent').save(root, J, { ...legacyV2(), job: J });
  const legacyFile = path.join(JD, 'intent-evidence.json');
  const before = crypto.createHash('sha256').update(fs.readFileSync(legacyFile)).digest('hex');
  const jobs = require('../cli/core/job');
  const st = jobs.load(root, J);
  st.denials = [{ gate: 'H1', at: '2026-10-02T09:00:00.000Z', reason: 'base the tests on Nautobot 2.4, not 3.x' }];
  jobs.save(root, st);
  const n = F.cli(root, ['next']);
  assert.equal(n.skill, 'clarify');
  assert.equal(n.clarify.stage, 'readback', 'a migrated job starts again at the read-back, pre-filled');
  F.cli(root, ['wfargs', 'clarify'], { allowFail: false });
  const d = record(root);
  assert.equal(d.version, 3);
  assert.equal(d.migration.from, 2);
  const by = (v2) => d.items.find((it) => it.v2_id === v2);
  assert.deepEqual([by('U-1').strength, by('U-1').status], ['user', 'decided'], 'answered by the user → the user\'s words');
  assert.ok(d.words.some((w) => w.text === 'Nautobot 2.4' && w.via === 'migration'));
  assert.deepEqual([by('U-2').strength, by('U-2').value], ['accepted', 'netmiko over SSH'], 'an accepted default → accepted');
  assert.deepEqual([by('U-3').strength, by('U-3').status], ['assumption', 'assumed'], 'assumed without asking → an assumption the sheet shows');
  assert.equal(by('U-4').strength, 'evidence', 'settled by evidence → evidence, judged again');
  assert.deepEqual([by('U-5').status, by('U-5').owner], ['deferred', 'design']);
  assert.equal(by('U-6').status, 'dropped');
  assert.match(JSON.stringify(by('U-6').history), /clarify v2.*not asked for/, 'who dropped it and why');
  assert.equal(by('U-7').status, 'open');
  assert.equal(by('U-8').folded_into, by('U-7').id, 'the folded alias is its own item, linked to the one it was folded into');
  assert.equal(d.redirects.length, 1);
  assert.equal(d.redirects[0].text, 'base the tests on Nautobot 2.4, not 3.x');
  assert.equal(d.redirects[0].status, 'queued', 'read back after the read-back');
  assert.match(d.migration.summary, /1 answered by you.*1 accepted defaults.*1 assumed without asking.*1 deferred to design.*1 dropped/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(legacyFile)).digest('hex'), before, 'the v2 record is left as it was');
});

test('migration: v1 unknowns (resolution fields) map the same way', () => {
  const { root, J } = job();
  require('../cli/core/intent').save(root, J, {
    version: 1, job: J, rounds: [],
    unknowns: [
      { id: 'U-1', text: 'Which version?', kind: 'repo', impact: 'high', resolution: 'answered', answer: '2.4', evidence: [] },
      { id: 'U-2', text: 'Where is add?', kind: 'repo', impact: 'high', resolution: 'assumption', evidence: [] },
      { id: 'U-3', text: 'Rename the module?', kind: 'user', impact: 'low', resolution: 'dismissed', evidence: [] },
      { id: 'U-4', text: 'Keep floats?', kind: 'decision', impact: 'high', resolution: 'question', evidence: [] },
    ],
    evidence: [], assumptions: [],
  });
  F.cli(root, ['next']);
  F.cli(root, ['wfargs', 'clarify'], { allowFail: false });
  const d = record(root);
  assert.equal(d.migration.from, 1);
  const s = Object.fromEntries(d.items.filter((it) => it.v2_id).map((it) => [it.v2_id, `${it.status}/${it.strength || '-'}`]));
  assert.deepEqual(s, { 'U-1': 'decided/user', 'U-2': 'decided/evidence', 'U-3': 'dropped/-', 'U-4': 'open/-' });
});

test('0.6.1 guarantees on a migrated job: drops are shown at H1 and in status with who and why; research gaps are shown', () => {
  const { root, J } = job({ risk: 'low' });
  const legacy = legacyV2();
  legacy.unknowns = legacy.unknowns.filter((u) => ['U-2', 'U-6'].includes(u.id));
  require('../cli/core/intent').save(root, J, { ...legacy, job: J });
  F.clarify(root);
  const n = F.cli(root, ['next']);
  assert.equal(n.step, 'H1', JSON.stringify(n).slice(0, 300));
  const h = n.clarify_h1;
  assert.equal(h.dropped.length, 1);
  assert.match(h.dropped[0], /Should VLAN names be lowercased\? \(dropped by clarify v2: not asked for\)/);
  assert.match(h.screen, /\*\*Dropped\*\*/);
  assert.match(h.screen, /\*\*God Eye:\*\* all 7 checks pass/, 'drops do not hide God Eye\'s verdict');
  const s = F.cli(root, ['clarify', 'status']);
  assert.match(s.raw || JSON.stringify(s), /Dropped:[\s\S]*lowercased/);
  assert.equal(h.status_command, `factory clarify status --job ${J}`);
  // a research gap is never hidden: it is listed at H1 and in the contract's Research gaps
  const d = record(root);
  assert.ok(Array.isArray(h.gaps));
  assert.equal(h.gaps.length, d.failures.length);
});

test('the intent_grounded floor: the contract may not rest on a source clarify rejected (outside its own sections)', () => {
  const { root, J, JD } = job({ risk: 'low' });
  F.clarify(root);
  const state = require('../cli/core/job').load(root, J);
  assert.equal(C.floorOk({ root, state }), true);
  // a rejected page cited in the user's own text breaks the floor
  const file = path.join(JD, 'clarify.json');
  const d = record(root);
  d.evidence.push({ id: 'E-9', item: null, claim: 'x', source: `${NB}/stable/x/`, quote: 'q', verdict: 'unpinned', by: 'docs', passes: [1] });
  C.save(root, J, d);
  fs.appendFileSync(path.join(JD, 'contract.md'), `\nSee ${NB}/stable/x/ for the model.\n`);
  assert.equal(C.floorOk({ root, state }), false);
  void file;
});

test('telemetry: what clarify cost the user and what it could not do, per job', () => {
  const { root } = job({ risk: 'low' });
  F.clarify(root);
  const t = F.cli(root, ['telemetry', 'report']);
  const m = (t.per_job || []).find((x) => x.clarify);
  assert.ok(m, JSON.stringify(t).slice(0, 300));
  assert.equal(m.clarify.version, 3);
  assert.equal(m.clarify.user_turns, 0, 'nothing needed the user: the read-back was shown, not waited on');
  assert.equal(m.clarify.readiness_checks, 1);
  assert.equal(m.clarify.proceeded, false);
});
