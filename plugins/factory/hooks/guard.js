'use strict';
// preToolUse guard: see guard-rules.js for what is denied and why. Registered without a
// matcher (Copilot's tool-name list is incomplete and VS Code's Local harness ignores
// matchers, hooks.md §6), so it filters by the normalised tool name itself and returns
// before loading anything for tools it doesn't guard. A timeout fails OPEN in Copilot
// (hooks.md §5.1): the hot path stays small and requires are lazy.

//
// In an agent process `factory run` started (FACTORY_RUNNER=1) the agent rules apply on top:
// only the factory commands roles are briefed to run are allowed (guard-rules AGENT_ALLOWED).
// Copilot's shell-session tools are normalised to Bash (write_bash: its input is checked
// as a command; read/stop/list_bash are not guarded).

const path = require('path');
const { safe, findRoot, traceError, runnerAgent } = require('./lib');

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

safe((input) => {
  const tool = input.tool;
  if (!WRITE_TOOLS.has(tool) && !READS.has(tool) && tool !== 'Bash') return;
  const { checkWrite, checkReadTool, checkBash, checkContent, deny, loadPolicy } = require('./guard-rules');
  const ti = input.args;
  const cwd = input.cwd;
  const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(cwd, p));
  const absFile = input.file ? abs(input.file) : null;
  const agent = runnerAgent();
  const root = findRoot(cwd, absFile && path.dirname(absFile), agent && agent.root);
  const policy = root ? loadPolicy(root) : require('../cli/core/policy').defaults();
  let why = null;
  if (WRITE_TOOLS.has(tool)) {
    // Every file the call writes: its path argument and every file an apply_patch body touches.
    for (const f of input.files) {
      why = checkWrite(root, abs(f.path), policy) || (root && f.content ? checkContent(f.content, abs(f.path)) : null);
      if (why) break;
    }
    if (!why && root && input.isPatch && !input.files.length) why = 'Could not tell which files this patch touches; use the edit or create tool on one file at a time.';
  } else if (READS.has(tool)) {
    why = checkReadTool(root, tool, ti, absFile, cwd, policy);
    // Copilot's rg / glob search `paths` (one directory or several), each checked like a path.
    for (const p of input.searchPaths || []) {
      if (why) break;
      why = checkReadTool(root, tool, ti, abs(p), cwd, policy);
    }
  } else if (tool === 'Bash' && root) why = checkBash(root, input.command, policy, { agent: Boolean(agent), shellInput: /^write_/.test(String(input.runtimeTool || '')) });
  if (why) {
    deny(why);
    try {
      require('./activity-log').log(input, 'guard_deny', { reason: why });
    } catch (e) {
      traceError(input, e); // logging never blocks
    }
  }
});
