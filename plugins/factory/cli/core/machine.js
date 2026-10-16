'use strict';
// The machine's tool inventory (fix 0.10.1): what a build environment can rely on HERE, so the
// environment the factory proposes (and the planner writes) uses tools that exist and work on
// this machine, without sudo. A real failure it prevents (J-0001, WSL Ubuntu 22.04): setup ran
// `python3 -m venv` where python3.10-venv (ensurepip) was not installed, while virtualenv was.
//
//   python    every python3.x on the PATH, with its version
//   venv      whether `python3 -m venv` really works: a throwaway venv is created (ensurepip
//             missing fails here, not when the module imports)
//   tools     virtualenv, uv, poetry, pipenv, pyenv, pipx, docker, compose, node, npm, pnpm,
//             yarn, bun: path and version, or null
//   docker    the daemon reachable without sudo (docker info)
//   sudo      none | passwordless | password (a setup never uses sudo; this says why a missing
//             system package is the user's to install)
//   network   PyPI and the npm registry: reachable, HTTP code, latency (curl, 8 s cap)
//
// Cached per machine (~/.cache/factory/machine-<key>.json, XDG_CACHE_HOME honoured) for a day;
// the key is the host, the user and the PATH searched. `factory doctor` shows it with remedies;
// environment detection and the planner's brief use it; the plan probe lints against it.
// FACTORY_MACHINE_PATH (tests, or a narrower view) replaces the PATH the tools are looked up on;
// FACTORY_MACHINE_OFFLINE=1 skips the network check; FACTORY_MACHINE_FILE names a fixed inventory
// (JSON, the shape scan() returns) used instead of scanning.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256 } = require('../lib/util');

const TTL_MS = 24 * 3600e3;
const TOOLS = ['virtualenv', 'uv', 'poetry', 'pipenv', 'pyenv', 'pipx', 'docker', 'docker-compose', 'node', 'npm', 'pnpm', 'yarn', 'bun', 'curl', 'git'];
const PYTHONS = ['python3', ...Array.from({ length: 10 }, (_, i) => `python3.${i + 6}`), 'python'];

const searchPath = () => process.env.FACTORY_MACHINE_PATH || process.env.PATH || '';
function which(name, dirs = searchPath()) {
  for (const d of String(dirs).split(path.delimiter).filter(Boolean)) {
    const f = path.join(d, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* not here */
    }
  }
  return null;
}
function run(file, args, { timeoutSec = 10, cwd } = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: timeoutSec * 1000, stdio: ['ignore', 'pipe', 'pipe'], cwd, env: { ...process.env, PATH: `${searchPath()}${path.delimiter}${process.env.PATH || ''}` } });
  return { code: r.status === null ? -1 : r.status, out: `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim() };
}
const firstLine = (s) => String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
const versionOf = (s) => (/(\d+\.\d+(?:\.\d+)?)/.exec(String(s || '')) || [])[1] || null;

function cacheFile(key) {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'factory', `machine-${key.slice(0, 16)}.json`);
}
function cacheKey() {
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    user = String(process.getuid ? process.getuid() : '');
  }
  return sha256(`${os.hostname()}\0${user}\0${searchPath()}\0${process.env.FACTORY_MACHINE_OFFLINE || ''}`);
}

// Does `<python> -m venv` make a usable venv (python and pip inside)?
function venvWorks(py) {
  if (!py) return { works: false, python: null, why: 'no python3 on the PATH' };
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-venv-probe-'));
    const r = run(py, ['-m', 'venv', path.join(dir, 'v')], { timeoutSec: 90 });
    const bin = path.join(dir, 'v', process.platform === 'win32' ? 'Scripts' : 'bin');
    const pipOk = fs.existsSync(path.join(bin, 'pip')) || fs.existsSync(path.join(bin, 'pip3'));
    if (r.code === 0 && pipOk) return { works: true, python: py, why: null };
    const ensurepip = /ensurepip/.test(r.out);
    return { works: false, python: py, ensurepip: !ensurepip && r.code === 0 ? 'no pip in the venv' : 'missing', why: firstLine(r.out.split('\n').find((l) => /ensurepip|venv|apt/i.test(l)) || r.out).slice(0, 300) || 'the venv has no pip' };
  } catch (e) {
    return { works: false, python: py, why: String(e.message).slice(0, 200) };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function reach(curl, url) {
  if (process.env.FACTORY_MACHINE_OFFLINE === '1') return { checked: false };
  if (!curl) return { checked: false, why: 'curl not found' };
  const r = run(curl, ['-sS', '-o', '/dev/null', '-I', '-w', '%{http_code} %{time_total}', '--max-time', '8', url], { timeoutSec: 12 });
  const m = /(\d{3}) ([\d.]+)/.exec(r.out);
  const code = m ? Number(m[1]) : null;
  return { checked: true, ok: Boolean(code && code < 500 && code !== 0), code, ms: m ? Math.round(Number(m[2]) * 1000) : null, ...(code ? {} : { why: firstLine(r.out).slice(0, 200) }) };
}

function scan() {
  const python = [];
  const seen = new Set();
  for (const n of PYTHONS) {
    const p = which(n);
    if (!p) continue;
    let real = p;
    try {
      real = fs.realpathSync(p);
    } catch {
      real = p;
    }
    const v = versionOf(run(p, ['--version']).out);
    if (n !== 'python3' && seen.has(`${real}`)) continue;
    seen.add(real);
    python.push({ cmd: n, path: p, version: v });
  }
  const tools = {};
  for (const t of TOOLS) {
    const p = which(t);
    tools[t] = p ? { path: p, version: versionOf(run(p, ['--version']).out) } : null;
  }
  // docker compose v2 is a docker subcommand
  let compose = tools['docker-compose'] ? 'docker-compose' : null;
  let daemon = null;
  if (tools.docker) {
    if (run(tools.docker.path, ['compose', 'version']).code === 0) compose = 'docker compose';
    const info = run(tools.docker.path, ['info'], { timeoutSec: 15 });
    daemon = info.code === 0 ? 'reachable' : /permission denied/i.test(info.out) ? 'needs_sudo' : 'not_running';
  }
  const sudoPath = which('sudo');
  const sudo = !sudoPath ? 'none' : run(sudoPath, ['-n', 'true'], { timeoutSec: 5 }).code === 0 ? 'passwordless' : 'password';
  const py3 = (python.find((p) => p.cmd === 'python3') || python[0] || {}).path || null;
  return {
    version: 1,
    at: new Date().toISOString(),
    host: os.hostname(),
    platform: `${process.platform}${fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') || /microsoft/i.test(os.release()) ? ' (WSL)' : ''}`,
    python,
    venv: venvWorks(py3),
    tools,
    docker: { present: Boolean(tools.docker), compose, daemon },
    sudo,
    network: { pypi: reach(tools.curl && tools.curl.path, 'https://pypi.org/simple/pip/'), npm: reach(tools.curl && tools.curl.path, 'https://registry.npmjs.org/') },
  };
}

// The inventory, from the cache when it is current (refresh: scan again).
function inventory({ refresh = false } = {}) {
  // a fixed inventory (tests; or a machine described by hand): FACTORY_MACHINE_FILE
  if (process.env.FACTORY_MACHINE_FILE) {
    try {
      return JSON.parse(fs.readFileSync(process.env.FACTORY_MACHINE_FILE, 'utf8'));
    } catch {
      /* unreadable: scan */
    }
  }
  const key = cacheKey();
  const f = cacheFile(key);
  if (!refresh) {
    try {
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (c && c.key === key && Date.now() - Date.parse(c.at) < TTL_MS) return c;
    } catch {
      /* none yet */
    }
  }
  const inv = { ...scan(), key };
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(inv, null, 1));
  } catch {
    /* a cache is a convenience */
  }
  return inv;
}

const has = (inv, t) => Boolean(inv && inv.tools && inv.tools[t]);

// How a Python environment is made here: uv > poetry (when the repo uses it) > virtualenv >
// python3 -m venv (only when it works). null when none can.
function pythonInstaller(inv, { poetryRepo = false } = {}) {
  if (!inv) return 'venv';
  if (has(inv, 'uv')) return 'uv';
  if (poetryRepo && has(inv, 'poetry')) return 'poetry';
  if (has(inv, 'virtualenv')) return 'virtualenv';
  if (inv.venv && inv.venv.works) return 'venv';
  return null;
}

// What the planner and the doctor are told: one line per fact, with the remedy where one is due.
function lines(inv) {
  if (!inv) return [];
  const L = [];
  const t = (n) => (inv.tools[n] ? `${n} ${inv.tools[n].version || ''}`.trim() : null);
  L.push({ name: 'python', ok: inv.python.length > 0, detail: inv.python.length ? inv.python.map((p) => `${p.cmd} ${p.version || '?'}`).join(', ') : 'no python3 on the PATH', remedy: 'install Python 3 (your package manager), or use uv (it fetches Python itself)' });
  L.push({ name: 'python3 -m venv', ok: Boolean(inv.venv && inv.venv.works), detail: inv.venv && inv.venv.works ? 'works (a throwaway venv was created)' : `does not work${inv.venv && inv.venv.why ? `: ${inv.venv.why}` : ''}`, remedy: has(inv, 'uv') ? 'environments use uv instead' : has(inv, 'virtualenv') ? 'environments use virtualenv instead' : 'install uv (curl -LsSf https://astral.sh/uv/install.sh | sh, no sudo) or the venv package (sudo apt install python3-venv)' });
  const py = ['uv', 'poetry', 'virtualenv', 'pipenv', 'pyenv', 'pipx'].map(t).filter(Boolean);
  L.push({ name: 'python tools', ok: true, detail: py.length ? py.join(', ') : 'none of uv, poetry, virtualenv, pipenv, pyenv, pipx' });
  L.push({ name: 'docker', ok: !inv.docker.present || inv.docker.daemon === 'reachable', level: 'warning', detail: !inv.docker.present ? 'not installed (no services in containers)' : `${inv.docker.compose || 'no compose'}; daemon ${inv.docker.daemon}`, remedy: inv.docker.daemon === 'needs_sudo' ? 'add yourself to the docker group (sudo usermod -aG docker $USER, then log in again): a setup never uses sudo' : 'start the docker daemon (Docker Desktop with WSL integration on WSL)' });
  const js = ['node', 'npm', 'pnpm', 'yarn', 'bun'].map(t).filter(Boolean);
  L.push({ name: 'javascript tools', ok: true, detail: js.join(', ') || 'none' });
  L.push({ name: 'sudo', ok: true, detail: `${inv.sudo}: environments never use sudo; a missing system package is yours to install` });
  for (const [n, r] of Object.entries(inv.network || {})) L.push({ name: `network ${n}`, ok: !r.checked || r.ok, level: 'warning', detail: !r.checked ? `not checked${r.why ? ` (${r.why})` : ''}` : r.ok ? `reachable (HTTP ${r.code}, ${r.ms} ms)` : `unreachable${r.why ? `: ${r.why}` : ''}`, remedy: 'check the proxy settings (HTTPS_PROXY, pip.conf, .npmrc); installs retry (pip --retries 5 --timeout 60)' });
  return L;
}

// A short JSON view for the planner's brief.
function summary(inv) {
  if (!inv) return null;
  return {
    platform: inv.platform,
    python: inv.python.map((p) => `${p.cmd} ${p.version || '?'}`),
    python3_venv_works: Boolean(inv.venv && inv.venv.works),
    ...(inv.venv && !inv.venv.works ? { venv_problem: inv.venv.why } : {}),
    tools: Object.fromEntries(Object.entries(inv.tools).map(([k, v]) => [k, v ? v.version || true : false])),
    docker: inv.docker,
    sudo: inv.sudo,
    network: Object.fromEntries(Object.entries(inv.network || {}).map(([k, v]) => [k, v.checked ? (v.ok ? 'reachable' : 'unreachable') : 'not checked'])),
    python_installer: pythonInstaller(inv),
  };
}

module.exports = { inventory, scan, which, pythonInstaller, lines, summary, has, venvWorks, cacheFile, cacheKey, TOOLS };
