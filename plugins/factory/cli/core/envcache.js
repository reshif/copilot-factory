'use strict';
// The shared package CACHE (0.12): every worktree keeps its OWN environment, built exactly like
// 0.11 (its own .factory-venv or node_modules, its own code, workspaces, path dependencies and
// setuptools_scm versions just work, .git is there). What is shared is data the installers
// already know how to reuse:
//
//   .factory/envcache/uv        UV_CACHE_DIR, with UV_LINK_MODE=copy: every venv gets its own
//                               copy of each file (a hard link would let a write in one worktree's
//                               venv change every other worktree and the cache: review 012B B-1);
//                               uv checks the hashes a uv.lock or a --require-hashes file carries
//   .factory/envcache/poetry    POETRY_CACHE_DIR (artifacts; poetry checks them against poetry.lock)
//   .factory/envcache/npm       npm_config_cache, with npm_config_prefer_offline (npm checks the
//                               lockfile's integrity hashes)
//   .factory/envcache/yarn, pnpm-store
//   .factory/wheelhouse/<key>/  pip: the ONLY shared source for pip (pip's own cache is not shared:
//                               it is not verified). Built only by the sealed environment's check
//                               (factory env check --job), from a fresh venv its setup just made in
//                               a scratch worktree of the base commit: what the declared inputs
//                               resolve to, never what an agent's venv holds (012B M-2). Every
//                               wheel's sha256 and the expected set are in a sealed manifest,
//                               checked before every use; a changed, added or missing wheel, or a
//                               set that is incomplete (a requirement that could not be wheeled, an
//                               offline install that missed), voids it until the next check
//                               rebuilds it (012B M-4). Task worktrees install with PIP_NO_INDEX
//                               and PIP_FIND_LINKS; ci verify and the epic gate resolve fresh.
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
const MISSED = (root, key) => path.join(WHEELS(root), `${key.slice(0, 16)}.missed.json`);
const norm = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '_');

// An offline install from this wheelhouse failed in a worktree: the key is incomplete until the
// next env check rebuilds it, and nobody tries it offline meanwhile (012B M-4).
function markMissed(root, key, cmd) {
  try {
    fs.mkdirSync(WHEELS(root), { recursive: true });
    writeJson(MISSED(root, key), seal({ key, cmd: redact(cmd || ''), at: nowIso() }));
  } catch {
    /* the next offline attempt fails again, then falls back */
  }
}

// The variables every installer reads for its cache (only the sealed environment's runs get them).
function cacheEnv(root) {
  const c = CACHE(root);
  return {
    UV_CACHE_DIR: path.join(c, 'uv'),
    UV_LINK_MODE: 'copy',
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
  const missed = readJson(MISSED(root, key), null);
  if (missed && valid(missed)) return { ok: false, incomplete: true, why: `incomplete: an offline install missed ${missed.cmd ? `(${redact(missed.cmd)})` : 'a requirement'} on ${missed.at}; the next env check rebuilds it` };
  const lacking = (m.expected || []).filter((name) => !Object.keys(wheels).some((w) => norm(w.split('-')[0]) === norm(name)));
  if (lacking.length) return { ok: false, incomplete: true, why: `incomplete: no wheel for ${lacking.slice(0, 5).join(', ')}` };
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

// Build the wheelhouse from the fresh venv the sealed environment's check just made (only
// factory env check calls this: environment.check, review 012B M-2): what that venv holds (pip
// freeze, pinned lines only: editables and the project itself are not wheels of the key), plus
// the project's build requirements, as wheels. Built in a temp dir and renamed into place (a crash
// never leaves a half wheelhouse), under a lock per key; its pip runs carry a tag, so a killed
// build's processes are ended and its temp dir removed by the next build or gc (012B m-1).
// `force`: rebuild even when one verifies (after a miss). Best effort: { ok, count } or { ok: false, why }.
function buildWheelhouse(root, key, { python, buildRequires = [], env = process.env, timeoutSec = 1200, force = false }) {
  if (!python || !fs.existsSync(python)) return { ok: false, why: 'no venv python to read the installed set from' };
  const final = dirOf(root, key);
  const v0 = verify(root, key);
  if (v0.ok && !force) return { ok: true, count: v0.count, reused: true };
  fs.mkdirSync(WHEELS(root), { recursive: true });
  const tag = `whbuild-${key.slice(0, 16)}`;
  return require('./job').withLock(`${final}.lock`, () => {
    // a build killed earlier: its pip processes and temp dirs
    try {
      require('./probe').survivors(tag, {});
    } catch {
      /* none */
    }
    sweepTemp(root);
    const v1 = verify(root, key);
    if (v1.ok && !force) return { ok: true, count: v1.count, reused: true };
    const penv = { ...env, FACTORY_PROBE_ID: tag };
    const fr = spawnSync(python, ['-m', 'pip', 'freeze', '--all', '--exclude-editable'], { encoding: 'utf8', timeout: 120000, env: penv });
    if (fr.status !== 0) return { ok: false, why: `pip freeze exit ${fr.status}: ${redact(String(fr.stderr || '').trim().slice(-300))}` };
    const lines = String(fr.stdout).split('\n').map((l) => l.trim()).filter(Boolean);
    const pins = lines.filter((l) => /^[A-Za-z0-9][A-Za-z0-9._-]*==[A-Za-z0-9._+!-]+$/.test(l));
    // a project installed from a local directory (`pip install .`: "name @ file://…") is the
    // project itself, not a dependency the wheelhouse should hold (012C m-3)
    const unpinned = lines.filter((l) => !pins.includes(l) && !/^#/.test(l) && !/ @ file:/.test(l)).map((l) => l.split(/[ @=]/)[0]);
    const tmp = `${final}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const reqs = `${tmp}.txt`;
    try {
      fs.writeFileSync(reqs, `${pins.join('\n')}\n`);
      const w = spawnSync(python, ['-m', 'pip', 'wheel', '-q', '--retries', '5', '--timeout', '60', '--no-deps', '-w', tmp, '-r', reqs], { encoding: 'utf8', timeout: timeoutSec * 1000, env: penv });
      if (w.status !== 0) return { ok: false, why: `pip wheel exit ${w.status}: ${redact(String(w.stderr || '').trim().slice(-300))}` };
      if (buildRequires.length) {
        const b = spawnSync(python, ['-m', 'pip', 'wheel', '-q', '--retries', '5', '--timeout', '60', '-w', tmp, ...buildRequires], { encoding: 'utf8', timeout: timeoutSec * 1000, env: penv });
        if (b.status !== 0) return { ok: false, why: `pip wheel (build requirements) exit ${b.status}: ${redact(String(b.stderr || '').trim().slice(-300))}` };
      }
      const wheels = {};
      for (const n of fs.readdirSync(tmp)) if (n.endsWith('.whl')) wheels[n] = fileHash(path.join(tmp, n));
      for (const n of fs.readdirSync(tmp)) if (!n.endsWith('.whl')) fs.rmSync(path.join(tmp, n), { recursive: true, force: true });
      // the expected set: every pinned requirement (a missing wheel shows as incomplete), and the
      // ones pip could not pin (a VCS or URL requirement): the wheelhouse is incomplete by design
      const expected = [...pins.map((p) => p.split('==')[0]), ...unpinned];
      writeJson(MANIFEST(tmp), seal({ version: 2, key, built_at: nowIso(), wheels, expected, pins: pins.length }));
      fs.rmSync(final, { recursive: true, force: true });
      fs.renameSync(tmp, final);
      fs.rmSync(MISSED(root, key), { force: true });
      try {
        gc(root, { keep: KEEP(), keepKey: key });
      } catch {
        /* garbage collection is a convenience */
      }
      const v2 = verify(root, key);
      return { ok: true, count: Object.keys(wheels).length, ...(v2.ok ? {} : { incomplete: v2.why }) };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(reqs, { force: true });
    }
  }, { waitMs: (timeoutSec + 600) * 1000, staleMs: (timeoutSec + 600) * 1000, what: `the wheelhouse ${key.slice(0, 16)}` });
}

// Temp dirs of wheelhouse builds whose process is gone (a killed build): removed.
function sweepTemp(root) {
  let names = [];
  try {
    names = fs.readdirSync(WHEELS(root));
  } catch {
    return;
  }
  for (const n of names) {
    const m = /^[0-9a-f]{16}\.tmp-(\d+)-[0-9a-f]+(\.txt)?$/.exec(n);
    if (!m) continue;
    let alive = false;
    try {
      process.kill(Number(m[1]), 0);
      alive = Number(m[1]) !== process.pid;
    } catch {
      alive = false;
    }
    if (!alive) fs.rmSync(path.join(WHEELS(root), n), { recursive: true, force: true });
  }
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
  sweepTemp(root);
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
    // what said a key was installed from these caches goes with them (012B M-3)
    fs.rmSync(path.join(CACHE(root), 'uv-installed.json'), { force: true });
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

module.exports = { markMissed, sweepTemp, MISSED, CACHE, WHEELS, LAST, KEEP, cacheEnv, keyOf, verify, touch, buildWheelhouse, wheelhouses, caches, gc, recordLast, redact, sizeOf, human, dirOf, pythonVersion };
