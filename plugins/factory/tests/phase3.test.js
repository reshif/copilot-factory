'use strict';
// Phase 3: factory drive (P3.1), factory inbox and notifications (P3.2), typed failure
// recovery (P3.3) and scheduling by dependency (P3.4).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');

const FAKE = path.join(__dirname, 'helpers', 'fake-copilot.js');
const CREW = path.join(__dirname, 'helpers', 'crew.js');
const REALIZE = path.join(F.PLUGIN, 'workflows', 'realize.js');
const core = (m) => require(`../cli/core/${m}`);
const stateOf = (root, J) => JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'state.json'), 'utf8'));
const events = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fake Copilot with a crew script; `script` may wrap the crew (a .js source string).
function harness({ script = CREW, env = {} } = {}) {
  const dir = require('./helpers/tmp').mkdtemp('factory-p3-');
  let file = script;
  if (!fs.existsSync(script)) {
    file = path.join(dir, 'script.js');
    fs.writeFileSync(file, script);
  }
  const log = path.join(dir, 'copilot.jsonl');
  const ENV = { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: FAKE, FAKE_COPILOT_SCRIPT: file, FAKE_COPILOT_LOG: log, FACTORY_NOTIFY: 'off', ...env };
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
    log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []),
    cli: (root, args) => parse(spawnSync('node', [F.BIN, ...args], { cwd: root, encoding: 'utf8', env: ENV, timeout: 300000 })),
    drive: (root, args = []) => parse(spawnSync('node', [F.BIN, 'drive', ...args], { cwd: root, encoding: 'utf8', env: ENV, timeout: 300000 })),
  };
}

// A chat reply through the real prompt hook (as Copilot delivers it).
function chat(root, text) {
  spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'prompt.js'), 'userPromptSubmitted'], { cwd: root, input: JSON.stringify({ prompt: text, cwd: root, sessionId: 'human', timestamp: Date.now() }), encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } });
  return JSON.parse(fs.readFileSync(path.join(root, '.factory', 'last-reply.json'), 'utf8'));
}

function newJob(root, policy) {
  if (policy) fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify(policy));
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  return J;
}

// The human's side of a drive stop: what they would reply in chat (or do in their terminal).
function answer(root, J, s) {
  if (s.kind === 'clarify') return chat(root, 'ok');
  if (s.kind === 'gate') return chat(root, 'approve');
  if (s.kind === 'wait' && /merged/.test(s.reply || '')) {
    const st = stateOf(root, J);
    F.sh(root, `git checkout -q ${st.base_branch} && git merge -q --no-ff -m "merge ${J}" ${st.branch}`);
    return chat(root, `merged ${F.sh(root, 'git rev-parse --short HEAD')}`);
  }
  return null;
}

// ------------------------------------------------------------------------------ P3.1 drive

test('P3.1: factory drive steps a whole bug@low job; it stops only where the human is needed, each stop typed, logged and notified; the human replies in chat and nothing else', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const h = harness();
  const stops = [];
  for (let i = 0; i < 10; i++) {
    const s = h.drive(root);
    assert.equal(s.__code, 0, JSON.stringify(s) + s.__stderr);
    stops.push(s.kind === 'gate' ? `gate ${s.gate.id}` : s.kind === 'clarify' ? `clarify ${s.stage}` : s.kind);
    assert.ok(s.summary && !/\n/.test(s.summary), 'a one-line summary');
    if (s.kind === 'done') break;
    const r = answer(root, J, s);
    assert.ok(r, `a stop the human can answer: ${JSON.stringify(s)}`);
    assert.equal(r.status, 'applied', JSON.stringify(r));
  }
  // 0.9.0: the read-back is shown (at H1), not waited on, and facts alone are no sheet: the human
  // is needed at H1 and for the merge only
  assert.deepEqual(stops, ['gate H1', 'wait', 'done']);
  assert.equal(stateOf(root, J).status, 'closed');
  const ev = events(root);
  // the drive never ran a human-only command, and every step it ran is marked via drive
  const HUMAN = new Set(['approve', 'deny', 'resume', 'proceed', 'cancel', 'abandon', 'waive', 'merged', 'confirm', 'assumption', 'finding', 'reseal']);
  const byDrive = ev.filter((e) => e.event === 'cli' && e.via === 'drive');
  assert.ok(byDrive.length > 10);
  assert.ok(!byDrive.some((e) => HUMAN.has(e.cmd) || (e.cmd === 'clarify' && ['reply', 'redirect'].includes(e.sub)) || (e.cmd === 'env' && e.sub === 'set')), 'never a human verb or a clarify reply');
  assert.ok(byDrive.some((e) => e.cmd === 'next') && byDrive.some((e) => e.cmd === 'ship') && byDrive.some((e) => e.cmd === 'close'));
  assert.ok(!ev.some((e) => e.event === 'cli' && e.cmd === 'next' && e.via !== 'drive'), 'nobody but the drive ran factory next');
  // every stop: a typed drive_stop event, and a notification attempt logged with it
  const ds = ev.filter((e) => e.event === 'drive_stop');
  assert.deepEqual(ds.map((e) => e.kind), ['gate', 'wait', 'done']);
  assert.equal(ds[0].gate, 'H1');
  assert.equal(ev.filter((e) => e.event === 'notify').length, ds.length);
  // the inspector finds nothing to say about how the job was driven
  const insp = spawnSync('node', [path.join(F.PLUGIN, '..', 'factory-inspector', 'bin', 'factory-inspect'), 'run', '--job', J], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } });
  const rep = JSON.parse(insp.stdout);
  assert.equal(rep.open.deviations, 0, insp.stdout);
});

test('P3.1: while a drive runs, factory next answers "driving" and factory run is refused; drive status --wait returns at its stop; drive stop interrupts it and a rerun continues from where the job is', async () => {
  const root = F.makeRepo();
  const J = newJob(root);
  // a slow builder, so the drive is caught mid-realize
  const h = harness({ script: `const crew = require(${JSON.stringify(CREW)});\nmodule.exports = async (c) => { if (c.role === 'builder' && !require('fs').existsSync(process.env.FAST_FILE)) await new Promise((r) => setTimeout(r, 6000)); return crew(c); };\n` });
  h.env.FAST_FILE = path.join(h.dir, 'fast');
  for (let i = 0; i < 4; i++) {
    const s = h.drive(root);
    if (s.kind === 'gate') {
      chat(root, 'approve');
      break;
    }
    answer(root, J, s);
  }
  const d = h.cli(root, ['drive', '--detach']);
  assert.equal(d.detached, true, JSON.stringify(d));
  assert.ok(fs.existsSync(d.log));
  // wait until it is building
  for (let i = 0; i < 100; i++) {
    const st = h.cli(root, ['drive', 'status']);
    if (st.status === 'running' && /realize/.test(st.step || '')) break;
    await sleep(100);
  }
  const n = h.cli(root, ['next']);
  assert.equal(n.action, 'driving', JSON.stringify(n));
  assert.match(n.instructions, /drive status --wait/);
  const run = h.cli(root, ['run', 'realize']);
  assert.equal(run.code, 'drive_in_progress', JSON.stringify(run));
  assert.equal(h.cli(root, ['drive']).code, 'drive_in_progress', 'one drive at a time');
  const stopped = h.cli(root, ['drive', 'stop']);
  assert.equal(stopped.stopped, true, JSON.stringify(stopped));
  const after = h.cli(root, ['drive', 'status']);
  assert.equal(after.status, 'stopped');
  assert.equal(after.last.kind, 'interrupted');
  assert.ok(!fs.existsSync(path.join(F.jobDir(root, J), 'run.lock')), 'the run it was in released its lock');
  const ev = events(root);
  assert.ok(ev.some((e) => e.event === 'workflow_end' && e.outcome === 'interrupted'), 'the run was stopped with its agents');
  assert.ok(ev.some((e) => e.event === 'drive_stop' && e.kind === 'interrupted'));
  // rerun (detached again): it continues from factory next and stops at the merge; status --wait returns then
  fs.writeFileSync(h.env.FAST_FILE, '1');
  assert.equal(h.cli(root, ['drive', '--detach']).detached, true);
  const w = h.cli(root, ['drive', 'status', '--wait', '120']);
  assert.equal(w.status, 'stopped', JSON.stringify(w));
  assert.equal(w.last.kind, 'wait', JSON.stringify(w.last));
  assert.match(w.last.summary, /merged/);
  assert.ok(w.log_tail.length > 0);
});

test('P3.1: a drive that died without a stop (killed) is taken over by the next one, which continues; a drive.json from a dead pid never blocks', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const h = harness();
  fs.writeFileSync(path.join(root, '.factory', 'drive.json'), JSON.stringify({ pid: 999999, host: os.hostname(), job: J, status: 'running', started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), step: 'run realize' }));
  assert.equal(h.cli(root, ['drive', 'status']).status, 'crashed');
  assert.notEqual(h.cli(root, ['next']).action, 'driving', 'a dead drive does not hold the job');
  const s = h.drive(root);
  assert.equal(s.kind, 'gate', JSON.stringify(s));
  const start = events(root).filter((e) => e.event === 'drive_start').pop();
  assert.equal(start.recovered_from.pid, 999999);
});

test('P3.1: the drive stops at a degraded run and at ground\'s questions (never answering them), and on Copilot being unavailable', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const h = harness({ env: { COPILOT_BIN: path.join(os.tmpdir(), 'no-such-copilot-bin') } });
  const s = h.drive(root);
  assert.equal(s.kind, 'copilot_unavailable', JSON.stringify(s));
  assert.equal(stateOf(root, J).status, 'active');
  // the stop detail for each kind says what to reply and which terminal command (with a code)
  const g = core('drive').stopDetail('gate', { job: J, step: 'H2', gate: { id: 'H2', hash: 'abcdef0123456789', docs: [] } });
  assert.equal(g.command, `factory approve H2 --job ${J}`);
  assert.match(g.reply, /approve \| deny/);
  const p = core('drive').stopDetail('parked', { job: J, reason: 'Tasks not done: T2 (blocked)', park: { kind: 'needs_paths', next: 'T2 needs src/index.js: amend the plan' } });
  assert.match(p.summary, /parked \(needs_paths\)[\s\S]*Next: T2 needs src\/index\.js/);
  assert.equal(p.command, `factory resume --job ${J}`);
  assert.match(core('drive').stopDetail('questions', { job: J }, { questions: ['Which DB?'] }).summary, /1 question/);
  assert.deepEqual(core('drive').words('factory evidence add AC-1 --type doc --note "two words" --job J-0001'), ['evidence', 'add', 'AC-1', '--type', 'doc', '--note', 'two words', '--job', 'J-0001']);
  assert.deepEqual(core('drive').runArgs({ workflow: 'fanout-judge', config: 'challenge', scope: null, lanes: ['code', 'tests'], threat_model: false }), ['run', 'fanout-judge', '--config', 'challenge', '--lanes', 'code,tests', '--no-threat-model', '--json']);
});

test('P3.1: agents may not drive: factory drive and inbox are refused inside a factory run agent and by the guard for agents', () => {
  const root = F.makeRepo();
  newJob(root);
  for (const args of [['drive'], ['drive', 'status'], ['inbox']]) {
    const r = F.cli(root, args, { env: { FACTORY_RUNNER: '1' } });
    assert.equal(r.code, 'agent_not_allowed', `${args.join(' ')}: ${JSON.stringify(r)}`);
  }
  const G = require('../hooks/guard-rules');
  assert.ok(G.checkBash(root, 'factory drive --detach', null, { agent: true }), 'the guard refuses a factory agent driving');
  assert.equal(G.checkBash(root, 'factory drive --detach', null, { agent: false }), null, 'the main session may');
});

// ------------------------------------------------------------------------------ P3.2 inbox, notify

test('P3.2: notifications: notify-send on Linux, wsl-notify-send or a PowerShell toast on WSL, osascript on macOS, a bell otherwise; policy.notify turns them off; they never block or throw', async () => {
  const N = core('notify');
  const has = (names) => (n) => n.find((x) => names.includes(x)) || null;
  assert.equal(N.plan('t', 'b', { platform: 'linux', wsl: false, find: has(['notify-send']) }).method, 'notify-send');
  assert.equal(N.plan('t', 'b', { platform: 'linux', wsl: true, find: has(['wsl-notify-send.exe', 'notify-send']) }).method, 'wsl-notify-send');
  // B1 (review): agent-written text never becomes script text. A park reason with a curly quote
  // (PowerShell closes a '…' string on ’ too) travels as an environment variable, passed to the
  // Windows side through WSLENV; osascript gets it as argv; control characters are stripped.
  const evil = "x’; Start-Process calc; ’ \u001b[31m\r\nsecond line";
  const toast = N.plan('t’', evil, { platform: 'linux', wsl: true, env: { WSLENV: 'PATH/l' }, find: has(['powershell.exe']) });
  assert.equal(toast.method, 'powershell');
  assert.equal(toast.args[toast.args.length - 1], N.TOAST_SCRIPT, 'the script is a constant');
  assert.ok(!/Start-Process|’/.test(toast.args.join(' ')), 'nothing of the text is in the command line');
  assert.match(N.TOAST_SCRIPT, /\$env:FACTORY_NOTE_TITLE[\s\S]*\$env:FACTORY_NOTE_BODY/);
  assert.equal(toast.env.FACTORY_NOTE_BODY, "x’; Start-Process calc; ’ [31m second line");
  assert.equal(toast.env.WSLENV, 'PATH/l:FACTORY_NOTE_TITLE:FACTORY_NOTE_BODY');
  const win = N.plan('t', evil, { platform: 'win32' });
  assert.ok(!/Start-Process/.test(win.args.join(' ')) && win.env.FACTORY_NOTE_BODY && !win.env.WSLENV);
  assert.equal(N.plan('t', 'b', { platform: 'darwin', find: has(['osascript']) }).method, 'osascript');
  const osa = N.plan('a "t"', 'b" & do shell script "touch /tmp/x', { platform: 'darwin', find: has(['osascript']) });
  assert.deepEqual(osa.args.slice(0, 6), ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run'], 'the AppleScript is a constant');
  assert.deepEqual(osa.args.slice(6), ['a "t"', 'b" & do shell script "touch /tmp/x'], 'the text is argv, never code');
  assert.deepEqual(N.plan('-t', '--b', { platform: 'linux', wsl: false, find: has(['notify-send']) }).args, ['--app-name=Software Factory', '--', '-t', '--b'], 'no text is read as an option');
  assert.equal(N.plan('t', 'b', { platform: 'win32' }).method, 'powershell');
  assert.equal(N.plan('t', 'b', { platform: 'linux', wsl: false, find: () => null }).method, 'bell');
  assert.equal(N.isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, () => ''), true);
  assert.equal(N.isWsl({}, () => 'Linux version 5.15.153.1-microsoft-standard-WSL2'), true);
  assert.equal(N.isWsl({}, () => 'Linux version 6.8.0-generic'), false);
  assert.equal(N.isWsl({}, () => { throw new Error('no /proc'); }), false);
  // a real spawn through a notify-send on PATH; then policy.notify false turns it off
  const root = F.makeRepo();
  const bin = require('./helpers/tmp').mkdtemp('factory-bin-');
  const out = path.join(bin, 'shown.txt');
  fs.writeFileSync(path.join(bin, 'notify-send'), `#!/bin/sh\necho "$@" >> "${out}"\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, FACTORY_NOTIFY: process.env.FACTORY_NOTIFY, WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME };
  try {
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    delete process.env.FACTORY_NOTIFY;
    delete process.env.WSL_DISTRO_NAME;
    if (N.isWsl()) return; // a WSL test machine would use its own notifier
    const t0 = Date.now();
    const r = N.notify(root, { title: 'Factory J-0001: gate waits for you', body: 'J-0001 waits at gate H1', job: 'J-0001', kind: 'gate' });
    assert.ok(Date.now() - t0 < 1000, 'never waits on the notifier');
    assert.deepEqual([r.sent, r.method], [true, 'notify-send']);
    for (let i = 0; i < 50 && !fs.existsSync(out); i++) await sleep(50);
    assert.match(fs.readFileSync(out, 'utf8'), /Factory J-0001: gate waits for you J-0001 waits at gate H1/);
    fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ notify: false }));
    assert.deepEqual(N.notify(root, { title: 't', body: 'b' }), { sent: false, method: 'off' });
    const ev = events(root).filter((e) => e.event === 'notify');
    assert.deepEqual(ev.map((e) => e.method), ['notify-send', 'off']);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('P3.2: a drive stop notifies through the OS notifier (notify-send on PATH)', async () => {
  const root = F.makeRepo();
  newJob(root, { clarify: { readback: 'wait' } }); // a clarify turn to stop at
  const bin = require('./helpers/tmp').mkdtemp('factory-bin-');
  const out = path.join(bin, 'shown.txt');
  fs.writeFileSync(path.join(bin, 'notify-send'), `#!/bin/sh\necho "$@" >> "${out}"\n`, { mode: 0o755 });
  const h = harness({ env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FACTORY_NOTIFY: '', WSL_DISTRO_NAME: '' } });
  if (core('notify').isWsl({})) return;
  const s = h.drive(root);
  assert.equal(s.kind, 'clarify');
  assert.equal(s.notified, 'notify-send');
  for (let i = 0; i < 50 && !fs.existsSync(out); i++) await sleep(50);
  assert.match(fs.readFileSync(out, 'utf8'), /clarify waits for your reply/);
});

test('P3.2: factory inbox lists what waits on the human across jobs: the gate, the clarify turn, the park, each with the chat reply and the terminal command (which asks for its code)', () => {
  const root = F.makeRepo();
  const h = harness();
  const J1 = newJob(root);
  for (let i = 0; i < 4; i++) {
    const s = h.drive(root, ['--job', J1]);
    if (s.kind === 'gate') break;
    answer(root, J1, s);
  }
  const J2 = newJob(root, { clarify: { readback: 'wait' } });
  h.drive(root, ['--job', J2]); // stops at clarify's read-back (kept waiting by policy)
  const J3 = newJob(root);
  F.cli(root, ['park', '--job', J3, '--reason', 'waiting for the vendor API']);
  const r = h.cli(root, ['inbox']);
  assert.equal(r.count, 3, JSON.stringify(r));
  const by = Object.fromEntries(r.items.map((x) => [x.job, x]));
  assert.deepEqual([by[J1].kind, by[J1].gate], ['gate', 'H1']);
  assert.deepEqual(by[J1].reply, ['approve', 'deny <what must change>']);
  assert.equal(by[J1].command, `factory approve H1 --job ${J1}`);
  assert.equal(by[J1].human_only, true);
  assert.deepEqual([by[J2].kind, by[J2].stage], ['clarify', 'readback_wait']);
  assert.match(by[J2].screen, /add returns the sum/);
  assert.match(by[J2].command, /factory clarify reply/);
  assert.deepEqual([by[J3].kind, by[J3].park_kind], ['park', 'manual']);
  assert.match(by[J3].next, /resume/);
  assert.match(r.message, /asks you to type a code shown there \(type it there; never paste it into a chat\)/);
  const md = spawnSync('node', [F.BIN, 'inbox', '--format', 'md'], { cwd: root, encoding: 'utf8', env: h.env }).stdout;
  assert.match(md, /# Factory inbox[\s\S]*Gate \*\*H1\*\*[\s\S]*it asks you to type a code shown on that terminal/);
  // read-only: nothing routed, nothing logged
  const before = fs.readFileSync(path.join(root, '.factory', 'log', 'decisions.jsonl'), 'utf8');
  h.cli(root, ['inbox']);
  assert.equal(fs.readFileSync(path.join(root, '.factory', 'log', 'decisions.jsonl'), 'utf8'), before);
  // the console carries the inbox (the --serve page shows it)
  const data = core('console').build(root);
  assert.equal(data.inbox.count, 3);
});

// ------------------------------------------------------------------------------ P3.3 typed recovery

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

test('P3.3: every park is typed with a suggested next step; factory why shows the park rows with their reasons; factory next while parked raises no false dead-hook notice', () => {
  const root = F.makeRepo();
  const J = toBuild(root);
  assert.equal(F.cli(root, ['next']).workflow, 'realize');
  // a realize result with a blocked task that needs a path
  const b = F.cli(root, ['wfargs', 'realize']);
  core('tasks').afterBuilder(root, J, 'T1', { status: 'blocked', summary: 'add is re-exported from src/index.js', needs_paths: ['src/index.js'] }, { label: 'build T1 #1' });
  const r = F.record(root, F.envelope(b, 'park', { tasks: [{ id: 'T1', outcome: 'blocked', attempts: 1, summary: 'Blocked: needs src/index.js. add is re-exported' }] }, { park_reason: 'Tasks not done: T1 (blocked)' }));
  assert.equal(r.status, 'park');
  assert.equal(r.park.kind, 'needs_paths');
  assert.match(r.park.next, /T1 needs src\/index\.js: amend the plan/);
  const st = stateOf(root, J);
  assert.deepEqual([st.status, st.park.kind], ['parked', 'needs_paths']);
  // factory next while parked: the typed park, and no "chat replies aren't reaching" notice
  fs.writeFileSync(path.join(root, '.factory', 'turn.json'), JSON.stringify({ at: new Date(Date.now() - 3600000).toISOString() }));
  for (let i = 0; i < 3; i++) {
    const n = F.cli(root, ['next']);
    assert.equal(n.action, 'parked');
    assert.equal(n.park.kind, 'needs_paths');
    assert.equal(n.notice, undefined, 'a park is not evidence of a dead hook');
  }
  const w = F.cli(root, ['why']);
  assert.deepEqual(w.parks.map((p) => [p.kind, p.rule]), [['needs_paths', 'park.needs_paths']]);
  assert.match(w.parks[0].next, /amend the plan/);
  assert.match(F.cli(root, ['why', '--format', 'md']).raw || '', /park \(needs_paths\)[^\n]*\[needs_paths\] Tasks not done: T1 \(blocked\)[^\n]*next: T1 needs src\/index\.js/);
  // router parks carry their type too (here the manual one, and the kinds for every cause)
  const dt = core('decision-table');
  assert.equal(dt.parkKind('x', 'budget'), 'budget');
  assert.equal(dt.parkKind('x', 'drift'), 'scope_violation');
  assert.equal(dt.parkKind('x', 'environment'), 'environment_broken');
  assert.equal(dt.parkKind('Tasks not done: T2 (exhausted)', 'realize'), 'task_exhausted');
  assert.equal(dt.parkKind('Tasks not done: T4 (blocked)', 'realize', { tasks: [{ id: 'T4', outcome: 'blocked', summary: 'Blocked (dependency_conflict): Merging T3 into T4 conflicts' }] }), 'dependency_conflict');
  assert.equal(dt.parkKind('Reconcile regression: …', 'reconcile'), 'regression');
  for (const k of Object.keys(dt.PARK_NEXT)) assert.ok(dt.PARK_NEXT[k].length > 20, k);
});

test('P3.3: amend submit while parked: gate A pre-empts the park, and the human approving the amendment resumes the job (no separate resume)', () => {
  const root = F.makeRepo();
  const J = toBuild(root);
  F.cli(root, ['next']);
  F.cli(root, ['park', '--reason', 'T1 needs src/index.js']);
  assert.equal(stateOf(root, J).status, 'parked');
  F.cli(root, ['amend', 'start', '--reason', 'T1 may touch the README too', '--by', 'user']);
  const pf = path.join(F.jobDir(root, J), 'plan.json');
  const plan = JSON.parse(fs.readFileSync(pf, 'utf8'));
  plan.tasks[0].allowed_paths.push('README.md');
  fs.writeFileSync(pf, JSON.stringify(plan, null, 2));
  const sub = F.cli(root, ['amend', 'submit']);
  assert.equal(sub.parked, true);
  assert.match(sub.next, /it presents gate A[\s\S]*approving the amendment also resumes it, as "resume" would/);
  const n = F.cli(root, ['next']);
  assert.deepEqual([n.action, n.step, n.resumes_park], ['gate', 'A', true], JSON.stringify(n));
  const r = F.reply(root, 'approve');
  assert.equal(r.resumed, true);
  const st = stateOf(root, J);
  assert.deepEqual([st.status, st.park, st.resumed.via], ['active', null, 'amendment']);
  assert.equal(st.tasks.T1.needs_work, 'amendment');
  assert.deepEqual([F.cli(root, ['next']).workflow, F.cli(root, ['next']).scope], ['realize', 'amendment']);
  // denied instead: the amendment reopens and the park stands
  const root2 = F.makeRepo();
  const J2 = toBuild(root2);
  F.cli(root2, ['next']);
  F.cli(root2, ['park', '--reason', 'x']);
  F.cli(root2, ['amend', 'start', '--reason', 'y']);
  const p2 = path.join(F.jobDir(root2, J2), 'plan.json');
  const pl2 = JSON.parse(fs.readFileSync(p2, 'utf8'));
  pl2.tasks[0].allowed_paths.push('README.md');
  fs.writeFileSync(p2, JSON.stringify(pl2, null, 2));
  F.cli(root2, ['amend', 'submit']);
  // M2 (review): not approvable or deniable before the router presented gate A
  assert.throws(() => F.reply(root2, 'deny keep the paths as they are'), /no gate waiting/);
  assert.equal(F.cli(root2, ['next']).step, 'A');
  F.reply(root2, 'deny keep the paths as they are');
  const n2 = F.cli(root2, ['next']);
  assert.equal(n2.action, 'parked');
  assert.equal(stateOf(root2, J2).pending_gate.id, 'P');
});

test('P3.3: a transient Copilot failure (HTTP 429) is retried with backoff in the same agent call and spends no attempt; one that never clears stops the run (copilot_transient) and the drive (transient)', () => {
  const root = F.makeRepo();
  const FAST = { copilot: { transient_backoff_seconds: 0.01, transient_retries: 2, transient_park_after: 2 } };
  const J = toBuild(root, FAST);
  const flaky = `const crew = require(${JSON.stringify(CREW)});\nconst fs = require('fs');\nmodule.exports = (c) => {\n  const f = process.env.RATE_FILE;\n  const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;\n  if (c.role === 'builder' && n < Number(process.env.RATE_LIMITS || 0)) { fs.writeFileSync(f, String(n + 1)); return { exit: 1, stderr: 'Error: Request failed with status code 429 (Too Many Requests): rate limit exceeded' }; }\n  return crew(c);\n};\n`;
  const h = harness({ script: flaky });
  h.env.RATE_FILE = path.join(h.dir, 'rate');
  h.env.RATE_LIMITS = '1';
  assert.equal(h.cli(root, ['next']).workflow, 'realize');
  const r = h.cli(root, ['run', 'realize', '--json']);
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 2000) + r.__stderr);
  const b = r.agents.filter((a) => a.role === 'builder');
  assert.deepEqual(b.map((a) => [a.label, a.outcome, a.transient_retries]), [['build T1 #1', 'ok', 1]], 'one builder run, attempt 1, after one transient retry');
  assert.equal(h.log().filter((c) => c.agent === 'factory:builder').length, 2, 'two spawns: the 429 and its retry');
  assert.equal(stateOf(root, J).tasks.T1.attempts, 1, 'no attempt spent on the 429');
  assert.ok(events(root).some((e) => e.event === 'agent_transient' && e.retry === 1 && /429/.test(e.match)));
  assert.match(r.__stderr, /transient failure \(status code 429\); retry 1 in/);
  // never clears: after transient_retries the run stops with nothing recorded, and the drive stops typed
  const root2 = F.makeRepo();
  const J2 = toBuild(root2, FAST);
  h.env.RATE_FILE = path.join(h.dir, 'rate2');
  h.env.RATE_LIMITS = '99';
  const s = h.drive(root2);
  assert.equal(s.kind, 'transient', JSON.stringify(s));
  assert.match(s.summary, /rate limit|429/);
  assert.equal(stateOf(root2, J2).status, 'active', 'not parked: nothing was recorded');
  assert.equal(stateOf(root2, J2).tasks.T1 ? stateOf(root2, J2).tasks.T1.attempts || 0 : 0, 0, 'no attempt spent');
  assert.ok(events(root2).some((e) => e.event === 'drive_stop' && e.kind === 'transient'));
  assert.equal(core('runner').transient({ code: 1, stderr: '', stdout: '{"type":"tool.result","data":{"content":"ECONNREFUSED 127.0.0.1:5432"}}' }), null, 'an agent\'s own tool output is never a transient failure');
  assert.equal(core('runner').transient({ code: 1, stderr: 'TypeError: fetch failed', stdout: '' }), 'fetch failed');
  assert.equal(core('runner').transient({ code: 0, stderr: '429', stdout: '' }), null);
});

test('P3.3: a reconcile regression on Tn rebuilds Tn on the merged code once, automatically; a second one parks typed', () => {
  const root = F.makeRepo();
  const J = toBuild(root, { limits: { integrate_each_wave: false } });
  assert.equal(F.cli(root, ['next']).workflow, 'realize');
  const sh = F.cli(root, ['task', 'start', 'T1']);
  F.write(sh.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
  F.sh(sh.worktree, 'git commit -qam fix');
  F.built(root, 'T1');
  F.cli(root, ['task', 'verify', 'T1']);
  F.record(root, F.envelope(F.cli(root, ['wfargs', 'realize']), 'ok', { tasks: [{ id: 'T1', outcome: 'done', attempts: 1 }] }));
  assert.equal(F.cli(root, ['next']).workflow, 'reconcile');
  const brief = F.cli(root, ['wfargs', 'reconcile']);
  core('ledger').append(root, J, { kind: 'step', step: 'reconcile', ok: false, bound: { fingerprint: 'x' }, detail: { regression: { dropped: [{ file: 'src/cli.js', line: "console.error('usage: x <list|value|export>')", by: 'already-merged work', task: 'T1' }], files: ['src/cli.js'], merges: [], fix_commits: [] }, message: 'Integration would drop work already merged' } });
  let r = F.record(root, F.envelope(brief, 'ok', { integrator: { status: 'regression', summary: 'dropped a line' } }));
  assert.equal(r.status, 'retry', JSON.stringify(r));
  assert.deepEqual(r.recovery, { kind: 'regression', action: 'rebuild', tasks: ['T1'] });
  const st = stateOf(root, J);
  assert.equal(st.status, 'active');
  assert.equal(st.tasks.T1.needs_work, 'integration');
  assert.match(st.tasks.T1.integration_failure.failures[0].output, /would drop src\/cli\.js/);
  assert.ok(events(root).some((e) => e.event === 'recovery' && e.kind === 'regression'));
  assert.equal(F.cli(root, ['next']).workflow, 'realize', 'factory next rebuilds it');
  // the same regression after its one rebuild: parked, typed
  r = F.record(root, F.envelope(brief, 'ok', { integrator: { status: 'regression', summary: 'dropped a line' } }));
  assert.equal(r.status, 'park', JSON.stringify(r));
  assert.equal(r.park.kind, 'regression');
  assert.match(stateOf(root, J).park.reason, /T1 already rebuilt once/);
});

test('P3.3: after a dependency_conflict, the task\'s next start restarts its branch from the integrated job branch (the once-rebuild), keeping the old head on a ref', () => {
  const root = F.makeRepo();
  const J = toBuild(root);
  // T1's branch has its own change to src/add.js …
  const s1 = F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
  F.write(s1.worktree, 'src/add.js', 'module.exports = (a, b) => a + b; // T1\n');
  F.sh(s1.worktree, 'git commit -qam T1');
  // … and the job branch got a clashing one meanwhile (another task, integrated)
  const jw = core('tasks').ensureJobWorktree(root, stateOf(root, J));
  F.write(jw, 'src/add.js', 'module.exports = (a, b) => b + a; // integrated\n');
  F.sh(jw, 'git commit -qam integrated');
  const c = F.cli(root, ['task', 'start', 'T1']);
  assert.equal(c.code, 'dependency_conflict', JSON.stringify(c));
  assert.equal(stateOf(root, J).tasks.T1.start_error.code, 'dependency_conflict');
  const r = F.cli(root, ['task', 'start', 'T1']);
  assert.ok(!r.code, JSON.stringify(r));
  assert.equal(r.restarted.reason, 'dependency_conflict');
  assert.match(fs.readFileSync(path.join(s1.worktree, 'src/add.js'), 'utf8'), /integrated/, 'rebuilt on the integrated job branch');
  assert.match(F.sh(root, `git show ${r.restarted.backup}:src/add.js`), /T1/, 'the old head is kept');
  assert.equal(stateOf(root, J).tasks.T1.start_error, undefined);
  assert.ok(!F.cli(root, ['task', 'start', 'T1']).restarted, 'once');
});

// ------------------------------------------------------------------------------ P3.4 DAG

test('P3.4: tasks are scheduled by dependency: a task starts as soon as its own dependency is integrated, not after the slowest task of its wave; concurrency stays within max_parallel_tasks', async () => {
  const U = 20;
  const mk = (id, deps = []) => ({ id, depends_on: deps, retry_limit: 3, builder: { agent_type: 'factory:builder', escalate: [] }, builder_prompt: `build ${id} #{{attempt}}\n{{failures}}` });
  const brief = { workflow: 'realize', job: 'J-1', input_hash: 'x', max_parallel_tasks: 2, builder_schema: {}, integrate_each_wave: true, tasks: { T1: mk('T1'), T2: mk('T2'), T3: mk('T3', ['T1']), T4: mk('T4', ['T3']), T5: mk('T5') }, waves: [['T1', 'T2', 'T5'], ['T3'], ['T4']] };
  const dur = { T1: 2, T2: 12, T3: 2, T4: 2, T5: 2 };
  const t0 = Date.now();
  const at = () => Math.round((Date.now() - t0) / U);
  const log = [];
  let live = 0;
  let peak = 0;
  const { result } = await H.run(REALIZE, brief, async (prompt, o) => {
    const id = o.label.split(' ')[1];
    live += 1;
    peak = Math.max(peak, live);
    const s = at();
    await sleep(dur[id] * U);
    live -= 1;
    log.push({ id, s, e: at() });
    return { status: 'done', summary: 'ok', swept: [] };
  }, {
    verify: async (id) => ({ task: id, pass: true }),
    integrate: async (ids) => { log.push({ integrate: ids.join(','), s: at() }); return { ok: true, route: {} }; },
  });
  assert.equal(result.status, 'ok', JSON.stringify(result.data));
  const t = (id) => log.find((x) => x.id === id);
  assert.ok(t('T3').s < t('T2').e, `T3 (needs T1) started before T2 (slow, same wave) finished: ${JSON.stringify(log)}`);
  assert.ok(t('T4').s < t('T2').e, 'and T4 after T3, still while T2 builds');
  const intT1 = log.find((x) => x.integrate && x.integrate.split(',').includes('T1'));
  assert.ok(intT1 && intT1.s <= t('T3').s, 'T3 started only after T1 was integrated');
  assert.ok(peak <= 2, `at most max_parallel_tasks builders at once (peak ${peak})`);
  assert.ok(result.data.integrations.length >= 3, 'integration per completed frontier, not one per wave barrier');
});

test('P3.4: a broken integration still stops what would build on it: nothing new starts until the reopened task is rebuilt and integrated', async () => {
  const mk = (id, deps = []) => ({ id, depends_on: deps, retry_limit: 1, builder: { agent_type: 'factory:builder', escalate: [] }, builder_prompt: `build ${id} #{{attempt}}\n{{failures}}` });
  const brief = { workflow: 'realize', job: 'J-1', input_hash: 'x', max_parallel_tasks: 4, builder_schema: {}, integrate_each_wave: true, tasks: { T1: mk('T1'), T2: mk('T2', ['T1']), T3: mk('T3') }, waves: [['T1', 'T3'], ['T2']] };
  const started = [];
  const { result } = await H.run(REALIZE, brief, async (prompt, o) => {
    started.push(o.label);
    if (/T3/.test(o.label)) await sleep(150);
    return { status: 'done', summary: 'ok', swept: [] };
  }, {
    verify: async (id) => ({ task: id, pass: true }),
    // T1's integration fails and routes back to T1, whose retry limit is used up
    integrate: async (ids) => (ids.includes('T1') ? { ok: false, kind: 'commands', failures: [{ cmd: 'npm test', code: 1 }], route: { T1: [{ cmd: 'npm test', code: 1, output: 'boom' }] } } : { ok: true, route: {} }),
  });
  assert.equal(result.status, 'park');
  const by = Object.fromEntries(result.data.tasks.map((x) => [x.id, x.outcome]));
  assert.equal(by.T1, 'exhausted');
  assert.equal(by.T2, 'skipped_dependency', 'its dependent never started');
  assert.ok(!started.some((l) => /T2/.test(l)));
});

// ------------------------------------------------------------------------------ upgrade

test('upgrade: a 0.7.0 job parked mid-build (a park with no kind, no park rows, no drive.json) continues under factory drive', () => {
  const root = F.makeRepo();
  const J = toBuild(root);
  F.cli(root, ['next']);
  // the park as 0.7.0 wrote it: reason, at, from; no kind or next, and no decision row
  const job = core('job');
  const st = job.load(root, J);
  st.status = 'parked';
  st.park = { reason: 'Tasks not done: T1 (blocked). Nothing partial ships.', at: new Date().toISOString(), from: 'realize' };
  st.pending_gate = { id: 'P', hash: null, docs: [], at: new Date().toISOString() };
  job.save(root, st);
  const n = F.cli(root, ['next']);
  assert.deepEqual([n.action, n.park.kind], ['parked', 'needs_paths']);
  assert.match(n.park.next, /amend the plan/);
  const h = harness();
  const s = h.drive(root);
  assert.equal(s.kind, 'parked', JSON.stringify(s));
  assert.equal(s.park.kind, 'needs_paths');
  assert.equal(h.cli(root, ['inbox']).items[0].park_kind, 'needs_paths');
  assert.equal(F.cli(root, ['why']).park.reason, st.park.reason);
  // the human resumes; the drive takes it on to the merge
  F.reply(root, 'resume');
  const s2 = h.drive(root);
  assert.equal(s2.kind, 'wait', JSON.stringify(s2));
  assert.match(s2.summary, /merged/);
});
