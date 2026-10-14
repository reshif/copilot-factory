'use strict';
// preToolUse: agents may run inspections and read reports; marking findings and changing
// modes are yours. Registered without a matcher (hooks.md §6): only shell calls are checked.
const { safe, deny } = require('./lib');

safe((input) => {
  if (input.tool !== 'Bash') return;
  const why = require('./guard-rules').check(input.command);
  if (why) deny(`[inspector guard] ${why}`);
});
