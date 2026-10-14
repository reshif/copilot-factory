'use strict';
// sessionStart: say how to reach factory-inspect (a plugin's bin/ is not on PATH in
// Copilot), inspect any job that ended while no session was watching, and report what
// an earlier end-of-turn catch-up found. Output: top-level additionalContext (hooks.md §5.2).
const { safe, context, cliCommand, takeUnreported, inAgent } = require('./lib');

safe((input) => {
  if (inAgent()) return; // an agent `factory run` started: no inspections or reports there
  const cmd = cliCommand();
  const parts = [`[inspector] Inspector CLI: ${cmd}. When a skill says to run \`factory-inspect …\` and it is not on PATH, run ${cmd} … instead.`];
  const { findRoot } = require('../inspector/io');
  const root = findRoot(input.cwd);
  if (root) {
    const main = require('../inspector/main');
    const earlier = takeUnreported(root);
    const ran = main.pending(root).length ? main.summary(main.run(root, {})) : null;
    const r = main.report(root, { status: 'open', health: false });
    parts.push(...earlier);
    if (ran) parts.push(ran);
    if (r.counts.open) parts.push(`[inspector] ${r.counts.open} open factory finding(s) (${r.counts.high} high). If the user asks about the factory's health, use the factory-inspector:inspect skill.`);
  }
  context(parts.join('\n'));
});
