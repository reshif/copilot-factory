'use strict';
// Backports of the claude-factory port review (PORT-AUTO-REVIEW) to copilot-factory 0.10.0:
// MAJ-3 (no login shell for the probe's and an unconfirmed environment's commands, the probe's own
// dirs unfiltered), MAJ-2 (a started record, interrupted runs cleaned up and counted, the question
// after two), MAJ-4 (granted paths are exact files), the one reply reader (B1 analogue) and the
// minors m1, m2, m6, m7.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');

const core = (m) => require(`../cli/core/${m}`);
const next = (root) => F.cli(root, ['next']);
const { seal } = require('../cli/lib/seal');

function newJob(root, { type = 'feature', risk = 'medium' } = {}) {
  return F.cli(root, ['job', 'new', '--title', 'x', '--type', type, '--risk', risk]).job;
}
function writePlan(root, J, tasks) {
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks }));
}
const task = (id, cmds, extra = {}) => ({ id, objective: id, allowed_paths: [`src/${id.toLowerCase()}.js`], criteria_ids: ['AC-1'], verify_commands: cmds, ...extra });
function events(root) {
  try {
    return fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const probeWorktrees = (root) => F.sh(root, 'git worktree list').split('\n').filter((l) => /_probe-/.test(l));
// pids whose working directory is inside dir (Linux /proc)
function pidsIn(dir) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const cwd = fs.readlinkSync(`/proc/${p}/cwd`);
      if (cwd === dir || cwd.startsWith(`${dir}/`)) out.push(Number(p));
    } catch {
      /* gone or not ours */
    }
  }
  return out;
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/\) Z /.test(st);
  } catch {
    return false;
  }
};
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}
const deadPid = () => spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;

// ------------------------------------------------------------------ MAJ-3

test('MAJ-3: the probe\'s setup, teardown and services.down run without a login shell, with the scratch home and no token, even with a profile that exports one', (t) => {
  const root = F.makeRepo(t);
  // a login shell would read these from the scratch home (HOME points there) and export a token
  for (const f of ['.profile', '.bash_profile', '.bashrc']) F.write(root, `.factory-probe/home/${f}`, 'export GH_TOKEN=ghs_fromprofile1234567890\nexport PROFILE_RAN=1\n');
  F.sh(root, 'git add -A && git commit -qm profile');
  const J = newJob(root);
  const out = path.join(root, '..', `maj3-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  fs.mkdirSync(out, { recursive: true });
  const show = (tag) => `echo "${tag} shell=$(shopt -q login_shell && echo login || echo nologin) home=$HOME tok=\${GH_TOKEN:-none} prof=\${PROFILE_RAN:-no}" > ${out}/${tag}.txt`;
  const env = { version: 1, name: 'shells', setup: [show('setup')], teardown: show('teardown'), services: { up: show('up'), down: show('down') } };
  fs.writeFileSync(core('environment').JOB_PROPOSED(root, J), JSON.stringify(env));
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ decompose: { plan_probe: 'full' } }));
  writePlan(root, J, [task('T1', ['node tests/add.test.js'])]);
  const r = F.cli(root, ['plan', 'probe'], { env: { GH_TOKEN: 'ghs_callertoken1234567890', CLAUDE_CODE_TMPDIR: path.join(root, '.factory') } });
  assert.equal(r.mode, 'full');
  assert.equal(r.setup.status, 'ok', JSON.stringify(r));
  for (const tag of ['setup', 'teardown', 'up', 'down']) {
    const line = fs.readFileSync(path.join(out, `${tag}.txt`), 'utf8');
    assert.match(line, /shell=nologin/, `${tag}: ${line}`);
    assert.match(line, /tok=none prof=no/, `${tag}: ${line}`);
    assert.match(line, /home=\S*\.factory-probe\/home/, `${tag}: the scratch home, never dropped (a temp path that contains a secret-looking variable's value): ${line}`);
  }
  assert.equal(probeWorktrees(root).length, 0);
});

test('MAJ-3: probeEnv keeps the probe\'s own directories even when a path contains a secret-looking variable\'s value; declared extras that carry one are still dropped', () => {
  const P = core('probe');
  const prev = process.env.SOME_SESSION_DIR;
  process.env.SOME_SESSION_DIR = '/tmp/secretish-session-dir';
  try {
    const e = P.probeEnv('/nonexistent', 'id1', { HOME: '/tmp/secretish-session-dir/x/home', FOO: 'bar' }, {});
    assert.equal(e.HOME, undefined, 'an extra carrying the value is dropped');
    assert.equal(e.FOO, 'bar');
    const own = P.probeEnv('/nonexistent', 'id1', {}, { HOME: '/tmp/secretish-session-dir/x/home' });
    assert.equal(own.HOME, '/tmp/secretish-session-dir/x/home', 'the probe\'s own home is kept');
  } finally {
    if (prev === undefined) delete process.env.SOME_SESSION_DIR;
    else process.env.SOME_SESSION_DIR = prev;
  }
});

test('MAJ-3: env check on an unconfirmed (proposed) environment runs like the probe: no login shell, no token, a scratch home', (t) => {
  const root = F.makeRepo(t);
  const out = path.join(root, '..', `maj3c-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(out, { force: true }));
  const env = { version: 1, name: 'shells', setup: [`echo "shell=$(shopt -q login_shell && echo login || echo nologin) home=$HOME tok=\${GH_TOKEN:-none}" > ${out}`] };
  fs.writeFileSync(path.join(root, '.factory', 'environment.proposed.json'), JSON.stringify(env));
  const r = F.cli(root, ['env', 'check', '--proposed'], { env: { GH_TOKEN: 'ghs_callertoken1234567890' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.which, 'proposed');
  const line = fs.readFileSync(out, 'utf8');
  assert.match(line, /shell=nologin home=\S*_envcheck-\d+\/\.factory-probe\/home tok=none/, line);
  assert.ok(!fs.readdirSync(path.join(root, '.factory', 'worktrees')).some((n) => n.startsWith('_envcheck-')), 'its worktree is gone');
});

// ------------------------------------------------------------------ MAJ-2

test('MAJ-2: a probe killed mid-run leaves an unfinished started record; the next run cleans up its processes (a cleared-env escapee included) and its worktree, counts it, and goes on', async (t) => {
  const root = F.makeRepo(t);
  const J = newJob(root);
  // a dry-run that starts an escapee with an empty environment in its own session, then waits
  const esc = `node -e "require('child_process').spawn('sleep',['120'],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH}}).unref(); setTimeout(()=>{},60000)"`;
  writePlan(root, J, [task('T1', [esc])]);
  const kid = spawn(process.execPath, [F.BIN, 'plan', 'probe'], { cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, FACTORY_ROOT: '' } });
  t.after(() => {
    try {
      process.kill(-kid.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  });
  const P = core('probe');
  const st = await until(() => {
    const s = P.readStarted(root, J);
    return s && !s.finished && fs.existsSync(s.wt) && pidsIn(s.wt).some((p) => /sleep/.test(fs.readFileSync(`/proc/${p}/cmdline`, 'utf8'))) ? s : null;
  });
  assert.ok(st, 'the started record names the run, its pid and its worktree');
  assert.equal(st.pid, kid.pid);
  const sleeper = pidsIn(st.wt).find((p) => /sleep/.test(fs.readFileSync(`/proc/${p}/cmdline`, 'utf8')));
  // the drive (or factory run) is killed: the probe's group goes, its setsid'd dry-run does not
  process.kill(-kid.pid, 'SIGKILL');
  await until(() => !alive(kid.pid));
  assert.ok(alive(sleeper), 'the escapee survived the group kill');
  assert.ok(fs.existsSync(st.wt), 'the scratch worktree is left behind');
  // the next run: the planner fixed the command
  writePlan(root, J, [task('T1', ['node tests/add.test.js'])]);
  const r = F.cli(root, ['plan', 'probe']);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(alive(sleeper), false, 'the escapee (empty environment, own session, cwd in the worktree) is killed');
  assert.equal(fs.existsSync(st.wt), false, 'its worktree is removed');
  assert.equal(probeWorktrees(root).length, 0);
  const ev = events(root).find((e) => e.event === 'plan_probe_interrupted');
  assert.ok(ev && ev.outcome === 'died' && ev.interrupted === 1 && ev.killed >= 1, JSON.stringify(ev));
  const after = P.readStarted(root, J);
  assert.equal(after.finished, true);
  assert.equal(after.interrupted, 0, 'a run that finished resets the count');
});

test('MAJ-2: a probe still running for the same plan is picked up (its result, not a second probe)', async (t) => {
  const root = F.makeRepo(t);
  const J = newJob(root);
  writePlan(root, J, [task('T1', ['node -e "setTimeout(()=>process.exit(1),3000)"'])]);
  const kid = spawn(process.execPath, [F.BIN, 'plan', 'probe'], { cwd: root, stdio: 'ignore', env: { ...process.env, FACTORY_ROOT: '' } });
  const done = new Promise((r) => kid.on('close', r));
  const P = core('probe');
  assert.ok(await until(() => { const s = P.readStarted(root, J); return s && !s.finished && s.pid === kid.pid; }));
  const r = F.cli(root, ['plan', 'probe']);
  await done;
  assert.equal(r.picked_up, true, JSON.stringify(r));
  assert.equal(events(root).filter((e) => e.event === 'plan_probe').length, 1, 'one probe ran');
  assert.equal(events(root).filter((e) => e.event === 'plan_probe_interrupted').length, 0);
});

function interruptedTwice(root, J, n = 1) {
  const P = core('probe');
  const plan = require('../cli/lib/util').hashFile(path.join(F.jobDir(root, J), 'plan.json'));
  const env = core('environment').gateProposal(root, J).hash;
  const wt = path.join(root, '.factory', 'worktrees', `_probe-${J}-424242`);
  fs.writeFileSync(P.STARTED(root, J), JSON.stringify(seal({ version: 1, job: J, plan, environment: env, mode: 'full', probe_id: 'deadbeefdeadbeef', pid: deadPid(), pid_start: '1', wt, at: new Date().toISOString(), deadline_at: new Date(Date.now() + 600e3).toISOString(), interrupted: n, finished: false })));
}

test('MAJ-2: after two interrupted runs the probe is not started again: the job parks with a specific question (a lint only, b your terminal, c no probe), and each answer works', (t) => {
  const root = F.makeRepo(t);
  const J = newJob(root);
  writePlan(root, J, [task('T1', ['node tests/add.test.js'])]);
  interruptedTwice(root, J);
  const r = F.cli(root, ['plan', 'probe']);
  assert.equal(r.needs_answer, true);
  assert.equal(r.parked, true);
  assert.equal(events(root).filter((e) => e.event === 'plan_probe').length, 0, 'nothing ran');
  let st = core('job').load(root, J);
  assert.equal(st.status, 'parked');
  assert.equal(st.park.kind, 'plan_probe');
  assert.deepEqual(st.park.options.map((o) => o.key), ['a', 'b', 'c']);
  assert.match(st.park.options[1].text, /factory plan probe --job/);
  // b: the human runs it in their own terminal while parked: it runs (the question is the gate)
  const own = F.cli(root, ['plan', 'probe']);
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.ok(!own.needs_answer);
  // a: lint only
  interruptedTwice(root, J);
  const ans = core('human').replyToPark(root, { jobId: J, text: 'a', channel: 'chat' });
  assert.equal(ans.resumed, true);
  st = core('job').load(root, J);
  assert.equal(st.probe_override, 'lint');
  assert.equal(fs.existsSync(core('probe').STARTED(root, J)), false, 'the interrupted runs are forgotten');
  const l = F.cli(root, ['plan', 'probe']);
  assert.equal(l.mode, 'lint');
  // c: no probe for this job
  interruptedTwice(root, J);
  assert.equal(F.cli(root, ['plan', 'probe']).needs_answer, true);
  core('human').replyToPark(root, { jobId: J, text: 'c', channel: 'chat' });
  assert.equal(F.cli(root, ['plan', 'probe']).skipped, true);
});

test('MAJ-2: under factory run, the decompose workflow stops probing on the question and recording decompose parks the job with it', async (t) => {
  // the workflow: the planner is not asked to fix an interruption
  const brief = { workflow: 'decompose', mode: 'plan', job: 'J-0001', input_hash: 'h', budgets: {}, probe: true, max_probe_rounds: 3, planner: { prompt: 'PLAN', schema: {}, agent_type: 'factory:planner', max_rounds: 3 } };
  const W = path.join(F.PLUGIN, 'workflows', 'decompose.js');
  const w = await H.run(W, brief, () => ({ valid: true, errors: [], path: 'plan.json' }), { probe: async () => ({ ok: false, needs_answer: true, problems: ['interrupted 2 times'], commands: [] }) });
  assert.equal(w.result.data.probe.stop, 'interrupted');
  assert.deepEqual(w.calls.map((c) => c.opts.label), ['planner #1']);
  // recording: a medium feature at decompose
  const root = F.makeRepo(t);
  const J = newJob(root);
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.clarify(root);
  assert.equal(next(root).step, 'H1');
  F.reply(root, 'approve');
  assert.equal(next(root).step, 'deps');
  F.cli(root, ['deps', 'fetch']);
  const g = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(g, 'ok', { topics: [{ topic: 'codebase', claims: [], unknowns: [] }], degraded: [] }));
  const d = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  F.write(F.jobDir(root, J), 'adr-001-x.md', F.adrText({ job: J }));
  F.record(root, F.envelope(d, 'ok', { options: [], degraded: [], judge: { kind: 'adr', paths: [path.join(F.jobDir(root, J), 'adr-001-x.md')], summary: 's' }, critiques: [{ verdict: 'approve', items: [] }] }));
  assert.equal(next(root).workflow, 'decompose');
  const b = F.cli(root, ['wfargs', 'decompose']);
  writePlan(root, J, [{ id: 'T1', objective: 'fix', allowed_paths: ['src/add.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node tests/add.test.js', covers: ['AC-1'] }] }]);
  interruptedTwice(root, J);
  const r = F.record(root, F.envelope(b, 'ok', { planner: { valid: true, errors: [], path: 'plan.json' }, critique: null, probe: { ok: false, problems: ['interrupted'], stop: 'interrupted' } }));
  assert.equal(r.status, 'park', JSON.stringify(r));
  assert.equal(r.park.kind, 'plan_probe');
  const st = core('job').load(root, J);
  assert.equal(st.park.kind, 'plan_probe');
  assert.equal(st.park.loop, undefined, 'no loop is reset by its answer');
  assert.match(st.park.question, /interrupted 2 times/);
});

test('m7: the sweep keeps a scratch worktree only while its owner (pid and start time) lives; a reused pid does not keep it, and the dead run\'s processes are killed', async (t) => {
  const root = F.makeRepo(t);
  const P = core('probe');
  const dir = path.join(root, '.factory', 'worktrees');
  fs.mkdirSync(dir, { recursive: true });
  // a live pid (this test's) recorded with another start time: a reused pid
  const reused = path.join(dir, `_probe-J-0001-${process.pid}`);
  fs.mkdirSync(path.join(reused, '.factory-probe'), { recursive: true });
  fs.writeFileSync(path.join(reused, '.factory-probe', 'owner.json'), JSON.stringify({ pid: process.pid, start: '1', probe_id: 'p1' }));
  const sleeper = spawn('sleep', ['60'], { cwd: reused, detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  });
  // its real owner, alive: kept
  const ownerKid = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => ownerKid.kill('SIGKILL'));
  await until(() => P.procStat(ownerKid.pid));
  const live = path.join(dir, `_probe-J-0002-${ownerKid.pid}`);
  fs.mkdirSync(path.join(live, '.factory-probe'), { recursive: true });
  fs.writeFileSync(path.join(live, '.factory-probe', 'owner.json'), JSON.stringify({ pid: ownerKid.pid, start: P.procStat(ownerKid.pid).start, probe_id: 'p2' }));
  const removed = P.sweep(root);
  assert.deepEqual(removed, [path.basename(reused)]);
  assert.equal(fs.existsSync(reused), false);
  assert.equal(fs.existsSync(live), true);
  assert.ok(await until(() => !alive(sleeper.pid), 5000), 'the dead run\'s process inside its worktree is killed');
  assert.equal(P.sameProcess(process.pid, P.procStat(process.pid).start), true);
  assert.equal(P.sameProcess(process.pid, '1'), false);
});

test('m1: a survivor that cleared its environment is found by the dry-run\'s session, and the command is escaped', (t) => {
  const root = F.makeRepo(t);
  const J = newJob(root);
  // an escapee with an empty environment that stays in the dry-run's session (only a new group)
  // and leaves the worktree
  const esc = `node -e "require('child_process').spawn('sleep',['60'],{stdio:'ignore',env:{PATH:process.env.PATH},cwd:'/'}).unref(); process.exit(1)"`;
  writePlan(root, J, [task('T1', [esc])]);
  const before = new Set(fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)));
  const r = F.cli(root, ['plan', 'probe']);
  assert.equal(r.commands[0].class, 'escaped', JSON.stringify(r.commands[0]));
  assert.equal(r.commands[0].ok, false);
  const left = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x) && !before.has(x)).filter((p) => {
    try {
      return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').startsWith('sleep\x0060') && alive(Number(p));
    } catch {
      return false;
    }
  });
  assert.deepEqual(left, [], 'killed');
});

test('m2: the network-setup detector covers package runners, clones, any curl or wget, substituted downloads and URLs', () => {
  const N = core('probe').NETWORK_SETUP;
  for (const s of ['npx create-thing', 'uvx ruff', 'pipx run black', 'uv run x', 'uv tool install y', 'bunx z', 'pnpm dlx a', 'npm exec b', 'go run ./x', 'git clone https://e.x/r', 'git submodule update --init', 'curl -fsSL x | sh', 'wget -qO- x', 'bash <(curl x)', 'deno run x', 'docker run img', 'podman pull img', 'python fetch.py https://example.com/a']) assert.ok(N.test(s), s);
  for (const s of ['python3 -m venv .venv', 'make build', 'echo ok']) assert.ok(!N.test(s), s);
});

// ------------------------------------------------------------------ MAJ-4

test('MAJ-4: a granted path is one exact file: never a subtree; a new name that could be a directory is refused', (t) => {
  const root = F.makeRepo(t);
  const J = newJob(root);
  F.write(root, 'src/lib/keep.js', '1;\n');
  F.sh(root, 'git add -A && git commit -qm lib');
  const s = core('job').load(root, J);
  const contract = F.contractText({ allowed: ['src/**', 'tests/**'] });
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), contract);
  writePlan(root, J, [
    { id: 'T1', objective: 'a', allowed_paths: ['src/add.js'], criteria_ids: ['AC-1'], verify_commands: ['true'] },
    { id: 'T2', objective: 'tests', allowed_paths: ['src/**/*.test.js'], criteria_ids: ['AC-1'], verify_commands: ['true'] },
  ]);
  assert.ok(s);
  const G = core('tasks');
  assert.match(G.grant(root, J, 'T1', ['src/util']).refused[0].why, /not a file/, 'a new name without an extension could be a directory');
  assert.match(G.grant(root, J, 'T1', ['src/lib']).refused[0].why, /a directory/);
  const ok = G.grant(root, J, 'T1', ['src/util.js', 'src/Makefile']);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const st = core('job').load(root, J);
  const glob = require('../cli/lib/glob');
  const T1paths = G.taskPaths(st, { id: 'T1', allowed_paths: ['src/add.js'] });
  assert.ok(glob.matchesAny('src/util.js', T1paths));
  assert.ok(!glob.matchesAny('src/util.js/x.test.js', T1paths), 'a granted file never covers a subtree');
  assert.equal(glob.matches('src/lib/a.test.js', '=src/lib'), false);
  assert.equal(glob.matches('src/lib', '=src/lib'), true);
  assert.equal(glob.globsOverlap(['=src/util.js'], ['src/**']), true);
  // the guard: a bare name granted by an older version (stored without "=") opens no subtree
  core('job').mutate(root, J, (x) => { x.tasks.T1 = { ...(x.tasks.T1 || {}), granted_paths: ['src/lib'] }; });
  const rules = require('../hooks/guard-rules');
  const scope = rules.taskScope(root, `${J}-T1`);
  assert.ok(scope.paths.includes('=src/lib'));
  assert.ok(!glob.matchesAny('src/lib/a.test.js', scope.paths));
  // alignment's drift check reads them the same way
  const src = fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'alignment.js'), 'utf8');
  assert.match(src, /granted_paths \|\| \[\]\)\.filter\(\(x\) => typeof x === 'string'\)\.map\(require\('\.\.\/lib\/glob'\)\.exact\)/);
});

// ------------------------------------------------------------------ one reply reader (B1 analogue), m6

test('B1 analogue: one reader (human.readReply) classifies every reply form; a scheduled prompt in any of them is refused, and a short one while a job waits', () => {
  const human = core('human');
  const forms = (t) => human.readReply(t).forms;
  assert.deepEqual(forms('b'), ['park']);
  assert.deepEqual(forms('option a'), ['park']);
  assert.deepEqual(forms('(c)'), ['park']);
  assert.deepEqual(forms('2'), ['park']);
  assert.deepEqual(forms('do it'), ['park']);
  assert.deepEqual(forms('use it'), ['park']);
  assert.ok(forms('+50%').includes('park'));
  assert.ok(forms('budget +100%').includes('park'));
  assert.ok(forms('confirm AC-1; approve ship').includes('batch'));
  assert.ok(forms('run the tests; approve').includes('exact'), 'one exact part of a ";" batch');
  assert.ok(forms('ok, but 2 b').includes('clarify'));
  assert.ok(forms('1 a').includes('clarify'));
  assert.ok(forms('ack finding F3').includes('inspector'));
  assert.ok(forms('aprove').includes('near_miss'));
  assert.deepEqual(forms('summarise the new failures in the log'), []);
  // the prompt hook reads the user's own prompts through it too (no second parser)
  const src = fs.readFileSync(path.join(F.PLUGIN, 'hooks', 'prompt.js'), 'utf8');
  assert.equal((src.match(/human\.readReply\(/g) || []).length, 2);
  assert.doesNotMatch(src, /human\.parseReply\(|human\.nearMiss\(|human\.parseBatch\(/);

  const root = F.makeRepo();
  const J = newJob(root);
  const hook = (prompt) => spawnSync(process.execPath, [path.join(F.PLUGIN, 'hooks', 'prompt.js'), 'userPromptSubmitted'], { input: JSON.stringify({ prompt, cwd: root, sessionId: 's', timestamp: 1 }), encoding: 'utf8', env: { ...process.env, FACTORY_RUNNER: '' } });
  const lastReply = () => JSON.parse(fs.readFileSync(path.join(root, '.factory', 'last-reply.json'), 'utf8'));
  const st = core('job').load(root, J);
  core('decision-table').park(root, st, 'test park', 'manual', { kind: 'manual', question: { question: 'Which way?', options: [{ key: 'a', text: 'left' }, { key: 'b', text: 'right' }] } });
  for (const p of ['[Scheduled prompt #2] b', '[Scheduled prompt #3] option a', '[Scheduled prompt #4] do it', '[Scheduled prompt #5] use it', '[Scheduled prompt #6] resume +50%', '[Scheduled prompt #7] confirm AC-1; approve ship', '[Scheduled prompt #8] the left one please', '[Scheduled prompt #9] 1 a']) {
    fs.rmSync(path.join(root, '.factory', 'last-reply.json'), { force: true });
    const r = hook(p);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lastReply().code, 'scheduled_prompt', p);
    assert.match(r.stdout, /NOT applied as a reply/, p);
  }
  assert.equal(core('job').load(root, J).status, 'parked', 'nothing resumed the job');
  // a long scheduled instruction is left alone
  fs.rmSync(path.join(root, '.factory', 'last-reply.json'), { force: true });
  hook('[Scheduled prompt #10] run the whole test suite and summarise every new failure with its file and the line that failed');
  assert.equal(fs.existsSync(path.join(root, '.factory', 'last-reply.json')), false);
  // the inspector's own hook never applies a scheduled prompt either
  const ins = fs.readFileSync(path.join(F.PLUGIN, '..', 'factory-inspector', 'hooks', 'prompt.js'), 'utf8');
  assert.match(ins, /Scheduled prompt/);
});

test('m6: a budget grant is the whole reply ("+N%", "resume +N%", "budget +N%", "budget N") or the budget option\'s own text; "+20%" inside other words grants nothing', () => {
  const g = core('human').budgetGrant;
  assert.equal(g('+50%'), 1.5);
  assert.equal(g('resume +50%'), 1.5);
  assert.equal(g('budget +100%'), 2);
  assert.equal(g('budget 40', 16), 2.5);
  assert.equal(g('+100% more (resume +100%)'), 2, 'the option text');
  assert.equal(g('make it +20% faster'), null);
  assert.equal(g('also try +20% and see'), null);
  assert.equal(g('the budget 40 is fine', 16), null);
});

// ------------------------------------------------------------------ machine-aware build environments

const MH = require('./helpers/machine');
const T = require('./helpers/tmp');

// PATH shims: a python3 whose venv lacks ensurepip (WSL Ubuntu 22.04 without python3.10-venv),
// virtualenv, a docker that needs sudo, a curl that reaches the index, a sudo that wants a password.
function shims(t) {
  const dir = T.mkdtemp('factory-shims-', t);
  const sh = (name, body) => {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(dir, name), 0o755);
  };
  sh('python3', 'case "$1" in --version) echo "Python 3.10.12";; -m) if [ "$2" = venv ]; then echo "The virtual environment was not created successfully because ensurepip is not" >&2; echo "available.  On Debian/Ubuntu systems, you need to install the python3-venv" >&2; echo "package using the following command." >&2; echo "    apt install python3.10-venv" >&2; exit 1; fi;; esac');
  sh('virtualenv', 'echo "virtualenv 20.25.0 from /usr/lib/python3/dist-packages/virtualenv/__init__.py"');
  sh('docker', 'case "$1" in --version) echo "Docker version 24.0.7";; compose) echo "Docker Compose version v2.21.0";; info) echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1;; esac');
  sh('curl', 'echo "200 0.052"');
  sh('sudo', 'exit 1');
  return dir;
}

test('machine inventory (PATH shims): python versions, a venv that fails for want of ensurepip, virtualenv but no uv, docker needing sudo, sudo with a password, the index reachable; cached per machine; doctor shows it with remedies', (t) => {
  const dir = shims(t);
  const cache = T.mkdtemp('factory-cache-', t);
  const env = { FACTORY_MACHINE_PATH: dir, XDG_CACHE_HOME: cache, FACTORY_MACHINE_FILE: '' };
  const run = (code) => JSON.parse(spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(${code}))`], { cwd: F.PLUGIN, encoding: 'utf8', env: { ...process.env, ...env } }).stdout);
  const inv = run("require('./cli/core/machine').inventory()");
  assert.deepEqual(inv.python.map((p) => [p.cmd, p.version]), [['python3', '3.10.12']]);
  assert.equal(inv.venv.works, false);
  assert.match(inv.venv.why, /ensurepip is not|python3-venv|apt install/);
  assert.ok(inv.tools.virtualenv && !inv.tools.uv && !inv.tools.poetry);
  assert.deepEqual(inv.docker, { present: true, compose: 'docker compose', daemon: 'needs_sudo' });
  assert.equal(inv.sudo, 'password');
  assert.deepEqual([inv.network.pypi.ok, inv.network.pypi.code, inv.network.pypi.ms], [true, 200, 52]);
  assert.equal(run("require('./cli/core/machine').pythonInstaller(require('./cli/core/machine').inventory())"), 'virtualenv');
  // cached: the second call is the first's scan
  assert.equal(run("require('./cli/core/machine').inventory().at"), inv.at);
  assert.ok(fs.readdirSync(path.join(cache, 'factory')).some((f) => /^machine-[0-9a-f]+\.json$/.test(f)));
  // doctor
  const root = F.makeRepo(t);
  const d = F.cli(root, ['doctor', '--machine'], { env });
  const c = (n) => d.checks.find((x) => x.name === `machine: ${n}`);
  assert.equal(c('python3 -m venv').ok, false);
  assert.match(c('python3 -m venv').detail, /Remedy: environments use virtualenv instead/);
  assert.match(c('docker').detail, /daemon needs_sudo[\s\S]*docker group/);
  assert.match(c('python tools').detail, /virtualenv/);
  assert.equal(c('python3 -m venv').level, 'warning', 'a machine fact never blocks the doctor by itself');
});

test('environment proposals use the machine: uv first, poetry for a poetry repo, virtualenv, python3 -m venv only when it works; pip retries', (t) => {
  const E = core('environment');
  const root = F.makeRepo(t);
  F.write(root, 'pyproject.toml', '[project]\nname = "x"\n');
  F.write(root, 'requirements-dev.txt', 'pytest==8.2.0\n');
  F.sh(root, 'git add -A && git commit -qm py');
  const d = (inv) => E.detect(root, { machine: inv });
  const uv = d(MH.inventory({ venv: false, tools: { uv: true, virtualenv: true } }));
  assert.equal(uv.name, 'python-uv');
  assert.deepEqual(uv.setup, ['uv venv -q --allow-existing .venv', 'uv pip install -q --python .venv/bin/python -e .', 'uv pip install -q --python .venv/bin/python -r requirements-dev.txt']);
  assert.equal(uv.env.UV_HTTP_TIMEOUT, '60');
  const ve = d(MH.inventory({ venv: false, tools: { virtualenv: true } }));
  assert.equal(ve.setup[0], 'virtualenv -q .venv');
  assert.ok(ve.setup.slice(1).every((s) => /--retries 5 --timeout 60/.test(s)), JSON.stringify(ve.setup));
  assert.deepEqual(E.lint(ve, { root, machine: MH.inventory({ venv: false, tools: { virtualenv: true } }) }), [], 'what the factory proposes passes its own lint');
  assert.equal(d(MH.inventory({ venv: true })).setup[0], 'python3 -m venv .venv');
  const none = d(MH.inventory({ venv: false }));
  assert.match(none.notes, /install uv \(no sudo\)/);
  assert.equal(E.lint(none, { root, machine: MH.inventory({ venv: false }) })[0].rule, 'venv_no_ensurepip');
  F.write(root, 'pyproject.toml', '[tool.poetry]\nname = "x"\n');
  F.write(root, 'poetry.lock', '\n');
  const po = d(MH.inventory({ venv: true, tools: { poetry: true, virtualenv: true } }));
  assert.equal(po.name, 'python-poetry');
  assert.deepEqual(po.setup, ['poetry install --no-interaction']);
  assert.equal(po.env.POETRY_VIRTUALENVS_IN_PROJECT, 'true');
  // the planner is told the machine and the rules
  assert.match(fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'wfargs.js'), 'utf8'), /This machine \(its tool inventory/);
});

// The J-0001 environment: python3 -m venv without ensurepip, requirements.txt written by T1, a
// Postgres health check that runs once, pip without retries.
const J0001_ENV = {
  version: 1,
  name: 'django-postgres',
  setup: ['python3 -m venv .venv', '.venv/bin/pip install -r requirements.txt'],
  env: { PATH: '{worktree}/.venv/bin:$PATH' },
  services: { up: 'docker compose -f dev/compose.yml up -d db', health: 'pg_isready -h localhost -p 5432', down: 'docker compose -f dev/compose.yml down' },
};
const J0001_PLAN = [
  { id: 'T1', objective: 'scaffold', allowed_paths: ['requirements.txt', 'app/**'], criteria_ids: ['AC-1'], verify_commands: ['python -m pytest -q app'] },
  { id: 'T2', objective: 'feature', allowed_paths: ['app/views.py'], depends_on: ['T1'], criteria_ids: ['AC-1'], verify_commands: ['python -m pytest -q app'] },
];

test('lint (J-0001 reproduced): venv without ensurepip, a missing tool, sudo, setup reading a file T1 creates, a single-shot health check, pip without retries; caught by the plan probe in lint-only mode, before the gate', (t) => {
  const root = F.makeRepo(t);
  F.write(root, 'dev/compose.yml', 'services: {}\n');
  F.sh(root, 'git add -A && git commit -qm compose');
  const J = newJob(root);
  const inv = MH.inventory({ venv: false, tools: { virtualenv: true, docker: true } });
  const mf = MH.use(inv);
  t.after(() => delete process.env.FACTORY_MACHINE_FILE);
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ decompose: { plan_probe: 'lint' } }));
  fs.writeFileSync(core('environment').JOB_PROPOSED(root, J), JSON.stringify({ ...J0001_ENV, setup: [...J0001_ENV.setup, 'uv pip install -q --python .venv/bin/python ruff', 'sudo apt-get install -y libpq-dev'] }));
  writePlan(root, J, J0001_PLAN);
  const r = F.cli(root, ['plan', 'probe'], { env: { FACTORY_MACHINE_FILE: mf } });
  assert.equal(r.mode, 'lint');
  assert.equal(r.ok, false);
  const rules = r.lint.filter((l) => l.task === 'environment').map((l) => l.rule).sort();
  assert.deepEqual([...new Set(rules)], ['missing_tool', 'needs_sudo', 'pip_no_retries', 'setup_reads_plan_file', 'single_health_check', 'venv_no_ensurepip']);
  const p = r.problems.join('\n');
  assert.match(p, /reads requirements\.txt, which T1 creates \(not a bootstrap task\)[\s\S]*Install from pins directly/);
  assert.match(p, /`python3 -m venv` does not work on this machine[\s\S]*use `virtualenv \.venv`/);
  assert.match(p, /health check runs once/);
  assert.match(p, /`uv` is not installed on this machine/);
  assert.equal(r.machine.python3_venv_works, false, 'the record carries the machine it was linted for');
  // the repaired proposal passes the lint: virtualenv, pins installed directly with retries, a health loop
  const FIXED = { ...J0001_ENV, setup: ['virtualenv -q .venv', ".venv/bin/pip install -q --retries 5 --timeout 60 'django==5.0.6' 'psycopg[binary]==3.1.19' pytest==8.2.0"], services: { ...J0001_ENV.services, health: 'for i in $(seq 60); do pg_isready -h localhost -p 5432 && exit 0; sleep 1; done; exit 1' } };
  fs.writeFileSync(core('environment').JOB_PROPOSED(root, J), JSON.stringify(FIXED));
  const r2 = F.cli(root, ['plan', 'probe'], { env: { FACTORY_MACHINE_FILE: mf } });
  assert.deepEqual(r2.lint.filter((l) => l.task === 'environment'), [], JSON.stringify(r2.lint));
  // with a bootstrap T1 the requirements file is fine
  writePlan(root, J, [{ ...J0001_PLAN[0], bootstrap: true }, J0001_PLAN[1]]);
  assert.ok(!core('environment').lint(J0001_ENV, { root, plan: { tasks: [{ ...J0001_PLAN[0], bootstrap: true }] }, machine: inv }).some((l) => l.rule === 'setup_reads_plan_file'));
});

// A job at H3 of a medium feature with this environment proposed (the probe off, as in J-0001).
function toCombinedGate(t, env) {
  const root = F.makeRepo(t);
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ decompose: { plan_probe: false } }));
  const J = newJob(root);
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.clarify(root);
  next(root);
  F.reply(root, 'approve');
  F.cli(root, ['deps', 'fetch']);
  const g = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(g, 'ok', { topics: [{ topic: 'codebase', claims: [], unknowns: [] }], degraded: [] }));
  // design depth (adr@2): the plan's files come from the design's Project layout; T1 writes
  // requirements.txt (the J-0001 setup reads it), so the layout names it
  F.write(F.jobDir(root, J), 'adr-001-x.md', F.adrText({ job: J, layout: F.layoutLines([['src/add.js', 'changed', ['AC-1'], 'add(a, b) returns the sum'], ['tests/add.test.js', 'existing', ['AC-1'], 'proves add(2, 3) is 5'], ['requirements.txt', 'new', ['AC-1'], 'the pinned Python dependencies']]) }));
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  F.record(root, F.envelope(b, 'ok', { options: [], degraded: [], judge: { kind: 'adr', paths: [path.join(F.jobDir(root, J), 'adr-001-x.md')], summary: 's' }, critiques: [{ verdict: 'approve', items: [] }] }));
  b = F.cli(root, ['wfargs', 'decompose']);
  writePlan(root, J, [{ id: 'T1', objective: 'fix', allowed_paths: ['src/add.js', 'requirements.txt'], criteria_ids: ['AC-1'], verify_commands: ['node tests/add.test.js'] }]);
  fs.writeFileSync(core('environment').JOB_PROPOSED(root, J), JSON.stringify(env));
  const rec = F.record(root, F.envelope(b, 'ok', { planner: { valid: true, errors: [], path: 'plan.json' }, critique: { verdict: 'approve', items: [] } }));
  assert.equal(rec.status, 'ok', JSON.stringify(rec.errors || rec));
  assert.equal(next(root).step, 'H3');
  return { root, J };
}

test('J-0001 after H3: the sealed environment is checked before any task; it fails (no ensurepip, requirements.txt from T1, a slow DB checked once); the repair loop escalates, a repair passes in a scratch worktree, one question seals it, the gate is not asked again; no attempt spent', (t) => {
  const dir = shims(t);
  const box = T.mkdtemp('factory-db-', t);
  const ready = path.join(box, 'ready');
  // the slow database: it is ready a moment after it starts
  const BROKEN = { version: 1, name: 'django-postgres', setup: [`${dir}/python3 -m venv .venv`, '.venv/bin/pip install -r requirements.txt'], services: { up: `rm -f ${ready}; (sleep 1; touch ${ready}) >/dev/null 2>&1 &`, health: `test -f ${ready}`, down: `rm -f ${ready}` } };
  const { root, J } = toCombinedGate(t, BROKEN);
  const mf = MH.use(MH.inventory({ venv: false, tools: { virtualenv: true, git: true } }));
  t.after(() => delete process.env.FACTORY_MACHINE_FILE);
  const env = { FACTORY_MACHINE_FILE: mf };
  F.reply(root, 'approve');
  const sealed = core('environment').load(root);
  assert.equal(sealed.name, 'django-postgres');
  const approvedH3 = core('job').load(root, J).approvals.H3.hash;
  // 1. the check, before any task
  let n = F.cli(root, ['next'], { env });
  assert.equal(n.step, 'env_check');
  assert.equal(n.command, `factory env check --job ${J}`);
  const ck = F.cli(root, ['env', 'check', '--job', J], { env });
  assert.equal(ck.ok, false);
  assert.match(ck.broken.reason, /test -f \S*ready exit 1/, 'the database was checked once, before it was ready');
  // 2. the repair loop: the planner in repair mode, with the failure and the machine
  n = F.cli(root, ['next'], { env });
  assert.equal(n.step, 'env_repair');
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'env_repair'], { env });
  const text = fs.readFileSync(b.judge.prompt.split('\n')[1].trim(), 'utf8');
  assert.match(text, /"python3_venv_works": false/);
  for (const rule of ['single_health_check', 'pip_no_retries', 'venv_no_ensurepip', 'setup_reads_plan_file']) assert.match(text, new RegExp(`"rule": "${rule}"`), rule);
  assert.equal(b.judge.model || null, null, 'first round on the planner\'s own model');
  const R = core('env-repair').REPAIR(root, J);
  // round 1: the agent changes nothing useful: no progress, the next round escalates
  fs.writeFileSync(R, JSON.stringify(BROKEN));
  let rec = F.record(root, F.envelope(b, 'ok', { repair: { path: R, summary: 'same' } }));
  assert.equal(rec.status, 'retry', JSON.stringify(rec));
  assert.equal(core('job').load(root, J).status, 'active');
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'env_repair'], { env });
  assert.ok(b.judge.model, 'escalated to the stronger model');
  // round 2: virtualenv, pins installed directly with retries (no requirements.txt), a health loop
  const FIXED = { ...BROKEN, setup: ['mkdir -p .venv/bin'], services: { ...BROKEN.services, health: `for i in $(seq 100); do test -f ${ready} && exit 0; sleep 0.1; done; exit 1` } };
  fs.writeFileSync(R, JSON.stringify(FIXED));
  rec = F.record(root, F.envelope(b, 'ok', { repair: { path: R, summary: 'wait for the database' } }));
  assert.equal(rec.status, 'park', JSON.stringify(rec));
  assert.equal(rec.park.kind, 'environment_repair');
  let st = core('job').load(root, J);
  assert.match(st.park.question, /- setup: .*python3 -m venv[\s\S]*\+ setup: mkdir -p \.venv\/bin[\s\S]*\+ services\.health: for i in/);
  assert.deepEqual(core('environment').load(root).setup, BROKEN.setup, 'not sealed until the human says so');
  // 3. one question, one reply: chat "yes" seals it (the human's channel)
  const ans = core('human').replyToPark(root, { jobId: J, text: 'yes', channel: 'chat' });
  assert.equal(ans.resumed, true);
  assert.deepEqual(core('environment').load(root).setup, FIXED.setup);
  st = core('job').load(root, J);
  assert.notEqual(st.approvals.H3.hash, approvedH3, 'the gate\'s approval moved with the sealed repair');
  assert.ok(st.approvals.H3.environment_repaired);
  n = F.cli(root, ['next'], { env });
  assert.equal(n.step, 'env_check', 'the gate is not asked again; the sealed fix is checked');
  assert.equal(F.cli(root, ['env', 'check', '--job', J], { env }).ok, true);
  n = F.cli(root, ['next'], { env });
  assert.equal(n.workflow, 'realize');
  assert.equal(Object.values(core('job').load(root, J).tasks || {}).reduce((a, x) => a + (x.attempts || 0), 0), 0, 'no task attempt was spent on the environment');
});

test('environment repair: without progress the loop stops with a specific question (never a bare resume); "approve environment" with nothing to seal is refused', (t) => {
  const root = F.makeRepo(t);
  const J = newJob(root);
  const BAD = { version: 1, name: 'bad', setup: ['echo "No matching distribution found for nautobot==9.9" >&2; exit 3'] };
  core('environment').confirm(root, { env: BAD, channel: 'tty' });
  const ER = core('env-repair');
  ER.checkForJob(root, core('job').load(root, J));
  assert.equal(ER.routerAction({ root, state: core('job').load(root, J) }).step, 'env_repair');
  let last = null;
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(ER.REPAIR(root, J), JSON.stringify(BAD));
    last = ER.record(root, core('job').load(root, J), {});
    if (last.status === 'park') break;
  }
  assert.equal(last.status, 'park');
  assert.equal(last.park_kind, 'environment_broken');
  assert.match(last.park_question.question, /still does not set up on this machine \(echo "No matching distribution/);
  assert.equal(last.park_question.options.length, 3);
  assert.throws(() => F.reply(root, 'approve environment'), /no repaired build environment waiting/);
  assert.equal(core('human').parseReply('approve environment').cmd, 'approve_environment');
  assert.ok(core('human').readReply('approve environment').reply);
});

test('proxies and index URLs reach the probe and a proposal\'s check by default; a login in their URL is stripped (unless policy decompose.probe_proxy_credentials) and redacted in output; probe_proxy false keeps them out', (t) => {
  const root = F.makeRepo(t);
  const J = newJob(root);
  const show = `node -e "console.log('p='+process.env.HTTPS_PROXY+' l='+process.env.https_proxy+' n='+process.env.NO_PROXY+' i='+process.env.PIP_INDEX_URL+' u='+process.env.UV_INDEX_URL+' r='+process.env.npm_config_registry); console.log('echo http://bob:s3cr'+'3tpw@proxy.corp:8080'); process.exit(1)"`;
  writePlan(root, J, [task('T1', [show])]);
  const env = { HTTPS_PROXY: 'http://bob:s3cr3tpw@proxy.corp:8080', https_proxy: 'http://bob:s3cr3tpw@proxy.corp:8080', NO_PROXY: 'localhost,.corp', PIP_INDEX_URL: 'https://ci:idxtoken99@pypi.corp/simple', UV_INDEX_URL: 'https://pypi.corp/simple', npm_config_registry: 'https://npm.corp/' };
  let r = F.cli(root, ['plan', 'probe'], { env });
  const tail = r.commands[0].tail;
  assert.match(tail, /p=http:\/\/proxy\.corp:8080 l=http:\/\/proxy\.corp:8080 n=localhost,\.corp i=https:\/\/pypi\.corp\/simple u=https:\/\/pypi\.corp\/simple r=https:\/\/npm\.corp\//, tail);
  assert.match(tail, /http:\/\/\[redacted\]@proxy\.corp:8080/, 'a login printed in output is redacted');
  assert.doesNotMatch(fs.readFileSync(core('probe').FILE(root, J), 'utf8'), /s3cr3tpw|idxtoken99/);
  // the credentials themselves only when the repo says so
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ decompose: { probe_proxy_credentials: true } }));
  r = F.cli(root, ['plan', 'probe'], { env });
  assert.match(r.commands[0].tail, /p=http:\/\/\[redacted\]@proxy\.corp:8080/, 'passed with its login, still redacted in what is recorded');
  assert.doesNotMatch(fs.readFileSync(core('probe').FILE(root, J), 'utf8'), /s3cr3tpw/);
  // off
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ decompose: { probe_proxy: false } }));
  r = F.cli(root, ['plan', 'probe'], { env });
  assert.match(r.commands[0].tail, /p=undefined l=undefined n=undefined i=undefined/);
  // a proposal's env check gets the same environment
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({}));
  const out = path.join(T.mkdtemp('factory-proxy-', t), 'seen');
  fs.writeFileSync(path.join(root, '.factory', 'environment.proposed.json'), JSON.stringify({ version: 1, name: 'p', setup: [`echo "$HTTPS_PROXY $PIP_INDEX_URL" > ${out}`] }));
  assert.equal(F.cli(root, ['env', 'check', '--proposed'], { env }).ok, true);
  assert.equal(fs.readFileSync(out, 'utf8').trim(), 'http://proxy.corp:8080 https://pypi.corp/simple');
});
