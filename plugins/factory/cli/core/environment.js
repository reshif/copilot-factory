'use strict';
// The build environment: what a task worktree needs before its code can be built and tested
// (a venv, installed dependencies, services), so builders, `task verify`, the per-wave
// integration check and prove run against the worktree's own code, not the root checkout's.
//
// .factory/environment.json (sealed; written only by `factory env set`, the human's):
//   {
//     "version": 1,
//     "name": "python-venv",                       a label
//     "setup": ["python3 -m venv .venv", ".venv/bin/pip install -q -e '.[dev]'"],
//                                                  run in each worktree, cached (see cache_key)
//     "cache_key": ["pyproject.toml", "requirements*.txt"],
//                                                  files whose content (with setup and env) keys the cache
//     "env": { "VIRTUAL_ENV": "{worktree}/.venv", "PATH": "{worktree}/.venv/bin:$PATH" },
//                                                  exported for builders and every verify command
//     "prefix": "",                                put before each verify command (e.g. "poetry run")
//     "services": { "up": "…", "health": "…", "down": "…" },
//                                                  once per job, from the project root
//     "teardown": "invoke destroy",                run in each worktree setup ran in, before
//                                                  the worktree is removed (job close, the
//                                                  scratch worktrees of env check and ci verify):
//                                                  what setup or the tests started there, e.g.
//                                                  a compose project per worktree
//     "ignore": [".venv/"],                        what setup creates: kept out of git status
//     "timeout_seconds": 1200
//   }
//
// Schema version 2 (0.12, docs/ENVIRONMENT.md): every worktree still builds its OWN environment
// with setup, exactly like version 1 (its own .factory-venv or node_modules, its own code). What
// is new is the shared package CACHE the factory gives those installs (cli/core/envcache.js) and
// the record of how and why:
//     "tool": "uv", "reason": "uv is installed: …",  how it is built and why (machine.pythonTool)
//     "cache": "uv",                               uv | pip | poetry | npm | pnpm | yarn | docker |
//                                                  none: which installer's cache the setup uses.
//                                                  uv, pip, poetry, npm, yarn and pnpm read the
//                                                  shared caches under .factory/envcache; pip also
//                                                  installs from a hash-checked wheelhouse
//                                                  (.factory/wheelhouse/<key>) without the network
//                                                  once one worktree has set up; uv runs offline
//                                                  first once a key has installed.
// A sealed version-1 environment (0.11) keeps working as it did; factory next offers the same
// setup, unchanged, as version 2 with the cache.
// The repository's own .venv (and the root checkout) is never set up, changed or removed.
//
// Placeholders in every command and value: {worktree} {root} {job} {task} ("job" for the
// job worktree), {slug} (j-0001-t1, for a compose project name) and {db} (factory_j0001_t1,
// for a database name). $VARS are left to the shell.
//
// A broken environment (a setup step or the services health check fails) is reported as
// "environment broken: <cmd> exit N: <tail>": realize parks once instead of spending builder
// attempts on it, and task verify refuses with code environment_broken.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { readJson, writeJson, exists, fail, nowIso, stableStringify } = require('../lib/util');
const { seal, valid } = require('../lib/seal');
const { matchesAny } = require('../lib/glob');
const git = require('../lib/git');

const FILE = (root) => path.join(root, '.factory', 'environment.json');
const PROPOSED = (root) => path.join(root, '.factory', 'environment.proposed.json');
const KEYS = ['version', 'name', 'tool', 'reason', 'cache', 'setup', 'cache_key', 'env', 'prefix', 'services', 'teardown', 'ignore', 'timeout_seconds', 'notes'];
const V2_ONLY = ['tool', 'reason', 'cache'];
const CACHES = ['uv', 'pip', 'poetry', 'npm', 'pnpm', 'yarn', 'docker', 'none'];
const DOC = 'docs/ENVIRONMENT.md';
const DOC_PATH = path.join(__dirname, '..', '..', DOC);

// The schema an environment is written in: its version, else 2 when it names its tool or cache.
function schemaOf(e) {
  if (!e) return 1;
  if (e.version === 1 || e.version === 2) return e.version;
  return V2_ONLY.some((k) => e[k] !== undefined) ? 2 : 1;
}
// Every command an environment runs before a verify command (lint, the network check, notices).
const commandsOf = (e) => [...((e && e.setup) || [])];
// One line saying what runs where.
function describe(e) {
  if (!e) return 'none';
  const s = `setup in every worktree: ${(e.setup || []).join(' && ') || '(none)'}`;
  if (schemaOf(e) === 2 && e.cache && e.cache !== 'none') return `${s} (with the shared ${e.cache} cache${e.cache === 'pip' ? ' and wheelhouse' : ''}: downloads once per key)`;
  return s;
}

// The schema check: the smallest set that covers a plain venv repo and a compose-based one.
function problems(e) {
  const out = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['the environment must be a JSON object'];
  for (const k of Object.keys(e)) if (!KEYS.includes(k) && k !== 'seal' && k !== 'confirmed') out.push(`unknown field "${k}" (fields: ${KEYS.join(', ')})`);
  const strs = (v, name) => {
    if (v === undefined) return;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) out.push(`${name} must be a list of non-empty strings`);
  };
  if (e.version !== undefined && e.version !== 1 && e.version !== 2) out.push('version must be 1 (0.11) or 2 (with tool, reason and the shared package cache)');
  if (schemaOf(e) === 1) for (const k of V2_ONLY) if (e[k] !== undefined) out.push(`${k} needs version 2`);
  if (e.cache !== undefined && !CACHES.includes(e.cache)) out.push(`cache must be one of ${CACHES.join(', ')}`);
  for (const k of ['tool', 'reason']) if (e[k] !== undefined && e[k] !== null && typeof e[k] !== 'string') out.push(`${k} must be a string`);
  strs(e.setup, 'setup');
  strs(e.cache_key, 'cache_key');
  strs(e.ignore, 'ignore');
  if (e.env !== undefined && (typeof e.env !== 'object' || Array.isArray(e.env) || Object.entries(e.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string'))) out.push('env must map variable names to strings');
  if (e.prefix !== undefined && typeof e.prefix !== 'string') out.push('prefix must be a string');
  if (e.teardown !== undefined && (typeof e.teardown !== 'string' || !e.teardown.trim())) out.push('teardown must be a command');
  if (e.services !== undefined) {
    const s = e.services;
    if (!s || typeof s !== 'object' || Array.isArray(s)) out.push('services must be an object {up, health, down}');
    else {
      for (const k of Object.keys(s)) if (!['up', 'health', 'down'].includes(k)) out.push(`services.${k} is not a field (up, health, down)`);
      for (const k of ['up', 'health', 'down']) if (s[k] !== undefined && (typeof s[k] !== 'string' || !s[k].trim())) out.push(`services.${k} must be a command`);
      if (!s.up) out.push('services needs an up command');
    }
  }
  if (e.timeout_seconds !== undefined && !(Number.isInteger(e.timeout_seconds) && e.timeout_seconds > 0)) out.push('timeout_seconds must be a positive integer');
  return out;
}

// The confirmed environment, or null (none configured: worktrees are used bare, as before).
// A file edited by hand fails its seal and is refused, like any other factory record.
function load(root) {
  const e = readJson(FILE(root), null);
  if (!e) return null;
  if (!valid(e)) fail(`${FILE(root)} was changed outside factory env set (its seal does not match). Run factory env set again from your terminal.`, 'environment_tampered');
  return e;
}

function loadSafe(root) {
  try {
    return { env: load(root), error: null };
  } catch (e) {
    return { env: null, error: e.message };
  }
}

const hash = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : stableStringify(x)).digest('hex');
const short = (e) => (e ? hash(strip(e)).slice(0, 8) : null);
function strip(e) {
  const { seal: _s, confirmed: _c, ...rest } = e || {};
  return rest;
}

// ---------------------------------------------------------------- detection

function read(root, f) {
  try {
    return fs.readFileSync(path.join(root, f), 'utf8');
  } catch {
    return null;
  }
}
const has = (root, f) => exists(path.join(root, f));

// A likely environment from the repo's files, with the files it rests on. The human confirms
// or edits it; nothing runs until then.
// fix 0.10.1: with this machine's tool inventory (cli/core/machine.js): a Python environment is
// made with uv when it is installed, else poetry (a poetry repo), virtualenv, and python3 -m venv
// only when it really works here; pip installs retry; never a tool that is missing or needs sudo.
// Each worktree's own venv: .factory-venv (not .venv: the ignore pattern for it can never hide
// your own .venv in the root checkout's git status).
const VENV = '.factory-venv';
const PIP = `${VENV}/bin/python -m pip install -q --retries 5 --timeout 60`;
function machineOf(given) {
  if (given !== undefined) return given;
  try {
    // a proposal is built on routing paths (factory next): the cached inventory only, never a scan
    return require('./machine').inventory({ cacheOnly: true });
  } catch {
    return null;
  }
}

// One TOML section's text ([name] up to the next [section]).
function section(text, name) {
  const m = new RegExp(`^\\[${name.replace(/\./g, '\\.')}\\]\\s*$`, 'm').exec(String(text || ''));
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const end = /^\[/m.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}
// A requirement goes into a shell command only when it is plain (name, extras, version
// specifiers): no quotes, markers or shell syntax.
const plainReq = (r) => /^[A-Za-z0-9_.-]+(\[[A-Za-z0-9_,.-]+\])?\s*([<>=!~]=?\s*[A-Za-z0-9_.*+-]+\s*,?\s*)*$/.test(r);
function buildRequires(py) {
  const b = section(py, 'build-system');
  const m = b && /^\s*requires\s*=\s*\[([\s\S]*?)\]/m.exec(b);
  const reqs = m ? [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1].trim()) : ['setuptools>=61', 'wheel'];
  return reqs.filter(plainReq);
}

// What the factory would choose for this repo on this machine, and why (factory doctor and
// factory env status show it; the proposal records it as tool and reason).
function toolChoice(root, { machine: given } = {}) {
  const py = read(root, 'pyproject.toml');
  const tasksPy = read(root, 'tasks.py');
  if (py && /nautobot/i.test(py) && tasksPy && /invoke/.test(tasksPy)) return { kind: 'nautobot', tool: 'invoke', reason: 'a Nautobot app (cookiecutter layout): invoke builds the development docker image (docker\'s layer cache makes later builds quick); each worktree runs its own compose project with its code mounted' };
  const reqs = fs.existsSync(root) ? fs.readdirSync(root).filter((f) => /^requirements[\w.-]*\.txt$/.test(f)) : [];
  if (py || reqs.length || has(root, 'setup.py') || has(root, 'setup.cfg')) {
    const poetryRepo = has(root, 'poetry.lock') || Boolean(py && /^\[tool\.poetry\]/m.test(py));
    const t = require('./machine').pythonTool(machineOf(given), { poetryRepo, poetryLock: has(root, 'poetry.lock') });
    return { kind: 'python', ...t };
  }
  const pkg = read(root, 'package.json');
  if (pkg) {
    const tool = has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'yarn.lock') ? 'yarn' : 'npm';
    return { kind: 'node', tool, reason: `${tool === 'npm' ? (has(root, 'package-lock.json') ? 'package-lock.json: npm ci' : 'no lockfile: npm install') : `${tool} lockfile: ${tool} install --frozen-lockfile`} in each worktree, from the shared ${tool} cache (offline first)` };
  }
  return { kind: 'none', tool: null, reason: 'no dependency manifest (pyproject.toml, requirements*.txt, setup.py, package.json)' };
}

// Is a path already ignored by the repository's own rules (.gitignore, your global excludes)?
function ignoredByRepo(root, p) {
  try {
    return git.run(root, ['check-ignore', '-q', '--no-index', p], { allowFail: true }).code === 0;
  } catch {
    return false;
  }
}

function detect(root, { machine: given } = {}) {
  const py = read(root, 'pyproject.toml');
  // file names go into shell commands: only plain ones (requirements-dev.txt), never shell syntax
  const reqs = fs.existsSync(root) ? fs.readdirSync(root).filter((f) => /^requirements[\w.-]*\.txt$/.test(f)) : [];
  const tasksPy = read(root, 'tasks.py');
  const pkg = read(root, 'package.json');
  const evidence = [];
  const choice = toolChoice(root, { machine: given });
  if (choice.kind === 'nautobot') {
    // A Nautobot app (the cookiecutter layout): tests run in docker compose through invoke,
    // with Postgres and Redis. One compose project per worktree (its own containers and
    // database, the worktree's code mounted), named by INVOKE_<APP>_PROJECT_NAME. Each worktree
    // runs `invoke build`; docker's layer cache makes every build after the first quick.
    const ns = (/Collection\(\s*["']([\w]+)["']\s*\)/.exec(tasksPy) || [])[1] || ((/^name\s*=\s*["']([\w-]+)["']/m.exec(py) || [])[1] || 'app').replace(/-/g, '_');
    const V = `INVOKE_${ns.toUpperCase()}`;
    evidence.push('pyproject.toml (nautobot)', 'tasks.py (invoke)');
    for (const f of ['development/docker-compose.base.yml', 'development/docker-compose.postgres.yml', 'development/docker-compose.redis.yml', 'poetry.lock']) if (has(root, f)) evidence.push(f);
    return {
      version: 2,
      name: 'nautobot-app-invoke',
      tool: choice.tool,
      reason: choice.reason,
      cache: 'docker',
      setup: ['invoke build'],
      cache_key: ['poetry.lock', 'pyproject.toml', 'development/Dockerfile', 'development/*.yml', 'development/*.env'],
      env: { [`${V}_PROJECT_NAME`]: 'factory-{slug}', [`${V}_LOCAL`]: 'false' },
      prefix: '',
      // invoke unittest leaves the project's database and redis containers running
      teardown: 'invoke destroy',
      ignore: [],
      timeout_seconds: 1800,
      notes: `Each worktree gets its own compose project (${V}_PROJECT_NAME=factory-{slug}): its own Postgres, Redis and Nautobot containers, with that worktree's code mounted. Each runs "invoke build"; docker's layer cache makes builds after the first quick while poetry.lock and the Dockerfile are unchanged. Verify commands look like "invoke unittest --failfast --label ${ns}.tests.test_x". Each project is removed with "invoke destroy" (teardown) when the job closes; for a cancelled job, run it in each .factory/worktrees/<job>-<task> yourself. See the factory's ${DOC}.`,
      evidence,
    };
  }
  if (choice.kind === 'python') {
    const dev = Boolean(py && /\[project\.optional-dependencies\][\s\S]*?^\s*dev\s*=/m.test(py));
    const pep621 = Boolean(py && /^\[project\]/m.test(py));
    const poetryRepo = Boolean(py && /^\[tool\.poetry\]/m.test(py));
    const installable = pep621 || poetryRepo || has(root, 'setup.py') || has(root, 'setup.cfg');
    const reqFiles = reqs.filter((f) => /dev|test/.test(f) || reqs.length === 1);
    const inv = machineOf(given);
    const how = choice.tool;
    const env = { VIRTUAL_ENV: `{worktree}/${VENV}`, PATH: `{worktree}/${VENV}/bin:$PATH` };
    const target = dev ? "'.[dev]'" : '.';
    let setup;
    let cache;
    if (how === 'poetry') {
      // poetry installs into the venv VIRTUAL_ENV names (this worktree's .factory-venv); its
      // artifacts come from the shared poetry cache, checked against poetry.lock's hashes
      const mk = choice.maker === 'uv' ? `uv venv -q --seed --allow-existing ${VENV}` : choice.maker === 'virtualenv' ? `virtualenv -q ${VENV}` : `python3 -m venv ${VENV}`;
      setup = [mk, 'poetry install --no-interaction', ...reqFiles.map((f) => `${PIP} -r ${f}`)];
      cache = 'poetry';
    } else if (how === 'uv') {
      const uvPip = `uv pip install -q --python ${VENV}/bin/python`;
      if (has(root, 'uv.lock') && pep621) {
        // uv sync into this worktree's venv: the project and every workspace member editable from
        // this worktree; packages hard-linked from the shared uv cache
        setup = [`uv sync -q --frozen${dev ? ' --extra dev' : ''}`];
        env.UV_PROJECT_ENVIRONMENT = `{worktree}/${VENV}`;
      } else setup = [`uv venv -q --seed --allow-existing ${VENV}`, ...(installable ? [`${uvPip} -e ${target}`] : []), ...reqFiles.map((f) => `${uvPip} -r ${f}`)];
      // uv retries on its own; its HTTP timeout is raised for slow indexes
      env.UV_HTTP_TIMEOUT = '60';
      cache = 'uv';
    } else {
      const mk = how === 'virtualenv' ? `virtualenv -q ${VENV}` : `python3 -m venv ${VENV}`;
      setup = [mk, `${PIP} --upgrade pip`, ...(installable ? [`${PIP} -e ${target}`] : []), ...reqFiles.map((f) => `${PIP} -r ${f}`)];
      cache = 'pip';
    }
    if (py) evidence.push('pyproject.toml');
    evidence.push(...reqs, ...['setup.py', 'setup.cfg', 'poetry.lock', 'uv.lock'].filter((f) => has(root, f)));
    if (inv) evidence.push(`this machine: ${how ? `${how} (${how === 'venv' ? 'python3 -m venv works' : 'installed'})` : 'no working venv tool (python3 -m venv fails: install uv or virtualenv)'}`);
    return {
      version: 2,
      name: how === 'uv' ? 'python-uv' : how === 'poetry' ? 'python-poetry' : 'python-venv',
      tool: how || 'none-available',
      reason: choice.reason,
      cache,
      setup,
      cache_key: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements*.txt', 'requirements/*.txt', 'constraints*.txt', 'poetry.lock', 'uv.lock', '.python-version'],
      env,
      prefix: '',
      // an editable setuptools install writes <name>.egg-info into the worktree: kept out of git
      // status only when the repository does not ignore it already (doctor says the pattern also
      // applies to your checkout)
      ignore: [`/${VENV}/`, ...(installable && !ignoredByRepo(root, 'x.egg-info/') ? ['/*.egg-info/'] : [])],
      timeout_seconds: 1200,
      notes: `Each worktree gets its own ${VENV} with the project installed in editable mode from that worktree (workspace members and path dependencies too), so python, pytest and console scripts import the worktree's code. Downloads are shared: the ${cache} cache under .factory/envcache${cache === 'pip' ? ', and a hash-checked wheelhouse per lockfile, so a later worktree installs without the network' : ''}. Your own .venv is never touched. Write verify commands as "python -m pytest …" or "pytest …". See the factory's ${DOC}.${how ? '' : ' python3 -m venv does not work on this machine (no ensurepip) and neither uv nor virtualenv is installed: install uv (no sudo), then propose again.'}`,
      evidence,
    };
  }
  if (choice.kind === 'node') {
    const lock = has(root, 'package-lock.json') ? 'npm ci --no-audit --no-fund' : has(root, 'pnpm-lock.yaml') ? 'pnpm install --frozen-lockfile' : has(root, 'yarn.lock') ? 'yarn install --frozen-lockfile' : null;
    let deps = false;
    try {
      const p = JSON.parse(pkg);
      deps = Boolean(Object.keys({ ...(p.dependencies || {}), ...(p.devDependencies || {}) }).length);
    } catch {
      deps = false;
    }
    evidence.push('package.json', ...['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].filter((f) => has(root, f)));
    if (!deps && !lock) return { version: 2, name: 'none', tool: null, reason: 'package.json has no dependencies', cache: 'none', setup: [], notes: 'package.json has no dependencies: worktrees need no setup.', evidence };
    // node_modules in each worktree: kept out of git status only when the repository does not
    // already ignore it (the pattern would also apply to your checkout's node_modules)
    const ignore = ignoredByRepo(root, 'node_modules/') ? [] : ['/node_modules/'];
    return {
      version: 2,
      name: 'node',
      tool: choice.tool,
      reason: choice.reason,
      cache: choice.tool,
      setup: [lock || 'npm install --no-audit --no-fund'],
      cache_key: ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.npmrc'],
      env: { PATH: '{worktree}/node_modules/.bin:$PATH' },
      prefix: '',
      ignore,
      timeout_seconds: 900,
      notes: `Each worktree installs its own node_modules; the packages come from the shared ${choice.tool} cache under .factory/envcache (offline first; the lockfile's integrity hashes are checked). See the factory's ${DOC}.`,
      evidence,
    };
  }
  return { version: 2, name: 'none', tool: null, reason: choice.reason, cache: 'none', setup: [], notes: 'No dependency manifest found: worktrees need no setup.', evidence: [] };
}

// ---------------------------------------------------------------- lint against this machine
//
// What makes an environment fail on THIS machine before anything runs (fix 0.10.1; J-0001 hit
// all of these after its plan gate): a venv without ensurepip, a tool that is not installed or
// needs sudo, setup reading a file a (non-bootstrap) task of the plan creates, a service health
// check that runs once instead of waiting, pip without retries. Returns [{ rule, cmd, message }].
const KNOWN_TOOLS = new Set(['virtualenv', 'uv', 'uvx', 'poetry', 'pipenv', 'pyenv', 'pipx', 'docker', 'docker-compose', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'python', 'python3']);
function segments(cmd) {
  return String(cmd || '').split(/&&|\|\||;|\|/).map((x) => x.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').replace(/^env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '').trim()).filter(Boolean);
}
// The files a setup command reads from the worktree.
function readsOf(cmd) {
  const out = [];
  for (const seg of segments(cmd)) {
    let m;
    const re = /(?:^|\s)(?:-r|--requirement|-c|--constraint)[=\s]+(['"]?)([^\s'"]+)\1/g;
    while ((m = re.exec(seg))) out.push([m[2]]);
    if (/\bpip3?\s+install\b|\buv\s+pip\s+install\b/.test(seg) && /(?:^|\s)(?:-e\s+)?['"]?\.(?:\[[\w,-]+\])?['"]?(?:\s|$)/.test(seg)) out.push(['pyproject.toml', 'setup.py', 'setup.cfg']);
    if (/^poetry\s+install\b|^uv\s+sync\b|^pipenv\s+install\b/.test(seg)) out.push(/^pipenv/.test(seg) ? ['Pipfile'] : ['pyproject.toml']);
    if (/^npm\s+ci\b/.test(seg)) out.push(['package-lock.json']);
    if (/^(npm\s+(install|i)|pnpm\s+(install|i)|yarn(\s+install)?|bun\s+install)\b/.test(seg) && !/\s(?!-)\S+@?\S*\s*$/.test(seg.replace(/^(npm|pnpm|bun)\s+(install|i)|^yarn(\s+install)?/, '').replace(/\s--?[\w-]+(=\S+)?/g, ''))) out.push(['package.json']);
    const f = /\bdocker(?:-compose|\s+compose)\b.*?\s-f\s+(\S+)/.exec(seg);
    if (f) out.push([f[1]]);
  }
  return out.map((alts) => alts.filter((x) => !/[{}$*]/.test(x))).filter((alts) => alts.length);
}
function lint(env, { root, base = 'HEAD', plan = null, machine = null } = {}) {
  const e = env || {};
  const out = [];
  const add = (rule, cmd, message) => out.push({ rule, cmd, message });
  const inv = machine;
  const setup = commandsOf(e);
  const svc = e.services || null;
  const all = [...setup, ...(e.teardown ? [e.teardown] : []), ...(svc ? [svc.up, svc.health, svc.down].filter(Boolean) : [])];
  const M = require('./machine');
  for (const cmd of all) {
    for (const seg of segments(cmd)) {
      const head = seg.split(/\s+/)[0];
      if (head === 'sudo') add('needs_sudo', cmd, `uses sudo: a setup runs unattended in every worktree and never asks for a password; install what needs root yourself once, and leave it out of the environment`);
      else if (inv && /^python3?(\.\d+)?$/.test(head) && !inv.python.some((p) => p.cmd === head) && !(head === 'python' && inv.python.length)) add('missing_tool', cmd, `\`${head}\` is not installed on this machine (found: ${inv.python.map((p) => p.cmd).join(', ') || 'no python'})`);
      else if (inv && KNOWN_TOOLS.has(head) && !/^python/.test(head)) {
        const tool = head === 'uvx' ? 'uv' : head === 'npx' ? 'npm' : head;
        if (!M.has(inv, tool)) add('missing_tool', cmd, `\`${head}\` is not installed on this machine: use a tool it has (${['uv', 'poetry', 'virtualenv', 'pipx', 'node', 'npm', 'pnpm', 'yarn', 'docker'].filter((t) => M.has(inv, t)).join(', ') || 'none of the usual'}), or install it yourself (no sudo: uv installs with curl -LsSf https://astral.sh/uv/install.sh | sh), then factory doctor --machine`);
        else if (head === 'docker' && /^docker\s+compose\b/.test(seg) && inv.docker.compose !== 'docker compose') add('missing_tool', cmd, `\`docker compose\` is not available here (${inv.docker.compose || 'no compose'})`);
        else if (head === 'docker' && inv.docker.daemon && inv.docker.daemon !== 'reachable') add('missing_tool', cmd, `the docker daemon is ${inv.docker.daemon === 'needs_sudo' ? 'reachable only with sudo (add yourself to the docker group)' : 'not running'} on this machine`);
      }
      if (/\bpip3?\s+install\b/.test(seg) && !/\buv\s+pip\s+install\b/.test(seg) && !/--retries\b/.test(seg) && !/--no-index\b/.test(seg)) add('pip_no_retries', cmd, 'pip installs without retries: one slow or dropped connection to the package index fails the whole setup; add --retries 5 --timeout 60 (or use uv, which retries)');
    }
  }
  for (const cmd of setup) {
    if (inv && inv.venv && inv.venv.works === false && /\bpython[\d.]*\s+-m\s+venv\b/.test(cmd) && !/--without-pip\b/.test(cmd)) add('venv_no_ensurepip', cmd, `\`python3 -m venv\` does not work on this machine (${inv.venv.why || 'no ensurepip'}; installing python3-venv needs sudo): use ${M.has(inv, 'uv') ? '`uv venv`' : M.has(inv, 'virtualenv') ? '`virtualenv`' : 'uv or virtualenv (install uv without sudo)'}; after installing something, factory doctor --machine scans again`);
  }
  // files setup reads: on the base commit, or written first by the bootstrap task
  if (root) {
    const git = require('../lib/git');
    const { matchesAny } = require('../lib/glob');
    const tasks = (plan && plan.tasks) || [];
    const at = (f) => git.run(root, ['cat-file', '-e', `${base}:${f.replace(/^\.\//, '')}`], { allowFail: true }).code === 0;
    for (const cmd of setup) {
      for (const alts of readsOf(cmd)) {
        if (alts.some(at)) continue;
        const makers = tasks.filter((t) => alts.some((f) => matchesAny(f.replace(/^\.\//, ''), t.allowed_paths || [])));
        if (makers.some((t) => t.bootstrap === true)) continue;
        add('setup_reads_plan_file', cmd, makers.length ? `reads ${alts[0]}, which ${makers.map((t) => t.id).join(', ')} create${makers.length > 1 ? '' : 's'} (not a bootstrap task): every worktree, ${makers[0].id}'s own included, is set up before that file exists. Install from pins directly in the setup (e.g. pip install 'django==5.0.6'), or make the task that writes ${alts[0]} the bootstrap task ("bootstrap": true) that every other task depends on` : `reads ${alts[0]}, which does not exist at the base commit and no task creates it`);
      }
    }
  }
  if (svc && svc.up) {
    const waits = (c) => /\b(until|while)\b|\bfor\b[^;]*;\s*do\b|--wait\b|--retry\b|\bretries\b|wait-for|\btimeout\s+\d/.test(String(c || ''));
    if (svc.health && !waits(svc.health)) add('single_health_check', svc.health, 'the service health check runs once, right after start, before the service is ready (a database takes seconds): wait with a deadline, e.g. `for i in $(seq 60); do pg_isready -h localhost && exit 0; sleep 1; done; exit 1`, or `docker compose up --wait`');
    else if (!svc.health && !waits(svc.up)) add('single_health_check', svc.up, 'nothing waits for the services to be ready: add a health command that retries with a deadline (or `docker compose up --wait`)');
  }
  return out;
}

// What `factory env set` would confirm: the main session's proposal file, else (a sealed 0.11
// environment the shared model can replace) its upgrade, else detection.
function proposal(root) {
  const p = readJson(PROPOSED(root), null);
  if (p) return { ...p, source: 'factory env propose' };
  const { env: conf } = loadSafe(root);
  const up = conf ? upgradeOf(root, conf) : null;
  if (up && up.env) return { ...up.env, source: 'your sealed 0.11 environment, unchanged, with the 0.12 shared package cache' };
  return { ...detect(root), source: 'detected from the repo files' };
}

// The version-2 environment that replaces a sealed version-1 one: the SAME environment, every
// field and every setup step exactly as sealed (pins, extras, constraints and requirement files
// included), plus the tool it uses, the reason, and the cache the factory gives its installs.
// Nothing is re-detected. Offered only when the setup uses an installer the cache serves.
// { env } or { why } or null (nothing to upgrade).
function cacheOf(cmds) {
  const t = cmds.join('\n');
  if (/\buv\s+(sync|pip\s+install|venv)\b/.test(t)) return 'uv';
  if (/\bpoetry\s+install\b/.test(t)) return 'poetry';
  if (/\bpip3?\s+install\b|-m\s+pip\s+install\b/.test(t)) return 'pip';
  if (/\bpnpm\s+(install|i)\b/.test(t)) return 'pnpm';
  if (/\byarn(\s+install)?\b/.test(t)) return 'yarn';
  if (/\bnpm\s+(ci|install|i)\b/.test(t)) return 'npm';
  if (/\binvoke\s+build\b|\bdocker(-compose|\s+compose)?\s+build\b/.test(t)) return 'docker';
  return 'none';
}
function upgradeOf(root, conf) {
  if (!conf || schemaOf(conf) !== 1 || isNone(conf) || !(conf.setup || []).length) return null;
  const cache = cacheOf(conf.setup || []);
  if (cache === 'none') return { why: 'its setup uses no installer the shared cache serves (uv, pip, poetry, npm, pnpm, yarn, docker build): nothing to speed up' };
  const { seal: _s, confirmed: _c, source: _src, evidence: _ev, hash: _h, problems: _p, ...same } = conf;
  const tool = cache === 'docker' ? 'docker' : cache;
  return {
    env: {
      ...same,
      version: 2,
      tool,
      reason: `your sealed 0.11 setup, unchanged (every step as you sealed it); its ${cache} installs now share the factory's package cache${cache === 'pip' ? ' and a hash-checked wheelhouse' : ''}`,
      cache,
    },
  };
}

// ---------------------------------------------------------------- expansion

function vars(root, state, taskId, wt) {
  const job = state ? state.id : 'envcheck';
  const scope = taskId || 'job';
  const slug = `${job}-${scope}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return { worktree: wt, root, job, task: scope, slug, db: `factory_${slug.replace(/-/g, '')}`.slice(0, 60) };
}
const expand = (s, v) => String(s).replace(/\{(worktree|root|job|task|slug|db|env)\}/g, (m, k) => (v[k] === undefined || v[k] === null ? m : v[k]));
const dq = (s) => `"${String(s).replace(/(["\\`])/g, '\\$1')}"`; // $VARS stay live for the shell

// The shell text put before every command: the env as exports (after the login profile, which
// may reset PATH), then the prefix.
function preamble(e, v) {
  if (!e) return '';
  return Object.entries(e.env || {}).map(([k, val]) => `export ${k}=${dq(expand(val, v))}; `).join('');
}
function wrap(e, v, cmd) {
  if (!e) return cmd;
  return `${preamble(e, v)}${e.prefix ? `${expand(e.prefix, v)} ` : ''}${cmd}`;
}

// The env for a process the runner starts (a builder): values expanded, $VAR from this env.
// under a base environment (the probe, a sandboxed check) $VAR expands from that allowlist, never
// from the user's full environment (a declared `X: $GH_TOKEN` would carry the token in)
function processEnv(e, v, base = BASE_ENV || process.env) {
  const out = {};
  for (const [k, val] of Object.entries((e && e.env) || {})) out[k] = expand(val, v).replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, n) => (n in out ? out[n] : base[n] || ''));
  return out;
}

// ---------------------------------------------------------------- running it

// The plan probe (cli/core/probe.js) runs setup with an allowlisted environment (no tokens or
// credentials) and no terminal: withBaseEnv sets that base for the commands run inside fn.
let BASE_ENV = null;
function withBaseEnv(base, fn) {
  const prev = BASE_ENV;
  BASE_ENV = base;
  try {
    return fn();
  } finally {
    BASE_ENV = prev;
  }
}

function sh(cmd, cwd, timeoutSec, extraEnv = {}) {
  const started = Date.now();
  // Under a base environment (the plan probe's allowlist, an unconfirmed environment's check) never
  // a login shell: bash -l re-reads the user's profile (~/.bash_profile, ~/.profile: found through
  // passwd even with HOME elsewhere), which can export the very tokens the allowlist removed
  // (review MAJ-3). The confirmed environment, sealed by the human, keeps the login shell their
  // tools may need (a version manager on the PATH).
  const argv = BASE_ENV ? ['--noprofile', '--norc', '-c', cmd] : ['-lc', cmd];
  const r = spawnSync('bash', argv, { cwd, encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024, ...(BASE_ENV ? { stdio: ['ignore', 'pipe', 'pipe'] } : {}), env: { ...(BASE_ENV || process.env), CI: process.env.CI || '1', FACTORY_ENV_SETUP: '1', ...extraEnv } });
  const out = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`;
  return { code: r.status === null ? -1 : r.status, timed_out: Boolean(r.error && r.error.code === 'ETIMEDOUT'), ms: Date.now() - started, output: out.length > 2000 ? `…${out.slice(-2000)}` : out };
}

function broken(step, cmd, r) {
  const tail = String(r.output || '').trim().split('\n').slice(-8).join('\n');
  return { step, cmd, code: r.code, timed_out: r.timed_out, tail, reason: `environment broken: ${cmd} exit ${r.timed_out ? 'timeout' : r.code}: ${tail.slice(-600) || '(no output)'}` };
}

// The cache key for a worktree: setup, env and prefix, plus the content of every cache_key
// file present in that worktree.
function cacheFiles(e, wt) {
  const files = [];
  const pats = e.cache_key || [];
  if (!pats.length) return files;
  let tracked = [];
  try {
    tracked = git.out(wt, ['ls-files']).split('\n').filter(Boolean);
  } catch {
    tracked = [];
  }
  for (const f of tracked.filter((x) => matchesAny(x, pats)).sort()) {
    try {
      files.push([f, hash(fs.readFileSync(path.join(wt, f)))]);
    } catch {
      /* listed but missing */
    }
  }
  return files;
}
function cacheKey(e, wt) {
  const files = cacheFiles(e, wt);
  return hash({ setup: e.setup || [], env: e.env || {}, prefix: e.prefix || '', files, ...(schemaOf(e) === 2 ? { cache: e.cache || null } : {}) });
}

function markerFile(wt) {
  const gd = path.resolve(wt, git.out(wt, ['rev-parse', '--git-dir']));
  return path.join(gd, 'factory-env.json');
}

// What setup creates (.venv/, node_modules/) must not make the worktree dirty: the common
// info/exclude applies to every worktree. A version-1 environment's patterns are appended as they
// were (0.11). A version-2 one's go into one block the factory owns and rewrites, marked so a
// person reading .git/info/exclude sees where they came from. The python templates name only what
// exists in factory worktrees (/.factory-venv/), so your own .venv stays visible; a node template
// adds /node_modules/ only when the repository does not ignore it already (and doctor says that it
// also applies to your checkout). Only the sealed environment writes the block: a proposal's check
// or the probe never rewrites it (review m-2).
const BLOCK_START = '# >>> copilot-factory: worktree build environments (managed; factory docs/ENVIRONMENT.md)';
const BLOCK_END = '# <<< copilot-factory';
function excludeFile(root) {
  return path.join(path.resolve(root, git.out(root, ['rev-parse', '--git-common-dir'])), 'info', 'exclude');
}
function ensureIgnored(root, e) {
  const list = (e && e.ignore) || [];
  const f = excludeFile(root);
  const cur = exists(f) ? fs.readFileSync(f, 'utf8') : '';
  if (schemaOf(e) === 2) {
    const want = [...new Set(list)];
    const re = new RegExp(`${BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*?${BLOCK_END}\\n?`);
    const block = `${BLOCK_START}\n${want.join('\n')}\n${BLOCK_END}\n`;
    const m = re.exec(cur);
    if (!want.length && !m) return;
    if (m && m[0] === block) return;
    const next = m ? cur.replace(re, block) : `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${block}`;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, next);
    return;
  }
  if (!list.length) return;
  const have = new Set(cur.split('\n').map((l) => l.trim()));
  const add = list.filter((p) => !have.has(p));
  if (add.length) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  }
}
// What info/exclude holds that the factory put there for worktree environments, and which of it
// also hides something in the root checkout (factory doctor shows it).
function excludeReport(root) {
  let cur = '';
  try {
    cur = fs.readFileSync(excludeFile(root), 'utf8');
  } catch {
    cur = '';
  }
  const lines = cur.split('\n').map((l) => l.trim());
  const i = lines.indexOf(BLOCK_START);
  const j = lines.indexOf(BLOCK_END);
  const managed = i >= 0 && j > i ? lines.slice(i + 1, j).filter(Boolean) : [];
  // a 0.11 environment appended `.venv/`: it also hides the root checkout's .venv from git status
  const legacy = lines.filter((l, k) => (k < i || k > j || i < 0) && /^\.venv\/?$/.test(l));
  // managed patterns that also match something in your checkout (e.g. /node_modules/)
  let top = [];
  try {
    top = fs.readdirSync(root);
  } catch {
    top = [];
  }
  const { matchesAny: mm } = require('../lib/glob');
  const alsoRoot = managed.filter((m) => { const g = m.replace(/^\/|\/$/g, ''); return top.some((n) => n === g || mm(n, [g])); });
  return { file: excludeFile(root), managed, also_hides_in_checkout: alsoRoot, legacy_venv: legacy.length > 0 };
}

// Job-level services: up once per job (recorded in the job state), health checked every time.
// A wave's tasks are prepared in parallel: the first brings the services up while the others
// wait for it (two `docker compose up` on one project at once fail), then each checks health.
function ensureServices(root, state, e, v) {
  const s = e.services;
  if (!s || !s.up) return { ok: true };
  if (!state) return servicesUp(root, null, e, v);
  const T = e.timeout_seconds || 1200;
  const file = path.join(require('../lib/paths').jobPaths(root, state.id).dir, 'services.lock');
  return require('./job').withLock(file, () => servicesUp(root, state, e, v), { waitMs: (2 * T + 360) * 1000, staleMs: (2 * T + 360) * 1000, what: `${state.id}'s services` });
}

function servicesUp(root, state, e, v) {
  const s = e.services;
  const T = e.timeout_seconds || 1200;
  const job = require('./job');
  const key = hash({ up: s.up, env: e.env || {} });
  const fresh = state ? job.load(root, state.id) : null;
  // a job's services run from the checkout; a check's (no job: env check, the probe, a repair
  // candidate) from its scratch worktree, never the user's checkout (release review M3)
  const home = state ? root : v.worktree || root;
  const jv = { ...v, worktree: home, task: 'job', slug: `${v.job}`.toLowerCase(), db: `factory_${String(v.job).toLowerCase().replace(/[^a-z0-9]/g, '')}` };
  const env = processEnv(e, jv);
  const up = () => {
    const r = sh(expand(s.up, jv), home, T, env);
    if (r.code !== 0) return broken('services.up', expand(s.up, jv), r);
    if (fresh) job.mutate(root, fresh.id, (st) => { st.environment_services = { key, up_at: nowIso() }; });
    return null;
  };
  const healthy = () => {
    if (!s.health) return null;
    const r = sh(expand(s.health, jv), home, Math.min(T, 300), env);
    return r.code === 0 ? null : broken('services.health', expand(s.health, jv), r);
  };
  const wasUp = Boolean(fresh && fresh.environment_services && fresh.environment_services.key === key);
  if (!wasUp) {
    const b = up();
    if (b) return { ok: false, broken: b };
  }
  let h = healthy();
  // Brought up earlier in this job but unhealthy now (the machine rebooted, docker restarted):
  // up once more before calling the environment broken, or every resume would park again.
  if (h && wasUp) {
    const b = up();
    if (b) return { ok: false, broken: b };
    h = healthy();
  }
  if (h) return { ok: false, broken: h };
  return { ok: true };
}

// Where a worktree's own environment lives, when the environment says (its VIRTUAL_ENV) or the
// templates put it: the marker's check that it is still there (review M-6: a `git clean -fdx` in
// the worktree removes it, and a cached marker must not call that ready).
function envDirs(e, v, wt) {
  const out = [];
  const ve = (e.env || {}).VIRTUAL_ENV || (e.env || {}).UV_PROJECT_ENVIRONMENT;
  if (ve) out.push(path.join(path.resolve(wt, expand(ve, v)), 'bin', 'python'));
  if (['npm', 'pnpm', 'yarn'].includes(e.cache) || /\b(npm\s+(ci|install)|pnpm\s+install|yarn(\s+install)?)\b/.test((e.setup || []).join('\n'))) out.push(path.join(wt, 'node_modules'));
  return out;
}
function venvPython(e, v, wt) {
  for (const f of envDirs(e, v, wt)) if (/bin\/python$/.test(f) && exists(f)) return f;
  for (const d of ['.factory-venv', '.venv']) if (exists(path.join(wt, d, 'bin', 'python'))) return path.join(wt, d, 'bin', 'python');
  return null;
}

// Make the environment ready in one worktree: services (once per job), then setup, cached by
// the key above. { ok, env, vars, ran, cached, key } or { ok: false, broken }.
// Every worktree builds its own environment. Version 2 adds the shared package cache
// (cli/core/envcache.js): uv, pip, poetry, npm, pnpm and yarn caches; for pip a hash-checked
// wheelhouse installed from without the network (falling back to the index when it lacks a wheel);
// for uv an offline attempt once a key has installed.
// One setup per worktree at a time (a lock naming its holder's pid and start time, never taken
// over while that process lives); setup's processes carry a tag, so a run whose owner was killed
// is ended (its processes too) before the next one starts (review M-7).
// `fresh`: no shared cache and no wheelhouse (ci verify and the epic gate resolve from the index,
// as 0.11 did: 012B M-2). `buildWheelhouse`: after a successful setup, build (or rebuild an
// incomplete) pip wheelhouse from this fresh venv: only environment.check (the sealed
// environment's check in a scratch worktree of the base commit) passes it.
function ensure(root, state, { taskId = null, wt, env: given, fresh = false, buildWheelhouse = false } = {}) {
  const e = given !== undefined ? given : load(root);
  const v = vars(root, state, taskId, wt);
  if (!e || inert(e)) return { ok: true, env: e, vars: v, ran: [], cached: false, key: null, none: true };
  // never the user's own checkout (or the .venv in it): only factory worktrees are set up
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  if (wt && real(wt) === real(root)) fail('The factory never sets up the root checkout (your own .venv stays yours): environments are made in factory worktrees only.', 'bad_input');
  const readOnly = Boolean(BASE_ENV);
  if (!readOnly) ensureIgnored(root, e);
  const svc = ensureServices(root, state, e, v);
  if (!svc.ok) return { ok: false, broken: svc.broken, env: e, vars: v };
  const key = cacheKey(e, wt);
  const run = () => setupIn(root, e, v, wt, key, { readOnly, state, taskId, fresh, buildWheelhouse });
  if (readOnly) return run();
  let lockFile = null;
  try {
    lockFile = `${markerFile(wt)}.lock`;
  } catch {
    lockFile = null;
  }
  if (!lockFile) return run();
  const T = e.timeout_seconds || 1200;
  const wait = (T * Math.max(1, (e.setup || []).length) + 600) * 1000;
  return require('./job').withLock(lockFile, run, { waitMs: wait, staleMs: wait, what: `the build environment of ${path.basename(wt)}` });
}

// What the environment holds, cheaply (012B m-6): the distributions in its site-packages, or the
// top-level packages of node_modules. A cached marker counts only while all of them are there.
function fingerprint(e, v, wt) {
  const out = [];
  const py = venvPython(e, v, wt);
  if (py) {
    const venv = path.dirname(path.dirname(py));
    for (const lib of ['lib', 'lib64']) {
      let ds = [];
      try {
        ds = fs.readdirSync(path.join(venv, lib)).filter((n) => /^python\d/.test(n));
      } catch {
        ds = [];
      }
      for (const d of ds) {
        try {
          for (const n of fs.readdirSync(path.join(venv, lib, d, 'site-packages'))) if (/\.dist-info$/.test(n)) out.push(path.join(path.relative(wt, venv), lib, d, 'site-packages', n));
        } catch {
          /* none */
        }
      }
      if (out.length) break;
    }
  }
  if (envDirs(e, v, wt).some((f) => /node_modules$/.test(f))) {
    try {
      for (const n of fs.readdirSync(path.join(wt, 'node_modules'))) if (!n.startsWith('.')) out.push(path.join('node_modules', n));
    } catch {
      /* none */
    }
  }
  return out.sort();
}

function uvInstalled(root, wkey, set) {
  const C = require('./envcache');
  const f = path.join(C.CACHE(root), 'uv-installed.json');
  if (set === undefined) return Boolean((readJson(f, {}) || {})[wkey]);
  fs.mkdirSync(C.CACHE(root), { recursive: true });
  // a read-modify-write under a lock: parallel first installs keep every key (012B m-7)
  return require('./job').withLock(`${f}.lock`, () => {
    const cur = readJson(f, {}) || {};
    if (set) cur[wkey] = nowIso();
    else delete cur[wkey];
    writeJson(f, cur);
  }, { waitMs: 30000, staleMs: 60000, what: 'uv-installed.json' });
}

function setupIn(root, e, v, wt, key, { readOnly, state, taskId, fresh = false, buildWheelhouse = false }) {
  let marker = null;
  try {
    marker = readJson(markerFile(wt), null);
  } catch {
    marker = null;
  }
  // a run that never finished: its owner died (the lock was free); end what it left running
  if (marker && marker.building && marker.tag) {
    try {
      require('./probe').survivors(marker.tag, { wt: null });
    } catch {
      /* nothing left */
    }
  }
  const present = envDirs(e, v, wt).every((f) => exists(f)) && (marker && Array.isArray(marker.holds) ? marker.holds.every((f) => exists(path.join(wt, f))) : true);
  if (marker && marker.key === key && marker.ok && present) return { ok: true, env: e, vars: v, ran: [], cached: true, key };
  const C = require('./envcache');
  const v2 = schemaOf(e) === 2 && e.cache && e.cache !== 'none';
  const T = e.timeout_seconds || 1200;
  const penv = processEnv(e, v);
  const tag = `envbuild-${require('crypto').randomBytes(6).toString('hex')}`;
  // the wheelhouse / offline key: the cache_key files' content, the setup, the tool, the python
  const files = cacheFiles(e, wt);
  const wkey = v2 ? C.keyOf(e, files, readOnly ? BASE_ENV : process.env) : null;
  const shared = v2 && !readOnly && !fresh ? C.cacheEnv(root) : {};
  let offline = {};
  let wh = null;
  if (v2 && !fresh && e.cache === 'pip') {
    wh = C.verify(root, wkey);
    if (wh.ok) {
      offline = { PIP_NO_INDEX: '1', PIP_FIND_LINKS: wh.dir };
      if (!readOnly) C.touch(wh.dir);
    }
  }
  if (v2 && !fresh && e.cache === 'uv' && !readOnly && uvInstalled(root, wkey)) offline = { UV_OFFLINE: '1' };
  try {
    writeJson(markerFile(wt), { key, ok: false, building: true, tag, owner: { pid: process.pid, start: (require('./probe').procStat(process.pid) || {}).start || null }, at: nowIso() });
  } catch {
    /* no marker: setup runs again next time anyway */
  }
  const attempt = (extra) => {
    const ran = [];
    for (const step of e.setup || []) {
      const cmd = expand(step, v);
      const r = sh(`${preamble(e, v)}${cmd}`, wt, T, { ...shared, ...penv, ...extra, ...(readOnly ? {} : { FACTORY_PROBE_ID: tag }) });
      ran.push({ cmd: C.redact(cmd), code: r.code, ms: r.ms });
      if (r.code !== 0) return { ok: false, ran, broken: broken('setup', cmd, r) };
    }
    return { ok: true, ran };
  };
  // the environment's own directories inside this worktree (never anything outside it)
  const cleanEnvDirs = () => {
    const dirs = envDirs(e, v, wt).map((f) => (/node_modules$/.test(f) ? f : path.dirname(path.dirname(f))));
    for (const d of dirs) {
      const rel = path.relative(wt, d);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) fs.rmSync(d, { recursive: true, force: true });
    }
  };
  const started = Date.now();
  let res = attempt(offline);
  let fallback = null;
  if (!res.ok && Object.keys(offline).length) {
    // the wheelhouse (or uv's cache) lacks something: the index this time, from a clean state (a
    // setup step such as `uv venv .venv` is not idempotent: 012B M-3); the key is marked so no
    // later worktree tries offline again before the next env check rebuilds it (012B M-4)
    fallback = { offline_failed: C.redact(res.broken.cmd) };
    if (!readOnly) {
      if (e.cache === 'pip') C.markMissed(root, wkey, res.broken.cmd);
      if (e.cache === 'uv') uvInstalled(root, wkey, false);
    }
    const first = res.ran;
    cleanEnvDirs();
    res = attempt({});
    res.ran = [...first.map((x) => ({ ...x, offline: true })), ...res.ran];
  }
  const ms = Date.now() - started;
  if (!res.ok) {
    try {
      writeJson(markerFile(wt), { key, ok: false, at: nowIso(), failed: C.redact(res.broken.cmd) });
    } catch {
      /* runs again next time */
    }
    if (!readOnly) C.recordLast(root, { at: nowIso(), ok: false, phase: 'setup', worktree: wt, job: state ? state.id : null, task: taskId || 'job', cmd: res.broken.cmd, code: res.broken.code, tail: res.broken.tail, ms });
    return { ok: false, broken: { ...res.broken, cmd: C.redact(res.broken.cmd), tail: C.redact(res.broken.tail), reason: C.redact(res.broken.reason) }, env: e, vars: v, ran: res.ran };
  }
  let cacheInfo = null;
  if (v2) {
    cacheInfo = { kind: e.cache, ...(fresh ? { fresh: true } : {}), offline: Boolean(Object.keys(offline).length) && !fallback, ...(fallback ? { fallback: true } : {}), ...(wh && wh.ok ? { wheelhouse: wkey.slice(0, 16) } : wh && !wh.ok && wh.why !== 'none' ? { wheelhouse_skipped: wh.why } : {}) };
    if (!readOnly && !fresh && buildWheelhouse && e.cache === 'pip' && (!wh || !wh.ok)) {
      const b = C.buildWheelhouse(root, wkey, { python: venvPython(e, v, wt), buildRequires: buildRequires(read(wt, 'pyproject.toml')), env: { ...process.env, ...penv }, timeoutSec: T, force: true });
      cacheInfo.wheelhouse_built = b.ok ? `${wkey.slice(0, 16)} (${b.count || 0} wheels${b.incomplete ? `; ${b.incomplete}` : ''})` : `not built: ${b.why}`;
    }
    if (!readOnly && !fresh && e.cache === 'uv' && !uvInstalled(root, wkey)) uvInstalled(root, wkey, true);
  }
  try {
    writeJson(markerFile(wt), { key, ok: true, at: nowIso(), name: e.name || null, ran: res.ran, holds: fingerprint(e, v, wt), ...(cacheInfo ? { cache: cacheInfo } : {}) });
  } catch {
    /* cache is a convenience */
  }
  if (!readOnly) C.recordLast(root, { at: nowIso(), ok: true, phase: 'setup', worktree: wt, job: state ? state.id : null, task: taskId || 'job', ms, ...(cacheInfo ? { cache: cacheInfo } : {}) });
  return { ok: true, env: e, vars: v, ran: res.ran, cached: false, key, ms, ...(cacheInfo ? { cache: cacheInfo } : {}) };
}

// ---------------------------------------------------------------- commands

function show(root) {
  const { env: e, error } = loadSafe(root);
  const p = proposal(root);
  const pp = problems(strip(p));
  return {
    file: FILE(root),
    confirmed: e ? { ...strip(e), hash: short(e), confirmed: e.confirmed || null } : null,
    ...(error ? { error } : {}),
    proposed: { ...p, hash: short(p), problems: pp },
    status: e ? 'confirmed' : 'proposed',
    ...(e ? { schema: schemaOf(e) === 2 ? '0.12 (own environment per worktree, shared package cache)' : '0.11 (own environment per worktree, no shared cache)', runs: describe(e) } : {}),
    proposed_runs: describe(p),
    guide: DOC_PATH,
    how: e && schemaOf(e) === 1 && schemaOf(p) === 2 && !readJson(PROPOSED(root), null)
      ? `Your environment (0.11) downloads every dependency again in every worktree. The proposal (${short(p)}) is the same environment, every setup step unchanged, with the 0.12 shared package cache (downloads once per lockfile${p.cache === 'pip' ? '; later worktrees install from a hash-checked wheelhouse without the network' : ''}). Reply "confirm environment ${short(p)}" to switch, or leave it: the old one keeps working.`
      : e
      ? 'Change it: edit a copy and run factory env set --file <copy> in your terminal (or factory env propose --file <copy>, then reply "confirm environment").'
      : `Nothing is set up in worktrees until you confirm an environment: reply "confirm environment" (or run factory env set in your terminal) to use the proposal (${short(p)}), or "confirm environment none" for bare worktrees.`,
  };
}

// The main session may write a proposal; only the human confirms it.
function propose(root, { file }) {
  if (!file) fail('env propose --file <environment.json>', 'bad_input');
  const p = readJson(path.resolve(file), null);
  if (!p) fail(`No JSON in ${file}`, 'bad_input');
  const pp = problems(strip(p));
  if (pp.length) fail(`The environment is not valid:\n- ${pp.join('\n- ')}`, 'environment_invalid', pp);
  writeJson(PROPOSED(root), strip(p));
  return { proposed: PROPOSED(root), hash: short(p), message: `Proposed (${short(p)}). The human confirms it: reply "confirm environment ${short(p)}", or factory env set in their terminal.` };
}

// Human-only (cli/core/human.js setEnvironment, and approving a gate that binds the environment):
// write the sealed, confirmed environment.
function confirm(root, { file, none = false, env: given = null, expectHash = null, channel, via = null }) {
  let e;
  if (none) e = { version: 1, name: 'none', setup: [] };
  else if (given) e = given;
  else if (file) e = readJson(path.resolve(file), null);
  else e = proposal(root);
  if (!e) fail(`No JSON in ${file}`, 'bad_input');
  const { source: _src, evidence: _ev, hash: _h, problems: _p, ...clean } = strip(e);
  if (expectHash && short(clean) !== expectHash && short(e) !== expectHash) fail(`The proposal is now ${short(clean)}, not ${expectHash}: it changed after it was shown. Run factory env show and confirm again.`, 'stale_environment');
  const pp = problems(clean);
  if (pp.length) fail(`The environment is not valid:\n- ${pp.join('\n- ')}`, 'environment_invalid', pp);
  const out = seal({ ...clean, version: schemaOf(clean), confirmed: { at: nowIso(), via: channel, ...(via ? { gate: via } : {}) } });
  writeJson(FILE(root), out);
  try {
    fs.rmSync(PROPOSED(root), { force: true });
  } catch {
    /* none */
  }
  return { file: FILE(root), environment: strip(out), hash: short(out) };
}

// `factory env check`: validate, then run setup (and services up/health/down) in a scratch
// worktree of HEAD. Changes no job state. Read-only for the repo: the scratch worktree is
// removed afterwards.
// `env`: check this environment instead (an environment repair's candidate: unconfirmed, so it runs
// sandboxed like a proposal).
function check(root, { proposed = false, env: given = null } = {}) {
  const { env: confirmed, error } = loadSafe(root);
  if (error && !given) return { ok: false, error };
  const e = given ? strip(given) : proposed || !confirmed ? strip(proposal(root)) : confirmed;
  const which = given || proposed || !confirmed ? 'proposed' : 'confirmed';
  // a proposal carries where it came from (source, evidence): not fields of the environment
  const pp = problems(which === 'proposed' ? essence(e) : e);
  if (pp.length) return { ok: false, which, problems: pp };
  sweepChecks(root);
  const wt = path.join(root, '.factory', 'worktrees', `_envcheck-${process.pid}`);
  git.run(root, ['worktree', 'prune'], { allowFail: true });
  git.run(root, ['worktree', 'add', '--detach', wt, 'HEAD']);
  const owner = `${wt}.owner.json`;
  try {
    const ps = require('./probe').procStat(process.pid);
    writeJson(owner, { pid: process.pid, start: ps ? ps.start : null, at: nowIso() });
  } catch {
    /* the owner file only helps the sweep */
  }
  try {
    const { evidence: _e, notes: _n, source: _s, ...run } = e;
    // An environment nobody confirmed yet (a proposal: detected, or written with factory env
    // propose; an agent may run env check) runs like the plan probe's setup: the allowlisted
    // environment without the user's tokens, a home inside the scratch worktree, no login shell
    // (review MAJ-3). The confirmed one is the human's and runs as their own shell would.
    let inBox = (fn) => fn();
    if (which === 'proposed') {
      const P = require('./probe');
      const box = path.join(wt, '.factory-probe');
      for (const d of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(box, d), { recursive: true });
      const base = P.probeEnv(root, `envcheck-${process.pid}`, {}, P.ownDirs(box));
      inBox = (fn) => withBaseEnv(base, fn);
    }
    // the sealed environment's check builds the pip wheelhouse from this fresh venv (012B M-2)
    let r = inBox(() => ensure(root, null, { taskId: 'envcheck', wt, env: run, buildWheelhouse: which === 'confirmed' }));
    // the prefix runs in front of every verify command: the check runs it too (release review B2)
    if (r.ok && run.prefix && String(run.prefix).trim()) {
      const v = vars(root, null, 'envcheck', wt);
      const pr = inBox(() => sh(wrap(run, v, 'true'), wt, 120, processEnv(run, v)));
      if (pr.code !== 0) r = { ...r, ok: false, broken: broken('prefix', `${run.prefix} true`, pr) };
    }
    const torn = inBox(() => teardown(root, null, { taskId: 'envcheck', wt, env: run }));
    let down = null;
    if (e.services && e.services.down) down = inBox(() => sh(expand(e.services.down, vars(root, null, 'envcheck', wt)), wt, 600)).code;
    // what a sandboxed check started and left running (a backgrounded service, a setsid'd
    // process): found by the check's tag or a working directory in its worktree, killed (M3)
    if (which === 'proposed') {
      // a moment for what is already ending (a service's last step) to end
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      } catch {
        /* no wait */
      }
      const left = require('./probe').survivors(`envcheck-${process.pid}`, { wt });
      if (left.length) {
        return { ok: false, which, name: e.name || null, ran: r.ran || [], broken: { step: 'survivors', cmd: left.map((x) => x.cmd).join('; '), code: null, tail: '', reason: `left ${left.length} process(es) running after the check (killed): ${left.map((x) => x.cmd).join('; ')}` }, message: 'processes left running' };
      }
    }
    return { ok: r.ok, which, name: e.name || null, ran: r.ran || [], ...(r.ok ? {} : { broken: r.broken, message: r.broken.reason }), ...(torn ? { teardown_exit: torn.code } : {}), ...(down !== null ? { services_down_exit: down } : {}) };
  } finally {
    git.run(root, ['worktree', 'remove', '--force', wt], { allowFail: true });
    try {
      fs.rmSync(wt, { recursive: true, force: true });
      fs.rmSync(owner, { force: true });
    } catch {
      /* gone */
    }
  }
}

// Scratch worktrees of env checks that died (a killed caller, a killed child): removed, with
// whatever still runs in them, unless their owner (pid and start time) still lives (review M-1).
// Without an owner file, a live pid keeps one for at most 2 h. `force`: pids whose worktrees go
// whatever their owner (a run just killed).
function sweepChecks(root, { force = [] } = {}) {
  const dir = path.join(root, '.factory', 'worktrees');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^_envcheck-\d+$/.test(n));
  } catch {
    return [];
  }
  const P = require('./probe');
  const gone = [];
  for (const n of names) {
    const wt = path.join(dir, n);
    const pid = Number(n.split('-')[1]);
    const owner = readJson(`${wt}.owner.json`, null);
    let keep;
    if (force.includes(pid)) keep = false;
    else if (owner && owner.pid) keep = P.sameProcess(owner.pid, owner.start);
    else {
      let age = 0;
      try {
        age = Date.now() - fs.statSync(wt).mtimeMs;
      } catch {
        age = Infinity;
      }
      keep = P.sameProcess(pid, null) && age < 2 * 3600e3;
    }
    if (keep) continue;
    try {
      P.survivors(`envcheck-${pid}`, { wt });
    } catch {
      /* nothing left running */
    }
    git.run(root, ['worktree', 'remove', '--force', wt], { allowFail: true });
    try {
      fs.rmSync(wt, { recursive: true, force: true });
      fs.rmSync(`${wt}.owner.json`, { force: true });
    } catch {
      /* gone */
    }
    gone.push(n);
  }
  if (gone.length) git.run(root, ['worktree', 'prune'], { allowFail: true });
  return gone;
}

// Undo what setup (or the tests) started for one worktree: the environment's teardown, run in
// that worktree before it is removed. Only where setup ran (its marker is there). Best effort:
// { cmd, code } or null.
function teardown(root, state, { taskId = null, wt, env: given } = {}) {
  let e = given;
  if (e === undefined) {
    try {
      e = load(root);
    } catch {
      return null;
    }
  }
  if (!e || !e.teardown || !wt || !exists(wt)) return null;
  let marker = null;
  try {
    marker = readJson(markerFile(wt), null);
  } catch {
    marker = null;
  }
  if (!marker) return null;
  const v = vars(root, state, taskId, wt);
  const cmd = expand(e.teardown, v);
  const r = sh(`${preamble(e, v)}${cmd}`, wt, 600, processEnv(e, v));
  return { cmd, code: r.code, ...(r.code === 0 ? {} : { tail: String(r.output || '').trim().split('\n').slice(-5).join('\n') }) };
}

// The job's services down (job close): best effort, logged by the caller.
function servicesDown(root, state) {
  let e = null;
  try {
    e = load(root);
  } catch {
    return null;
  }
  if (!e || !e.services || !e.services.down || !state.environment_services) return null;
  const v = vars(root, state, null, root);
  const jv = { ...v, worktree: root, slug: String(state.id).toLowerCase(), db: `factory_${String(state.id).toLowerCase().replace(/[^a-z0-9]/g, '')}` };
  const cmd = expand(e.services.down, jv);
  const r = sh(cmd, root, 600, processEnv(e, jv));
  return { cmd, code: r.code };
}

// ---------------------------------------------------------------- the environment a gate binds

// The planner's proposal for this job (.factory/jobs/<job>/environment.proposed.json: the build
// environment the plan runs in, written with plan.json), or null.
const JOB_PROPOSED = (root, jobId) => path.join(root, '.factory', 'jobs', jobId, 'environment.proposed.json');

// What an environment means, without its bookkeeping (seal, who confirmed it, where it came from).
function essence(e) {
  const { seal: _s, confirmed: _c, source: _src, evidence: _ev, hash: _h, problems: _p, ...rest } = e || {};
  return { ...rest, version: schemaOf(e) };
}
const fullHash = (e) => hash(essence(e));
// Nothing to do in a worktree (whatever its name).
const inert = (e) => !e || (!commandsOf(e).length && !e.services && !Object.keys(e.env || {}).length && !e.prefix);
const isNone = (e) => !e || ((e.name === 'none' || !e.name) && !commandsOf(e).length && !e.services && !Object.keys(e.env || {}).length && !e.prefix);

// The environment a job's plan gate binds: { status, hash, env, source, file? }
//   confirmed  the sealed environment.json is what the plan runs in (nothing to seal)
//   proposed   the planner's proposal (or the repo's detected one) waits for the human: approving
//              a gate that binds the environment seals it
//   none       nothing to set up (bare worktrees)
//   tampered   environment.json fails its seal
function gateProposal(root, jobId) {
  const { env: conf, error } = loadSafe(root);
  if (error) return { status: 'tampered', hash: 'tampered', env: null, message: error };
  const jp = jobId ? readJson(JOB_PROPOSED(root, jobId), null) : null;
  if (jp && !problems(essence(jp)).length) {
    const h = fullHash(jp);
    if (conf && fullHash(conf) === h) return { status: 'confirmed', hash: h, env: strip(conf), short: short(conf) };
    if (isNone(jp) && (!conf || isNone(conf))) return { status: 'none', hash: 'none', env: essence(jp) };
    return { status: 'proposed', hash: h, env: essence(jp), short: short(essence(jp)), source: 'the planner (with the plan)', file: JOB_PROPOSED(root, jobId) };
  }
  if (conf) return { status: 'confirmed', hash: fullHash(conf), env: strip(conf), short: short(conf) };
  const p = proposal(root);
  if (isNone(p)) return { status: 'none', hash: 'none', env: essence(p) };
  return { status: 'proposed', hash: fullHash(p), env: essence(p), short: short(essence(p)), source: p.source };
}

// Realize may not start while the environment its commands run in waits for the human.
function needsConfirmation(root, jobId) {
  const g = gateProposal(root, jobId);
  return g.status === 'proposed' || g.status === 'tampered';
}

// A one-line summary for factory next / the gate view while no environment is confirmed; with a
// sealed 0.11 environment, the shared model's speed-up, offered once per proposal.
function notice(root) {
  const { env: e, error } = loadSafe(root);
  if (error) return { status: 'tampered', message: error };
  if (e) {
    if (schemaOf(e) !== 1 || isNone(e) || readJson(PROPOSED(root), null)) return null;
    const u = upgradeOf(root, e);
    if (!u || !u.env) return null;
    const p = proposal(root);
    if (schemaOf(p) !== 2) return null;
    return {
      status: 'upgrade',
      name: p.name,
      hash: short(p),
      cache: p.cache,
      message: `Speed-up: your build environment (sealed under 0.11) downloads every dependency again in every worktree; the same setup, unchanged, with the 0.12 shared ${p.cache} cache downloads once per lockfile and installs later worktrees from it. Reply "confirm environment ${short(p)}" to switch (factory env show shows it, ${DOC_PATH} explains it); until then the old setup keeps working as before.`,
    };
  }
  const p = proposal(root);
  if (isNone(p)) return null;
  return {
    status: 'proposed',
    name: p.name,
    hash: short(p),
    setup: p.setup,
    ...(schemaOf(p) === 2 ? { tool: p.tool || null, reason: p.reason || null, cache: p.cache || null } : {}),
    env: p.env || {},
    services: p.services || null,
    evidence: p.evidence || [],
    message: `Worktrees have no build environment yet. Proposed (${p.source}): ${p.name}${p.tool ? ` with ${p.tool} (${p.reason})` : ''} — ${describe(p)}. Show it to the user: they reply "confirm environment ${short(p)}" (or run factory env set / factory env show in their terminal; ${DOC_PATH} explains what runs where); until then builders and task verify run in bare worktrees.`,
  };
}

// `factory env status` (read-only): which tool is used and why, the shared caches and wheelhouses
// (where, how big, built when), each worktree's own environment, the last check and the last
// failure with the exact next step. Builds nothing, scans nothing (the cached inventory only).
function status(root, { jobId = null } = {}) {
  const C = require('./envcache');
  const M = require('./machine');
  const { env: conf, error } = loadSafe(root);
  const inv = (() => {
    try {
      return M.inventory({ cacheOnly: true });
    } catch {
      return null;
    }
  })();
  const choice = toolChoice(root, { machine: inv });
  const e = conf || null;
  const ver = e ? schemaOf(e) : null;
  const last = readJson(C.LAST(root), {}) || {};
  let check = null;
  try {
    const ER = require('./env-repair');
    const ids = jobId ? [jobId] : require('./job').listJobIds(root);
    for (const id of ids) {
      const c = ER.readCheck(root, id);
      if (c && (!check || String(c.at) > String(check.at))) check = { job: id, ok: c.ok, at: c.at, hash: c.hash, ...(c.ok ? {} : { cmd: c.broken ? C.redact(c.broken.cmd) : null, tail: C.redact((c.broken && c.broken.tail) || (c.problems || []).join('; ')).slice(-1200) }) };
    }
  } catch {
    check = null;
  }
  // each factory worktree's own environment (from its marker; no git process)
  const worktrees = [];
  try {
    const base = path.join(root, '.factory', 'worktrees');
    for (const n of fs.readdirSync(base)) {
      const wt = path.join(base, n);
      let gd = null;
      try {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(wt, '.git'), 'utf8'));
        if (m) gd = path.resolve(wt, m[1].trim());
      } catch {
        gd = null;
      }
      if (!gd) continue;
      const mk = readJson(path.join(gd, 'factory-env.json'), null);
      if (!mk) continue;
      const own = ['.factory-venv', '.venv', 'node_modules'].filter((d) => exists(path.join(wt, d)));
      worktrees.push({ name: n, ok: Boolean(mk.ok), building: Boolean(mk.building), at: mk.at || null, own_env: own, ...(mk.cache ? { cache: mk.cache } : {}), ...(mk.failed ? { failed: C.redact(mk.failed) } : {}) });
    }
  } catch {
    /* no worktrees */
  }
  const f0 = last.last_failure || null;
  const userVenv = path.join(root, '.venv');
  return {
    environment: error
      ? { status: 'tampered', error }
      : e
        ? { status: 'confirmed', name: e.name || null, hash: short(e), schema: ver === 2 ? '0.12: own environment per worktree, shared package cache' : '0.11: own environment per worktree, no shared cache', runs: C.redact(describe(e)), confirmed: e.confirmed || null }
        : { status: 'none confirmed', proposed: (() => { const p = proposal(root); return { name: p.name, hash: short(p), runs: C.redact(describe(p)) }; })() },
    tool: e && ver === 2 ? { chosen: e.tool || null, reason: e.reason || null, cache: e.cache || null, recorded_in: 'the sealed environment' } : { chosen: choice.tool, reason: choice.reason, recorded_in: 'not sealed yet: what the factory would choose on this machine now' },
    machine_now: { tool: choice.tool, reason: choice.reason, inventory: inv ? `scanned ${M.ageText(inv)}` : 'no machine scan cached (factory doctor --machine scans)', python3_venv: inv ? (inv.venv && inv.venv.works ? 'works' : `does not work${inv.venv && inv.venv.why ? `: ${inv.venv.why}` : ''}`) : 'unknown' },
    cache: { dir: C.CACHE(root), used: Boolean(e && ver === 2 && e.cache && e.cache !== 'none'), caches: C.caches(root), wheelhouses: C.wheelhouses(root), keep: C.KEEP() },
    worktrees,
    last_check: check,
    last_build: last.last_build || null,
    last_failure: f0 ? { ...f0, current: Boolean(last.last_build && !last.last_build.ok), next_step: `fix the cause shown (a missing tool: install it, then factory doctor --machine; a dependency: the lockfile or the setup), then factory env check --job <J> (factory next names it); only that worktree's environment is built again` } : null,
    your_venv: { path: userVenv, exists: exists(userVenv), note: 'The factory never creates, changes or deletes your .venv, and never sets up the root checkout: each worktree builds its own .factory-venv.' },
    ...(e && ver === 1 ? { upgrade: (() => { const u = upgradeOf(root, e); return u && u.env ? { hash: short(u.env), message: notice(root) ? notice(root).message : null } : u ? { why: u.why } : null; })() } : {}),
    doc: DOC_PATH,
  };
}

module.exports = { buildRequires, cacheOf, envDirs, sweepChecks, DOC_PATH, status, upgradeOf, toolChoice, describe, schemaOf, commandsOf, inert, excludeReport, ensureIgnored, DOC, KEYS, lint, readsOf, withBaseEnv, gateProposal, needsConfirmation, fullHash, essence, isNone, JOB_PROPOSED, teardown, servicesDown, load, loadSafe, detect, proposal, problems, show, propose, confirm, check, ensure, wrap, preamble, processEnv, vars, expand, notice, cacheKey, short, FILE, PROPOSED };
