'use strict';
// SessionStart: if this repo has an active factory job, say so, so work resumes from the CLI's state.

const { safe, emit, findRoot } = require('./lib');

safe((input) => {
  const root = findRoot(input.cwd || process.cwd());
  if (!root) return;
  const job = require('../cli/core/job');
  const id = job.current(root);
  if (!id) return;
  const s = job.load(root, id);
  if (!['active', 'parked'].includes(s.status)) return;
  const gate = s.pending_gate ? ` · waiting at ${s.pending_gate.id}` : '';
  emit({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `[factory] Current job ${s.id}: ${s.title} · ${s.recipe.id} · risk ${s.risk} · ${s.status}${gate}. To continue, use the factory:start skill (it runs \`factory next\`). Factory CLI: node "${require('path').join(require('../cli/lib/paths').PLUGIN_ROOT, 'bin', 'factory')}".`,
    },
  });
});
