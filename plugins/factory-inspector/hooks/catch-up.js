'use strict';
// agentStop catch-up: jobs also end outside the agent's shell — a "cancel job" or
// "merged <sha>" reply applied by the factory's prompt hook, or a command you ran in your
// own terminal — and postToolUse never sees those. If any ended job hasn't been inspected
// at its current status, inspect it now. Never blocks: Copilot's agentStop honours only
// decision/reason (hooks.md §5.5; systemMessage is not a CLI output, §5.8), so the
// result goes to the register and the one-line summary is kept for the next hook that can
// show it: the next prompt (prompt.js, usually the very next message), an after-close
// report, or the next session start.

const { safe, stashUnreported, inAgent } = require('./lib');

safe((input) => {
  if (inAgent()) return; // an agent `factory run` started: no inspections or reports there
  const { findRoot } = require('../inspector/io');
  const root = findRoot(input.cwd);
  if (!root) return;
  const main = require('../inspector/main');
  if (!main.pending(root).length) return;
  const line = main.summary(main.run(root, {}));
  if (line) stashUnreported(root, line);
});
