'use strict';
// Temporary directories for tests that clean up after themselves. Every directory made here is
// removed when its test ends (t.after, when a test context is given) and, whatever happens, when
// the test process exits (one node --test child per file), so a suite run leaves nothing in the
// system temp dir. Read-only trees (.factory/deps is unpacked read-only) are made writable first.
//
//   const { mkdtemp } = require('./helpers/tmp');
//   const dir = mkdtemp('factory-x-');        // removed at process exit
//   const dir = mkdtemp('factory-x-', t);     // removed when test t ends (and at exit)

const fs = require('fs');
const os = require('os');
const path = require('path');

const made = new Set();

function writable(p) {
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
    let names = [];
    try {
      names = fs.readdirSync(p);
    } catch {
      names = [];
    }
    for (const n of names) writable(path.join(p, n));
  }
}

// Remove a tree, read-only parts included. Never throws.
function remove(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    writable(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      /* best effort */
    }
  }
  made.delete(dir);
}

function cleanupAll() {
  for (const d of [...made]) remove(d);
}

let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', cleanupAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      cleanupAll();
      process.exit(128 + (os.constants.signals[sig] || 1));
    });
  }
}

// fs.mkdtempSync under the system temp dir, registered for cleanup.
function mkdtemp(prefix = 'factory-test-', t = null) {
  hook();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  if (t && typeof t.after === 'function') t.after(() => remove(dir));
  return dir;
}

// A path that is registered for cleanup without being created (a test creates it itself).
function track(dir) {
  hook();
  made.add(dir);
  return dir;
}

module.exports = { mkdtemp, track, remove, cleanupAll, made };
