'use strict';
// postToolUse (shell): after a factory command that can end a job (close, cancel, abandon),
// inspect it and any other ended job not yet inspected. Reports in one line through
// additionalContext, which Copilot appends to the tool result (hooks.md §5.4); never blocks.

const { safe, context, takeUnreported } = require('./lib');

safe((input) => {
  if (input.tool !== 'Bash') return;
  if (!/\bfactory\b[^|;&\n]*\s(close|cancel|abandon)\b/.test(input.command)) return;
  const { findRoot } = require('../inspector/io');
  const root = findRoot(input.cwd);
  if (!root) return;
  const main = require('../inspector/main');
  const line = main.summary(main.run(root, {}));
  const earlier = takeUnreported(root);
  const all = [...earlier, line].filter(Boolean);
  if (!all.length) return;
  context(`${all.join(' ')} Tell the user in one line; details with the factory-inspector:inspect skill.`);
});
