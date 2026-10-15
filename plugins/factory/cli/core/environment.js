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
//     "ignore": [".venv/"],                        what setup creates: kept out of git status
//     "timeout_seconds": 1200
//   }
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
const KEYS = ['version', 'name', 'setup', 'cache_key', 'env', 'prefix', 'services', 'ignore', 'timeout_seconds', 'notes'];

// The schema check: the smallest set that covers a plain venv repo and a compose-based one.
function problems(e) {
  const out = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['the environment must be a JSON object'];
  for (const k of Object.keys(e)) if (!KEYS.includes(k) && k !== 'seal' && k !== 'confirmed') out.push(`unknown field "${k}" (fields: ${KEYS.join(', ')})`);
  if (e.version !== undefined && e.version !== 1) out.push('version must be 1');
  const strs = (v, name) => {
    if (v === undefined) return;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) out.push(`${name} must be a list of non-empty strings`);
  };
  strs(e.setup, 'setup');
  strs(e.cache_key, 'cache_key');
  strs(e.ignore, 'ignore');
  if (e.env !== undefined && (typeof e.env !== 'object' || Array.isArray(e.env) || Object.entries(e.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string'))) out.push('env must map variable names to strings');
  if (e.prefix !== undefined && typeof e.prefix !== 'string') out.push('prefix must be a string');
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
function detect(root) {
  const py = read(root, 'pyproject.toml');
  const reqs = fs.existsSync(root) ? fs.readdirSync(root).filter((f) => /^requirements.*\.txt$/.test(f)) : [];
  const tasksPy = read(root, 'tasks.py');
  const pkg = read(root, 'package.json');
  const evidence = [];
  if (py && /nautobot/i.test(py) && tasksPy && /invoke/.test(tasksPy)) {
    // A Nautobot app (the cookiecutter layout): tests run in docker compose through invoke,
    // with Postgres and Redis. One compose project per worktree (its own containers and
    // database, the worktree's code mounted), named by INVOKE_<APP>_PROJECT_NAME.
    const ns = (/Collection\(\s*["']([\w]+)["']\s*\)/.exec(tasksPy) || [])[1] || ((/^name\s*=\s*["']([\w-]+)["']/m.exec(py) || [])[1] || 'app').replace(/-/g, '_');
    const V = `INVOKE_${ns.toUpperCase()}`;
    evidence.push('pyproject.toml (nautobot)', 'tasks.py (invoke)');
    for (const f of ['development/docker-compose.base.yml', 'development/docker-compose.postgres.yml', 'development/docker-compose.redis.yml', 'poetry.lock']) if (has(root, f)) evidence.push(f);
    return {
      version: 1,
      name: 'nautobot-app-invoke',
      setup: ['invoke build'],
      cache_key: ['poetry.lock', 'pyproject.toml', 'development/Dockerfile', 'development/*.yml', 'development/*.env'],
      env: { [`${V}_PROJECT_NAME`]: 'factory-{slug}', [`${V}_LOCAL`]: 'false' },
      prefix: '',
      ignore: [],
      timeout_seconds: 1800,
      notes: `Each worktree gets its own compose project (${V}_PROJECT_NAME=factory-{slug}): its own Postgres, Redis and Nautobot containers, with that worktree's code mounted. Verify commands look like "invoke unittest --failfast --label ${ns}.tests.test_x". Remove a project with "invoke destroy" in its worktree. For a shared Postgres/Redis stack and one test database per task instead, see the README recipe.`,
      evidence,
    };
  }
  if (py || reqs.length || has(root, 'setup.py') || has(root, 'setup.cfg')) {
    const dev = py && /\[project\.optional-dependencies\][\s\S]*?^\s*dev\s*=/m.test(py);
    const install = py || has(root, 'setup.py') ? `.venv/bin/pip install -q -e ${dev ? "'.[dev]'" : '.'}` : null;
    const setup = ['python3 -m venv .venv', '.venv/bin/pip install -q --upgrade pip', ...(install ? [install] : []), ...reqs.filter((f) => /dev|test/.test(f) || reqs.length === 1).map((f) => `.venv/bin/pip install -q -r ${f}`)];
    if (py) evidence.push('pyproject.toml');
    evidence.push(...reqs, ...['setup.py', 'setup.cfg', 'poetry.lock', 'uv.lock'].filter((f) => has(root, f)));
    return {
      version: 1,
      name: 'python-venv',
      setup,
      cache_key: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements*.txt', 'poetry.lock', 'uv.lock'],
      env: { VIRTUAL_ENV: '{worktree}/.venv', PATH: '{worktree}/.venv/bin:$PATH' },
      prefix: '',
      ignore: ['.venv/'],
      timeout_seconds: 1200,
      notes: 'Each worktree gets its own .venv with the project installed in editable mode from that worktree, so python, pytest and console scripts import the worktree\'s code. Write verify commands as "python -m pytest …" or "pytest …".',
      evidence,
    };
  }
  if (pkg) {
    const lock = has(root, 'package-lock.json') ? 'npm ci' : has(root, 'pnpm-lock.yaml') ? 'pnpm install --frozen-lockfile' : has(root, 'yarn.lock') ? 'yarn install --frozen-lockfile' : null;
    let deps = false;
    try {
      const p = JSON.parse(pkg);
      deps = Boolean(Object.keys({ ...(p.dependencies || {}), ...(p.devDependencies || {}) }).length);
    } catch {
      deps = false;
    }
    evidence.push('package.json', ...['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].filter((f) => has(root, f)));
    if (!deps && !lock) return { version: 1, name: 'none', setup: [], notes: 'package.json has no dependencies: worktrees need no setup.', evidence };
    return {
      version: 1,
      name: 'node',
      setup: [lock || 'npm install --no-audit --no-fund'],
      cache_key: ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
      env: { PATH: '{worktree}/node_modules/.bin:$PATH' },
      prefix: '',
      ignore: ['node_modules/'],
      timeout_seconds: 900,
      notes: 'Each worktree installs its own node_modules.',
      evidence,
    };
  }
  return { version: 1, name: 'none', setup: [], notes: 'No dependency manifest found: worktrees need no setup.', evidence: [] };
}

// What `factory env set` would confirm: the main session's proposal file, else detection.
function proposal(root) {
  const p = readJson(PROPOSED(root), null);
  if (p) return { ...p, source: 'factory env propose' };
  return { ...detect(root), source: 'detected from the repo files' };
}

// ---------------------------------------------------------------- expansion

function vars(root, state, taskId, wt) {
  const job = state ? state.id : 'envcheck';
  const scope = taskId || 'job';
  const slug = `${job}-${scope}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return { worktree: wt, root, job, task: scope, slug, db: `factory_${slug.replace(/-/g, '')}`.slice(0, 60) };
}
const expand = (s, v) => String(s).replace(/\{(worktree|root|job|task|slug|db)\}/g, (_, k) => v[k]);
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
function processEnv(e, v, base = process.env) {
  const out = {};
  for (const [k, val] of Object.entries((e && e.env) || {})) out[k] = expand(val, v).replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, n) => (n in out ? out[n] : base[n] || ''));
  return out;
}

// ---------------------------------------------------------------- running it

function sh(cmd, cwd, timeoutSec, extraEnv = {}) {
  const started = Date.now();
  const r = spawnSync('bash', ['-lc', cmd], { cwd, encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: process.env.CI || '1', FACTORY_ENV_SETUP: '1', ...extraEnv } });
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
// info/exclude applies to every worktree.
function ensureIgnored(root, e) {
  const list = (e && e.ignore) || [];
  if (!list.length) return;
  const common = path.resolve(root, git.out(root, ['rev-parse', '--git-common-dir']));
  const f = path.join(common, 'info', 'exclude');
  const cur = exists(f) ? fs.readFileSync(f, 'utf8') : '';
  const have = new Set(cur.split('\n').map((l) => l.trim()));
  const add = list.filter((p) => !have.has(p));
  if (add.length) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  }
}

// Job-level services: up once per job (recorded in the job state), health checked every time.
function ensureServices(root, state, e, v) {
  const s = e.services;
  if (!s || !s.up) return { ok: true };
  const T = e.timeout_seconds || 1200;
  const job = require('./job');
  const key = hash({ up: s.up, env: e.env || {} });
  const fresh = state ? job.load(root, state.id) : null;
  const jv = { ...v, worktree: root, task: 'job', slug: `${v.job}`.toLowerCase(), db: `factory_${String(v.job).toLowerCase().replace(/[^a-z0-9]/g, '')}` };
  const env = processEnv(e, jv);
  if (!fresh || !fresh.environment_services || fresh.environment_services.key !== key) {
    const r = sh(expand(s.up, jv), root, T, env);
    if (r.code !== 0) return { ok: false, broken: broken('services.up', expand(s.up, jv), r) };
    if (fresh) job.mutate(root, fresh.id, (st) => { st.environment_services = { key, up_at: nowIso() }; });
  }
  if (s.health) {
    const r = sh(expand(s.health, jv), root, Math.min(T, 300), env);
    if (r.code !== 0) return { ok: false, broken: broken('services.health', expand(s.health, jv), r) };
  }
  return { ok: true };
}

// Make the environment ready in one worktree: services (once per job), then setup, cached by
// the key above. { ok, env, vars, ran, cached, key } or { ok: false, broken }.
function ensure(root, state, { taskId = null, wt, env: given } = {}) {
  const e = given !== undefined ? given : load(root);
  const v = vars(root, state, taskId, wt);
  if (!e || (!(e.setup || []).length && !e.services && !Object.keys(e.env || {}).length && !e.prefix)) return { ok: true, env: e, vars: v, ran: [], cached: false, key: null, none: true };
  ensureIgnored(root, e);
  const svc = ensureServices(root, state, e, v);
  if (!svc.ok) return { ok: false, broken: svc.broken, env: e, vars: v };
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
    how: e
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

// Human-only (cli/core/human.js setEnvironment): write the sealed, confirmed environment.
function confirm(root, { file, none = false, expectHash = null, channel }) {
  let e;
  if (none) e = { version: 1, name: 'none', setup: [] };
  else if (file) e = readJson(path.resolve(file), null);
  else e = proposal(root);
  if (!e) fail(`No JSON in ${file}`, 'bad_input');
  const { source: _src, evidence: _ev, hash: _h, problems: _p, ...clean } = strip(e);
  if (expectHash && short(clean) !== expectHash && short(e) !== expectHash) fail(`The proposal is now ${short(clean)}, not ${expectHash}: it changed after it was shown. Run factory env show and confirm again.`, 'stale_environment');
  const pp = problems(clean);
  if (pp.length) fail(`The environment is not valid:\n- ${pp.join('\n- ')}`, 'environment_invalid', pp);
  const out = seal({ ...clean, version: 1, confirmed: { at: nowIso(), via: channel } });
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
function check(root, { proposed = false } = {}) {
  const { env: confirmed, error } = loadSafe(root);
  if (error) return { ok: false, error };
  const e = proposed || !confirmed ? strip(proposal(root)) : confirmed;
  const which = proposed || !confirmed ? 'proposed' : 'confirmed';
  const pp = problems(e);
  if (pp.length) return { ok: false, which, problems: pp };
  const wt = path.join(root, '.factory', 'worktrees', `_envcheck-${process.pid}`);
  git.run(root, ['worktree', 'prune'], { allowFail: true });
  git.run(root, ['worktree', 'add', '--detach', wt, 'HEAD']);
  try {
    const { evidence: _e, notes: _n, source: _s, ...run } = e;
    const r = ensure(root, null, { taskId: 'envcheck', wt, env: run });
    let down = null;
    if (e.services && e.services.down) down = sh(expand(e.services.down, vars(root, null, 'envcheck', wt)), root, 600).code;
    return { ok: r.ok, which, name: e.name || null, ran: r.ran || [], ...(r.ok ? {} : { broken: r.broken, message: r.broken.reason }), ...(down !== null ? { services_down_exit: down } : {}) };
  } finally {
    git.run(root, ['worktree', 'remove', '--force', wt], { allowFail: true });
  }
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

// A one-line summary for factory next / the gate view while no environment is confirmed.
function notice(root) {
  const { env: e, error } = loadSafe(root);
  if (error) return { status: 'tampered', message: error };
  if (e) return null;
  const p = proposal(root);
  if (p.name === 'none' && !(p.setup || []).length) return null;
  return {
    status: 'proposed',
    name: p.name,
    hash: short(p),
    setup: p.setup,
    env: p.env || {},
    services: p.services || null,
    evidence: p.evidence || [],
    message: `Worktrees have no build environment yet. Proposed (${p.source}): ${p.name} — setup: ${(p.setup || []).join(' && ') || '(none)'}. Show it to the user: they reply "confirm environment ${short(p)}" (or run factory env set / factory env show in their terminal); until then builders and task verify run in bare worktrees.`,
  };
}

module.exports = { servicesDown, load, loadSafe, detect, proposal, problems, show, propose, confirm, check, ensure, wrap, preamble, processEnv, vars, expand, notice, cacheKey, short, FILE, PROPOSED };
