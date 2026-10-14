'use strict';
// Your replies about findings and inspection modes, applied before the model sees them.
const { safe, emit } = require('./lib');
const { findRoot } = require('../inspector/io');

safe((input) => {
  const main = require('../inspector/main');
  const p = main.parseReply(input.prompt);
  if (!p) return;
  const root = findRoot(input.cwd || process.cwd());
  if (!root) return;
  let msg;
  try {
    msg = `[inspector] Applied: ${main.applyReply(root, p).message}`;
  } catch (e) {
    msg = `[inspector] Not applied: ${e.message}`;
  }
  emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: msg } });
});
