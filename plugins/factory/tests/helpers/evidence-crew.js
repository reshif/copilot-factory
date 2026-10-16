'use strict';
// The 0.10.0 crew ("critics with evidence") for fake-copilot.js: crew.js plays every role, except
//   - the interfaces researcher, which writes an API ledger from the fetched dependency source
//     (its first quote is at the wrong line, so the CLI rejects it and asks once more);
//   - the architect, whose first design relies on a library flag the way it reads, not the way
//     the pinned source behaves (SKIP_UNMATCHED_DST "so stale VLANs are deleted"), and whose
//     revise follows the critic's evidence;
//   - the API-conformance critic, which reads the fetched source and objects with file:line;
//   - the finding verifier, which confirms what the source shows;
//   - the planner, whose first plan has a verify command that cannot run (a binary nobody
//     installs), fixed once the CLI's plan probe says so.
// EVIDENCE_CREW (JSON): { "plan": "good" } starts with a plan that runs.

const fs = require('fs');
const path = require('path');
const F = require('./fixture');
const base = require('./crew');

const opt = () => {
  try {
    return JSON.parse(process.env.EVIDENCE_CREW || '{}');
  } catch {
    return {};
  }
};

// The pinned library the tests fetch (served by archives.fakeIndex as a wheel).
const LIB = {
  'diffsync/__init__.py': 'from diffsync.enum import DiffSyncFlags\n\n\ndef sync_to(target, flags=DiffSyncFlags.NONE):\n    """Sync to target; objects missing from the source are deleted unless a SKIP flag says otherwise."""\n    return target\n',
  'diffsync/enum.py': [
    'import enum',
    '',
    '',
    'class DiffSyncFlags(enum.Flag):',
    '    NONE = 0',
    '    SKIP_UNMATCHED_DST = 0b10  # objects only in the target are kept: nothing is deleted',
    '',
  ].join('\n'),
};

function readText(c) {
  const nested = (t) => t.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/') && l.endsWith('.md') && fs.existsSync(l)).map((l) => fs.readFileSync(l, 'utf8')).join('\n');
  return `${c.instructions || ''}\n${nested(c.instructions || '')}\n${c.prompt || ''}`;
}

function adr(J, { threats, decision, usage }) {
  const text = F.adrText({ job: J, acs: ['AC-1'], threats, decision });
  return text.replace('## Consequences', `## External API usage\n| Symbol | How the design uses it | Ledger |\n|---|---|---|\n| ${usage} | L-1 |\n\n## Consequences`);
}

module.exports = (c) => {
  const root = c.env.FACTORY_ROOT;
  const J = c.env.FACTORY_JOB;
  const jd = path.join(root, '.factory', 'jobs', J);
  const text = readText(c);
  const lib = `.factory/deps/${J}/pypi/diffsync-2.0.1/diffsync/enum.py`;
  switch (c.role) {
    case 'researcher': {
      if (/CLARIFY INPUT/.test(text)) return base(c);
      if (!/Topic: \*\*interfaces\*\*/.test(text)) return { topic: 'codebase', claims: [{ claim: 'add subtracts', source: 'src/add.js:1' }], unknowns: [] };
      const again = /The factory CLI checked your API ledger/.test(text);
      return {
        topic: 'interfaces',
        claims: [{ claim: 'The sync uses diffsync 2.0.1 (requirements.txt)', source: 'requirements.txt:1' }],
        unknowns: [],
        ledger: [{ symbol: 'diffsync.DiffSyncFlags.SKIP_UNMATCHED_DST', file: lib, line: again ? 6 : 5, quote: 'SKIP_UNMATCHED_DST = 0b10', version: '2.0.1', behaviour: 'objects only in the target are kept: with this flag nothing is deleted' }],
      };
    }
    case 'architect': {
      const file = path.join(jd, 'adr-001-sync.md');
      const threats = fs.existsSync(path.join(jd, 'threat-model.md')) ? ['TH-1'] : [];
      const revise = /api-conformance/.test(text) && /SKIP_UNMATCHED_DST/.test(text) && /Revise the design record/.test(text);
      fs.writeFileSync(file, revise
        ? adr(J, { threats, decision: 'We will call sync_to with DiffSyncFlags.NONE, so VLANs missing from the source are deleted (L-1: SKIP_UNMATCHED_DST would keep them).', usage: 'diffsync.sync_to(target, flags=DiffSyncFlags.NONE) | deletes objects missing from the source; SKIP_UNMATCHED_DST deliberately not passed' })
        : adr(J, { threats, decision: 'We will call sync_to with SKIP_UNMATCHED_DST so stale VLANs are deleted.', usage: 'diffsync.sync_to(target, flags=SKIP_UNMATCHED_DST) | deletes stale objects in the target' }));
      const check = F.cli(root, ['doc', 'check', file, '--job', J]);
      if (!check.ok) return { exit: 5, stderr: `doc check failed: ${JSON.stringify(check)}` };
      return { kind: 'adr', paths: [file], summary: revise ? 'Sync without SKIP_UNMATCHED_DST.' : 'Sync with SKIP_UNMATCHED_DST.' };
    }
    case 'api-conformance': {
      const design = fs.readFileSync(path.join(jd, 'adr-001-sync.md'), 'utf8');
      const src = fs.readFileSync(path.join(root, lib), 'utf8').split('\n');
      const line = src.findIndex((l) => l.includes('SKIP_UNMATCHED_DST =')) + 1;
      if (/flags=SKIP_UNMATCHED_DST/.test(design)) {
        return { verdict: 'revise', items: [{ symbol: 'diffsync.DiffSyncFlags.SKIP_UNMATCHED_DST', issue: 'ADR "Decision" passes SKIP_UNMATCHED_DST so stale VLANs are deleted; the pinned source keeps objects only in the target with that flag, so nothing is deleted.', severity: 'blocker', evidence: { kind: 'source', ref: `${lib}:${line}`, quote: 'SKIP_UNMATCHED_DST = 0b10' }, suggestion: 'Do not pass SKIP_UNMATCHED_DST.' }] };
      }
      return { verdict: 'approve', items: [] };
    }
    case 'finding-verifier': {
      const m = /"id": "([^"]+)"/.exec(text);
      return { finding_id: m ? m[1] : 'x', status: 'confirmed', evidence: `${lib}:6 reads "SKIP_UNMATCHED_DST = 0b10  # objects only in the target are kept"`, reason: 'The source keeps target-only objects under that flag.' };
    }
    case 'planner': {
      const file = path.join(jd, 'plan.json');
      const fixed = opt().plan === 'good' || /plan probe/.test(text);
      const cmd = fixed ? 'node tests/add.test.js' : 'vlan-sync-check --strict && node tests/add.test.js';
      fs.writeFileSync(file, JSON.stringify({ tasks: [{ id: 'T1', objective: 'Sync without SKIP_UNMATCHED_DST (ADR 001)', allowed_paths: ['src/add.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: [{ cmd, covers: ['AC-1'] }] }] }));
      const v = F.cli(root, ['plan', 'validate', '--job', J]);
      return { valid: Boolean(v.valid), errors: v.errors || [], path: file };
    }
    default:
      return base(c);
  }
};

module.exports.LIB = LIB;
