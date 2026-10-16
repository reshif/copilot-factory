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
// Schema version 2 (0.12, the shared model; docs/ENVIRONMENT.md): dependencies are installed ONCE
// per lockfile into a factory-owned shared environment, and each worktree only gets a cheap
// overlay of it (cli/core/envstore.js). Instead of setup and cache_key:
//     "tool": "uv", "reason": "uv is installed: …",  how it is built and why (machine.pythonTool)
//     "deps": ["uv venv -q --allow-existing {env}/venv", "uv pip install … -r pyproject.toml"],
//                                                  once per key, in {env}/src (a copy of the
//                                                  worktree's tracked files); {env} is
//                                                  .factory/envs/<key>
//     "deps_key": ["pyproject.toml", "uv.lock"],   files whose content (with deps, tool, env and
//                                                  this machine) keys the shared environment
//     "overlay": "python",                         python: <worktree>/.factory-venv, a thin venv
//                                                  over {env}/venv; node: <worktree>/node_modules
//                                                  linked to {env}/src/node_modules; none
//     "project": ["uv pip install … --no-deps -e ."],  each worktree, after the overlay: cheap
// A sealed version-1 environment (0.11) keeps working as it did (setup in every worktree) until
// the human confirms a version-2 one; factory next offers it.
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
const KEYS = ['version', 'name', 'tool', 'reason', 'setup', 'cache_key', 'deps', 'deps_key', 'overlay', 'project', 'env', 'prefix', 'services', 'teardown', 'ignore', 'timeout_seconds', 'notes'];
const V2_ONLY = ['deps', 'deps_key', 'overlay', 'project'];
const V1_ONLY = ['setup', 'cache_key'];
const DOC = 'docs/ENVIRONMENT.md';
const DOC_PATH = path.join(__dirname, '..', '..', DOC);

// The schema an environment is written in: its version, else 2 when it uses the shared fields.
function schemaOf(e) {
  if (!e) return 1;
  if (e.version === 1 || e.version === 2) return e.version;
  return V2_ONLY.some((k) => e[k] !== undefined) ? 2 : 1;
}
// Every command an environment runs before a verify command (lint, the network check, notices).
const commandsOf = (e) => [...((e && e.setup) || []), ...((e && e.deps) || []), ...((e && e.project) || [])];
// One line saying what runs where.
function describe(e) {
  if (!e) return 'none';
  if (schemaOf(e) === 2) {
    const d = (e.deps || []).join(' && ');
    const p = (e.project || []).join(' && ');
    return `${d ? `once per ${(e.deps_key || []).join(', ') || 'environment'} (shared in .factory/envs): ${d}` : 'no shared dependencies'}; each worktree: ${e.overlay === 'python' ? '.factory-venv (a thin venv over the shared one)' : e.overlay === 'node' ? 'node_modules linked to the shared one' : 'no overlay'}${p ? ` + ${p}` : ''}`;
  }
  return `setup in every worktree: ${(e.setup || []).join(' && ') || '(none)'}`;
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
  if (e.version !== undefined && e.version !== 1 && e.version !== 2) out.push('version must be 1 (setup in every worktree) or 2 (deps shared, project per worktree)');
  const ver = schemaOf(e);
  if (ver === 2) for (const k of V1_ONLY) if (e[k] !== undefined) out.push(`${k} is a version-1 field: version 2 splits setup into deps (installed once, shared) and project (each worktree), and cache_key into deps_key`);
  if (ver === 1) for (const k of V2_ONLY) if (e[k] !== undefined) out.push(`${k} needs version 2 (the shared model)`);
  strs(e.deps, 'deps');
  strs(e.deps_key, 'deps_key');
  strs(e.project, 'project');
  if (e.overlay !== undefined && !['python', 'node', 'none'].includes(e.overlay)) out.push('overlay must be python, node or none');
  if (e.overlay === 'python' && !(e.deps || []).length) out.push('overlay python needs deps that make the shared venv at {env}/venv');
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
const PIP = '{env}/venv/bin/python -m pip install -q --retries 5 --timeout 60';
const OV = '{worktree}/.factory-venv';
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
function projectName(py) {
  const t = section(py, 'project') || section(py, 'tool.poetry') || '';
  const n = (/^\s*name\s*=\s*["']([A-Za-z0-9._-]+)["']/m.exec(t) || [])[1];
  return n || null;
}
const q = (r) => `'${r}'`;

// What the factory would choose for this repo on this machine, and why (factory doctor and
// factory env status show it; the proposal records it as tool and reason).
function toolChoice(root, { machine: given } = {}) {
  const py = read(root, 'pyproject.toml');
  const tasksPy = read(root, 'tasks.py');
  if (py && /nautobot/i.test(py) && tasksPy && /invoke/.test(tasksPy)) return { kind: 'nautobot', tool: 'invoke', reason: 'a Nautobot app (cookiecutter layout): invoke builds the development docker image once; each worktree runs its own compose project with its code mounted' };
  const reqs = fs.existsSync(root) ? fs.readdirSync(root).filter((f) => /^requirements[\w.-]*\.txt$/.test(f)) : [];
  if (py || reqs.length || has(root, 'setup.py') || has(root, 'setup.cfg')) {
    const poetryRepo = has(root, 'poetry.lock') || Boolean(py && /^\[tool\.poetry\]/m.test(py));
    const t = require('./machine').pythonTool(machineOf(given), { poetryRepo, poetryLock: has(root, 'poetry.lock') });
    return { kind: 'python', ...t };
  }
  const pkg = read(root, 'package.json');
  if (pkg) {
    const tool = has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'yarn.lock') ? 'yarn' : 'npm';
    let ws = false;
    try {
      ws = Boolean(JSON.parse(pkg).workspaces);
    } catch {
      ws = false;
    }
    const pnp = has(root, '.pnp.cjs') || has(root, '.yarnrc.yml');
    if (ws || has(root, 'pnpm-workspace.yaml') || pnp) return { kind: 'node', tool, shared: false, reason: `${tool} (${tool === 'npm' ? 'package-lock.json or none' : `${tool} lockfile`}); ${pnp ? 'Yarn Plug\'n\'Play keeps no node_modules to share' : 'the repo declares workspaces, whose links point into each worktree'}, so each worktree installs (from the package manager\'s cache)` };
    return { kind: 'node', tool, shared: true, reason: `${tool === 'npm' ? (has(root, 'package-lock.json') ? 'package-lock.json: npm ci' : 'no lockfile: npm install') : `${tool} lockfile: ${tool}`} installs node_modules once; each worktree links it` };
  }
  return { kind: 'none', tool: null, reason: 'no dependency manifest (pyproject.toml, requirements*.txt, setup.py, package.json)' };
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
    // with Postgres and Redis. The development image is built once per lockfile (deps, shared by
    // its tag); each worktree gets its own compose project (its own containers and database,
    // the worktree's code mounted), named by INVOKE_<APP>_PROJECT_NAME.
    const ns = (/Collection\(\s*["']([\w]+)["']\s*\)/.exec(tasksPy) || [])[1] || ((/^name\s*=\s*["']([\w-]+)["']/m.exec(py) || [])[1] || 'app').replace(/-/g, '_');
    const V = `INVOKE_${ns.toUpperCase()}`;
    evidence.push('pyproject.toml (nautobot)', 'tasks.py (invoke)');
    for (const f of ['development/docker-compose.base.yml', 'development/docker-compose.postgres.yml', 'development/docker-compose.redis.yml', 'poetry.lock']) if (has(root, f)) evidence.push(f);
    return {
      version: 2,
      name: 'nautobot-app-invoke',
      tool: choice.tool,
      reason: choice.reason,
      deps: ['invoke build'],
      deps_key: ['poetry.lock', 'pyproject.toml', 'development/Dockerfile', 'development/*.yml', 'development/*.env'],
      overlay: 'none',
      project: [],
      env: { [`${V}_PROJECT_NAME`]: 'factory-{slug}', [`${V}_LOCAL`]: 'false' },
      prefix: '',
      // invoke unittest leaves the project's database and redis containers running
      teardown: 'invoke destroy',
      ignore: [],
      timeout_seconds: 1800,
      notes: `The development image (nautobot and the app's dependencies) is built once per poetry.lock / Dockerfile (deps, from a copy of the repo under .factory/envs), not once per worktree. Each worktree gets its own compose project (${V}_PROJECT_NAME=factory-{slug}): its own Postgres, Redis and Nautobot containers, with that worktree's code mounted. Verify commands look like "invoke unittest --failfast --label ${ns}.tests.test_x". Each project is removed with "invoke destroy" (teardown) when the job closes; for a cancelled job, run it in each .factory/worktrees/<job>-<task> yourself. See the factory's ${DOC}.`,
      evidence,
    };
  }
  if (choice.kind === 'python') {
    const dev = Boolean(py && /\[project\.optional-dependencies\][\s\S]*?^\s*dev\s*=/m.test(py));
    const pep621 = Boolean(py && /^\[project\]/m.test(py));
    const poetryRepo = Boolean(py && /^\[tool\.poetry\]/m.test(py));
    const installable = pep621 || poetryRepo || has(root, 'setup.py') || has(root, 'setup.cfg');
    const reqFiles = reqs.filter((f) => /dev|test/.test(f) || reqs.length === 1);
    const name = py ? projectName(py) : null;
    const backend = installable ? buildRequires(py) : [];
    const inv = machineOf(given);
    const how = choice.tool;
    const env = { VIRTUAL_ENV: OV, PATH: `${OV}/bin:$PATH` };
    const target = dev ? "'.[dev]'" : '.';
    let deps;
    let project;
    if (how === 'poetry') {
      const mk = choice.maker === 'uv' ? 'uv venv -q --seed --allow-existing {env}/venv' : choice.maker === 'virtualenv' ? 'virtualenv -q {env}/venv' : 'python3 -m venv {env}/venv';
      // poetry installs into the venv VIRTUAL_ENV names (not one of its own): the main and dev groups, never the project itself
      deps = [mk, 'VIRTUAL_ENV={env}/venv poetry install --no-root --no-interaction', ...(backend.length ? [`${PIP} ${backend.map(q).join(' ')}`] : []), ...reqFiles.map((f) => `${PIP} -r ${f}`)];
      project = installable ? [`${OV}/bin/python -m pip install -q --no-deps --no-build-isolation --no-index -e .`] : [];
    } else if (how === 'uv') {
      const uvPip = 'uv pip install -q --python {env}/venv/bin/python';
      const fromLock = has(root, 'uv.lock') && pep621;
      deps = [
        'uv venv -q --allow-existing {env}/venv',
        ...(fromLock ? [`UV_PROJECT_ENVIRONMENT={env}/venv uv sync -q --frozen --no-install-project${dev ? ' --extra dev' : ''}`] : pep621 ? [`${uvPip} -r pyproject.toml${dev ? ' --extra dev' : ''}`] : installable ? [`${uvPip} ${target}`, ...(name ? [`uv pip uninstall -q --python {env}/venv/bin/python ${name}`] : [])] : []),
        ...(backend.length ? [`${uvPip} ${backend.map(q).join(' ')}`] : []),
        ...reqFiles.map((f) => `${uvPip} -r ${f}`),
      ];
      project = installable ? [`uv pip install -q --python ${OV}/bin/python --no-deps --no-build-isolation -e .`] : [];
      // uv retries on its own; its HTTP timeout is raised for slow indexes
      env.UV_HTTP_TIMEOUT = '60';
    } else {
      const mk = how === 'virtualenv' ? 'virtualenv -q {env}/venv' : 'python3 -m venv {env}/venv';
      // pip cannot install only a project's dependencies: it installs the project (built in the
      // copy under {env}/src) and removes it again, so the shared venv never holds a worktree's code
      deps = [mk, `${PIP} --upgrade pip`, ...(backend.length ? [`${PIP} ${backend.map(q).join(' ')}`] : []), ...(installable ? [`${PIP} ${target}`, ...(name ? [`{env}/venv/bin/python -m pip uninstall -q -y ${name}`] : [])] : []), ...reqFiles.map((f) => `${PIP} -r ${f}`)];
      project = installable ? [`${OV}/bin/python -m pip install -q --no-deps --no-build-isolation --no-index -e .`] : [];
    }
    if (py) evidence.push('pyproject.toml');
    evidence.push(...reqs, ...['setup.py', 'setup.cfg', 'poetry.lock', 'uv.lock'].filter((f) => has(root, f)));
    if (inv) evidence.push(`this machine: ${how ? `${how} (${how === 'venv' ? 'python3 -m venv works' : 'installed'})` : 'no working venv tool (python3 -m venv fails: install uv or virtualenv)'}`);
    return {
      version: 2,
      name: how === 'uv' ? 'python-uv' : how === 'poetry' ? 'python-poetry' : 'python-venv',
      tool: how || 'none-available',
      reason: choice.reason,
      deps,
      deps_key: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements*.txt', 'poetry.lock', 'uv.lock'],
      overlay: 'python',
      project,
      env,
      prefix: '',
      ignore: ['/.factory-venv/', '*.egg-info/'],
      timeout_seconds: 1200,
      notes: `Dependencies are installed once per ${['pyproject.toml', 'poetry.lock', 'uv.lock', ...reqFiles].filter((f) => has(root, f)).join(' / ') || 'manifest'} into a shared venv under .factory/envs/<key>/ (built with ${how || 'python3 -m venv'}). Each worktree gets .factory-venv, a thin venv that sees the shared packages and has that worktree's project installed in editable mode (no dependencies, no network), so python, pytest and console scripts import the worktree's code. Your own .venv is never touched. Write verify commands as "python -m pytest …" or "pytest …". See the factory's ${DOC}.${how ? '' : ' python3 -m venv does not work on this machine (no ensurepip) and neither uv nor virtualenv is installed: install uv (no sudo), then propose again.'}`,
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
    if (!deps && !lock) return { version: 2, name: 'none', tool: null, reason: 'package.json has no dependencies', deps: [], project: [], notes: 'package.json has no dependencies: worktrees need no setup.', evidence };
    const install = lock || 'npm install --no-audit --no-fund';
    const common = { version: 2, name: 'node', tool: choice.tool, reason: choice.reason, deps_key: ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.npmrc'], env: { PATH: '{worktree}/node_modules/.bin:$PATH' }, prefix: '', timeout_seconds: 900, evidence };
    if (!choice.shared) return { ...common, deps: [], overlay: 'none', project: [install], ignore: ['node_modules/'], notes: `Each worktree installs its own node_modules (${choice.reason}). See the factory's ${DOC}.` };
    return { ...common, deps: [install], overlay: 'node', project: [], ignore: ['/node_modules'], notes: `node_modules is installed once per lockfile under .factory/envs/<key>/ and each worktree links it (node_modules -> the shared one). See the factory's ${DOC}.` };
  }
  return { version: 2, name: 'none', tool: null, reason: choice.reason, deps: [], project: [], notes: 'No dependency manifest found: worktrees need no setup.', evidence: [] };
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
  if (up && up.env) return { ...up.env, source: 'the 0.12 shared model, from your sealed 0.11 environment' };
  return { ...detect(root), source: 'detected from the repo files' };
}

// The version-2 environment that replaces a sealed version-1 one: the detected shared model, with
// what the old one added kept (services, teardown, prefix, its other env variables, a longer
// timeout). Only when every old setup step is one the shared model covers (making a venv,
// installing dependencies, invoke build, npm ci …); a custom step (a script of the repo's) is not
// guessed at. { env } or { why } or null (nothing to upgrade).
const COVERED = /^(python3?(\.\d+)?\s+-m\s+venv|virtualenv|uv\s+venv|uv\s+pip\s+install|uv\s+sync|(\.venv\/bin\/)?(pip3?|python3?\s+-m\s+pip)\s+install|\.venv\/bin\/python3?\s+-m\s+pip\s+install|poetry\s+install|npm\s+(ci|install|i)|pnpm\s+(install|i)|yarn(\s+install)?|invoke\s+build)\b/;
function upgradeOf(root, conf) {
  if (!conf || schemaOf(conf) !== 1 || isNone(conf) || !(conf.setup || []).length) return null;
  const steps = (conf.setup || []).flatMap((c) => segments(c));
  const odd = steps.filter((c) => !COVERED.test(c));
  if (odd.length) return { why: `its setup has steps the shared model does not cover by itself (${odd.slice(0, 3).join('; ')}): split them into deps (once) and project (each worktree) yourself (factory env propose --file, see ${DOC_PATH})` };
  let d;
  try {
    d = detect(root);
  } catch {
    return null;
  }
  if (isNone(d)) return null;
  const { evidence: _e, ...base } = d;
  const extra = Object.fromEntries(Object.entries(conf.env || {}).filter(([k]) => !['VIRTUAL_ENV', 'PATH', 'POETRY_VIRTUALENVS_IN_PROJECT'].includes(k)));
  return {
    env: {
      ...base,
      env: { ...extra, ...(base.env || {}) },
      ...(conf.services ? { services: conf.services } : {}),
      ...(conf.teardown ? { teardown: conf.teardown } : {}),
      ...(conf.prefix ? { prefix: conf.prefix } : {}),
      ...(Math.max(conf.timeout_seconds || 0, base.timeout_seconds || 0) ? { timeout_seconds: Math.max(conf.timeout_seconds || 0, base.timeout_seconds || 0) } : {}),
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
function cacheKey(e, wt) {
  const files = [];
  const pats = e.cache_key || [];
  if (pats.length) {
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
  }
  return hash({ setup: e.setup || [], env: e.env || {}, prefix: e.prefix || '', files });
}

function markerFile(wt) {
  const gd = path.resolve(wt, git.out(wt, ['rev-parse', '--git-dir']));
  return path.join(gd, 'factory-env.json');
}

// What setup creates (.venv/, node_modules/) must not make the worktree dirty: the common
// info/exclude applies to every worktree. A version-1 environment's patterns are appended as they
// were (0.11). A version-2 one's go into one block the factory owns and rewrites, marked so a
// person reading .git/info/exclude sees where they came from; they name what exists only in
// factory worktrees (/.factory-venv/), so the root checkout's git status (your own .venv
// included) is not changed by them.
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
    const want = [...new Set([...(e.overlay === 'python' ? ['/.factory-venv/'] : []), ...list])];
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
  return { file: excludeFile(root), managed, legacy_venv: legacy.length > 0 };
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

// Make the environment ready in one worktree: services (once per job), then setup, cached by
// the key above. { ok, env, vars, ran, cached, key } or { ok: false, broken }.
// Version 2: the shared dependency environment (built once per key, cli/core/envstore.js), this
// worktree's overlay of it, then the project commands (cached per worktree).
function ensure(root, state, { taskId = null, wt, env: given } = {}) {
  const e = given !== undefined ? given : load(root);
  const v = vars(root, state, taskId, wt);
  if (!e || inert(e)) return { ok: true, env: e, vars: v, ran: [], cached: false, key: null, none: true };
  // never the user's own checkout (or the .venv in it): only factory worktrees are set up
  if (wt && path.resolve(wt) === path.resolve(root)) fail('The factory never sets up the root checkout (your own .venv stays yours): environments are made in factory worktrees only.', 'bad_input');
  ensureIgnored(root, e);
  const svc = ensureServices(root, state, e, v);
  if (!svc.ok) return { ok: false, broken: svc.broken, env: e, vars: v };
  if (schemaOf(e) === 2) return ensureShared(root, state, e, v, wt, taskId);
  const key = cacheKey(e, wt);
  let marker = null;
  try {
    marker = readJson(markerFile(wt), null);
  } catch {
    marker = null;
  }
  if (marker && marker.key === key && marker.ok) return { ok: true, env: e, vars: v, ran: [], cached: true, key };
  const ran = [];
  const T = e.timeout_seconds || 1200;
  const penv = processEnv(e, v);
  for (const step of e.setup || []) {
    const cmd = expand(step, v);
    const r = sh(`${preamble(e, v)}${cmd}`, wt, T, penv);
    ran.push({ cmd, code: r.code, ms: r.ms });
    if (r.code !== 0) {
      try {
        writeJson(markerFile(wt), { key, ok: false, at: nowIso(), failed: cmd });
      } catch {
        /* no marker: setup runs again next time anyway */
      }
      return { ok: false, broken: broken('setup', cmd, r), env: e, vars: v, ran };
    }
  }
  try {
    writeJson(markerFile(wt), { key, ok: true, at: nowIso(), name: e.name || null, ran });
  } catch {
    /* cache is a convenience */
  }
  return { ok: true, env: e, vars: v, ran, cached: false, key };
}

function ensureShared(root, state, e, v0, wt, taskId) {
  const S = require('./envstore');
  const T = e.timeout_seconds || 1200;
  const key = S.keyOf(e, wt);
  const readOnly = Boolean(BASE_ENV);
  const who = { job: state ? state.id : null, task: taskId || 'job', worktree: wt, at: nowIso() };
  // the deps commands: {worktree} is the copy they run in ({env}/src)
  const runDeps = (step, src, dir) => {
    const dv = { ...v0, worktree: src, env: dir, task: key.slice(0, 8), slug: `env-${key.slice(0, 8)}`, db: `factory_env_${key.slice(0, 8)}` };
    const cmd = expand(step, dv);
    const r = sh(`${preamble(e, dv)}${cmd}`, src, T, processEnv(e, dv));
    return { cmd, code: r.code, ms: r.ms, timed_out: r.timed_out, broken: r.code === 0 ? null : broken('deps', cmd, r) };
  };
  // the worktree marker: this worktree's overlay and project commands, for this shared env
  const wtKey = hash({ key, overlay: e.overlay || 'none', project: e.project || [], env: e.env || {}, prefix: e.prefix || '' });
  let marker = null;
  try {
    marker = readJson(markerFile(wt), null);
  } catch {
    marker = null;
  }
  const sharedDir = S.dirOf(root, key);
  const privateDir = path.join(wt, '.factory-probe', `env-${key.slice(0, 16)}`);
  if (marker && marker.ok && marker.key === wtKey && marker.env_dir && S.healthy(e, marker.env_dir) && (marker.env_dir === sharedDir || marker.env_dir === privateDir)) {
    const v = { ...v0, env: marker.env_dir };
    if (!readOnly && marker.env_dir === sharedDir) S.touch(sharedDir);
    return { ok: true, env: e, vars: v, ran: [], cached: true, key, shared: { key: key.slice(0, 16), dir: marker.env_dir, built: false, reused: true } };
  }
  let sh0;
  try {
    sh0 = S.ensureShared(root, e, { key, wt, run: runDeps, timeoutSec: T, readOnly, privateDir, who });
  } catch (err) {
    return { ok: false, env: e, vars: v0, ran: [], broken: { step: 'deps', cmd: 'wait for the shared environment', code: null, tail: '', reason: `environment broken: ${err.message}` } };
  }
  const v = { ...v0, env: sh0.dir };
  const ran = [...(sh0.ran || [])];
  const shared = { key: key.slice(0, 16), dir: sh0.dir, built: Boolean(sh0.built), reused: Boolean(sh0.reused), waited_ms: sh0.waited_ms || 0, ...(sh0.private ? { private: true } : {}) };
  if (!sh0.ok) return { ok: false, broken: sh0.broken, env: e, vars: v, ran, shared };
  const procEnv = { ...(BASE_ENV || process.env), ...processEnv(e, v) };
  const o = S.overlay(e, sh0.dir, wt, key, procEnv);
  if (!o.ok) {
    const b = { step: 'overlay', cmd: `overlay ${e.overlay}`, code: null, tail: o.why, reason: `environment broken: the ${e.overlay} overlay of the shared environment: ${o.why}` };
    if (!readOnly) recordFailure(root, { phase: 'overlay', key, wt, cmd: b.cmd, tail: o.why });
    return { ok: false, broken: b, env: e, vars: v, ran, shared };
  }
  for (const step of e.project || []) {
    const cmd = expand(step, v);
    const r = sh(`${preamble(e, v)}${cmd}`, wt, T, processEnv(e, v));
    ran.push({ cmd, code: r.code, ms: r.ms, phase: 'project' });
    if (r.code !== 0) {
      try {
        writeJson(markerFile(wt), { key: wtKey, env_key: key, env_dir: sh0.dir, ok: false, at: nowIso(), failed: cmd });
      } catch {
        /* runs again next time */
      }
      const b = broken('project', cmd, r);
      if (!readOnly) recordFailure(root, { phase: 'project', key, wt, cmd, code: r.code, tail: b.tail });
      return { ok: false, broken: b, env: e, vars: v, ran, shared };
    }
  }
  try {
    writeJson(markerFile(wt), { key: wtKey, env_key: key, env_dir: sh0.dir, ok: true, at: nowIso(), name: e.name || null, overlay: e.overlay || 'none', ran });
  } catch {
    /* cache is a convenience */
  }
  return { ok: true, env: e, vars: v, ran, cached: false, key, shared };
}

function recordFailure(root, { phase, key, wt, cmd, code = null, tail }) {
  const S = require('./envstore');
  try {
    const f = S.LAST(root);
    const cur = readJson(f, {}) || {};
    const rec = { at: nowIso(), ok: false, phase, key: key.slice(0, 16), worktree: wt, cmd, code, tail: S.redact(tail).slice(-2000) };
    writeJson(f, { ...cur, last_build: rec, last_failure: rec });
  } catch {
    /* status is a convenience */
  }
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
    ...(e ? { schema: schemaOf(e) === 2 ? 'shared (0.12)' : 'per-worktree (0.11)', runs: describe(e) } : {}),
    proposed_runs: describe(p),
    guide: DOC_PATH,
    how: e && schemaOf(e) === 1 && schemaOf(p) === 2 && !readJson(PROPOSED(root), null)
      ? `Your environment (0.11) runs its whole setup in every worktree. The proposal (${short(p)}) is the 0.12 shared model of it: dependencies once per lockfile, a thin overlay per worktree. Reply "confirm environment ${short(p)}" to switch, or leave it: the old one keeps working.`
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
    let r = inBox(() => ensure(root, null, { taskId: 'envcheck', wt, env: run }));
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
const inert = (e) => !e || (!commandsOf(e).length && !e.services && !Object.keys(e.env || {}).length && !e.prefix && !(e.overlay && e.overlay !== 'none'));
const isNone = (e) => !e || ((e.name === 'none' || !e.name) && !commandsOf(e).length && !e.services && !Object.keys(e.env || {}).length && !e.prefix && !(e.overlay && e.overlay !== 'none'));

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
      deps: p.deps || [],
      project: p.project || [],
      message: `Speed-up: your build environment (sealed under 0.11) reinstalls every dependency in every worktree; the shared model installs them once per lockfile and gives each worktree a thin overlay (seconds, not minutes). Reply "confirm environment ${short(p)}" to switch (factory env show shows it, ${DOC_PATH} explains it); until then the old setup keeps working as before.`,
    };
  }
  const p = proposal(root);
  if (isNone(p)) return null;
  return {
    status: 'proposed',
    name: p.name,
    hash: short(p),
    ...(schemaOf(p) === 2 ? { tool: p.tool || null, reason: p.reason || null, deps: p.deps || [], project: p.project || [] } : { setup: p.setup }),
    env: p.env || {},
    services: p.services || null,
    evidence: p.evidence || [],
    message: `Worktrees have no build environment yet. Proposed (${p.source}): ${p.name}${p.tool ? ` with ${p.tool} (${p.reason})` : ''} — ${describe(p)}. Show it to the user: they reply "confirm environment ${short(p)}" (or run factory env set / factory env show in their terminal; ${DOC_PATH} explains what runs where); until then builders and task verify run in bare worktrees.`,
  };
}

// `factory env status` (read-only): which tool is used and why, where the shared environments
// live (size, key, built when, used by which worktrees), the last check and the last failure with
// the exact next step. Builds nothing, scans nothing (the cached machine inventory only).
function status(root, { jobId = null } = {}) {
  const S = require('./envstore');
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
  let currentKey = null;
  if (e && ver === 2 && !inert(e)) {
    try {
      currentKey = S.keyOf(e, root).slice(0, 16);
    } catch {
      currentKey = null;
    }
  }
  const envs = S.list(root);
  const last = readJson(S.LAST(root), {}) || {};
  // the newest env check of any job (or of the job named)
  let check = null;
  try {
    const ER = require('./env-repair');
    const ids = jobId ? [jobId] : require('./job').listJobIds(root);
    for (const id of ids) {
      const c = ER.readCheck(root, id);
      if (c && (!check || String(c.at) > String(check.at))) check = { job: id, ok: c.ok, at: c.at, hash: c.hash, ...(c.ok ? {} : { cmd: c.broken ? c.broken.cmd : null, tail: S.redact((c.broken && c.broken.tail) || (c.problems || []).join('; ')).slice(-1200) }) };
    }
  } catch {
    check = null;
  }
  const fail0 = last.last_failure || null;
  const failNewer = Boolean(fail0 && last.last_build && !last.last_build.ok);
  const nextStep = (f) => {
    if (!f) return null;
    if (f.phase === 'project') return `the per-worktree step failed in ${f.worktree}: fix the cause shown (usually the project's build backend missing from deps), then factory env check --job <J> (factory next names it)`;
    if (f.phase === 'overlay') return 'the shared environment has no usable venv at {env}/venv: its deps must make one there; fix deps (factory env propose --file, then confirm), then factory env check --job <J>';
    return `fix the cause shown (a missing tool: install it, then factory doctor --machine; a dependency: change the lockfile or deps), then factory env check --job <J> builds it again (only this key; nothing else is reinstalled)`;
  };
  const userVenv = path.join(root, '.venv');
  return {
    environment: error
      ? { status: 'tampered', error }
      : e
        ? { status: 'confirmed', name: e.name || null, hash: short(e), schema: ver === 2 ? 'shared (0.12: deps once per key, an overlay per worktree)' : 'per-worktree (0.11: setup runs in every worktree)', runs: describe(e), confirmed: e.confirmed || null }
        : { status: 'none confirmed', proposed: (() => { const p = proposal(root); return { name: p.name, hash: short(p), runs: describe(p) }; })() },
    tool: e && ver === 2 ? { chosen: e.tool || null, reason: e.reason || null, recorded_in: 'the sealed environment' } : { chosen: choice.tool, reason: choice.reason, recorded_in: 'not sealed yet: what the factory would choose on this machine now' },
    machine_now: { tool: choice.tool, reason: choice.reason, inventory: inv ? `scanned ${M.ageText(inv)}` : 'no machine scan cached (factory doctor --machine scans)', python3_venv: inv ? (inv.venv && inv.venv.works ? 'works' : `does not work${inv.venv && inv.venv.why ? `: ${inv.venv.why}` : ''}`) : 'unknown' },
    shared_envs: { store: S.STORE(root), keep: S.KEEP(), current_key: currentKey, current_built: currentKey ? envs.some((x) => x.key === currentKey && x.ok) : null, envs },
    worktrees: S.worktreeUses(root),
    last_check: check,
    last_build: last.last_build || null,
    last_failure: fail0 ? { ...fail0, current: Boolean(failNewer), next_step: nextStep(fail0) } : null,
    your_venv: { path: userVenv, exists: exists(userVenv), note: 'The factory never creates, changes or deletes your .venv, and never sets up the root checkout: worktrees get their own .factory-venv overlay.' },
    ...(e && ver === 1 ? { upgrade: (() => { const u = upgradeOf(root, e); return u && u.env ? { hash: short(u.env), message: notice(root) ? notice(root).message : null } : u ? { why: u.why } : null; })() } : {}),
    doc: DOC_PATH,
  };
}

module.exports = { sweepChecks, DOC_PATH, status, upgradeOf, toolChoice, describe, schemaOf, commandsOf, inert, excludeReport, ensureIgnored, DOC, KEYS, lint, readsOf, withBaseEnv, gateProposal, needsConfirmation, fullHash, essence, isNone, JOB_PROPOSED, teardown, servicesDown, load, loadSafe, detect, proposal, problems, show, propose, confirm, check, ensure, wrap, preamble, processEnv, vars, expand, notice, cacheKey, short, FILE, PROPOSED };
