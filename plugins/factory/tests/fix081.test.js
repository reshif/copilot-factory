'use strict';
// 0.8.1 fixes, from the review of the claude-factory port of the same features
// (P34-PORT-REVIEW.md): M2 drive liveness under pid reuse and a stale record `drive stop` clears,
// M1 a step killed twice by a shell tool's time limit (step_too_long), M3 judgement roles on the
// session default model, M4 the agent ban on driving the job (guard: substitutions and script
// files; CLI: process ancestry), the minors (drive refuses human-only verbs, inbox gate A only once
// presented, a drive rerun's park counted once, the proposals file locked), and B1 (a scheduled
// Copilot CLI prompt is never a reply).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const F = require('./helpers/fixture');

const FAKE = path.join(__dirname, 'helpers', 'fake-copilot.js');
const CREW = path.join(__dirname, 'helpers', 'crew.js');
const core = (m) => require(`../cli/core/${m}`);
const driveJson = (root) => path.join(root, '.factory', 'drive.json');
const readDrive = (root) => JSON.parse(fs.readFileSync(driveJson(root), 'utf8'));
const events = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NO_COPILOT = { COPILOT_BIN: path.join(os.tmpdir(), 'no-such-copilot-bin'), FACTORY_NOTIFY: 'off' };

function newJob(root) {
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  return J;
}

// ------------------------------------------------------------------------------ M2

test('M2: same-host liveness needs the recorded process start time: a reused pid is dead whatever it runs; no reliable check falls back to the heartbeat; another host stays heartbeat-only', () => {
  const D = core('drive');
  const host = os.hostname();
  const old = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const now = new Date().toISOString();
  const me = D.procStart(process.pid);
  if (process.platform === 'linux') assert.match(String(me), /^stat:\d+$/);
  if (me) {
    assert.equal(D.alive({ pid: process.pid, pid_start: me, host, status: 'running', heartbeat_at: old }), true, 'the drive itself, heartbeat a week old (a laptop that slept)');
    assert.equal(D.alive({ pid: process.pid, pid_start: `${me}0`, host, status: 'running', heartbeat_at: now }), false, 'same pid, another start time: a reused pid, even a node one with a fresh heartbeat');
  }
  // a record without pid_start (0.8.0) or where nothing reliable can tell: the heartbeat decides
  assert.equal(D.alive({ pid: process.pid, host, status: 'running', heartbeat_at: old }), false, 'a live node pid with a week-old heartbeat and no start time is not that drive');
  assert.equal(D.alive({ pid: process.pid, host, status: 'running', heartbeat_at: now }), true);
  assert.equal(D.alive({ pid: 999999, host, status: 'running', heartbeat_at: now, pid_start: 'stat:1' }), false, 'a gone pid');
  assert.equal(D.alive({ pid: 999999, host: 'old-container', status: 'running', heartbeat_at: old }), false);
  assert.equal(D.alive({ pid: 999999, host: 'other-box', status: 'running', heartbeat_at: now }), true, 'another host: a fresh heartbeat');
});

test('M2: a drive records its start time; a stale record held by a reused pid does not lock the repo, and factory drive stop clears it without signalling that process', async () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const r = F.cli(root, ['drive'], { env: NO_COPILOT });
  assert.equal(r.kind, 'copilot_unavailable', JSON.stringify(r).slice(0, 400));
  const st = readDrive(root);
  if (process.platform !== 'win32') assert.ok(st.pid_start, 'pid_start recorded');
  // the pid now belongs to an unrelated node process (pid reuse), the record still says running
  const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
  try {
    await sleep(200);
    fs.writeFileSync(driveJson(root), JSON.stringify({ ...st, pid: other.pid, status: 'running', heartbeat_at: new Date().toISOString(), step: 'run review' }));
    assert.notEqual(F.cli(root, ['next']).action, 'driving', 'a reused pid does not hold the job');
    assert.equal(F.cli(root, ['drive', 'status']).status, 'crashed');
    const s = F.cli(root, ['drive', 'stop']);
    assert.equal(s.cleared, true, JSON.stringify(s));
    assert.equal(s.stopped, false);
    assert.equal(other.exitCode, null, 'the unrelated process was not signalled');
    assert.equal(process.kill(other.pid, 0), true);
    assert.equal(readDrive(root).status, 'stopped');
    assert.ok(events(root).some((e) => e.event === 'drive_cleared' && e.pid === other.pid));
    assert.equal(F.cli(root, ['drive', 'status']).status, 'stopped');
    assert.equal(J, readDrive(root).job);
  } finally {
    other.kill();
  }
});

// ------------------------------------------------------------------------------ M1

test('M1: the step two drives in a row were killed in is not started a third time (step_too_long); the count starts again after that stop', () => {
  const D = core('drive');
  // the count, from the previous record
  assert.deepEqual(D.killedIn({ pid: 5, status: 'running', step: 'verify run', detached: true }), { pid: 5, started_at: undefined, step: 'verify run', kills: 1, detached: true });
  assert.equal(D.killedIn({ pid: 5, status: 'running', step: 'verify run', recovered_from: { step: 'verify run', kills: 1 } }).kills, 2);
  assert.equal(D.killedIn({ pid: 5, status: 'running', step: 'ci verify', recovered_from: { step: 'verify run', kills: 3 } }).kills, 1, 'another step: the count starts again');
  assert.equal(D.killedIn({ pid: 5, status: 'stopped', detached: false, last: { kind: 'interrupted', in_step: 'verify run' }, recovered_from: { step: 'verify run', kills: 1 } }).kills, 2, 'a foreground drive a signal stopped mid-step counts');
  assert.equal(D.killedIn({ pid: 5, status: 'stopped', detached: true, last: { kind: 'interrupted', in_step: 'verify run' } }), null, 'factory drive stop on a detached drive is not a kill');
  assert.equal(D.killedIn({ pid: 5, status: 'stopped', last: { kind: 'gate' } }), null);
  assert.equal(D.killedIn({ pid: 5, status: 'running', step: 'next' }), null);

  const root = F.makeRepo();
  const J = newJob(root);
  const host = os.hostname();
  const dead = { pid: 999999, pid_start: 'stat:1', host, job: J, status: 'running', started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), detached: false, step: 'run clarify' };
  // killed once in "run clarify": the rerun runs it (and here stops on the missing Copilot)
  fs.mkdirSync(path.dirname(driveJson(root)), { recursive: true });
  fs.writeFileSync(driveJson(root), JSON.stringify(dead));
  assert.equal(F.cli(root, ['drive'], { env: NO_COPILOT }).kind, 'copilot_unavailable');
  // killed twice in a row in it: not started again
  fs.writeFileSync(driveJson(root), JSON.stringify({ ...dead, recovered_from: { pid: 999998, step: 'run clarify', kills: 1 } }));
  const r = F.cli(root, ['drive'], { env: NO_COPILOT });
  assert.equal(r.kind, 'step_too_long', JSON.stringify(r).slice(0, 400));
  assert.equal(r.__code, 1);
  assert.equal(r.in_step, 'run clarify');
  assert.equal(r.kills, 2);
  assert.match(r.summary, /killed 2 times in a row during "run clarify"[\s\S]*factory drive --detach/);
  assert.equal(r.command, 'factory drive --detach');
  assert.ok(events(root).some((e) => e.event === 'drive_stop' && e.kind === 'step_too_long'));
  assert.ok(!events(root).some((e) => e.event === 'cli' && e.cmd === 'run' && e.via === 'drive' && e.ts > r.at), 'nothing was started');
  // after that stop the next drive runs the step again (the user asked for it)
  assert.equal(F.cli(root, ['drive'], { env: NO_COPILOT }).kind, 'copilot_unavailable');
  // the inbox and distill's trouble list know the kind
  assert.ok(core('lifecycle').troubleOf);
});

test('M1: a foreground drive stopped by a signal mid-step records the step it was in (in_step), so the next drive counts it', async () => {
  const root = F.makeRepo();
  newJob(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-081-'));
  const script = path.join(dir, 'script.js');
  fs.writeFileSync(script, `const crew = require(${JSON.stringify(CREW)});\nmodule.exports = async (c) => { if (c.role === 'interviewer') await new Promise((r) => setTimeout(r, 20000)); return crew(c); };\n`);
  const env = { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: FAKE, FAKE_COPILOT_SCRIPT: script, FAKE_COPILOT_LOG: path.join(dir, 'copilot.jsonl'), FACTORY_NOTIFY: 'off' };
  const d = spawn(process.execPath, [F.BIN, 'drive'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  d.stdout.on('data', (x) => (out += x));
  try {
    let st = null;
    for (let i = 0; i < 200; i++) {
      await sleep(100);
      try {
        st = readDrive(root);
      } catch {
        st = null;
      }
      if (st && st.step === 'run clarify') break;
    }
    assert.equal(st && st.step, 'run clarify', 'the drive is in its clarify run');
    await sleep(500);
    d.kill('SIGTERM');
    await new Promise((r) => d.on('close', r));
    assert.ok(out !== null);
    const after = readDrive(root);
    assert.equal(after.last.kind, 'interrupted');
    assert.equal(after.last.in_step, 'run clarify');
    assert.equal(core('drive').killedIn(after).kills, 1);
  } finally {
    if (d.exitCode === null) d.kill('SIGKILL');
  }
});

// ------------------------------------------------------------------------------ M3

test('M3: judgement roles run on the session default model; only the interviewer and the sweep check get the fast tier; the builder still escalates on attempt 3; a 0.8.0 snapshot is read the new way', () => {
  const W = core('wfargs');
  const pol = core('policy').defaults();
  assert.equal(pol.agents.models_profile, 'session-default');
  assert.deepEqual(pol.agents.models, { interviewer: 'haiku', 'sweep-check': 'haiku' });
  const judgement = ['finding-verifier', 'security-reviewer', 'code-reviewer', 'test-reviewer', 'ux-reviewer', 'epic-reviewer', 'researcher', 'god-eye', 'architect', 'contract-writer', 'builder', 'planner', 'slicer', 'option-generator', 'threat-modeler', 'integrator', 'brief-writer', 'lesson-writer', 'tester'];
  for (const r of judgement) assert.equal(W.roleModel(pol, r), null, `${r}: no --model`);
  assert.equal(W.roleModel(pol, 'interviewer'), 'haiku');
  const state = { policy: pol };
  assert.equal(W.agentSpec(state, 'finding-verifier').model, undefined);
  assert.equal(W.sweepSpec(state).model, 'haiku');
  assert.equal(W.sweepSpec(state).agent_type, 'factory:tester');
  const b = W.builderSpec(state);
  assert.equal(b.model, undefined);
  assert.deepEqual(b.escalate, ['opus']);
  assert.equal(b.escalate_from, 3);
  // a job created under 0.8.0: its snapshot holds the old tiers and no models_profile
  const legacy = { ...pol, agents: { ...pol.agents, models: { ...W.LEGACY_080 } } };
  delete legacy.agents.models_profile;
  for (const r of judgement) assert.equal(W.roleModel(legacy, r), null, `${r} (0.8.0 snapshot)`);
  assert.equal(W.roleModel(legacy, 'interviewer'), 'haiku');
  // a project's own choice (a new snapshot carries models_profile) is kept, and off still wins
  const own = { ...pol, agents: { ...pol.agents, models: { ...pol.agents.models, researcher: 'sonnet' } } };
  assert.equal(W.roleModel(own, 'researcher'), 'sonnet');
  assert.equal(W.roleModel({ ...own, agents: { ...own.agents, models_enabled: false } }, 'interviewer'), null);
});

test('M3: factory doctor says every other role runs on the session default and names judgement roles a project pinned to a model', () => {
  const root = F.makeRepo();
  const fakeV = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-081-')), 'copilot.js');
  fs.writeFileSync(fakeV, '#!/usr/bin/env node\nconsole.log("GitHub Copilot CLI 1.0.99");\n');
  fs.chmodSync(fakeV, 0o755);
  const find = (r) => (r.checks || r.results || []).find((c) => c.name === 'copilot models') || JSON.stringify(r).match(/copilot models[^}]*/);
  const d1 = F.cli(root, ['doctor'], { env: { COPILOT_BIN: fakeV } });
  assert.match(JSON.stringify(find(d1)), /interviewer, sweep-check[\s\S]*every other role: your Copilot session default model[\s\S]*attempt 3\+: claude-opus-5\.5/);
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ agents: { models: { 'finding-verifier': 'haiku' } } }));
  const d2 = F.cli(root, ['doctor'], { env: { COPILOT_BIN: fakeV } });
  assert.match(JSON.stringify(find(d2)), /pins judgement roles[\s\S]*finding-verifier \(claude-haiku-5\.5\)/);
});

// ------------------------------------------------------------------------------ M4

test('M4: the guard reads a factory agent\'s script files and refuses a subcommand built at run time; human-only verbs stay blocked for everyone', () => {
  const g = require('../hooks/guard-rules');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-081-g-'));
  fs.writeFileSync(path.join(dir, 'run.sh'), 'echo hi\nfactory drive\n');
  fs.writeFileSync(path.join(dir, 'x'), '#!/usr/bin/env bash\nfactory clarify reply ok\n');
  fs.writeFileSync(path.join(dir, 'ok.sh'), 'factory task show T1\n');
  const agent = (c) => g.checkBash(dir, c, null, { agent: true, cwd: dir });
  const main = (c) => g.checkBash(dir, c, null, { agent: false, cwd: dir });
  for (const c of ['echo drive | xargs factory', 'xargs factory < f.txt', 'parallel factory ::: drive', 'factory "$(echo drive)"', 'factory $(printf drive)', 'factory `echo inbox`', 'factory "$(echo clarify)" reply ok', 'factory $SUB', 'sh run.sh', 'bash ./run.sh', 'source run.sh', '. run.sh', './x', 'factory drive', 'factory inbox', 'factory answer --question q --answer a', 'factory clarify reply ok']) {
    assert.ok(agent(c), `agent: ${c} is refused`);
  }
  assert.equal(agent('sh ok.sh'), null);
  assert.equal(agent('factory task show T1'), null);
  // the main session drives the job; it may not hide a verb behind a substitution
  assert.equal(main('factory drive'), null);
  assert.equal(main('sh run.sh'), null);
  assert.match(main('factory "$(echo approve)"'), /command substitution/);
  for (const c of ['factory approve', 'factory env set --confirm x', 'factory ci install', 'echo approve | xargs factory', 'factory lessons accept L1']) {
    assert.match(main(c), /human-only/, c);
    assert.ok(agent(c), c);
  }
});

test('M4: the CLI refuses a factory agent the driving verbs even when a script unset FACTORY_RUNNER: it finds the agent process in its ancestry', () => {
  const root = F.makeRepo();
  newJob(root);
  const env = { ...process.env, FACTORY_ROOT: '', FACTORY_NOTIFY: 'off', COPILOT_BIN: NO_COPILOT.COPILOT_BIN };
  for (const k of ['FACTORY_RUNNER', 'FACTORY_AGENT_ROLE', 'FACTORY_AGENT_LABEL']) delete env[k];
  const childCode = (args) => `const r = require('child_process').spawnSync(process.execPath, ${JSON.stringify([F.BIN, ...args])}, { cwd: ${JSON.stringify(root)}, encoding: 'utf8', env: (() => { const e = { ...process.env }; for (const k of ['FACTORY_RUNNER', 'FACTORY_AGENT_ROLE', 'FACTORY_AGENT_LABEL']) delete e[k]; return e; })() }); process.stdout.write(r.stdout);`;
  const via = (args, extraArgv, extraEnv = {}) => {
    const r = spawnSync(process.execPath, ['-e', childCode(args), '--', ...extraArgv], { cwd: root, encoding: 'utf8', env: { ...env, ...extraEnv } });
    try {
      return JSON.parse(r.stdout);
    } catch {
      return { raw: r.stdout, stderr: r.stderr };
    }
  };
  if (process.platform === 'win32') return;
  // the parent looks like `copilot -p … --agent factory:tester`
  for (const args of [['drive'], ['inbox'], ['answer', '--question', 'q', '--answer', 'a'], ['clarify', 'reply', 'ok'], ['next'], ['approve']]) {
    const r = via(args, ['-p', 'x', '--agent', 'factory:tester']);
    assert.equal(r.code, 'agent_not_allowed', `${args.join(' ')}: ${JSON.stringify(r).slice(0, 300)}`);
  }
  // the parent was started with FACTORY_RUNNER=1 (fixed in its environment at exec)
  if (fs.existsSync('/proc/self/environ')) assert.equal(via(['drive', 'status'], [], { FACTORY_RUNNER: '1' }).code, 'agent_not_allowed');
  // what an agent is briefed to run still works there, and the main session is not affected
  assert.equal(via(['job', 'list'], ['--agent', 'factory:tester']).code, undefined);
  assert.notEqual(via(['drive', 'status'], ['--agent', 'other']).code, 'agent_not_allowed');
  const A = require('../cli/lib/agent-ancestry');
  assert.equal(A.factoryAgentAncestor(), null, 'the test runner has no factory agent above it');
});

// ------------------------------------------------------------------------------ minors

test('minor: the drive never runs a human-only verb, from the same list as the guard (env set and ci install included)', () => {
  const H = require('../cli/lib/human-verbs');
  for (const [a, b] of [['approve'], ['resume'], ['env', 'set'], ['ci', 'install'], ['lessons', 'accept'], ['confirm', 'AC-1'], ['merged', 'abc']]) assert.equal(H.isHumanOnly(a, b), true, `${a} ${b || ''}`);
  for (const [a, b] of [['ci', 'verify'], ['env', 'show'], ['verify', 'run'], ['close']]) assert.equal(H.isHumanOnly(a, b), false, `${a} ${b || ''}`);
  assert.equal(require('../hooks/guard-rules').HUMAN_ONLY, H.HUMAN_ONLY, 'the guard reads the shared list');
  const src = fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'drive.js'), 'utf8');
  assert.match(src, /case 'cli': \{[\s\S]{0,400}isHumanOnly\(w\[0\], w\[1\]\)[\s\S]{0,200}human_only/);
});

test('minor: the inbox offers gate A only once it is presented; before that it says the drive presents it', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const file = path.join(F.jobDir(root, J), 'state.json');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  s.amendment = { status: 'submitted', hash: 'h1', file: path.join(F.jobDir(root, J), 'amendment.json'), submitted_at: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(s));
  const before = core('inbox').list(root, { plain: true });
  const it = (before.items || before).find((x) => x.job === J);
  assert.equal(it.kind, 'amend', JSON.stringify(it));
  assert.ok(!(it.reply || []).includes('approve'));
  s.pending_gate = { id: 'A', hash: 'h1', docs: [], at: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(s));
  const after = core('inbox').list(root, { plain: true });
  const it2 = (after.items || after).find((x) => x.job === J);
  assert.equal(it2.kind, 'gate');
  assert.equal(it2.gate, 'A');
  assert.ok(it2.reply.includes('approve'));
});

test('minor: a drive rerun that stops at the same park again is the same park for distill (counted once)', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const ev = core('events');
  const t0 = Date.now();
  const at = new Date(t0 - 3600e3).toISOString();
  ev.append(root, { event: 'drive_stop', job: J, kind: 'parked', park_at: at, park_kind: 'cap', summary: 'parked (cap)', notified: 'desktop' });
  // reruns minutes later: once notified as a repeat, once with the same park_at
  const lines = fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8');
  const shift = (o, min) => JSON.stringify({ ...o, ts: new Date(t0 - 3600e3 + min * 60e3).toISOString() });
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), `${shift({ event: 'drive_stop', job: J, kind: 'parked', park_at: at, summary: 'parked (cap)', notified: 'repeat' }, 5)}\n${shift({ event: 'drive_stop', job: J, kind: 'parked', park_at: at, summary: 'parked (cap)', notified: 'desktop' }, 9)}\n`);
  assert.ok(lines.length > 0);
  const state = core('job').load(root, J);
  const tr = core('lifecycle').troubleOf(root, state);
  const parks = tr.parks.filter((p) => p.source === 'drive_stop');
  assert.equal(parks.length, 1, JSON.stringify(tr.parks));
  // a different park later is another one
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), `${shift({ event: 'drive_stop', job: J, kind: 'parked', park_at: new Date(t0 - 600e3).toISOString(), summary: 'parked again', notified: 'desktop' }, 50)}\n`);
  assert.equal(core('lifecycle').troubleOf(root, state).parks.filter((p) => p.source === 'drive_stop').length, 2);
});

test('minor: the project brief proposals file is written under its lock: concurrent distill proposals each get their own id', async () => {
  const root = F.makeRepo();
  const N = 6;
  const code = (i) => `require(${JSON.stringify(path.join(F.PLUGIN, 'cli', 'core', 'project-brief.js'))}).propose(${JSON.stringify(root)}, [{ section: 'Notes', add: ['note from job ${i}'] }], { job: 'J-000${i}', why: 'race' });`;
  const kids = Array.from({ length: N }, (_, i) => new Promise((r) => spawn(process.execPath, ['-e', code(i + 1)], { cwd: root, stdio: 'ignore', env: { ...process.env, FACTORY_ROOT: '' } }).on('close', r)));
  await Promise.all(kids);
  const doc = JSON.parse(fs.readFileSync(core('project-brief').proposalsFile(root), 'utf8'));
  assert.equal(doc.proposals.length, N);
  assert.deepEqual(doc.proposals.map((p) => p.id).sort(), Array.from({ length: N }, (_, i) => `P${i + 1}`).sort());
  assert.ok(!fs.existsSync(`${core('project-brief').proposalsFile(root)}.lock`));
});

// ------------------------------------------------------------------------------ B1

test('B1: a Copilot CLI scheduled prompt (/every, /after, /loop) is never applied as a reply; an ordinary scheduled prompt is left alone', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const hook = (prompt) => spawnSync(process.execPath, [path.join(F.PLUGIN, 'hooks', 'prompt.js'), 'userPromptSubmitted'], { input: JSON.stringify({ prompt, cwd: root, sessionId: 's', timestamp: 1 }), encoding: 'utf8', env: { ...process.env, FACTORY_RUNNER: '' } });
  const last = () => JSON.parse(fs.readFileSync(path.join(root, '.factory', 'last-reply.json'), 'utf8'));
  for (const p of ['[Scheduled prompt #4] approve', '[Scheduled prompt #12] resume', '[Scheduled prompt #1] cancel job', '[Scheduled prompt #3] ok', '[scheduled prompt #2]   accept brief P1']) {
    const r = hook(p);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(last().status, 'refused', p);
    assert.equal(last().code, 'scheduled_prompt', p);
    assert.match(r.stdout, /NOT applied as a reply/);
  }
  assert.ok(events(root).some((e) => e.event === 'reply_refused' && e.code === 'scheduled_prompt'));
  const state = core('job').load(root, J);
  assert.equal(state.status, 'active', 'cancel job was not applied');
  fs.rmSync(path.join(root, '.factory', 'last-reply.json'));
  const r = hook('[Scheduled prompt #5] run the test suite and summarise new failures');
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(path.join(root, '.factory', 'last-reply.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.factory', 'turn.json'), 'utf8')).scheduled, true);
  // a typed reply is still applied as before
  assert.equal(hook('approve').status, 0);
  assert.notEqual(last().code, 'scheduled_prompt');
});

// ------------------------------------------------------------------------------ ci install

test('ci install vendors every directory the CLI reads at run time: the copy starts and runs ci verify with no access to the plugin; doctor flags a broken or stale copy', () => {
  const ship = core('ship');
  // every plugin directory cli/ reads (pluginPath('x') / require('../../x')) is vendored, the console aside
  const used = new Set();
  const walkSrc = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walkSrc(p);
      else if (f.endsWith('.js')) for (const m of fs.readFileSync(p, 'utf8').matchAll(/pluginPath\('([a-z-]+)'|require\('\.\.\/\.\.\/([a-z-]+)[/'.]|PLUGIN_ROOT, '([a-z-]+)'/g)) used.add(m[1] || m[2] || m[3]);
    }
  };
  walkSrc(path.join(F.PLUGIN, 'cli'));
  used.delete('console');
  for (const d of used) if (fs.existsSync(path.join(F.PLUGIN, d)) && fs.statSync(path.join(F.PLUGIN, d)).isDirectory()) assert.ok(ship.VENDOR_DIRS.includes(d), `${d} is vendored`);
  for (const d of ['schemas', 'templates']) assert.ok(ship.VENDOR_DIRS.includes(d));

  const root = F.makeRepo();
  ship.ciInstall(root);
  // run the copy from somewhere the plugin is not: a fresh directory with only the vendored CLI
  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-081-ci-'));
  fs.cpSync(path.join(root, '.github', 'factory-cli'), path.join(away, 'factory-cli'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: away };
  const bin = path.join(away, 'factory-cli', 'bin', 'factory');
  const help = spawnSync(process.execPath, [bin, '--help'], { cwd: away, env, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  const ver = spawnSync(process.execPath, [bin, '--version'], { cwd: away, env, encoding: 'utf8' });
  assert.equal(JSON.parse(ver.stdout).version, JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'plugin.json'), 'utf8')).version);
  const mdir = path.join(away, '.factory-ship');
  fs.mkdirSync(mdir);
  fs.writeFileSync(path.join(mdir, 'J-0001.json'), JSON.stringify({ job: 'J-0001', commands: [{ cmd: `"${process.execPath}" -e "process.exit(0)"` }] }));
  const v = spawnSync(process.execPath, [bin, 'ci', 'verify', '--manifest-dir', mdir], { cwd: away, env, encoding: 'utf8' });
  assert.equal(v.status, 0, `${v.stdout}${v.stderr}`);
  assert.equal(JSON.parse(v.stdout).ok, true, v.stdout);
  // every runner module loads in the copy (the require that broke 0.8.0's: schemas/agent-outputs/lessons.json)
  const load = spawnSync(process.execPath, ['-e', `for (const m of ['runner','wfargs','ship','lifecycle','drive','decision-table']) require(${JSON.stringify(path.join(away, 'factory-cli', 'cli', 'core'))} + '/' + m)`], { cwd: away, env, encoding: 'utf8' });
  assert.equal(load.status, 0, load.stderr);
  for (const args of [['doctor'], ['ci', 'verify'], ['why']]) {
    const r = spawnSync(process.execPath, [bin, ...args], { cwd: away, env, encoding: 'utf8' });
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Cannot find module/, args.join(' '));
  }
  assert.equal(ship.vendoredStatus(root).ok, true);
  // a stale copy (a file changed) and a broken one (0.8.0's: no schemas)
  fs.appendFileSync(path.join(root, '.github', 'factory-cli', 'cli', 'core', 'ship.js'), '\n// local edit\n');
  const stale = ship.vendoredStatus(root);
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.match(stale.message, /factory ci install again in your own terminal/);
  fs.rmSync(path.join(root, '.github', 'factory-cli', 'schemas'), { recursive: true, force: true });
  const broken = ship.vendoredStatus(root);
  assert.equal(broken.broken, true, JSON.stringify(broken));
  assert.match(broken.message, /missing schemas[\s\S]*factory ci install again/);
  const doc = F.cli(root, ['doctor']);
  assert.match(JSON.stringify(doc), /ci cli[\s\S]*broken/);
  // a reinstall replaces it whole
  ship.ciInstall(root);
  assert.equal(ship.vendoredStatus(root).ok, true);
});

// ------------------------------------------------------------------------------ hook heartbeat (VS Code / WSL)

test('hooks: the launcher finds the plugin without any root variable (VS Code token, or the root the CLI recorded); every run leaves a heartbeat; doctor reports each hook and says when the guard is not enforcing', () => {
  const H = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'hooks.json'), 'utf8'));
  const root = F.makeRepo();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-081-u-'));
  const base = { PATH: process.env.PATH, HOME: userDir, FACTORY_USER_DIR: userDir };
  const deny = (r) => r.stdout && JSON.parse(r.stdout).permissionDecision === 'deny';
  const guardIn = JSON.stringify({ toolName: 'bash', toolArgs: { command: 'factory approve' }, cwd: root });
  const runIn = (bash, env) => spawnSync('bash', ['-c', bash], { cwd: root, input: guardIn, encoding: 'utf8', env: { ...base, ...env } });
  const doctor = () => F.cli(root, ['doctor'], { env: { FACTORY_USER_DIR: userDir } }).checks;
  const check = (checks, name) => checks.find((c) => c.name === name);
  // a fresh repository: no hook has run; the guard is called out as not enforcing
  const fresh = check(doctor(), 'hook guard');
  assert.equal(fresh.ok, false);
  assert.match(fresh.detail, /never seen running in this repository[\s\S]*NOT enforcing/);
  // the CLI just recorded where it lives (doctor ran it)
  assert.equal(fs.readFileSync(path.join(userDir, 'plugin-root'), 'utf8').trim(), F.PLUGIN);
  // 1. no root variable and no recorded root: the hook is skipped, and the launcher logs why
  fs.rmSync(path.join(userDir, 'plugin-root'));
  const skipped = runIn(H.hooks.preToolUse[0].bash, {});
  assert.equal(skipped.status, 0);
  assert.equal(skipped.stdout, '');
  assert.match(skipped.stderr, /hook script \/hooks\/guard\.js not found; hook skipped \(factory doctor explains\)/);
  const line = fs.readFileSync(path.join(userDir, 'hooks.log'), 'utf8').trim().split('\n').pop().split('\t');
  assert.deepEqual([line[1], line[2], fs.realpathSync(line[3])], ['factory:guard', 'not_found', fs.realpathSync(root)]);
  assert.equal(JSON.parse(line[4]).vars, '');
  const g = check(doctor(), 'hook guard');
  assert.equal(g.ok, false);
  assert.match(g.detail, /could not start or failed \(not_found\)[\s\S]*no PLUGIN_ROOT, COPILOT_PLUGIN_ROOT or CLAUDE_PLUGIN_ROOT[\s\S]*vscode#337374[\s\S]*GitHub Copilot Chat Hooks[\s\S]*the guard is NOT enforcing/);
  // 2. the root the CLI recorded (doctor above wrote it again): the guard runs and enforces
  assert.equal(fs.readFileSync(path.join(userDir, 'plugin-root'), 'utf8').trim(), F.PLUGIN);
  const viaFile = runIn(H.hooks.preToolUse[0].bash, {});
  assert.ok(deny(viaFile), viaFile.stderr);
  // 3. VS Code substitutes the ${PLUGIN_ROOT} token, shell-quoted (a path with a space), and sets no variable
  fs.rmSync(path.join(userDir, 'plugin-root'));
  const spaced = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plug ')), 'my plugin');
  fs.symlinkSync(F.PLUGIN, spaced);
  for (const tok of ['${PLUGIN_ROOT}', '${CLAUDE_PLUGIN_ROOT}']) {
    const b = H.hooks.preToolUse[0].bash.split(tok).join(`'${spaced}'`);
    const r = runIn(tok === '${CLAUDE_PLUGIN_ROOT}' ? b.split('${PLUGIN_ROOT}').join('') : b, {});
    assert.ok(deny(r), `${tok}: ${r.stderr}`);
  }
  // 4. the env var (the Copilot CLI) still works, and wins over a recorded root
  fs.writeFileSync(path.join(userDir, 'plugin-root'), '/nonexistent\n');
  assert.ok(deny(runIn(H.hooks.preToolUse[0].bash, { COPILOT_PLUGIN_ROOT: F.PLUGIN })));
  // the hook itself stamped the repository and the user log
  const stamps = JSON.parse(fs.readFileSync(path.join(root, '.factory', 'log', 'hooks.json'), 'utf8'));
  assert.equal(stamps.guard.outcome, 'ok');
  const ok = check(doctor(), 'hook guard');
  assert.equal(ok.ok, true, ok.detail);
  assert.match(ok.detail, /last ran/);
  // the prompt hook, run through its launcher: a heartbeat too (chat replies reach the factory)
  const p = spawnSync('bash', ['-c', H.hooks.userPromptSubmitted[0].bash], { cwd: root, input: JSON.stringify({ prompt: 'hello', cwd: root, sessionId: 's', timestamp: 1 }), encoding: 'utf8', env: { ...base, PLUGIN_ROOT: F.PLUGIN } });
  assert.equal(p.status, 0);
  assert.ok(fs.existsSync(path.join(root, '.factory', 'turn.json')));
  assert.equal(check(doctor(), 'hook prompt').ok, true);
  // no node: logged as node_missing, and doctor names the fix
  const noNode = fs.mkdtempSync(path.join(os.tmpdir(), 'nonode-'));
  for (const b of ['bash', 'cat', 'mkdir', 'date', 'uname']) {
    const w = spawnSync('bash', ['-c', `command -v ${b}`], { encoding: 'utf8' }).stdout.trim();
    if (w) fs.symlinkSync(w, path.join(noNode, b));
  }
  fs.rmSync(path.join(userDir, 'node-path'), { force: true }); // no node the CLI recorded either
  spawnSync(path.join(noNode, 'bash'), ['-c', H.hooks.userPromptSubmitted[0].bash], { cwd: root, input: '{}', encoding: 'utf8', env: { PATH: noNode, HOME: userDir, FACTORY_USER_DIR: userDir, PLUGIN_ROOT: F.PLUGIN } });
  const pm = check(doctor(), 'hook prompt');
  assert.equal(pm.ok, false);
  assert.match(pm.detail, /node_missing[\s\S]*no `node` on its PATH[\s\S]*chat replies \(approve, resume, ok …\) do not reach the factory/);
  // the log is capped
  const big = path.join(userDir, 'hooks.log');
  fs.appendFileSync(big, `${'x'.repeat(200)}\n`.repeat(2000));
  const was = process.env.FACTORY_USER_DIR;
  process.env.FACTORY_USER_DIR = userDir;
  try {
    require('../cli/lib/hook-health').note({ hook: 'guard', cwd: root });
  } finally {
    if (was === undefined) delete process.env.FACTORY_USER_DIR;
    else process.env.FACTORY_USER_DIR = was;
  }
  assert.ok(fs.statSync(big).size < 256 * 1024);
  // agents may not plant a plugin root or fake the log
  const gr = require('../hooks/guard-rules');
  assert.match(gr.checkWrite(root, path.join(os.homedir(), '.factory', 'plugin-root'), null), /belong to the factory CLI/);
  assert.match(gr.checkBash(root, 'echo /tmp/evil > ~/.factory/plugin-root', null, {}), /belong to the factory CLI/);
});

test('hooks: factory next\'s dead-hook notice sends the user to factory doctor first', () => {
  const w = require('../cli/core/reply-watch');
  const root = F.makeRepo();
  const n = w.notice(root, { job: 'J-0001', action: 'gate', gate: { id: 'H1', hash: 'h' } });
  assert.match(n, /First run factory doctor: its "hook prompt" and "hook guard" lines/);
});

test('hooks: node only on a login shell PATH (~/.local/bin): the launcher uses the node the CLI recorded, and the guard still enforces', () => {
  const H = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'hooks.json'), 'utf8'));
  const root = F.makeRepo();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-081-n-'));
  F.cli(root, ['doctor'], { env: { FACTORY_USER_DIR: userDir } }); // records plugin-root and node-path
  assert.equal(fs.readFileSync(path.join(userDir, 'node-path'), 'utf8').trim(), process.execPath);
  // a PATH with bash and coreutils but no node
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-081-bin-'));
  for (const t of ['bash', 'cat', 'dirname', 'mkdir', 'date', 'uname', 'wslpath']) {
    const w = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
    if (w) fs.symlinkSync(w, path.join(bin, t));
  }
  const input = JSON.stringify({ toolName: 'bash', toolArgs: { command: 'factory approve' }, cwd: root });
  const run = () => spawnSync(path.join(bin, 'bash'), ['-c', H.hooks.preToolUse[0].bash], { cwd: root, input, encoding: 'utf8', env: { PATH: bin, HOME: userDir, FACTORY_USER_DIR: userDir } });
  const r = run();
  assert.ok(r.stdout && JSON.parse(r.stdout).permissionDecision === 'deny', r.stderr);
  // without the record (and no node in the fallback folders) it says node is missing, never denies everything
  fs.rmSync(path.join(userDir, 'node-path'));
  const r2 = run();
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, '');
  assert.match(r2.stderr, /node is not on PATH/);
});

test('guard: agents may not write the launchers\' node-path record', () => {
  const rules = require('../hooks/guard-rules');
  const src = fs.readFileSync(path.join(F.PLUGIN, 'hooks', 'guard-rules.js'), 'utf8');
  assert.match(src, /plugin-root\|node-path\|hooks\\\.log\)\$/);
  assert.ok(rules);
});
