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
