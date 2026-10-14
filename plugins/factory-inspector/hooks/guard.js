'use strict';
// Agents may run inspections and read reports; marking findings and changing modes are yours.
const { safe, emit } = require('./lib');
const { check } = require('./guard-rules');

safe((input) => {
  if (input.tool_name !== 'Bash') return;
  const why = check(input.tool_input && input.tool_input.command);
  if (why) emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[inspector guard] ${why}` } });
});

