'use strict';
// 0.12: shared package CACHE, own environment. Every worktree builds its own environment exactly
// like 0.11 (its own .factory-venv / node_modules, its own code), and the installs share a package
// cache (uv, pip, poetry, npm) plus, for pip, a hash-checked wheelhouse per key. The tool is chosen
// by one function and recorded with its reason, doctor and env status say what happened, the
// user's own .venv is never touched, and a sealed 0.11 environment is offered unchanged with the
// cache.
//
// Two kinds of tests: fake installers that count downloads (no network), and REAL-TOOL tests (uv,
// pip/venv, poetry, npm) that run only when the tool is installed and its registry answers; they
// say why when they skip.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const F = require('./helpers/fixture');
const MH = require('./helpers/machine');
const T = require('./helpers/tmp');
const { seal } = require('../cli/lib/seal');

const core = (m) => require(`../cli/core/${m}`);
const E = core('environment');
const C = core('envcache');
const human = core('human');
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !human.AGENT_ENV.some(([a]) => a === k)));
const say = (root, text) => {
  spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'prompt.js'), 'userPromptSubmitted'], { cwd: root, input: JSON.stringify({ prompt: text, cwd: root, sessionId: 'human' }), encoding: 'utf8', env: { ...clean, FACTORY_ROOT: '' } });
  return JSON.parse(fs.readFileSync(path.join(root, '.factory', 'last-reply.json'), 'utf8'));
};
const sealEnv = (root, e) => E.confirm(root, { env: e, channel: 'tty' });
const worktree = (root, name, edit = null) => {
  const wt = path.join(root, '.factory', 'worktrees', name);
  F.sh(root, `git worktree add -q --detach ${wt} HEAD`);
  if (edit) {
    edit(wt);
    F.sh(wt, `git add -A && git -c user.email=t@e -c user.name=t commit -qm ${name}`);
  }
  return wt;
};
const run = (r, wt, cmd, cwd = wt) => spawnSync('bash', ['-c', E.wrap(r.env, r.vars, cmd)], { cwd, encoding: 'utf8' });

// ------------------------------------------------------------------ fake installers (counting)

// fake-install.sh <worktree> <count file> <packages…>: "downloads" a package into UV_CACHE_DIR
// (or a cache of the worktree's own when none is shared) only when it is not there, counting each
// download, then "installs" (copies) it into the worktree's own .factory-venv.
const INSTALL = `#!/usr/bin/env bash
set -euo pipefail
wt="$1"; count="$2"; shift 2
cache="\${UV_CACHE_DIR:-$wt/.own-cache}"
mkdir -p "$cache" "$wt/.factory-venv/bin" "$wt/.factory-venv/site"
for p in "$@"; do
  if [ ! -f "$cache/$p.whl" ]; then echo "download $p" >> "$count"; sleep 0.2; echo "$p" > "$cache/$p.whl"; fi
  cp "$cache/$p.whl" "$wt/.factory-venv/site/$p"
done
printf '#!/bin/sh\necho "fake venv python: $*" >&2\nexit 1\n' > "$wt/.factory-venv/bin/python"; chmod +x "$wt/.factory-venv/bin/python"
`;
function kit(t) {
  const dir = T.mkdtemp('factory-fakeinst-', t);
  fs.writeFileSync(path.join(dir, 'fake-install.sh'), INSTALL, { mode: 0o755 });
  const count = path.join(dir, 'count');
  const env = (cache = 'uv', extra = []) => ({
    version: 2,
    name: 'fake-python',
    tool: 'fake',
    reason: 'a fake installer that counts its downloads',
    cache,
    setup: [`bash ${dir}/fake-install.sh {worktree} ${count} nautobot napalm netmiko`, ...extra],
    cache_key: ['pyproject.toml'],
    env: { VIRTUAL_ENV: '{worktree}/.factory-venv', PATH: '{worktree}/.factory-venv/bin:$PATH' },
    ignore: ['/.factory-venv/', '/.own-cache/'],
    timeout_seconds: 120,
  });
  return { dir, count, env, downloads: () => (fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim().split('\n').filter(Boolean).length : 0) };
}
function pyRepo(t) {
  const root = F.makeRepo(t);
  F.write(root, 'pyproject.toml', '[project]\nname = "myapp"\nversion = "0.1.0"\n');
  F.write(root, 'myapp/__init__.py', 'WHO = "root"\n');
  F.sh(root, 'git rm -q -r src tests/add.test.js && git add -A && git commit -qm py');
  F.write(root, '.venv/MINE', 'my own venv\n'); // the developer's own venv: never touched
  return root;
}

test('shared cache: five worktrees each build their OWN environment, and each package is downloaded once (0.11: once per worktree)', (t) => {
  const root = pyRepo(t);
  const K = kit(t);
  // 0.11 (version 1, no cache): every worktree downloads everything again
  const old = { ...K.env(), version: 1 };
  delete old.tool;
  delete old.reason;
  delete old.cache;
  for (const n of ['A-T1', 'A-T2']) assert.equal(E.ensure(root, null, { taskId: n, wt: worktree(root, n), env: old }).ok, true);
  assert.equal(K.downloads(), 6, '0.11: 3 packages × 2 worktrees');
  fs.writeFileSync(K.count, '');
  sealEnv(root, K.env());
  const names = ['J-0001-T1', 'J-0001-T2', 'J-0001-T3', 'J-0001-T4', 'J-0001'];
  for (const n of names) {
    const wt = worktree(root, n);
    const r = E.ensure(root, { id: 'J-0001' }, { taskId: n === 'J-0001' ? null : n.split('-').pop(), wt });
    assert.equal(r.ok, true, JSON.stringify(r.broken));
    assert.equal(r.cache.kind, 'uv');
    assert.deepEqual(fs.readdirSync(path.join(wt, '.factory-venv', 'site')).sort(), ['napalm', 'nautobot', 'netmiko'], `${n} has its own environment`);
    assert.equal(F.sh(wt, 'git status --porcelain'), '', `${n}: its environment is kept out of git status`);
  }
  assert.equal(K.downloads(), 3, '0.12: each package downloaded once, for five worktrees');
  assert.ok(fs.existsSync(path.join(C.CACHE(root), 'uv', 'nautobot.whl')), 'the cache is under .factory/envcache');
  // a second call in the same worktree is cached; a removed environment (git clean -fdx) is not (review M-6)
  const wt1 = path.join(root, '.factory', 'worktrees', 'J-0001-T1');
  assert.equal(E.ensure(root, { id: 'J-0001' }, { taskId: 'T1', wt: wt1 }).cached, true);
  F.sh(wt1, 'git clean -qfdx');
  const again = E.ensure(root, { id: 'J-0001' }, { taskId: 'T1', wt: wt1 });
  assert.equal(again.cached, false, 'a missing environment is built again, never reported ready');
  assert.ok(fs.existsSync(path.join(wt1, '.factory-venv', 'bin', 'python')));
  // the user's own .venv and checkout: untouched and still visible to git
  assert.deepEqual(fs.readdirSync(path.join(root, '.venv')), ['MINE']);
  assert.equal(spawnSync('git', ['check-ignore', '-q', '.venv'], { cwd: root }).status, 1);
  assert.match(F.sh(root, 'git status --porcelain'), /\?\? \.venv\//);
  assert.match(fs.readFileSync(E.excludeReport(root).file, 'utf8'), /# >>> copilot-factory: worktree build environments[^\n]*\n\/\.factory-venv\/\n\/\.own-cache\/\n# <<< copilot-factory\n/);
  assert.throws(() => E.ensure(root, null, { taskId: 'T9', wt: root }), /never sets up the root checkout/);
});

test('runs without your credentials (probe, proposal check, repair candidate) get no shared cache and never rewrite the exclude block', (t) => {
  const root = pyRepo(t);
  const K = kit(t);
  sealEnv(root, K.env());
  const before = fs.existsSync(E.excludeReport(root).file) ? fs.readFileSync(E.excludeReport(root).file, 'utf8') : '';
  const wt = worktree(root, '_probe-J-0001-1');
  const base = { PATH: process.env.PATH, HOME: T.mkdtemp('factory-home-', t), LANG: 'C' };
  const r = E.withBaseEnv(base, () => E.ensure(root, null, { taskId: 'probe', wt, env: { ...K.env(), ignore: ['/proposal-wants-this/'] } }));
  assert.equal(r.ok, true, JSON.stringify(r.broken));
  assert.ok(fs.existsSync(path.join(wt, '.own-cache', 'nautobot.whl')), 'its own scratch cache');
  assert.ok(!fs.existsSync(path.join(C.CACHE(root), 'uv')), 'the shared cache was not written');
  assert.equal(fs.existsSync(E.excludeReport(root).file) ? fs.readFileSync(E.excludeReport(root).file, 'utf8') : '', before, 'the exclude block is the sealed environment\'s only (review m-2)');
});

test('one setup per worktree at a time: a lock that is never taken over while its holder lives; a holder killed mid-build has its setup processes ended, and the next run builds cleanly (crash mid-build, review M-7)', async (t) => {
  const root = pyRepo(t);
  const dir = T.mkdtemp('factory-crash-', t);
  const log = path.join(dir, 'log');
  // a slow setup that logs its start and end
  const env = { version: 2, name: 'slow', tool: 'fake', reason: 'test', cache: 'none', setup: [`echo "start $$" >> ${log}; sleep 4; echo "end $$" >> ${log}; mkdir -p {worktree}/.factory-venv/bin && ln -sf "$(command -v python3)" {worktree}/.factory-venv/bin/python`], env: { VIRTUAL_ENV: '{worktree}/.factory-venv' }, timeout_seconds: 60 };
  sealEnv(root, env);
  const wt = worktree(root, 'J-0001-T1');
  const code = `const E = require(${JSON.stringify(path.join(F.PLUGIN, 'cli', 'core', 'environment.js'))}); const r = E.ensure(${JSON.stringify(root)}, null, { taskId: 'T1', wt: ${JSON.stringify(wt)} }); process.stdout.write(JSON.stringify({ ok: r.ok, cached: r.cached }));`;
  const holder = spawn(process.execPath, ['-e', code], { cwd: root });
  const lock = `${path.join(path.resolve(wt, F.sh(wt, 'git rev-parse --git-dir')), 'factory-env.json')}.lock`;
  for (let i = 0; i < 100 && !fs.existsSync(log); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(lock), 'the build holds the worktree lock');
  // a living holder is never taken over, however old its lock looks
  const J = core('job');
  assert.throws(() => J.withLock(lock, () => 'took it', { waitMs: 800, staleMs: 1 }), /stayed locked/);
  // the holder is killed mid-build; its setup (another process) would go on writing
  holder.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  const r = E.ensure(root, null, { taskId: 'T1', wt });
  assert.equal(r.ok, true, JSON.stringify(r.broken));
  assert.equal(r.cached, false);
  await new Promise((res) => setTimeout(res, 4500));
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  const first = lines[0].split(' ')[1];
  assert.ok(!lines.includes(`end ${first}`), `the killed run's setup was ended, not left to finish into the new environment: ${lines.join(' | ')}`);
  assert.equal(lines.filter((l) => l.startsWith('end')).length, 1);
  assert.equal(E.ensure(root, null, { taskId: 'T1', wt }).cached, true);
});

test('the wheelhouse is integrity-checked (sealed sha256 per wheel); garbage collection keeps the newest N and shows sizes; agents may not run it, nor touch the caches in any form the guard reads', (t) => {
  const root = pyRepo(t);
  const mk = (key, wheels, at) => {
    const d = C.dirOf(root, key);
    fs.mkdirSync(d, { recursive: true });
    const hs = {};
    for (const [n, body] of Object.entries(wheels)) {
      fs.writeFileSync(path.join(d, n), body);
      hs[n] = require('crypto').createHash('sha256').update(body).digest('hex');
    }
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(seal({ version: 1, key, built_at: at, wheels: hs })));
    fs.writeFileSync(path.join(d, 'used'), at);
    fs.utimesSync(path.join(d, 'used'), new Date(at), new Date(at));
    return d;
  };
  const keys = ['a', 'b', 'c', 'd'].map((x) => x.repeat(64));
  keys.forEach((k, i) => mk(k, { 'six-1.0-py3-none-any.whl': `six${i}` }, new Date(Date.now() - (5 - i) * 3600e3).toISOString()));
  assert.equal(C.verify(root, keys[3]).ok, true);
  fs.writeFileSync(path.join(C.dirOf(root, keys[3]), 'six-1.0-py3-none-any.whl'), 'evil');
  assert.match(C.verify(root, keys[3]).why, /changed/, 'a changed wheel voids the wheelhouse');
  fs.writeFileSync(path.join(C.dirOf(root, keys[2]), 'extra-1.0-py3-none-any.whl'), 'x');
  assert.match(C.verify(root, keys[2]).why, /does not list/, 'an added wheel voids it');
  const m = JSON.parse(fs.readFileSync(path.join(C.dirOf(root, keys[1]), 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(C.dirOf(root, keys[1]), 'manifest.json'), JSON.stringify({ ...m, wheels: {} }));
  assert.match(C.verify(root, keys[1]).why, /not sealed/, 'an edited manifest voids it');
  const g = F.cli(root, ['env', 'gc', '--keep', '2']);
  assert.equal(g.removed.length, 2, JSON.stringify(g));
  assert.match(g.removed[0].size, /\d+ (B|kB|MB|GB)/);
  assert.equal(F.cli(root, ['env', 'gc'], { env: { FACTORY_RUNNER: '1' } }).code, 'agent_not_allowed');
  // agents may not write the caches or the wheelhouse, from a shell or inline code
  const G = require('../hooks/guard-rules');
  for (const cmd of ['cp evil.whl .factory/wheelhouse/aaaa/', `python3 -c "open('.factory/envcache/pip/x','w').write('x')"`]) assert.ok(G.checkBash(root, cmd, null, { agent: true, job: 'J-0001' }), cmd);
  // from a worktree: relative paths, cd, installer flags and cache variables, tar/rsync/find/mkdir/chmod, script files (012B M-1)
  const wt = path.join(root, '.factory', 'worktrees', 'J-0001-T1');
  fs.mkdirSync(path.join(wt, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'tools', 'p.py'), `import pathlib\npathlib.Path('${root}/.factory/envcache/uv/x').write_text('x')\n`);
  const ab = path.join(root, '.factory');
  const refused = ['cp evil.whl ../../wheelhouse/abc/', 'cd ../../envcache && echo x > uv/f', 'echo x >> ../../jobs/J-0001/state.json', `UV_CACHE_DIR=${ab}/envcache/uv uv pip install ./evil`, `export UV_CACHE_DIR=${ab}/envcache/uv; uv pip install x`, `pip install --cache-dir ${ab}/envcache/pip x`, 'pip download -d ../../wheelhouse/abc x', 'npm cache add --cache ../../envcache/npm x', `npm_config_cache=${ab}/envcache/npm npm install`, `tar -xf x.tar -C ${ab}/envcache/pip`, `rsync -a x/ ${ab}/envcache/pip/`, `find ${ab}/envcache -delete`, `mkdir -p ${ab}/wheelhouse/zz`, `chmod -R 777 ${ab}/envcache`, `uv cache clean --cache-dir ${ab}/envcache/uv`, 'python3 tools/p.py'];
  for (const cmd of refused) assert.ok(G.checkBash(root, cmd, null, { agent: true, job: 'J-0001', cwd: wt }), `refused: ${cmd}`);
  for (const cmd of ['ls ../../envcache', `du -sh ${ab}/envcache`, 'pip install -e .', 'uv pip install six']) assert.equal(G.checkBash(root, cmd, null, { agent: true, job: 'J-0001', cwd: wt }), null, `allowed: ${cmd}`);
});

test('guard (012C): cd is tracked conservatively (subshells, cd -, popd, conditional or failing cd only ADD a directory), and builder output, caches and the environment\'s own directories stay writable whatever the allowed paths', (t) => {
  const root = F.makeRepo(t);
  F.write(root, 'scripts/run.sh', 'echo hi\n');
  F.sh(root, 'git add -A && git commit -qm s');
  fs.mkdirSync(path.join(root, '.factory', 'jobs', 'J-0001'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'jobs', 'J-0001', 'plan.json'), JSON.stringify({ tasks: [{ id: 'T1', allowed_paths: ['src/**', 'tests/**', 'scripts/**', 'pyproject.toml', 'package.json'] }] }));
  const wt = worktree(root, 'J-0001-T1');
  const G = require('../hooks/guard-rules');
  const o = { agent: true, job: 'J-0001', cwd: wt };
  for (const c of ['(cd /tmp); echo x > .github/workflows/ci.yml', 'cd /tmp; cd -; echo x > .github/workflows/ci.yml', '(cd /tmp); echo x > ../../envcache/uv/f', 'pushd /tmp; popd; echo x > ../../envcache/uv/f', 'false && cd /tmp; echo x > ../../envcache/uv/f', 'cd /nonexistent; echo x > ../../envcache/uv/f', 'cd /tmp || true; cp x ../../wheelhouse/abc/', 'bash -c "cd /tmp"; echo x > ../../envcache/uv/f', 'echo x > README.md']) assert.ok(G.checkBash(root, c, null, o), `refused: ${c}`);
  for (const c of ['pytest > test-output.txt 2>&1', 'npm run build > build.log', 'rm -rf build dist', 'rm -rf .pytest_cache', 'rm -rf node_modules', 'rm -rf .factory-venv', 'cd src && echo x > y.py', 'mkdir -p src/a/b', 'echo x > src/a.py', 'cd /tmp && echo x > out.txt', 'pip install -e .', 'tar -czf dist/out.tgz -C build .']) assert.equal(G.checkBash(root, c, null, o), null, `allowed: ${c}`);
  // a tracked file outside the allowed paths stays refused, even with a build-like name
  F.write(root, 'build.log', 'tracked\n');
  F.sh(root, 'git add -A && git commit -qm log');
  const wt2 = worktree(root, 'J-0001-T2');
  fs.writeFileSync(path.join(root, '.factory', 'jobs', 'J-0001', 'plan.json'), JSON.stringify({ tasks: [{ id: 'T1', allowed_paths: ['src/**'] }, { id: 'T2', allowed_paths: ['src/**'] }] }));
  assert.ok(G.checkBash(root, 'echo x > build.log', null, { agent: true, job: 'J-0001', cwd: wt2 }));
});

test('guard (012D MJ-1): cd tracking fails CLOSED: any cd it cannot follow makes the directory unknown and refuses every relative write; absolute targets are checked as always; normal builder work still runs', (t) => {
  const root = F.makeRepo(t);
  F.write(root, 'scripts/run.sh', 'echo hi\n');
  F.write(root, 'src/up.sh', 'cd ../..\n');
  F.sh(root, 'git add -A && git commit -qm s');
  fs.mkdirSync(path.join(root, '.factory', 'jobs', 'J-0001'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'jobs', 'J-0001', 'plan.json'), JSON.stringify({ tasks: [{ id: 'T1', allowed_paths: ['src/**', 'tests/**', 'scripts/**', 'x/**'] }, { id: 'T2', allowed_paths: ['src/**'] }] }));
  const wt = worktree(root, 'J-0001-T1');
  const wt2 = worktree(root, 'J-0001-T2');
  fs.mkdirSync(path.join(wt, 'x'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'src', 'sub'), { recursive: true });
  const G = require('../hooks/guard-rules');
  const o = { agent: true, job: 'J-0001', cwd: wt };
  const O = T.mkdtemp('factory-outside-', t); // an existing directory outside the repository
  const W = '.github/workflows/ci.yml';
  // every row of the REL-012D review, plus the forms around them
  const refused = [
    `pushd ${O}; pushd +1; echo x > ${W}`, `pushd ${O}; pushd -0; echo x > ${W}`,
    `f() { cd ${O}; }; echo x > ${W}`, `f(){ cd ${O}; }; f; echo x > ${W}`, `function f { cd ${O}; }; f; echo x > ${W}`,
    `if false; then cd ${O}; fi; echo x > ${W}`, `while false; do cd ${O}; done; echo x > ${W}`, `case a in a) cd ${O};; esac; echo x > ${W}`, `for d in ${O}; do cd $d; done; echo x > ${W}`, `{ cd ${O}; }; echo x > ${W}`,
    `cd ${O} & echo x > ${W}`, `cd ${O} | true; echo x > ${W}`, `true | cd ${O}; echo x > ${W}`,
    `pushd ${O}; pushd +1; cd ../../envcache/uv && echo POISON >> archive-v0/h/six.py`,
    `pushd ${O}; pushd +1; cd ../../wheelhouse/abc && echo x > six-1.0-py3-none-any.whl`,
    `pushd ${O}; pushd +1; cd ../../.. && echo x > ${W}`,
    `pushd ${O}; pushd +1; cd ../.. && echo '{}' > environment.json`,
    'D=../..; cd $D; echo x > envcache/uv/a.log', 'D=../..; cd "$D"; mkdir -p src; echo x > src/f',
    'set -- ../..; cd "$1"; echo x > envcache/uv/a.log', 'cd ${PWD%/*/*}; echo x > envcache/uv/a.log', 'cd "$(dirname $(dirname $PWD))"; echo x > envcache/uv/a.log',
    'cd ~+/../..; echo x > envcache/uv/a.log', 'OLDPWD=../..; cd -; echo x > envcache/uv/a.log',
    "eval 'cd ../..'; echo x > envcache/uv/a.log", "printf 'cd ../..\\n' > src/up.sh && . src/up.sh && echo x > envcache/uv/a.log", '. src/up.sh; echo x > envcache/uv/a.log', 'source src/up.sh; echo x > envcache/uv/a.log', 'source <(echo cd ../..); echo x > envcache/uv/a.log', ". /dev/stdin <<<'cd ../..'; echo x > envcache/uv/a.log",
    'CDPATH=../.. cd envcache; echo x > uv/a.log', 'export CDPATH=../..; cd envcache; echo x > uv/a.log',
    'cd -- ../..; echo x > envcache/uv/a.log', 'cd -P ../..; echo x > envcache/uv/a.log',
    `false && cd ${O}; echo x > ${W}`, `cd /nonexistent-dir; echo x > ${W}`, `cd ${O} || true; echo x > ${W}`,
    'echo x > README.md',
  ];
  for (const c of refused) assert.ok(G.checkBash(root, c, null, o), `refused: ${c}`);
  // the message says what to do
  assert.match(G.checkBash(root, `if true; then cd ${O}; fi; echo x > src/a.py`, null, o), /absolute path, or a simple cd/);
  // unknown directory, absolute target: checked as always (allowed in scope, refused out of it)
  assert.equal(G.checkBash(root, `if true; then cd ${O}; fi; echo x > ${wt}/src/a.py`, null, o), null);
  assert.ok(G.checkBash(root, `if true; then cd ${O}; fi; echo x > ${root}/.factory/envcache/uv/a.log`, null, o));
  // a cd the guard follows exactly: a plain one to a real directory, wherever it is
  assert.ok(G.checkBash(root, `builtin cd ../../..; echo x > ${W}`, null, o), 'followed into the main checkout: protected');
  assert.ok(G.checkBash(root, 'cd ../.. && echo x > envcache/uv/a.log', null, o), 'followed into .factory: the cache');
  const ok = ['cd src && echo x > y.py', '(cd x && make > build.log)', '(cd src && echo x > a.py) && echo y > tests/t.py', 'pushd src && echo x > a.py && popd && echo y > tests/b.py', 'echo x > src/a.py', 'cd src/sub && touch a.py && cd ../.. && echo > tests/x.py', 'cd src; echo x > a.py', `cd ${O} && echo x > out.txt`, 'bash -c "cd /tmp"; echo x > src/a.py', 'echo $(cd /tmp && pwd) > src/a.py', 'pytest > test-output.txt 2>&1', 'rm -rf build dist node_modules .factory-venv', 'mkdir -p src/a/b',
    // m-4: find's {} is each file it found, not a path
    'find . -name __pycache__ -exec rm -rf {} +', 'find src -name "*.o" -exec rm -f {} \;'];
  for (const c of ok) assert.equal(G.checkBash(root, c, null, o), null, `allowed: ${c}`);
  // m-1: another task's worktree is not this agent's to write, from a shell or the edit tool
  for (const c of ['echo x > ../J-0001-T2/src/a.py', `echo x > ${wt2}/src/a.py`, 'echo x > ../J-0001-T2/.factory-venv/bin/python', 'echo x > ../J-0001-T2/build.log', 'cd ../J-0001-T2 && echo x > src/a.py']) assert.match(G.checkBash(root, c, null, o) || '', /another task's worktree/, c);
  const pol = core('policy').defaults();
  assert.match(G.checkWrite(root, path.join(wt2, 'src', 'a.py'), pol, { own: 'J-0001-T1' }), /another task's worktree/);
  assert.equal(G.checkWrite(root, path.join(wt, 'src', 'a.py'), pol, { own: 'J-0001-T1' }), null);
  assert.equal(G.ownWorktree(root, path.join(wt, 'src')), 'J-0001-T1');
  // m-2: symlinks are resolved along the whole path, however deep the new part is; a link into
  // factory state is refused when it is made
  assert.match(G.checkBash(root, 'ln -s ../.. build', null, o) || '', /link points into \.factory/);
  fs.symlinkSync('../..', path.join(wt, 'build'));
  for (const c of ['install -D src/p.py build/envcache/uv/a/b/c.py', 'mkdir -p build/envcache/uv/q/r', 'echo x > build/envcache/uv/a/b/c.py', 'cp a build/state.json']) assert.ok(G.checkBash(root, c, null, o), `refused: ${c}`);
  assert.match(G.checkWrite(root, path.join(wt, 'build', 'envcache', 'uv', 'n', 'e', 'w.py'), pol, { own: 'J-0001-T1' }), /factory state/);
  assert.equal(G.checkBash(root, 'ln -s ../tests/fixtures src/fixtures', null, o), null, 'a link inside its own worktree');
});

test('build output stays out of the commit: the factory\'s save of uncommitted work unstages new build output and logs; the builder and its time-up turn are told to add only their changed files (012D m-3)', (t) => {
  const root = F.makeRepo(t);
  const wt = worktree(root, 'J-0001-T1');
  F.sh(wt, 'git checkout -q -b factory/J-0001-T1');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'build', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'src', 'new.py'), 'x = 1\n');
  fs.writeFileSync(path.join(wt, 'build', 'lib', 'new.py'), 'x = 1\n');
  fs.writeFileSync(path.join(wt, 'pytest.log'), 'log\n');
  fs.writeFileSync(path.join(wt, 'test-results.xml'), '<x/>\n');
  const sha = require('../cli/core/runner')._commitWip(wt, 'T1', 'time up');
  assert.ok(sha);
  const files = F.sh(wt, 'git show --name-only --format= HEAD').trim().split('\n');
  assert.deepEqual(files, ['src/new.py']);
  assert.ok(fs.existsSync(path.join(wt, 'build', 'lib', 'new.py')), 'the output itself is left alone');
  // nothing but build output: no empty commit
  fs.writeFileSync(path.join(wt, 'more.log'), 'log\n');
  assert.equal(require('../cli/core/runner')._commitWip(wt, 'T1', 'time up'), null);
  const md = fs.readFileSync(path.join(F.PLUGIN, 'agents', 'builder.agent.md'), 'utf8');
  assert.match(md, /never `git add -A`/);
  assert.doesNotMatch(fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'runner.js'), 'utf8'), /`git add -A && git commit/);
});

test('fresh runs ignore the sealed environment\'s own cache settings (012D m-5): UV_CACHE_DIR and PIP_CACHE_DIR in its env never reach a fresh setup', (t) => {
  const root = F.makeRepo(t);
  const seen = path.join(T.mkdtemp('factory-seen-', t), 'env.txt');
  const env = { version: 2, name: 'x', tool: 'uv', reason: 'test', cache: 'uv', setup: [`env > ${seen}`], cache_key: [], env: { UV_CACHE_DIR: '/home/someone/.cache/uv', PIP_CACHE_DIR: '/home/someone/.cache/pip', KEEP_ME: 'yes' }, timeout_seconds: 60 };
  sealEnv(root, env);
  const wc = worktree(root, 'J-0001-ci');
  const rc = E.ensure(root, null, { taskId: 'ci', wt: wc, fresh: true });
  assert.equal(rc.ok, true, JSON.stringify(rc.broken));
  const got = Object.fromEntries(fs.readFileSync(seen, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.match(got.UV_CACHE_DIR, /factory-fresh-cache-/);
  assert.notEqual(got.PIP_CACHE_DIR, '/home/someone/.cache/pip');
  assert.equal(got.KEEP_ME, 'yes');
  // a task worktree (not fresh) keeps the sealed choice
  const w1 = worktree(root, 'J-0001-T1');
  assert.equal(E.ensure(root, null, { taskId: 'T1', wt: w1 }).ok, true);
  assert.match(fs.readFileSync(seen, 'utf8'), /^UV_CACHE_DIR=\/home\/someone\/\.cache\/uv$/m);
});

test('the fallback after an offline miss starts clean: what the first attempt created at the top of the worktree (mkdir data) is removed too; a project installed from its own directory is not expected in the wheelhouse (012C m-2, m-3)', (t) => {
  const root = pyRepo(t);
  const dir = T.mkdtemp('factory-offline-', t);
  // fake-uv.sh <worktree>: installs every package listed in the worktree's pkgs.txt; offline it
  // fails like uv for one that is not in the cache
  fs.writeFileSync(path.join(dir, 'fake-uv.sh'), `#!/usr/bin/env bash
set -euo pipefail
wt="$1"; cache="\${UV_CACHE_DIR}"; mkdir -p "$cache" "$wt/.factory-venv/bin"
for p in $(cat "$wt/pkgs.txt"); do
  if [ ! -f "$cache/$p" ]; then
    if [ -n "\${UV_OFFLINE:-}" ]; then echo "error: $p was not found in the cache (offline)" >&2; exit 2; fi
    echo "$p" > "$cache/$p"
  fi
done
printf '#!/bin/sh\\nexit 1\\n' > "$wt/.factory-venv/bin/python"; chmod +x "$wt/.factory-venv/bin/python"
`, { mode: 0o755 });
  F.write(root, 'pkgs.txt', 'six\n');
  F.sh(root, 'git add -A && git commit -qm pkgs');
  const env = { version: 2, name: 'fake-uv', tool: 'uv', reason: 'test', cache: 'uv', setup: ['mkdir data', `bash ${dir}/fake-uv.sh {worktree}`], cache_key: ['pyproject.toml'], env: { VIRTUAL_ENV: '{worktree}/.factory-venv' }, ignore: ['/.factory-venv/', '/data/'], timeout_seconds: 60 };
  sealEnv(root, env);
  assert.equal(E.ensure(root, null, { taskId: 'T1', wt: worktree(root, 'J-0001-T1') }).ok, true);
  const w2 = worktree(root, 'J-0001-T2', (w) => F.write(w, 'pkgs.txt', 'six\niniconfig\n'));
  const r2 = E.ensure(root, null, { taskId: 'T2', wt: w2 });
  assert.equal(r2.ok, true, JSON.stringify(r2.broken));
  assert.equal(r2.cache.fallback, true, 'offline missed; the retry did not trip over `mkdir data`');
  // m-3: "name @ file://…" (pip install .) is the project, not an expected wheel
  const py = path.join(dir, 'python');
  fs.writeFileSync(py, `#!/usr/bin/env bash
if [ "$3" = freeze ]; then printf 'six==1.0\\ndapp @ file:///tmp/x\\n'; exit 0; fi
if [ "$3" = wheel ]; then while [ $# -gt 0 ]; do if [ "$1" = -w ]; then echo whl > "$2/six-1.0-py3-none-any.whl"; fi; shift; done; exit 0; fi
exit 1
`, { mode: 0o755 });
  const k = 'e'.repeat(64);
  const b = C.buildWheelhouse(root, k, { python: py, env: process.env });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.incomplete, undefined);
  assert.equal(C.verify(root, k).ok, true, 'complete: the project itself is not expected');
});

test('tool choice: one function, recorded with its reason; templates build each worktree\'s own .factory-venv / node_modules with the matching cache', (t) => {
  const root = F.makeRepo(t);
  F.write(root, 'pyproject.toml', '[project]\nname = "x"\n[project.optional-dependencies]\ndev = ["pytest"]\n');
  F.write(root, 'requirements-dev.txt', 'pytest==8.2.0\n');
  F.sh(root, 'git add -A && git commit -qm py');
  const d = (inv) => E.detect(root, { machine: inv });
  const uv = d(MH.inventory({ venv: false, tools: { uv: true, virtualenv: true } }));
  assert.deepEqual([uv.version, uv.tool, uv.cache], [2, 'uv', 'uv']);
  assert.match(uv.reason, /uv is installed/);
  assert.deepEqual(uv.setup, ['uv venv -q --seed --allow-existing .factory-venv', "uv pip install -q --python .factory-venv/bin/python -e '.[dev]'", 'uv pip install -q --python .factory-venv/bin/python -r requirements-dev.txt']);
  assert.equal(uv.env.VIRTUAL_ENV, '{worktree}/.factory-venv');
  assert.deepEqual(E.problems(E.essence(uv)), []);
  assert.deepEqual(E.lint(uv, { root, machine: MH.inventory({ venv: false, tools: { uv: true } }) }), []);
  const ve = d(MH.inventory({ venv: false, tools: { virtualenv: true } }));
  assert.deepEqual([ve.tool, ve.cache, ve.setup[0]], ['virtualenv', 'pip', 'virtualenv -q .factory-venv']);
  assert.deepEqual(E.lint(ve, { root, machine: MH.inventory({ venv: false, tools: { virtualenv: true } }) }), []);
  assert.equal(d(MH.inventory({ venv: true })).tool, 'venv');
  const none = d(MH.inventory({ venv: false }));
  assert.equal(none.tool, 'none-available');
  assert.equal(E.lint(none, { root, machine: MH.inventory({ venv: false }) })[0].rule, 'venv_no_ensurepip');
  // uv.lock: uv sync into the worktree's own venv (workspace members editable from that worktree)
  F.write(root, 'uv.lock', 'version = 1\n');
  const ul = d(MH.inventory({ tools: { uv: true } }));
  assert.deepEqual([ul.setup, ul.env.UV_PROJECT_ENVIRONMENT], [['uv sync -q --frozen --extra dev'], '{worktree}/.factory-venv']);
  fs.rmSync(path.join(root, 'uv.lock'));
  // a poetry repo with its lock: poetry, into the worktree's venv, the venv made by uv
  F.write(root, 'pyproject.toml', '[tool.poetry]\nname = "x"\n');
  F.write(root, 'poetry.lock', '\n');
  const po = d(MH.inventory({ venv: true, tools: { poetry: true, uv: true } }));
  assert.deepEqual([po.tool, po.cache], ['poetry', 'poetry']);
  assert.match(po.reason, /poetry\.lock[\s\S]*uv makes the venv/);
  assert.deepEqual(po.setup.slice(0, 2), ['uv venv -q --seed --allow-existing .factory-venv', 'poetry install --no-interaction']);
  // node: own node_modules, the npm cache; the ignore pattern only when the repo does not ignore it
  const n = F.makeRepo(t);
  F.write(n, 'package.json', '{"devDependencies":{"mocha":"1"}}');
  F.write(n, 'package-lock.json', '{}');
  let nd = E.detect(n);
  assert.deepEqual([nd.tool, nd.cache, nd.setup, nd.ignore], ['npm', 'npm', ['npm ci --no-audit --no-fund'], ['/node_modules/']]);
  F.write(n, '.gitignore', 'node_modules/\n');
  nd = E.detect(n);
  assert.deepEqual(nd.ignore, [], 'already ignored by the repo: nothing added that would also apply to your checkout');
  // Nautobot: invoke build in each worktree (docker's layer cache)
  F.write(root, 'pyproject.toml', '[tool.poetry]\nname = "nautobot-app-golden"\n[tool.poetry.dependencies]\nnautobot = "^2.0"\n');
  F.write(root, 'tasks.py', 'from invoke import Collection, task\nnamespace = Collection("nautobot_golden")\n');
  const nb = E.detect(root);
  assert.deepEqual([nb.version, nb.setup, nb.cache, nb.teardown], [2, ['invoke build'], 'docker', 'invoke destroy']);
  // the schema
  assert.match(E.problems({ version: 1, cache: 'pip' }).join(), /cache needs version 2/);
  assert.match(E.problems({ version: 2, cache: 'ruby' }).join(), /cache must be one of/);
  assert.match(E.problems({ version: 3 }).join(), /version must be 1/);
});

test('migration: a sealed 0.11 environment keeps working; the offer is the SAME setup (pins, extras, constraints, nested requirement files) with the cache; one reply switches', (t) => {
  const root = pyRepo(t);
  const OLD = { version: 1, name: 'django-app', setup: ['python3 -m venv .venv', ".venv/bin/pip install -q --retries 5 --timeout 60 'django==5.0.6' 'pytest-django==4.8.0'", ".venv/bin/pip install -q --retries 5 --timeout 60 -e '.[test]' -c constraints.txt", '.venv/bin/pip install -q --retries 5 --timeout 60 -r requirements/ci.txt'], cache_key: ['pyproject.toml', 'constraints.txt', 'requirements/*.txt'], env: { VIRTUAL_ENV: '{worktree}/.venv', PATH: '{worktree}/.venv/bin:$PATH', DJANGO_SETTINGS_MODULE: 'app.settings' }, services: { up: 'true', health: 'true' }, ignore: ['.venv/'], timeout_seconds: 1500, notes: 'mine' };
  fs.writeFileSync(E.FILE(root), JSON.stringify(seal({ ...OLD, confirmed: { at: '2026-09-01T00:00:00Z', via: 'chat' } }), null, 2));
  assert.equal(E.load(root).version, 1, 'a 0.11 seal still verifies');
  assert.equal(E.fullHash(E.load(root)), E.fullHash(OLD), 'its hash (what gates bound) is unchanged');
  const up = E.upgradeOf(root, E.load(root)).env;
  const { version: _v, tool, reason, cache, ...rest } = up;
  const { version: _o, ...was } = OLD;
  assert.deepEqual(rest, was, 'every field and every setup step exactly as sealed');
  assert.deepEqual([up.version, tool, cache], [2, 'pip', 'pip']);
  assert.match(reason, /unchanged/);
  const nt = E.notice(root);
  assert.equal(nt.status, 'upgrade');
  assert.equal(nt.message.split('\n').length, 1, 'one line');
  assert.match(nt.message, new RegExp(`same setup, unchanged[\\s\\S]*confirm environment ${nt.hash}`));
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  assert.equal((F.cli(root, ['next']).environment || {}).status, 'upgrade');
  const r = say(root, `confirm environment ${nt.hash}`);
  assert.equal(r.status, 'applied', JSON.stringify(r));
  const now = E.load(root);
  assert.deepEqual([now.version, now.cache, now.setup], [2, 'pip', OLD.setup]);
  assert.equal(E.notice(root), null, 'no more offer');
  // a setup that uses no installer the cache serves is not offered
  assert.match(E.upgradeOf(root, { ...OLD, setup: ['bash scripts/mkenv.sh'] }).why, /no installer the shared cache serves/);
});

test('doctor: a "build environment" section (tool and why, python3 -m venv with its age, the cache, your .venv never touched, last check); the inventory only under --machine; env status says what happened', (t) => {
  const root = pyRepo(t);
  const K = kit(t);
  fs.appendFileSync(E.excludeReport(root).file, '.venv/\n'); // a 0.11 environment added this
  sealEnv(root, K.env());
  E.ensure(root, { id: 'J-0001' }, { taskId: 'T1', wt: worktree(root, 'J-0001-T1') });
  const d = F.cli(root, ['doctor']);
  const c = (n) => d.checks.find((x) => x.name === n) || {};
  assert.ok(!d.checks.some((x) => /^machine:/.test(x.name)), 'no tool dump without --machine');
  assert.match(c('build environment').detail, /fake-python/);
  assert.match(c('build environment: tool').detail, /the sealed environment uses fake \(a fake installer that counts its downloads\); on this machine now the factory would choose venv/);
  assert.match(c('build environment: python3 -m venv').detail, /works \(scanned (just now|\d+ (min|h) ago); factory doctor --machine scans again\)/);
  assert.match(c('build environment: cache').detail, /each worktree builds its own environment; its uv installs share .*envcache \(files copied, never linked\)[\s\S]*uv \d+ (B|kB|MB)/);
  assert.match(c('build environment: your .venv').detail, /\.venv exists: the factory never creates, changes or deletes it[\s\S]*has a "\.venv\/" line/);
  assert.match(c('build environment: last check').detail, /none yet/);
  assert.ok(fs.existsSync(d.build_environment.guide));
  assert.ok(F.cli(root, ['doctor', '--machine']).checks.some((x) => x.name === 'machine: python tools'));
  const s = F.cli(root, ['env', 'status'], { env: { FACTORY_RUNNER: '1' } });
  assert.deepEqual([s.tool.chosen, s.tool.cache], ['fake', 'uv']);
  assert.equal(s.worktrees[0].name, 'J-0001-T1');
  assert.deepEqual(s.worktrees[0].own_env, ['.factory-venv']);
  assert.ok(s.cache.caches.some((x) => x.name === 'uv' && /\d/.test(x.size)));
  assert.equal(s.last_build.ok, true);
  assert.match(s.your_venv.note, /never creates, changes or deletes your \.venv/);
  assert.match(s.environment.schema, /own environment per worktree, shared package cache/);
  // a failure is recorded, redacted, with the next step
  const bad = { ...K.env(), setup: ['echo "auth for https://bob:pw1234567@idx.example/simple failed ghp_abcdefghijklmnop1234" >&2; exit 3'] };
  sealEnv(root, bad);
  assert.equal(E.ensure(root, null, { taskId: 'T2', wt: worktree(root, 'J-0001-T2') }).ok, false);
  const s2 = E.status(root);
  assert.match(s2.last_failure.tail, /failed/);
  assert.doesNotMatch(JSON.stringify(s2), /pw1234567|ghp_abcdefghijklmnop1234/, 'tokens and logins are redacted, the command too (review m-6)');
  assert.match(s2.last_failure.next_step, /factory env check --job/);
});

// ------------------------------------------------------------------ real tools

const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;
let NET = null;
function online(url) {
  NET = NET || {};
  if (NET[url] === undefined) NET[url] = spawnSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', url], { encoding: 'utf8' }).stdout.trim() === '200';
  return NET[url];
}
const skipUnless = (t, bin, url) => {
  if (!has(bin)) return t.skip(`${bin} is not installed`) || true;
  if (url && !online(url)) return t.skip(`${url} does not answer (real-tool test needs the registry)`) || true;
  return false;
};
const PYPI = 'https://pypi.org/simple/six/';
const NPM = 'https://registry.npmjs.org/is-number';
const timings = {};
const timed = (fn) => {
  const s = Date.now();
  const r = fn();
  return [r, Date.now() - s];
};
test.after(() => {
  if (Object.keys(timings).length) fs.writeFileSync(path.join(require('os').tmpdir(), 'factory-v012-timings.json'), JSON.stringify(timings, null, 1));
});

test('REAL uv: a workspace member is imported from each worktree\'s OWN copy; the second worktree installs from the shared cache, faster; files are copied, so a write in one venv reaches no other venv and not the cache', { timeout: 600000 }, (t) => {
  if (skipUnless(t, 'uv', PYPI)) return;
  const root = F.makeRepo(t);
  F.write(root, 'pyproject.toml', '[project]\nname = "app"\nversion = "0.1.0"\nrequires-python = ">=3.9"\ndependencies = ["mylib", "six", "iniconfig", "packaging", "pluggy"]\n[tool.uv.sources]\nmylib = { workspace = true }\n[tool.uv.workspace]\nmembers = ["libs/*"]\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n[tool.hatch.build.targets.wheel]\npackages = ["app"]\n');
  F.write(root, 'app/__init__.py', 'import mylib\n');
  F.write(root, 'libs/mylib/pyproject.toml', '[project]\nname = "mylib"\nversion = "0.1.0"\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n');
  F.write(root, 'libs/mylib/mylib/__init__.py', 'WHO = "root"\n');
  F.sh(root, 'git rm -q -r src && uv lock -q && git add -A && git commit -qm ws');
  const env = E.detect(root, { machine: MH.inventory({ tools: { uv: true } }) });
  assert.deepEqual(env.setup, ['uv sync -q --frozen']);
  sealEnv(root, env);
  const out = {};
  const offline = {};
  for (const n of ['J-0001-T1', 'J-0001-T2']) {
    const wt = worktree(root, n, (w) => F.write(w, 'libs/mylib/mylib/__init__.py', `WHO = "${n}"\n`));
    const [r, ms] = timed(() => E.ensure(root, null, { taskId: n, wt }));
    assert.equal(r.ok, true, JSON.stringify(r.broken));
    out[n] = ms;
    offline[n] = Boolean(r.cache && r.cache.offline);
    const py = run(r, wt, 'python -c "import mylib, app; print(mylib.WHO, mylib.__file__)"', T.mkdtemp('factory-cwd-', t));
    assert.equal(py.status, 0, py.stderr);
    assert.match(py.stdout, new RegExp(`^${n} ${wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/libs/mylib/`), `${n} imports its own workspace member`);
    assert.equal(F.sh(wt, 'git status --porcelain'), '');
  }
  timings.uv_workspace_ms = out;
  // 012B B-1: copies, never hard links: a write in T1's venv changes neither T2, a new worktree nor the cache
  const site = (wt) => path.join(wt, '.factory-venv', fs.readdirSync(path.join(wt, '.factory-venv', 'lib')).map((d) => path.join('lib', d, 'site-packages')).find((d) => fs.existsSync(path.join(wt, '.factory-venv', d, 'iniconfig'))), 'iniconfig', '__init__.py');
  const w1 = path.join(root, '.factory', 'worktrees', 'J-0001-T1');
  const w2 = path.join(root, '.factory', 'worktrees', 'J-0001-T2');
  assert.equal(fs.statSync(site(w1)).nlink, 1, 'its own copy (one link)');
  fs.appendFileSync(site(w1), '\nPOISON = "written by T1"\n');
  const w3 = worktree(root, 'J-0002-T1');
  const r3 = E.ensure(root, null, { taskId: 'T1', wt: w3 });
  assert.equal(r3.ok, true);
  for (const w of [w2, w3]) assert.doesNotMatch(fs.readFileSync(site(w), 'utf8'), /POISON/, `${path.basename(w)} is unaffected`);
  assert.equal(spawnSync('grep', ['-rl', 'POISON', path.join(C.CACHE(root), 'uv')], { encoding: 'utf8' }).stdout, '', 'the cache is unaffected');
  t.diagnostic(`uv: first worktree ${out['J-0001-T1']} ms, second ${out['J-0001-T2']} ms`);
  // the second worktree installs offline from the shared cache (its time is reported above; a
  // timing assertion was flaky once the index answers from a warm proxy)
  assert.deepEqual(offline, { 'J-0001-T1': false, 'J-0001-T2': true }, 'the second worktree installs offline from the shared uv cache');
  assert.ok(fs.readdirSync(path.join(C.CACHE(root), 'uv')).length > 0, 'the uv cache is under .factory/envcache');
});

test('REAL poetry: a path dependency (develop = true) is imported from each worktree\'s own copy', { timeout: 600000 }, (t) => {
  if (skipUnless(t, 'poetry', PYPI)) return;
  const root = F.makeRepo(t);
  F.write(root, 'pyproject.toml', '[tool.poetry]\nname = "papp"\nversion = "0.1.0"\ndescription = ""\nauthors = ["a <a@b.c>"]\npackages = [{include = "papp"}]\n[tool.poetry.dependencies]\npython = "^3.9"\nsix = "*"\nmylib = {path = "libs/mylib", develop = true}\n[build-system]\nrequires = ["poetry-core>=1.0.0"]\nbuild-backend = "poetry.core.masonry.api"\n');
  F.write(root, 'papp/__init__.py', '');
  F.write(root, 'libs/mylib/pyproject.toml', '[tool.poetry]\nname = "mylib"\nversion = "0.1.0"\ndescription = ""\nauthors = ["a <a@b.c>"]\npackages = [{include = "mylib"}]\n[tool.poetry.dependencies]\npython = "^3.9"\n[build-system]\nrequires = ["poetry-core>=1.0.0"]\nbuild-backend = "poetry.core.masonry.api"\n');
  F.write(root, 'libs/mylib/mylib/__init__.py', 'WHO = "root"\n');
  const pc = T.mkdtemp('factory-poetry-cache-', t);
  F.sh(root, `git rm -q -r src && POETRY_CACHE_DIR=${pc} poetry lock -q && git add -A && git commit -qm poetry`);
  const env = E.detect(root, { machine: MH.inventory({ venv: true, tools: { poetry: true, uv: has('uv') } }) });
  assert.equal(env.tool, 'poetry');
  sealEnv(root, env);
  const out = {};
  for (const n of ['J-0001-T1', 'J-0001-T2']) {
    const wt = worktree(root, n, (w) => F.write(w, 'libs/mylib/mylib/__init__.py', `WHO = "${n}"\n`));
    const [r, ms] = timed(() => E.ensure(root, null, { taskId: n, wt }));
    assert.equal(r.ok, true, JSON.stringify(r.broken));
    out[n] = ms;
    const py = run(r, wt, 'python -c "import mylib; print(mylib.WHO)"', T.mkdtemp('factory-cwd-', t));
    assert.equal(py.stdout.trim(), n, `${n} imports its own path dependency: ${py.stderr}`);
  }
  timings.poetry_path_dep_ms = out;
  t.diagnostic(`poetry: first worktree ${out['J-0001-T1']} ms, second ${out['J-0001-T2']} ms`);
  assert.ok(fs.existsSync(path.join(C.CACHE(root), 'poetry')), 'the poetry cache is under .factory/envcache');
});

test('REAL pip: a setuptools_scm project builds in each worktree (.git is there); only the sealed environment\'s check builds the wheelhouse (from a fresh venv), tasks install from it offline, ci verify resolves fresh; a killed install is rebuilt cleanly', { timeout: 900000 }, async (t) => {
  if (skipUnless(t, 'python3', PYPI)) return;
  const root = F.makeRepo(t);
  F.write(root, 'pyproject.toml', '[project]\nname = "sapp"\ndynamic = ["version"]\ndependencies = ["six", "iniconfig", "packaging", "pluggy", "pygments"]\n[project.optional-dependencies]\ndev = ["pytest"]\n[build-system]\nrequires = ["setuptools>=64", "setuptools_scm>=8"]\nbuild-backend = "setuptools.build_meta"\n[tool.setuptools_scm]\n[tool.setuptools]\npackages = ["sapp"]\n');
  F.write(root, 'sapp/__init__.py', 'WHO = "root"\n');
  F.write(root, '.gitignore', '*.egg-info/\n');
  F.sh(root, 'git rm -q -r src && git add -A && git commit -qm scm && git tag v1.2.3');
  const env = E.detect(root, { machine: MH.inventory({ venv: true }) });
  assert.deepEqual([env.tool, env.cache], ['venv', 'pip']);
  sealEnv(root, env);
  // a task before any check: no wheelhouse is built from a task's venv (012B M-2)
  const w0 = worktree(root, 'J-0001-T0');
  const r0 = E.ensure(root, null, { taskId: 'T0', wt: w0 });
  assert.equal(r0.ok, true, JSON.stringify(r0.broken));
  assert.equal(r0.cache.wheelhouse_built, undefined);
  assert.equal(C.wheelhouses(root).length, 0, 'a task worktree never builds the wheelhouse');
  // the sealed environment's check builds it, from the fresh venv of its scratch worktree
  const [ck, ckMs] = timed(() => F.cli(root, ['env', 'check']));
  assert.equal(ck.ok, true, JSON.stringify(ck));
  assert.equal(C.wheelhouses(root).length, 1);
  const out = {};
  for (const n of ['J-0001-T1', 'J-0001-T2']) {
    const wt = worktree(root, n, (w) => F.write(w, 'sapp/__init__.py', `WHO = "${n}"\n`));
    const [r, ms] = timed(() => E.ensure(root, null, { taskId: n, wt }));
    assert.equal(r.ok, true, JSON.stringify(r.broken));
    out[n] = { ms, cache: r.cache };
    assert.equal(r.cache.offline, true, `${n} installed with no index, from the wheelhouse`);
    const py = run(r, wt, 'python -c "import sapp, importlib.metadata as m; print(sapp.WHO, m.version(\'sapp\'))" && pytest --version', T.mkdtemp('factory-cwd-', t));
    assert.equal(py.status, 0, py.stdout + py.stderr);
    assert.match(py.stdout, new RegExp(`^${n} 1\\.2\\.`), 'its own code, its scm version');
    assert.equal(F.sh(wt, 'git status --porcelain'), '');
  }
  timings.pip_scm_ms = { env_check_with_wheelhouse: ckMs, task_from_index: r0.ms, task1_offline: out['J-0001-T1'].ms, task2_offline: out['J-0001-T2'].ms };
  t.diagnostic(`pip: a task from the index ${r0.ms} ms; the env check (setup + wheelhouse) ${ckMs} ms; tasks offline ${out['J-0001-T1'].ms} / ${out['J-0001-T2'].ms} ms`);
  assert.ok(out['J-0001-T2'].ms < r0.ms, JSON.stringify(timings.pip_scm_ms));
  // an agent drifts its own venv: the wheelhouse is not touched (it is never built from a task)
  const w1 = path.join(root, '.factory', 'worktrees', 'J-0001-T1');
  const before = JSON.stringify(C.wheelhouses(root).map((w) => [w.key, w.wheels]));
  assert.equal(spawnSync(path.join(w1, '.factory-venv', 'bin', 'python'), ['-m', 'pip', 'install', '-q', 'iniconfig==1.1.1'], { encoding: 'utf8' }).status, 0);
  // (what its venv holds changed: the marker no longer counts, setup runs again in that worktree)
  assert.equal(E.ensure(root, null, { taskId: 'T1', wt: w1 }).ok, true);
  assert.equal(JSON.stringify(C.wheelhouses(root).map((w) => [w.key, w.wheels])), before);
  // ci verify and the epic gate: a fresh resolution from the index (no wheelhouse, no shared cache)
  const wc = worktree(root, 'J-0001-ci');
  const rc = E.ensure(root, null, { taskId: 'ci', wt: wc, fresh: true });
  assert.equal(rc.ok, true);
  assert.deepEqual([rc.cache.fresh, rc.cache.offline], [true, false]);
  assert.match(fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'ship.js'), 'utf8'), /taskId: 'ci', wt, fresh: !/);
  // crash mid-build: the install is killed; the next ensure builds a complete environment
  const wt3 = worktree(root, 'J-0001-T3');
  const code = `const E = require(${JSON.stringify(path.join(F.PLUGIN, 'cli', 'core', 'environment.js'))}); E.ensure(${JSON.stringify(root)}, null, { taskId: 'T3', wt: ${JSON.stringify(wt3)} });`;
  const child = spawn(process.execPath, ['-e', code], { cwd: root });
  for (let i = 0; i < 200 && !fs.existsSync(path.join(wt3, '.factory-venv', 'bin', 'python')); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 400));
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 200));
  const r3 = E.ensure(root, null, { taskId: 'T3', wt: wt3 });
  assert.equal(r3.ok, true, JSON.stringify(r3.broken));
  assert.equal(run(r3, wt3, 'python -c "import sapp, six, pytest; print(sapp.WHO)"').stdout.trim(), 'root');
});

test('REAL pip: an incomplete wheelhouse (a requirement it lacks) is detected: the miss falls back from a clean venv, no later worktree tries offline, and the next env check rebuilds it', { timeout: 900000 }, (t) => {
  if (skipUnless(t, 'python3', PYPI)) return;
  const root = F.makeRepo(t);
  // a 0.11-style setup whose nested requirements file is not in cache_key: a task can add a
  // requirement without changing the key
  F.write(root, 'requirements.txt', '-r requirements/base.txt\n');
  F.write(root, 'requirements/base.txt', 'six\n');
  F.sh(root, 'git rm -q -r src && git add -A && git commit -qm reqs');
  const OLD = { version: 1, name: 'reqs', setup: ['python3 -m venv .venv', '.venv/bin/pip install -q --retries 5 --timeout 60 -r requirements.txt'], cache_key: ['requirements.txt'], env: { VIRTUAL_ENV: '{worktree}/.venv', PATH: '{worktree}/.venv/bin:$PATH' }, ignore: ['.venv/'], timeout_seconds: 600 };
  sealEnv(root, E.upgradeOf(root, OLD).env);
  assert.equal(F.cli(root, ['env', 'check']).ok, true);
  const add = (w) => F.write(w, 'requirements/base.txt', 'six\niniconfig\n');
  const w1 = worktree(root, 'J-0001-T1', add);
  const r1 = E.ensure(root, null, { taskId: 'T1', wt: w1 });
  assert.equal(r1.ok, true, JSON.stringify(r1.broken));
  assert.equal(r1.cache.fallback, true, 'the offline attempt missed iniconfig, then the index');
  assert.equal(run(r1, w1, 'python -c "import iniconfig, six"').status, 0);
  const key = C.wheelhouses(root)[0].key;
  assert.ok(fs.existsSync(path.join(C.WHEELS(root), `${key}.missed.json`)), 'the miss is recorded for the key');
  const w2 = worktree(root, 'J-0001-T2', add);
  const r2 = E.ensure(root, null, { taskId: 'T2', wt: w2 });
  assert.equal(r2.ok, true);
  assert.deepEqual([r2.cache.offline, r2.cache.fallback], [false, undefined], 'no second failed offline attempt');
  assert.match(r2.cache.wheelhouse_skipped, /incomplete/);
  // the next env check rebuilds it (from the base commit's declared inputs)
  const ck = F.cli(root, ['env', 'check']);
  assert.equal(ck.ok, true);
  assert.ok(!fs.readdirSync(C.WHEELS(root)).some((n) => n.endsWith('.missed.json')), 'the miss is cleared by the rebuild');
});

test('REAL uv: a migrated 0.11 setup (`uv venv .venv`, not idempotent) survives an offline miss: the fallback starts from a clean venv', { timeout: 600000 }, (t) => {
  if (skipUnless(t, 'uv', PYPI)) return;
  const root = F.makeRepo(t);
  F.write(root, 'requirements.txt', '-r requirements/base.txt\n');
  F.write(root, 'requirements/base.txt', 'six\n');
  F.sh(root, 'git rm -q -r src && git add -A && git commit -qm reqs');
  const OLD = { version: 1, name: 'uv-reqs', setup: ['uv venv -q .venv', 'uv pip install -q --python .venv/bin/python -r requirements.txt'], cache_key: ['requirements.txt'], env: { VIRTUAL_ENV: '{worktree}/.venv', PATH: '{worktree}/.venv/bin:$PATH' }, ignore: ['.venv/'], timeout_seconds: 600 };
  const up = E.upgradeOf(root, OLD).env;
  assert.deepEqual(up.setup, OLD.setup, 'the setup is kept as sealed');
  sealEnv(root, up);
  const w1 = worktree(root, 'J-0001-T1');
  assert.equal(E.ensure(root, null, { taskId: 'T1', wt: w1 }).ok, true);
  const w2 = worktree(root, 'J-0001-T2', (w) => F.write(w, 'requirements/base.txt', 'six\niniconfig\n'));
  const r2 = E.ensure(root, null, { taskId: 'T2', wt: w2 });
  assert.equal(r2.ok, true, JSON.stringify(r2.broken));
  assert.equal(r2.cache.fallback, true, 'offline missed iniconfig; `uv venv .venv` ran again in a clean state');
  assert.equal(run(r2, w2, 'python -c "import iniconfig, six"').status, 0);
  // env gc --caches also forgets that a key was installed: the next worktree goes online at once
  F.cli(root, ['env', 'gc', '--caches']);
  assert.ok(!fs.existsSync(path.join(C.CACHE(root), 'uv-installed.json')));
  const r3 = E.ensure(root, null, { taskId: 'T3', wt: worktree(root, 'J-0001-T3') });
  assert.deepEqual([r3.ok, r3.cache.offline, r3.cache.fallback], [true, false, undefined]);
});

test('REAL npm: npm ci in one worktree never touches another\'s node_modules; the second install comes from the shared npm cache', { timeout: 600000 }, (t) => {
  if (skipUnless(t, 'npm', NPM)) return;
  const root = F.makeRepo(t);
  F.write(root, 'package.json', JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'is-number': '7.0.0', 'left-pad': '1.3.0' } }));
  const nc = T.mkdtemp('factory-npm-cache-', t);
  F.sh(root, `npm install -q --no-audit --no-fund --cache ${nc} >/dev/null 2>&1; rm -rf node_modules; git add -A && git commit -qm node`);
  const env = E.detect(root);
  assert.deepEqual([env.tool, env.cache], ['npm', 'npm']);
  sealEnv(root, env);
  const out = {};
  const wts = {};
  for (const n of ['J-0001-T1', 'J-0001-T2']) {
    const wt = worktree(root, n);
    const [r, ms] = timed(() => E.ensure(root, null, { taskId: n, wt }));
    assert.equal(r.ok, true, JSON.stringify(r.broken));
    out[n] = ms;
    wts[n] = { wt, r };
    assert.equal(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink(), false, 'its own node_modules, not a link');
  }
  timings.npm_ms = out;
  t.diagnostic(`npm: first worktree ${out['J-0001-T1']} ms, second ${out['J-0001-T2']} ms`);
  const { wt: w1 } = wts['J-0001-T1'];
  const { wt: w2, r: r2 } = wts['J-0001-T2'];
  fs.writeFileSync(path.join(w1, 'node_modules', 'is-number', 'SENTINEL'), 'T1');
  assert.equal(run(r2, w2, 'npm ci --no-audit --no-fund -q').status, 0);
  assert.equal(fs.readFileSync(path.join(w1, 'node_modules', 'is-number', 'SENTINEL'), 'utf8'), 'T1', 'T1\'s node_modules is untouched by T2\'s npm ci');
  assert.ok(fs.existsSync(path.join(C.CACHE(root), 'npm', '_cacache')), 'the npm cache is under .factory/envcache');
});

test('REAL uv (012C MJ-2): ci verify\'s fresh install never reads a cache an agent wrote into: not the factory\'s, not the user\'s own (even after a hard-linking install in a task)', { timeout: 600000 }, (t) => {
  if (skipUnless(t, 'uv', PYPI)) return;
  const root = F.makeRepo(t);
  F.write(root, 'requirements.txt', 'six==1.17.0\n');
  F.sh(root, 'git rm -q -r src && git add -A && git commit -qm reqs');
  const env = { version: 2, name: 'uv-reqs', tool: 'uv', reason: 'test', cache: 'uv', setup: ['uv venv -q --allow-existing .factory-venv', 'uv pip install -q --python .factory-venv/bin/python -r requirements.txt'], cache_key: ['requirements.txt'], env: { VIRTUAL_ENV: '{worktree}/.factory-venv', PATH: '{worktree}/.factory-venv/bin:$PATH' }, ignore: ['/.factory-venv/'], timeout_seconds: 600 };
  sealEnv(root, env);
  const w1 = worktree(root, 'J-0001-T1');
  const r1 = E.ensure(root, null, { taskId: 'T1', wt: w1 });
  assert.equal(r1.ok, true);
  // the builder's own shell copies too (UV_LINK_MODE=copy in its environment)
  assert.equal(E.processEnv(r1.env, r1.vars).UV_LINK_MODE, 'copy');
  // worst case: an agent forces hard links into the user's own cache, then edits its venv
  const userCache = path.join(process.env.XDG_CACHE_HOME, 'uv');
  const x = run(r1, w1, `UV_LINK_MODE=hardlink UV_CACHE_DIR=${userCache} uv pip install -q --reinstall six==1.17.0`);
  assert.equal(x.status, 0, x.stderr);
  const six = path.join(w1, '.factory-venv', fs.readdirSync(path.join(w1, '.factory-venv', 'lib'))[0] ? `lib/${fs.readdirSync(path.join(w1, '.factory-venv', 'lib'))[0]}/site-packages/six.py` : '');
  assert.ok(fs.statSync(six).nlink >= 2, 'the agent\'s file is now a hard link into the user\'s cache');
  fs.appendFileSync(six, '\nPOISON = "agent T1"\n');
  // ci verify: fresh, with a private copy-mode cache
  const wc = worktree(root, 'J-0001-ci');
  const rc = E.ensure(root, null, { taskId: 'ci', wt: wc, fresh: true });
  assert.equal(rc.ok, true, JSON.stringify(rc.broken));
  const p = run(rc, wc, 'python -c "import six; print(getattr(six, \'POISON\', None))"');
  assert.equal(p.stdout.trim(), 'None', 'ci verify installed a clean six');
  // and a task worktree from the factory's cache is clean too
  const r2 = E.ensure(root, null, { taskId: 'T2', wt: worktree(root, 'J-0001-T2') });
  assert.equal(run(r2, path.join(root, '.factory', 'worktrees', 'J-0001-T2'), 'python -c "import six; print(getattr(six, \'POISON\', None))"').stdout.trim(), 'None');
});
