'use strict';
// 0.11 "design depth": the design the human approves shows what is decided (decision records with
// options and trade-offs), how it works end to end (component, sequence, data mapping, failure
// flow) and where every file goes (the project layout), and `factory doc check`, `factory plan
// validate`, the gate view and the console enforce and show it. Older designs (template adr@1)
// keep their rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const T = require('./helpers/tmp');
const doc = require('../cli/core/doc');
const design = require('../cli/core/design');

const FIX = path.join(__dirname, 'fixtures', 'design');
const GOOD = fs.readFileSync(path.join(FIX, 'adr-vlan-sync.md'), 'utf8');
const CONTRACT = fs.readFileSync(path.join(FIX, 'contract-vlan-sync.md'), 'utf8');
const ACS = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'];
const OPTS = { type: 'adr', acs: ACS, testAcs: ACS, options: [{ id: 'O-1', title: 'Netmiko' }, { id: 'O-2', title: 'NAPALM' }, { id: 'O-3', title: 'Golden Config' }] };
const problems = (text, opts = OPTS) => doc.check(text, opts).problems;
const has = (ps, re) => assert.ok(ps.some((p) => re.test(p)), `expected ${re} in:\n${ps.join('\n')}`);
// the text of one "##" section of the good ADR, replaced
const swap = (title, body) => GOOD.replace(new RegExp(`(## ${title}\\n)[\\s\\S]*?(?=\\n## )`), `$1${body}\n`);

test('doc check: a deep ADR (decisions, flows, mapping, failures, layout, how it runs) passes', () => {
  const r = doc.check(GOOD, OPTS);
  assert.deepEqual(r.problems, []);
  assert.equal(r.template, 'adr@2');
  const l = design.layoutOf(GOOD);
  assert.deepEqual(l.entries.filter((e) => !e.dir).map((e) => e.path).slice(0, 4), ['nautobot_vlan_sync/__init__.py', 'nautobot_vlan_sync/jobs.py', 'nautobot_vlan_sync/records.py', 'nautobot_vlan_sync/collectors/__init__.py']);
  assert.deepEqual(l.entries.find((e) => e.path.endsWith('netmiko_collector.py')), { path: 'nautobot_vlan_sync/collectors/netmiko_collector.py', dir: false, status: 'new', responsibility: 'collect_vlans(): SSH with Secrets credentials, TextFSM parse, DeviceError', acs: ['AC-1', 'AC-3'], line: l.entries.find((e) => e.path.endsWith('netmiko_collector.py')).line, note: l.entries.find((e) => e.path.endsWith('netmiko_collector.py')).note });
  const recs = design.decisionRecords(GOOD.split('## Decision records')[1].split('\n## ')[0]);
  assert.deepEqual(recs.map((d) => [d.id, d.options.length, d.chosen]), [['D-1', 3, 'O-1 Netmiko "show vlan brief"'], ['D-2', 3, 'Key on (VLAN group, VID), tenant checked'], ['D-3', 2, 'One transaction per device']]);
});

test('doc check: decision records need context, cited drivers, a real trade-off table, one choice, consequences and a revisit trigger', () => {
  const d1 = GOOD.split('### D-1')[1].split('### D-2')[0];
  const at = (txt) => GOOD.replace(d1, txt);
  has(problems(swap('Decision records', 'We weighed it all and chose Netmiko.')), /needs at least one decision record/);
  has(problems(at(d1.replace(/\| O-2 NAPALM[^\n]*\n\| O-3 Golden[^\n]*\n/, ''))), /D-1 weighs 1 option\(s\)/);
  has(problems(at(d1.replace('| chosen |', '| rejected: no |'))), /D-1: exactly one option's verdict must say "chosen" \(found 0\)/);
  has(problems(at(d1.replace('rejected: two platforms uncovered', 'chosen'))), /found 2/);
  has(problems(at(d1.replace(/\*\*Drivers\.\*\*[^\n]*/, '**Drivers.** Coverage and speed matter most.'))), /D-1: its Drivers cite nothing/);
  has(problems(at(d1.replace(/\*\*Revisit when\.\*\*[^\n]*/, ''))), /D-1 is missing \*\*Revisit when\.\*\*/);
  has(problems(at(d1.replace(/\*\*Consequences\.\*\*[^\n]*/, '**Consequences.** Fine.'))), /\*\*Consequences\.\*\* says too little/);
  const narrow = d1.replace(/\| Option \| Platform[^\n]*\n\|---[^\n]*\n/, '| Option | Verdict |\n|---|---|\n').replace(/\| (O-\d [^|]*)\|[^\n]*\| (chosen|rejected[^|]*) \|/g, '| $1| $2 |');
  has(problems(at(narrow)), /D-1: the options table has 2 column\(s\): a trade-off table needs/);
  // the option generators' options: one row each, by id
  has(problems(GOOD.replace(/^\| O-3 \|.*\n/m, '')), /leaves out the option generators' O-3/);
  has(problems(GOOD.replace(/^\| O-[23] \|.*\n/gm, ''), { ...OPTS, options: null }), /"## Considered options" lists 1 option/);
});

test('doc check: the flows — a component diagram with real modules, a sequence with failure paths, every AC a flow step', () => {
  has(problems(GOOD.replace(/  subgraph nautobot\[[^\n]*\n/, '').replace(/\n  end\n  col -->/, '\n  col -->')), /draws no boundary/);
  const generic = '```mermaid\nflowchart LR\n  u([User]) -->|request| a\n  subgraph s["System"]\n    a[Entry point] -->|call| b[Core module]\n  end\n  b -->|protocol| x[External system]\n```';
  has(problems(swap('Architecture diagram', generic)), /names none of the modules in "## Project layout"/);
  has(problems(swap('End-to-end flow', 'The job runs.')), /"## End-to-end flow" needs a ```mermaid diagram \(sequenceDiagram\)/);
  const happy = '```mermaid\nsequenceDiagram\n  U->>J: run\n  J->>C: collect\n  C-->>J: vlans\n  J->>W: apply\n  Note over J: AC-1 AC-2 AC-3 AC-4 AC-5\n```';
  has(problems(swap('End-to-end flow', happy)), /shows only the happy path/);
  has(problems(swap('End-to-end flow', '```mermaid\nsequenceDiagram\n  U->>J: run\n  alt ok\n    J-->>U: done\n  end\n  Note over J: AC-1 AC-2 AC-3 AC-4 AC-5\n```')), /has 2 message\(s\): draw the whole run/);
  has(problems(GOOD.replace('Note over U,J: AC-5 the job is listed in Jobs', 'Note over U,J: the job is listed in Jobs')), /No flow step shows AC-5/);
});

test('doc check: data mapping with a match key, a failure table mapped to ACs, how it runs in code', () => {
  has(problems(swap('Data model and mapping', 'We copy the VLAN fields across.')), /needs a mapping table \(Source \| Target \| Transform \| Match key\)/);
  has(problems(swap('Data model and mapping', '| Source | Target |\n|---|---|\n| vlan id | VLAN.vid |')), /must say which fields match a source record to a target record/);
  assert.deepEqual(problems(swap('Data model and mapping', 'None: this change only renames a CLI flag, no data moves.')), []);
  has(problems(swap('Failure and state flow', '| Failure | Detected by | Behaviour | AC |\n|---|---|---|---|\n| Device unreachable | timeout | skip | AC-3 |')), /lists 1 failure/);
  has(problems(swap('Failure and state flow', '| Failure | Detected by | Behaviour |\n|---|---|---|\n| Device unreachable | timeout | skip |\n| Login failed | auth error | skip |')), /map each failure to the acceptance criterion/);
  has(problems(swap('How it runs', 'Engineers start it from the Jobs page.')), /must name the entry points and commands in `code`/);
});

test('doc check: the project layout — a tree of files with status, responsibility and ACs; every AC served; a test file', () => {
  has(problems(swap('Project layout', 'Files under nautobot_vlan_sync and tests.')), /needs the file tree in a ```text block/);
  has(problems(GOOD.replace('creates, updates and conflicts · AC-1, AC-4', 'creates and updates · AC-1').replace('updates and conflicts · AC-1, AC-4', 'updates · AC-1')), /no file serves AC-4/);
  has(problems(GOOD.replace('# new · exports collect_vlans · AC-1', '# exports collect_vlans · AC-1')), /collectors\/__init__\.py has no status/);
  has(problems(GOOD.replace('# new · exports collect_vlans · AC-1', '# new · AC-1')), /collectors\/__init__\.py needs its responsibility/);
  has(problems(GOOD.replace('· AC-1, AC-4\n└── writer', '· AC-1, AC-4, AC-9\n└── writer')), /cites AC-9, which the contract does not have/);
  const noTests = GOOD.replace(/^tests\/\n(├──|│|└──)[^\n]*\n(│[^\n]*\n|├──[^\n]*\n|└──[^\n]*\n)*/m, '');
  has(problems(noTests), /lists no new or changed test file, but AC-1/);
  has(problems(GOOD.replace('README.md                     # existing', '../README.md                  # existing')), /must be a repository-relative path inside the repository/);
});

test('doc check: an ADR written under adr@1 keeps adr@1\'s rules (with a warning); a no-adr@2 note needs its layout', () => {
  const old = F.adrText({ job: 'J-0001' });
  const r = doc.check(old, { type: 'adr', acs: ['AC-1'] });
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.template, 'adr@1');
  assert.ok(r.warnings.some((w) => /older template adr@1/.test(w)));
  const no2 = F.noAdrText({ job: 'J-0001' }).replace('template: no-adr@1', 'template: no-adr@2');
  has(doc.check(no2, { type: 'no-adr' }).problems, /Missing section "## Project layout"/);
  const full = no2.replace('## How each acceptance criterion is met', '## Project layout\n```text\nsrc/\n└── add.js          # changed · adds instead of subtracting · AC-1\ntests/\n└── add.test.js     # changed · proves add(2, 3) is 5 · AC-1\n```\n\n## How it runs\n- Test: `node tests/add.test.js`\n\n## How each acceptance criterion is met');
  assert.deepEqual(doc.check(full, { type: 'no-adr', acs: ['AC-1'], testAcs: ['AC-1'] }).problems, []);
});

function vlanJob(t) {
  const root = F.makeRepo(t);
  const J = F.cli(root, ['job', 'new', '--title', 'VLAN sync', '--type', 'feature', '--risk', 'medium']).job;
  const jd = F.jobDir(root, J);
  fs.writeFileSync(path.join(jd, 'contract.md'), CONTRACT);
  fs.writeFileSync(path.join(jd, 'adr-001-vlan-sync.md'), GOOD.replace('job: J-0001', `job: ${J}`));
  return { root, J, jd };
}

test('plan validate: every new or changed layout file is owned by exactly one task, every task path covers a layout file; the tree shows the owners', (t) => {
  const { root, J, jd } = vlanJob(t);
  const { GOOD: good, BAD: bad } = require('./helpers/design-crew');
  fs.writeFileSync(path.join(jd, 'plan.json'), JSON.stringify({ tasks: bad }));
  const v = F.cli(root, ['plan', 'validate', '--job', J]);
  assert.equal(v.valid, false);
  has(v.errors, /nautobot_vlan_sync\/diff\.py \(new in the design's Project layout\) is owned by T1 and T2/);
  has(v.errors, /tests\/test_collector\.py \(new in the design's Project layout\) is owned by no task/);
  has(v.errors, /pyproject\.toml \(changed in the design's Project layout\) is owned by no task/);
  has(v.errors, /T2's allowed path docs\/\*\* covers no new, changed or deleted file in the design's Project layout \(adr-001-vlan-sync\.md\)/);
  assert.ok(!v.errors.some((e) => /README\.md/.test(e)), 'an existing file needs no owner');
  fs.writeFileSync(path.join(jd, 'plan.json'), JSON.stringify({ tasks: good }));
  const ok = F.cli(root, ['plan', 'validate', '--job', J]);
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
  assert.equal(ok.layout.find((f) => f.path === 'nautobot_vlan_sync/diff.py').owner, 'T2');
  assert.equal(ok.layout.find((f) => f.path === 'README.md').owner, null);
  assert.match(ok.layout_tree, /netmiko_collector\.py\s+# new · T1 · AC-1,AC-3 · collect_vlans/);
  // the builder's packet: the layout files its task owns, and the flow
  const pk = require('../cli/core/packet').forTask(root, require('../cli/core/job').load(root, J), 'T2');
  assert.deepEqual(pk.layout.map((f) => f.path), ['nautobot_vlan_sync/diff.py', 'tests/test_diff.py']);
  assert.match(pk.flow, /^```mermaid\nsequenceDiagram/);
  // the gate's view: decisions, the diagrams, the layout with owners; `doc design --format md`
  const view = F.cli(root, ['doc', 'design', '--job', J]);
  assert.deepEqual(view.decisions.map((d) => d.id), ['D-1', 'D-2', 'D-3']);
  assert.deepEqual(view.diagrams.map((d) => [d.section, d.type]), [['Architecture diagram', 'flowchart'], ['End-to-end flow', 'sequenceDiagram'], ['Data model and mapping', 'erDiagram'], ['Failure and state flow', 'stateDiagram-v2']]);
  assert.equal(view.layout.planned, true);
  assert.deepEqual(view.layout.problems, []);
  assert.match(view.summary, /3 decision record\(s\); 1 component, 1 sequence and 2 data \/ state diagram\(s\); a layout of 13 file\(s\) \(10 new, 2 changed\), 12 owned by one task/);
  const md = spawnSync('node', [F.BIN, 'doc', 'design', '--job', J, '--format', 'md'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } }).stdout;
  assert.match(md, /\| D-2 How a found VLAN is matched to a Nautobot VLAN \| Key on \(VLAN group, VID\), tenant checked \| Key on VID only; Key on name \|/);
  assert.match(md, /```mermaid\nsequenceDiagram[\s\S]*alt reachable and logged in/);
  assert.match(md, /```text\nnautobot_vlan_sync\/\n  __init__\.py\s+# changed · T3 · AC-5/);
});

test('plan validate: an older design (adr@1) has no layout contract; plans are checked as before', (t) => {
  const root = F.makeRepo(t);
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'adr-001-fix-add.md'), F.adrText({ job: J }));
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks: [{ id: 'T1', objective: 'Fix add', allowed_paths: ['src/**'], criteria_ids: ['AC-1'], verify_commands: ['node tests/add.test.js'] }] }));
  const v = F.cli(root, ['plan', 'validate', '--job', J]);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(v.layout, undefined);
  assert.ok(F.cli(root, ['doc', 'design', '--job', J]).legacy.length === 1);
});

test('console: the page draws the design\'s mermaid diagrams itself (flowchart, sequence with blocks, state, er) and shows the layout with owners', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'console', 'src', 'js', 'shell', f), 'utf8');
  const ctx = { esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]) };
  vm.createContext(ctx);
  vm.runInContext(`${src('mermaid.js')}\n${src('design.js')}\nthis.mermaidSvg = mermaidSvg; this.designHtml = designHtml;`, ctx);
  const blocks = doc.structure(GOOD).fences.filter((f) => f.lang === 'mermaid').map((f) => f.body.join('\n'));
  const svgs = blocks.map((b) => ctx.mermaidSvg(b));
  assert.ok(svgs.every((s) => s && s.startsWith('<svg') && s.endsWith('</svg>')), 'every diagram of the ADR is drawn');
  assert.match(svgs[0], /class="mm-grp"[\s\S]*Nautobot 2\.x/);
  assert.match(svgs[0], /class="mm-node changed"><title>jobs\.VlanSyncJob/);
  assert.match(svgs[1], /<tspan class="kw">alt<\/tspan> reachable and logged in/);
  assert.match(svgs[1], /<tspan class="kw">else<\/tspan> unreachable or login failed/);
  assert.match(svgs[1], /AC-3 report it, go on with the next device/);
  assert.equal(ctx.mermaidSvg('pie title x\n "a": 1'), null, 'a type it does not draw: the page shows the source');
  const html = ctx.designHtml({ summary: 's', decisions: [{ id: 'D-1', title: 'T', chosen: 'A', options: [{ option: 'A', verdict: 'chosen' }, { option: 'B', verdict: 'rejected: slow' }], why: 'w', revisit: 'r' }], diagrams: [{ section: 'End-to-end flow', type: 'sequenceDiagram', ok: true, source: blocks[1] }], layout: { planned: true, files: [{ path: 'a/b.py', status: 'new', owners: ['T1'], acs: ['AC-1'], responsibility: 'does b' }, { path: 'a/c.py', status: 'new', owners: [], acs: [], responsibility: 'does c' }], problems: [] }, runs: '- `run`', legacy: [] });
  assert.match(html, /<td>B \(rejected: slow\)<\/td>/);
  assert.match(html, /<svg class="mmd"/);
  assert.match(html, /<td>T1<\/td>/);
  assert.match(html, /<td class="bad">no owner<\/td>/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'console', 'console.html'), 'utf8');
  assert.ok(page.includes('function mermaidSvg(') && page.includes('function designHtml('), 'built into the one page');
});

// ---------------------------------------------------------------- end to end
const FAKE = path.join(__dirname, 'helpers', 'fake-copilot.js');
const CREW = path.join(__dirname, 'helpers', 'design-crew.js');

function runArgs(n) {
  const a = [n.workflow];
  if (n.config) a.push('--config', n.config);
  if (n.mode) a.push('--mode', n.mode);
  if (n.lanes) a.push('--lanes', [].concat(n.lanes).join(','));
  if (n.threat_model === true) a.push('--threat-model');
  if (n.threat_model === false) a.push('--no-threat-model');
  return a;
}

test('e2e: the fake Copilot writes a full design; record holds it to every generated option, the planner to the layout, and the ONE medium gate shows what, how and where', (t) => {
  const dir = T.mkdtemp('factory-e2e-design-', t);
  const env = { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: FAKE, FAKE_COPILOT_SCRIPT: CREW, FAKE_COPILOT_LOG: path.join(dir, 'copilot.jsonl'), FACTORY_NOTIFY: 'off' };
  const root = F.makeRepo(t);
  const J = F.cli(root, ['job', 'new', '--title', 'VLAN sync', '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), CONTRACT);
  const runs = [];
  let gate = null;
  for (let i = 0; i < 40 && !gate; i++) {
    const n = F.cli(root, ['next']);
    if (n.action === 'skill' && n.skill === 'clarify') {
      if (n.clarify.waiting_for_user) F.cli(root, ['clarify', 'reply', 'ok']);
      else assert.equal(spawnSync('node', [F.BIN, 'run', 'clarify', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 240000 }).status, 0);
    } else if (n.action === 'gate' && n.step === 'H1') F.reply(root, 'approve');
    else if (n.action === 'gate') gate = n;
    else if (n.action === 'cli') {
      const w = n.command.split(/\s+/).slice(1).filter((x, k, a) => x !== '--job' && a[k - 1] !== '--job');
      const r = F.cli(root, w);
      assert.ok(!r.error, JSON.stringify(r));
    } else if (n.action === 'workflow') {
      const r = spawnSync('node', [F.BIN, 'run', ...runArgs(n), '--json'], { cwd: root, env, encoding: 'utf8', timeout: 240000 });
      const out = JSON.parse(r.stdout);
      assert.equal(r.status, 0, r.stdout.slice(0, 2000));
      runs.push({ workflow: n.workflow, config: n.config || null, out });
    } else assert.fail(`unexpected: ${JSON.stringify(n).slice(0, 500)}`);
  }
  assert.ok(gate, 'a gate was reached');
  assert.equal(gate.step, 'H3');
  assert.deepEqual(gate.review.approves, ['design', 'plan', 'environment']);
  // decide ran twice: the first ADR left out the generators' O-3, and record sent it back
  const decides = runs.filter((r) => r.config === 'decide');
  assert.equal(decides.length, 2);
  assert.equal(decides[0].out.status, 'retry');
  assert.ok(decides[0].out.doc_problems.some((p) => /leaves out the option generators' O-3 \("Read VLANs from Golden Config backups"\)/.test(p)), JSON.stringify(decides[0].out.doc_problems));
  const opts = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'options.json'), 'utf8'));
  assert.deepEqual(opts.options.map((o) => o.id), ['O-1', 'O-2', 'O-3']);
  // decompose: the first plan ignored the layout, validate said so, the planner derived it from the tree
  const dec = runs.find((r) => r.workflow === 'decompose').out;
  assert.ok(dec.agents.some((a) => a.label === 'planner #2'), JSON.stringify(dec.agents));
  // the gate: decision table, the four diagrams, the tree with one owner per built file
  const D = gate.review.design;
  assert.deepEqual(D.decisions.map((d) => [d.id, d.chosen]), [['D-1', 'O-1 Netmiko "show vlan brief"'], ['D-2', 'Key on (VLAN group, VID), tenant checked'], ['D-3', 'One transaction per device']]);
  assert.deepEqual(D.diagrams.map((d) => d.type), ['flowchart', 'sequenceDiagram', 'erDiagram', 'stateDiagram-v2']);
  assert.ok(D.layout.files.filter((f) => f.status !== 'existing').every((f) => f.owners.length === 1), JSON.stringify(D.layout.files));
  assert.equal(D.layout.files.find((f) => f.path === 'nautobot_vlan_sync/__init__.py').owners[0], 'T3');
  assert.match(D.runs, /runjob nautobot_vlan_sync\.jobs\.VlanSyncJob/);
  // the inbox and the console show the same
  const inbox = spawnSync('node', [F.BIN, 'inbox', '--format', 'md'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } }).stdout;
  assert.match(inbox, /\*\*Design:\*\* 3 decision record\(s\)[\s\S]*\| D-3 How writes are grouped \| One transaction per device[\s\S]*```mermaid\nflowchart LR[\s\S]*```text\nnautobot_vlan_sync\//);
  const data = require('../cli/core/console').build(root, {});
  const job = data.jobs.find((j) => j.id === J);
  assert.equal(job.design.decisions.length, 3);
  assert.equal(job.design.layout.planned, true);
});
