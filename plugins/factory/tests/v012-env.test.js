'use strict';
// 0.12: the shared dependency environment. Dependencies are installed ONCE per (machine, lockfile,
// tool) into .factory/envs/<key>/, each worktree gets a thin overlay that imports its own code,
// the tool is chosen by one function and recorded with its reason, doctor and env status say
// what happened, the user's own .venv is never touched, and a sealed 0.11 environment keeps
// working until the human confirms the shared one.
// The installs are a fake installer that counts itself (no network): a venv made with
// python3 -m venv --without-pip, a fake dependency, a fake pytest and a console script.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const F = require('./helpers/fixture');
const MH = require('./helpers/machine');
const T = require('./helpers/tmp');

const core = (m) => require(`../cli/core/${m}`);
const E = core('environment');
const S = core('envstore');
const human = core('human');
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !human.AGENT_ENV.some(([a]) => a === k)));
const say = (root, text) => {
  spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'prompt.js'), 'userPromptSubmitted'], { cwd: root, input: JSON.stringify({ prompt: text, cwd: root, sessionId: 'human' }), encoding: 'utf8', env: { ...clean, FACTORY_ROOT: '' } });
  return JSON.parse(fs.readFileSync(path.join(root, '.factory', 'last-reply.json'), 'utf8'));
};

const INSTALL = `#!/usr/bin/env bash
# fake-install.sh <env> <count file> [sleep seconds] [fail]
set -euo pipefail
env="$1"; count="$2"; nap="\${3:-0}"; fail="\${4:-}"
echo "install $$ $PWD" >> "$count"
sleep "$nap"
if [ -n "$fail" ]; then echo "ERROR: No matching distribution found for nautobot==9.9 (token ghp_abcdefghijklmnop1234)" >&2; exit 3; fi
python3 -m venv --without-pip "$env/venv"
site=$("$env/venv/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
mkdir -p "$site/fakedep" "$site/fakepytest"
echo 'VERSION = "1.0"' > "$site/fakedep/__init__.py"
cat > "$site/fakepytest/__init__.py" <<'PY'
import glob, importlib.util, os, sys
def main():
    fails = 0
    for f in sorted(glob.glob('tests/test_*.py')):
        spec = importlib.util.spec_from_file_location(os.path.basename(f)[:-3], f)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        for n in sorted(dir(m)):
            if n.startswith('test_'):
                try:
                    getattr(m, n)()
                    print('PASS', n)
                except Exception as e:
                    fails += 1
                    print('FAIL', n, e)
    return 1 if fails else 0
PY
printf '#!%s\\nimport sys\\nfrom fakepytest import main\\nsys.exit(main())\\n' "$env/venv/bin/python" > "$env/venv/bin/pytest"
printf '#!%s\\nimport myapp, fakedep\\nprint("myapp", myapp.WHO, "fakedep", fakedep.VERSION)\\n' "$env/venv/bin/python" > "$env/venv/bin/fakedep-who"
chmod +x "$env/venv/bin/pytest" "$env/venv/bin/fakedep-who"
`;
// the project step: an "editable install" of the worktree (a .pth naming it) and the project's own
// console script, both in the overlay
const PROJECT = `#!/usr/bin/env bash
set -euo pipefail
wt="$1"
py="$wt/.factory-venv/bin/python"
"$py" -c 'import sysconfig, sys; open(sysconfig.get_paths()["purelib"] + "/_myapp_editable.pth", "w").write(sys.argv[1] + "\\n")' "$wt"
printf '#!%s\\nimport myapp\\nprint("myapp-who", myapp.WHO)\\n' "$py" > "$wt/.factory-venv/bin/myapp-who"
chmod +x "$wt/.factory-venv/bin/myapp-who"
`;

function kit(t) {
  const dir = T.mkdtemp('factory-fakeinst-', t);
  fs.writeFileSync(path.join(dir, 'fake-install.sh'), INSTALL, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'fake-project.sh'), PROJECT, { mode: 0o755 });
  const count = path.join(dir, 'count');
  return {
    dir,
    count,
    installs: () => (fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim().split('\n').filter(Boolean).length : 0),
    env: ({ nap = 0, fail = false } = {}) => ({
      version: 2,
      name: 'fake-python',
      tool: 'fake',
      reason: 'a fake installer that counts its installs',
      deps: [`bash ${dir}/fake-install.sh {env} ${count} ${nap}${fail ? ' fail' : ''}`],
      deps_key: ['pyproject.toml'],
      overlay: 'python',
      project: [`bash ${dir}/fake-project.sh {worktree}`],
      env: { VIRTUAL_ENV: '{worktree}/.factory-venv', PATH: '{worktree}/.factory-venv/bin:$PATH' },
      ignore: ['/.factory-venv/'],
      timeout_seconds: 120,
    }),
  };
}

function pyRepo(t) {
  const root = F.makeRepo(t);
  F.write(root, 'pyproject.toml', '[project]\nname = "myapp"\nversion = "0.1.0"\n');
  F.write(root, 'myapp/__init__.py', 'WHO = "root"\n');
  F.write(root, 'tests/test_who.py', 'import myapp, os\n\ndef test_who():\n    assert myapp.WHO == os.path.basename(os.getcwd()), (myapp.WHO, os.getcwd())\n');
  F.sh(root, 'git rm -q -r src tests/add.test.js && git add -A && git commit -qm py');
  // the developer's own .venv in the checkout: never touched
  F.write(root, '.venv/MINE', 'my own venv\n');
  return root;
}
// a worktree whose myapp says who it is (its directory name), committed there
function worktree(root, name) {
  const wt = path.join(root, '.factory', 'worktrees', name);
  F.sh(root, `git worktree add -q --detach ${wt} HEAD`);
  F.write(wt, 'myapp/__init__.py', `WHO = "${name}"\n`);
  F.sh(wt, 'git -c user.email=t@e -c user.name=t commit -qam who');
  return wt;
}
const run = (r, wt, cmd, cwd = wt) => spawnSync('bash', ['-c', E.wrap(r.env, r.vars, cmd)], { cwd, encoding: 'utf8' });
const seal = (root, e) => E.confirm(root, { env: e, channel: 'tty' });
const state = { id: 'J-0001' };

test('shared env: dependencies are installed once for N tasks (and the job worktree); each overlay imports its own worktree\'s code, console scripts and pytest included', (t) => {
  const root = pyRepo(t);
  const K = kit(t);
  seal(root, K.env());
  const names = ['J-0001-T1', 'J-0001-T2', 'J-0001-T3', 'J-0001-T4', 'J-0001'];
  const results = names.map((n) => {
    const wt = worktree(root, n);
    const r = E.ensure(root, state, { taskId: n === 'J-0001' ? null : n.split('-').pop(), wt });
    assert.equal(r.ok, true, JSON.stringify(r.broken));
    return [n, wt, r];
  });
  assert.equal(K.installs(), 1, 'one install for five worktrees');
  assert.equal(results[0][2].shared.built, true);
  assert.ok(results.slice(1).every(([, , r]) => r.shared.reused && !r.shared.built), 'the others reuse it');
  const dirs = new Set(results.map(([, , r]) => r.shared.dir));
  assert.equal(dirs.size, 1);
  assert.match([...dirs][0], /\.factory\/envs\/[0-9a-f]{16}$/);
  for (const [n, wt, r] of results) {
    // from a directory outside the worktree: the code comes from the overlay, not from the cwd
    const py = run(r, wt, 'python -c "import myapp, sys; print(myapp.WHO, sys.prefix)"', T.mkdtemp('factory-cwd-', t));
    assert.equal(py.status, 0, py.stderr);
    assert.equal(py.stdout.split(' ')[0], n, `${n} imports its own code`);
    assert.equal(fs.realpathSync(py.stdout.trim().split(' ')[1]), fs.realpathSync(path.join(wt, '.factory-venv')));
    assert.match(run(r, wt, 'fakedep-who').stdout, new RegExp(`^myapp ${n} fakedep 1\\.0`), 'a shared console script runs on the overlay');
    assert.match(run(r, wt, 'myapp-who').stdout, new RegExp(`^myapp-who ${n}\\n`), "the project's own console script");
    const pt = run(r, wt, 'pytest');
    assert.equal(pt.status, 0, pt.stdout + pt.stderr);
    assert.match(pt.stdout, /PASS test_who/);
    assert.equal(F.sh(wt, 'git status --porcelain'), '', '.factory-venv is kept out of git status');
  }
  // a second call is cached per worktree: no install, no project step
  const again = E.ensure(root, state, { taskId: 'T1', wt: results[0][1] });
  assert.equal(again.cached, true);
  assert.deepEqual(again.ran, []);
  assert.equal(K.installs(), 1);
  // the user's own .venv and checkout: untouched, and not hidden from git status by the factory
  assert.deepEqual(fs.readdirSync(path.join(root, '.venv')), ['MINE']);
  assert.equal(spawnSync('git', ['check-ignore', '-q', '.venv'], { cwd: root }).status, 1, 'the root .venv is not ignored by anything the factory added');
  assert.match(F.sh(root, 'git status --porcelain'), /\?\? \.venv\//);
  const ex = fs.readFileSync(E.excludeReport(root).file, 'utf8');
  assert.match(ex, /# >>> copilot-factory: worktree build environments[^\n]*\n\/\.factory-venv\/\n# <<< copilot-factory\n/);
  assert.throws(() => E.ensure(root, state, { taskId: 'T9', wt: root }), /never sets up the root checkout/);
});

test('a lockfile change builds a new shared env (only for the worktree that changed it); the others keep theirs', (t) => {
  const root = pyRepo(t);
  const K = kit(t);
  seal(root, K.env());
  const a = worktree(root, 'J-0001-T1');
  const b = worktree(root, 'J-0001-T2');
  const ra = E.ensure(root, state, { taskId: 'T1', wt: a });
  E.ensure(root, state, { taskId: 'T2', wt: b });
  assert.equal(K.installs(), 1);
  F.write(b, 'pyproject.toml', '[project]\nname = "myapp"\nversion = "0.1.0"\ndependencies = ["fakedep>=1"]\n');
  F.sh(b, 'git -c user.email=t@e -c user.name=t commit -qam dep');
  const rb = E.ensure(root, state, { taskId: 'T2', wt: b });
  assert.equal(rb.ok, true);
  assert.equal(rb.shared.built, true);
  assert.equal(K.installs(), 2, 'the new key is built once');
  assert.notEqual(rb.shared.key, ra.shared.key);
  assert.equal(E.ensure(root, state, { taskId: 'T1', wt: a }).cached, true, 'T1 is unaffected');
  // a non-key file changes nothing
  F.write(b, 'README.md', 'x\n');
  assert.equal(E.ensure(root, state, { taskId: 'T2', wt: b }).cached, true);
  assert.equal(K.installs(), 2);
});

const child = (root, wt, task, envObj) => new Promise((resolve) => {
  const code = `const E = require(${JSON.stringify(path.join(F.PLUGIN, 'cli', 'core', 'environment.js'))});
const r = E.ensure(${JSON.stringify(root)}, { id: 'J-0001' }, { taskId: ${JSON.stringify(task)}, wt: ${JSON.stringify(wt)}, env: ${JSON.stringify(envObj)} });
process.stdout.write(JSON.stringify({ ok: r.ok, shared: r.shared, cmd: r.broken ? r.broken.cmd : null, reason: r.broken ? r.broken.reason : null }));`;
  const p = spawn(process.execPath, ['-e', code], { cwd: root });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', () => resolve(JSON.parse(out || '{}')));
});

test('concurrency: parallel tasks wait for one build and reuse it; a build that fails while they wait is not run again for each', async (t) => {
  const root = pyRepo(t);
  const K = kit(t);
  const env = { ...K.env({ nap: 2 }), version: 2 };
  seal(root, env);
  const wts = ['J-0001-T1', 'J-0001-T2', 'J-0001-T3', 'J-0001-T4'].map((n) => worktree(root, n));
  const rs = await Promise.all(wts.map((wt, i) => child(root, wt, `T${i + 1}`, env)));
  assert.ok(rs.every((r) => r.ok), JSON.stringify(rs));
  assert.equal(K.installs(), 1, 'one install for four parallel tasks');
  assert.equal(rs.filter((r) => r.shared.built).length, 1);
  assert.ok(rs.filter((r) => !r.shared.built).every((r) => r.shared.reused), JSON.stringify(rs));
  assert.ok(rs.some((r) => r.shared.waited_ms > 500), 'the others waited for the lock');
  assert.ok(!fs.readdirSync(S.STORE(root)).some((f) => f.endsWith('.lock')), 'the lock is released');
  // a failing install: the same failure for everyone who waited, from one run
  const K2 = kit(t);
  const bad = K2.env({ nap: 2, fail: true });
  const wts2 = ['J-0002-T1', 'J-0002-T2', 'J-0002-T3'].map((n) => worktree(root, n));
  const fs2 = await Promise.all(wts2.map((wt, i) => child(root, wt, `T${i + 1}`, bad)));
  assert.ok(fs2.every((r) => !r.ok), JSON.stringify(fs2));
  assert.equal(K2.installs(), 1, 'the failing install ran once, not once per waiting task');
  assert.ok(fs2.every((r) => /No matching distribution found for nautobot==9\.9/.test(r.reason)));
  // the failure is recorded for factory env status, redacted
  const st = E.status(root);
  assert.equal(st.last_failure.phase, 'deps');
  assert.match(st.last_failure.tail, /No matching distribution/);
  assert.doesNotMatch(JSON.stringify(st), /ghp_abcdefghijklmnop1234/, 'a token in the output is redacted');
  assert.match(st.last_failure.next_step, /factory env check --job/);
});

test('runs without your credentials (probe, proposal check, repair candidate) reuse the shared env read-only, or build a private one in their scratch worktree; never write .factory/envs', (t) => {
  const root = pyRepo(t);
  const K = kit(t);
  const env = K.env();
  seal(root, env);
  const wt = worktree(root, 'J-0001-T1');
  E.ensure(root, state, { taskId: 'T1', wt });
  assert.equal(K.installs(), 1);
  const snapshot = () => fs.readdirSync(S.STORE(root)).sort().map((n) => `${n}:${fs.existsSync(path.join(S.STORE(root), n, 'used')) ? fs.statSync(path.join(S.STORE(root), n, 'used')).mtimeMs : ''}`).join(',');
  const before = snapshot();
  const base = { PATH: process.env.PATH, HOME: T.mkdtemp('factory-home-', t), LANG: 'C' };
  const scratch = path.join(root, '.factory', 'worktrees', '_probe-J-0001-1');
  F.sh(root, `git worktree add -q --detach ${scratch} HEAD`);
  const r = E.withBaseEnv(base, () => E.ensure(root, null, { taskId: 'probe', wt: scratch, env }));
  assert.equal(r.ok, true, JSON.stringify(r.broken));
  assert.equal(r.shared.reused, true);
  assert.equal(K.installs(), 1, 'reused: nothing installed');
  assert.match(run(r, scratch, 'python -c "import myapp; print(myapp.WHO)"').stdout, /^root/, 'the scratch worktree\'s own code');
  // a key no shared env has: built privately inside the scratch worktree
  F.write(scratch, 'pyproject.toml', '[project]\nname = "myapp"\nversion = "0.2.0"\n');
  const scratch2 = path.join(root, '.factory', 'worktrees', '_probe-J-0001-2');
  F.sh(root, `git worktree add -q --detach ${scratch2} HEAD`);
  F.write(scratch2, 'pyproject.toml', '[project]\nname = "myapp"\nversion = "0.2.0"\n');
  const p = E.withBaseEnv(base, () => E.ensure(root, null, { taskId: 'probe', wt: scratch2, env }));
  assert.equal(p.ok, true, JSON.stringify(p.broken));
  assert.equal(p.shared.private, true);
  assert.ok(p.shared.dir.startsWith(path.join(scratch2, '.factory-probe')), p.shared.dir);
  assert.equal(K.installs(), 2);
  assert.equal(snapshot(), before, 'the shared store was not written (no new env, no last-use stamp)');
});

test('garbage collection keeps the newest N and every env a worktree uses, and shows sizes', (t) => {
  const root = pyRepo(t);
  const K = kit(t);
  seal(root, K.env());
  const wt = worktree(root, 'J-0001-T1');
  const keep = worktree(root, 'J-0001-T2');
  E.ensure(root, state, { taskId: 'T2', wt: keep }); // the first key stays in use by T2
  const keys = [];
  const prev = process.env.FACTORY_ENV_KEEP;
  process.env.FACTORY_ENV_KEEP = '2';
  t.after(() => (prev === undefined ? delete process.env.FACTORY_ENV_KEEP : (process.env.FACTORY_ENV_KEEP = prev)));
  for (let i = 1; i <= 4; i++) {
    F.write(wt, 'pyproject.toml', `[project]\nname = "myapp"\nversion = "1.${i}.0"\n`);
    F.sh(wt, `git -c user.email=t@e -c user.name=t commit -qam v${i}`);
    keys.push(E.ensure(root, state, { taskId: 'T1', wt }).shared.key);
  }
  assert.equal(K.installs(), 5);
  const left = S.list(root).map((x) => x.key);
  const first = S.list(root).find((x) => x.used_by.includes('J-0001-T2'));
  assert.ok(first, 'the env T2 uses is kept');
  assert.ok(left.includes(keys[3]) && left.includes(keys[2]), 'the newest two are kept');
  assert.ok(!left.includes(keys[0]) && !left.includes(keys[1]), `older unused ones are removed: ${left}`);
  // by hand (not for agents), with sizes
  const g = F.cli(root, ['env', 'gc', '--keep', '1']);
  assert.ok(Array.isArray(g.removed) && g.removed.length === 1, JSON.stringify(g));
  assert.match(g.removed[0].size, /\d+ (B|kB|MB|GB)/);
  assert.match(g.freed, /\d/);
  assert.equal(F.cli(root, ['env', 'gc'], { env: { FACTORY_RUNNER: '1' } }).code, 'agent_not_allowed');
  assert.ok(E.status(root).shared_envs.envs.every((x) => /\d+ (B|kB|MB|GB)/.test(x.size)));
});

test('tool choice: one function, recorded in the proposal with its reason (uv, poetry for a poetry repo, virtualenv, venv only when it works); node and Nautobot use the shared model too', (t) => {
  const root = F.makeRepo(t);
  F.write(root, 'pyproject.toml', '[project]\nname = "x"\n[project.optional-dependencies]\ndev = ["pytest"]\n[build-system]\nrequires = ["hatchling>=1.18", "evil; rm -rf /"]\nbuild-backend = "hatchling.build"\n');
  F.write(root, 'requirements-dev.txt', 'pytest==8.2.0\n');
  F.sh(root, 'git add -A && git commit -qm py');
  const d = (inv) => E.detect(root, { machine: inv });
  const uv = d(MH.inventory({ venv: false, tools: { uv: true, virtualenv: true } }));
  assert.equal(uv.version, 2);
  assert.equal(uv.tool, 'uv');
  assert.match(uv.reason, /uv is installed/);
  assert.deepEqual(uv.deps, ['uv venv -q --allow-existing {env}/venv', 'uv pip install -q --python {env}/venv/bin/python -r pyproject.toml --extra dev', "uv pip install -q --python {env}/venv/bin/python 'hatchling>=1.18'", 'uv pip install -q --python {env}/venv/bin/python -r requirements-dev.txt']);
  assert.deepEqual(uv.project, ['uv pip install -q --python {worktree}/.factory-venv/bin/python --no-deps --no-build-isolation -e .']);
  assert.equal(uv.overlay, 'python');
  assert.equal(uv.env.VIRTUAL_ENV, '{worktree}/.factory-venv');
  assert.deepEqual(E.problems(E.essence(uv)), []);
  assert.deepEqual(E.lint(uv, { root, machine: MH.inventory({ venv: false, tools: { uv: true } }) }), []);
  for (const c of [...uv.deps, ...uv.project]) assert.doesNotMatch(c, /[;$`|&()]|rm -rf/, c);
  const ve = d(MH.inventory({ venv: false, tools: { virtualenv: true } }));
  assert.equal(ve.tool, 'virtualenv');
  assert.equal(ve.deps[0], 'virtualenv -q {env}/venv');
  assert.deepEqual(E.lint(ve, { root, machine: MH.inventory({ venv: false, tools: { virtualenv: true } }) }), [], 'its pip installs retry; the editable install is --no-index');
  assert.ok(ve.deps.some((c) => /pip uninstall -q -y x$/.test(c)), 'the project itself never stays in the shared venv');
  assert.equal(d(MH.inventory({ venv: true })).tool, 'venv');
  const none = d(MH.inventory({ venv: false }));
  assert.equal(none.tool, 'none-available');
  assert.match(none.reason, /install uv without sudo/);
  assert.equal(E.lint(none, { root, machine: MH.inventory({ venv: false }) })[0].rule, 'venv_no_ensurepip');
  // a poetry repo with its lock: poetry, with the venv made by uv
  F.write(root, 'pyproject.toml', '[tool.poetry]\nname = "x"\n[build-system]\nrequires = ["poetry-core>=1.0.0"]\n');
  F.write(root, 'poetry.lock', '\n');
  const po = d(MH.inventory({ venv: true, tools: { poetry: true, uv: true } }));
  assert.equal(po.tool, 'poetry');
  assert.match(po.reason, /poetry\.lock[\s\S]*uv makes the venv/);
  assert.deepEqual(po.deps.slice(0, 2), ['uv venv -q --seed --allow-existing {env}/venv', 'VIRTUAL_ENV={env}/venv poetry install --no-root --no-interaction']);
  assert.equal(E.toolChoice(root, { machine: MH.inventory({ venv: true, tools: { uv: true } }) }).tool, 'uv', 'no poetry: uv');
  // node: installed once, linked
  const n = F.makeRepo(t);
  F.write(n, 'package.json', '{"devDependencies":{"mocha":"1"}}');
  F.write(n, 'package-lock.json', '{}');
  const nd = E.detect(n);
  assert.deepEqual([nd.tool, nd.overlay, nd.deps, nd.ignore], ['npm', 'node', ['npm ci --no-audit --no-fund'], ['/node_modules']]);
  F.write(n, 'package.json', '{"workspaces":["packages/*"],"devDependencies":{"mocha":"1"}}');
  const ws = E.detect(n);
  assert.deepEqual([ws.overlay, ws.deps, ws.project], ['none', [], ['npm ci --no-audit --no-fund']]);
  assert.match(ws.reason, /workspaces/);
  // Nautobot: the image once, a compose project per worktree
  F.write(root, 'pyproject.toml', '[tool.poetry]\nname = "nautobot-app-golden"\n[tool.poetry.dependencies]\nnautobot = "^2.0"\n');
  F.write(root, 'tasks.py', 'from invoke import Collection, task\nnamespace = Collection("nautobot_golden")\n');
  const nb = E.detect(root);
  assert.deepEqual([nb.version, nb.deps, nb.overlay, nb.teardown], [2, ['invoke build'], 'none', 'invoke destroy']);
  assert.equal(nb.env.INVOKE_NAUTOBOT_GOLDEN_PROJECT_NAME, 'factory-{slug}');
  // the schema
  assert.match(E.problems({ version: 2, setup: ['x'] }).join(), /setup is a version-1 field/);
  assert.match(E.problems({ version: 1, deps: ['x'] }).join(), /deps needs version 2/);
  assert.match(E.problems({ version: 2, overlay: 'ruby' }).join(), /overlay must be python, node or none/);
  assert.match(E.problems({ version: 3 }).join(), /version must be 1/);
});

test('migration: a sealed 0.11 environment keeps working per worktree; factory next offers the shared one in one line; one reply switches', (t) => {
  const root = pyRepo(t);
  const K = kit(t);
  // a 0.11 environment, sealed as 0.11 wrote it (version 1, setup in every worktree)
  const OLD = { version: 1, name: 'python-venv', setup: ['python3 -m venv .venv', '.venv/bin/pip install -q --retries 5 --timeout 60 -e .'], cache_key: ['pyproject.toml'], env: { VIRTUAL_ENV: '{worktree}/.venv', PATH: '{worktree}/.venv/bin:$PATH', DJANGO_SETTINGS_MODULE: 'app.settings' }, services: { up: 'true', health: 'true' }, ignore: ['.venv/'], timeout_seconds: 1500 };
  const sealed = core('../lib/seal').seal({ ...OLD, confirmed: { at: '2026-09-01T00:00:00Z', via: 'chat' } });
  fs.writeFileSync(E.FILE(root), JSON.stringify(sealed, null, 2));
  assert.equal(E.load(root).version, 1, 'a 0.11 seal still verifies');
  assert.equal(E.fullHash(E.load(root)), E.fullHash(OLD), 'its hash (what gates bound) is unchanged');
  // the old setup still runs, per worktree (a legacy setup step we can count)
  const legacy = { ...OLD, setup: [`echo legacy >> ${K.count}`] };
  for (const n of ['J-0001-T1', 'J-0001-T2']) assert.equal(E.ensure(root, null, { taskId: n, wt: worktree(root, n), env: legacy }).ok, true);
  assert.equal(K.installs(), 2, '0.11: one setup per worktree, as before');
  // the offer: the shared model of it, with its services, variables and timeout kept
  const up = E.upgradeOf(root, E.load(root));
  assert.equal(up.env.version, 2);
  assert.deepEqual(up.env.services, OLD.services);
  assert.equal(up.env.env.DJANGO_SETTINGS_MODULE, 'app.settings');
  assert.equal(up.env.env.VIRTUAL_ENV, '{worktree}/.factory-venv');
  assert.equal(up.env.timeout_seconds, 1500);
  const nt = E.notice(root);
  assert.equal(nt.status, 'upgrade');
  assert.equal(nt.message.split('\n').length, 1, 'one line');
  assert.match(nt.message, new RegExp(`installs them once per lockfile[\\s\\S]*confirm environment ${nt.hash}`));
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  assert.ok(J);
  const nx = F.cli(root, ['next']);
  assert.equal((nx.environment || {}).status, 'upgrade', JSON.stringify(nx).slice(0, 600));
  assert.match(F.cli(root, ['env', 'show']).how, /0\.12 shared model/);
  // the human switches with one reply
  const r = say(root, `confirm environment ${nt.hash}`);
  assert.equal(r.status, 'applied', JSON.stringify(r));
  const now = E.load(root);
  assert.equal(now.version, 2);
  assert.equal(now.tool, 'venv');
  assert.ok(now.deps.length && now.project.length);
  assert.equal(E.notice(root), null, 'no more offer');
  // a 0.11 setup with a step of its own is not guessed at
  const custom = { ...OLD, setup: ['bash scripts/mkenv.sh'] };
  assert.match(E.upgradeOf(root, custom).why, /steps the shared model does not cover/);
});

test('factory env check builds the shared env once; the next check and every task reuse it (CLI)', (t) => {
  const root = pyRepo(t);
  const K = kit(t);
  seal(root, K.env());
  const c1 = F.cli(root, ['env', 'check']);
  assert.equal(c1.ok, true, JSON.stringify(c1));
  const c2 = F.cli(root, ['env', 'check']);
  assert.equal(F.cli(root, ['env', 'check'], { env: { FACTORY_RUNNER: '1' } }).code, 'agent_not_allowed', 'an agent checks only a proposal (review m-8)');
  assert.equal(c2.ok, true);
  assert.equal(K.installs(), 1, 'the second check reuses it');
  for (const n of ['J-0001-T1', 'J-0001-T2']) E.ensure(root, state, { taskId: n, wt: worktree(root, n) });
  assert.equal(K.installs(), 1);
  assert.equal(F.sh(root, 'git worktree list').split('\n').filter((l) => /_envcheck/.test(l)).length, 0);
});

test('doctor: a "build environment" section (tool and why, python3 -m venv with its age, shared envs, your .venv never touched, last check); the tool inventory only under --machine; env status says what happened', (t) => {
  const root = pyRepo(t);
  const K = kit(t);
  // a 0.11 environment added `.venv/` to info/exclude: doctor points it out
  fs.appendFileSync(E.excludeReport(root).file, '.venv/\n');
  seal(root, K.env());
  E.ensure(root, state, { taskId: 'T1', wt: worktree(root, 'J-0001-T1') });
  const d = F.cli(root, ['doctor']);
  const c = (n) => d.checks.find((x) => x.name === n) || {};
  assert.ok(!d.checks.some((x) => /^machine:/.test(x.name)), 'no tool dump without --machine');
  assert.match(c('build environment').detail, /fake-python[\s\S]*shared model/);
  assert.match(c('build environment: tool').detail, /the sealed environment uses fake \(a fake installer that counts its installs\); on this machine now the factory would choose venv: python3 -m venv works/);
  assert.match(c('build environment: python3 -m venv').detail, /works \(scanned (just now|\d+ (min|h) ago); factory doctor --machine scans again\)/);
  assert.match(c('build environment: shared').detail, /1 in .*\.factory\/envs \(\d+ (B|kB|MB)\); newest [0-9a-f]{16}: built .* with fake in \d+ s, used by 1 worktree/);
  assert.match(c('build environment: your .venv').detail, /\.venv exists: the factory never creates, changes or deletes it and never sets up the root checkout[\s\S]*has a "\.venv\/" line/);
  assert.match(c('build environment: last check').detail, /none yet/);
  assert.match(c('build environment: guide').detail, /docs\/ENVIRONMENT\.md/);
  assert.equal(d.build_environment.your_venv.touched_by_factory, false);
  assert.ok(fs.existsSync(d.build_environment.guide));
  const m = F.cli(root, ['doctor', '--machine']);
  assert.ok(m.checks.some((x) => x.name === 'machine: python tools'));
  // env status: read-only, agents may run it
  const s = F.cli(root, ['env', 'status'], { env: { FACTORY_RUNNER: '1' } });
  assert.equal(s.tool.chosen, 'fake');
  assert.equal(s.tool.reason, 'a fake installer that counts its installs');
  assert.match(s.machine_now.tool, /venv/);
  assert.equal(s.shared_envs.current_built, true);
  assert.equal(s.shared_envs.envs[0].used_by[0], 'J-0001-T1');
  assert.ok(s.shared_envs.envs[0].built_at && s.shared_envs.envs[0].size);
  assert.match(s.your_venv.note, /never creates, changes or deletes your \.venv/);
  assert.equal(s.last_failure, null);
  assert.match(s.environment.schema, /shared/);
});
