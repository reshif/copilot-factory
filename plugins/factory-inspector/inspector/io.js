'use strict';
// Reading the factory's records — independently. Nothing here imports the factory's
// code: the file layout and the seal format are the contract, and this module has its
// own implementation of both, so a bug in the factory can't hide itself from the audit.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function readText(p, fallback = null) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return fallback;
  }
}

function readJson(p, fallback = null) {
  const t = readText(p, null);
  if (t === null) return fallback;
  try {
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

function sha256(x) {
  return crypto.createHash('sha256').update(x).digest('hex');
}

// Same canonical form the factory signs: sorted keys, undefined dropped (as JSON does).
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined && typeof v[k] !== 'function')
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

let secretCache;
function secret() {
  if (secretCache !== undefined) return secretCache;
  const f = process.env.FACTORY_SECRET_FILE || path.join(os.homedir(), '.config', 'software-factory', 'secret');
  secretCache = (readText(f, '') || '').trim() || null;
  return secretCache;
}

// true / false, or null when there is no secret to check against.
function sealOk(obj) {
  const key = secret();
  if (!key) return null;
  if (!obj || typeof obj.seal !== 'string') return false;
  const { seal, ...rest } = obj;
  const want = crypto.createHmac('sha256', key).update(canonical(rest)).digest('hex');
  return want.length === seal.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(seal));
}

// Every line, with its line number and whether its seal holds.
function readLog(p) {
  const out = [];
  const t = readText(p, '');
  t.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch {
      out.push({ line: i + 1, rec: null, sealed: false, torn: true });
      return;
    }
    out.push({ line: i + 1, rec, sealed: sealOk(rec) !== false });
  });
  return out;
}

function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.factory', 'project.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function layout(root) {
  const f = path.join(root, '.factory');
  return {
    jobs: path.join(f, 'jobs'),
    events: path.join(f, 'log', 'events.jsonl'),
    decisions: path.join(f, 'log', 'decisions.jsonl'),
    inspect: path.join(f, 'inspect'),
    register: path.join(f, 'inspect', 'register.json'),
    config: path.join(f, 'inspect', 'config.json'),
    hookErrors: path.join(f, 'inspect', 'hook-errors.jsonl'), // the inspector's own hook failures (unsealed: its own file)
    job: (id) => ({
      dir: path.join(f, 'jobs', id),
      state: path.join(f, 'jobs', id, 'state.json'),
      lock: path.join(f, 'jobs', id, 'recipe.lock.json'),
      ledger: path.join(f, 'jobs', id, 'ledger.jsonl'),
    }),
  };
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = { readText, readJson, writeJson, sha256, canonical, sealOk, readLog, findRoot, layout, nowIso, secret };
