'use strict';
// Dependency source for agents (0.10.0, "critics with evidence"): the job's pinned packages,
// downloaded by the CLI and unpacked READ-ONLY under .factory/deps/<job>/, so researchers,
// option generators, the architect and the critics can read the library code the design will
// call instead of designing from memory.
//
//   factory deps fetch [--add pypi:name==1.2.3,npm:name@1.2.3]
//   factory deps show
//   factory deps check --file ledger.json     (an API ledger's quotes against the fetched source)
//
// Nothing downloaded is ever executed:
//   - Python: `pip download --no-deps --only-binary=:all:` (a wheel is a zip; an sdist would
//     run its build backend just to read its metadata, so sdists are never fetched),
//   - Node:   `npm pack <name>@<version> --ignore-scripts` (a registry tarball, no lifecycle
//     scripts),
//   - Go:     `go mod download -json <module>@<version>` (module zips are plain source).
// The archives are unpacked by this file (zip and tar.gz readers below), never by a tool that
// could run code; entries that climb out (absolute, "..") and links are skipped, and sizes are
// capped. The unpacked trees are chmod'ed read-only. .factory/ is already git-excluded.
//
// Which packages: the versions clarify settled (pins the human confirmed at H1), the ones ground
// or the planner asked for (deps.request.json, CLI-written), and the repository's direct
// dependencies the contract names. A version that is a range is resolved from the lockfile.
// A failed download (no network, no wheel, a private index) is recorded as a GAP, shown to the
// agents and at the design gate; it never parks the job.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { readJson, writeJson, exists, nowIso, sha256, stableStringify, fail } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const { seal, valid } = require('../lib/seal');

const ECOSYSTEMS = ['pypi', 'npm', 'go'];
const DEFAULTS = {
  enabled: true,
  max_packages: 20,
  max_unpacked_mb: 200,
  max_files: 20000,
  timeout_seconds: 180,
  fetch: {
    pypi: 'python3 -m pip download --no-deps --only-binary=:all: --disable-pip-version-check --no-input -q -d {dest} {name}=={version}',
    npm: 'npm pack {name}@{version} --pack-destination {dest} --ignore-scripts --silent --no-audit --no-fund',
    go: 'GOFLAGS=-mod=mod GOMODCACHE={dest}/gomodcache go mod download -json {name}@{version}',
  },
};

const DIR = (root, jobId) => path.join(root, '.factory', 'deps', jobId);
const MANIFEST = (root, jobId) => path.join(DIR(root, jobId), 'deps.json');
const REQUEST = (root, jobId) => path.join(jobPaths(root, jobId).dir, 'deps.request.json');
const LEDGER = (root, jobId) => path.join(jobPaths(root, jobId).dir, 'api-ledger.json');

function settings(root, state) {
  let live = {};
  try {
    live = (require('./policy').load(root) || {}).deps || {};
  } catch {
    live = {};
  }
  const snap = (state && state.policy && state.policy.deps) || {};
  const s = { ...DEFAULTS, ...live, ...snap };
  s.fetch = { ...DEFAULTS.fetch, ...(live.fetch || {}), ...(snap.fetch || {}) };
  // FACTORY_DEPS_FETCH_<ECO> overrides the command (the test suite's fake index, a mirror)
  for (const e of ECOSYSTEMS) if (process.env[`FACTORY_DEPS_FETCH_${e.toUpperCase()}`]) s.fetch[e] = process.env[`FACTORY_DEPS_FETCH_${e.toUpperCase()}`];
  return s;
}

// ---------------------------------------------------------------- names and versions

// Names and versions go into shell commands: only plain ones.
const SAFE_NAME = /^@?[A-Za-z0-9][A-Za-z0-9._~-]*(\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/;
const SAFE_VERSION = /^v?[0-9][A-Za-z0-9.+_-]*$/;
const EXACT = /^v?\d+(\.\d+)*([.+_-]?[A-Za-z0-9.]+)*$/; // 1.2.3, 2.4.3rc1, v1.2.0, 1.2.3+local
const isExact = (v) => typeof v === 'string' && EXACT.test(v.trim()) && !/[x*]$/i.test(v.trim()) && !/^[<>=~^!]/.test(v.trim());

const keyOf = (p) => `${p.ecosystem}:${String(p.name).toLowerCase()}`;
const dirName = (p) => `${String(p.name).replace(/^@/, '').replace(/[/@\\]/g, '_')}-${p.version}`;

// "pypi:nautobot==2.4.3", "npm:left-pad@1.3.0", "go:golang.org/x/text@v0.14.0"
function parseSpec(s) {
  const t = String(s || '').trim();
  const m = /^(pypi|npm|go):(.+)$/i.exec(t);
  if (!m) return null;
  const eco = m[1].toLowerCase();
  const rest = m[2].trim();
  let name;
  let version;
  if (eco === 'pypi') [name, version] = rest.split('==');
  else {
    const i = rest.lastIndexOf('@');
    if (i <= 0) return null;
    name = rest.slice(0, i);
    version = rest.slice(i + 1);
  }
  if (!name || !version) return null;
  return { ecosystem: eco, name: name.trim(), version: version.trim() };
}

// ---------------------------------------------------------------- what the repository pins

function readFile(root, f) {
  try {
    return fs.readFileSync(path.join(root, f), 'utf8');
  } catch {
    return null;
  }
}

// Direct dependencies the repository declares, with an exact version when it has one (from the
// manifest, else its lockfile): [{ ecosystem, name, version|null, source }].
function repoDeps(root) {
  const out = [];
  const add = (ecosystem, name, version, source) => {
    if (!name) return;
    if (out.some((x) => x.ecosystem === ecosystem && x.name.toLowerCase() === name.toLowerCase())) return;
    out.push({ ecosystem, name, version: version && isExact(version) ? version : null, source });
  };
  // Python
  const lock = {};
  for (const lf of ['poetry.lock', 'uv.lock']) {
    const t = readFile(root, lf);
    if (!t) continue;
    for (const m of t.matchAll(/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g)) lock[m[1].toLowerCase()] = m[2];
  }
  const reqs = fs.existsSync(root) ? fs.readdirSync(root).filter((f) => /^requirements[\w.-]*\.txt$/.test(f)) : [];
  for (const f of reqs) {
    const t = readFile(root, f) || '';
    t.split('\n').forEach((l, i) => {
      const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(==\s*([0-9][^\s;#,]*))?/.exec(l);
      if (m && !/^\s*-/.test(l)) add('pypi', m[1], m[4] || lock[m[1].toLowerCase()] || null, `${f}:${i + 1}`);
    });
  }
  const py = readFile(root, 'pyproject.toml');
  if (py) {
    const lines = py.split('\n');
    let section = '';
    lines.forEach((l, i) => {
      const h = /^\s*\[([^\]]+)\]\s*$/.exec(l);
      if (h) {
        section = h[1].trim();
        return;
      }
      if (/^tool\.poetry\.(dev-)?dependencies$|^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section)) {
        const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)")/.exec(l);
        if (m && m[1].toLowerCase() !== 'python') add('pypi', m[1], (m[2] || m[3] || '').replace(/^==/, '') || lock[m[1].toLowerCase()] || null, `pyproject.toml:${i + 1}`);
        return;
      }
      for (const q of l.matchAll(/"([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(?:(==)\s*([0-9][^",;\s]*)|[<>~!=^][^"]*)?\s*(?:;[^"]*)?"/g)) {
        if (!/dependencies|requires|optional-dependencies/.test(section) && !/dependencies\s*=/.test(l)) continue;
        add('pypi', q[1], q[4] || lock[q[1].toLowerCase()] || null, `pyproject.toml:${i + 1}`);
      }
    });
  }
  // Node
  const pkg = readFile(root, 'package.json');
  if (pkg) {
    let p = {};
    let pl = {};
    try {
      p = JSON.parse(pkg);
    } catch {
      p = {};
    }
    try {
      pl = JSON.parse(readFile(root, 'package-lock.json') || '{}');
    } catch {
      pl = {};
    }
    for (const [name, spec] of Object.entries({ ...(p.dependencies || {}), ...(p.devDependencies || {}), ...(p.peerDependencies || {}) })) {
      const locked = pl.packages && pl.packages[`node_modules/${name}`] && pl.packages[`node_modules/${name}`].version;
      const v = isExact(String(spec)) ? String(spec) : locked || (pl.dependencies && pl.dependencies[name] && pl.dependencies[name].version) || null;
      add('npm', name, v, 'package.json');
    }
  }
  // Go
  const gomod = readFile(root, 'go.mod');
  if (gomod) {
    let inBlock = false;
    gomod.split('\n').forEach((l, i) => {
      if (/^\s*require\s*\(\s*$/.test(l)) {
        inBlock = true;
        return;
      }
      if (inBlock && /^\s*\)\s*$/.test(l)) {
        inBlock = false;
        return;
      }
      const m = inBlock ? /^\s*([\w.~/-]+)\s+(v[\w.+-]+)/.exec(l) : /^\s*require\s+([\w.~/-]+)\s+(v[\w.+-]+)/.exec(l);
      if (m) add('go', m[1], m[2], `go.mod:${i + 1}`);
    });
  }
  return out;
}

// Which ecosystem a pinned system belongs to: the repository's manifests first, then the words
// around it (the pin's quote, the contract).
function inferEcosystem(system, repo, text) {
  const s = String(system || '').toLowerCase();
  const hit = repo.find((d) => d.name.toLowerCase() === s);
  if (hit) return hit.ecosystem;
  const t = String(text || '');
  if (/\bpip\b|\bpypi\b|python|django|pytest|poetry|pyproject|requirements\.txt|\bnautobot\b/i.test(t)) return 'pypi';
  if (/\bnpm\b|node\.?js|package\.json|typescript|javascript|\byarn\b|\bpnpm\b/i.test(t)) return 'npm';
  if (/\bgo\.mod\b|golang|\bgo module/i.test(t)) return 'go';
  return null;
}

function readRequest(root, jobId) {
  const r = readJson(REQUEST(root, jobId), null);
  return r && Array.isArray(r.packages) ? r.packages : [];
}

// Add packages ground or the planner asked for (CLI-written; agents never write it).
function addRequest(root, jobId, specs, from) {
  const cur = readRequest(root, jobId);
  const added = [];
  for (const s of specs || []) {
    const p = typeof s === 'string' ? parseSpec(s) : s && ECOSYSTEMS.includes(s.ecosystem) && s.name ? { ecosystem: s.ecosystem, name: String(s.name), version: s.version ? String(s.version) : null } : null;
    if (!p || !SAFE_NAME.test(p.name)) continue;
    if (cur.some((x) => keyOf(x) === keyOf(p) && (x.version || null) === (p.version || null))) continue;
    const entry = { ...p, from: from || 'request', at: nowIso() };
    cur.push(entry);
    added.push(entry);
  }
  if (added.length) writeJson(REQUEST(root, jobId), { version: 1, packages: cur });
  return added;
}

// The packages this job reads: [{ ecosystem, name, version|null, from }], deduplicated, capped.
function wanted(root, state) {
  const S = settings(root, state);
  const repo = repoDeps(root);
  let contractText = '';
  try {
    contractText = require('./contract').read(root, state.id) || '';
  } catch {
    contractText = '';
  }
  const out = [];
  const push = (p) => {
    if (!p || !p.ecosystem || !p.name) return;
    if (out.some((x) => keyOf(x) === keyOf(p))) return;
    let version = p.version && isExact(String(p.version)) ? String(p.version).trim() : null;
    if (!version) {
      const r = repo.find((d) => keyOf(d) === keyOf(p));
      version = r && r.version ? r.version : null;
    }
    out.push({ ecosystem: p.ecosystem, name: p.name, version, from: p.from, ...(p.range ? { range: p.range } : {}) });
  };
  for (const r of readRequest(root, state.id)) push({ ...r, from: r.from || 'request' });
  // clarify's pins: the versions the human confirmed at H1
  try {
    const C = require('./clarify');
    const data = C.load(root, state.id);
    for (const it of (data && data.items) || []) {
      if (it.kind !== 'pin' || it.status !== 'decided' || !it.value || !it.system) continue;
      const eco = inferEcosystem(it.system, repo, `${(it.source && it.source.quote) || ''}\n${contractText}`);
      push({ ecosystem: eco || 'unknown', name: it.system, version: it.value, from: `clarify pin ${it.id}`, ...(isExact(it.value) ? {} : { range: it.value }) });
    }
  } catch {
    /* no clarify record */
  }
  // the repository's direct dependencies the contract names
  for (const d of repo) {
    if (d.name.length < 3) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9_-])${d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i');
    if (re.test(contractText)) push({ ...d, from: `${d.source} (named in the contract)` });
  }
  return out.slice(0, Math.max(0, S.max_packages));
}

function pinsHash(root, state) {
  return sha256(stableStringify(wanted(root, state).map((p) => [keyOf(p), p.version])));
}

// ---------------------------------------------------------------- archives (no tool runs them)

function safeRel(name) {
  const n = String(name).replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!n || n.includes('\0') || n.startsWith('/') || /^[A-Za-z]:/.test(n)) return null;
  const parts = n.split('/').filter((x) => x && x !== '.');
  if (parts.some((x) => x === '..')) return null;
  return parts.join('/');
}

class Limits {
  constructor(maxBytes, maxFiles) {
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.bytes = 0;
    this.files = 0;
  }
  take(n) {
    this.bytes += n;
    this.files += 1;
    if (this.bytes > this.maxBytes) throw new Error(`unpacked size over ${Math.round(this.maxBytes / 1048576)} MB`);
    if (this.files > this.maxFiles) throw new Error(`more than ${this.maxFiles} files`);
  }
}

function writeEntry(destDir, rel, data, lim) {
  lim.take(data.length);
  const out = path.join(destDir, rel);
  if (!out.startsWith(destDir + path.sep)) return;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
}

// A zip (wheel, Go module zip): stored and deflated entries; links and zip64 are refused.
function unzip(buf, destDir, lim) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 archives are not supported');
  let n = 0;
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    const mode = (attrs >>> 16) & 0o170000;
    if (name.endsWith('/') || mode === 0o040000) continue;
    if (mode === 0o120000) continue; // a symlink: skipped
    const rel = safeRel(name);
    if (!rel) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.slice(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) continue; // another compression: skipped
    writeEntry(destDir, rel, data, lim);
    n += 1;
  }
  return n;
}

// A tar.gz (npm pack, an sdist someone else downloaded): regular files only.
function untgz(buf, destDir, lim) {
  const tar = zlib.gunzipSync(buf);
  let p = 0;
  let n = 0;
  let longName = null;
  let paxPath = null;
  const str = (a, b) => tar.slice(a, b).toString('utf8').replace(/\0.*$/s, '');
  while (p + 512 <= tar.length) {
    const h = tar.slice(p, p + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(str(p + 124, p + 136).trim() || '0', 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(p + 345, p + 500);
    let name = str(p, p + 100);
    if (prefix && tar.slice(p + 257, p + 262).toString() === 'ustar') name = `${prefix}/${name}`;
    const body = tar.slice(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === 'g') continue;
    const full = paxPath || longName || name;
    paxPath = null;
    longName = null;
    if (type !== '0' && type !== '\0' && type !== '7') continue; // dirs, links, devices: skipped
    const rel = safeRel(full);
    if (!rel) continue;
    writeEntry(destDir, rel, body, lim);
    n += 1;
  }
  return n;
}

function unpack(file, destDir, S) {
  const lim = new Limits(S.max_unpacked_mb * 1048576, S.max_files);
  const buf = fs.readFileSync(file);
  fs.mkdirSync(destDir, { recursive: true });
  if (/\.(whl|zip)$/i.test(file)) return unzip(buf, destDir, lim);
  if (/\.(tgz|tar\.gz)$/i.test(file)) return untgz(buf, destDir, lim);
  throw new Error(`cannot unpack ${path.basename(file)} (only wheels, zips and .tgz)`);
}

// Read-only: files 0444, directories 0555 (after their contents).
function setReadOnly(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(p)) setReadOnly(path.join(p, n));
    fs.chmodSync(p, 0o555);
  } else fs.chmodSync(p, 0o444);
}

function makeWritable(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    try {
      fs.chmodSync(p, 0o755);
    } catch {
      /* not ours */
    }
    for (const n of fs.readdirSync(p)) makeWritable(path.join(p, n));
  }
}

// Remove a tree the CLI made read-only.
function removeTree(p) {
  if (!exists(p)) return;
  makeWritable(p);
  fs.rmSync(p, { recursive: true, force: true });
}

// ---------------------------------------------------------------- fetching

function fetchOne(root, state, p, S) {
  const base = { ecosystem: p.ecosystem, name: p.name, version: p.version, from: p.from };
  const gap = (reason) => ({ ...base, status: 'gap', reason: String(reason).slice(0, 400), at: nowIso() });
  if (!ECOSYSTEMS.includes(p.ecosystem)) return gap(`unknown ecosystem for "${p.name}": the CLI could not tell whether it is a Python, Node or Go package`);
  if (!p.version) return gap(`no exact version for ${p.name}${p.range ? ` (only "${p.range}")` : ''}: nothing pins it and no lockfile resolves it`);
  if (!SAFE_NAME.test(p.name) || !SAFE_VERSION.test(p.version)) return gap(`"${p.name} ${p.version}" is not a plain package name and version`);
  const jobDir = DIR(root, state.id);
  const work = path.join(jobDir, `.work-${process.pid}-${Date.now()}`);
  const dest = path.join(work, 'dl');
  const cwd = path.join(work, 'cwd'); // an empty directory: nothing in it can be imported
  fs.mkdirSync(dest, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const cmd = S.fetch[p.ecosystem].replace(/\{dest\}/g, `'${dest}'`).replace(/\{name\}/g, p.name).replace(/\{version\}/g, p.version);
    const r = spawnSync('bash', ['-c', cmd], {
      cwd,
      encoding: 'utf8',
      timeout: S.timeout_seconds * 1000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PIP_NO_INPUT: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', GOFLAGS: '-mod=mod', GOTOOLCHAIN: 'local' },
    });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    if (r.error && r.error.code === 'ETIMEDOUT') return gap(`download timed out after ${S.timeout_seconds}s`);
    if (r.status !== 0) return gap(`download failed (exit ${r.status === null ? 'killed' : r.status}): ${out.split('\n').slice(-3).join(' ').slice(-300) || 'no output'}`);
    let archive = null;
    if (p.ecosystem === 'go') {
      try {
        const j = JSON.parse(r.stdout);
        archive = j.Zip || null;
      } catch {
        archive = null;
      }
    }
    if (!archive) {
      const files = fs.readdirSync(dest).filter((f) => /\.(whl|zip|tgz|tar\.gz)$/i.test(f));
      archive = files.length ? path.join(dest, files[0]) : null;
    }
    if (!archive || !exists(archive)) return gap(`the download produced no wheel, zip or .tgz (${p.ecosystem === 'pypi' ? 'sdist-only packages are not fetched: building one runs its code' : 'nothing to read'})`);
    const target = path.join(jobDir, p.ecosystem, dirName(p));
    removeTree(target);
    let files;
    try {
      files = unpack(archive, target, S);
    } catch (e) {
      removeTree(target);
      return gap(`could not unpack ${path.basename(archive)}: ${e.message}`);
    }
    setReadOnly(target);
    return { ...base, status: 'fetched', path: path.relative(root, target).replace(/\\/g, '/'), archive: path.basename(archive), files, at: nowIso() };
  } finally {
    removeTree(work);
  }
}

function loadManifest(root, jobId) {
  const m = readJson(MANIFEST(root, jobId), null);
  if (!m || !valid(m)) return { version: 1, packages: [] };
  return m;
}

// `factory deps fetch`: fetch what is wanted and not fetched yet. Never fails on a download:
// each failure is a gap in the manifest and the step record.
function fetch(root, { jobId, add = [] } = {}) {
  const job = require('./job');
  const state = job.resolve(root, jobId);
  if (add.length) addRequest(root, state.id, add, 'factory deps fetch --add');
  const S = settings(root, state);
  const want = S.enabled === false ? [] : wanted(root, state);
  const prev = loadManifest(root, state.id);
  fs.mkdirSync(DIR(root, state.id), { recursive: true });
  const packages = [];
  for (const p of want) {
    const old = prev.packages.find((x) => keyOf(x) === keyOf(p) && x.version === p.version && x.status === 'fetched' && x.path && exists(path.join(root, x.path)));
    packages.push(old || fetchOne(root, state, p, S));
  }
  const doc = seal({ version: 1, job: state.id, at: nowIso(), packages });
  writeJson(MANIFEST(root, state.id), doc);
  const fetched = packages.filter((p) => p.status === 'fetched');
  const gaps = packages.filter((p) => p.status === 'gap');
  const ledger = require('./ledger');
  ledger.append(root, state.id, { kind: 'step', step: 'deps', ok: true, bound: { pins: pinsHash(root, state) }, detail: { fetched: fetched.map((p) => `${p.ecosystem}:${p.name}@${p.version}`), gaps: gaps.map((p) => ({ package: `${p.ecosystem}:${p.name}${p.version ? `@${p.version}` : ''}`, reason: p.reason })), skipped: S.enabled === false } });
  try {
    require('./events').append(root, { event: 'deps_fetch', job: state.id, fetched: fetched.length, gaps: gaps.length });
  } catch {
    /* the log is a convenience */
  }
  return {
    job: state.id,
    dir: DIR(root, state.id),
    packages: packages.map((p) => ({ package: `${p.ecosystem}:${p.name}${p.version ? `@${p.version}` : ''}`, status: p.status, ...(p.path ? { path: p.path, files: p.files } : {}), ...(p.reason ? { reason: p.reason } : {}), from: p.from })),
    gaps: gaps.length,
    message: S.enabled === false
      ? 'Dependency source is off (policy deps.enabled: false).'
      : want.length
        ? `${fetched.length} package(s) readable under ${path.relative(root, DIR(root, state.id))}${gaps.length ? `; ${gaps.length} gap(s), shown to the agents and at the design gate (not a stop)` : ''}.`
        : 'No pinned package to fetch.',
  };
}

function show(root, { jobId } = {}) {
  const state = require('./job').resolve(root, jobId);
  const m = loadManifest(root, state.id);
  return { job: state.id, dir: DIR(root, state.id), wanted: wanted(root, state), packages: m.packages, ledger: readLedger(root, state.id) };
}

// The fetched packages, for briefs and the runner's read dirs.
function fetched(root, jobId) {
  return loadManifest(root, jobId).packages.filter((p) => p.status === 'fetched' && p.path && exists(path.join(root, p.path)));
}
function gaps(root, jobId) {
  return loadManifest(root, jobId).packages.filter((p) => p.status === 'gap');
}

// What a researcher, option generator, architect or critic is told.
function briefText(root, state) {
  const have = fetched(root, state.id);
  const miss = gaps(root, state.id);
  if (!have.length && !miss.length) return '';
  return [
    `- Dependency source (fetched by the CLI for the pinned versions, unpacked read-only under ${DIR(root, state.id)}; read it with view/rg, never install, import from or execute it):`,
    ...have.map((p) => `  - ${p.ecosystem}:${p.name} ${p.version} — ${path.join(root, p.path)}`),
    ...miss.map((p) => `  - GAP ${p.ecosystem}:${p.name}${p.version ? ` ${p.version}` : ''} — no source: ${p.reason}. A claim about it is UNVERIFIED unless the repository shows it.`),
  ].join('\n');
}

// ---------------------------------------------------------------- the API ledger

const normLine = (s) => String(s).replace(/\s+/g, ' ').trim();

// Each quoted fact against the fetched source: the file must be inside a fetched package of
// the version claimed, and the quote must be at the cited line (whitespace aside; a quote may
// be part of a line, or several lines). { verified: [...], rejected: [{ entry, why }] }.
function checkLedger(root, state, entries) {
  const pkgs = fetched(root, state.id);
  const verified = [];
  const rejected = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const why = (() => {
      if (!e || typeof e !== 'object') return 'not an object';
      if (!e.symbol || !e.file || !e.quote) return 'needs symbol, file, line and quote';
      const abs = path.resolve(root, String(e.file));
      const pkg = pkgs.find((p) => abs.startsWith(path.join(root, p.path) + path.sep));
      if (!pkg) return `${e.file} is not inside a fetched package (${pkgs.map((p) => p.path).join(', ') || 'none fetched'})`;
      if (e.version && String(e.version).replace(/^v/, '') !== String(pkg.version).replace(/^v/, '')) return `version ${e.version} is not the fetched ${pkg.name} ${pkg.version}`;
      let lines;
      try {
        lines = fs.readFileSync(abs, 'utf8').split('\n');
      } catch {
        return `${e.file} does not exist`;
      }
      const L = Number(e.line);
      if (!Number.isInteger(L) || L < 1 || L > lines.length) return `line ${e.line} is not in ${e.file} (${lines.length} lines)`;
      const q = String(e.quote).split('\n').map(normLine).filter(Boolean);
      if (!q.length) return 'the quote is empty';
      for (let i = 0; i < q.length; i++) {
        const at = lines[L - 1 + i];
        if (at === undefined || !normLine(at).includes(q[i])) return `the quote is not at ${e.file}:${L + i} (that line reads: "${normLine(at || '').slice(0, 160)}")`;
      }
      e._pkg = pkg;
      return null;
    })();
    if (why) rejected.push({ entry: e, why });
    else {
      const pkg = e._pkg;
      delete e._pkg;
      verified.push({ symbol: String(e.symbol), package: `${pkg.ecosystem}:${pkg.name}`, version: pkg.version, file: path.relative(root, path.resolve(root, String(e.file))).replace(/\\/g, '/'), line: Number(e.line), quote: String(e.quote), ...(e.behaviour ? { behaviour: String(e.behaviour) } : {}) });
    }
  }
  return { verified, rejected };
}

// The sealed ledger ground recorded: { entries: [{ id: 'L-1', … }], rejected: [...] }.
function writeLedger(root, state, verified, rejected, bound = {}) {
  const entries = verified.map((v, i) => ({ id: `L-${i + 1}`, ...v }));
  const doc = seal({ version: 1, job: state.id, at: nowIso(), entries, rejected: rejected.map((r) => ({ symbol: r.entry && r.entry.symbol, file: r.entry && r.entry.file, line: r.entry && r.entry.line, why: r.why })), ...bound });
  writeJson(LEDGER(root, state.id), doc);
  return doc;
}

function readLedger(root, jobId) {
  const d = readJson(LEDGER(root, jobId), null);
  if (!d || !valid(d)) return null;
  return d;
}

// `factory deps check --file f`: what checkLedger says, for a researcher checking its own quotes
// before it returns and for factory run's ground step. Changes nothing.
function checkFile(root, { jobId, file }) {
  const state = require('./job').resolve(root, jobId);
  if (!file) fail('deps check --file <ledger.json>', 'bad_input');
  const v = readJson(path.resolve(file), null);
  const entries = Array.isArray(v) ? v : v && Array.isArray(v.ledger) ? v.ledger : v && Array.isArray(v.entries) ? v.entries : null;
  if (!entries) fail(`No ledger list in ${file} (a JSON list, or {"ledger": [...]})`, 'bad_input');
  const r = checkLedger(root, state, entries);
  return { job: state.id, ok: r.rejected.length === 0, verified: r.verified.length, rejected: r.rejected.map((x) => ({ symbol: x.entry && x.entry.symbol, file: x.entry && x.entry.file, line: x.entry && x.entry.line, ...(x.entry && x.entry.probe ? { probe: x.entry.probe } : {}), why: x.why })) };
}

// A closed job's source is removed (it is a cache).
function cleanup(root, jobId) {
  removeTree(DIR(root, jobId));
}

module.exports = { DEFAULTS, ECOSYSTEMS, DIR, MANIFEST, REQUEST, LEDGER, settings, parseSpec, repoDeps, inferEcosystem, wanted, pinsHash, addRequest, readRequest, fetch, fetchOne, show, fetched, gaps, briefText, checkLedger, writeLedger, readLedger, checkFile, cleanup, unzip, untgz, unpack, safeRel, setReadOnly, removeTree, isExact };
