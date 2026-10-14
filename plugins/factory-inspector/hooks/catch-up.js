'use strict';
// agentStop catch-up: jobs also end outside the agent's shell — a "cancel job" or
// "merged <sha>" reply applied by the factory's prompt hook, or a command you ran in your
// own terminal — and postToolUse never sees those. If any ended job hasn't been inspected
// at its current status, inspect it.
//
// Cheap and fast: hooks run synchronously and every agentStop (each stop-gate continuation
// too) waits for this one, so the hook itself only does the pending() check (a few small
// reads). An inspection, when one is due, runs in a detached background process
// (`catch-up.js --background <root>`), one at a time (.factory/inspect/catch-up.lock).
// Never blocks: Copilot's agentStop honours only decision/reason (hooks.md §5.5), so the
// result goes to the register and the one-line summary is kept for the next hook that can
// show it: the next prompt (prompt.js), an after-close report, or the next session start.

const fs = require('fs');
const path = require('path');

function lockFile(root) {
  return path.join(root, '.factory', 'inspect', 'catch-up.lock');
}

function running(root) {
  try {
    const l = JSON.parse(fs.readFileSync(lockFile(root), 'utf8'));
    if (Date.now() - Date.parse(l.at) > 10 * 60 * 1000) return false; // stale
    process.kill(l.pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

if (process.argv[2] === '--background') {
  // The detached inspection: one run, its summary stashed for the next hook that can show it.
  const root = process.argv[3];
  const { stashUnreported } = require('./lib');
  try {
    fs.mkdirSync(path.dirname(lockFile(root)), { recursive: true });
    fs.writeFileSync(lockFile(root), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const main = require('../inspector/main');
    if (main.pending(root).length) {
      const line = main.summary(main.run(root, {}));
      if (line) stashUnreported(root, line);
    }
  } catch {
    /* the next session start or after-close inspects it */
  } finally {
    try {
      fs.rmSync(lockFile(root), { force: true });
    } catch {
      /* best effort */
    }
  }
} else {
  const { safe, inAgent } = require('./lib');
  safe((input) => {
    if (inAgent()) return; // an agent `factory run` started: no inspections or reports there
    const { findRoot } = require('../inspector/io');
    const root = findRoot(input.cwd);
    if (!root) return;
    if (!require('../inspector/main').pending(root).length || running(root)) return;
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [__filename, '--background', root], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  });
}
