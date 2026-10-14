'use strict';
// templates/docs and `factory doc`: every template is self-consistent, the check enforces
// front matter, section order, tables, AC/threat coverage and well-formed Mermaid, and the
// docs the CLI renders itself (findings, ship report, lessons, index) pass their own check.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');
const doc = require('../cli/core/doc');

const tmpFile = (name, text) => {
  const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'factory-doc-'));
  const p = path.join(d, name);
  fs.writeFileSync(p, text);
  return p;
};

test('every template is well formed: only its {{placeholders}} fail the check', () => {
  for (const type of Object.keys(doc.TYPES)) {
    const t = doc.loadTemplate(type);
    assert.equal(t.version, `${type}@1`);
    assert.ok(t.sections.length >= 2, type);
    const r = doc.check(doc.template(type), { type });
    assert.deepEqual(r.problems.filter((p) => !/placeholder|is not YYYY-MM-DD/.test(p)), [], `${type}: ${r.problems.join('; ')}`);
  }
  const adr = doc.loadTemplate('adr');
  assert.deepEqual(adr.sections.map((s) => s.title), ['Context', 'Decision drivers', 'Considered options', 'Decision', 'Architecture diagram', 'Consequences', 'How each acceptance criterion is met', 'Threat mitigations', 'Rollback and migration', 'Open questions']);
  assert.ok(adr.sections.find((s) => s.title === 'Architecture diagram').rules.mermaid.includes('flowchart'));
  assert.equal(doc.loadTemplate('threat-model').sections.find((s) => /Data-flow/.test(s.title)).rules.subgraph, true);
  assert.equal(doc.loadTemplate('no-adr').sections.find((s) => s.title === 'Diagram').rules.optional, true);
});

test('factory doc template / list print the template set', () => {
  const r = require('child_process').spawnSync('node', [F.BIN, 'doc', 'template', 'adr'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^---\ndoc: adr\ntemplate: adr@1/);
  assert.match(r.stdout, /## Architecture diagram[\s\S]*```mermaid\nflowchart LR/);
  const l = JSON.parse(require('child_process').spawnSync('node', [F.BIN, 'doc', 'list'], { encoding: 'utf8' }).stdout);
  assert.deepEqual(l.map((x) => x.type), ['adr', 'no-adr', 'recommendation', 'threat-model', 'contracts', 'findings', 'ship-report', 'lessons', 'index']);
  const bad = require('child_process').spawnSync('node', [F.BIN, 'doc', 'template', 'nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});

test('doc check: a valid ADR passes; one without a Mermaid architecture diagram is rejected', () => {
  const ok = tmpFile('adr-001-x.md', F.adrText({ job: 'J-0001' }));
  const r = F.cli(path.dirname(ok), ['doc', 'check', ok]);
  assert.equal(r.__code, 0, JSON.stringify(r));
  assert.equal(r.ok, true);
  assert.equal(r.type, 'adr');

  const none = tmpFile('adr-001-x.md', F.adrText({ job: 'J-0001', diagram: 'Boxes and arrows, described in words.\n' }));
  const r2 = F.cli(path.dirname(none), ['doc', 'check', none]);
  assert.equal(r2.__code, 1);
  assert.equal(r2.ok, false);
  assert.ok(r2.problems.some((p) => /"## Architecture diagram" needs a ```mermaid diagram/.test(p)), r2.problems.join('\n'));

  const seq = doc.check(F.adrText({ job: 'J-0001', diagram: '```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n' }), { type: 'adr' });
  assert.ok(seq.problems.some((p) => /needs a flowchart \| graph .* found sequenceDiagram/.test(p)), 'a sequence diagram alone is not an architecture diagram');
});

test('doc check: sections, order, front matter, tables, coverage and placeholders', () => {
  const good = F.adrText({ job: 'J-0002', acs: ['AC-1'] });
  const swap = good.replace('## Consequences', '## Tmp').replace('## Decision drivers', '## Consequences').replace('## Tmp', '## Decision drivers');
  assert.ok(doc.check(swap, { type: 'adr' }).problems.some((p) => /out of order/.test(p)));
  const noTable = good.replace(/\| # \| Option[\s\S]*?rejected: out of scope \|\n/, 'We looked at two.\n');
  assert.ok(doc.check(noTable, { type: 'adr' }).problems.some((p) => /"## Considered options" needs a markdown table/.test(p)));
  const r = doc.check(good, { type: 'adr', job: 'J-0003', acs: ['AC-1', 'AC-2'], threats: ['TH-1'] });
  assert.ok(r.problems.some((p) => /job: J-0002, but this is J-0003/.test(p)));
  assert.ok(r.problems.some((p) => /does not cover AC-2/.test(p)));
  assert.ok(r.problems.some((p) => /does not map threat\(s\) TH-1/.test(p)));
  assert.ok(doc.check(good.replace('status: proposed', 'status: maybe'), { type: 'adr' }).problems.some((p) => /status "maybe" is not one of proposed, accepted, superseded, rejected/.test(p)));
  assert.ok(doc.check(good.replace('Revert the merge commit', '{{Rollback}}'), { type: 'adr' }).problems.some((p) => /Unfilled template placeholders/.test(p)));
  assert.ok(doc.check(good.replace(/^---[\s\S]*?---\n/, ''), { type: 'adr' }).problems.some((p) => /No front matter/.test(p)));
  assert.ok(doc.check(good.replace('# ADR 001: Fix add in place', '# Fix add'), { type: 'adr' }).problems.some((p) => /Title "Fix add" should look like "ADR/.test(p)));
  assert.ok(doc.check(good.replace('Revert the merge commit; no data changes.', '<!-- later -->'), { type: 'adr' }).problems.some((p) => /"## Rollback and migration" is empty/.test(p)));
  // AC-1 is not AC-10
  assert.ok(doc.check(good.replace(/\| AC-1 \|/, '| AC-10 |'), { type: 'adr', acs: ['AC-1'] }).problems.some((p) => /does not cover AC-1/.test(p)));
});

test('doc check: no-adr is lighter (no diagram needed), but any Mermaid it has must be well formed', () => {
  assert.deepEqual(doc.check(F.noAdrText({ job: 'J-0001' }), { type: 'no-adr', acs: ['AC-1'] }).problems, []);
  const withBad = F.noAdrText({ job: 'J-0001' }).replace('## Rollback', '## Diagram\n```mermaid\nflowchart LR\n  a --> b(\n```\n\n## Rollback');
  assert.ok(doc.check(withBad, { type: 'no-adr' }).problems.some((p) => /unbalanced brackets/.test(p)));
  assert.ok(doc.check(F.noAdrText({ job: 'J-0001' }), { type: 'no-adr', threats: ['TH-1'] }).problems.some((p) => /Missing section "## Threat mitigations": the threat model lists TH-1/.test(p)));
});

test('mermaid: diagram types, blocks, edges and brackets', () => {
  const m = (body, start = 0) => doc.mermaid({ start, end: 9, body: body.split('\n') });
  assert.deepEqual(m('flowchart LR\n  subgraph s["A (b)"]\n    a[x] -->|call (y| b((c))\n  end').problems, []);
  assert.equal(m('flowchart LR\n  subgraph s["A (b)"]\n    a[x] -->|call (y| b((c))\n  end').subgraphs, 1);
  assert.deepEqual(m('%% comment\ngraph TD\n  a --> b').problems, []);
  assert.deepEqual(m('---\ntitle: x\n---\nflowchart TB\n  a -.-> b').problems, []);
  assert.deepEqual(m('sequenceDiagram\n  participant A\n  loop every minute\n    A->>B: ping (x\n  end').problems, []);
  assert.deepEqual(m('C4Container\n  Person(u, "User")\n  System_Boundary(s, "Sys") {\n    Container(api, "API", "Node")\n  }\n  Rel(u, api, "Uses", "HTTPS")').problems, []);
  assert.deepEqual(m('erDiagram\n  A ||--o{ B : has').problems, []);
  assert.match(m('flowchart XY\n  a --> b').problems.join(), /unknown direction/);
  assert.match(m('flowchart LR\n  a\n  b').problems.join(), /no edges/);
  assert.match(m('flowchart LR\n  subgraph s\n  a --> b').problems.join(), /1 subgraph\(s\) but 0 "end"/);
  assert.match(m('flowchart LR\n  a[x --> b').problems.join(), /unbalanced brackets/);
  assert.match(m('sequenceDiagram\n  alt x\n  A->>B: y').problems.join(), /1 block\(s\)/);
  assert.match(m('sequenceDiagram\n  participant A').problems.join(), /no messages/);
  assert.match(m('C4Context\n  Person(u, "User")').problems.join(), /no relationships/);
  assert.match(m('boxes\n  a --> b').problems.join(), /not a Mermaid diagram type/);
  assert.match(m('').problems.join(), /is empty/);
  assert.match(doc.mermaid({ start: 3, end: null, body: ['flowchart LR'] }).problems.join(), /line 4 is never closed/);
});

test('doc check --job checks every doc of a job; findings and the lessons register follow their templates', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 'codebase', claims: [{ claim: 'add subtracts', source: 'src/add.js:1' }, { claim: 'callers exist', source: 'UNVERIFIED' }], unknowns: [{ question: 'Floats too?', blocking: false }] }, { topic: 'history', claims: [], unknowns: [] }], degraded: [] }));
  const findings = fs.readFileSync(path.join(F.jobDir(root, J), 'findings.md'), 'utf8');
  assert.match(findings, /^---\ndoc: findings\ntemplate: findings@1\njob: J-0001\ntitle: Fix add\nstatus: grounded/);
  assert.match(findings, /\| codebase \| 2 \| 1 \| 1 \| 0 \|[\s\S]*### codebase\n\n- add subtracts — `src\/add\.js:1`\n- callers exist — \*\*UNVERIFIED\*\*[\s\S]*## Unknowns\n\n- \[codebase\] Floats too\?/);
  let r = F.cli(root, ['doc', 'check']);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.docs.map((d) => d.type), ['findings']);
  // a broken doc in the job folder fails the job check, and a file check infers the job
  F.write(F.jobDir(root, J), 'no-adr.md', F.noAdrText({ job: J, acs: [] }));
  r = F.cli(root, ['doc', 'check', '--job', J]);
  assert.equal(r.__code, 1);
  assert.match(r.docs.find((d) => d.type === 'no-adr').problems.join(), /does not cover AC-1/);
  r = F.cli(root, ['doc', 'check', path.join(F.jobDir(root, J), 'no-adr.md')]);
  assert.match(r.problems.join(), /does not cover AC-1/);
  // index renders and passes its own check
  const idx = F.cli(root, ['doc', 'index']);
  assert.equal(doc.checkFile(idx.index, { type: 'index', acs: ['AC-1'] }).ok, true);
  assert.match(fs.readFileSync(idx.index, 'utf8'), /\| contract\.md \| contract \|[^\n]*approved \(H1\) \| ok \|[\s\S]*\| no-adr\.md \| no-adr \| no-adr@1 \| accepted \| \d problem\(s\) \|[\s\S]*## Changelog[\s\S]*\| clarify \| ok \|/);
  // lessons register
  F.cli(root, ['lessons', 'add', '--job', J, '--text', 'In src/**, arithmetic helpers have a test per operator.', '--scope', 'src/**', '--why', 'code-1: add subtracted']);
  const reg = path.join(root, '.factory', 'lessons', 'lessons.md');
  assert.equal(doc.checkFile(reg).ok, true, doc.checkFile(reg).problems.join('\n'));
  assert.match(fs.readFileSync(reg, 'utf8'), /### L1 — proposed\n- Rule: In src\/\*\*, arithmetic[\s\S]*- Why: code-1: add subtracted\n- Check: review \(findings cite "lesson:L1"\)/);
});
