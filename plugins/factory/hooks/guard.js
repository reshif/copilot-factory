'use strict';
// PreToolUse guard: see guard-rules.js for what is denied and why.

const path = require('path');
const { safe, findRoot, traceError } = require('./lib');
const { checkWrite, checkReadTool, checkBash, checkContent, deny, loadPolicy, READ_TOOLS } = require('./guard-rules');

safe((input) => {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const filePath = ti.file_path || ti.notebook_path || ti.path || null;
  const absFile = filePath ? (path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)) : null;
  const root = findRoot(cwd, absFile && path.dirname(absFile));
  const policy = root ? loadPolicy(root) : require('../cli/core/policy').defaults();
  let why = null;
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && absFile) {
    why = checkWrite(root, absFile, policy);
    if (!why && root) {
      const text = [ti.content, ti.new_string, ti.new_source, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string) : [])].filter(Boolean).join('\n');
      why = checkContent(text, absFile);
    }
  }
  else if (READ_TOOLS.has(tool)) why = checkReadTool(root, tool, ti, absFile, cwd, policy);
  else if (tool === 'Bash' && root) why = checkBash(root, ti.command, policy);
  if (why) {
    deny(why);
    try {
      require('./activity-log').log(input, 'guard_deny', { reason: why });
    } catch (e) {
      traceError(input, e); // logging never blocks
    }
  }
});
