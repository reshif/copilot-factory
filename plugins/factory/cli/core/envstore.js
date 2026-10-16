'use strict';
// Shared dependency environments (0.12). Before, every worktree (each task's, the job's, the
// env check's and the plan probe's scratch worktrees, repair candidates, ci verify) ran the whole
// setup: its own .venv and every dependency installed again (a Nautobot app: five minutes of
// nautobot and napalm per worktree). Now an environment of schema version 2 says:
//
//   deps      installed ONCE per key into .factory/envs/<key>/ (factory-owned, never the
//             repository's own .venv): run in <env>/src, a copy of the worktree's tracked files,
//             so a build writes nothing into any worktree
//   deps_key  the files whose content keys it (with the deps commands, the tool, env and this
//             machine): a lockfile change builds a new one; nothing else does
//   overlay   what each worktree gets from it, cheaply:
//               python  <worktree>/.factory-venv, a thin venv (python -m venv --without-pip, no
//                       network) whose site-packages sees the shared venv's through one .pth file,
//                       with the shared console scripts re-pointed at the thin venv's python, so
//                       pytest and every console script import THIS worktree's code
//               node    <worktree>/node_modules, a symlink to <env>/src/node_modules
//               none    nothing (a docker image the deps step built is shared by its tag)
//   project   per worktree, after the overlay (cheap: an editable install with --no-deps)
//
// Concurrency: one build per key at a time (a lock file next to the env); parallel tasks wait for
// it and then reuse it; a build that failed while they waited is not run again for them.
// A run without the user's environment (the plan probe, an unconfirmed proposal's check, a repair
// candidate: environment.withBaseEnv) never writes the shared store: it reuses a shared env whose
// key matches, read-only, or builds a private one inside its own scratch worktree.
// Old envs are garbage-collected after each build: the newest KEEP (by last use) and every env a
// worktree still uses stay.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { readJson, writeJson, nowIso, stableStringify } = require('../lib/util');
const { matchesAny } = require('../lib/glob');
const git = require('../lib/git');

const STORE = (root) => path.join(root, '.factory', 'envs');
const LAST = (root) => path.join(STORE(root), 'last.json');
const OVERLAY = '.factory-venv';
const KEEP = () => Math.max(1, parseInt(process.env.FACTORY_ENV_KEEP || '3', 10) || 3);
const hash = (x) => crypto.createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : stableStringify(x)).digest('hex');

const dirOf = (root, key) => path.join(STORE(root), key.slice(0, 16));
const markerOf = (dir) => path.join(dir, 'env.json');
const lockOf = (dir) => `${dir}.lock`;

function machineId() {
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    user = String(process.getuid ? process.getuid() : '');
  }
  return { host: os.hostname(), user, platform: process.platform, arch: process.arch };
}

// The tracked files of a worktree that match the env's deps_key, with their content hashes.
function keyFiles(e, wt) {
  const pats = e.deps_key || [];
  if (!pats.length) return [];
  let tracked = [];
  try {
    tracked = git.out(wt, ['ls-files']).split('\n').filter(Boolean);
  } catch {
    tracked = [];
  }
  const out = [];
  for (const f of tracked.filter((x) => matchesAny(x, pats)).sort()) {
    try {
      out.push([f, hash(fs.readFileSync(path.join(wt, f)))]);
    } catch {
      /* listed but missing */
    }
  }
  return out;
}

// The key of the shared env a worktree needs.
function keyOf(e, wt) {
  return hash({ v: 2, tool: e.tool || null, deps: e.deps || [], overlay: e.overlay || 'none', env: e.env || {}, files: keyFiles(e, wt), machine: machineId() });
}

function readMarker(dir) {
  return readJson(markerOf(dir), null);
}

// Is a built env still there (a deleted venv, an interrupted build)?
function healthy(e, dir) {
  const m = readMarker(dir);
  if (!m || !m.ok) return false;
  if ((e.overlay || 'none') === 'python') return fs.existsSync(path.join(dir, 'venv', 'bin', 'python'));
  if (e.overlay === 'node' && (e.deps || []).length) return fs.existsSync(path.join(dir, 'src', 'node_modules'));
  return true;
}

// Copy the worktree's tracked files (their working-tree content) to <dir>/src: the deps commands
// run there, so nothing they write (build/, *.egg-info, node_modules) lands in a worktree.
function stage(wt, src) {
  fs.rmSync(src, { recursive: true, force: true });
  fs.mkdirSync(src, { recursive: true });
  let files = [];
  try {
    files = git.run(wt, ['ls-files', '-z'], { allowFail: true }).stdout.split('\0').filter(Boolean);
  } catch {
    files = [];
  }
  for (const f of files) {
    const from = path.join(wt, f);
    const to = path.join(src, f);
    let st;
    try {
      st = fs.lstatSync(from);
    } catch {
      continue;
    }
    if (st.isDirectory()) continue; // a submodule
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
  }
  return files.length;
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

// What a failure says, with no login or token in it.
function redact(text) {
  let t = String(text || '');
  try {
    t = require('./probe').redact(t);
  } catch {
    /* the probe's redaction is the main one */
  }
  return t
    .replace(/(\/\/)[^/\s:@]+:[^@\s/]+@/g, '$1[redacted]@')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|xox[abprs]-[A-Za-z0-9-]{8,})/g, '[redacted]')
    .replace(/\b((?:[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY))\s*[=:]\s*)\S+/gi, '$1[redacted]');
}

function recordLast(root, rec) {
  try {
    const cur = readJson(LAST(root), {}) || {};
    const next = { ...cur, last_build: rec, ...(rec.ok ? {} : { last_failure: rec }) };
    writeJson(LAST(root), next);
  } catch {
    /* status is a convenience */
  }
}

// Build (or reuse) the shared env for this key. run(cmd, cwd) runs one deps command with the
// environment's exports; returns { ok, dir, key, built, waited_ms, ran } or { ok: false, broken }.
// readOnly: never write the shared store (see the head of this file): `privateDir` is used when
// the shared env for the key is missing.
function ensureShared(root, e, { key, wt, run, timeoutSec, readOnly = false, privateDir = null, who = null }) {
  const shared = dirOf(root, key);
  if (healthy(e, shared)) {
    if (!readOnly) touch(shared);
    return { ok: true, dir: shared, key, built: false, reused: true, waited_ms: 0, ran: [] };
  }
  if (readOnly) {
    const dir = privateDir;
    if (healthy(e, dir) && (readMarker(dir) || {}).key === key) return { ok: true, dir, key, built: false, private: true, waited_ms: 0, ran: [] };
    return { ...buildIn(root, e, { dir, key, wt, run, who, record: false }), private: true, waited_ms: 0 };
  }
  fs.mkdirSync(STORE(root), { recursive: true });
  const asked = Date.now();
  const T = timeoutSec || 1200;
  const waitMs = (T * Math.max(1, (e.deps || []).length) + 600) * 1000;
  return require('./job').withLock(lockOf(shared), () => {
    const waited = Date.now() - asked;
    // built by another task while this one waited
    if (healthy(e, shared)) {
      touch(shared);
      return { ok: true, dir: shared, key, built: false, reused: true, waited_ms: waited, ran: [] };
    }
    // failed while this one waited: the same failure, not a second five-minute run
    const m = readMarker(shared);
    if (m && m.ok === false && m.key === key && Date.parse(m.finished_at || 0) >= asked && m.failure) {
      return { ok: false, dir: shared, key, built: false, waited_ms: waited, broken: m.failure.broken, ran: [] };
    }
    const r = buildIn(root, e, { dir: shared, key, wt, run, who, record: true });
    if (r.ok) {
      try {
        gc(root, { keep: KEEP() });
      } catch {
        /* garbage collection is a convenience */
      }
    }
    return { ...r, waited_ms: waited };
  }, { waitMs, staleMs: waitMs, what: `the shared build environment ${key.slice(0, 16)}` });
}

function touch(dir) {
  try {
    const f = path.join(dir, 'used');
    fs.writeFileSync(f, nowIso());
  } catch {
    /* last use is for garbage collection only */
  }
}

function buildIn(root, e, { dir, key, wt, run, who, record }) {
  const started = Date.now();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'src');
  const base = { version: 2, key, name: e.name || null, tool: e.tool || null, reason: e.reason || null, overlay: e.overlay || 'none', machine: machineId(), files: keyFiles(e, wt).map((f) => f[0]), started_at: nowIso(), ...(who ? { by: who } : {}) };
  writeJson(markerOf(dir), { ...base, ok: false, building: true, pid: process.pid });
  stage(wt, src);
  const ran = [];
  for (const cmd of e.deps || []) {
    const r = run(cmd, src, dir);
    ran.push({ cmd: r.cmd, code: r.code, ms: r.ms });
    if (r.code !== 0) {
      const broken = r.broken;
      const failure = { phase: 'deps', cmd: r.cmd, code: r.code, timed_out: Boolean(r.timed_out), tail: redact(broken.tail).slice(-2000), broken: { ...broken, tail: redact(broken.tail), reason: redact(broken.reason) } };
      // what a failed build left is no use: only its record stays (factory env status shows it)
      for (const n of fs.readdirSync(dir)) if (n !== 'env.json') fs.rmSync(path.join(dir, n), { recursive: true, force: true });
      const rec = { ...base, ok: false, finished_at: nowIso(), ms: Date.now() - started, ran, failure };
      writeJson(markerOf(dir), rec);
      if (record) recordLast(root, { at: rec.finished_at, ok: false, key, dir, phase: 'deps', cmd: r.cmd, code: r.code, tail: failure.tail, worktree: wt, by: who });
      return { ok: false, dir, key, built: true, ran, broken: failure.broken };
    }
  }
  const rec = { ...base, ok: true, finished_at: nowIso(), built_at: nowIso(), ms: Date.now() - started, ran, size_bytes: sizeOf(dir) };
  writeJson(markerOf(dir), rec);
  touch(dir);
  if (record) recordLast(root, { at: rec.finished_at, ok: true, key, dir, ms: rec.ms, worktree: wt, by: who });
  return { ok: true, dir, key, built: true, ran };
}

// ---------------------------------------------------------------- overlays

function sitePackages(prefix) {
  for (const lib of ['lib', 'lib64']) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(prefix, lib)).filter((n) => /^python\d/.test(n)).sort();
    } catch {
      names = [];
    }
    for (const n of names) {
      const p = path.join(prefix, lib, n, 'site-packages');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// <wt>/.factory-venv over <dir>/venv. Returns { ok, cached, path } or { ok: false, why }.
function pythonOverlay(dir, wt, key, env) {
  const ov = path.join(wt, OVERLAY);
  const mark = path.join(ov, '.factory-overlay.json');
  const shared = path.join(dir, 'venv');
  const want = { env_key: key, shared };
  const have = readJson(mark, null);
  if (have && have.env_key === key && have.shared === shared && fs.existsSync(path.join(ov, 'bin', 'python'))) return { ok: true, cached: true, path: ov };
  const py = path.join(shared, 'bin', 'python');
  if (!fs.existsSync(py)) return { ok: false, why: `the shared environment has no venv at ${shared} (its deps commands must make one there: {env}/venv)` };
  fs.rmSync(ov, { recursive: true, force: true });
  // --without-pip: no ensurepip and no network; pip (and everything else) comes from the shared venv
  const r = spawnSync(py, ['-m', 'venv', '--without-pip', ov], { encoding: 'utf8', timeout: 120000, env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) return { ok: false, why: `${py} -m venv --without-pip ${ov} exit ${r.status}: ${String(r.stderr || r.stdout || '').trim().slice(-400)}` };
  const site = sitePackages(ov);
  const sharedSite = sitePackages(shared);
  if (!site || !sharedSite) return { ok: false, why: `no site-packages in ${site ? shared : ov}` };
  // processed last (after an editable install's own .pth): the worktree's code comes first
  fs.writeFileSync(path.join(site, 'zzz_factory_shared.pth'), `import site; site.addsitedir(${JSON.stringify(sharedSite)})\n`);
  // the shared console scripts, re-pointed at the thin venv's python (they would import the
  // shared venv's view otherwise, without this worktree's code)
  const sbin = path.join(shared, 'bin');
  const obin = path.join(ov, 'bin');
  const pyRef = new RegExp(`${sbin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/python[\\d.]*`, 'g');
  for (const n of fs.readdirSync(sbin)) {
    if (/^(python[\d.]*|activate.*|Activate\.ps1|deactivate.*|pydoc\.bat)$/.test(n)) continue;
    const from = path.join(sbin, n);
    const to = path.join(obin, n);
    if (fs.existsSync(to)) continue;
    let st;
    try {
      st = fs.statSync(from);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let head = '';
    try {
      const fd = fs.openSync(from, 'r');
      const b = Buffer.alloc(2);
      fs.readSync(fd, b, 0, 2, 0);
      fs.closeSync(fd);
      head = b.toString('latin1');
    } catch {
      head = '';
    }
    if (head === '#!' && st.size < 256 * 1024) {
      const text = fs.readFileSync(from, 'utf8');
      if (pyRef.test(text)) {
        pyRef.lastIndex = 0;
        fs.writeFileSync(to, text.replace(pyRef, path.join(obin, 'python')), { mode: 0o755 });
        continue;
      }
      pyRef.lastIndex = 0;
    }
    fs.symlinkSync(from, to);
  }
  writeJson(mark, { ...want, at: nowIso() });
  return { ok: true, cached: false, path: ov };
}

// <wt>/node_modules -> <dir>/src/node_modules
function nodeOverlay(dir, wt) {
  const link = path.join(wt, 'node_modules');
  const target = path.join(dir, 'src', 'node_modules');
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  try {
    if (fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === target) return { ok: true, cached: true, path: link };
  } catch {
    /* none yet */
  }
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link, 'dir');
  return { ok: true, cached: false, path: link };
}

function overlay(e, dir, wt, key, env) {
  const kind = e.overlay || 'none';
  if (kind === 'python') return pythonOverlay(dir, wt, key, env);
  if (kind === 'node') return nodeOverlay(dir, wt);
  return { ok: true, cached: true, path: null };
}

// ---------------------------------------------------------------- what is there

// The worktrees under .factory/worktrees and the environment each was set up with (read from the
// marker in its git dir; no git process).
function worktreeUses(root) {
  const base = path.join(root, '.factory', 'worktrees');
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    names = [];
  }
  for (const n of names) {
    const wt = path.join(base, n);
    let gd = null;
    try {
      const g = fs.readFileSync(path.join(wt, '.git'), 'utf8');
      const m = /^gitdir:\s*(.+)$/m.exec(g);
      if (m) gd = path.resolve(wt, m[1].trim());
    } catch {
      gd = null;
    }
    if (!gd) continue;
    const mk = readJson(path.join(gd, 'factory-env.json'), null);
    if (!mk) continue;
    out.push({ worktree: wt, name: n, env_key: mk.env_key || null, ok: Boolean(mk.ok), at: mk.at || null, schema: mk.env_key ? 2 : 1 });
  }
  return out;
}

function list(root, { sizes = true } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(STORE(root)).filter((n) => /^[0-9a-f]{16}$/.test(n));
  } catch {
    names = [];
  }
  const uses = worktreeUses(root);
  return names.map((n) => {
    const dir = path.join(STORE(root), n);
    const m = readMarker(dir) || {};
    let used = null;
    try {
      used = fs.statSync(path.join(dir, 'used')).mtime.toISOString();
    } catch {
      used = null;
    }
    const users = uses.filter((u) => u.env_key && u.env_key.slice(0, 16) === n).map((u) => u.name);
    return {
      key: n,
      path: dir,
      ok: Boolean(m.ok),
      building: Boolean(m.building) && fs.existsSync(lockOf(dir)),
      name: m.name || null,
      tool: m.tool || null,
      reason: m.reason || null,
      built_at: m.built_at || null,
      build_ms: m.ms || null,
      last_used: used,
      files: m.files || [],
      used_by: users,
      ...(sizes ? { size_bytes: sizeOf(dir), size: human(sizeOf(dir)) } : {}),
      ...(m.failure ? { failure: { cmd: m.failure.cmd, code: m.failure.code, tail: m.failure.tail, at: m.finished_at || null } } : {}),
    };
  }).sort((a, b) => String(b.last_used || b.built_at || '').localeCompare(String(a.last_used || a.built_at || '')));
}

// Remove old envs: keep the newest `keep` (by last use, built ones), and also every env a worktree
// still uses and any being built. Returns { kept, removed: [{ key, size }] }.
function gc(root, { keep = KEEP() } = {}) {
  const all = list(root, { sizes: true });
  const kept = [];
  const removed = [];
  let n = 0;
  for (const x of all) {
    const busy = fs.existsSync(lockOf(x.path));
    const inUse = x.used_by.length > 0;
    const recent = x.ok && n < keep;
    if (x.ok) n += 1;
    if (busy || inUse || recent) {
      kept.push({ key: x.key, size: x.size, ...(inUse ? { used_by: x.used_by } : {}) });
      continue;
    }
    // a failed build's record is kept while it is the newest thing there is (status shows it)
    if (!x.ok && x === all[0]) {
      kept.push({ key: x.key, size: x.size, failed: true });
      continue;
    }
    fs.rmSync(x.path, { recursive: true, force: true });
    removed.push({ key: x.key, size: x.size });
  }
  const bytes = removed.reduce((sum, r) => sum + ((all.find((a) => a.key === r.key) || {}).size_bytes || 0), 0);
  return { kept, removed, freed: human(bytes) };
}

module.exports = { touch, STORE, LAST, OVERLAY, KEEP, dirOf, keyOf, keyFiles, readMarker, healthy, ensureShared, overlay, pythonOverlay, nodeOverlay, worktreeUses, list, gc, sizeOf, human, redact, machineId, stage };
