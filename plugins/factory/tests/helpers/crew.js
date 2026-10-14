'use strict';
// A scripted crew for fake-copilot.js (FAKE_COPILOT_SCRIPT=crew.js): every factory role
// answers like a real agent would, running the real factory CLI from its cwd where the
// role does (task start/verify, reconcile run, doc check) and writing the documents its
// role owns (ADR, threat model, plan). FAKE_CREW (JSON) tunes it:
//   { "finding": "major" }   the code reviewer reports one finding of that severity
//   { "verdict": "refuted" } what the finding verifier says (default refuted)

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
  const text = c.instructions || '';
  switch (c.role) {
    case 'intent-analyst':
      return { focus: 'x', questions: [] };
    case 'judge':
      return { questions: [], dismissed: [] };
    case 'god-eye':
      if (/intent_confirmed/.test(text)) return { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'add subtracts', outcome: 'add sums' }, items: [] };
      return { verdict: 'approve', items: [] };
    case 'researcher':
      return { topic: 'codebase', claims: [{ claim: 'add subtracts', source: 'src/add.js:1' }], unknowns: [] };
    case 'option-generator':
      return { title: 'Fix in place', summary: 'Change the operator', pros: ['small'], cons: [] };
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
      return { finding_id: 'code-1', status: S.verdict || 'refuted', reason: 'checked the code' };
    default:
      return { exit: 1, stderr: `crew: no script for ${c.agent}` };
  }
};
