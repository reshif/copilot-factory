'use strict';
// A scripted crew for fake-copilot.js (FAKE_COPILOT_SCRIPT=crew.js): every factory role
// answers like a real agent would, running the real factory CLI from its cwd where the
// role does (task start/verify, reconcile run, doc check) and writing the documents its
// role owns (ADR, threat model, plan). FAKE_CREW (JSON) tunes it:
//   { "finding": "major" }   the code reviewer reports one finding of that severity
//   { "verdict": "refuted" } what the finding verifier says: confirmed, refuted (default) or unverifiable
//   { "world": true }        the intent mapper also finds a world unknown (a web scout runs)
//   { "web": "down" }        the web scout reports no web access
//   { "evidence": "contradicted" } what the evidence verifier says (default confirmed)

const fs = require('fs');
const path = require('path');
const F = require('./fixture');

const sc = () => {
  try {
    return JSON.parse(process.env.FAKE_CREW || '{}');
  } catch {
    return {};
  }
};

module.exports = (c) => {
  const root = c.env.FACTORY_ROOT;
  const J = c.env.FACTORY_JOB;
  const jd = path.join(root, '.factory', 'jobs', J);
  const S = sc();
  // The runner's prompt file points at the brief file wfargs wrote: read both.
  const nested = (t) => t.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/') && l.endsWith('.md') && fs.existsSync(l)).map((l) => fs.readFileSync(l, 'utf8')).join('\n');
  const text = `${c.instructions || ''}\n${nested(c.instructions || '')}`;
  switch (c.role) {
    case 'intent-mapper': {
      // The scout phase: one repo unknown the repo answers, optionally one world unknown.
      const unknowns = [{ text: 'Where is add implemented and what does it do today?', kind: 'repo', impact: 'high', draft: 'add is implemented in src/add.js and subtracts', research: 'repo', search: 'src/add.js' }];
      if (S.world) unknowns.push({ text: 'Does the ECMAScript spec define + on two numbers as addition?', kind: 'world', impact: 'medium', draft: 'ECMAScript defines + on numbers as numeric addition', research: 'web', search: 'tc39.es ecma262' });
      unknowns.push({ text: 'Should non-numbers be rejected?', kind: 'user', impact: 'low', draft: 'Leave non-numbers as they are?', research: 'none' });
      return { unknowns };
    }
    case 'verifier': {
      const ids = [...text.matchAll(/"id": "(E-\d+)"/g)].map((m) => m[1]);
      return { verdicts: [...new Set(ids)].map((id) => ({ evidence_id: id, verdict: S.evidence || 'confirmed', confidence: 'high', reason: 'quote found at the source', quote_found: S.evidence !== 'unverified', version_applies: true, second_source: null })) };
    }
    case 'intent-analyst':
      return { focus: 'x', questions: [] };
    case 'judge':
      return { questions: [], dismissed: [] };
    case 'god-eye':
      if (/intent_confirmed/.test(text)) return { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'add subtracts', outcome: 'add sums' }, items: [], researchable_questions: [] };
      return { verdict: 'approve', items: [] };
    case 'researcher': {
      if (/Mode: \*\*repo\*\*/.test(text)) {
        return { mode: 'repo', versions: [{ name: 'node', version: process.versions.node, source: 'process.versions' }], evidence: [{ unknown: (text.match(/"id": "(U-\d+)"/) || [])[1] || 'U-1', claim: 'add is implemented in src/add.js and subtracts', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports = (a, b) => a - b;', confidence: 'high' }], unresolved: [] };
      }
      if (/Mode: \*\*web\*\*/.test(text)) {
        const u = (text.match(/"id": "(U-\d+)"/) || [])[1] || 'U-2';
        if (S.web === 'down') return { mode: 'web', web_available: false, evidence: [], unresolved: [{ unknown: u, reason: 'web_fetch failed: no network' }], fetched: [] };
        return { mode: 'web', web_available: true, evidence: [{ unknown: u, claim: 'ECMAScript defines + on two numbers as numeric addition', source: 'https://tc39.es/ecma262/#sec-applystringornumericbinaryoperator', source_tier: 'standard', retrieved_at: '2026-10-14', quote: 'Return ? operation(lnum, rnum).', applies_to_version: 'ES2025', confidence: 'high' }], unresolved: [], fetched: ['https://tc39.es/ecma262/'] };
      }
      return { topic: 'codebase', claims: [{ claim: 'add subtracts', source: 'src/add.js:1' }], unknowns: [] };
    }
    case 'option-generator':
      return { title: 'Fix in place', summary: 'Change the operator', criteria: [{ id: 'AC-1', how: 'add returns a + b' }], touches: ['src/add.js'], pros: ['small'], cons: [] };
    case 'threat-modeler': {
      const file = path.join(jd, 'threat-model.md');
      fs.writeFileSync(file, F.threatModelText({ job: J }));
      return { path: file, threats: [{ threat: 'TH-1', mitigation: 'validate input', severity: 'low' }] };
    }
    case 'architect': {
      const file = path.join(jd, 'adr-001-fix-add.md');
      const threats = fs.existsSync(path.join(jd, 'threat-model.md')) ? ['TH-1'] : [];
      fs.writeFileSync(file, F.adrText({ job: J, acs: ['AC-1'], threats }));
      const check = F.cli(root, ['doc', 'check', file, '--job', J]);
      if (!check.ok) return { exit: 5, stderr: `doc check failed: ${JSON.stringify(check)}` };
      return { kind: 'adr', paths: [file], summary: 'Fix the operator in place.' };
    }
    case 'planner': {
      const file = path.join(jd, 'plan.json');
      fs.writeFileSync(file, JSON.stringify({ tasks: [{ id: 'T1', objective: 'Fix add', allowed_paths: ['src/add.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node tests/add.test.js', covers: ['AC-1'] }] }] }));
      const v = F.cli(root, ['plan', 'validate', '--job', J]);
      return { valid: Boolean(v.valid), errors: v.errors || [], path: file };
    }
    case 'builder': {
      const s = F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
      F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
      F.sh(s.worktree, 'git commit -qam "fix add"');
      return { status: 'done', summary: 'fixed add', swept: ['src/add.js'] };
    }
    case 'tester': {
      const v = F.cli(root, ['task', 'verify', 'T1']);
      return { pass: v.pass, evidence_id: v.evidence_id, failures: (v.failures || []).map((f) => f.cmd) };
    }
    case 'integrator': {
      const r = F.cli(root, ['reconcile', 'run', '--job', J]);
      return { status: r.status === 'merged' ? 'merged' : 'behavioural_conflict', summary: JSON.stringify(r).slice(0, 200) };
    }
    case 'code-reviewer':
    case 'test-reviewer':
    case 'security-reviewer':
    case 'ux-reviewer': {
      const lane = c.role.replace('-reviewer', '').replace('test', 'tests');
      const findings = S.finding && lane === 'code' ? [{ id: 'code-1', severity: S.finding, file: 'src/add.js', line: 1, summary: 'Non-numbers are not rejected' }] : [];
      return { lane, findings };
    }
    case 'finding-verifier':
      return { finding_id: 'code-1', status: S.verdict || 'refuted', evidence: 'read src/add.js:1', reason: 'checked the code' };
    default:
      return { exit: 1, stderr: `crew: no script for ${c.agent}` };
  }
};
