'use strict';
// Grounded intent: research first, ask only what research can't answer.
// The clarify scout phase (workflow harness), the CLI's re-checks and question rules, the
// contract's evidence-backed Assumptions, "change A-n" / "drop A-n" replies (also through the
// prompt hook), the intent_grounded floor, budgets, telemetry and a full run through the runner.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');
const { validate } = require('../cli/lib/schema');
const contract = require('../cli/core/contract');
const Q = require('../cli/core/questions');
const intent = require('../cli/core/intent');
const human = require('../cli/core/human');

const WF = path.join(F.PLUGIN, 'workflows', 'fanout-judge.js');
const ENV = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'schemas', 'envelope.json'), 'utf8'));
const schema = (n) => JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'schemas', 'agent-outputs', `${n}.json`), 'utf8'));

// ---------------------------------------------------------------- workflow harness
const item = (id, category, gate = false) => ({ id, label: id, category, gate, prompt: `p-${id}`, schema: {}, agent_type: 'factory:intent-analyst' });
function brief(scout = {}) {
  const budget = { repo_scouts: 3, web_scouts: 1, time_sec: 120, strict_second_source: false, unknowns_per_scout: 3, max_unknowns: 12, verifier_batch: 4, max_verifiers: 2, mapper_sec: 180, ...(scout.budget || {}) };
  return {
    workflow: 'fanout-judge', job: 'J-0001', input_hash: 'h', budgets: { limit: {} }, config: 'clarify', round: 1, limits: { max_questions: 5 }, asked: [],
    fanout: [item('intent', 'intent', true), item('scope', 'scope')],
    judge: { prompt: 'JUDGE', schema: {}, agent_type: 'factory:judge' },
    critique: { prompt: 'GOD', schema: {}, agent_type: 'factory:god-eye' },
    scout: {
      round: 1, risk: 'low', web: { enabled: true, reason: null, search_mcp: null }, map_needed: true,
      prior: { unknowns: [], evidence: [], assumptions: [], versions: [] }, pending: [], next_ids: { U: 0, E: 0, A: 0 },
      mapper: { agent_type: 'factory:intent-mapper', label: 'intent map', prompt: 'MAP', schema: {} },
      repo_scout: { agent_type: 'factory:researcher', label: 'scout · repo', mode: 'repo', prompt_template: 'REPO {{unknowns}}', schema: {} },
      web_scout: { agent_type: 'factory:researcher', label: 'scout · web', mode: 'web', prompt_template: 'WEB {{unknowns}}', schema: {} },
      verifier: { agent_type: 'factory:verifier', label: 'verify evidence', prompt_template: 'VERIFY {{findings}}', schema: {} },
      ...scout,
      budget,
    },
  };
}
const idsIn = (prompt) => [...prompt.matchAll(/"id": "(U-\d+)"/g)].map((m) => m[1]);
const repoEv = (u, extra = {}) => ({ unknown: u, claim: `claim for ${u}`, source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports', confidence: 'high', ...extra });
const webEv = (u, extra = {}) => ({ unknown: u, claim: `web claim for ${u}`, source: `https://docs.example.com/${u}`, source_tier: 'official', retrieved_at: '2026-10-14', quote: `quote ${u}`, applies_to_version: 'v2', confidence: 'high', ...extra });
const verdictsFor = (prompt, verdict = 'confirmed', extra = {}) => ({ verdicts: [...new Set([...prompt.matchAll(/"id": "(E-\d+)"/g)].map((m) => m[1]))].map((id) => ({ evidence_id: id, verdict, confidence: 'high', reason: 'checked', quote_found: true, ...extra })) });
// A default crew: no questions, God Eye approves with nothing researchable.
function crew(over = {}) {
  return (prompt, opts) => {
    const t = opts.agentType;
    for (const [k, f] of Object.entries(over)) if (prompt.startsWith(k) || t === k) return f(prompt, opts);
    if (t === 'factory:intent-analyst') return { focus: 'x', questions: [] };
    if (t === 'factory:judge') return { questions: [], dismissed: [] };
    if (t === 'factory:god-eye') return { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, items: [], researchable_questions: [] };
    if (t === 'factory:verifier') return verdictsFor(prompt);
    throw new Error(`unexpected ${t}: ${prompt.slice(0, 60)}`);
  };
}

test('scout phase: map → scouts (budgeted, grouped, time-capped) → verifier → sort, all before the analysts', async () => {
  const map = { unknowns: [
    ...[1, 2, 3, 4, 5].map((i) => ({ text: `repo thing ${i}`, kind: 'repo', impact: i === 5 ? 'medium' : 'high', draft: `repo claim ${i}` })),
    ...[1, 2].map((i) => ({ text: `world thing ${i}`, kind: 'world', impact: 'high', draft: `world claim ${i}` })),
    { text: 'who is it for', kind: 'user', impact: 'high', draft: 'Who is it for?' },
    { text: 'naming of a flag', kind: 'repo', impact: 'low', draft: 'call it --fast' },
    { text: 'queue or cron', kind: 'decision', impact: 'high', draft: 'Queue or cron?', options: ['queue', 'cron'], research: 'none' },
  ] };
  const b = brief({ budget: { repo_scouts: 1, web_scouts: 1, unknowns_per_scout: 3 } });
  const r = await H.run(WF, b, crew({
    MAP: () => map,
    REPO: (p) => ({ mode: 'repo', evidence: idsIn(p).map((u) => repoEv(u)), unresolved: [] }),
    WEB: (p) => ({ mode: 'web', web_available: true, evidence: idsIn(p).map((u) => webEv(u)), unresolved: [] }),
  }));
  const labels = r.calls.map((c) => c.opts.label);
  assert.equal(labels[0], 'intent map');
  assert.ok(labels.indexOf('scout · repo #1') < labels.indexOf('intent'), 'research before the intent gate');
  assert.ok(labels.indexOf('verify evidence #1') < labels.indexOf('intent'));
  assert.deepEqual(labels.filter((l) => /^scout/.test(l)).sort(), ['scout · repo #1', 'scout · web #1'], 'one repo scout and one web scout: the budget');
  assert.ok(r.calls.filter((c) => /^(scout|verify)/.test(c.opts.label)).every((c) => c.opts.timeoutSec === 120), 'scouts and verifier run under the time cap');
  assert.equal(r.calls.find((c) => c.opts.label === 'intent map').opts.timeoutSec, 180);
  const repoCall = r.calls.find((c) => c.opts.label === 'scout · repo #1');
  assert.deepEqual(idsIn(repoCall.prompt), ['U-1', 'U-2', 'U-3'], 'high impact first, three per scout');
  const sc = r.result.data.scout;
  const by = Object.fromEntries(sc.unknowns.map((u) => [u.text, u]));
  assert.equal(by['repo thing 4'].resolution, 'question');
  assert.match(by['repo thing 4'].note, /repo research budget spent/);
  assert.equal(by['naming of a flag'].resolution, 'deferred', 'low impact: assumed, not researched');
  assert.equal(by['who is it for'].resolution, 'question');
  assert.equal(by['queue or cron'].resolution, 'question');
  assert.equal(by['world thing 1'].resolution, 'assumption', 'web evidence the verifier confirmed');
  assert.deepEqual(sc.assumptions.map((a) => a.unknown).sort(), ['U-1', 'U-2', 'U-3', 'U-6', 'U-7']);
  // the analysts, judge and God Eye see the evidence
  const analyst = r.calls.find((c) => c.opts.label === 'intent');
  assert.match(analyst.prompt, /INTENT EVIDENCE:[\s\S]*"must_ask"[\s\S]*U-8/);
  assert.match(r.calls.find((c) => c.opts.label === 'judge').prompt, /INTENT EVIDENCE/);
  // the must-ask researchable unknowns become questions even though the judge returned none
  assert.equal(r.result.status, 'needs_user');
  assert.deepEqual(r.result.questions.map((q) => q.unknown).sort(), ['U-4', 'U-5']);
  assert.ok(r.result.questions.every((q) => /budget spent/.test(q.why)));
  assert.deepEqual(validate(ENV, r.result), []);
});

test('scout phase: web off → world unknowns become questions marked "not researched (web off)", no web scout runs', async () => {
  const b = brief({ web: { enabled: false, reason: 'policy (intent_research.web is false)' } });
  const r = await H.run(WF, b, crew({
    MAP: () => ({ unknowns: [{ text: 'Does Stripe retry webhooks?', kind: 'world', impact: 'high', draft: 'Stripe retries webhooks for 3 days' }] }),
  }));
  assert.ok(!r.calls.some((c) => /^scout/.test(c.opts.label)));
  const u = r.result.data.scout.unknowns[0];
  assert.equal(u.resolution, 'question');
  assert.match(u.note, /not researched \(web off/);
  assert.equal(r.result.questions.length, 1);
  assert.match(r.result.questions[0].why, /web off/);
});

test('scout phase degrades gracefully: no web access / a failed scout → unverified → asked; a failed mapper → degraded', async () => {
  let r = await H.run(WF, brief(), crew({
    MAP: () => ({ unknowns: [{ text: 'w', kind: 'world', impact: 'high', draft: 'w is true' }, { text: 'r', kind: 'repo', impact: 'high', draft: 'r is true' }] }),
    WEB: (p) => ({ mode: 'web', web_available: false, evidence: [webEv(idsIn(p)[0])], unresolved: [{ unknown: idsIn(p)[0], reason: 'web_fetch failed' }] }),
    REPO: () => null,
  }));
  const sc = r.result.data.scout;
  assert.equal(sc.web.available, false);
  assert.equal(sc.evidence.length, 0, 'no web evidence is kept when the scout had no web access');
  assert.match(sc.unknowns[0].note, /no web access/);
  assert.match(sc.unknowns[1].note, /scout failed or ran out of time/);
  assert.equal(r.calls.filter((c) => /^scout · repo/.test(c.opts.label)).length, 1, 'scouts are not retried: the budget is the budget');
  assert.deepEqual(r.result.data.degraded, [], 'a failed scout is not a missing angle');
  assert.deepEqual(r.result.questions.map((q) => q.unknown).sort(), ['U-1', 'U-2']);
  // the mapper failing twice: nothing was researched, the run is degraded
  r = await H.run(WF, brief(), crew({ MAP: () => null }));
  assert.equal(r.calls.filter((c) => /^intent map/.test(c.opts.label)).length, 2);
  assert.equal(r.result.status, 'degraded');
  assert.deepEqual(r.result.data.degraded, ['intent-mapper']);
});

test('verifier: contradicted and quote mismatches are asked with both sources; strict second source at high risk', async () => {
  const map = { unknowns: [{ text: 'a', kind: 'world', impact: 'high', draft: 'a' }, { text: 'b', kind: 'world', impact: 'high', draft: 'b' }, { text: 'c', kind: 'world', impact: 'high', draft: 'c' }] };
  const r = await H.run(WF, brief({ budget: { web_scouts: 1, strict_second_source: true } }), crew({
    MAP: () => map,
    WEB: (p) => ({ mode: 'web', evidence: idsIn(p).map((u) => webEv(u)), unresolved: [] }),
    VERIFY: () => ({ verdicts: [
      { evidence_id: 'E-1', verdict: 'contradicted', confidence: 'high', reason: 'the changelog says otherwise', counter_source: { source: 'https://x/changelog', quote: 'removed in v2' } },
      { evidence_id: 'E-2', verdict: 'confirmed', confidence: 'high', reason: 'ok', quote_found: false },
      { evidence_id: 'E-3', verdict: 'confirmed', confidence: 'high', reason: 'ok', quote_found: true, second_source: null },
    ] }),
  }));
  const ev = Object.fromEntries(r.result.data.scout.evidence.map((e) => [e.id, e]));
  assert.equal(ev['E-1'].verdict, 'contradicted');
  assert.equal(ev['E-1'].counter_source.source, 'https://x/changelog');
  assert.equal(ev['E-2'].verdict, 'unverified', 'quote not found is never confirmed');
  assert.equal(ev['E-3'].verdict, 'unverified', 'high risk: no second source');
  assert.match(ev['E-3'].verdict_reason, /second source/);
  assert.equal(r.result.data.scout.assumptions.length, 0);
  assert.match(r.result.data.scout.unknowns[0].note, /sources disagree/);
  assert.equal(r.result.questions.length, 3);
});

test('judge: researchable questions research answered are dropped; a new world question is researched first, then re-judged', async () => {
  let judged = 0;
  const r = await H.run(WF, brief(), crew({
    MAP: () => ({ unknowns: [{ text: 'which lib', kind: 'repo', impact: 'high', draft: 'uses lib x' }] }),
    REPO: (p) => ({ mode: 'repo', evidence: idsIn(p).map((u) => repoEv(u)), unresolved: [] }),
    WEB: (p) => ({ mode: 'web', evidence: idsIn(p).map((u) => webEv(u)), unresolved: [] }),
    JUDGE: (p) => {
      judged += 1;
      if (judged === 1) return { questions: [{ question: 'Which lib do we use?', category: 'constraint', why: 'w', default: 'x', unknown: 'U-1' }, { question: 'Does the vendor rate-limit?', category: 'constraint', why: 'w', default: '?', unknown: 'new', kind: 'world' }], dismissed: [] };
      assert.match(p, /NEW EVIDENCE[\s\S]*"U-2"[\s\S]*"assumption"/);
      return { questions: [{ question: 'Who signs off?', category: 'scope', why: 'w', default: 'Your call: the lead', unknown: 'new', kind: 'user', preference: true }], dismissed: [] };
    },
  }));
  assert.equal(judged, 2);
  assert.ok(r.calls.some((c) => c.opts.label === 'scout · web #1'));
  assert.deepEqual(r.result.questions.map((q) => q.question), ['Who signs off?']);
  assert.ok(r.result.data.scout.researchable_dropped.length >= 1);
});

test('God Eye: researchable questions go back to the scouts once; approval needs the list empty', async () => {
  let god = 0;
  const gate = (rq) => ({ verdict: 'approve', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, items: [], researchable_questions: rq });
  let r = await H.run(WF, brief(), crew({
    MAP: () => ({ unknowns: [] }),
    REPO: (p) => ({ mode: 'repo', evidence: idsIn(p).map((u) => repoEv(u)), unresolved: [] }),
    GOD: () => ((god += 1) === 1 ? gate([{ question: 'Which test runner?', kind: 'repo', why: 'AC-1 names none' }]) : gate([])),
  }));
  assert.equal(god, 2);
  assert.ok(r.calls.some((c) => c.opts.label === 'god-eye · intent (after research)'));
  assert.equal(r.result.status, 'ok');
  assert.equal(r.result.data.scout.unknowns[0].source, 'god-eye');
  // still researchable after the second look: not approved
  r = await H.run(WF, brief({ budget: { repo_scouts: 0 } }), crew({ MAP: () => ({ unknowns: [] }), GOD: () => gate([{ question: 'Which test runner?', kind: 'repo' }]) }));
  assert.equal(r.result.status, 'needs_user');
});

test('later rounds reuse the evidence: no mapper, no scouts, unless something is pending', async () => {
  const prior = {
    unknowns: [{ id: 'U-1', text: 'which lib', kind: 'repo', impact: 'high', draft: 'uses x', research: 'repo', resolution: 'assumption', evidence: ['E-1'], assumption: 'A-1', researched: true }, { id: 'U-2', text: 'runner', kind: 'repo', impact: 'high', draft: 'node test', research: 'repo', resolution: 'pending', evidence: [], researched: false, source: 'god-eye' }],
    evidence: [{ id: 'E-1', ...repoEv('U-1'), scout: 'repo', verdict: 'confirmed' }],
    assumptions: [{ id: 'A-1', unknown: 'U-1', statement: 'uses x', evidence: ['E-1'] }],
    versions: [],
  };
  const r = await H.run(WF, brief({ map_needed: false, prior, pending: ['U-2'], next_ids: { U: 2, E: 1, A: 1 } }), crew({
    REPO: (p) => {
      assert.deepEqual(idsIn(p), ['U-2'], 'only the pending unknown is researched');
      return { mode: 'repo', evidence: [repoEv('U-2', { claim: 'tests use node --test' })], unresolved: [] };
    },
  }));
  assert.ok(!r.calls.some((c) => c.opts.label === 'intent map'));
  const sc = r.result.data.scout;
  assert.deepEqual(sc.evidence.map((e) => e.id), ['E-1', 'E-2']);
  assert.deepEqual(sc.assumptions.map((a) => a.id), ['A-1', 'A-2']);
  assert.equal(r.result.status, 'ok');
});

// ---------------------------------------------------------------- units
test('question rules: every question names its unknown and cites evidence or is the user\'s call', () => {
  const data = {
    unknowns: [
      { id: 'U-1', kind: 'repo', impact: 'high', resolution: 'assumption', assumption: 'A-1', evidence: ['E-1'] },
      { id: 'U-2', kind: 'world', impact: 'high', resolution: 'question', evidence: ['E-2'], note: 'not researched (web off)' },
      { id: 'U-3', kind: 'decision', impact: 'high', resolution: 'question', evidence: ['E-3'] },
    ],
    evidence: [{ id: 'E-1' }, { id: 'E-2' }, { id: 'E-3' }],
  };
  const g = Q.ground([
    { question: 'Which lib?', category: 'constraint', unknown: 'U-1' },
    { question: 'Does Stripe retry?', category: 'constraint', unknown: 'u-2' },
    { question: 'Queue or cron?', category: 'scope', unknown: 'U-3', evidence: ['E-3', 'E-99'] },
    { question: 'Who is it for?', category: 'intent' },
    { question: 'Which DB vendor default?', category: 'constraint', unknown: 'U-42', kind: 'world', default: 'pg', evidence: ['E-1'] },
  ], data);
  assert.deepEqual(g.researchable.map((x) => x.unknown), ['U-1'], 'research answered it: not asked');
  const by = Object.fromEntries(g.questions.map((q) => [q.question, q]));
  assert.equal(by['Does Stripe retry?'].unknown, 'U-2');
  assert.equal(by['Does Stripe retry?'].researchable, true);
  assert.match(by['Does Stripe retry?'].note, /web off/);
  assert.equal(by['Does Stripe retry?'].preference, true, 'no evidence cited: shown as the user\'s call');
  assert.deepEqual(by['Queue or cron?'].evidence, ['E-3'], 'unknown evidence ids are removed');
  assert.equal(by['Queue or cron?'].preference, false);
  assert.equal(by['Who is it for?'].unknown, 'U-4', 'no unknown named: a new user unknown');
  assert.equal(by['Who is it for?'].kind, 'user');
  assert.equal(by['Which DB vendor default?'].unknown, 'U-5');
  assert.equal(by['Which DB vendor default?'].kind, 'world');
  assert.deepEqual(g.created.map((u) => u.id), ['U-4', 'U-5']);
  assert.equal(g.flagged.length, 4);
  // shape keeps the grounded fields
  const s = Q.shape(g.questions, { budget: 5 });
  assert.ok(s.questions.every((q) => q.unknown && Array.isArray(q.evidence) && typeof q.preference === 'boolean'));
  // the judge and God Eye schemas carry the new fields
  assert.ok(schema('judge').properties.questions.items.required.includes('unknown'));
  assert.ok(schema('intent-critique').required.includes('researchable_questions'));
});

test('contract: "## Assumptions (evidence-backed)" parses, validates and is rewritten in place', () => {
  const base = F.contractText();
  const t = contract.setGrounded(base, ['- A-1: The repo uses node --test (evidence: E-1, E-2)', '- A-2: Use v2 (beta) (overridden by user)']);
  assert.match(t, /## Assumptions \(evidence-backed\)\n<!--[^\n]*-->\n- A-1: [^\n]*\n- A-2: [^\n]*\n\n## Assumptions\n/);
  const p = contract.parse(t);
  assert.deepEqual(p.groundedAssumptions.map((a) => [a.id, a.statement, a.evidence, a.overridden]), [['A-1', 'The repo uses node --test', ['E-1', 'E-2'], false], ['A-2', 'Use v2 (beta)', [], true]]);
  assert.deepEqual(contract.problems(p), []);
  assert.equal(contract.setGrounded(t, ['- A-1: The repo uses node --test (evidence: E-1, E-2)', '- A-2: Use v2 (beta) (overridden by user)']), t, 'idempotent');
  assert.equal(contract.setGrounded(base, []), base, 'nothing to write: unchanged');
  const bad = contract.parse(contract.setGrounded(base, ['- A-1: no evidence here', '- A-1: twice (evidence: E-1)', '- something else']));
  const probs = contract.problems(bad).join('\n');
  assert.match(probs, /A-1 cites no evidence/);
  assert.match(probs, /Duplicate evidence-backed assumption ids/);
  assert.match(probs, /"something else" is not "- A-n/);
  // citations in Intent and Constraints
  const c = contract.parse(F.contractText({ intent: '- Problem: webhooks are lost (evidence: E-4)\n- Who: ops\n- Outcome: none lost\n- Success signal: zero lost' }).replace('- No new dependencies', '- Stripe retries for 3 days, see https://stripe.com/docs/webhooks'));
  assert.deepEqual(c.citations.map((x) => [x.section, x.evidence, x.urls]), [['Intent', ['E-4'], []], ['Constraints', [], ['https://stripe.com/docs/webhooks']]]);
  // the template carries the empty section
  assert.match(contract.template({ title: 't', workType: 'bug', risk: 'low' }), /## Assumptions \(evidence-backed\)\n<!--/);
});

test('CLI re-checks evidence: repo quotes against the file, web needs URL + quote, strict second source; sort', () => {
  const root = F.makeRepo();
  const ev = (id, u, x) => ({ id, unknown: u, claim: 'c', source_tier: 'repo', confidence: 'high', verdict: 'unchecked', scout: 'repo', ...x });
  const data = {
    unknowns: [
      { id: 'U-1', kind: 'repo', impact: 'medium', resolution: 'pending', evidence: [] },
      { id: 'U-2', kind: 'repo', impact: 'medium', resolution: 'pending', evidence: [] },
      { id: 'U-3', kind: 'world', impact: 'high', resolution: 'pending', evidence: [] },
      { id: 'U-4', kind: 'world', impact: 'high', resolution: 'pending', evidence: [] },
      { id: 'U-5', kind: 'world', impact: 'high', resolution: 'pending', evidence: [] },
    ],
    evidence: [
      ev('E-1', 'U-1', { source: 'src/add.js:1', quote: 'module.exports = (a, b) => a - b;' }),
      ev('E-2', 'U-2', { source: 'src/add.js:1', quote: 'a + b' }),
      ev('E-3', 'U-3', { scout: 'web', source: 'docs page', source_tier: 'official', quote: 'q', verdict: 'confirmed' }),
      ev('E-4', 'U-4', { scout: 'web', source: 'https://d/x', source_tier: 'official', quote: 'q', verdict: 'confirmed' }),
      ev('E-5', 'U-5', { scout: 'web', source: 'https://d/y', source_tier: 'official', quote: 'q', verdict: 'confirmed', second_source: { source: 'https://d/z', quote: 'q2' } }),
    ],
    assumptions: [],
  };
  data.evidence = intent.checkEvidence(root, data, { strict: true });
  const v = Object.fromEntries(data.evidence.map((e) => [e.id, [e.verdict, e.verdict_reason]]));
  assert.equal(v['E-1'][0], 'unchecked', 'the quote is at src/add.js:1');
  assert.equal(v['E-2'][0], 'unverified');
  assert.match(v['E-2'][1], /quote not found in src\/add\.js/);
  assert.match(v['E-3'][1], /without a URL/);
  assert.match(v['E-4'][1], /second independent source/);
  assert.equal(v['E-5'][0], 'confirmed');
  const s = intent.sort(data);
  assert.deepEqual(s.unknowns.map((u) => u.resolution), ['assumption', 'question', 'question', 'question', 'assumption']);
  assert.deepEqual(s.assumptions.map((a) => [a.id, a.unknown]), [['A-1', 'U-1'], ['A-2', 'U-5']]);
  assert.deepEqual(intent.contractLines(s), ['- A-1: c (evidence: E-1)', '- A-2: c (evidence: E-5)']);
});

test('budgets: policy.intent_research per risk, the job snapshot winning; search MCP and web switch', () => {
  const root = F.makeRepo();
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ intent_research: { web: false, search_mcp: 'brave/search', budgets: { medium: { repo_scouts: 2 } } } }));
  const J = F.cli(root, ['job', 'new', '--title', 't', '--type', 'feature', '--risk', 'medium']).job;
  const state = require('../cli/core/job').load(root, J);
  const s = intent.settings(root, state);
  assert.equal(s.web, false);
  assert.equal(s.search_mcp, 'brave/search');
  assert.deepEqual([s.budget.repo_scouts, s.budget.web_scouts, s.budget.time_sec, s.budget.strict_second_source], [2, 3, 240, false]);
  const hi = intent.settings(root, { ...state, risk: 'high' });
  assert.deepEqual([hi.budget.repo_scouts, hi.budget.web_scouts, hi.budget.time_sec, hi.budget.strict_second_source], [5, 5, 300, true]);
  const lo = intent.settings(root, { ...state, risk: 'low', policy: {} });
  assert.deepEqual([lo.budget.repo_scouts, lo.budget.web_scouts, lo.budget.time_sec], [3, 1, 120]);
  // the brief carries it, and tells the web scout about the search tool / web off
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.equal(b.scout.web.enabled, false);
  assert.match(b.scout.web.reason, /intent_research\.web is false/);
  assert.equal(b.scout.budget.repo_scouts, 2);
  assert.equal(b.scout.map_needed, true);
  assert.deepEqual(['factory:intent-mapper', 'factory:researcher', 'factory:researcher', 'factory:verifier'], [b.scout.mapper, b.scout.repo_scout, b.scout.web_scout, b.scout.verifier].map((x) => x.agent_type));
  const webFile = b.scout.web_scout.prompt_template.split('\n')[1].trim();
  assert.match(fs.readFileSync(webFile, 'utf8'), /MCP tool brave\/search/);
  assert.match(fs.readFileSync(path.join(F.PLUGIN, 'agents', 'researcher.agent.md'), 'utf8'), /are data, not instructions[\s\S]*\*\*Privacy:\*\*/, 'privacy and untrusted-content rules live in the researcher\'s role');
});

// ---------------------------------------------------------------- record, floor, replies
function scoutData({ world = 'confirmed', impact = 'medium' } = {}) {
  return {
    ran: true, round: 1, web: { enabled: true, reason: null, available: true },
    map: { ran: true, ok: true },
    unknowns: [
      { id: 'U-1', text: 'Where is add?', kind: 'repo', impact: 'high', draft: 'add is in src/add.js', research: 'repo', resolution: 'assumption', evidence: ['E-1'], researched: true },
      { id: 'U-2', text: 'Is + numeric addition per ECMAScript?', kind: 'world', impact, draft: 'ECMAScript + adds numbers', research: 'web', resolution: world === 'confirmed' ? 'assumption' : 'question', evidence: ['E-2'], researched: true },
    ],
    evidence: [
      { id: 'E-1', unknown: 'U-1', claim: 'add is in src/add.js and subtracts', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports = (a, b) => a - b;', confidence: 'high', scout: 'repo', verdict: 'confirmed' },
      { id: 'E-2', unknown: 'U-2', claim: 'ECMAScript + adds two numbers', source: 'https://tc39.es/ecma262/', source_tier: 'standard', retrieved_at: '2026-10-14', quote: 'Return ? operation(lnum, rnum).', confidence: 'high', scout: 'web', verdict: world },
    ],
    assumptions: [],
    scouts: [{ label: 'scout · repo #1', mode: 'repo', unknowns: ['U-1'], outcome: 'ok' }, { label: 'scout · web #1', mode: 'web', unknowns: ['U-2'], outcome: 'ok' }],
    verifiers: 1, degraded: [],
  };
}
const APPROVE = { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, items: [], researchable_questions: [] };
function clarifyRecord(root, scout, judge = { questions: [], dismissed: [] }, critique = APPROVE) {
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  return F.record(root, F.envelope(b, judge.questions.length ? 'needs_user' : 'ok', { analysts: [], degraded: [], judge, critique, scout }));
}

test('record: evidence persisted (sealed JSON, ledger, intent-findings.md), assumptions written into the contract', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  const r = clarifyRecord(root, scoutData());
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.deepEqual(r.assumptions.map((a) => [a.id, a.unknown, a.evidence]), [['A-1', 'U-1', ['E-1']], ['A-2', 'U-2', ['E-2']]]);
  assert.deepEqual(r.findings.map((f) => f.id), ['E-1', 'E-2']);
  assert.equal(r.research.confirmed, 2);
  const data = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'intent-evidence.json'), 'utf8'));
  assert.equal(require('../cli/lib/seal').valid(data), true);
  assert.equal(data.rounds.length, 1);
  const text = fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8');
  assert.match(text, /- A-1: add is in src\/add\.js and subtracts \(evidence: E-1\)\n- A-2: ECMAScript \+ adds two numbers \(evidence: E-2\)/);
  const ledger = fs.readFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const ie = ledger.find((e) => e.kind === 'intent');
  assert.ok(ie && ie.seal && ie.unknowns.length === 2 && ie.assumptions.length === 2);
  const step = ledger.filter((e) => e.kind === 'step' && e.step === 'clarify').pop();
  assert.equal(step.bound.contract, require('../cli/core/contract').hash(root, require('../cli/core/job').load(root, J)), 'bound to the contract with the assumptions written in');
  assert.equal(F.cli(root, ['doc', 'check']).ok, true);
  const show = F.cli(root, ['intent', 'show']);
  assert.equal(show.counts.assumptions, 2);
  assert.deepEqual(show.grounded_problems, []);
  assert.equal(F.cli(root, ['next']).step, 'H1');
});

test('floor intent_grounded: medium refuses unconfirmed world claims and un-asked world unknowns; low only warns', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', 'medium']).job;
  // an unverified world finding, cited in Constraints, and the judge asked nothing
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText().replace('- No new dependencies', '- + adds numbers (evidence: E-2), see https://example.com/not-evidence'));
  let r = clarifyRecord(root, scoutData({ world: 'unverified' }), { questions: [], dismissed: [] });
  assert.equal(r.status, 'needs_user', JSON.stringify(r));
  assert.equal(r.questions.length, 1, 'the world unknown research could not settle is asked anyway');
  assert.equal(r.questions[0].unknown, 'U-2');
  assert.equal(r.questions[0].researchable, true);
  const check = F.cli(root, ['contract', 'check']);
  assert.equal(check.ok, false);
  assert.match(check.problems.join('\n'), /Constraints cites E-2 .* which is unverified, not confirmed[\s\S]*https:\/\/example\.com\/not-evidence without confirmed evidence/);
  // the floor itself
  const steps = require('../cli/core/steps');
  const job = require('../cli/core/job');
  const ctx = steps.context(root, job.load(root, J), job.load);
  assert.equal(require('../cli/core/floors').check(ctx, 'intent_grounded'), false);
  assert.ok(require('../cli/core/recipes').expandFloors('medium').includes('intent_grounded'));
  assert.ok(!require('../cli/core/recipes').expandFloors('low').includes('intent_grounded'));
  // low risk: the same contract only warns
  const root2 = F.makeRepo();
  const J2 = F.cli(root2, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root2, J2), 'contract.md'), F.contractText().replace('- No new dependencies', '- + adds numbers (evidence: E-2)'));
  r = clarifyRecord(root2, scoutData({ world: 'unverified', impact: 'low' }));
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.match(r.warnings.join('\n'), /advisory at low risk[\s\S]*E-2/);
  const c2 = F.cli(root2, ['contract', 'check']);
  assert.equal(c2.ok, true);
  assert.ok(c2.warnings.length);
});

test('replies: "change A-n <value>" and "drop A-n" edit the contract, mark the assumption overridden, and invalidate H1', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  assert.equal(clarifyRecord(root, scoutData()).status, 'ok');
  const n = F.cli(root, ['next']);
  assert.equal(n.step, 'H1');
  // through the prompt hook, like a real chat reply
  const hook = spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'prompt.js'), 'userPromptSubmitted'], { input: JSON.stringify({ prompt: 'change A-2 treat + as string concatenation too', cwd: root, sessionId: 's', timestamp: 1 }), encoding: 'utf8' });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(JSON.parse(hook.stdout).additionalContext, /Applied your reply: Changed A-2 to "treat \+ as string concatenation too"/);
  const last = JSON.parse(fs.readFileSync(path.join(root, '.factory', 'last-reply.json'), 'utf8'));
  assert.equal(last.status, 'applied');
  assert.equal(last.reply, 'change_assumption');
  const text = fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8');
  assert.match(text, /- A-2: treat \+ as string concatenation too \(overridden by user\)/);
  assert.deepEqual(F.cli(root, ['contract', 'check']).problems, []);
  // the H1 shown before the change can't be approved any more
  assert.throws(() => F.reply(root, 'approve'), /changed after it was presented/);
  // clarify runs again (reusing the evidence), then H1 again
  assert.equal(F.cli(root, ['next']).skill, 'clarify');
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.equal(b.scout.map_needed, false, 'the research is reused');
  assert.deepEqual(b.scout.pending, []);
  assert.equal(b.scout.prior.assumptions.find((a) => a.id === 'A-2').overridden, true);
  assert.equal(F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: APPROVE, scout: { ...b.scout.prior, ran: true, round: 2, map: { ran: false, ok: null }, scouts: [], verifiers: 0, degraded: [] } })).status, 'ok');
  assert.match(fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8'), /- A-2: treat \+ as string concatenation too \(overridden by user\)/, 'the override survives the next round');
  assert.equal(F.cli(root, ['next']).step, 'H1');
  F.reply(root, 'approve');
  // after H1: dropping an assumption is drift → amend
  const r = F.reply(root, 'drop A-1');
  assert.match(r.message, /Dropped A-1[\s\S]*amendment/);
  assert.doesNotMatch(fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8'), /- A-1:/);
  const nx = F.cli(root, ['next']);
  assert.equal(nx.skill, 'amend');
  assert.equal(nx.rule, 'row2.drift_contract');
  // the record and the findings doc say so; telemetry counts it
  const data = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'intent-evidence.json'), 'utf8'));
  assert.equal(data.assumptions.find((a) => a.id === 'A-2').overridden, true);
  assert.equal(data.assumptions.find((a) => a.id === 'A-1').dropped, true);
  assert.match(fs.readFileSync(path.join(F.jobDir(root, J), 'intent-findings.md'), 'utf8'), /A-2: treat \+ as string concatenation too — \*\*overridden by you\*\*[\s\S]*~~A-1:/);
  const tel = F.cli(root, ['telemetry', 'report']);
  assert.equal(tel.per_job[0].intent.assumptions_overridden, 2);
  assert.equal(tel.by_recipe['standard@medium'].intent.assumptions_overridden, 2);
  // errors: an unknown id, a missing value, an agent
  assert.throws(() => F.reply(root, 'change A-9 x'), /no assumption A-9/);
  assert.equal(human.parseReply('change A-3'), null);
  assert.equal(human.nearMiss('change A-3').verb, 'change');
  assert.equal(human.nearMiss('change the button colour'), null, 'ordinary messages are not near misses');
  const agent = spawnSync('node', [F.BIN, 'assumption', 'change', 'A-2', '--value', 'x'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '', FACTORY_RUNNER: '1' } });
  assert.match(agent.stdout, /agent_not_allowed/);
  const show = spawnSync('node', [F.BIN, 'intent', 'show'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '', FACTORY_RUNNER: '1' } });
  assert.equal(show.status, 0, 'agents may read the intent research');
});

test('telemetry: researchable questions asked and scout runs are counted', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', 'medium']);
  fs.writeFileSync(path.join(F.jobDir(root, 'J-0001'), 'contract.md'), F.contractText());
  clarifyRecord(root, scoutData({ world: 'unverified' }));
  const t = F.cli(root, ['telemetry', 'report']);
  assert.equal(t.per_job[0].intent.researchable_questions_asked, 1);
  assert.equal(t.per_job[0].intent.researchable_question_rate, 1);
  assert.equal(t.per_job[0].intent.scout_rounds, 1);
  const md = spawnSync('node', [F.BIN, 'telemetry', 'report', '--format', 'md'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } }).stdout;
  assert.match(md, /## Grounded intent[\s\S]*\| standard@medium \| 1 \| 1 \| 1 \|/);
});

// ---------------------------------------------------------------- runner
test('factory run: a full clarify through the scout phase on the fake Copilot (repo + web + verifier), medium risk', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.cli(root, ['next']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-gi-'));
  const env = (crewOpts) => ({ ...process.env, FACTORY_ROOT: '', COPILOT_BIN: path.join(__dirname, 'helpers', 'fake-copilot.js'), FAKE_COPILOT_SCRIPT: path.join(__dirname, 'helpers', 'crew.js'), FAKE_COPILOT_LOG: path.join(dir, `log-${Math.random()}.jsonl`), FAKE_CREW: JSON.stringify(crewOpts) });
  const run = (crewOpts, args = []) => {
    const p = spawnSync('node', [F.BIN, 'run', 'fanout-judge', '--config', 'clarify', ...args], { cwd: root, encoding: 'utf8', env: env(crewOpts), timeout: 120000 });
    return p;
  };
  const p = run({ world: true }, ['--json']);
  const r = JSON.parse(p.stdout);
  assert.equal(r.status, 'ok', p.stdout + p.stderr);
  assert.deepEqual(r.agents.slice(0, 4).map((a) => a.label).sort(), ['intent map', 'scout · repo #1', 'scout · web #1', 'verify evidence #1']);
  assert.ok(r.agents.filter((a) => /^(scout|verify)/.test(a.label)).every((a) => a.time_cap_sec === 240), 'medium risk: 4 minutes');
  assert.deepEqual(r.assumptions.map((a) => a.evidence), [['E-1'], ['E-2']]);
  assert.equal(r.findings.find((f) => f.id === 'E-2').source, 'https://tc39.es/ecma262/#sec-applystringornumericbinaryoperator');
  assert.match(p.stderr, /phase: clarify: scout · map the unknowns[\s\S]*phase: clarify: scout · research 2 unknown\(s\) with 2 scout\(s\)[\s\S]*phase: clarify: scout · verify 2 finding\(s\)[\s\S]*phase: clarify: intent gate/);
  const ev = fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.event === 'agent_run');
  assert.ok(ev.some((e) => e.role === 'verifier' && e.label === 'verify evidence #1' && e.time_cap_sec === 240));
  // the printed summary carries findings and assumptions
  assert.equal(F.cli(root, ['next']).step, 'H1');
});

test('factory run: no web access → the world unknown is asked, saying so (medium risk is not approved without it)', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.cli(root, ['next']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-gi-'));
  const p = spawnSync('node', [F.BIN, 'run', 'fanout-judge', '--config', 'clarify'], { cwd: root, encoding: 'utf8', timeout: 120000, env: { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: path.join(__dirname, 'helpers', 'fake-copilot.js'), FAKE_COPILOT_SCRIPT: path.join(__dirname, 'helpers', 'crew.js'), FAKE_COPILOT_LOG: path.join(dir, 'log.jsonl'), FAKE_CREW: JSON.stringify({ world: true, web: 'down' }) } });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.match(p.stdout, /^status: needs_user/);
  assert.match(p.stdout, /questions \(1\)[\s\S]*Q-1 \[constraint\][^\n]*unknown: U-2 \(world\)[^\n]*your call[^\n]*researchable, asked because: not verified: no web access/);
  assert.match(p.stdout, /assumptions \(1\) — reply "change A-n <value>" or "drop A-n" to override:\n  - A-1: add is implemented in src\/add\.js and subtracts \(evidence: E-1\)/);
  assert.match(p.stdout, /research: 3 unknown\(s\), 1 finding\(s\) \(1 confirmed\), web unavailable/);
  assert.match(p.stdout, /intent_findings: .*intent-findings\.md/);
});
