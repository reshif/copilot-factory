'use strict';
// Small, dependency-free helpers shared by the CLI and the hooks.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class FactoryError extends Error {
  constructor(message, code = 'error', details = undefined) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function fail(message, code = 'error', details) {
  throw new FactoryError(message, code, details);
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function shortHash(h) {
  return h ? String(h).slice(0, 12) : null;
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

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
  } catch (e) {
    fail(`Invalid JSON in ${p}: ${e.message}`, 'invalid_json');
  }
}

// Atomic write: write to a temp file in the same directory, then rename.
function writeText(p, text) {
  mkdirp(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

function writeJson(p, obj) {
  writeText(p, JSON.stringify(obj, null, 2) + '\n');
}

function appendJsonl(p, obj) {
  mkdirp(path.dirname(p));
  fs.appendFileSync(p, JSON.stringify(obj) + '\n');
}

function readJsonl(p) {
  const t = readText(p, '');
  const out = [];
  for (const line of t.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn final line (crash mid-append) is skipped, never fatal.
    }
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function hashFile(p) {
  const t = readText(p, null);
  return t === null ? null : sha256(t);
}

function hashFiles(paths) {
  // Order-independent combined hash of several files; missing files hash as "-".
  const parts = [...paths].sort().map((p) => `${path.basename(p)}:${hashFile(p) || '-'}`);
  return sha256(parts.join('\n'));
}

function uniq(arr) {
  return [...new Set(arr)];
}

// Deterministic JSON (sorted keys), matching what JSON.stringify keeps:
// undefined object values are dropped, undefined array items become null.
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined && typeof v[k] !== 'function')
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function deepMerge(base, over) {
  if (Array.isArray(over)) return over.slice();
  if (over && typeof over === 'object') {
    const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
    for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return over === undefined ? base : over;
}

module.exports = {
  FactoryError,
  fail,
  sha256,
  shortHash,
  exists,
  mkdirp,
  readText,
  readJson,
  writeText,
  writeJson,
  appendJsonl,
  readJsonl,
  nowIso,
  hashFile,
  hashFiles,
  uniq,
  stableStringify,
  deepMerge,
};
