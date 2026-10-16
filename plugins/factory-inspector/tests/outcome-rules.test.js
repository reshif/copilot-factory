'use strict';
// P4.5 outcome rules (R23 work lost, R24 exports removed, R25 drive stops never surfaced) and
// the inspector-noise fixes from the red-team run: gate A presented by `amend submit`, amend
// commands are not driver deviations, a failing `task verify` is a verdict and not a CLI
// failure, and the health summary counts parks the way R16 does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../../factory/tests/helpers/fixture');
const I = require('../inspector/main');
const rules = require('../inspector/rules');
const { LIMITS } = require('../inspector/config');

const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 36e5).toISOString();
const job0 = (extra = {}) => ({ id: 'J-0001', state: { status: 'closed', updated_at: at(9), tasks: {} }, lock: null, events: [], decisions: [], ledger: [], ...extra });

// A repo with: base B; T1 adds src/csv.js exporting toCsv and parse (start B, head H1); T2 starts
// at H1 and rewrites src/csv.js without toCsv (head H2); an unrelated line of history S0 off B.
function history() {
  const root = F.makeRepo();
  const head = () => F.sh(root, 'git rev-parse HEAD').trim();
  const B = head();
  F.write(root, 'src/csv.js', 'function toCsv(rows) { return rows.join(","); }\nfunction parse(t) { return t.split(","); }\nmodule.exports = {\n  toCsv,\n  parse,\n};\n');
  F.sh(root, 'git add -A && git commit -qm "T1: csv"');
  const H1 = head();
  F.write(root, 'src/csv.js', 'function parse(t) { return t.split(","); }\nmodule.exports = { parse };\n');
  F.sh(root, 'git add -A && git commit -qm "T2: tidy"');
  const H2 = head();
  F.sh(root, `git checkout -q -b other ${B} && git commit -q --allow-empty -m "S0"`);
  const S0 = head();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insp-job-'));
  const evFile = (id, h) => {
    const p = path.join(dir, `${id}.json`);
    fs.writeFileSync(p, JSON.stringify({ id, head: h, pass: true }));
    return p;
  };
  const tasks = {
    T1: { outcome: 'done', start_commit: B, evidence: { pass: true, file: evFile('T1', H1), at: at(2) }, history: [{ attempt: 1, summary: 'added the csv helpers' }] },
    T2: { outcome: 'done', start_commit: H1, evidence: { pass: true, file: evFile('T2', H2), at: at(3) }, history: [{ attempt: 1, summary: 'tidied src/csv.js' }] },
  };
  const ledger = (shipped) => [
    { kind: 'step', step: 'reconcile', ok: true, at: at(4), detail: { task_heads: { T1: H1, T2: H2 } } },
    { kind: 'step', step: 'ship', ok: true, at: at(5), detail: { head: shipped } },
  ];
  return { root, dir, B, H1, H2, S0, tasks, ledger };
}

test('R24 export removed: an export one task added is gone at ship, removed by a later task, with no recorded reason', () => {
  const h = history();
  const plan = { tasks: [{ id: 'T1', objective: 'Add toCsv and parse' }, { id: 'T2', objective: 'Tidy src/csv.js' }] };
  const job = job0({ root: h.root, dir: h.dir, plan, state: { status: 'closed', tasks: h.tasks }, ledger: h.ledger(h.H2) });
  const found = rules.evidenceChain(job).filter((x) => x.rule === 'R24.export_removed');
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].class, found[0].severity], ['deviation', 'high']);
  assert.match(found[0].summary, /toCsv \(src\/csv\.js, added by T1, removed by T2\)/);
  assert.ok(!/parse/.test(found[0].summary), 'an export still shipped is fine');
  assert.ok(!rules.evidenceChain(job).some((x) => x.rule === 'R23.work_lost'), 'T1 and T2 are both in what shipped');
  // a recorded reason (the plan says so) explains it
  const planned = { tasks: [plan.tasks[0], { id: 'T2', objective: 'Remove toCsv: callers use the stream writer now' }] };
  assert.deepEqual(rules.evidenceChain({ ...job, plan: planned }).filter((x) => x.rule === 'R24.export_removed'), []);
  // a re-export dropped by a rebuild (the red-team run's lost toCsv): `...require('./csv')` is an export of the index
  assert.ok(rules.exportsOf("module.exports = { ...require('./csv'), load, total };\n", 'src/index.js').has("...require('./csv')"));
  assert.ok(rules.exportsOf("export * from './csv';\n", 'src/index.ts').has("* from './csv'"));
  // no git (a synthetic job) or no ship: nothing said
  assert.deepEqual(rules.exportsRemoved({ ...job, root: undefined }), []);
  assert.deepEqual(rules.exportsRemoved({ ...job, ledger: job.ledger.slice(0, 1) }), []);
});

test('R23 work lost: a task\'s verified or integrated commits are not in the commit that shipped', () => {
  const h = history();
  const job = job0({ root: h.root, dir: h.dir, plan: null, state: { status: 'closed', tasks: h.tasks }, ledger: h.ledger(h.S0) });
  const found = rules.workLost(job);
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].rule, found[0].class, found[0].severity], ['R23.work_lost', 'deviation', 'high']);
  assert.match(found[0].summary, /2 task\(s\) of J-0001 have commits that are not in what shipped/);
  assert.match(found[0].summary, /T1 @[0-9a-f]{10} \(integration, 1 commit\(s\) missing\)/);
  // shipped on top of everything: nothing lost
  assert.deepEqual(rules.workLost({ ...job, ledger: h.ledger(h.H2) }), []);
  // a commit git no longer has: unknown, not lost
  assert.deepEqual(rules.workLost({ ...job, ledger: h.ledger('0'.repeat(40)) }), []);
});

test('R25 drive stops never surfaced: a stop that needs you with no notification sent, no inbox look and no reply', () => {
  // drive.js order: the notify line is written a few ms BEFORE its drive_stop
  const ms = (h, d) => new Date(Date.parse(at(h)) + d).toISOString();
  const stop = { event: 'drive_stop', ts: at(1), kind: 'gate', gate: 'H2', notified: 'off', sent: false };
  const j = (events, decisions = [], status = 'active') => job0({ state: { status, updated_at: at(1) }, events, decisions });
  const fires = (job, now = at(3)) => rules.jobHealth(job, LIMITS, now).some((x) => x.rule === 'R25.drive_stop_unsurfaced');
  const fired = rules.jobHealth(j([stop]), LIMITS, at(3)).filter((x) => x.rule === 'R25.drive_stop_unsurfaced');
  assert.equal(fired.length, 1);
  assert.deepEqual([fired[0].class, fired[0].severity], ['gap', 'medium']);
  assert.match(fired[0].summary, /where you had to act, and nothing reached you after: gate at .* \(notifier: off\)/);
  assert.ok(!fires(j([{ event: 'notify', ts: ms(1, -2), kind: 'gate', method: 'notify-send', sent: true }, { ...stop, notified: 'notify-send' }])), 'a notify logged just before its stop surfaced it');
  assert.ok(!fires(j([{ ...stop, notified: 'notify-send', sent: true }])), 'the stop itself says it was sent');
  assert.ok(!fires(j([{ ...stop, notified: 'repeat' }])), 'the same stop was announced before');
  assert.ok(fires(j([{ event: 'notify', ts: ms(1, -60000), kind: 'gate', method: 'notify-send', sent: true }, stop])), 'a notification a minute earlier was for something else');
  assert.ok(!fires(j([stop, { event: 'drive_notified', ts: at(1.01), via: 'inbox' }])), 'a drive_notified line');
  assert.ok(!fires(j([stop, { event: 'cli', cmd: 'inbox', ts: at(1.5), ok: true }])), 'you (or the main session) opened the inbox');
  assert.ok(!fires(j([stop], [{ action: 'human.approve', gate: 'H2', ts: at(2) }])), 'your reply shows you saw it');
  assert.ok(!fires(j([stop]), at(1.05)), 'a stop a few minutes old on an active job is still in flight');
  for (const kind of ['done', 'interrupted', 'superseded']) assert.ok(!fires(j([{ ...stop, kind }])), `${kind}: nothing for you to act on`);
  assert.ok(!fires(j([stop], [], 'closed')), 'a closed job waits for nothing');
  assert.ok(!fires(j([])), 'no drive events: a job that never ran under drive gets nothing');
});

test('inspector noise: gate A presented by amend submit, amend is not a deviation, failing task verify is a verdict, Parks counts every park', () => {
  const decisions = [
    { id: 'J-0001-D0009', ts: at(1), action: 'workflow', workflow: 'realize', step: 'realize', rule: 'order.next_step' },
    { ts: at(1.2), action: 'human.approve', gate: 'A', hash: 'h', channel: 'chat' },
    { id: 'J-0001-D0010', ts: at(1.3), action: 'workflow', workflow: 'realize', config: null, step: 'realize', rule: 'order.next_step' },
  ];
  const cli = (cmd, sub, ts, extra = {}) => ({ event: 'cli', cmd, sub, ts, decision_id: 'J-0001-D0009', ok: true, ...extra });
  const events = [cli('amend', 'start', at(1.05)), cli('amend', 'submit', at(1.1)), cli('wfargs', 'realize', at(1.01), { workflow: 'realize' }), cli('record', null, at(1.02), { workflow: 'realize', status: 'park' })];
  const job = job0({ state: { status: 'active', updated_at: at(2), approvals: { A: { via: 'chat' } }, amendment: { status: 'approved', hash: 'h' } }, decisions, events });
  const found = [...rules.gates(job), ...rules.driverFidelity(job)].map((x) => x.rule);
  assert.ok(!found.includes('R4.unpresented_gate'), found.join(','));
  assert.ok(!found.includes('R7.unexpected_command'), found.join(','));
  // without the submit, an approval of A was never presented
  assert.ok(rules.gates({ ...job, events: [] }).some((x) => x.rule === 'R4.unpresented_gate'));
  // a submit of another amendment does not present this one (hash never submitted)
  assert.ok(rules.gates({ ...job, state: { ...job.state, amendment: { hash: 'other' } } }).some((x) => x.rule === 'R4.unpresented_gate'));
  // failing task verify runs (exit 1, no code) are verdicts; refusals with a code are failures
  const verdicts = Array.from({ length: 5 }, (_, i) => cli('task', 'verify', at(2 + i / 10), { ok: false, code: null }));
  assert.ok(!rules.jobHealth({ ...job, events: verdicts }, LIMITS, at(3)).some((x) => x.rule === 'R13.cli_failures'));
  const refusals = Array.from({ length: 3 }, (_, i) => cli('task', 'verify', at(2 + i / 10), { ok: false, code: 'dependency_not_merged' }));
  assert.ok(rules.jobHealth({ ...job, events: refusals }, LIMITS, at(3)).some((x) => x.rule === 'R13.cli_failures'));
  // parks: the router's, a workflow's result and a typed park event, one count for R16 and health
  const parks = rules.parksOf(job0({ decisions: [{ id: 'D1', ts: at(1), action: 'parked', rule: 'cap.review_rounds' }], events: [cli('record', null, at(2), { status: 'park', workflow: 'realize' }), { event: 'task_parked', ts: at(3), type: 'dependency_conflict' }, { event: 'task_parked', ts: at(3), type: 'dependency_conflict' }] }));
  assert.equal(parks.length, 3, 'one park written twice at once counts once');
});

test('health summary: Parks counts every park (as R16 does) and failing checks apart from CLI failures', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  const ev = require('../../factory/cli/core/events');
  for (let i = 0; i < 4; i++) ev.append(root, { event: 'cli', job: J, cmd: 'record', sub: null, ok: true, status: 'park', workflow: 'realize' });
  for (let i = 0; i < 3; i++) ev.append(root, { event: 'cli', job: J, cmd: 'task', sub: 'verify', ok: false, code: null });
  // spaced in time, so none is the same park twice
  const lines = fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 7);
  const h = I.health(root);
  const job = require('../inspector/observe').observe(root).jobs[J];
  assert.equal(h.parks, rules.parksOf(job).length);
  assert.ok(h.parks >= 1);
  assert.equal(h.cli.verdicts, 3);
  assert.equal(h.cli.by_code.filter((x) => /task verify/.test(x.key)).length, 0, 'a failing task verify is not a CLI failure');
});

test('Phase 3 shapes: typed park rows (action park, park.kind) count as parks', () => {
  const parks = rules.parksOf(job0({ decisions: [{ ts: at(1), action: 'park', rule: 'park.dependency_conflict', park: { kind: 'dependency_conflict' }, reason: 'T2 does not merge' }] }));
  assert.deepEqual(parks.map((p) => p.rule), ['dependency_conflict']);
});

test('R24 (review M5): an export moved to another file, and renamed tests, are not removals; an unattributed drop is medium', () => {
  const root = F.makeRepo();
  const head = () => F.sh(root, 'git rev-parse HEAD').trim();
  const B = head();
  F.write(root, 'src/a.js', 'function parseRow(r) { return r.split(","); }\nmodule.exports = { parseRow };\n');
  F.write(root, 'tests/test_a.py', 'def test_parse_row():\n    pass\n');
  F.sh(root, 'git add -A && git commit -qm T1');
  const H1 = head();
  F.write(root, 'src/a.js', 'module.exports = {};\n');
  F.write(root, 'src/parse.js', 'function parseRow(r) { return r.split(","); }\nmodule.exports = { parseRow };\n');
  F.write(root, 'tests/test_a.py', 'def test_parse_rows():\n    pass\n');
  F.sh(root, 'git add -A && git commit -qm T2');
  const H2 = head();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insp-mv-'));
  const ev = (id, h) => { const p = path.join(dir, `${id}.json`); fs.writeFileSync(p, JSON.stringify({ head: h, pass: true })); return p; };
  const tasks = { T1: { outcome: 'done', start_commit: B, evidence: { pass: true, file: ev('T1', H1), at: at(2) } }, T2: { outcome: 'done', start_commit: H1, evidence: { pass: true, file: ev('T2', H2), at: at(3) } } };
  const ledger = (ship) => [{ kind: 'step', step: 'reconcile', ok: true, at: at(4), detail: { task_heads: { T1: H1, T2: H2 } } }, { kind: 'step', step: 'ship', ok: true, at: at(5), detail: { head: ship } }];
  const job = job0({ root, dir, plan: { tasks: [] }, state: { status: 'closed', base_commit: B, tasks }, ledger: ledger(H2) });
  assert.deepEqual(rules.exportsRemoved(job), [], 'parseRow moved to src/parse.js; the renamed test is not an interface');
  // dropped with no task's range removing it (an integration commit): medium, not high
  F.write(root, 'src/parse.js', 'module.exports = {};\n');
  F.sh(root, 'git add -A && git commit -qm "integration: oops"');
  const S = head();
  const found = rules.exportsRemoved({ ...job, ledger: ledger(S) });
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'medium');
  assert.match(found[0].summary, /parseRow \(src\/a\.js, added by T1, removed by T2\)|parseRow \(src\/a\.js, added by T1\)/);
});
