'use strict';
// Is this process running under a factory agent, whatever its environment says now? A factory
// agent is a `copilot -p … --agent factory:<role>` process that `factory run` started with
// FACTORY_RUNNER=1 (runner.js). An agent's shell inherits that, and cli/main.js refuses it every
// command its role isn't briefed to run. A script can unset the variable (`unset FACTORY_RUNNER;
// factory drive`), so the CLI also looks up its own process ancestry for the agent process
// itself: its command line (`--agent factory:…`) or the environment it was started with
// (FACTORY_RUNNER=1 in /proc/<pid>/environ, fixed at exec: nothing the agent runs can change it).
//
// Linux: /proc. macOS and the BSDs: one `ps -A -o pid=,ppid=,command=` (the command line only).
// Windows: not available (null): the environment check and the guard hook are the layers there.

const fs = require('fs');

const AGENT_CMD = /(^|[\0\s])--agent(=|[\0\s]+)["']?factory:/;
const MAX_DEPTH = 40;

function procParent(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(rest[1]); // field 4
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

function procIsAgent(pid) {
  try {
    if (AGENT_CMD.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) return 'cmdline';
  } catch {
    /* gone, or not ours */
  }
  try {
    if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes('FACTORY_RUNNER=1')) return 'environ';
  } catch {
    /* another user's process: unreadable */
  }
  return null;
}

// { pid, how } for the nearest factory-agent ancestor, or null (none, or nothing can tell).
function factoryAgentAncestor({ start = process.ppid } = {}) {
  if (process.platform === 'win32') return null;
  if (fs.existsSync('/proc/self/stat')) {
    let pid = start;
    for (let i = 0; i < MAX_DEPTH && pid && pid > 1; i++) {
      const how = procIsAgent(pid);
      if (how) return { pid, how };
      pid = procParent(pid);
    }
    return null;
  }
  try {
    const r = require('child_process').spawnSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) return null;
    const rows = new Map();
    for (const line of String(r.stdout || '').split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), cmd: m[3] });
    }
    let pid = start;
    for (let i = 0; i < MAX_DEPTH && pid && pid > 1; i++) {
      const row = rows.get(pid);
      if (!row) return null;
      if (AGENT_CMD.test(row.cmd)) return { pid, how: 'command' };
      pid = row.ppid;
    }
  } catch {
    /* no ps */
  }
  return null;
}

module.exports = { factoryAgentAncestor, AGENT_CMD };
