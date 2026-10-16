'use strict';
// The shared package CACHE (0.12): every worktree keeps its OWN environment, built exactly like
// 0.11 (its own .factory-venv or node_modules, its own code, workspaces, path dependencies and
// setuptools_scm versions just work, .git is there). What is shared is data the installers
// already know how to reuse, kept on the same filesystem as the worktrees (hard links work):
//
//   .factory/envcache/uv        UV_CACHE_DIR (UV_LINK_MODE=hardlink: a second install is seconds)
//   .factory/envcache/pip       PIP_CACHE_DIR (downloads and built wheels)
//   .factory/envcache/poetry    POETRY_CACHE_DIR (artifacts; poetry checks them against poetry.lock)
//   .factory/envcache/npm       npm_config_cache, with npm_config_prefer_offline (npm checks the
//                               lockfile's integrity hashes)
//   .factory/envcache/yarn, pnpm-store
//   .factory/wheelhouse/<key>/  pip only: every wheel the environment ended up with (and the
//                               project's build requirements), built once per key after the first
//                               successful setup. A later worktree installs with PIP_NO_INDEX and
//                               PIP_FIND_LINKS (no network), falling back to the index when a wheel
//                               is missing. Each wheel's sha256 is in a sealed manifest and checked
//                               before every use: a changed, added or missing file voids it.
//
// The cache is never executed from: it is what the installers read. Runs without your
// credentials (the plan probe, a proposal's check, repair candidates) use a verified wheelhouse
// read-only and keep their own scratch caches; only the sealed environment fills the shared ones.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { readJson, writeJson, nowIso, stableStringify } = require('../lib/util');
const { seal, valid } = require('../lib/seal');

const CACHE = (root) => path.join(root, '.factory', 'envcache');
const WHEELS = (root) => path.join(root, '.factory', 'wheelhouse');
const LAST = (root) => path.join(root, '.factory', 'envcache', 'last.json');
const KEEP = () => Math.max(1, parseInt(process.env.FACTORY_ENV_KEEP || '3', 10) || 3);
const hash = (x) => crypto.createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : stableStringify(x)).digest('hex');
const dirOf = (root, key) => path.join(WHEELS(root), key.slice(0, 16));
const MANIFEST = (dir) => path.join(dir, 'manifest.json');

// The variables every installer reads for its cache (only the sealed environment's runs get them).
function cacheEnv(root) {
  const c = CACHE(root);
  return {
    UV_CACHE_DIR: path.join(c, 'uv'),
    UV_LINK_MODE: 'hardlink',
    PIP_CACHE_DIR: path.join(c, 'pip'),
    POETRY_CACHE_DIR: path.join(c, 'poetry'),
    npm_config_cache: path.join(c, 'npm'),
    npm_config_prefer_offline: 'true',
    YARN_CACHE_FOLDER: path.join(c, 'yarn'),
    npm_config_store_dir: path.join(c, 'pnpm-store'),
  };
}

let PY = null;
function pythonVersion(env) {
  if (PY !== null) return PY;
  const r = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.version.split()[0], sys.implementation.cache_tag)'], { encoding: 'utf8', timeout: 10000, env });
  PY = r.status === 0 ? String(r.stdout).trim() : 'none';
  return PY;
}
function machineId() {
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    user = String(process.getuid ? process.getuid() : '');
  }
  return { host: os.hostname(), user, platform: process.platform, arch: process.arch };
}

// The wheelhouse key: the setup, the tool, the content of the cache_key files in this worktree,
// the python it runs on (a minor upgrade means other wheels) and this machine.
function keyOf(e, files, env) {
  return hash({ v: 2, setup: e.setup || [], tool: e.tool || null, cache: e.cache || null, files, python: pythonVersion(env), machine: machineId() });
}

// What a failure or a command says, without a login or a token in it.
function redact(text) {
  let t = String(text || '');
  try {
    t = require('./probe').redact(t);
  } catch {
    /* the probe's redaction is the main one */
  }
  return t
    .replace(/(\/\/)[^/\s:@]+:[^@\s/]+@/g, '$1[redacted]@')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|pypi-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,})/g, '[redacted]')
    .replace(/\b((?:[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY))\s*[=:]\s*)\S+/gi, '$1[redacted]');
}

function sizeOf(p) {
  let total = 0;
  const walk = (x) => {
    let st;
    try {
      st = fs.lstatSync(x);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let names = [];
      try {
        names = fs.readdirSync(x);
      } catch {
        names = [];
      }
      for (const n of names) walk(path.join(x, n));
    } else total += st.size;
  };
  walk(p);
  return total;
}
const human = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} kB` : `${n} B`);
const fileHash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// The wheelhouse for a key, when its sealed manifest holds and every wheel still has its hash (and
// nothing was added). { ok, dir, count } or { ok: false, why }.
function verify(root, key) {
  const dir = dirOf(root, key);
  const m = readJson(MANIFEST(dir), null);
  if (!m) return { ok: false, why: 'none' };
  if (!valid(m) || m.key !== key) return { ok: false, why: 'its manifest is not sealed by the factory' };
  const wheels = m.wheels || {};
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n !== 'manifest.json' && n !== 'used');
  } catch {
    names = [];
  }
  const extra = names.filter((n) => !(n in wheels));
  if (extra.length) return { ok: false, why: `files the manifest does not list: ${extra.slice(0, 3).join(', ')}` };
  for (const [n, h] of Object.entries(wheels)) {
    let got = null;
    try {
      got = fileHash(path.join(dir, n));
    } catch {
      got = null;
    }
    if (got !== h) return { ok: false, why: `${n} ${got ? 'changed' : 'is missing'}` };
  }
  return { ok: true, dir, count: Object.keys(wheels).length };
}

function touch(dir) {
  try {
    fs.writeFileSync(path.join(dir, 'used'), nowIso());
  } catch {
    /* last use is for garbage collection only */
  }
}

// Build the wheelhouse from an environment that just set up: what it holds (pip freeze, pinned
// lines only: editables and the project itself are not wheels of the key) plus the project's build
// requirements, as wheels, from the shared pip cache (no second download). Built in a temp dir and
// renamed into place (a crash never leaves a half wheelhouse), under a lock per key. Best effort:
// { ok, count } or { ok: false, why }.
function buildWheelhouse(root, key, { python, buildRequires = [], env = process.env, timeoutSec = 1200 }) {
  if (!python || !fs.existsSync(python)) return { ok: false, why: 'no venv python to read the installed set from' };
  const final = dirOf(root, key);
  if (verify(root, key).ok) return { ok: true, count: verify(root, key).count, reused: true };
  fs.mkdirSync(WHEELS(root), { recursive: true });
  return require('./job').withLock(`${final}.lock`, () => {
    if (verify(root, key).ok) return { ok: true, reused: true };
    const fr = spawnSync(python, ['-m', 'pip', 'freeze', '--all', '--exclude-editable'], { encoding: 'utf8', timeout: 120000, env });
    if (fr.status !== 0) return { ok: false, why: `pip freeze exit ${fr.status}: ${redact(String(fr.stderr || '').trim().slice(-300))}` };
    const pins = String(fr.stdout).split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z0-9][A-Za-z0-9._-]*==[A-Za-z0-9._+!-]+$/.test(l));
    const tmp = `${final}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const reqs = path.join(tmp, '..', `${path.basename(tmp)}.txt`);
      fs.writeFileSync(reqs, `${pins.join('\n')}\n`);
      const args = ['-m', 'pip', 'wheel', '-q', '--retries', '5', '--timeout', '60', '--no-deps', '-w', tmp, '-r', reqs];
      const w = spawnSync(python, args, { encoding: 'utf8', timeout: timeoutSec * 1000, env });
      fs.rmSync(reqs, { force: true });
      if (w.status !== 0) return { ok: false, why: `pip wheel exit ${w.status}: ${redact(String(w.stderr || '').trim().slice(-300))}` };
      if (buildRequires.length) {
        const b = spawnSync(python, ['-m', 'pip', 'wheel', '-q', '--retries', '5', '--timeout', '60', '-w', tmp, ...buildRequires], { encoding: 'utf8', timeout: timeoutSec * 1000, env });
        if (b.status !== 0) return { ok: false, why: `pip wheel (build requirements) exit ${b.status}: ${redact(String(b.stderr || '').trim().slice(-300))}` };
      }
      const wheels = {};
      for (const n of fs.readdirSync(tmp)) if (n.endsWith('.whl')) wheels[n] = fileHash(path.join(tmp, n));
      for (const n of fs.readdirSync(tmp)) if (!n.endsWith('.whl')) fs.rmSync(path.join(tmp, n), { recursive: true, force: true });
      writeJson(MANIFEST(tmp), seal({ version: 1, key, built_at: nowIso(), wheels, pins: pins.length }));
      fs.rmSync(final, { recursive: true, force: true });
      fs.renameSync(tmp, final);
      try {
        gc(root, { keep: KEEP(), keepKey: key });
      } catch {
        /* garbage collection is a convenience */
      }
      return { ok: true, count: Object.keys(wheels).length };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, { waitMs: (timeoutSec + 600) * 1000, staleMs: (timeoutSec + 600) * 1000, what: `the wheelhouse ${key.slice(0, 16)}` });
}

function wheelhouses(root) {
  let names = [];
  try {
    names = fs.readdirSync(WHEELS(root)).filter((n) => /^[0-9a-f]{16}$/.test(n));
  } catch {
    names = [];
  }
  return names.map((n) => {
    const dir = path.join(WHEELS(root), n);
    const m = readJson(MANIFEST(dir), null) || {};
    let used = null;
    try {
      used = fs.statSync(path.join(dir, 'used')).mtime.toISOString();
    } catch {
      used = null;
    }
    const bytes = sizeOf(dir);
    return { key: n, path: dir, wheels: Object.keys(m.wheels || {}).length, built_at: m.built_at || null, last_used: used, sealed: valid(m), size_bytes: bytes, size: human(bytes) };
  }).sort((a, b) => String(b.last_used || b.built_at || '').localeCompare(String(a.last_used || a.built_at || '')));
}
function caches(root) {
  let names = [];
  try {
    names = fs.readdirSync(CACHE(root)).filter((n) => fs.statSync(path.join(CACHE(root), n)).isDirectory());
  } catch {
    names = [];
  }
  return names.map((n) => {
    const bytes = sizeOf(path.join(CACHE(root), n));
    return { name: n, path: path.join(CACHE(root), n), size_bytes: bytes, size: human(bytes) };
  });
}

// Remove old wheelhouses: the newest `keep` (by last use) stay, and any used in the last 10
// minutes (a run may be about to read it). `caches: true` also empties the package caches.
function gc(root, { keep = KEEP(), caches: all = false, keepKey = null } = {}) {
  const list = wheelhouses(root);
  const kept = [];
  const removed = [];
  let n = 0;
  for (const x of list) {
    const recent = x.last_used && Date.now() - Date.parse(x.last_used) < 10 * 60e3;
    const mine = keepKey && keepKey.slice(0, 16) === x.key;
    if (n < keep || recent || mine || fs.existsSync(`${x.path}.lock`)) {
      n += 1;
      kept.push({ key: x.key, size: x.size });
      continue;
    }
    fs.rmSync(x.path, { recursive: true, force: true });
    removed.push({ key: x.key, size: x.size, size_bytes: x.size_bytes });
  }
  let cleared = [];
  if (all) {
    cleared = caches(root).map((c) => ({ name: c.name, size: c.size, size_bytes: c.size_bytes }));
    for (const c of caches(root)) fs.rmSync(c.path, { recursive: true, force: true });
  }
  const bytes = [...removed, ...cleared].reduce((s, r) => s + (r.size_bytes || 0), 0);
  return { kept, removed: removed.map(({ size_bytes: _b, ...r }) => r), ...(all ? { caches_cleared: cleared.map(({ size_bytes: _b, ...r }) => r) } : {}), freed: human(bytes) };
}

function recordLast(root, rec) {
  try {
    const cur = readJson(LAST(root), {}) || {};
    const clean = { ...rec, ...(rec.cmd ? { cmd: redact(rec.cmd) } : {}), ...(rec.tail ? { tail: redact(rec.tail).slice(-2000) } : {}) };
    writeJson(LAST(root), { ...cur, last_build: clean, ...(rec.ok ? {} : { last_failure: clean }) });
  } catch {
    /* status is a convenience */
  }
}

module.exports = { CACHE, WHEELS, LAST, KEEP, cacheEnv, keyOf, verify, touch, buildWheelhouse, wheelhouses, caches, gc, recordLast, redact, sizeOf, human, dirOf, pythonVersion };
