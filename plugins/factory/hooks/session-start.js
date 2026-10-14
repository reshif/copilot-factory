'use strict';
// sessionStart: tell the agent how to reach the factory CLI (a plugin's bin/ is not on
// PATH in Copilot, plugins-cli.md §3) and, if this repo has a current factory job, its
// status, so work resumes from the CLI's state. Output: top-level additionalContext
// (honoured since CLI 1.0.11, hooks.md §5.2). Fires on resume too.

const { safe, context, findRoot, cliCommand, traceError } = require('./lib');

safe((input) => {
  const cmd = cliCommand();
  const lines = [`[factory] Factory CLI: ${cmd}. Whenever a skill or instruction says to run \`factory …\` and \`factory\` is not on PATH, run ${cmd} … instead (same arguments).`];
  const root = findRoot(input.cwd);
  if (root) {
    try {
      const job = require('../cli/core/job');
      const id = job.current(root);
      const s = id ? job.load(root, id) : null;
      if (s && ['active', 'parked'].includes(s.status)) {
        const gate = s.pending_gate ? ` · waiting at ${s.pending_gate.id}` : '';
        lines.push(`[factory] Current job ${s.id}: ${s.title} · ${s.recipe.id} · risk ${s.risk} · ${s.status}${gate}. To continue, use the factory:start skill (it runs \`factory next\`).`);
      }
    } catch (e) {
      traceError(input, e);
      lines.push('[factory] The current job could not be read; run `factory next` to see why.');
    }
  }
  context(lines.join('\n'));
});
