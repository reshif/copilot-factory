'use strict';
// userPromptSubmitted: your replies about findings and inspection modes, applied as a
// side effect before the agent acts; and what an end-of-turn catch-up inspection found
// (catch-up.js runs at agentStop, whose output can't carry it). Copilot hands this hook's
// additionalContext to the model (verified on CLI 1.0.97, though the reference says command
// hook output is dropped, hooks.md §5.3), so the catch-up line reaches the user on the very
// next prompt — including the stop gate's continuation prompt in the same turn — instead of
// waiting for the next session start. If it were dropped, nothing is lost: the finding is
// in the register, and a reply's change is applied either way.
const { safe, context, inAgent, takeUnreported } = require('./lib');

safe((input) => {
  if (inAgent()) return; // an agent `factory run` started: no inspections or reports there
  const { findRoot } = require('../inspector/io');
  const root = findRoot(input.cwd);
  if (!root) return;
  const lines = [];
  const earlier = takeUnreported(root);
  if (earlier.length) lines.push(`${earlier.join(' ')} Tell the user in one line; details with the factory-inspector:inspect skill.`);
  const main = require('../inspector/main');
  // a prompt the Copilot CLI's scheduler sent (/every, /after, /loop: "[Scheduled prompt #N]")
  // fires unattended: never a reply (the factory's prompt hook refuses it the same way)
  const scheduled = /^\s*\[Scheduled prompt\b[^\]\n]{0,40}\]/i.test(String(input.prompt || ''));
  const p = scheduled ? null : main.parseReply(input.prompt);
  if (p) {
    try {
      lines.push(`[inspector] Applied: ${main.applyReply(root, p).message}`);
    } catch (e) {
      lines.push(`[inspector] Not applied: ${e.message}`);
    }
  }
  context(lines.join('\n'));
});
