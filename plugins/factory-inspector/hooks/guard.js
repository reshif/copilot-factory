'use strict';
// preToolUse: agents may run inspections and read reports; marking findings and changing
// modes are yours. Registered without a matcher (hooks.md §6): shell calls are checked
// (write_bash input and VS Code's run_in_terminal too), and so are the command-like
// arguments of a tool we don't know that runs things (a VS Code, extension or MCP command
// runner) — for those only the human-only and agent rules apply. Agents `factory run`
// started run no inspections at all.
const { safe, deny, inAgent } = require('./lib');

const KNOWN = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Grep', 'Glob', 'NotebookRead', 'Task', 'Agent', 'WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion', 'BashOutput', 'KillShell']);
const RUNNER = /terminal|shell|exec|command|run|bash|powershell|pwsh|cmd|script|task|process|spawn/i;
const RUNNER_ARG = /^(command|cmd|commands|commandLine|command_line|shellCommand|shell_command|script|code|input|line|keys|text|args|argv|arguments)$/i;
const COMMAND_ARG = /^(command|cmd|commands|commandLine|command_line|shellCommand|shell_command|script)$/i;

function commandArgs(input) {
  const keyOk = (k) => (RUNNER.test(String(input.runtimeTool || '')) ? RUNNER_ARG : COMMAND_ARG).test(k);
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
  const a = input.args || {};
  const cmd = typeof a.command === 'string' ? a.command : typeof a.cmd === 'string' ? a.cmd : null;
  const rest = Array.isArray(a.args) ? a.args : Array.isArray(a.argv) ? a.argv : null;
  if (cmd && rest && rest.every((x) => typeof x === 'string')) out.push([cmd, ...rest].join(' '));
  return out;
}

safe((input) => {
  const { check } = require('./guard-rules');
  if (input.tool === 'Bash') {
    const why = check(input.command, { agent: inAgent() });
    if (why) deny(`[inspector guard] ${why}`);
    return;
  }
  if (!input.tool || KNOWN.has(input.tool)) return;
  for (const c of commandArgs(input)) {
    const why = check(c, { agent: inAgent() });
    if (why && /is yours|run no inspections/.test(why)) {
      deny(`[inspector guard] ${why} (tool ${input.runtimeTool})`);
      return;
    }
  }
});
