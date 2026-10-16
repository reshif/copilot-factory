'use strict';
// Fixes after 0.11.0 (found porting it to claude-factory): the environment seal's reply forms
// shown everywhere are exactly the ones that seal; agents may not run the machine scan or the
// sealed environment's check for a job; the inbox shows a pending seal with its exact reply.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');

const core = (m) => require(`../cli/core/${m}`);
const next = (root, env) => F.cli(root, ['next'], env ? { env } : {});

const LAYOUT = () => F.layoutLines([['src/add.js', 'changed', ['AC-1'], 'add(a, b) returns the sum'], ['tests/add.test.js', 'existing', ['AC-1'], 'proves add(2, 3) is 5']]);
const PLAN = [{ id: 'T1', objective: 'fix', allowed_paths: ['src/add.js'], criteria_ids: ['AC-1'], verify_commands: ['node tests/add.test.js'] }];
const BROKEN = { version: 1, name: 'broken', setup: ['echo "ERROR: No matching distribution found for x==9.9" >&2; exit 3'] };
const GOOD = { version: 1, name: 'fixed', setup: ['true'] };

// A medium feature through its combined H3 with a broken environment, to the repair's seal park.
function toSealPark(t) {
  const root = F.makeRepo(t);
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ decompose: { plan_probe: false } }));
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.clarify(root);
  next(root);
  F.reply(root, 'approve');
  F.cli(root, ['deps', 'fetch']);
  const g = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(g, 'ok', { topics: [{ topic: 'codebase', claims: [], unknowns: [] }], degraded: [] }));
  F.write(F.jobDir(root, J), 'adr-001-x.md', F.adrText({ job: J, layout: LAYOUT() }));
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  F.record(root, F.envelope(b, 'ok', { options: [], degraded: [], judge: { kind: 'adr', paths: [path.join(F.jobDir(root, J), 'adr-001-x.md')], summary: 's' }, critiques: [{ verdict: 'approve', items: [] }] }));
  b = F.cli(root, ['wfargs', 'decompose']);
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks: PLAN }));
  fs.writeFileSync(core('environment').JOB_PROPOSED(root, J), JSON.stringify(BROKEN));
  const rec = F.record(root, F.envelope(b, 'ok', { planner: { valid: true, errors: [], path: 'plan.json' }, critique: { verdict: 'approve', items: [] } }));
  assert.equal(rec.status, 'ok', JSON.stringify(rec.errors || rec));
  assert.equal(next(root).step, 'H3');
  F.reply(root, 'approve');
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({}));
  assert.equal(next(root).step, 'env_check');
  assert.equal(F.cli(root, ['env', 'check', '--job', J]).ok, false);
  assert.equal(next(root).step, 'env_repair');
  const w = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'env_repair']);
  const R = core('env-repair').REPAIR(root, J);
  fs.writeFileSync(R, JSON.stringify(GOOD));
  const r = F.recordRepair(root, J, w, { repair: { path: R, summary: 'fix' } });
  assert.equal(r.park.kind, 'environment_repair', JSON.stringify(r));
  return { root, J, short: core('job').load(root, J).env_repair.short };
}

// The quoted reply forms a text offers ("…" and `…`).
const quoted = (s) => [...String(s || '').matchAll(/"([^"]+)"|`([^`]+)`/g)].map((m) => m[1] || m[2]);

test('the seal\'s reply forms shown everywhere (park next, the question, factory next, the drive stop, the inbox) are exactly the accepted ones: approve environment <hash> or "a" seal; nothing shown says "yes" seals', (t) => {
  const { root, J, short } = toSealPark(t);
  const seal = `approve environment ${short}`;
  const st = core('job').load(root, J);
  const n = next(root);
  assert.equal(n.action, 'parked');
  const stop = core('drive').stopDetail('parked', n, { job: J });
  const item = core('inbox').list(root).items.find((x) => x.job === J);
  assert.ok(item, 'the inbox lists the seal');
  const md = core('inbox').markdown(core('inbox').list(root));

  // every text the user is shown names the hash, and never "(or yes)"
  const texts = { 'state.park.next': st.park.next, 'next.park.next': n.park.next, instructions: n.instructions, 'option a': st.park.options[0].text, 'drive summary': stop.summary, 'drive reply': stop.reply, 'inbox reply': item.reply.join(' | '), 'inbox markdown': md };
  for (const [k, s] of Object.entries(texts)) {
    assert.ok(String(s).includes(seal), `${k} names "${seal}": ${s}`);
    assert.doesNotMatch(String(s), /\(or yes\)|or yes\b|"yes" to seal|reply "approve environment"(?! [0-9a-f])/i, k);
  }
  assert.equal(stop.command, null, 'no terminal command seals it');
  assert.equal(item.command, null);
  assert.equal(item.human_only, true);
  assert.deepEqual(item.reply.map((x) => x.split(' ')[0] === 'approve' ? x : x.split(' ')[0]), [seal, 'a', 'b', 'c']);
  assert.deepEqual(stop.reply.split(' | ').map((x) => x.split(' (')[0]), [seal, 'a', 'b', 'c']);
  assert.doesNotMatch(core('decision-table').PARK_NEXT.environment_repair, /\(or yes\)/);
  assert.match(core('decision-table').PARK_NEXT.environment_repair, /"approve environment <hash>" \(the hash the question names\) or "a"/);
  for (const f of ['cli/core/env-repair.js', 'cli/core/decision-table.js', 'skills/park/SKILL.md', 'skills/start/SKILL.md', 'docs/DRIVE.md']) {
    assert.doesNotMatch(fs.readFileSync(path.join(F.PLUGIN, f), 'utf8'), /approve environment"? \(or yes/, f);
  }

  // every form shown as sealing seals (option a); the others are b / c; nothing else seals
  const P = core('human');
  const shown = new Set([...Object.values(texts).flatMap(quoted), ...item.reply, ...stop.reply.split(' | ')].map((x) => x.replace(/ \(.*$/, '').trim()));
  const sealing = [...shown].filter((x) => { try { const a = P.parkAnswer(st, x); return a && a.option === 'a'; } catch { return false; } });
  assert.deepEqual(sealing.sort(), [seal, 'a'].sort(), `the shown forms that seal: ${sealing}`);
  assert.equal(P.parkAnswer(st, 'b').option, 'b');
  assert.equal(P.parkAnswer(st, 'c').option, 'c');
  for (const w of ['yes', 'ok', 'sure']) assert.throws(() => P.replyToPark(root, { jobId: J, text: w, channel: 'chat' }), /does not seal/, w);
  assert.throws(() => F.reply(root, 'approve environment'), /Name the environment you seal/);
  assert.equal(core('environment').load(root).name, 'broken', 'nothing sealed yet');
  // the chat reply exactly as shown seals it
  assert.equal(F.reply(root, seal).resumed, true);
  assert.equal(core('environment').load(root).name, 'fixed');
  assert.equal(core('inbox').list(root).items.filter((x) => x.job === J && x.park_kind === 'environment_repair').length, 0);
});

test('agents are refused factory doctor --machine and factory env check --job (guard and CLI); env check --proposed stays allowed', (t) => {
  const root = F.makeRepo(t);
  const G = require('../hooks/guard-rules');
  const B = path.join(F.PLUGIN, 'bin', 'factory');
  const as = (c, agent) => G.checkBash(root, c, null, { agent, job: 'J-0001' });
  for (const c of [`node "${B}" doctor --machine`, 'factory doctor --machine', 'factory env check --job J-0001', 'factory env check --job=J-0001', 'factory --job J-0001 env check', 'J=J-0001; factory env check --job "$J"']) {
    assert.ok(as(c, true), `agent denied: ${c}`);
  }
  assert.match(as('factory doctor --machine', true), /doctor --machine.*main session/);
  assert.match(as('factory env check --job J-0001', true), /may only check a proposal/);
  for (const c of ['factory env check --proposed', 'factory env check --proposed --job J-0001', 'factory env show']) assert.equal(as(c, true), null, `agent allowed: ${c}`);
  for (const c of ['factory doctor --machine', 'factory env check --job J-0001']) assert.equal(as(c, false), null, `the main session may: ${c}`);
  // the CLI backstop: inside a factory agent, whatever way the command was built
  const agentEnv = { FACTORY_RUNNER: '1', FACTORY_AGENT_ROLE: 'planner' };
  const r1 = F.cli(root, ['doctor', '--machine'], { env: agentEnv });
  assert.equal(r1.code, 'agent_not_allowed', JSON.stringify(r1).slice(0, 300));
  assert.match(JSON.stringify(r1), /doctor --machine/);
  const r2 = F.cli(root, ['env', 'check', '--job', 'J-0001'], { env: agentEnv });
  assert.equal(r2.code, 'agent_not_allowed', JSON.stringify(r2).slice(0, 300));
  assert.match(JSON.stringify(r2), /may only check a proposal/);
  const r3 = F.cli(root, ['env', 'check', '--proposed', '--job', 'J-0001'], { env: agentEnv });
  assert.notEqual(r3.code, 'agent_not_allowed', JSON.stringify(r3).slice(0, 300));
  const r4 = F.cli(root, ['env', 'check', '--job', 'J-0001'], { env: { FACTORY_RUNNER: '' } });
  assert.notEqual(r4.code, 'agent_not_allowed', 'the main session runs it');
});
