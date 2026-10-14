'use strict';
// R14 question rounds, R21 review regressions, R22 reconcile drops, and R7 on the
// router's `evidence` action — from the real factory CLI where it can produce them,
// from synthetic records for what older factory versions wrote.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('../../factory/tests/helpers/fixture');
const I = require('../inspector/main');
const rules = require('../inspector/rules');
const { LIMITS } = require('../inspector/config');

const BIN = path.join(path.resolve(__dirname, '..'), 'bin', 'factory-inspect');
const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 36e5).toISOString();
const synthetic = (ledger, extra = {}) => ({ id: 'J-0001', state: { status: 'active', updated_at: at(9) }, lock: null, events: [], decisions: [], ledger, ...extra });

test('R14 step_failures: clarify/ground rounds that asked the user are not failures (outcome needs_user, and legacy records)', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Sync VLAN', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  for (let i = 1; i <= 3; i++) {
    F.cli(root, ['next']);
    const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
    const r = F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [{ question: `Scope question ${i}?`, why: 'w', blocking: false, category: 'scope', default: 'd' }], dismissed: [] }, critique: { verdict: 'approve', intent_confirmed: true, items: [] } }));
    assert.equal(r.status, 'needs_user');
  }
  spawnSync('node', [BIN, 'run', '--job', J], { cwd: root, encoding: 'utf8' });
  const rulesFound = I.report(root).findings.map((x) => x.rule);
  assert.ok(!rulesFound.includes('R14.step_failures'), rulesFound.join(','));
  // legacy records (no outcome): clarify with questions, ground with blocking unknowns
  const legacy = synthetic([
    ...[1, 2, 3].map((h) => ({ kind: 'step', step: 'clarify', ok: false, at: at(h), detail: { round: h, questions: 2, question_ids: ['Q-1'] } })),
    ...[1, 2, 3].map((h) => ({ kind: 'step', step: 'ground', ok: false, at: at(h), detail: { topics: 1, blocking: ['Which range?'] } })),
  ]);
  assert.ok(!rules.jobHealth(legacy, LIMITS, at(10)).some((x) => x.rule === 'R14.step_failures'));
  // real failures still count
  const failing = synthetic([1, 2, 3].map((h) => ({ kind: 'step', step: 'ground', ok: false, at: at(h), detail: { topics: 0, blocking: [] } })));
  assert.ok(rules.jobHealth(failing, LIMITS, at(10)).some((x) => x.rule === 'R14.step_failures'));
});

test('R21 review regression: from the real CLI (blocked again: medium) and from an older factory\'s downgrade (let through: high)', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Sync VLAN', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 'codebase', claims: [{ claim: 'x', source: 'src/add.js:1' }], unknowns: [] }], degraded: [] }));
  F.cli(root, ['next']);
  F.cli(root, ['plan', 'from-contract']);
  const build = (files) => {
    const s = F.cli(root, ['task', 'start', 'T1', '--job', J]);
    for (const [f, c] of Object.entries(files)) F.write(s.worktree, f, c);
    F.sh(s.worktree, 'git add -A && git commit -qm build');
    F.cli(root, ['task', 'verify', 'T1', '--job', J]);
    return F.cli(root, ['reconcile', 'run', '--job', J]).status;
  };
  const review = require('../../factory/cli/core/review');
  const rec = (summary, line) => review.record(root, { jobId: J, payload: { lanes: [{ lane: 'code', findings: [{ id: 'code-1', severity: 'major', file: 'src/add.js', line, summary }] }], verifications: [{ finding_id: 'code-1', status: 'confirmed' }] } });
  const VULN = 'module.exports = (a, b) => a + b; // no validation\n';
  assert.equal(build({ 'src/add.js': VULN }), 'merged');
  rec('Non-numbers are not rejected', 1);
  assert.equal(build({ 'src/add.js': 'module.exports = (a, b) => { if (typeof a !== "number") throw new TypeError(); return a + b; };\n' }), 'merged');
  assert.equal(build({ 'src/add.js': VULN, 'src/sync.js': 'module.exports = 1;\n' }), 'merged');
  assert.equal(rec('add() accepts strings', 3).ok, false);
  const found = rules.reviewRegressions({ id: J, ledger: require('../../factory/cli/core/ledger').all(root, J) });
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].rule, found[0].class, found[0].severity], ['R21.review_regression', 'ambiguity', 'medium']);
  assert.match(found[0].summary, /blocked again/);
  spawnSync('node', [BIN, 'run', '--job', J], { cwd: root, encoding: 'utf8' });
  assert.ok(I.report(root).findings.some((x) => x.rule === 'R21.review_regression'));

  // what an older factory recorded: the same bug, reworded, downgraded to minor and let through
  const old = synthetic([
    { kind: 'step', step: 'challenge', ok: false, at: at(1), detail: { round: 1, findings: [{ id: 'code-1', lane: 'code', severity: 'major', file: 'src/b.py', line: 2, summary: 'check() accepts anything', status: 'confirmed' }] } },
    { kind: 'step', step: 'challenge', ok: true, at: at(2), detail: { round: 2, findings: [{ id: 'code-4', lane: 'code', severity: 'minor', file: 'src/b.py', line: 9, summary: 'no range validation', notes: ['downgraded from major: new in round 2 on code unchanged since the last round'], status: 'minor' }] } },
  ]);
  const legacy = rules.jobHealth(old, LIMITS, at(10)).filter((x) => x.rule === 'R21.review_regression');
  assert.equal(legacy.length, 1);
  assert.deepEqual([legacy[0].class, legacy[0].severity], ['deviation', 'high']);
  assert.match(legacy[0].summary, /let through \(code-4 as minor\/minor\)/);
  // a minor nit near a fixed bug, on another rule and summary, is not the bug
  const nit = synthetic([old.ledger[0], { kind: 'step', step: 'challenge', ok: true, at: at(2), detail: { round: 2, findings: [{ id: 'code-9', lane: 'code', severity: 'minor', file: 'src/b.py', line: 3, summary: 'name the argument', status: 'minor' }] } }]);
  assert.deepEqual(rules.reviewRegressions(nit), []);
});

test('R22 reconcile drop: a failed reconcile record with a regression is a high deviation', () => {
  const job = synthetic([
    { kind: 'step', step: 'reconcile', ok: false, at: at(3), detail: { regression: { files: ['src/b.py'], dropped: [{ file: 'src/b.py', line: 'return isinstance(x, int)  # SECURITY FIX', by: 'already-merged work', task: 'T4' }] }, message: 'Integration would drop work already merged or fixed: src/b.py: "return isinstance(x, int)  # SECURITY FIX"' } },
    { kind: 'step', step: 'reconcile', ok: true, at: at(4), detail: {} },
  ]);
  const found = rules.jobHealth(job, LIMITS, at(10)).filter((x) => x.rule === 'R22.reconcile_drop');
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].class, found[0].severity], ['deviation', 'high']);
  assert.match(found[0].summary, /src\/b\.py.*SECURITY FIX/);
  assert.deepEqual(rules.reconcileDrops(synthetic([{ kind: 'step', step: 'reconcile', ok: true, at: at(1), detail: {} }])), []);
});

test('R7: the router\'s evidence action expects factory evidence add, and nothing else', () => {
  const cli = (h, d, extra) => ({ event: 'cli', ts: at(h), job: 'J-0001', decision_id: d, ok: true, ...extra });
  const decisions = [
    { id: 'J-0001-D0001', ts: at(1), action: 'evidence', step: 'prove', command: 'factory evidence add AC-2 --type doc --path <file> --job J-0001' },
    { id: 'J-0001-D0002', ts: at(2), action: 'cli', step: 'prove', command: 'factory verify run --job J-0001' },
  ];
  const done = synthetic([], { decisions, events: [cli(1.5, 'J-0001-D0001', { cmd: 'evidence', sub: 'add' }), cli(2.5, 'J-0001-D0002', { cmd: 'verify', sub: 'run' })] });
  assert.deepEqual(rules.driverFidelity(done), []);
  const skipped = synthetic([], { decisions, events: [cli(2.5, 'J-0001-D0002', { cmd: 'verify', sub: 'run' })] });
  assert.deepEqual(rules.driverFidelity(skipped).map((x) => x.rule), ['R7.not_done']);
});
