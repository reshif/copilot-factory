'use strict';
// Catch-up at the end of every turn: jobs also end outside Claude's Bash — a "cancel job"
// or "merged <sha>" reply applied by the factory's prompt hook, or a command you ran in
// your own terminal — and PostToolUse never sees those. If any ended job hasn't been
// inspected at its current status, inspect now and show you one line. Never blocks.

const { safe, emit } = require('./lib');
const { findRoot } = require('../inspector/io');

safe((input) => {
  const root = findRoot(input.cwd || process.cwd());
  if (!root) return;
  const main = require('../inspector/main');
  if (!main.pending(root).length) return;
  const line = main.summary(main.run(root, {}));
  if (line) emit({ systemMessage: `${line} Details with /factory-inspector:inspect.` });
});
