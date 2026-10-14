'use strict';
// preToolUse: agents may run inspections and read reports; marking findings and changing
// modes are yours. Registered without a matcher (hooks.md §6): only shell calls are checked
// (write_bash input too). Agents `factory run` started run no inspections at all.
const { safe, deny, inAgent } = require('./lib');

safe((input) => {
  if (input.tool !== 'Bash') return;
  const why = require('./guard-rules').check(input.command, { agent: inAgent() });
  if (why) deny(`[inspector guard] ${why}`);
});
