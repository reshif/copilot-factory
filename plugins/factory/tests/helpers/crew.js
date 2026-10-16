'use strict';
// A scripted crew for fake-copilot.js (FAKE_COPILOT_SCRIPT=crew.js): every factory role
// answers like a real agent would, running the real factory CLI from its cwd where the
// role does (task start/verify, reconcile run, doc check) and writing the documents its
// role owns (ADR, threat model, plan). FAKE_CREW (JSON) tunes it:
//   { "finding": "major" }   the code reviewer reports one finding of that severity
//   { "verdict": "refuted" } what the finding verifier says: confirmed, refuted (default) or unverifiable
//   { "world": true }        clarify's read-back also plans a docs item (the docs researcher finds it)
//   { "web": "down" }        clarify's docs researcher reports no web access

const fs = require('fs');
const path = require('path');
const F = require('./fixture');

// The first JSON value after a marker in an agent's brief (the clarify crew's parser).
const { grab } = require('./clarify3-crew');

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
    // clarify v3: the read-back plans one repo item (and a docs one with S.world)
    case 'interviewer':
      return { intent: { problem: 'add(2, 3) returns -1', who: 'callers of src/add.js', outcome: 'add returns the sum', success: 'tests/add.test.js passes' }, scope: { in: ['add'], out: [] }, took: [], pins: [], plan: [{ item: 'new', what: 'Where is add implemented and what does it do today?', tag: 'repo', pins: [], impact: 'high' }, ...(S.world ? [{ item: 'new', what: 'Does the ECMAScript spec define + on two numbers as addition?', tag: 'docs', pins: [], impact: 'medium' }] : [])], questions: [], design_may_choose: [] };
    case 'brief-writer': {
      const inp = grab(text, 'CLARIFY INPUT (JSON):') || { plan: [] };
      const ev = (grab(text, 'INPUTS (JSON):') || []).flatMap((x) => (x.output && x.output.evidence) || []);
      return { summary: 'add subtracts', records: [], facts: inp.plan.flatMap((p) => { const e = ev.filter((x) => x.plan === p.id); return e.length ? [{ plan: p.id, statement: e[0].claim, evidence: e.map((x) => x.source) }] : []; }), gaps: [] };
    }
    case 'contract-writer': {
      const inp = grab(text, 'CLARIFY INPUT (JSON):') || { items: [] };
      return { contract: fs.readFileSync(path.join(jd, 'contract.md'), 'utf8'), covers: inp.items.map((x) => ({ item: x.id, where: 'Goal' })), uncovered: [] };
    }
    case 'god-eye':
      // the loop engine's diagnosis of a loop that made no progress: the question for the human
      if (/Focus: \*\*diagnosis/.test(text)) return { cause: 'The reviewer keeps finding the same problem in src/add.js and the builders do not change that line.', needs_user: true, approach: '', question: 'The same review finding survived every fix round: what should the builders do about it?', options: [{ key: 'a', text: 'Fix it the way the finding says', consequences: 'one more round with that direction' }, { key: 'b', text: 'The finding is wrong for this job: amend the contract to say so', consequences: 'an amendment you approve' }], recommendation: 'a' };
      if (/Focus: \*\*readiness/.test(text)) return { verdict: 'ready', restatement: { problem: 'add subtracts', outcome: 'add sums' }, checklist: { intent_clear: true, scope_bounded: true, acs_testable: true, self_consistent: true, facts_honoured: true, instructions_handled: true, decisions_closed: true }, objections: [] };
      return { verdict: 'approve', items: [] };
    case 'researcher': {
      const inp = grab(text, 'CLARIFY INPUT (JSON):');
      if (inp && inp.mode === 'repo') return { mode: 'repo', versions: [{ name: 'node', version: process.versions.node, source: 'process.versions' }], evidence: inp.plan.filter((p) => p.tag === 'repo').map((p) => ({ plan: p.id, claim: 'add is implemented in src/add.js and subtracts', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports = (a, b) => a - b; // bug: should add', confidence: 'high' })), unresolved: [] };
      if (inp && inp.mode === 'docs') {
        const docs = inp.plan.filter((p) => p.tag === 'docs');
        if (S.web === 'down') return { mode: 'docs', web_available: false, evidence: [], unresolved: inp.plan.map((p) => ({ plan: p.id, reason: 'web_fetch failed: no network' })) };
        return { mode: 'docs', web_available: true, evidence: docs.map((p) => ({ plan: p.id, claim: 'ECMAScript defines + on two numbers as numeric addition', source: 'https://tc39.es/ecma262/2025/#sec-applystringornumericbinaryoperator', source_tier: 'standard', system: 'ecmascript', quote: 'Return ? operation(lnum, rnum).', version: 'ES2025', retrieved_at: '2026-10-14', confidence: 'high' })), unresolved: [] };
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
