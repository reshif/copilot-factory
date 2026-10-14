'use strict';
// Session start: inspect any job that ended while no session was watching, then report.
const { safe, emit } = require('./lib');
const { findRoot } = require('../inspector/io');

safe((input) => {
  const root = findRoot(input.cwd || process.cwd());
  if (!root) return;
  const main = require('../inspector/main');
  const ran = main.pending(root).length ? main.summary(main.run(root, {})) : null;
  const r = main.report(root, { status: 'open', health: false });
  if (!r.counts.open && !ran) return;
  const parts = [];
  if (ran) parts.push(ran);
  if (r.counts.open) parts.push(`[inspector] ${r.counts.open} open factory finding(s) (${r.counts.high} high). If the user asks about the factory's health, use /factory-inspector:inspect.`);
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join(' ') } });
});
