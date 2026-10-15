'use strict';
// A scripted clarify crew for fake-copilot.js (FAKE_COPILOT_SCRIPT=clarify-crew.js) that
// reproduces the J-0002 pattern on a fresh job, round by round:
//   round 1  the mapper lists five issues, one an implementation detail (the NX-OS command:
//            deferred to design); the repo scout confirms one; the web scout gets HTTP 404 on
//            the Nautobot docs (unreachable → one question with a default) and finds a claim
//            whose verifier times out (unverified → one question with a default); the judge
//            re-raises the NX-OS command in other words (folded, not asked)
//   round 2  the contract editor applies the answers and the accepted default; the judge
//            paraphrases the NX-OS command again (folded); God Eye's first look has one pointed
//            blocker (AC-2), the editor revises, God Eye's second look has only an unpointed
//            minor item: approve with notes → H1
// FAKE_CLARIFY (JSON) tunes it: { "stall": true } makes every round say nothing new.

const fs = require('fs');
const path = require('path');

const S = () => {
  try {
    return JSON.parse(process.env.FAKE_CLARIFY || '{}');
  } catch {
    return {};
  }
};

const NXOS = 'Which NX-OS CLI command sets the allowed VLAN list on a trunk interface?';

module.exports = (c) => {
  const root = c.env.FACTORY_ROOT;
  const J = c.env.FACTORY_JOB;
  const contractFile = path.join(root, '.factory', 'jobs', J, 'contract.md');
  const nested = (t) => t.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/') && l.endsWith('.md') && fs.existsSync(l)).map((l) => fs.readFileSync(l, 'utf8')).join('\n');
  const text = `${c.instructions || ''}\n${nested(c.instructions || '')}`;
  const ids = (re) => [...text.matchAll(re)].map((m) => m[1]);
  const opt = S();
  switch (c.role) {
    case 'intent-mapper':
      return {
        restatement: 'Keep NX-OS trunk VLANs in line with Nautobot.',
        unknowns: [
          { text: 'Where does the automation read interface VLAN assignments today?', kind: 'repo', impact: 'high', draft: 'the automation reads interfaces in src/add.js', research: 'repo', search: 'src/add.js', why: 'The sync must extend the existing reader.', same_as: 'new', subject: 'automation.vlan-source', owner: 'research' },
          { text: NXOS, kind: 'world', impact: 'high', draft: 'switchport trunk allowed vlan <list>', research: 'web', search: 'cisco.com nexus 9000 interfaces guide', why: 'A wrong command breaks trunks.' },
          { text: 'Does Nautobot 2.x expose tagged VLANs on the dcim interface API?', kind: 'world', impact: 'high', draft: 'Nautobot 2.x interfaces carry tagged_vlans', research: 'web', search: 'docs.nautobot.com', why: 'The sync reads them.', same_as: 'new', subject: 'nautobot.tagged-vlans', owner: 'research' },
          { text: "Does NX-OS 9.3 keep a trunk's allowed VLANs when its port-channel flaps?", kind: 'world', impact: 'medium', draft: 'NX-OS 9.3 keeps the allowed VLANs across a port-channel flap', research: 'web', search: 'cisco.com nexus 9000 port-channel', why: 'A flap could undo a sync.', same_as: 'new', subject: 'nxos.trunk-flap', owner: 'research' },
          { text: 'Should the sync remove VLANs that are on the trunk but not in Nautobot?', kind: 'user', impact: 'high', draft: 'Should the sync remove VLANs that are on the trunk but not in Nautobot?', options: ['Yes, prune them', 'No, only add'], research: 'none', why: 'Pruning can cut traffic.', same_as: 'new', subject: 'sync.prune', owner: 'user' },
        ],
      };
    case 'researcher': {
      const asked = ids(/"id": "(U-\d+)"/g);
      if (/Mode: \*\*repo\*\*/.test(text)) {
        return { mode: 'repo', versions: [], evidence: asked.map((u) => ({ unknown: u, claim: 'the automation reads interfaces in src/add.js', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports = (a, b) => a - b; // bug: should add', confidence: 'high' })), unresolved: [] };
      }
      if (/Mode: \*\*web\*\*/.test(text)) {
        const nb = asked.find((u) => text.includes(`"id": "${u}",\n    "text": "Does Nautobot`));
        const flap = asked.filter((u) => u !== nb);
        return {
          mode: 'web',
          web_available: true,
          evidence: flap.map((u) => ({ unknown: u, claim: 'NX-OS keeps allowed VLANs on a port-channel member after a flap', source: 'https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus9000/sw/93x/interfaces/configuration/guide/port-channels.html', source_tier: 'official', retrieved_at: '2026-10-15', quote: 'The allowed VLAN list is retained', applies_to_version: '9.3', confidence: 'medium' })),
          unresolved: nb ? [{ unknown: nb, reason: 'HTTP 404 from docs.nautobot.com' }] : [],
          fetched: ['https://docs.nautobot.com/projects/core/en/stable/', 'https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus9000/sw/93x/interfaces/configuration/guide/port-channels.html'],
          failed_sources: nb ? [{ unknown: nb, source: 'https://docs.nautobot.com/projects/core/en/stable/user-guide/core-data-model/dcim/interface/', reason: 'HTTP 404' }] : [],
        };
      }
      return { topic: 'codebase', claims: [{ claim: 'the automation reads interfaces in src/add.js', source: 'src/add.js:1' }], unknowns: [] };
    }
    case 'verifier': {
      // the batch with the port-channel finding times out; the repo finding is confirmed
      if (/port-channel/.test(text)) return { exit: 1, stderr: 'timed out after 240s' };
      return { verdicts: [...new Set(ids(/"id": "(E-\d+)"/g))].map((id) => ({ evidence_id: id, verdict: 'confirmed', confidence: 'high', reason: 'the quote is at src/add.js:1', quote_found: true, version_applies: true, second_source: null })) };
    }
    case 'intent-analyst':
      if (/Your focus: \*\*intent\*\*/.test(text)) return { focus: 'intent', questions: [], restatement: { problem: 'trunk VLANs drift', who: 'network automation', outcome: 'trunks match Nautobot', success: 'zero drift for a week' } };
      if (/Your focus: \*\*ambiguity\*\*/.test(text) && /Round 1\./.test(text)) {
        // asks about the prune decision through the ledger (same_as), not as a new issue
        return { focus: 'ambiguity', questions: [{ question: 'Should VLANs missing from Nautobot be pruned from the switch trunks?', why: 'Pruning can cut traffic.', blocking: true, category: 'scope', default: 'Your call: prune them', options: ['Yes', 'No'], same_as: 'U-5', subject: 'sync.prune', preference: true }] };
      }
      return { focus: 'x', questions: [] };
    case 'judge': {
      if (opt.stall) return { questions: [], dismissed: [] };
      if (c.n === 0) {
        return {
          questions: [
            { question: 'Should the sync remove VLANs that are on the trunk but not in Nautobot?', category: 'scope', why: 'Pruning can cut traffic.', default: 'Your call: prune them', options: ['Yes, prune them', 'No, only add'], unknown: 'U-5', preference: true, same_as: 'U-5', subject: 'sync.prune' },
            // the J-0002 pattern: the NX-OS command again, in other words, as "new"
            { question: 'What is the exact NX-OS syntax for switchport trunk allowed vlan?', category: 'constraint', why: 'A wrong command breaks trunks.', default: 'switchport trunk allowed vlan <list>', unknown: 'new', kind: 'world', preference: true, same_as: 'new', subject: 'nxos.switchport-syntax' },
          ],
          dismissed: [],
        };
      }
      return { questions: [{ question: 'Which command does NX-OS accept to set allowed VLANs on trunk ports?', category: 'constraint', why: 'w', default: 'switchport trunk allowed vlan', unknown: 'new', kind: 'world', preference: true, same_as: 'new', subject: 'nxos.trunk-command' }], dismissed: [] };
    }
    case 'contract-editor': {
      const cur = (text.match(/----- BEGIN CONTRACT -----\n([\s\S]*?)\n----- END CONTRACT -----/) || [])[1] || fs.readFileSync(contractFile, 'utf8');
      const refs = ids(/"ref": "(U-\d+|AC-\d+)"/g);
      let next = cur;
      const applied = [];
      if (refs.some((r) => r.startsWith('U-'))) {
        next = next.replace('## Constraints\n', '## Constraints\n- VLANs on a trunk that Nautobot does not list are removed (pruned)\n- Nautobot 2.x tagged_vlans on dcim interfaces is the source of truth\n');
        for (const r of refs.filter((x) => x.startsWith('U-'))) applied.push({ ref: r, section: 'Constraints', change: 'stated the settled answer' });
      }
      if (refs.includes('AC-2')) {
        next = next.replace(/- AC-2: [^\n]*/, '- AC-2: a dry run lists each VLAN it would add or remove per interface, and applies nothing (evidence: test)');
        applied.push({ ref: 'AC-2', section: 'Acceptance criteria', change: 'the dry run output is named' });
      }
      return { contract: next, applied, skipped: [] };
    }
    case 'god-eye': {
      const base = { intent_confirmed: true, restatement: { problem: 'trunk VLANs drift from Nautobot', who: 'network automation team', outcome: 'trunks carry exactly the VLANs Nautobot lists', success: 'zero drift for a week' } };
      if (opt.stall) return { ...base, verdict: 'revise', checklist: { intent_clear: true, scope_bounded: true, acs_testable: true, no_open_blockers: true, constraints_consistent: true }, items: [{ issue: 'AC-2 does not say what a dry run prints', severity: 'major', ref: 'AC-2', suggestion: 'name the output' }], researchable_questions: [], ungrounded_claims: [] };
      if (c.n === 0) {
        return {
          ...base,
          verdict: 'revise',
          checklist: { intent_clear: true, scope_bounded: true, acs_testable: false, no_open_blockers: true, constraints_consistent: true },
          items: [
            { issue: 'AC-2 does not say what a dry run lists, so no test can check it', severity: 'blocker', suggestion: 'AC-2: a dry run lists each VLAN it would add or remove per interface (evidence: test)', ref: 'AC-2', same_as: 'new', subject: 'ac2.dry-run-output' },
            { issue: 'The exact NX-OS command for the allowed VLAN list is still not stated', severity: 'major', suggestion: 'state it', ref: 'U-2', same_as: 'U-2', subject: 'nxos.switchport-command' },
            { issue: 'Consider naming the log file', severity: 'minor', suggestion: 'name it' },
          ],
          researchable_questions: [{ question: 'Which NX-OS command form adds VLANs to a trunk?', kind: 'world', why: 'nice to know', same_as: 'new', subject: 'nxos.add-form', blocker: false }],
          ungrounded_claims: [],
        };
      }
      return { ...base, verdict: 'revise', checklist: { intent_clear: true, scope_bounded: true, acs_testable: true, no_open_blockers: true, constraints_consistent: true }, items: [{ issue: 'The Goal could name the drift report', severity: 'minor', suggestion: 'mention it' }], researchable_questions: [], ungrounded_claims: [] };
    }
    default:
      return { exit: 1, stderr: `clarify-crew: no script for ${c.agent}` };
  }
};
