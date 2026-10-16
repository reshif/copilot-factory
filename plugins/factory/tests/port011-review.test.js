'use strict';
// The fixes from the claude-factory 0.11 port review that apply to copilot-factory 0.11.1
// (PORT-011-REPORT.md, "Fixes after the review"): M-1 (the environment checks as a
// long step: detached, bounded by the caller's time, picked up later, cut-offs counted, stale
// scratch worktrees swept), M-2 (repair candidates follow the probe's switches), M-3 ("I fixed it"
// forgets every machine cache), m-1 … m-9.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const T = require('./helpers/tmp');
const { seal } = require('../cli/lib/seal');

const core = (m) => require(`../cli/core/${m}`);
const newJob = (root, risk = 'medium') => F.cli(root, ['job', 'new', '--title', 'x', '--type', 'feature', '--risk', risk]).job;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A job whose sealed environment is `env` (confirmed from the user's terminal).
function sealed(t, env) {
  const root = F.makeRepo(t);
  const J = newJob(root);
  core('environment').confirm(root, { env, channel: 'tty' });
  return { root, J };
}
// The sealed check failed and the router routed a repair: the repair brief.
function toRepair(root, J) {
  assert.equal(F.cli(root, ['env', 'check', '--job', J]).ok, false);
  core('job').mutate(root, J, (x) => {
    x.last_decision = 'workflow:env_repair::';
  });
  return F.cli(root, ['wfargs', 'fanout-judge', '--config', 'env_repair']);
}
const BROKEN = { version: 1, name: 'broken', setup: ['echo "ERROR: no x==9.9" >&2; exit 3'] };

// ------------------------------------------------------------------ M-1

test('M-1: recording a repair never runs the candidate; the router names its check, a long CLI step of its own, which ends the round', (t) => {
  const { root, J } = sealed(t, BROKEN);
  const b = toRepair(root, J);
  const ran = path.join(T.mkdtemp('factory-m1-', t), 'ran');
  fs.writeFileSync(core('env-repair').REPAIR(root, J), JSON.stringify({ version: 1, name: 'fixed', setup: [`touch ${ran}`] }));
  const rec = F.record(root, F.envelope(b, 'ok', { repair: { path: core('env-repair').REPAIR(root, J), summary: 'fix' } }));
  assert.equal(rec.status, 'ok', JSON.stringify(rec));
  assert.equal(rec.pending_check, true);
  assert.equal(fs.existsSync(ran), false, 'factory record ran nothing');
  const n = core('env-repair').routerAction({ root, state: core('job').load(root, J) });
  assert.equal(n.step, 'env_repair_check');
  assert.equal(n.command, `factory env check --repair --job ${J}`);
  // a second record while the candidate waits is refused (the router did not route a repair)
  assert.equal(F.record(root, F.envelope(b, 'ok', { repair: { path: core('env-repair').REPAIR(root, J), summary: 'again' } })).code, 'no_repair_open');
  const r = F.cli(root, ['env', 'check', '--repair', '--job', J]);
  assert.equal(r.status, 'park', JSON.stringify(r));
  assert.equal(r.park.kind, 'environment_repair');
  assert.equal(fs.existsSync(ran), true, 'the check ran it, in the scratch worktree');
  assert.equal(core('job').load(root, J).env_repair_pending, null);
});

test('M-1: the check runs in its own process, bounded by the caller\'s time; a call that runs out returns pending and the next call picks up the result; the drive yields on it', async (t) => {
  const go = path.join(T.mkdtemp('factory-m1go-', t), 'go');
  const { root, J } = sealed(t, { version: 1, name: 'slow', setup: [`for i in $(seq 100); do test -f ${go} && exit 0; sleep 0.1; done; exit 1`] });
  const env = { FACTORY_ENVCHECK_MIN_START_MS: '1000', FACTORY_DRIVE_DEADLINE: String(Date.now() + 4000) };
  const first = F.cli(root, ['env', 'check', '--job', J], { env });
  assert.equal(first.pending, true, JSON.stringify(first));
  const st = core('env-repair').readStarted(root, J);
  assert.equal(st.finished, false);
  assert.equal(core('probe').sameProcess(st.pid, st.pid_start), true, 'it goes on in its own process');
  fs.writeFileSync(go, '');
  const second = F.cli(root, ['env', 'check', '--job', J]);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(core('env-repair').readStarted(root, J).finished, true);
  assert.equal(core('env-repair').routerAction({ root, state: core('job').load(root, J) }), null, 'recorded: the router moves on');
  await sleep(1);
});

test('M-1: a check cut off twice goes to the user\'s terminal (step_too_long with --foreground); the drive stops with that command; the foreground run finishes', (t) => {
  const go = path.join(T.mkdtemp('factory-m1fg-', t), 'go');
  const { root, J } = sealed(t, { version: 1, name: 'slow', setup: [`for i in $(seq 300); do test -f ${go} && exit 0; sleep 0.1; done; exit 1`] });
  const env = { FACTORY_ENVCHECK_MIN_START_MS: '1000' };
  let killed = 0;
  for (let i = 0; i < 6 && killed < 2; i++) {
    const r = F.cli(root, ['env', 'check', '--job', J], { env: { ...env, FACTORY_DRIVE_DEADLINE: String(Date.now() + 6000) } });
    assert.equal(r.pending, true, JSON.stringify(r));
    const st = core('env-repair').readStarted(root, J);
    if (st.finished) continue;
    process.kill(-st.pid, 'SIGKILL'); // the run dies (a reboot, an OOM kill)
    killed += 1;
    spawnSync('sleep', ['0.3']);
  }
  const third = F.cli(root, ['env', 'check', '--job', J], { env });
  assert.equal(third.code, 'step_too_long', JSON.stringify(third));
  assert.equal(third.details.command, `factory env check --job ${J} --foreground`);
  // factory drive turns it into its step_too_long stop, naming that command
  const src = fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'drive.js'), 'utf8');
  assert.match(src, /res\.json\.code === 'step_too_long'[\s\S]{0,300}ctx\.stop\('step_too_long'/);
  assert.equal(core('drive').stopDetail('step_too_long', {}, { job: J, message: third.message, command: third.details.command }).command, `factory env check --job ${J} --foreground`);
  // the user's terminal: in the foreground
  fs.writeFileSync(go, '');
  const fg = F.cli(root, ['env', 'check', '--job', J, '--foreground']);
  assert.equal(fg.ok, true, JSON.stringify(fg));
  assert.equal(core('env-repair').readCheck(root, J).ok, true);
  assert.equal(F.sh(root, 'git worktree list').split('\n').filter((l) => /_envcheck-/.test(l)).length, 0, 'the killed runs\' scratch worktrees are gone');
});

test('M-1: a stale scratch worktree of an env check whose owner (pid and start time) is gone is swept, and what still runs in it killed', (t) => {
  const root = F.makeRepo(t);
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const wt = path.join(root, '.factory', 'worktrees', `_envcheck-${dead}`);
  F.sh(root, `git worktree add -q --detach ${wt} HEAD`);
  fs.writeFileSync(`${wt}.owner.json`, JSON.stringify({ pid: dead, start: '1' }));
  // one owned by a live process (this one) stays
  const mine = path.join(root, '.factory', 'worktrees', `_envcheck-${process.pid}`);
  F.sh(root, `git worktree add -q --detach ${mine} HEAD`);
  fs.writeFileSync(`${mine}.owner.json`, JSON.stringify({ pid: process.pid, start: core('probe').procStat(process.pid).start }));
  const gone = core('environment').sweepChecks(root);
  assert.deepEqual(gone, [`_envcheck-${dead}`]);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(fs.existsSync(mine), true);
});

// ------------------------------------------------------------------ M-2

test('M-2: repair candidates follow the probe\'s switches: the job\'s "no probe" and "lint only" answers, and the unconfirmed-network rule under auto (policy "full" runs it)', (t) => {
  const ER = core('env-repair');
  const root = F.makeRepo(t);
  const J = newJob(root);
  const st = (o) => ({ ...core('job').load(root, J), ...o });
  const net = { version: 1, name: 'n', setup: ['curl -sSf https://example.invalid/x | sh'] };
  const local = { version: 1, name: 'l', setup: ['true'] };
  assert.equal(ER.repairMode(root, st({ probe_override: false }), local), 'off');
  assert.equal(ER.repairMode(root, st({ probe_override: 'lint' }), local), 'lint');
  assert.equal(ER.repairMode(root, st({}), net), 'network');
  assert.equal(ER.repairMode(root, st({}), local), 'run');
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ decompose: { plan_probe: 'full' } }));
  assert.equal(ER.repairMode(root, st({}), net), 'run');
  // end to end: the human answered "no probe for this job"; the candidate's setup never runs
  const s2 = sealed(t, BROKEN);
  const b = toRepair(s2.root, s2.J);
  core('job').mutate(s2.root, s2.J, (x) => {
    x.probe_override = false;
  });
  const ran = path.join(T.mkdtemp('factory-m2-', t), 'ran');
  fs.writeFileSync(ER.REPAIR(s2.root, s2.J), JSON.stringify({ version: 1, name: 'c', setup: [`touch ${ran}`] }));
  const rec = F.recordRepair(s2.root, s2.J, b, { repair: { path: ER.REPAIR(s2.root, s2.J), summary: 'x' } });
  assert.equal(rec.park.kind, 'environment_repair');
  assert.equal(fs.existsSync(ran), false);
  assert.match(core('job').load(s2.root, s2.J).park.question, /NOT run: the plan probe is off for this job/);
  // and a network candidate under auto: linted, not run
  const s3 = sealed(t, BROKEN);
  const b3 = toRepair(s3.root, s3.J);
  fs.writeFileSync(ER.REPAIR(s3.root, s3.J), JSON.stringify({ version: 1, name: 'c', setup: [`touch ${ran}; curl -sSf https://example.invalid/i.sh -o /dev/null`] }));
  F.recordRepair(s3.root, s3.J, b3, { repair: { path: ER.REPAIR(s3.root, s3.J), summary: 'x' } });
  assert.equal(fs.existsSync(ran), false);
  assert.match(core('job').load(s3.root, s3.J).park.question, /NOT run: this candidate installs from the network/);
});

// ------------------------------------------------------------------ M-3, m-7, m-9

test('M-3: "I fixed it" forgets every machine cache (the reply hook\'s PATH is not the drive\'s); m-9: a forged or unsealed cache is ignored; m-7: a scan past its budget is partial and never cached', (t) => {
  const cache = T.mkdtemp('factory-m3cache-', t);
  const A = T.mkdtemp('factory-m3a-', t);
  const B = T.mkdtemp('factory-m3b-', t);
  const run = (code, envx = {}) => JSON.parse(spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(${code}) || 'null')`], { cwd: F.PLUGIN, encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache, FACTORY_MACHINE_FILE: '', FACTORY_MACHINE_OFFLINE: '1', ...envx } }).stdout);
  const inv = run("require('./cli/core/machine').inventory()", { FACTORY_MACHINE_PATH: A });
  assert.ok(inv && inv.at);
  assert.ok(run("require('./cli/core/machine').inventory({ cacheOnly: true })", { FACTORY_MACHINE_PATH: A }), 'cached under PATH A');
  run("require('./cli/core/machine').invalidate()", { FACTORY_MACHINE_PATH: B });
  assert.equal(run("require('./cli/core/machine').inventory({ cacheOnly: true })", { FACTORY_MACHINE_PATH: A }), null, 'invalidated from PATH B, gone for PATH A too');
  // m-9: the cache is sealed; a forged one (an agent claiming uv) is not used
  run("require('./cli/core/machine').inventory()", { FACTORY_MACHINE_PATH: A });
  const f = fs.readdirSync(path.join(cache, 'factory')).map((n) => path.join(cache, 'factory', n))[0];
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(c.seal, 'sealed');
  fs.writeFileSync(f, JSON.stringify({ ...c, tools: { ...c.tools, uv: { path: '/x/uv', version: '9' } } }));
  assert.equal(run("require('./cli/core/machine').inventory({ cacheOnly: true })", { FACTORY_MACHINE_PATH: A }), null, 'a forged inventory is ignored');
  const { seal: _s, ...plain } = c;
  fs.writeFileSync(f, JSON.stringify(plain));
  assert.equal(run("require('./cli/core/machine').inventory({ cacheOnly: true })", { FACTORY_MACHINE_PATH: A }), null, 'an unsealed one too');
  // m-7: a budget of 1 ms: partial, never cached
  fs.rmSync(path.join(cache, 'factory'), { recursive: true, force: true });
  const shim = T.mkdtemp('factory-m7-', t);
  fs.writeFileSync(path.join(shim, 'python3'), '#!/bin/sh\nsleep 0.2; echo "Python 3.10.12"\n');
  fs.chmodSync(path.join(shim, 'python3'), 0o755);
  const p = run("require('./cli/core/machine').inventory()", { FACTORY_MACHINE_PATH: shim, FACTORY_MACHINE_SCAN_BUDGET_MS: '1' });
  assert.equal(p.partial, true);
  assert.ok(!fs.existsSync(path.join(cache, 'factory')) || !fs.readdirSync(path.join(cache, 'factory')).length, 'a partial scan is not cached');
  // the repair brief and the decompose brief read the cache, never scan (not long steps)
  assert.match(fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'wfargs.js'), 'utf8'), /inventory\(\{ cacheOnly: true \}\)[\s\S]{0,200}not scanned yet/);
});

// ------------------------------------------------------------------ m-1

test('m-1: on the seal question only "approve environment <hash>" or "a" alone seal: never "a, …", "1", the option\'s text or "seal …"; the seal shapes are replies for the scheduling guard', (t) => {
  const { root, J } = sealed(t, BROKEN);
  const b = toRepair(root, J);
  fs.writeFileSync(core('env-repair').REPAIR(root, J), JSON.stringify({ version: 1, name: 'fixed', setup: ['true'] }));
  const rec = F.recordRepair(root, J, b, { repair: { path: core('env-repair').REPAIR(root, J), summary: 'x' } });
  assert.equal(rec.park.kind, 'environment_repair');
  const short = core('job').load(root, J).env_repair.short;
  for (const w of ['a, no wait do not seal', 'a - wait', '1', 'a) ok', 'Seal the repaired environment', 'seal the deal after you explain prefix', `Seal the repaired environment ${short}`]) {
    assert.throws(() => core('human').replyToPark(root, { jobId: J, text: w, channel: 'chat' }), /does not seal/, w);
    assert.equal(core('environment').load(root).name, 'broken', `nothing sealed by "${w}"`);
  }
  for (const w of ['a', '(a)', 'option a', `approve environment ${short}`, 'Seal the repaired environment now']) assert.ok(core('human').readReply(w).reply, w);
  const r = core('human').replyToPark(root, { jobId: J, text: '(a)', channel: 'chat' });
  assert.equal(r.resumed, true);
  assert.equal(core('environment').load(root).name, 'fixed');
  // the stop and the route name the exact reply (copilot-factory 0.11.1)
  assert.match(core('decision-table').PARK_NEXT.environment_repair, /"approve environment <hash>" \(the hash the question names\) or "a"/);
});

// ------------------------------------------------------------------ m-2, m-8

test('m-2 / m-8: an agent may not scan the machine or check the confirmed environment, in any form the guard can read, and the CLI refuses both while an agent works', (t) => {
  const root = F.makeRepo(t);
  const G = require('../hooks/guard-rules');
  const pol = core('policy').defaults();
  const agent = { agent: true, job: 'J-0001' };
  F.write(root, 'scan.sh', 'factory doctor --machine\n');
  F.write(root, 'proposal.sh', 'factory env check --proposed\n');
  for (const cmd of ['echo --machine | xargs factory doctor', 'factory doctor $(echo --machine)', 'F=--machine; factory doctor $F', 'echo --job J-0001 | xargs factory env check', 'factory env check ${X:---job} J-0001', 'factory env check', 'factory env check --repair --job J-0001', 'bash scan.sh', `node -e "require('child_process').execSync('factory doctor --machine')"`, `python3 -c "import os; os.system('factory env check --job J-0001')"`]) {
    assert.ok(G.checkBash(root, cmd, pol, agent), `refused: ${cmd}`);
    if (!/xargs|\$\(|\$\{/.test(cmd)) assert.equal(G.checkBash(root, cmd, pol, {}), null, `the main session may: ${cmd}`);
  }
  for (const cmd of ['factory env check --proposed', 'bash proposal.sh', 'factory env show', 'factory env status']) assert.equal(G.checkBash(root, cmd, pol, agent), null, cmd);
  // the CLI's backstop while an agent works (FACTORY_RUNNER and the role variables)
  const ag = { env: { FACTORY_RUNNER: '1' } };
  assert.equal(F.cli(root, ['doctor', '--machine'], ag).code, 'agent_not_allowed');
  assert.equal(F.cli(root, ['env', 'check'], ag).code, 'agent_not_allowed');
  assert.equal(F.cli(root, ['env', 'check', '--repair', '--job', 'J-0001'], ag).code, 'agent_not_allowed');
  assert.notEqual(F.cli(root, ['env', 'check', '--proposed'], ag).code, 'agent_not_allowed');
  assert.notEqual(F.cli(root, ['env', 'status'], ag).code, 'agent_not_allowed');
});

// ------------------------------------------------------------------ m-3

test('m-3: a failing check\'s output is redacted before the record, the repair brief, the park and the drive stop', (t) => {
  // the secrets are in the user's environment, never in the sealed environment's own text (the
  // repair agent sees that text: it is what it repairs)
  const prev = { MY_API_TOKEN: process.env.MY_API_TOKEN, HTTPS_PROXY: process.env.HTTPS_PROXY };
  process.env.MY_API_TOKEN = 'tok_s3cr3tvalue123456';
  process.env.HTTPS_PROXY = 'http://bob:pw12345@proxy.corp:8080';
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const { root, J } = sealed(t, { version: 1, name: 'leaky', setup: ['echo "auth failed with $MY_API_TOKEN via $HTTPS_PROXY" >&2; exit 3'] });
  const ck = F.cli(root, ['env', 'check', '--job', J]);
  assert.equal(ck.ok, false);
  const rec = fs.readFileSync(core('env-repair').CHECK(root, J), 'utf8');
  assert.doesNotMatch(rec, /tok_s3cr3tvalue123456|pw12345/);
  assert.doesNotMatch(JSON.stringify(ck), /tok_s3cr3tvalue123456|pw12345/);
  core('job').mutate(root, J, (x) => {
    x.last_decision = 'workflow:env_repair::';
  });
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'env_repair']);
  assert.doesNotMatch(fs.readFileSync(b.judge.prompt.split('\n')[1].trim(), 'utf8'), /tok_s3cr3tvalue123456|pw12345/);
  assert.doesNotMatch(JSON.stringify(core('job').load(root, J).loops), /tok_s3cr3tvalue123456|pw12345/);
});

// ------------------------------------------------------------------ m-4, m-5, m-6

test('m-4: the diff of a list is ordered: a repeated command shows with its position', () => {
  const d = core('env-repair').fullDiff({ setup: ['a', 'b'] }, { setup: ['a', 'b', 'a'] });
  assert.equal(d, '+ setup: a (#3)');
  const m = core('env-repair').fullDiff({ setup: ['a', 'b'] }, { setup: ['b', 'a'] });
  assert.match(m, /^- setup: a \(#1\)\n\+ setup: a \(#2\)$|^- setup: b \(#2\)\n\+ setup: b \(#1\)$/);
});

test('m-5: the console renderer caps edges ("&" fan-out): past the cap the source is shown', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'console', 'src', 'js', 'shell', f), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(`${src('mermaid.js')}\nthis.R = mermaidRender;`, ctx);
  const side = (p) => Array.from({ length: 40 }, (_, i) => `${p}${i}`).join(' & ');
  const big = ['flowchart LR', `${side('a')} --> ${side('b')}`].join('\n');
  const t0 = Date.now();
  const r = ctx.R(big);
  assert.equal(r.svg, null);
  assert.match(r.reason, /too large/);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(ctx.R('flowchart LR\n  a & b --> c & d').svg, 'a small fan-out still draws');
});

test('m-6: the sealed state\'s design-depth marker wins over the lock; a lock re-sealed with older templates cannot downgrade the job, and reseal restores the marker', (t) => {
  const root = F.makeRepo(t);
  const J = newJob(root);
  const jd = F.jobDir(root, J);
  const lockFile = path.join(jd, 'recipe.lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const { seal: _s, ...body } = lock;
  fs.writeFileSync(lockFile, JSON.stringify(seal({ ...body, design_templates: { adr: 'adr@1', 'no-adr': 'no-adr@1' } }), null, 2));
  const adr = path.join(jd, 'adr-001-x.md');
  fs.writeFileSync(adr, F.adrText({ job: J, template: 'adr@1' }));
  const r = F.cli(root, ['doc', 'check', adr]);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /created under adr@2/.test(p)), JSON.stringify(r.problems));
  // the human's reseal takes the lock as it is, except the state's marker
  fs.writeFileSync(lockFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(lockFile, 'utf8')), note: 'edited' }, null, 2));
  const out = core('job').reseal(root, J);
  assert.equal(out.design_templates_kept, true);
  assert.deepEqual(out.design_templates_differed, { adr: 'adr@1', 'no-adr': 'no-adr@1' });
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')).design_templates, { adr: 'adr@2', 'no-adr': 'no-adr@2' });
});
