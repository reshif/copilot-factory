'use strict';
// userPromptSubmitted: your replies about findings and inspection modes, applied as a
// side effect before the agent acts. The additionalContext may be dropped by Copilot
// (hooks.md §5.3); the change itself is in the register either way.
const { safe, context } = require('./lib');

safe((input) => {
  const main = require('../inspector/main');
  const p = main.parseReply(input.prompt);
  if (!p) return;
  const { findRoot } = require('../inspector/io');
  const root = findRoot(input.cwd);
  if (!root) return;
  let msg;
  try {
    msg = `[inspector] Applied: ${main.applyReply(root, p).message}`;
  } catch (e) {
    msg = `[inspector] Not applied: ${e.message}`;
  }
  context(msg);
});
