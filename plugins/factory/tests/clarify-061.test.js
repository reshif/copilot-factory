'use strict';
// 0.6.1: narrow fixes to clarify from J-0001 (Nautobot VLAN sync from Cisco devices, 0.6.0)
// and the clarify simulation. No new mechanisms: each fix is local.
//   1. the job's own title words are no evidence that two issues are the same (both copies of
//      the dedup rule: the workflow's and the CLI's)
//   2. no issue is dropped without an actor and a reason; the record refuses a round in which
//      one vanishes (ledger_invariant); H1 shows "dropped by judge: <reason>"
//   4. degraded rounds park after two in a row, naming the failing agent(s)
//   5. a failed intent mapper and an unavailable web are shown in the round result and at H1;
//      defaults from agent memory with the web down are labelled
//   6. God Eye's blockers are never counted as approval: "God Eye objects" at H1

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');
const J2 = require('./helpers/j0002');
const clarify = require('../cli/core/clarify');
const intent = require('../cli/core/intent');
const job = require('../cli/core/job');

const WF = path.join(F.PLUGIN, 'workflows', 'fanout-judge.js');
const TITLE = 'Nautobot VLAN sync from Cisco devices';
const SCOPE = 'Which Cisco devices does the Nautobot VLAN sync job read from?';
const CREDS = 'How does the Nautobot VLAN sync job get credentials for the Cisco devices?';

function newJob(root, title = TITLE) {
  const J = F.cli(root, ['job', 'new', '--title', title, '--type', 'feature', '--risk', 'medium']).job;
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
const byId = (d, id) => d.unknowns.find((u) => u.id === id);
const APPROVE = { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, checklist: { intent_clear: true, scope_bounded: true, acs_testable: true, no_open_blockers: true, constraints_consistent: true }, items: [], researchable_questions: [] };

const item = (id, category, gate = false) => ({ id, label: id, category, gate, prompt: `p-${id}`, schema: {}, agent_type: 'factory:intent-analyst' });
function brief(scout = {}, extra = {}) {
  const budget = { repo_scouts: 3, web_scouts: 2, time_sec: 120, strict_second_source: false, unknowns_per_scout: 3, max_unknowns: 12, verifier_batch: 4, max_verifiers: 2, mapper_sec: 180 };
  return {
    workflow: 'fanout-judge', job: 'J-0001', input_hash: 'h', budgets: { limit: {} }, config: 'clarify', round: 2, limits: { max_questions: 5 }, asked: [],
    fanout: [item('intent', 'intent', true), item('scope', 'scope')],
    judge: { prompt: 'JUDGE', schema: {}, agent_type: 'factory:judge' },
    critique: { prompt: 'GOD', schema: {}, agent_type: 'factory:god-eye' },
    editor: { prompt: 'EDIT', schema: {}, agent_type: 'factory:contract-editor', todo: [] },
    ledger: { round: 2, new_since: {}, changed_sections: null, settled_sections: [], nothing_new: false },
    scout: {
      round: 2, risk: 'medium', web: { enabled: true, reason: null, search_mcp: null }, map_needed: false,
      prior: { unknowns: [], evidence: [], assumptions: [], versions: [] }, pending: [], next_ids: { U: 0, E: 0, A: 0 },
      mapper: { agent_type: 'factory:intent-mapper', label: 'intent map', prompt: 'MAP', schema: {} },
      repo_scout: { agent_type: 'factory:researcher', label: 'scout · repo', mode: 'repo', prompt_template: 'REPO {{unknowns}}', schema: {} },
      web_scout: { agent_type: 'factory:researcher', label: 'scout · web', mode: 'web', prompt_template: 'WEB {{unknowns}}', schema: {} },
      verifier: { agent_type: 'factory:verifier', label: 'verify evidence', prompt_template: 'VERIFY {{findings}}', schema: {} },
      ...scout,
      budget,
    },
    ...extra,
  };
}
function crew(over = {}) {
  return (prompt, opts) => {
    const t = opts.agentType;
    for (const [k, f] of Object.entries(over)) if (prompt.startsWith(k) || t === k) return f(prompt, opts);
    if (t === 'factory:intent-analyst') return { focus: 'x', questions: [] };
    if (t === 'factory:judge') return { questions: [], dismissed: [] };
    if (t === 'factory:god-eye') return APPROVE;
    if (t === 'factory:contract-editor') return { contract: '# x\n\n## Intent\n- Problem: p\n', applied: [], skipped: [] };
    throw new Error(`unexpected ${t}: ${prompt.slice(0, 60)}`);
  };
}

// ---------------------------------------------------------------- 1. the job's own words
test('1: the job title\'s words are no evidence of identity: credentials do not fold into device scope (CLI and workflow); paraphrases still fold', async () => {
  const bg = clarify.vocabulary(TITLE);
  const scope = { subject: 'sync.device-scope', subject_explicit: true, text: SCOPE };
  const creds = { subject: 'device.credentials', subject_explicit: true, text: CREDS };
  assert.equal(clarify.sameIssue(creds, scope), true, 'without the job\'s vocabulary (0.6.0) credentials fold into device scope');
  assert.equal(clarify.sameIssue(creds, scope, bg), false, 'with it they are two issues');
  assert.equal(clarify.sameIssue({ text: 'How should VLANs be scoped for the six tenants with their own locations?' }, { text: 'How should VLANs be scoped across the six tenants and their own locations?' }, bg), true, 'a real paraphrase still folds');
  assert.equal(clarify.sameIssue({ text: 'Is there a maintenance window for the sync?' }, { text: 'Is there a maintenance window the sync must respect?' }, clarify.vocabulary('Nautobot interface VLAN sync')), true);

  // CLI: device scope settled; the judge raises credentials next round → its own issue, asked
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  round(root, { scout: scoutData([issue('U-5', SCOPE, 'scope', { owner: 'user', status: 'settled', settled_by: 'user', subject: 'sync.device-scope', answer: 'all access switches' })]) }, 'ok');
  const r = round(root, { scout: scoutData([]), judge: { questions: [{ question: CREDS, category: 'scope', why: 'w', default: 'Your call', same_as: 'new', subject: 'device.credentials', kind: 'user', preference: true }], dismissed: [] } });
  assert.equal(r.status, 'needs_user');
  const d = ledgerOf(root, J);
  const c = d.unknowns.find((u) => /credentials/.test(u.text));
  assert.ok(c, 'the credentials issue exists');
  assert.notEqual(c.id, 'U-5');
  assert.ok(r.questions.some((q) => q.unknown === c.id), 'and is asked');
  assert.ok(!(byId(d, 'U-5').notes || []).some((x) => /credentials/.test(x.text)), 'not a note on the settled scope issue');

  // the brief carries the vocabulary to the workflow
  F.cli(root, ['next']);
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.deepEqual(b.scout.vocabulary, bg);

  // workflow: the same raise against a settled scope issue is a new issue, not a note
  const prior = { unknowns: [{ ...issue('U-1', SCOPE, 'scope'), owner: 'user', status: 'settled', settled_by: 'user', subject: 'sync.device-scope', subject_explicit: true, answer: 'all access switches' }], evidence: [], assumptions: [], versions: [] };
  const judge = () => ({ questions: [{ question: CREDS, category: 'scope', why: 'w', default: 'Your call', same_as: 'new', subject: 'device.credentials', kind: 'user' }], dismissed: [] });
  const without = await H.run(WF, brief({ prior, next_ids: { U: 1, E: 0, A: 0 } }), crew({ JUDGE: judge }));
  assert.equal(without.result.status, 'ok', '0.6.0 shape (no vocabulary): folded into U-1 as a note');
  const withV = await H.run(WF, brief({ prior, next_ids: { U: 1, E: 0, A: 0 }, vocabulary: bg }), crew({ JUDGE: judge }));
  assert.equal(withV.result.status, 'needs_user');
  assert.ok(withV.result.data.scout.unknowns.some((u) => u.id !== 'U-1' && /credentials/.test(u.text)), 'a new issue in the workflow too');
});

// ---------------------------------------------------------------- 2. no silent drop
test('2: a judge dismissal drops an issue only with a reason; H1 shows "dropped by judge: <reason>"; the record refuses a round in which an issue vanishes or is dropped without actor and reason', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  const creds = { ...issue('U-1', CREDS, 'decision'), owner: 'user', status: 'proposed', subject: 'device.credentials' };
  const other = { ...issue('U-2', 'Should the sync delete VLANs missing on the device?', 'decision'), owner: 'user', status: 'proposed', subject: 'sync.prune' };
  // no reason: nothing is dropped (0.6.0 dropped it for good)
  let r = round(root, { scout: scoutData([creds, other]), judge: { questions: [], dismissed: [{ question: CREDS, unknown: 'U-1', reason: '' }, { question: other.text, unknown: 'U-2', reason: 'the README will cover it' }] }, critique: APPROVE }, 'ok');
  let d = ledgerOf(root, J);
  assert.notEqual(byId(d, 'U-1').status, 'dropped', 'a dismissal without a reason drops nothing');
  assert.equal(byId(d, 'U-2').status, 'dropped');
  const h = byId(d, 'U-2').history.slice(-1)[0];
  assert.deepEqual([h.event, h.actor, h.text], ['dropped', 'judge', 'the README will cover it']);
  assert.ok(r.questions.some((q) => q.unknown === 'U-1'), 'U-1 is asked instead');
  // the user answers; the next round reaches H1, which shows the drop and why
  F.cli(root, ['answer', 'U-1', 'from the Nautobot secrets group of each device']);
  F.cli(root, ['next']);
  r = round(root, { scout: scoutData([]), critique: APPROVE }, 'ok');
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 400));
  const n = F.cli(root, ['next']);
  assert.equal(n.step, 'H1');
  assert.deepEqual(n.clarify.dropped, ['U-2: Should the sync delete VLANs missing on the device? (dropped by judge: the README will cover it)']);
  assert.match(F.cli(root, ['clarify', 'status', '--job', J]).raw, /Dropped:\n {2}U-2: .*\(dropped by judge: the README will cover it\)/);

  // the guard: a workflow that reports an issue it opened but does not return it
  const root2 = F.makeRepo();
  const J2id = newJob(root2);
  F.cli(root2, ['next']);
  round(root2, { scout: scoutData([{ ...issue('U-1', SCOPE, 'scope'), owner: 'user', status: 'proposed' }]) });
  const before = JSON.stringify(ledgerOf(root2, J2id).unknowns);
  F.cli(root2, ['next']);
  const bad = round(root2, { scout: scoutData([], { raised: { created: [{ issue: 'U-40', source: 'judge' }], folded: [], notes: [] } }) });
  assert.equal(bad.code, 'ledger_invariant');
  assert.match(bad.message, /U-40, opened this round, vanished/);
  assert.equal(JSON.stringify(ledgerOf(root2, J2id).unknowns), before, 'nothing was recorded');

  // the rule itself: a lost alias, a lost new issue, a drop with no actor or reason
  const prior = { unknowns: [{ id: 'U-1', text: 'a', status: 'open', aliases: [{ id: 'U-9' }] }, { id: 'U-2', text: 'b', status: 'open', aliases: [] }] };
  const now = { unknowns: [clarify.cleanIssue({ id: 'U-1', text: 'a', kind: 'user', status: 'proposed' }), clarify.cleanIssue({ id: 'U-2', text: 'b', kind: 'user', status: 'dropped' })] };
  const p = clarify.invariant(prior, now, ['U-7']);
  assert.ok(p.some((x) => /U-9 \(an alias of U-1\) vanished/.test(x)));
  assert.ok(p.some((x) => /U-7, opened this round, vanished/.test(x)));
  assert.ok(p.some((x) => /U-2 .* dropped without a recorded reason and actor/.test(x)));
  clarify.event(now.unknowns[1], 2, 'dropped', 'judge', 'does not change the outcome');
  assert.deepEqual(clarify.invariant(prior, { unknowns: [{ ...now.unknowns[0], aliases: [{ id: 'U-9' }] }, now.unknowns[1], clarify.cleanIssue({ id: 'U-7', text: 'c', kind: 'user' })] }, ['U-7']), []);
});

// ---------------------------------------------------------------- 4. degraded rounds park
test('4: two degraded clarify rounds in a row park the job, naming the failing agent(s); resume, then --accept-degraded, goes on', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  const failed = (extra = {}) => {
    const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
    return F.record(root, F.envelope(b, 'degraded', { analysts: [], degraded: ['intent-analyst:intent', 'intent-analyst:scope'], judge: { questions: [], dismissed: [] }, scout: scoutData([]), ...extra }));
  };
  let r = failed();
  assert.equal(r.status, 'retry', 'the first degraded round is retried once, automatically');
  F.cli(root, ['next']);
  r = failed();
  assert.equal(r.status, 'park', JSON.stringify(r).slice(0, 300));
  assert.match(r.park_reason, /agent\(s\) failed in 2 clarify rounds in a row: intent-analyst:intent, intent-analyst:scope/);
  assert.match(r.park_reason, /--accept-degraded/);
  let st = job.load(root, J);
  assert.equal(st.status, 'parked');
  assert.match(st.park.reason, /intent-analyst:intent/);
  assert.equal(clarify.limits(st).counted, 0, 'degraded rounds still do not count towards the ceiling');
  F.reply(root, 'resume');
  st = job.load(root, J);
  assert.equal(st.counters.clarify_degraded_streak, 0, 'resume resets the streak');
  assert.equal(F.cli(root, ['next']).skill, 'clarify');
  // the same agents keep failing: one automatic retry, then parked again (never an endless loop)
  assert.equal(failed().status, 'retry');
  F.cli(root, ['next']);
  assert.equal(failed().status, 'park');
});

// ---------------------------------------------------------------- 5. hidden failures shown
test('5: a failed intent mapper and an unavailable web are said in the round result and at H1; defaults from agent memory are labelled', () => {
  // the mapper never returned; an analyst question still makes the round needs_user (0.6.0 hid it)
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  let r = round(root, { scout: scoutData([], { map: { ran: true, ok: false }, degraded: ['intent-mapper'] }), judge: { questions: [{ question: 'Which devices are in scope?', category: 'scope', why: 'w', default: 'Your call', same_as: 'new', subject: 'scope.devices', kind: 'user' }], dismissed: [] } });
  assert.equal(r.status, 'needs_user');
  assert.match(r.research_incomplete, /^Research incomplete: intent-mapper failed or timed out/);
  assert.match(r.message, /^Research incomplete: intent-mapper failed or timed out/);

  // the web is down: a world fact asked with the mapper's draft as its default
  const root2 = F.makeRepo();
  const J2id = newJob(root2);
  F.cli(root2, ['next']);
  const world = { ...issue('U-1', 'Does Nautobot 2.4 scope VLANs by location?', 'world'), owner: 'research', status: 'proposed', subject: 'nautobot.vlan.scope', default: 'VLANs are scoped by location groups', reason: 'not verified: no web access (no network or no web tool)' };
  r = round(root2, { scout: scoutData([world], { web: { enabled: true, available: false } }) });
  assert.equal(r.status, 'needs_user');
  assert.match(r.research_incomplete, /web unavailable, so these items rest on agent knowledge: U-1 Does Nautobot 2\.4 scope VLANs by location\?/);
  // nobody answers: the default is accepted next round, labelled as agent memory
  F.cli(root2, ['next']);
  r = round(root2, { scout: scoutData([], { web: { enabled: true, available: null } }), critique: APPROVE }, 'ok'); // no web scout ran this round
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 300));
  assert.match(r.message, /^Research incomplete: web unavailable, so these items rest on agent knowledge: U-1 .*\(default accepted: VLANs are scoped by location groups\)/);
  const text = fs.readFileSync(path.join(F.jobDir(root2, J2id), 'contract.md'), 'utf8');
  assert.match(text, /## Clarifications \(settled\)[\s\S]*U-1 \(Q-1\): Does Nautobot 2\.4 scope VLANs by location\? → VLANs are scoped by location groups \(default accepted; from agent memory, the web was unavailable\)/);
  const n = F.cli(root2, ['next']);
  assert.equal(n.step, 'H1');
  assert.match(n.clarify.research_incomplete, /web unavailable, so these items rest on agent knowledge: U-1/);
  // research that ran fully adds nothing
  assert.equal(clarify.researchGaps({ rounds: [{ mapped: true, map_ok: true }], web: { enabled: true, available: true }, unknowns: [] }), null);
});
