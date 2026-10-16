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
// Tools the normaliser knows that run no command.
const KNOWN = new Set(['Task', 'Agent', 'WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion', 'BashOutput', 'KillShell']);
// A tool we don't know whose name says it runs things (VS Code tasks, an extension's or an
// MCP server's terminal tool): every command-like string argument is read as a command.
// Any other unknown tool: only arguments named like a command. Content and prose fields
// (explanation, description, content…) are never read; within a command, a factory verb
// counts only in command position (shell.js), so `echo "factory approve"` is data.
const RUNNER = /terminal|shell|exec|command|run|bash|powershell|pwsh|cmd|script|task|process|spawn/i;
const RUNNER_ARG = /^(command|cmd|commands|commandLine|command_line|shellCommand|shell_command|script|code|input|line|keys|text|args|argv|arguments)$/i;
const COMMAND_ARG = /^(command|cmd|commands|commandLine|command_line|shellCommand|shell_command|script)$/i;

function commandArgs(input) {
  const runner = RUNNER.test(String(input.runtimeTool || ''));
  const keyOk = (k) => (runner ? RUNNER_ARG : COMMAND_ARG).test(k);
  const out = [];
  const visit = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 2) return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v && keyOk(k)) out.push(v);
      else if (Array.isArray(v) && keyOk(k) && v.every((x) => typeof x === 'string')) out.push(v.join(' '));
      else if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  visit(input.args, 0);
  // {command: "factory", args: ["approve"]}: one command line
  const a = input.args || {};
  const cmd = typeof a.command === 'string' ? a.command : typeof a.cmd === 'string' ? a.cmd : null;
  const rest = Array.isArray(a.args) ? a.args : Array.isArray(a.argv) ? a.argv : null;
  if (cmd && rest && rest.every((x) => typeof x === 'string')) out.push([cmd, ...rest].join(' '));
  return out;
}

safe((input) => {
  const tool = input.tool;
  if (!tool || KNOWN.has(tool)) return;
  const unknown = !WRITE_TOOLS.has(tool) && !READS.has(tool) && tool !== 'Bash';
  const commands = unknown ? commandArgs(input) : null;
  if (unknown && !commands.length) return;
  const { checkWrite, checkReadTool, checkBash, checkUnknownCommand, checkContent, deny, loadPolicy } = require('./guard-rules');
  const ti = input.args;
  const cwd = input.cwd;
  const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(cwd, p));
  const absFile = input.file ? abs(input.file) : null;
  const agent = runnerAgent();
  const root = findRoot(cwd, absFile && path.dirname(absFile), agent && agent.root);
  const policy = root ? loadPolicy(root) : require('../cli/core/policy').defaults();
  let why = null;
  if (unknown) {
    for (const c of root ? commands : []) {
      why = checkUnknownCommand(root, c, policy, { agent: Boolean(agent) });
      if (why) {
        why = `${why} (tool ${input.runtimeTool}: "${c.replace(/\s+/g, ' ').trim().slice(0, 117)}")`;
        break;
      }
    }
  } else if (WRITE_TOOLS.has(tool)) {
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
  } else if (tool === 'Bash' && root) why = checkBash(root, input.command, policy, { agent: Boolean(agent), cwd, shellInput: /^write_/.test(String(input.runtimeTool || '')) });
  if (why) {
    // Say what was seen, so a block can be traced to the exact command.
    if (tool === 'Bash' && input.command) {
      const seen = String(input.command).replace(/\s+/g, ' ').trim();
      why = `${why} (command: "${seen.length > 120 ? `${seen.slice(0, 117)}...` : seen}")`;
    }
    deny(why);
    try {
      require('./activity-log').log(input, 'guard_deny', { reason: why });
    } catch (e) {
      traceError(input, e); // logging never blocks
    }
  }
});
