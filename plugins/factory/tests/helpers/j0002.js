'use strict';
// A J-0002-shaped job in the pre-v2 format (copilot-factory 0.4.x), for the clarify v2
// migration and convergence tests. The real job: Nautobot interface VLAN sync,
// standard@medium, 9 clarify rounds, parked on the round cap, 26 unknowns, 25 findings, 13
// answers (some free-form, by question text), the NX-OS command raised again as U-7, U-19,
// U-20, U-22, U-23 and U-25, cisco.com unreachable (HTTP 404), verifier timeouts.
//
// build(root) writes, through the factory's own sealed writers:
//   jobs/J-0002/state.json         parked from clarify after 9 rounds, policy snapshot without
//                                  clarify_no_progress_rounds (max_intent_rounds 4)
//   jobs/J-0002/intent-evidence.json   version 1 (no subjects, owners or statuses)
//   jobs/J-0002/answers.json       13 answers: by Q-n and free-form (--question "…")
//   jobs/J-0002/contract.md        the contract as clarify left it

const fs = require('fs');
const path = require('path');
const F = require('./fixture');

const CONTRACT = `# Nautobot interface VLAN sync

## Intent
- Problem: switch trunk VLANs drift from what Nautobot says the interfaces carry
- Who: the network automation team; asked by the DC operations lead
- Outcome: each managed trunk carries exactly the VLANs Nautobot lists for its interface
- Why now: two outages from stale trunk VLANs this quarter
- Success signal: the nightly drift report shows zero trunk VLAN mismatches for a week

## Goal
A sync job reads interface VLAN assignments from Nautobot and makes the NX-OS trunks match them.

## Non-goals
- Access-port VLANs
- Creating VLANs that do not exist on the switch

## Acceptance criteria
- AC-1: after a sync, each in-scope trunk's allowed VLANs equal Nautobot's tagged VLANs for that interface (evidence: test)
- AC-2: a dry run lists the changes without applying them (evidence: test)

## Constraints
- Runs from the existing automation container (Python 3.11)

## Allowed paths
- src/**
- tests/**

## Verify commands
- \`node tests/add.test.js\` (AC-1, AC-2)

## Assumptions
- The sync runs with a service account that may configure trunks
`;

// [id, text, kind, impact, resolution, extra]
const U = [
  ['U-1', 'Where does the current automation read interface VLAN assignments from Nautobot?', 'repo', 'high', 'assumption', { evidence: ['E-1'], assumption: 'A-1' }],
  ['U-2', 'Does Nautobot 2.x expose tagged VLANs on the dcim interface API?', 'world', 'high', 'question', { evidence: ['E-2'], question_id: 'Q-2', note: 'research did not confirm it: E-2 unverified (the verifier failed or ran out of time)' }],
  ['U-3', 'Should the sync remove VLANs that are on the trunk but not in Nautobot?', 'user', 'high', 'answered', { question_id: 'Q-1', answer: 'Yes, prune them' }],
  ['U-4', 'Which device roles are in scope for the VLAN sync (leaf, spine, border)?', 'user', 'high', 'question', { question_id: 'Q-3' }],
  ['U-5', 'Should the sync run nightly or on every Nautobot change?', 'decision', 'high', 'question', { question_id: 'Q-4', options: ['nightly', 'on change'] }],
  ['U-6', 'Is a dry-run mode required before the first live run?', 'user', 'medium', 'answered', { question_id: 'Q-5', answer: 'yes' }],
  ['U-7', 'Which NX-OS CLI command sets the allowed VLAN list on a trunk interface?', 'world', 'high', 'question', { evidence: ['E-3', 'E-4'], question_id: 'Q-6', note: 'research did not confirm it: E-3 unverified (HTTP 404), E-4 unverified (HTTP 404)' }],
  ['U-8', 'Which NX-OS release do the leaf switches run?', 'repo', 'high', 'assumption', { evidence: ['E-5'], assumption: 'A-2' }],
  ['U-9', 'Does Nautobot model native VLANs separately from tagged VLANs?', 'world', 'medium', 'assumption', { evidence: ['E-6'], assumption: 'A-3' }],
  ['U-10', 'How should the sync handle an interface with no VLANs in Nautobot?', 'user', 'high', 'answered', { question_id: 'Q-7', answer: 'skip it and report' }],
  ['U-11', 'Who approves the first production run?', 'user', 'medium', 'answered', { question_id: 'Q-8', answer: 'the DC operations lead' }],
  ['U-12', 'Which pynautobot API field holds the untagged VLAN of an interface (untagged_vlan or native_vlan)?', 'world', 'high', 'question', { evidence: ['E-7'], question_id: 'Q-9', note: 'research did not confirm it: E-7 unverified' }],
  ['U-13', 'Is there a maintenance window the sync must respect?', 'user', 'high', 'question', { question_id: 'Q-10' }],
  ['U-14', 'Does the automation container already have network access to the switches?', 'repo', 'medium', 'assumption', { evidence: ['E-8'], assumption: 'A-4' }],
  ['U-15', 'What are the exact line ranges in sync/nxos.py that build the VLAN commands?', 'repo', 'medium', 'question', { evidence: ['E-9'], question_id: 'Q-11', note: 'research did not confirm it: E-9 unverified' }],
  ['U-16', 'Should the drift report be emailed or posted to chat?', 'user', 'low', 'deferred', { note: 'low impact: assumed, not researched' }],
  ['U-17', 'Does the ntc-templates parser for show interface switchport return trunking_vlans as a list?', 'world', 'high', 'question', { evidence: ['E-10'], note: 'research did not confirm it: E-10 unverified (HTTP 404)' }],
  ['U-18', 'Is the VLAN range 1-4094 valid on all leaf platforms?', 'world', 'medium', 'answered', { question_id: 'Q-12', answer: 'yes, except reserved 3968-4094' }],
  ['U-19', 'What is the exact NX-OS syntax for switchport trunk allowed vlan?', 'world', 'high', 'question', { evidence: ['E-11'], note: 'research did not confirm it: E-11 unverified (HTTP 404)' }],
  ['U-20', 'Does NX-OS use switchport trunk allowed vlan add to add VLANs to a trunk?', 'world', 'high', 'pending', {}],
  ['U-21', 'Should port-channel members be synced individually or through the port-channel?', 'user', 'high', 'answered', { question_id: 'Q-13', answer: 'through the port-channel' }],
  ['U-22', 'Confirm the NX-OS command form for configuring trunk allowed VLANs', 'world', 'high', 'question', { evidence: ['E-12'], note: 'research did not confirm it: E-12 unverified' }],
  ['U-23', 'NX-OS: is the command switchport trunk allowed vlan or switchport allowed vlan?', 'world', 'high', 'pending', {}],
  ['U-24', 'Must the sync log every change for audit?', 'user', 'high', 'answered', { question_id: 'Q-14', answer: 'yes, to the change log' }],
  ['U-25', 'Which command does NX-OS accept to set allowed VLANs on trunk ports?', 'world', 'high', 'pending', {}],
  ['U-26', 'Is rollback of a failed sync required?', 'user', 'high', 'question', { question_id: 'Q-15' }],
];

// 25 findings: repo quotes for the repo unknowns, cisco.com and Nautobot docs that could not be reached.
function evidence() {
  const out = [
    { id: 'E-1', unknown: 'U-1', claim: 'The automation reads interfaces through src/add.js', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports = (a, b) => a - b;', confidence: 'high', scout: 'repo', verdict: 'confirmed' },
    { id: 'E-2', unknown: 'U-2', claim: 'Nautobot 2.x interfaces carry tagged_vlans', source: 'https://docs.nautobot.com/projects/core/en/stable/user-guide/core-data-model/dcim/interface/', source_tier: 'official', quote: 'tagged_vlans', confidence: 'medium', scout: 'web', verdict: 'unverified', verdict_reason: 'the verifier failed or ran out of time' },
    { id: 'E-3', unknown: 'U-7', claim: 'switchport trunk allowed vlan <list> sets the allowed VLANs', source: 'https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus9000/sw/93x/interfaces/configuration/guide/b-cisco-nexus-9000-nx-os-interfaces-configuration-guide-93x.html', source_tier: 'official', quote: 'switchport trunk allowed vlan', confidence: 'medium', scout: 'web', verdict: 'unverified', verdict_reason: 'HTTP 404' },
    { id: 'E-4', unknown: 'U-7', claim: 'NX-OS 9.3 supports add/remove keywords', source: 'https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus9000/sw/93x/layer2/configuration/guide.html', source_tier: 'official', quote: 'allowed vlan add', confidence: 'low', scout: 'web', verdict: 'unverified', verdict_reason: 'HTTP 404' },
    { id: 'E-5', unknown: 'U-8', claim: 'The leaf inventory pins NX-OS 9.3', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports', confidence: 'high', scout: 'repo', verdict: 'confirmed' },
    { id: 'E-6', unknown: 'U-9', claim: 'Nautobot has untagged_vlan and tagged_vlans on interfaces', source: 'https://docs.nautobot.com/projects/core/en/stable/', source_tier: 'official', quote: 'untagged_vlan', confidence: 'high', scout: 'web', verdict: 'confirmed', second_source: { source: 'https://github.com/nautobot/nautobot/blob/develop/nautobot/dcim/models/device_components.py', quote: 'tagged_vlans' } },
    { id: 'E-7', unknown: 'U-12', claim: 'pynautobot exposes untagged_vlan', source: 'https://pynautobot.readthedocs.io/', source_tier: 'official', quote: 'untagged_vlan', confidence: 'low', scout: 'web', verdict: 'unverified', verdict_reason: 'the verifier failed or ran out of time' },
    { id: 'E-8', unknown: 'U-14', claim: 'The container reaches the switches over the management VRF', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports', confidence: 'medium', scout: 'repo', verdict: 'unchecked' },
    { id: 'E-9', unknown: 'U-15', claim: 'sync/nxos.py builds the commands', source: 'sync/nxos.py:40-80', source_tier: 'repo', quote: 'def build_commands', confidence: 'low', scout: 'repo', verdict: 'unverified', verdict_reason: 'sync/nxos.py does not exist (CLI check)' },
    { id: 'E-10', unknown: 'U-17', claim: 'trunking_vlans is a list', source: 'https://github.com/networktocode/ntc-templates/blob/master/ntc_templates/templates/cisco_nxos_show_interface_switchport.textfsm', source_tier: 'primary', quote: 'TRUNKING_VLANS', confidence: 'low', scout: 'web', verdict: 'unverified', verdict_reason: 'HTTP 404' },
    { id: 'E-11', unknown: 'U-19', claim: 'switchport trunk allowed vlan is the syntax', source: 'https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/101x/configuration/interfaces/cisco-nexus-9000-nx-os-interfaces-configuration-guide-101x.html', source_tier: 'official', quote: 'switchport trunk allowed vlan', confidence: 'medium', scout: 'web', verdict: 'unverified', verdict_reason: 'HTTP 404' },
    { id: 'E-12', unknown: 'U-22', claim: 'the command form is switchport trunk allowed vlan', source: 'https://www.cisco.com/c/en/us/support/switches/nexus-9000-series-switches/products-command-reference-list.html', source_tier: 'official', quote: 'allowed vlan', confidence: 'low', scout: 'web', verdict: 'unverified', verdict_reason: 'HTTP 404' },
  ];
  // the rest: further unreachable cisco.com fetches across the rounds
  for (let i = 13; i <= 25; i++) out.push({ id: `E-${i}`, unknown: ['U-7', 'U-19', 'U-22', 'U-12', 'U-17'][i % 5], claim: `NX-OS trunk VLAN detail, attempt ${i}`, source: `https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus9000/sw/attempt-${i}.html`, source_tier: 'official', quote: 'allowed vlan', confidence: 'low', scout: 'web', verdict: 'unverified', verdict_reason: 'HTTP 404' });
  return out.map((e) => ({ retrieved_at: '2026-10-10', applies_to_version: null, second_source: null, counter_source: null, checks: [], cli_checked: true, verdict_confidence: null, verdict_reason: null, round: 1, ...e }));
}

// 13 answers: by Q-n through factory answer --id, and free-form (factory answer --question "…").
const ANSWERS = [
  { id: 'Q-1', question: 'Should the sync remove VLANs that are on the trunk but not in Nautobot?', answer: 'Yes, prune them' },
  { id: 'Q-5', question: 'Is a dry-run mode required before the first live run?', answer: 'yes' },
  { id: 'Q-7', question: 'How should the sync handle an interface with no VLANs in Nautobot?', answer: 'skip it and report' },
  { id: 'Q-8', question: 'Who approves the first production run?', answer: 'the DC operations lead' },
  { id: 'Q-12', question: 'Is the VLAN range 1-4094 valid on all leaf platforms?', answer: 'yes, except reserved 3968-4094' },
  { id: 'Q-13', question: 'Should port-channel members be synced individually or through the port-channel?', answer: 'through the port-channel' },
  { id: 'Q-14', question: 'Must the sync log every change for audit?', answer: 'yes, to the change log' },
  // free-form: the chat agent retyped the question; v1 dropped these silently
  { question: 'Which device roles are in scope for the sync?', answer: 'leaf and border, not spine' },
  { question: 'Does Nautobot expose tagged VLANs on the interface API in 2.x?', answer: 'yes: tagged_vlans on dcim interfaces' },
  { question: 'Is rollback required when a sync fails?', answer: 'yes, restore the previous allowed list' },
  { question: 'Is there a maintenance window for the sync?', answer: 'nightly 01:00-03:00 only' },
  { id: 'Q-1', question: 'Should the sync remove VLANs that are on the trunk but not in Nautobot?', answer: 'yes, prune' },
  { question: 'What colour should the dashboard be?', answer: 'blue' },
];

function build(root) {
  const job = require('../../cli/core/job');
  const intent = require('../../cli/core/intent');
  const { jobPaths } = require('../../cli/lib/paths');
  F.cli(root, ['job', 'new', '--title', 'Nautobot interface VLAN sync', '--type', 'feature', '--risk', 'medium']);
  const J = F.cli(root, ['job', 'new', '--title', 'Nautobot interface VLAN sync', '--type', 'feature', '--risk', 'medium']).job;
  const jp = jobPaths(root, J);
  fs.writeFileSync(jp.contract, CONTRACT);
  const state = job.load(root, J);
  // the 0.4.x policy snapshot: max_intent_rounds 4 (cap + 2 = 6), no clarify_no_progress_rounds
  state.policy.limits.max_intent_rounds = 4;
  delete state.policy.limits.clarify_no_progress_rounds;
  const logQ = U.filter(([, , , , , x]) => x.question_id).map(([id, text, kind, , , x], i) => ({ id: x.question_id, round: Math.min(9, 1 + i), category: kind === 'user' || kind === 'decision' ? 'scope' : 'constraint', question: text, default: kind === 'world' ? 'None: answer needed' : 'Your call', unknown: id, kind, evidence: x.evidence || [], preference: !(x.evidence || []).length, researchable: ['repo', 'world'].includes(kind) }));
  logQ.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  Object.assign(state, {
    status: 'parked',
    park: { reason: 'Clarify is not converging (9 rounds).', at: '2026-10-12T10:00:00.000Z', from: 'clarify' },
    pending_gate: { id: 'P', hash: null, docs: [], at: '2026-10-12T10:00:00.000Z' },
    question_log: logQ,
    asked_questions: logQ.map((q) => q.question),
  });
  state.counters.clarify_rounds = 9;
  state.counters.intent_rounds = 1;
  job.save(root, state);
  const unknowns = U.map(([id, text, kind, impact, resolution, x]) => ({ id, text, kind, impact, draft: x.draft || text, research: kind === 'repo' ? 'repo' : kind === 'world' ? 'web' : 'none', resolution, evidence: x.evidence || [], assumption: x.assumption || null, question_id: x.question_id || null, answer: x.answer || null, note: x.note || null, researched: ['assumption', 'question'].includes(resolution) && ['repo', 'world'].includes(kind), source: Number(id.slice(2)) > 18 ? 'god-eye' : 'mapper', round: Math.min(9, Number(id.slice(2)) > 18 ? Number(id.slice(2)) - 16 : 1), ...(x.options ? { options: x.options } : {}) }));
  const assumptions = [['A-1', 'U-1', ['E-1']], ['A-2', 'U-8', ['E-5']], ['A-3', 'U-9', ['E-6']], ['A-4', 'U-14', ['E-8']]].map(([id, u, ev]) => ({ id, unknown: u, statement: `statement for ${u}`, evidence: ev, overridden: false, override: null, dropped: false, withdrawn: false }));
  const rounds = Array.from({ length: 9 }, (_, i) => ({ round: i + 1, at: `2026-10-1${i < 5 ? 1 : 2}T0${i}:00:00.000Z`, scouted: true, mapped: i === 0 || i === 3, map_ok: i !== 3, scouts: [{ label: 'scout · web #1', mode: 'web', unknowns: ['U-7'], outcome: i % 2 ? 'no_result' : 'ok' }], verifiers: 1, degraded: i % 3 === 0 ? ['verify evidence #1'] : [], budget: null }));
  intent.save(root, J, { version: 1, job: J, rounds, web: { enabled: true, reason: null, available: true, search_mcp: null }, versions: [], unknowns, evidence: evidence(), assumptions });
  fs.writeFileSync(jp.answers, JSON.stringify(ANSWERS.map((a, i) => ({ ...a, at: `2026-10-1${i < 6 ? 1 : 2}T0${i % 10}:30:00.000Z` })), null, 2));
  return J;
}

module.exports = { build, CONTRACT, U, ANSWERS };
