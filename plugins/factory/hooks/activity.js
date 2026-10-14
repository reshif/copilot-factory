'use strict';
// postToolUse and subagentStart: one activity line each. postToolUse is registered without
// a matcher (hooks.md §6), so read-only tools are skipped here, as the Claude matcher did.
const { safe } = require('./lib');

// Tools that change something or reach out: the same set the Claude-era matcher logged.
const LOGGED = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent', 'WebFetch', 'WebSearch']);

function shouldLog(input) {
  return input.event !== 'PostToolUse' || LOGGED.has(input.tool);
}

if (require.main === module) safe((input) => {
  if (shouldLog(input)) require('./activity-log').log(input);
});

module.exports = { shouldLog, LOGGED };
