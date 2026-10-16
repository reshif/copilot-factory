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

test('R25 drive stops never surfaced: a drive_stop with no drive_notified and no reply after it', () => {
  const stop = { event: 'drive_stop', ts: at(1), type: 'gate', reason: 'H2 waits for you' };
  const j = (events, decisions = [], status = 'active') => job0({ state: { status, updated_at: at(1) }, events, decisions });
  const fired = rules.jobHealth(j([stop]), LIMITS, at(3)).filter((x) => x.rule === 'R25.drive_stop_unsurfaced');
  assert.equal(fired.length, 1);
  assert.deepEqual([fired[0].class, fired[0].severity], ['gap', 'medium']);
  assert.match(fired[0].summary, /stopped 1 time\(s\) in J-0001 and nothing reached you after: gate at/);
  const none = (job, now = at(3)) => !rules.jobHealth(job, LIMITS, now).some((x) => x.rule === 'R25.drive_stop_unsurfaced');
  assert.ok(none(j([stop, { event: 'drive_notified', ts: at(1.01), via: 'inbox' }])), 'the inbox or a notification surfaced it');
  assert.ok(none(j([stop], [{ action: 'human.approve', gate: 'H2', ts: at(2) }])), 'your reply shows you saw it');
  assert.ok(none(j([stop]), at(1.05)), 'a stop a few minutes old on an active job is still in flight');
  assert.ok(!none(j([stop], [], 'closed'), at(1.05)), 'a closed job is not waiting for it');
  assert.ok(!none(j([{ event: 'drive_notified', ts: at(0) }, { ...stop, stop_id: 's1' }, { event: 'drive_notified', ts: at(2), stop_id: 's2' }], [], 'closed')), 'a notification before it, or for another stop, does not count');
  assert.ok(none(j([])), 'no drive events: a job that never ran under drive gets nothing');
});

test('inspector noise: gate A presented by amend submit, amend is not a deviation, failing task verify is a verdict, Parks counts every park', () => {
  const decisions = [
    { id: 'J-0001-D0009', ts: at(1), action: 'workflow', workflow: 'realize', step: 'realize', rule: 'order.next_step' },
    { ts: at(1.2), action: 'human.approve', gate: 'A', hash: 'h', channel: 'chat' },
    { id: 'J-0001-D0010', ts: at(1.3), action: 'workflow', workflow: 'realize', config: null, step: 'realize', rule: 'order.next_step' },
  ];
  const cli = (cmd, sub, ts, extra = {}) => ({ event: 'cli', cmd, sub, ts, decision_id: 'J-0001-D0009', ok: true, ...extra });
  const events = [cli('amend', 'start', at(1.05)), cli('amend', 'submit', at(1.1)), cli('wfargs', 'realize', at(1.01), { workflow: 'realize' }), cli('record', null, at(1.02), { workflow: 'realize', status: 'park' })];
  const job = job0({ state: { status: 'active', updated_at: at(2), approvals: { A: { via: 'chat' } } }, decisions, events });
  const found = [...rules.gates(job), ...rules.driverFidelity(job)].map((x) => x.rule);
  assert.ok(!found.includes('R4.unpresented_gate'), found.join(','));
  assert.ok(!found.includes('R7.unexpected_command'), found.join(','));
  // without the submit, an approval of A was never presented
  assert.ok(rules.gates({ ...job, events: [] }).some((x) => x.rule === 'R4.unpresented_gate'));
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

test('Phase 3 shapes: typed park rows (action park, park.kind) count as parks; a drive_stop whose notification was sent is surfaced', () => {
  const parks = rules.parksOf(job0({ decisions: [{ ts: at(1), action: 'park', rule: 'park.dependency_conflict', park: { kind: 'dependency_conflict' }, reason: 'T2 does not merge' }] }));
  assert.deepEqual(parks.map((p) => p.rule), ['dependency_conflict']);
  const stop = { event: 'drive_stop', ts: at(1), kind: 'gate', notified: 'notify-send' };
  const j = (events) => job0({ state: { status: 'closed', updated_at: at(1) }, events });
  const fired = (events) => rules.jobHealth(j(events), LIMITS, at(3)).some((x) => x.rule === 'R25.drive_stop_unsurfaced');
  assert.ok(!fired([stop, { event: 'notify', ts: at(1), kind: 'gate', method: 'notify-send', sent: true }]), 'the notifier sent it');
  assert.ok(fired([{ ...stop, notified: 'off' }, { event: 'notify', ts: at(1), kind: 'gate', method: 'off', sent: false }]), 'notifications off and no reply: never surfaced');
});
