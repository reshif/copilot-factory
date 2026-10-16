'use strict';
// Phase 3 review fixes (P3-REVIEW.md): M1 guard flags, M2 gate A only once presented, M3 an
// amendment's approval resumes as `resume` does, M4 drive liveness and ownership, M5 the attempt
// barrier and the green base, M6 the start skill, M7 transient signals and their park, and the
// minors fixed with them (stop_before_ship, notify dedupe, exit codes, evidence naming).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');

const FAKE = path.join(__dirname, 'helpers', 'fake-copilot.js');
const CREW = path.join(__dirname, 'helpers', 'crew.js');
const REALIZE = path.join(F.PLUGIN, 'workflows', 'realize.js');
const core = (m) => require(`../cli/core/${m}`);
const stateOf = (root, J) => JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'state.json'), 'utf8'));
const events = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness({ script = CREW, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-p3r-'));
  let file = script;
  if (!fs.existsSync(script)) {
    file = path.join(dir, 'script.js');
    fs.writeFileSync(file, script);
  }
  const ENV = { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: FAKE, FAKE_COPILOT_SCRIPT: file, FAKE_COPILOT_LOG: path.join(dir, 'copilot.jsonl'), FACTORY_NOTIFY: 'off', ...env };
  const parse = (r) => {
    let j;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      j = { raw: r.stdout };
    }
    return Object.assign(j, { __code: r.status, __stderr: r.stderr });
  };
  return {
    dir,
    env: ENV,
    cli: (root, args) => parse(spawnSync('node', [F.BIN, ...args], { cwd: root, encoding: 'utf8', env: ENV, timeout: 300000 })),
    drive: (root, args = []) => parse(spawnSync('node', [F.BIN, 'drive', ...args], { cwd: root, encoding: 'utf8', env: ENV, timeout: 300000 })),
  };
}

function newJob(root, policy) {
  if (policy) fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify(policy));
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  return J;
}

function toBuild(root, policy) {
  const J = newJob(root, policy);
  F.clarify(root);
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  F.cli(root, ['next']);
  const b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 't', claims: [], unknowns: [] }], degraded: [] }));
  F.cli(root, ['next']);
  F.cli(root, ['plan', 'from-contract']);
  return J;
}

function amendPlan(root, J) {
  F.cli(root, ['amend', 'start', '--reason', 'T1 may touch the README too', '--by', 'user']);
  const pf = path.join(F.jobDir(root, J), 'plan.json');
  const plan = JSON.parse(fs.readFileSync(pf, 'utf8'));
  plan.tasks[0].allowed_paths.push('README.md');
  fs.writeFileSync(pf, JSON.stringify(plan, null, 2));
  return F.cli(root, ['amend', 'submit']);
}

// ------------------------------------------------------------------------------ M1

test('M1: the guard reads flags with the CLI\'s own boolean-flag list, so a flag before the verb never hides a human-only command', () => {
  const G = require('../hooks/guard-rules');
  const main = require('../cli/main');
  assert.equal(G.CLI_BOOL, main.BOOL, 'one list, shared');
  assert.deepEqual([...G.CLI_BOOL].sort(), [...main.BOOL].sort());
  // every boolean flag, in front of a human-only verb: refused (main session) …
  for (const flag of main.BOOL) {
    assert.ok(G.checkBash('/tmp', `factory --${flag} approve H1`, null, { agent: false }), `--${flag} approve H1`);
    assert.ok(G.checkBash('/tmp', `factory --${flag} resume`, null, { agent: false }), `--${flag} resume`);
  }
  // … and in front of a driving verb for a factory agent
  for (const c of ['factory --detach next', 'factory --detached-child ship', 'factory --proposed run realize', 'factory --none drive']) assert.ok(G.checkBash('/tmp', c, null, { agent: true }), c);
  // the CLI parses them the same way
  assert.deepEqual(main.parseArgs(['--detach', 'approve', 'H1']).pos, ['approve', 'H1']);
  // a value flag still takes its value
  assert.equal(G.checkBash('/tmp', 'factory --job J-0001 next', null, { agent: false }), null);
});

// ------------------------------------------------------------------------------ M2, M3

test('M2: an amendment can be approved (or denied) only once the router presented gate A, also on an active job', () => {
  const root = F.makeRepo();
  const J = toBuild(root);
  F.cli(root, ['next']);
  amendPlan(root, J);
  assert.equal(stateOf(root, J).status, 'active');
  assert.throws(() => F.reply(root, 'approve'), /no gate waiting/, 'not before factory next presents it');
  assert.throws(() => F.reply(root, 'deny no'), /no gate waiting/);
  assert.equal(stateOf(root, J).amendment.status, 'submitted', 'nothing changed');
  const n = F.cli(root, ['next']);
  assert.deepEqual([n.action, n.step], ['gate', 'A']);
  assert.match(F.reply(root, 'approve').message, /Approved A/);
});

test('M3: approving an amendment on a parked job does what resume does: a budget park gets its 50% more, a review-rounds park one more round', () => {
  const root = F.makeRepo();
  const J = toBuild(root);
  F.cli(root, ['next']);
  const before = stateOf(root, J).policy.limits.max_agent_runs_per_job;
  core('decision-table').park(root, core('job').load(root, J), 'Agent-run budget used up', 'budget');
  amendPlan(root, J);
  assert.equal(F.cli(root, ['next']).step, 'A');
  const r = F.reply(root, 'approve');
  assert.equal(r.resumed, true);
  const st = stateOf(root, J);
  assert.equal(st.status, 'active');
  assert.equal(st.policy.limits.max_agent_runs_per_job, Math.ceil(before * 1.5), 'the budget was raised as resume raises it');
  assert.deepEqual([st.resumed.from, st.resumed.via], ['budget', 'amendment']);
  const resumes = core('decisions').forJob(root, J).filter((d) => d.action === 'human.resume');
  assert.equal(resumes.length, 1);
  // the same rule for review rounds: one more round
  const root2 = F.makeRepo();
  const J2 = toBuild(root2);
  F.cli(root2, ['next']);
  const s2 = core('job').load(root2, J2);
  s2.counters.review_rounds = s2.policy.limits.max_review_rounds + 1;
  core('job').save(root2, s2);
  core('decision-table').park(root2, core('job').load(root2, J2), 'Review rounds used up', 'review');
  amendPlan(root2, J2);
  F.cli(root2, ['next']);
  F.reply(root2, 'approve');
  assert.equal(stateOf(root2, J2).counters.review_rounds, stateOf(root2, J2).policy.limits.max_review_rounds - 1);
});

// ------------------------------------------------------------------------------ M4

test('M4: drive liveness: a live drive on this host is alive however old its heartbeat (a laptop that slept); another host\'s counts only by its heartbeat; stop never signals another host\'s pid', () => {
  const D = core('drive');
  const host = os.hostname();
  const old = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const now = new Date().toISOString();
  // 0.8.1: the recorded process start time says it is this process (pid reuse: fix081.test.js)
  assert.equal(D.alive({ pid: process.pid, pid_start: D.procStart(process.pid), host, status: 'running', heartbeat_at: old }), process.platform !== 'win32', 'this process, heartbeat a week old');
  assert.equal(D.alive({ pid: 999999, host, status: 'running', heartbeat_at: now }), false, 'a gone pid');
  assert.equal(D.alive({ pid: 999999, host: 'old-container', status: 'running', heartbeat_at: old }), false, 'another host, stale');
  assert.equal(D.alive({ pid: 999999, host: 'other-box', status: 'running', heartbeat_at: now }), true, 'another host, fresh heartbeat');
  assert.equal(D.alive({ pid: process.pid, host, status: 'stopped', heartbeat_at: now }), false);
  const root = F.makeRepo();
  const J = newJob(root);
  fs.writeFileSync(path.join(root, '.factory', 'drive.json'), JSON.stringify({ pid: process.pid, host: 'other-box', job: J, status: 'running', started_at: now, heartbeat_at: now }));
  const r = D.stopDrive(root);
  assert.equal(r.stopped, false);
  assert.match(r.message, /started on other-box[\s\S]*not signalled/);
  // a stale other-host record does not hold the repo
  fs.writeFileSync(path.join(root, '.factory', 'drive.json'), JSON.stringify({ pid: process.pid, host: 'old-container', job: J, status: 'running', started_at: old, heartbeat_at: old }));
  assert.notEqual(F.cli(root, ['next']).action, 'driving');
});

test('M4: a drive that lost drive.json to another drive stops at its next step without writing over the new owner\'s record', async () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const h = harness({ script: `const crew = require(${JSON.stringify(CREW)});\nmodule.exports = async (c) => { if (c.role === 'interviewer') await new Promise((r) => setTimeout(r, 3000)); return crew(c); };\n` });
  const d = h.cli(root, ['drive', '--detach']);
  assert.equal(d.detached, true, JSON.stringify(d));
  const file = path.join(root, '.factory', 'drive.json');
  // another drive "takes over" while this one is in its first clarify run (a live process of ours)
  const other = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
  try {
    await sleep(800);
    const taken = { ...JSON.parse(fs.readFileSync(file, 'utf8')), pid: other.pid, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(taken));
    for (let i = 0; i < 150; i++) {
      try {
        process.kill(d.pid, 0);
      } catch {
        break;
      }
      await sleep(100);
    }
    let gone = false;
    try {
      process.kill(d.pid, 0);
    } catch {
      gone = true;
    }
    assert.ok(gone, 'the old drive exited');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.pid, other.pid, 'the new owner\'s record is untouched');
    assert.equal(after.status, 'running');
    assert.ok(events(root).some((e) => e.event === 'drive_superseded' && e.pid === d.pid));
    assert.ok(!events(root).some((e) => e.event === 'drive_stop' && e.pid === d.pid && e.kind !== 'superseded'), 'it recorded no stop of its own');
  } finally {
    other.kill();
  }
  assert.equal(stateOf(root, J).status, 'active');
});

// ------------------------------------------------------------------------------ M5

test('M5: no attempt starts or retries while an integration\'s checks run or a failed integration is being repaired (except the repair), and attempts stay within max_parallel_tasks', async () => {
  const U = 20;
  const mk = (id, deps = []) => ({ id, depends_on: deps, retry_limit: 3, builder: { agent_type: 'factory:builder', escalate: [] }, builder_prompt: `build ${id} #{{attempt}}\n{{failures}}` });
  // A fast, B slow, C waits for a slot; A's first integration fails and is routed back to A; C fails its first verify (a retry)
  const brief = { workflow: 'realize', job: 'J-1', input_hash: 'x', max_parallel_tasks: 2, builder_schema: {}, integrate_each_wave: true, tasks: { A: mk('A'), B: mk('B'), C: mk('C') }, waves: [['A', 'B', 'C']] };
  const dur = { A: 1, B: 12, C: 3 };
  const t0 = Date.now();
  const at = () => (Date.now() - t0) / U;
  const attempts = [];
  const integrations = [];
  let live = 0;
  let peak = 0;
  let aIntegrations = 0;
  let cVerifies = 0;
  const { result } = await H.run(REALIZE, brief, async (prompt, o) => {
    const id = o.label.split(' ')[1];
    live += 1;
    peak = Math.max(peak, live);
    const s = at();
    await sleep(dur[id] * U);
    live -= 1;
    attempts.push({ id, s, e: at(), label: o.label });
    return { status: 'done', summary: 'ok', swept: [] };
  }, {
    verify: async (id) => {
      if (id === 'C') cVerifies += 1;
      return { task: id, pass: !(id === 'C' && cVerifies === 1), failures: [{ cmd: 'npm test', code: 1, output: 'C fails once' }] };
    },
    integrate: async (ids) => {
      const s = at();
      await sleep(6 * U);
      const fail = ids.includes('A') && aIntegrations++ === 0;
      integrations.push({ ids, s, e: at(), ok: !fail });
      return fail ? { ok: false, kind: 'commands', failures: [{ cmd: 'npm test', code: 1 }], route: { A: [{ cmd: 'npm test', code: 1, output: 'A broke it' }] } } : { ok: true, route: {} };
    },
  });
  assert.equal(result.status, 'ok', JSON.stringify(result.data));
  const failed = integrations.find((x) => !x.ok);
  const repairOk = integrations.find((x) => x.ok && x.ids.includes('A') && x.s >= failed.e);
  assert.ok(failed && repairOk, JSON.stringify(integrations));
  // during any integration's checks, no attempt started
  for (const ig of integrations) for (const a of attempts) assert.ok(!(a.s > ig.s + 0.2 && a.s < ig.e - 0.2), `${a.label} started at ${a.s.toFixed(1)} during the integration of ${ig.ids} (${ig.s.toFixed(1)}–${ig.e.toFixed(1)})`);
  // between the failed integration and its repair's success, only A (the repair) made attempts
  for (const a of attempts) if (a.s > failed.s && a.s < repairOk.e) assert.equal(a.id, 'A', `${a.label} at ${a.s.toFixed(1)} built on a broken integration`);
  assert.ok(peak <= 2, `attempts at once within the cap (peak ${peak})`);
});

test('M5: a task starts from the job branch as last integrated green; one reopened to repair an integration starts from the job branch itself', () => {
  const root = F.makeRepo();
  const J = toBuild(root);
  const T = core('tasks');
  const job = core('job');
  const st = job.load(root, J);
  const jw = T.ensureJobWorktree(root, st);
  const green = F.sh(jw, 'git rev-parse HEAD');
  F.write(jw, 'src/broken.js', 'syntax error here\n');
  F.sh(jw, 'git add -A && git commit -qm "a merge whose checks failed"');
  const s2 = job.load(root, J);
  s2.integration_green = green;
  job.save(root, s2);
  assert.equal(T.startBase(root, job.load(root, J), 'T1'), green);
  const r = F.cli(root, ['task', 'start', 'T1']);
  assert.ok(!r.code, JSON.stringify(r));
  assert.ok(!fs.existsSync(path.join(r.worktree, 'src/broken.js')), 'the unchecked merge is not in the task branch');
  const s3 = job.load(root, J);
  s3.tasks.T1 = { ...s3.tasks.T1, needs_work: 'integration' };
  job.save(root, s3);
  assert.equal(T.startBase(root, job.load(root, J), 'T1'), s3.branch, 'a repair sees the merge it fixes');
});

// ------------------------------------------------------------------------------ M6

test('M6: the start skill starts the drive in the background and waits under the tool limit; an interrupted drive is restarted, not a stop', () => {
  const s = fs.readFileSync(path.join(F.PLUGIN, 'skills', 'start', 'SKILL.md'), 'utf8');
  const loop = s.slice(s.indexOf('## The loop'), s.indexOf('## Without'));
  assert.match(loop, /Start it in the background: `factory drive --detach`[\s\S]*`factory drive status --wait 240`/);
  assert.match(loop, /Don't run `factory drive` in the foreground/);
  assert.match(loop, /\| `interrupted` \| [^\n]*`factory drive --detach`[^\n]*\| step 1 \|/);
  assert.ok(!/longest timeout/.test(loop));
});

// ------------------------------------------------------------------------------ M7

test('M7: transient means Copilot\'s own error line with an HTTP status in context, a rate limit or a network drop; never a number, a reply or a local service', () => {
  const t = (stderr, stdout = '') => core('runner').transient({ code: 1, stderr, stdout });
  assert.equal(t('Error: Request failed with status code 429 (Too Many Requests)'), 'status code 429');
  assert.equal(t('Error: 503 Service Unavailable'), '503 Service Unavailable');
  assert.equal(t('CAPIError: HTTP 502 from the model endpoint'), 'HTTP 502');
  assert.equal(t('error: rate limit exceeded for this model'), 'rate limit exceeded');
  assert.equal(t('TypeError: fetch failed'), 'fetch failed');
  assert.equal(t('Tokens used: 1,429 input'), null);
  assert.equal(t('Error: connect ECONNREFUSED 127.0.0.1:5432'), null, 'a local service is the agent\'s problem');
  assert.equal(t('', 'I implemented the rate limiting middleware (HTTP 503 on overload)'), null, 'stdout is the agent');
  assert.equal(t('  "summary": "added retry on 429"'), null);
  assert.equal(t('note: 500 lines changed'), null);
  assert.equal(core('runner').transient({ code: 1, timedOut: true, stderr: 'Error: status 429' }), null);
});

test('M7: a transient failure that persists across reruns parks the job (kind transient) after copilot.transient_park_after runs; the drive then stops parked; resume counts afresh', () => {
  const root = F.makeRepo();
  const J = toBuild(root, { copilot: { transient_backoff_seconds: 0.01, transient_retries: 1, transient_park_after: 2 } });
  const h = harness({ script: `const crew = require(${JSON.stringify(CREW)});\nmodule.exports = (c) => (c.role === 'builder' ? { exit: 1, stderr: 'Error: Request failed with status code 429 (Too Many Requests)' } : crew(c));\n` });
  const s1 = h.drive(root);
  assert.equal(s1.kind, 'transient', JSON.stringify(s1));
  assert.equal(s1.__code, 1, 'a failure stop exits 1');
  assert.equal(stateOf(root, J).transient_aborts, 1);
  assert.equal(stateOf(root, J).status, 'active');
  const s2 = h.drive(root);
  assert.equal(s2.kind, 'parked', JSON.stringify(s2));
  assert.equal(s2.park.kind, 'transient');
  assert.match(s2.summary, /2 runs in a row/);
  assert.equal(stateOf(root, J).tasks.T1 ? stateOf(root, J).tasks.T1.attempts || 0 : 0, 0, 'no attempt spent on any of it');
  F.reply(root, 'resume');
  assert.equal(stateOf(root, J).transient_aborts, undefined);
});

// ------------------------------------------------------------------------------ minors

test('policy.drive.stop_before_ship: the drive stops (kind ship) before factory ship instead of running it; off by default', () => {
  const root = F.makeRepo();
  const J = newJob(root, { drive: { stop_before_ship: true } });
  const h = harness();
  let s;
  for (let i = 0; i < 6; i++) {
    s = h.drive(root);
    if (s.kind === 'clarify') F.cli(root, ['clarify', 'reply', 'ok']);
    else if (s.kind === 'gate') F.reply(root, 'approve');
    else break;
  }
  assert.equal(s.kind, 'ship', JSON.stringify(s).slice(0, 400));
  assert.match(s.summary, /ready to ship[\s\S]*stop_before_ship/);
  assert.ok(!events(root).some((e) => e.event === 'cli' && e.cmd === 'ship'), 'nothing was pushed or merged');
  assert.ok(!stateOf(root, J).pr, 'no PR or local merge prepared');
  assert.equal(JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'policy', 'default-policy.json'), 'utf8')).drive.stop_before_ship, false);
});

test('a rerun that stops at the same gate notifies once; a failure stop exits 1; a human stop exits 0', () => {
  const root = F.makeRepo();
  newJob(root);
  const h = harness({ env: { FACTORY_NOTIFY: '' } });
  const a = h.drive(root);
  const b = h.drive(root);
  assert.equal(a.kind, 'clarify');
  assert.equal(a.__code, 0);
  assert.equal(b.kind, 'clarify');
  assert.equal(b.notified, 'repeat', 'the same read-back again: no second notification');
  const nt = events(root).filter((e) => e.event === 'notify');
  assert.equal(nt.length, 1);
  const root2 = F.makeRepo();
  newJob(root2);
  const u = harness({ env: { COPILOT_BIN: path.join(os.tmpdir(), 'no-such-copilot-bin') } }).drive(root2);
  assert.equal(u.kind, 'copilot_unavailable');
  assert.equal(u.__code, 1);
});

test('the drive records doc evidence only for a file the criterion names (a lone CHANGELOG is not the README)', () => {
  const root = F.makeRepo();
  const J = toBuild(root);
  const D = core('drive');
  const jp = F.jobDir(root, J);
  const c = fs.readFileSync(path.join(jp, 'contract.md'), 'utf8').replace(/- AC-1: [^\n]*/, '- AC-1: add(2, 3) returns 5 and the README documents add (evidence: test)');
  fs.writeFileSync(path.join(jp, 'contract.md'), c);
  const st = core('job').load(root, J);
  const s = F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
  F.write(s.worktree, 'CHANGELOG.md', '- add fixed\n');
  F.sh(s.worktree, 'git add -A && git commit -qm log');
  const jw = core('tasks').ensureJobWorktree(root, st);
  F.sh(jw, `git merge -q --no-ff -m m ${core('steps').taskBranch(st, 'T1')}`);
  // plan.json's T1 covers AC-1 and allows CHANGELOG.md? from-contract allows src/**, tests/**: widen for the probe
  const pf = path.join(jp, 'plan.json');
  const plan = JSON.parse(fs.readFileSync(pf, 'utf8'));
  plan.tasks[0].allowed_paths.push('CHANGELOG.md', 'README.md');
  fs.writeFileSync(pf, JSON.stringify(plan));
  assert.equal(D.evidencePath(root, J, 'AC-1', 'doc'), null, 'CHANGELOG.md is not named by AC-1');
  F.write(s.worktree, 'README.md', '# tiny\n\nadd(a, b) sums.\n');
  F.sh(s.worktree, 'git rm -q CHANGELOG.md && git add -A && git commit -qm readme');
  F.sh(jw, `git merge -q --no-ff -m m2 ${core('steps').taskBranch(st, 'T1')}`);
  assert.deepEqual(D.evidencePath(root, J, 'AC-1', 'doc'), { path: 'README.md', tasks: ['T1'] });
});
