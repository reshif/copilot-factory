'use strict';
// Runs verify commands deterministically, with flaky re-runs.

const { spawnSync } = require('child_process');

function tail(s, n = 4000) {
  s = String(s || '');
  return s.length > n ? `…${s.slice(-n)}` : s;
}

function runOnce(cmd, cwd, timeoutSec) {
  const started = Date.now();
  const r = spawnSync('bash', ['-lc', cmd], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: process.env.CI || '1', FACTORY_VERIFY: '1', PYTHONDONTWRITEBYTECODE: '1' },
  });
  return {
    code: r.status === null ? -1 : r.status,
    timed_out: Boolean(r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM',
    ms: Date.now() - started,
    output: tail(`${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`),
  };
}

// A command passes only if it passes first time. If it fails and then passes on a
// re-run it is "flaky": recorded, and not accepted as proof.
function runCommand(cmd, cwd, { timeoutSec = 600, reruns = 1 } = {}) {
  const first = runOnce(cmd, cwd, timeoutSec);
  if (first.code === 0) return { cmd, pass: true, flaky: false, code: 0, ms: first.ms, output: first.output };
  for (let i = 0; i < reruns; i++) {
    const again = runOnce(cmd, cwd, timeoutSec);
    if (again.code === 0) return { cmd, pass: false, flaky: true, code: first.code, ms: first.ms + again.ms, output: first.output };
  }
  return { cmd, pass: false, flaky: false, code: first.code, timed_out: first.timed_out, ms: first.ms, output: first.output };
}

module.exports = { runCommand, tail };
