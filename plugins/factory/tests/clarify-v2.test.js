'use strict';
// Clarify v2 (docs/DESIGN-CLARIFY-v2.md): one issue ledger the CLI owns, identity by subject,
// one answer channel, a defined exit for research, rounds that review only what changed,
// implementation facts handed to design, progress instead of round counting, one writer, and
// what the console and factory next show. Behaviours A–I, the J-0002 migration and two
// end-to-end runs on the fake Copilot (a fresh job, and the migrated J-0002 itself).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');
const J2 = require('./helpers/j0002');
const clarify = require('../cli/core/clarify');
const intent = require('../cli/core/intent');
const contract = require('../cli/core/contract');
const guardRules = require('../hooks/guard-rules');
const { validate } = require('../cli/lib/schema');

const WF = path.join(F.PLUGIN, 'workflows', 'fanout-judge.js');
const ENV = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'schemas', 'envelope.json'), 'utf8'));
const FAKE = path.join(__dirname, 'helpers', 'fake-copilot.js');
const CREW = path.join(__dirname, 'helpers', 'clarify-crew.js');

// ---------------------------------------------------------------- helpers
const item = (id, category, gate = false) => ({ id, label: id, category, gate, prompt: `p-${id}`, schema: {}, agent_type: 'factory:intent-analyst' });
function brief(scout = {}, extra = {}) {
  const budget = { repo_scouts: 3, web_scouts: 2, time_sec: 120, strict_second_source: false, unknowns_per_scout: 3, max_unknowns: 12, verifier_batch: 4, max_verifiers: 2, mapper_sec: 180, ...(scout.budget || {}) };
  return {
    workflow: 'fanout-judge', job: 'J-0001', input_hash: 'h', budgets: { limit: {} }, config: 'clarify', round: 1, limits: { max_questions: 5 }, asked: [],
    fanout: [item('intent', 'intent', true), item('scope', 'scope')],
    judge: { prompt: 'JUDGE', schema: {}, agent_type: 'factory:judge' },
    critique: { prompt: 'GOD', schema: {}, agent_type: 'factory:god-eye' },
    editor: { prompt: 'EDIT', schema: {}, agent_type: 'factory:contract-editor', todo: [] },
    ledger: { round: 1, new_since: {}, changed_sections: null, settled_sections: [], nothing_new: false },
    scout: {
      round: 1, risk: 'medium', web: { enabled: true, reason: null, search_mcp: null }, map_needed: true,
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
const idsIn = (p) => [...p.matchAll(/"id": "(U-\d+)"/g)].map((m) => m[1]);
const webEv = (u, extra = {}) => ({ unknown: u, claim: `web claim for ${u}`, source: `https://docs.example.com/${u}`, source_tier: 'official', retrieved_at: '2026-10-14', quote: `quote ${u}`, applies_to_version: 'v2', confidence: 'high', ...extra });
const APPROVE = { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, checklist: { intent_clear: true, scope_bounded: true, acs_testable: true, no_open_blockers: true, constraints_consistent: true }, items: [], researchable_questions: [] };
function crew(over = {}) {
  return (prompt, opts) => {
    const t = opts.agentType;
    for (const [k, f] of Object.entries(over)) if (prompt.startsWith(k) || t === k) return f(prompt, opts);
    if (t === 'factory:intent-analyst') return { focus: 'x', questions: [] };
    if (t === 'factory:judge') return { questions: [], dismissed: [] };
    if (t === 'factory:god-eye') return APPROVE;
    if (t === 'factory:verifier') return { verdicts: [...new Set([...prompt.matchAll(/"id": "(E-\d+)"/g)].map((m) => m[1]))].map((id) => ({ evidence_id: id, verdict: 'confirmed', confidence: 'high', reason: 'ok', quote_found: true })) };
    if (t === 'factory:contract-editor') return { contract: '# x\n\n## Intent\n- Problem: p\n', applied: [], skipped: [] };
    throw new Error(`unexpected ${t}: ${prompt.slice(0, 60)}`);
  };
}
const NXOS = [
  'Which NX-OS CLI command sets the allowed VLAN list on a trunk interface?',
  'What is the exact NX-OS syntax for switchport trunk allowed vlan?',
  "Does NX-OS use 'switchport trunk allowed vlan add' to add VLANs to a trunk?",
  'Confirm the NX-OS command form for configuring trunk allowed VLANs',
  "NX-OS: is the command 'switchport trunk allowed vlan' or 'switchport allowed vlan'?",
  'Which command does NX-OS accept to set allowed VLANs on trunk ports?',
];

function newJob(root, { risk = 'medium', policy } = {}) {
  if (policy) fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify(policy));
  const J = F.cli(root, ['job', 'new', '--title', 'Nautobot interface VLAN sync', '--type', 'feature', '--risk', risk]).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), J2.CONTRACT);
  return J;
}
// A clarify round recorded from a hand-made envelope (the scout data as the workflow returns it).
function round(root, data, status = 'needs_user') {
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  return F.record(root, F.envelope(b, status, { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, ...data }));
}
const issue = (id, text, kind, extra = {}) => ({ id, text, kind, impact: 'high', draft: text, research: kind === 'repo' ? 'repo' : kind === 'world' ? 'web' : 'none', evidence: [], assumption: null, question_id: null, answer: null, note: null, researched: false, source: 'mapper', round: 1, ...extra });
const scoutData = (unknowns, extra = {}) => ({ ran: true, round: 1, web: { enabled: true, available: true }, map: { ran: true, ok: true }, unknowns, evidence: [], assumptions: [], versions: [], scouts: [], verifiers: 0, degraded: [], ...extra });
const ledgerOf = (root, J) => intent.load(root, J);
const hook = (name, input, event) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', name), ...(event ? [event] : [])], { input: JSON.stringify(input), encoding: 'utf8' });
function harness(script, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-clarify2-'));
  const env = { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: FAKE, FAKE_COPILOT_SCRIPT: script, FAKE_COPILOT_LOG: path.join(dir, 'copilot.jsonl'), ...extraEnv };
  return {
    run(root, args) {
      const r = spawnSync('node', [F.BIN, 'run', ...args, '--json'], { cwd: root, encoding: 'utf8', env, timeout: 120000 });
      let out;
      try { out = JSON.parse(r.stdout); } catch { out = { raw: r.stdout, stderr: r.stderr }; }
      return Object.assign(out, { __code: r.status, __stderr: r.stderr });
    },
  };
}

// ---------------------------------------------------------------- A. one ledger, owned by the CLI
test('A: the ledger is intent-evidence.json v2: subject, owner, status, settled_by, links and history per issue; settled is final', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  const r = round(root, { scout: scoutData([
    issue('U-1', 'Where does the automation read interface VLANs?', 'repo', { owner: 'research', status: 'settled', settled_by: 'evidence', subject: 'automation.vlan-source', evidence: ['E-1'] }),
    issue('U-2', 'Should the sync prune VLANs not in Nautobot?', 'user', { owner: 'user', status: 'proposed', subject: 'sync.prune' }),
  ], { evidence: [{ id: 'E-1', unknown: 'U-1', claim: 'reads in src/add.js', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports = (a, b) => a - b; // bug: should add', confidence: 'high', scout: 'repo', verdict: 'confirmed' }] }), judge: { questions: [{ question: 'Should the sync prune VLANs not in Nautobot?', category: 'scope', why: 'w', default: 'Your call: prune', unknown: 'U-2', preference: true }], dismissed: [] } });
  assert.equal(r.status, 'needs_user');
  const d = ledgerOf(root, J);
  assert.equal(d.version, 2);
  const [u1, u2] = d.unknowns;
  for (const k of ['id', 'subject', 'text', 'kind', 'impact', 'owner', 'status', 'settled_by', 'evidence', 'question_id', 'answer', 'assumption', 'history', 'aliases', 'notes']) assert.ok(k in u1, `issue field ${k}`);
  assert.deepEqual([u1.status, u1.settled_by, u1.owner, u1.subject, u1.assumption], ['settled', 'evidence', 'research', 'automation.vlan.source', 'A-1']);
  assert.deepEqual([u2.status, u2.owner, u2.question_id], ['proposed', 'user', 'Q-1']);
  assert.ok(u2.history.some((h) => h.event === 'asked' && h.text === 'Q-1'));
  // settled is final: the next round's workflow says otherwise, the ledger keeps it
  F.cli(root, ['answer', 'Q-1', 'yes, prune them']);
  F.cli(root, ['next']);
  round(root, { scout: scoutData([{ ...u1, status: 'open', settled_by: null }, { ...u2, status: 'proposed', settled_by: null, answer: null }]) });
  const d2 = ledgerOf(root, J);
  assert.deepEqual(d2.unknowns.map((u) => [u.id, u.status, u.settled_by]), [['U-1', 'settled', 'evidence'], ['U-2', 'settled', 'user']]);
  // it reopens only on new confirmed evidence that names it
  const reopened = intent.advance({ ...d2, evidence: [...d2.evidence, { id: 'E-9', unknown: 'U-1', claim: 'it reads from a cache instead', source: 'src/add.js:1', verdict: 'confirmed', scout: 'repo', contradicts: 'U-1' }] }, 3);
  const u = reopened.unknowns.find((x) => x.id === 'U-1');
  assert.deepEqual([u.status, u.owner], ['proposed', 'user']);
  assert.match(u.reason, /E-9 contradicts/);
  const kept = intent.advance({ ...d2, evidence: [...d2.evidence, { id: 'E-9', unknown: 'U-1', claim: 'x', source: 'src/add.js:1', verdict: 'unverified', scout: 'repo', contradicts: 'U-1' }] }, 3);
  assert.equal(kept.unknowns[0].status, 'settled', 'unverified evidence never reopens');
});

// ---------------------------------------------------------------- B. identity by subject
test('B: paraphrases fold into one issue (subject key, then tokens); a raise against a settled subject is a note, never a reopen', () => {
  const list = [];
  for (const t of NXOS) {
    const hit = clarify.findSame(list, { text: t });
    if (hit) hit.aliases.push({ id: `U-${list.length + 10}`, text: t });
    else list.push(clarify.cleanIssue({ id: `U-${list.length + 1}`, text: t, kind: 'world' }));
  }
  assert.equal(list.length, 1, 'six phrasings of the NX-OS command are one issue');
  assert.equal(list[0].owner, 'design', 'and an implementation detail');
  for (const other of ['Should the sync remove VLANs that are not in Nautobot from trunk ports?', "Which Nautobot API field holds an interface's tagged VLANs?", 'Where is add implemented and what does it do today?']) {
    assert.equal(clarify.findSame(list, { text: other }), null, `"${other}" is a different issue`);
  }
  assert.equal(clarify.findSame(list, { text: 'anything', same_as: 'U-1' }), list[0], 'same_as names it');
  assert.equal(clarify.findSame(list, { text: 'anything', same_as: 'U-11' }), list[0], 'an alias id names it too');
  assert.equal(clarify.subjectKey('NX-OS switchport-command'), 'nxos.switchport.command');
  // two agent-given subjects that differ need a closer match
  assert.equal(clarify.sameIssue({ subject: 'nxos.native-vlan', subject_explicit: true, text: 'Which NX-OS command sets the native VLAN on a trunk?' }, { subject: 'nxos.allowed-vlans', subject_explicit: true, text: NXOS[0] }), false);
});

test('B: the workflow and the CLI apply the same dedup; factory record folds a raise the workflow missed', async () => {
  // the workflow: the judge's "new" paraphrase of a settled issue is noted on it, not asked
  const prior = { unknowns: [{ ...issue('U-1', 'Should the sync prune VLANs that are not in Nautobot?', 'user'), owner: 'user', status: 'settled', settled_by: 'user', subject: 'sync.prune', subject_explicit: true, answer: 'yes' }], evidence: [], assumptions: [], versions: [] };
  const r = await H.run(WF, brief({ map_needed: false, prior, next_ids: { U: 1, E: 0, A: 0 } }), crew({
    JUDGE: () => ({ questions: [{ question: 'Should VLANs missing from Nautobot be pruned from the trunks?', category: 'scope', why: 'w', default: 'd', unknown: 'new', same_as: 'new', subject: 'sync.prune' }], dismissed: [] }),
  }));
  assert.equal(r.result.status, 'ok');
  assert.equal(r.result.data.scout.unknowns.length, 1);
  assert.match(r.result.data.scout.unknowns[0].notes[0].text, /raised again \(not reopened\)/);
  assert.equal(r.result.data.scout.unknowns[0].status, 'settled');
  // the CLI: an envelope with a new issue that paraphrases a live one → folded as an alias
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  round(root, { scout: scoutData([{ ...issue('U-1', NXOS[0], 'world'), owner: 'user', status: 'proposed', subject: 'nxos.command.allowed.vlan', default: 'switchport trunk allowed vlan' }]) });
  F.cli(root, ['next']);
  const d = ledgerOf(root, J);
  round(root, { scout: scoutData([...d.unknowns, { ...issue('U-2', NXOS[5], 'world'), owner: 'research', status: 'open', source: 'god-eye', round: 2 }]) });
  const d2 = ledgerOf(root, J);
  assert.deepEqual(d2.unknowns.map((u) => u.id), ['U-1']);
  assert.deepEqual(d2.unknowns[0].aliases.map((a) => a.id), ['U-2']);
});

test('B: every agent that raises an issue carries same_as and subject in its schema and recipe; the briefs carry the ledger', () => {
  const S = (n) => JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'schemas', 'agent-outputs', `${n}.json`), 'utf8'));
  assert.ok(S('intent-map').properties.unknowns.items.properties.same_as && S('intent-map').properties.unknowns.items.properties.owner);
  assert.ok(S('judge').properties.questions.items.properties.same_as && S('judge').properties.questions.items.properties.subject);
  assert.ok(S('analyst').properties.questions.items.properties.same_as);
  assert.ok(S('intent-critique').properties.items.items.properties.ref && S('intent-critique').properties.checklist);
  assert.ok(S('intent-critique').properties.researchable_questions.items.properties.blocker);
  const root = F.makeRepo();
  newJob(root);
  F.cli(root, ['next']);
  round(root, { scout: scoutData([{ ...issue('U-1', 'Should the sync prune?', 'user'), owner: 'user', status: 'settled', settled_by: 'user', answer: 'yes' }]) });
  F.cli(root, ['next']);
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  const files = fs.readdirSync(path.join(root, '.factory', 'scratch', 'briefs', 'J-0001')).sort();
  const last = path.join(root, '.factory', 'scratch', 'briefs', 'J-0001', files[files.length - 1]);
  const judgeBrief = fs.readFileSync(path.join(last, fs.readdirSync(last).find((f) => /judge/.test(f))), 'utf8');
  assert.match(judgeBrief, /same_as/);
  assert.ok(b.ledger && Array.isArray(b.ledger.changed_sections), 'the ledger brief: what changed since the last round');
  assert.equal(b.scout.prior.unknowns[0].status, 'settled', 'the workflow gets the ledger, settled issues included');
});

// ---------------------------------------------------------------- C. one answer channel
test('C: factory answer U-n / Q-n / --default settles the issue (world facts too, user-asserted); free text is matched or refused loudly', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  round(root, { scout: scoutData([
    { ...issue('U-1', 'Does Nautobot 2.x expose tagged VLANs on the dcim interface API?', 'world'), owner: 'user', status: 'proposed', default: 'Nautobot 2.x interfaces carry tagged_vlans', reason: 'source unreachable: HTTP 404' },
    { ...issue('U-2', 'Should the sync prune VLANs not in Nautobot?', 'user'), owner: 'user', status: 'proposed', default: 'Your call: prune them' },
    { ...issue('U-3', 'Which device roles are in scope (leaf, spine, border)?', 'user'), owner: 'user', status: 'proposed' },
  ]) });
  let d = ledgerOf(root, J);
  assert.deepEqual(d.unknowns.map((u) => u.question_id), ['Q-3', 'Q-1', 'Q-2'], 'scope (user) before constraint (world)');
  // U-n with an answer: a world fact the user asserts
  let a = F.cli(root, ['answer', 'U-1', 'yes, tagged_vlans']);
  assert.equal(a.settled_by, 'user');
  // Q-n --default: the proposed default, without its "Your call:" label
  a = F.cli(root, ['answer', 'Q-1', '--default']);
  assert.deepEqual([a.settled_by, a.answer], ['assumption_accepted', 'prune them']);
  // free text: matched by overlap with the issue
  a = F.cli(root, ['answer', '--question', 'Which device roles are in scope for the sync?', '--answer', 'leaf and border']);
  assert.equal(a.issue, 'U-3');
  // free text that matches nothing: refused, with the open ids; nothing recorded
  const before = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'answers.json'), 'utf8')).length;
  const no = F.cli(root, ['answer', '--question', 'What colour should the dashboard be?', '--answer', 'blue']);
  assert.equal(no.code, 'no_match');
  assert.match(no.message, /Open: none|Open: /);
  assert.equal(JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'answers.json'), 'utf8')).length, before);
  d = ledgerOf(root, J);
  assert.deepEqual(d.unknowns.map((u) => [u.id, u.status, u.settled_by]), [['U-1', 'settled', 'user'], ['U-2', 'settled', 'assumption_accepted'], ['U-3', 'settled', 'user']]);
  assert.equal(d.unknowns[0].user_asserted, true);
  assert.equal(F.cli(root, ['answer', 'Q-9', 'x']).code, 'bad_input');
  // no default to accept
  const r2 = F.makeRepo();
  newJob(r2);
  F.cli(r2, ['next']);
  round(r2, { scout: scoutData([{ ...issue('U-1', 'Who signs off the first run?', 'user'), owner: 'user', status: 'proposed' }]) });
  assert.equal(F.cli(r2, ['answer', 'Q-1', '--default']).code, 'no_default');
});

test('C: a numbered chat reply ("1 yes, 2 …", "defaults") is recorded by the prompt hook as answers to the current question set', () => {
  assert.deepEqual(clarify.parseNumbered('1 yes, 2 trunk ports too'), { all_defaults: false, items: [{ n: 1, text: 'yes' }, { n: 2, text: 'trunk ports too' }] });
  assert.deepEqual(clarify.parseNumbered('1. yes\n2) no, keep them'), { all_defaults: false, items: [{ n: 1, text: 'yes' }, { n: 2, text: 'no, keep them' }] });
  assert.equal(clarify.parseNumbered('approve'), null);
  assert.equal(clarify.parseNumbered('defaults').all_defaults, true);
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  round(root, { scout: scoutData([
    { ...issue('U-1', 'Should the sync prune VLANs not in Nautobot?', 'user'), owner: 'user', status: 'proposed', options: ['Yes, prune', 'No'], default: 'Yes, prune' },
    { ...issue('U-2', 'Is the dry run required first?', 'user'), owner: 'user', status: 'proposed', default: 'yes' },
  ]) });
  // a numbered message before there is a question set is left alone; with one it is applied
  const out = hook('prompt.js', { prompt: '1 prune them, 2 yes', cwd: root, sessionId: 's', timestamp: 1 }, 'userPromptSubmitted');
  assert.match(JSON.parse(out.stdout).additionalContext, /Recorded 2 answer\(s\): Q-1 → prune them; Q-2 → yes/);
  const d = ledgerOf(root, J);
  assert.deepEqual(d.unknowns.map((u) => [u.status, u.answered.via]), [['settled', 'chat'], ['settled', 'chat']]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.factory', 'last-reply.json'), 'utf8')).reply, 'answers');
  // a number outside the set is refused, nothing recorded
  const bad = hook('prompt.js', { prompt: '7 yes', cwd: root, sessionId: 's', timestamp: 2 }, 'userPromptSubmitted');
  assert.equal(bad.stdout, '', 'the set is answered: nothing open, the message is left alone');
  // answers stay the main session's (and the user's), never a factory agent's
  const agent = spawnSync('node', [F.BIN, 'answer', 'Q-1', 'x'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '', FACTORY_RUNNER: '1' } });
  assert.equal(JSON.parse(agent.stdout).code, 'agent_not_allowed');
  assert.ok(guardRules.checkBash(root, 'factory answer Q-1 yes', guardRules.loadPolicy(root), { agent: true }), 'the guard refuses it from an agent too');
  assert.equal(guardRules.checkBash(root, 'factory clarify status', guardRules.loadPolicy(root), { agent: true }), null, 'clarify status is open to agents');
});

// ---------------------------------------------------------------- D. research has a defined exit
test('D: one research attempt and one longer retry; unreachable, unverified or verifier timeout → one user question with a default; failed sources kept', async () => {
  let repoCalls = 0;
  const map = { unknowns: [
    { text: 'Where is the reader?', kind: 'repo', impact: 'high', draft: 'the reader is src/add.js', owner: 'research', same_as: 'new', subject: 'reader' },
    { text: 'Does Nautobot 2.x expose tagged VLANs?', kind: 'world', impact: 'high', draft: 'Nautobot 2.x exposes tagged_vlans', owner: 'research', same_as: 'new', subject: 'nautobot.tagged' },
    { text: 'Does NX-OS keep allowed VLANs after a flap?', kind: 'world', impact: 'high', draft: 'NX-OS keeps them', owner: 'research', same_as: 'new', subject: 'nxos.flap' },
  ] };
  const r = await H.run(WF, brief(), crew({
    MAP: () => map,
    REPO: (p) => ((repoCalls += 1) === 1 ? null : { mode: 'repo', evidence: idsIn(p).map((u) => ({ unknown: u, claim: 'reader in src/add.js', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports', confidence: 'high' })), unresolved: [] }),
    WEB: (p) => ({ mode: 'web', web_available: true, evidence: [webEv('U-3')], unresolved: [{ unknown: 'U-2', reason: 'HTTP 404 from docs.nautobot.com' }], failed_sources: [{ unknown: 'U-2', source: 'https://docs.nautobot.com/x', reason: 'HTTP 404' }] }),
    VERIFY: (p) => (/U-3/.test(p) ? null : { verdicts: [...new Set([...p.matchAll(/"id": "(E-\d+)"/g)].map((m) => m[1]))].map((id) => ({ evidence_id: id, verdict: 'confirmed', confidence: 'high', reason: 'ok', quote_found: true })) }),
  }));
  const labels = r.calls.map((c) => [c.opts.label, c.opts.timeoutSec]);
  assert.deepEqual(labels.filter(([l]) => /^scout · repo/.test(l)), [['scout · repo #1', 120], ['scout · repo #1 (retry)', 240]], 'the failed scout is retried once with twice the budget');
  const by = Object.fromEntries(r.result.data.scout.unknowns.map((u) => [u.subject, u]));
  assert.deepEqual([by.reader.status, by.reader.settled_by, by.reader.attempts], ['settled', 'evidence', 2]);
  assert.deepEqual([by['nautobot.tagged'].status, by['nautobot.tagged'].owner], ['proposed', 'user']);
  assert.match(by['nautobot.tagged'].reason, /source unreachable: HTTP 404/);
  assert.equal(by['nautobot.tagged'].default, 'Nautobot 2.x exposes tagged_vlans', 'the default is the claim research could not confirm');
  assert.deepEqual(by['nautobot.tagged'].failed_sources, [{ source: 'https://docs.nautobot.com/x', reason: 'HTTP 404' }]);
  assert.equal(r.calls.filter((c) => /^scout · web/.test(c.opts.label)).length, 1, 'an unreachable source is not retried');
  assert.deepEqual([by['nxos.flap'].status, by['nxos.flap'].owner], ['proposed', 'user'], 'the verifier timed out: unverified → the user');
  assert.match(by['nxos.flap'].reason, /verifier failed or ran out of time/);
  assert.equal(r.result.status, 'needs_user');
  assert.deepEqual(r.result.questions.map((q) => q.unknown).sort(), ['U-2', 'U-3']);
  // the next round does not research them again, and failed sources travel with the issue
  const next = await H.run(WF, brief({ map_needed: false, prior: { ...r.result.data.scout, unknowns: r.result.data.scout.unknowns.map((u) => (u.id === 'U-2' ? { ...u, question_id: 'Q-1' } : u)) }, next_ids: { U: 3, E: 3, A: 1 } }), crew({ WEB: () => { throw new Error('researched again'); } }));
  assert.ok(!next.calls.some((c) => /^scout/.test(c.opts.label)));
  // the scout brief tells web scouts not to fetch failed sources again
  const root = F.makeRepo();
  newJob(root);
  F.cli(root, ['next']);
  round(root, { scout: scoutData([{ ...issue('U-1', 'Does Nautobot expose tagged VLANs?', 'world'), owner: 'research', status: 'researching', failed_sources: [{ source: 'https://docs.nautobot.com/x', reason: 'HTTP 404' }] }]) });
  F.cli(root, ['next']);
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.deepEqual(b.scout.pending, ['U-1'], 'a researching issue is retried next round');
  assert.equal(b.scout.prior.unknowns[0].failed_sources[0].source, 'https://docs.nautobot.com/x');
});

// ---------------------------------------------------------------- E. rounds review only what changed
test('E: briefs carry what changed; a round with nothing new skips the analysts and the judge', async () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.equal(b.ledger.changed_sections, null, 'the first round reviews everything');
  round(root, { scout: scoutData([{ ...issue('U-1', 'Should the sync prune?', 'user'), owner: 'user', status: 'proposed', default: 'yes' }]) });
  F.cli(root, ['next']);
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.deepEqual(b.ledger.changed_sections, []);
  assert.equal(b.ledger.nothing_new, false, 'the question was asked last round: its default is taken now');
  assert.deepEqual(b.ledger.new_since.defaults_taken, [{ issue: 'U-1', default: 'yes' }]);
  assert.ok(b.editor.todo.some((t) => t.ref === 'U-1'), 'the editor applies the accepted default');
  // a section edited by the contract editor shows as changed next round
  const c = fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8');
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: APPROVE, contract: { text: c.replace('- Access-port VLANs', '- Access-port VLANs\n- Pruning access ports'), edits: [{ label: 'apply', ok: true, applied: [{ ref: 'U-1', section: 'Non-goals', change: 'x' }], skipped: [] }] }, scout: scoutData(ledgerOf(root, J).unknowns) }));
  // the workflow: nothing new → analysts and judge skipped, the ledger's proposals asked
  const prior = { unknowns: [{ ...issue('U-1', 'Who signs off?', 'user'), owner: 'user', status: 'proposed', default: 'the lead' }], evidence: [], assumptions: [], versions: [] };
  const r = await H.run(WF, brief({ map_needed: false, prior, next_ids: { U: 1, E: 0, A: 0 } }, { ledger: { round: 2, new_since: {}, changed_sections: [], settled_sections: ['goal'], nothing_new: true } }), crew({
    'factory:intent-analyst': () => { throw new Error('analyst ran'); },
    'factory:judge': () => { throw new Error('judge ran'); },
  }));
  assert.equal(r.result.data.quiet, true);
  assert.deepEqual(r.result.questions.map((q) => q.unknown), ['U-1']);
  assert.deepEqual(r.result.data.degraded, [], 'skipped angles are not missing angles');
});

test('E: God Eye\'s checklist: unpointed or settled items are notes (approve with notes); a pointed blocker is revised, then asked; never needs_user with zero questions', async () => {
  const settled = { unknowns: [{ ...issue('U-1', NXOS[0], 'world'), owner: 'design', status: 'deferred_to_design', settled_by: 'design_deferral', subject: 'nxos.command.allowed.vlan' }], evidence: [], assumptions: [], versions: [] };
  const sb = () => brief({ map_needed: false, prior: settled, next_ids: { U: 1, E: 0, A: 0 } });
  // revise, nothing actionable: notes only
  let r = await H.run(WF, sb(), crew({ GOD: () => ({ ...APPROVE, verdict: 'revise', items: [{ issue: 'The goal could be tighter', severity: 'minor' }, { issue: NXOS[1], severity: 'major', ref: 'U-1' }, { issue: 'Log format?', severity: 'major' }] }) }));
  assert.equal(r.result.status, 'ok');
  assert.equal(r.result.data.approved_with_notes, true);
  assert.equal(r.result.data.notes.length, 3);
  assert.match(r.result.data.notes.find((n) => n.ref === 'U-1').text, /already settled \(deferred_to_design/);
  // a pointed blocker: editor → God Eye again → approve
  let god = 0;
  r = await H.run(WF, sb(), crew({
    GOD: () => ((god += 1) === 1 ? { ...APPROVE, verdict: 'revise', items: [{ issue: 'AC-2 is not testable', severity: 'blocker', ref: 'AC-2', suggestion: 'name the output' }] } : APPROVE),
    EDIT: (p) => { assert.match(p, /"ref": "AC-2"/); return { contract: '# x\n\n## Intent\n- Problem: p\n', applied: [{ ref: 'AC-2', section: 'Acceptance criteria', change: 'x' }], skipped: [] }; },
  }));
  assert.deepEqual(r.calls.map((c) => c.opts.label).filter((l) => /god|editor/.test(l)), ['god-eye · intent', 'contract editor · God Eye\'s items', 'god-eye · intent (after the revision)']);
  assert.equal(r.result.status, 'ok');
  assert.equal(r.result.data.contract.text, '# x\n\n## Intent\n- Problem: p\n');
  assert.match(r.calls.find((c) => /after the revision/.test(c.opts.label)).prompt, /----- BEGIN CONTRACT -----/);
  // still a blocker after the revision → one question with God Eye's suggestion as its default
  r = await H.run(WF, sb(), crew({ GOD: () => ({ ...APPROVE, verdict: 'revise', items: [{ issue: 'AC-2 is not testable', severity: 'blocker', ref: 'AC-2', suggestion: 'AC-2: a dry run lists each change' }] }) }));
  assert.equal(r.result.status, 'needs_user');
  assert.deepEqual(r.result.questions.map((q) => [q.category, q.default]), [['acceptance', 'AC-2: a dry run lists each change']]);
  // intent not confirmed → an intent question, never zero questions
  r = await H.run(WF, sb(), crew({ GOD: () => ({ ...APPROVE, intent_confirmed: false }) }));
  assert.equal(r.result.status, 'needs_user');
  assert.equal(r.result.questions[0].category, 'intent');
  for (const x of [r]) assert.ok(!(x.result.status === 'needs_user' && !x.result.questions.length));
  assert.deepEqual(validate(ENV, r.result), []);
});

// ---------------------------------------------------------------- F. implementation facts go to design
test('F: implementation facts are deferred to design: not asked, not blocking intent_grounded, handed to ground and decide', () => {
  for (const t of [NXOS[0], 'What are the exact line ranges in sync/nxos.py that build the commands?', 'Which pynautobot API field holds the untagged VLAN?', 'Does the ntc-templates parser return trunking_vlans as a list?']) assert.equal(clarify.classify({ text: t }, 'world'), 'design', t);
  for (const t of ['Does Nautobot 2.x expose tagged VLANs on interfaces?', 'Where is add implemented?']) assert.equal(clarify.classify({ text: t }, 'repo'), 'research', t);
  assert.equal(clarify.classify({ text: NXOS[0], owner: 'research' }, 'world'), 'research', 'the agent\'s owner wins');
  assert.equal(clarify.classify({ text: 'exact syntax?' }, 'user'), 'user', 'only repo and world issues fall back to the rule');
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  const r = round(root, { scout: scoutData([{ ...issue('U-1', NXOS[0], 'world') }]), critique: APPROVE }, 'ok');
  assert.equal(r.status, 'ok', 'medium risk: an implementation-fact world unknown does not block H1');
  const d = ledgerOf(root, J);
  assert.deepEqual([d.unknowns[0].owner, d.unknowns[0].status, d.unknowns[0].settled_by], ['design', 'deferred_to_design', 'design_deferral']);
  assert.deepEqual(intent.groundedProblems(root, require('../cli/core/job').load(root, J)), []);
  assert.match(fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8'), /## Deferred to design\n<!--[^\n]*-->\n- U-1: Which NX-OS CLI command/);
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  F.cli(root, ['next']);
  const g = F.cli(root, ['wfargs', 'ground']);
  const files = fs.readdirSync(path.join(root, '.factory', 'scratch', 'briefs', J)).filter((f) => /^ground/.test(f));
  const text = fs.readdirSync(path.join(root, '.factory', 'scratch', 'briefs', J, files[0])).map((f) => fs.readFileSync(path.join(root, '.factory', 'scratch', 'briefs', J, files[0], f), 'utf8')).join('\n');
  assert.ok(g.probes.length);
  assert.match(text, /Deferred to design by clarify[\s\S]*U-1 \[world\] Which NX-OS CLI command/);
});

// ---------------------------------------------------------------- G. progress, not rounds
test('G: two rounds in a row with no progress park the job (not converging); a degraded round is retried once and not counted; resume resets', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const job = require('../cli/core/job');
  F.cli(root, ['next']);
  const stuck = { ...issue('U-1', 'Should the sync prune?', 'user'), owner: 'user', status: 'proposed' };
  let r = round(root, { scout: scoutData([stuck]) });
  assert.equal(r.clarify.round.progress, true, 'asked a question');
  // the user doesn't answer and there is no default: waiting, not progress
  F.cli(root, ['next']);
  r = round(root, { scout: scoutData(ledgerOf(root, J).unknowns) });
  assert.equal(r.status, 'needs_user');
  assert.equal(r.questions[0].id, 'Q-1', 'the same question again, same id');
  assert.equal(r.clarify.round.progress, false);
  // a degraded round: retried automatically, not counted
  F.cli(root, ['next']);
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  r = F.record(root, F.envelope(b, 'degraded', { analysts: [], degraded: ['intent-analyst:scope'], judge: { questions: [], dismissed: [] }, scout: scoutData(ledgerOf(root, J).unknowns) }));
  assert.equal(r.status, 'retry');
  let st = job.load(root, J);
  assert.deepEqual([st.counters.clarify_no_progress, st.counters.clarify_degraded_rounds], [1, 1]);
  assert.equal(clarify.limits(st).counted, 2);
  // another round with nothing settled: not converging → park
  F.cli(root, ['next']);
  r = round(root, { scout: scoutData(ledgerOf(root, J).unknowns), critique: { ...APPROVE, verdict: 'revise', items: [{ issue: 'x', severity: 'minor' }] } });
  assert.equal(r.status, 'needs_user', 'a waiting question is not a park: the user is still the one to act');
  // with the question answered by "drop" and nothing else moving: two empty rounds park
  const r2 = F.makeRepo();
  const J2id = newJob(r2);
  F.cli(r2, ['next']);
  const fail = { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: APPROVE };
  fs.writeFileSync(path.join(F.jobDir(r2, J2id), 'contract.md'), J2.CONTRACT.replace('## Goal\nA sync job', '## Goal\n<the outcome>\n\nA sync job').replace(/## Goal\n[\s\S]*?\n\n## Non-goals/, '## Goal\n<the outcome in one or two sentences>\n\n## Non-goals'));
  let x = round(r2, { ...fail, scout: scoutData([]) }, 'ok');
  assert.equal(x.status, 'revise', 'contract problems, nothing for the user: clarify runs again (the editor fixes them)');
  F.cli(r2, ['next']);
  x = round(r2, { ...fail, scout: scoutData([]) }, 'ok');
  assert.equal(x.status, 'park');
  assert.match(x.park_reason, /not converging: 2 round\(s\) in a row settled nothing/);
  st = job.load(r2, J2id);
  assert.equal(st.status, 'parked');
  F.reply(r2, 'resume');
  st = job.load(r2, J2id);
  assert.equal(st.counters.clarify_no_progress, 0, 'resume resets the no-progress counter');
  assert.equal(F.cli(r2, ['next']).skill, 'clarify');
});

test('G: the hard ceiling (limits.max_intent_rounds, default 10) parks at factory next; resume allows the rounds the no-progress rule needs; old snapshots keep max+2', () => {
  const pol = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'policy', 'default-policy.json'), 'utf8')).limits;
  assert.deepEqual([pol.max_intent_rounds, pol.clarify_no_progress_rounds], [10, 2]);
  const root = F.makeRepo();
  const J = newJob(root, { policy: { limits: { max_intent_rounds: 2 } } });
  const job = require('../cli/core/job');
  const st = job.load(root, J);
  assert.equal(clarify.limits(st).ceiling, 2);
  F.cli(root, ['next']);
  round(root, { scout: scoutData([{ ...issue('U-1', 'q one', 'user'), owner: 'user', status: 'proposed', default: 'a' }]) });
  F.cli(root, ['next']);
  round(root, { scout: scoutData([...ledgerOf(root, J).unknowns, { ...issue('U-2', 'another thing entirely here', 'user'), owner: 'user', status: 'proposed', default: 'b', round: 2 }]) });
  const n = F.cli(root, ['next']);
  assert.equal(n.action, 'parked');
  assert.equal(n.rule, 'cap.clarify_rounds');
  assert.match(n.reason, /ceiling of 2 rounds/);
  F.reply(root, 'resume');
  const s2 = job.load(root, J);
  assert.equal(clarify.limits(s2).ceiling, 4, 'two more rounds after the ceiling');
  // a 0.4.x snapshot (no clarify_no_progress_rounds): max_intent_rounds + 2, or the new default if higher
  assert.equal(clarify.limits({ policy: { limits: { max_intent_rounds: 4 } }, counters: {} }).ceiling, 10);
  assert.equal(clarify.limits({ policy: { limits: { max_intent_rounds: 12 } }, counters: {} }).ceiling, 14);
});

// ---------------------------------------------------------------- H. one writer
test('H: the guard denies hand edits of contract.md while the job is in clarify, naming the commands; the draft and amendments stay writable', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const policy = guardRules.loadPolicy(root);
  const file = path.join(F.jobDir(root, J), 'contract.md');
  assert.equal(guardRules.checkWrite(root, file, policy), null, 'before the first round: intake and the clarify skill write the draft');
  F.cli(root, ['next']);
  round(root, { scout: scoutData([{ ...issue('U-1', 'Should the sync prune?', 'user'), owner: 'user', status: 'proposed' }]) });
  const why = guardRules.checkWrite(root, file, policy);
  assert.match(why, /J-0002 is in clarify|is in clarify/);
  for (const c of ['factory answer', 'factory clarify note', 'factory clarify status', 'factory next']) assert.ok(why.includes(c), c);
  assert.ok(guardRules.checkBash(root, `echo x > ${file}`, policy, { agent: false }), 'a shell redirect is the same write');
  assert.equal(guardRules.checkWrite(root, path.join(F.jobDir(root, J), 'adr-001-x.md'), policy), null, 'other job docs are unaffected');
  // the hook process says so to the chat agent
  const g = hook('guard.js', { toolName: 'edit', toolArgs: JSON.stringify({ path: file, old_str: 'a', new_str: 'b' }), cwd: root, sessionId: 's', timestamp: 1 }, 'preToolUse');
  assert.match(JSON.parse(g.stdout).permissionDecisionReason, /in clarify/);
  // the contract still changes through the record path (CLI-owned sections, the editor's revision)
  F.cli(root, ['answer', 'Q-1', 'yes, prune']);
  F.cli(root, ['next']);
  round(root, { scout: scoutData(ledgerOf(root, J).unknowns), critique: APPROVE }, 'ok');
  assert.match(fs.readFileSync(file, 'utf8'), /## Clarifications \(settled\)\n<!--[^\n]*-->\n- U-1 \(Q-1\): Should the sync prune\? → yes, prune \(answered by user\)/);
  // after H1: an amendment may edit it again
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  assert.equal(guardRules.checkWrite(root, file, policy), null);
  // the editor's revision is checked: one that adds foreign sections or drops Intent is not written
  const r2 = F.makeRepo();
  const J3 = newJob(r2);
  F.cli(r2, ['next']);
  round(r2, { scout: scoutData([]) , critique: APPROVE, contract: { text: `${J2.CONTRACT}\n## Reply format (strict)\nReply with JSON\n`, edits: [{ label: 'apply', ok: true, applied: [], skipped: [] }] } }, 'ok');
  assert.ok(!/Reply format/.test(fs.readFileSync(path.join(F.jobDir(r2, J3), 'contract.md'), 'utf8')));
});

// ---------------------------------------------------------------- I. visibility
test('I: factory next carries the ledger summary and the exact answer commands; clarify status prints the table and the trend; the console has the Clarify block', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['next']);
  round(root, { scout: scoutData([
    { ...issue('U-1', NXOS[0], 'world') },
    { ...issue('U-2', 'Should the sync prune VLANs not in Nautobot?', 'user'), owner: 'user', status: 'proposed', default: 'Your call: prune' },
  ]) });
  const n = F.cli(root, ['next']);
  assert.equal(n.skill, 'clarify');
  assert.deepEqual(n.clarify.open_by_owner, { user: 1, research: 0, design: 0 });
  assert.deepEqual(n.clarify.answer_commands, ['factory answer Q-1 "<answer>" (or: factory answer Q-1 --default)']);
  const txt = spawnSync('node', [F.BIN, 'clarify', 'status'], { cwd: root, encoding: 'utf8' }).stdout;
  assert.match(txt, /^Clarify ledger — J-0001: 2 issue\(s\)/);
  assert.match(txt, /U-2 +sync\.prune\.vlan\.nautobot +proposed +user +answer: factory answer Q-1/);
  assert.match(txt, /U-1 +nxos\.command\.allowed\.vlan +deferred_to_design +design +ground\/decide settle it/);
  assert.match(txt, /Round  opened  settled  deferred  asked  progress\n1 +2 +0 +1 +1 +yes/);
  const js = F.cli(root, ['clarify', 'status', '--json']);
  assert.equal(js.issues.length, 2);
  assert.equal(js.rounds[0].opened, 2);
  // read-only: no write, also from an agent
  const agent = spawnSync('node', [F.BIN, 'clarify', 'status', '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '', FACTORY_RUNNER: '1' } });
  assert.equal(JSON.parse(agent.stdout).job, J);
  F.cli(root, ['clarify', 'note', 'U-2', 'only on the leaf switches']);
  assert.equal(ledgerOf(root, J).unknowns.find((u) => u.id === 'U-2').notes.pop().text, 'only on the leaf switches');
  // the console
  const data = require('../cli/core/console').build(root, { job: J });
  const c = data.jobs.find((j) => j.id === J).clarify;
  assert.deepEqual([c.totals.issues, c.questions.length, c.deferred.length, c.rounds.length], [2, 1, 1, 1]);
  assert.ok(c.issues.every((r) => r.status && r.owner && r.next));
  const html = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  assert.match(html, /function clarifyBlock\(j\)/, 'the section view block');
  assert.match(html, /function clarifyHtml\(job\)/, 'the job view block');
  assert.match(html, /function turnLabel\(m\)/, 'the Board says how many questions');
});

// ---------------------------------------------------------------- migration: the J-0002 fixture
test('migration: J-0002 (v1) → the ledger on first touch: duplicates folded, free-form answers matched, implementation facts deferred; status works with no new round', () => {
  const root = F.makeRepo();
  const J = J2.build(root);
  assert.equal(J, 'J-0002');
  const before = ledgerOf(root, J);
  assert.equal(before.version, 1);
  // what v1 left: 26 unknowns, 25 findings, 13 answers, the world unknowns still blocking
  assert.deepEqual([before.unknowns.length, before.evidence.length, JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'answers.json'), 'utf8')).length], [26, 25, 13]);
  const job = require('../cli/core/job');
  assert.ok(intent.groundedProblems(root, job.load(root, J)).length >= 4, 'v1: world unknowns neither confirmed nor answered block');
  // clarify status: read-only, shows the migrated ledger and what migrated
  const txt = spawnSync('node', [F.BIN, 'clarify', 'status', '--job', J], { cwd: root, encoding: 'utf8' }).stdout;
  assert.match(txt, /Migrated from v1: 5 duplicate\(s\) folded \(U-19→U-7, U-20→U-7, U-22→U-7, U-23→U-7, U-25→U-7\); 4 free-form answer\(s\) matched \(U-4, U-2, U-26, U-13\); 4 deferred to design \(U-7, U-12, U-15, U-17\)/);
  assert.match(txt, /Not matched: "What colour should the dashboard be\?"/);
  assert.match(txt, /U-7 +nxos\.command\.allowed\.vlan +deferred_to_design +design .*\[aliases U-19, U-20, U-22, U-23, U-25\]/);
  assert.match(txt, /U-5 +sync\.run\.nightly\.every +proposed +user +answer: factory answer Q-4/);
  assert.equal(ledgerOf(root, J).version, 1, 'status wrote nothing');
  const v = F.cli(root, ['clarify', 'status', '--job', J, '--json']);
  assert.deepEqual([v.totals.issues, v.totals.settled, v.totals.deferred_to_design, v.totals.dropped, v.open_by_owner.user], [21, 16, 4, 0, 1]);
  assert.equal(v.limits.ceiling, 10, 'the 0.4.x snapshot (cap 6) gets the new default ceiling');
  const by = Object.fromEntries(v.issues.map((r) => [r.id, r]));
  assert.deepEqual([by['U-2'].status, by['U-2'].settled_by], ['settled', 'user'], 'free-form answer matched by overlap: a world fact the user settled');
  assert.deepEqual([by['U-16'].status, by['U-16'].settled_by], ['settled', 'assumption_accepted'], 'low impact deferred → accepted');
  assert.deepEqual([by['U-1'].settled_by, by['U-14'].settled_by], ['evidence', 'evidence']);
  // the v2 floor: what blocked under v1 no longer does (U-2 answered, the NX-OS cluster deferred)
  const migrated = clarify.ensure(root, job.load(root, J));
  assert.deepEqual(intent.groundedProblems(root, job.load(root, J), { data: migrated }), []);
  // the first write persists it: the human resumes, and a note is a write
  F.reply(root, `resume ${J}`);
  F.cli(root, ['clarify', 'note', '--job', J, 'U-5', 'nightly is fine for now']);
  const after = ledgerOf(root, J);
  assert.equal(after.version, 2);
  assert.equal(after.migration.folded.length, 5);
  assert.deepEqual(after.migration.deferred.map((x) => x.id), ['U-7', 'U-12', 'U-15', 'U-17']);
  assert.ok(after.evidence.every((e) => !['U-19', 'U-20', 'U-22', 'U-23', 'U-25'].includes(e.unknown)), 'evidence re-pointed at the canonical issue');
});

// ---------------------------------------------------------------- end to end on the fake Copilot
test('e2e: a fresh J-0002-shaped job through factory run: paraphrases folded, HTTP 404 and a verifier timeout asked once with defaults, God Eye revise with nothing actionable → H1 in two rounds', () => {
  const root = F.makeRepo();
  const J = newJob(root, { policy: { intent_research: { verifier_batch: 1 } } });
  const h = harness(CREW);
  assert.equal(F.cli(root, ['next']).skill, 'clarify');
  // round 1
  let r = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.__code, 0, r.__stderr);
  assert.equal(r.status, 'needs_user', JSON.stringify(r).slice(0, 400));
  assert.deepEqual(r.questions.map((q) => [q.id, q.unknown]), [['Q-1', 'U-5'], ['Q-2', 'U-3'], ['Q-3', 'U-4']]);
  assert.match(r.questions[1].why, /source unreachable: HTTP 404/);
  assert.match(r.questions[2].why, /verifier failed or ran out of time/);
  assert.ok(r.questions.every((q) => q.default && !/^None/.test(q.default)), 'each with a default to accept');
  let d = ledgerOf(root, J);
  const nx = d.unknowns.find((u) => u.id === 'U-2');
  assert.deepEqual([nx.status, nx.owner], ['deferred_to_design', 'design'], 'the NX-OS command is design\'s');
  assert.ok(nx.notes.some((x) => /raised again \(not reopened\)/.test(x.text)), 'the judge\'s paraphrase was folded into it');
  assert.equal(d.unknowns.length, 5, 'no issue was created twice');
  assert.equal(d.unknowns.find((u) => u.id === 'U-3').failed_sources[0].reason, 'HTTP 404');
  // the user: a numbered chat reply, a free-form answer, one question skipped (its default applies)
  const out = hook('prompt.js', { prompt: '1 yes, prune them', cwd: root, sessionId: 's', timestamp: 1 }, 'userPromptSubmitted');
  assert.match(JSON.parse(out.stdout).additionalContext, /Q-1 → yes, prune them/);
  assert.equal(F.cli(root, ['answer', '--question', 'Does Nautobot expose tagged VLANs on interfaces in 2.x?', '--answer', 'yes, tagged_vlans on dcim interfaces']).issue, 'U-3');
  assert.ok(guardRules.checkWrite(root, path.join(F.jobDir(root, J), 'contract.md'), guardRules.loadPolicy(root)), 'the chat agent cannot hand-edit the contract now');
  // round 2
  assert.equal(F.cli(root, ['next']).skill, 'clarify');
  r = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 600));
  assert.equal(r.next_gate, 'H1');
  assert.match(r.message, /approved with notes/);
  const labels = r.agents.map((a) => a.label);
  assert.ok(labels[0] === 'contract editor · apply what was settled', 'the editor applies the answers first');
  assert.ok(labels.includes('contract editor · God Eye\'s items') && labels.includes('god-eye · intent (after the revision)'));
  assert.ok(!labels.includes('intent map') && !labels.some((l) => /^scout/.test(l)), 'nothing researched again');
  d = ledgerOf(root, J);
  assert.deepEqual(d.unknowns.map((u) => [u.id, u.status, u.settled_by]), [['U-1', 'settled', 'evidence'], ['U-2', 'deferred_to_design', 'design_deferral'], ['U-3', 'settled', 'user'], ['U-4', 'settled', 'assumption_accepted'], ['U-5', 'settled', 'user']]);
  assert.deepEqual(d.rounds.map((x) => [x.ledger.opened, x.ledger.settled, x.ledger.progress]), [[5, 1, true], [0, 3, true]]);
  const text = fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8');
  assert.match(text, /- AC-2: a dry run lists each VLAN it would add or remove per interface/, 'God Eye\'s pointed blocker was revised in');
  assert.match(text, /VLANs on a trunk that Nautobot does not list are removed/, 'the answers were applied');
  assert.match(text, /## Clarifications \(settled\)[\s\S]*U-4 \(Q-3\)[^\n]*\(default accepted\)/);
  assert.match(text, /## Deferred to design[\s\S]*U-2: Which NX-OS CLI command/);
  assert.deepEqual(F.cli(root, ['contract', 'check']).problems, []);
  const n = F.cli(root, ['next']);
  assert.equal(n.action, 'gate');
  assert.equal(n.step, 'H1');
  assert.notEqual(require('../cli/core/job').load(root, J).status, 'parked');
});

test('e2e: the migrated J-0002 resumes and reaches H1: God Eye re-raises the NX-OS command (a note), the open decision is answered', () => {
  const root = F.makeRepo();
  const J = J2.build(root);
  F.reply(root, `resume ${J}`);
  const n = F.cli(root, ['next']);
  assert.equal(n.skill, 'clarify');
  assert.deepEqual(n.clarify.answer_commands, ['factory answer Q-4 "<answer>"']);
  const h = harness(CREW, { FAKE_CLARIFY: JSON.stringify({ stall: true }) });
  let r = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.status, 'needs_user', JSON.stringify(r).slice(0, 500));
  assert.deepEqual(r.questions.map((q) => [q.id, q.waiting]), [['Q-4', true]], 'the open decision, same id, nothing re-asked');
  assert.ok(r.agents.some((a) => a.label === 'contract editor · apply what was settled'), 'the answers v1 never applied are applied now');
  F.cli(root, ['answer', 'Q-4', 'nightly']);
  assert.equal(F.cli(root, ['next']).skill, 'clarify');
  r = h.run(root, ['fanout-judge', '--config', 'clarify']);
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 500));
  assert.equal(F.cli(root, ['next']).step, 'H1');
  const d = ledgerOf(root, J);
  assert.equal(d.version, 2);
  assert.ok(d.unknowns.filter((u) => !['settled', 'deferred_to_design', 'dropped'].includes(u.status)).length === 0);
  assert.equal(d.unknowns.find((u) => u.id === 'U-7').status, 'deferred_to_design');
});
