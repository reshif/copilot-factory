'use strict';
// After a factory command that can end a job (close, cancel, abandon), inspect it and any
// other ended job not yet inspected. Reports in one line; never blocks.

const { safe, emit } = require('./lib');
const { findRoot } = require('../inspector/io');

safe((input) => {
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  if (!/\bfactory\b[^|;&\n]*\s(close|cancel|abandon)\b/.test(cmd)) return;
  const root = findRoot(input.cwd || process.cwd());
  if (!root) return;
  const main = require('../inspector/main');
  const line = main.summary(main.run(root, {}));
  if (!line) return;
  emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `${line} Tell the user in one line; details with /factory-inspector:inspect.` } });
});
