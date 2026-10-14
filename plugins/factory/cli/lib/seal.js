'use strict';
// Seals: an HMAC over everything the floors trust (ledger entries, approvals, waivers,
// CI results), keyed by a per-user secret kept outside the repository, at
// ~/.config/software-factory/secret (mode 0600). Records written by hand — e.g. an agent
// editing state.json or appending to ledger.jsonl — carry no valid seal and are ignored.
//
// This is defence in depth, not a sandbox: a process running as you can read your files.
// The guard hook also blocks agents from touching the secret, inline interpreters that
// reach into factory internals, and TTY fakers; CI re-verify and your own merge remain
// the final backstop.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { stableStringify } = require('./util');

function secretFile() {
  return process.env.FACTORY_SECRET_FILE || path.join(os.homedir(), '.config', 'software-factory', 'secret');
}

let cached = null;
function secret() {
  if (cached) return cached;
  const f = secretFile();
  try {
    cached = fs.readFileSync(f, 'utf8').trim();
  } catch {
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const fresh = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(f, fresh + '\n', { mode: 0o600, flag: 'wx' });
      cached = fresh;
    } catch {
      cached = fs.readFileSync(f, 'utf8').trim(); // another process created it first
    }
  }
  return cached;
}

function sign(obj) {
  const { seal: _s, ...rest } = obj || {};
  return crypto.createHmac('sha256', secret()).update(stableStringify(rest)).digest('hex');
}

function seal(obj) {
  return { ...obj, seal: sign(obj) };
}

function valid(obj) {
  if (!obj || typeof obj.seal !== 'string') return false;
  const want = sign(obj);
  return want.length === obj.seal.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(obj.seal));
}

module.exports = { secretFile, seal, valid, sign };
