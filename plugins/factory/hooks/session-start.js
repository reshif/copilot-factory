'use strict';
// sessionStart: tell the agent how to reach the factory CLI (a plugin's bin/ is not on
// PATH in Copilot, plugins-cli.md §3) and, if this repo has a current factory job, its
// status, so work resumes from the CLI's state. Output: top-level additionalContext
// (honoured since CLI 1.0.11, hooks.md §5.2). Fires on resume too.
//
// In an agent process `factory run` started (FACTORY_RUNNER=1), the session is one factory
// agent doing one brief: it gets only a short role note — never "continue the job", which
// would invite it to drive the factory itself.

const { safe, context, findRoot, cliCommand, traceError, runnerAgent } = require('./lib');

function agentNote(agent) {
  const cmd = cliCommand();
  const who = agent.role ? `the factory agent "${agent.role}"` : 'a factory agent';
  return [
    `[factory] You are ${who}${agent.job ? ` for job ${agent.job}` : ''}, started by \`factory run\`. Do the task in your brief and nothing else.`,
    `[factory] Run only the factory commands your brief gives you (the CLI is ${cmd}). Never run factory next, run, record, wfargs, ship, close, init, job new, amend, park, followup, epic or distill, and never a human-only command (approve, deny, resume, cancel, abandon, waive, merged, confirm, lessons accept/reject/promote, ci install): the guard refuses them. Driving the job is the main session's work.`,
    '[factory] Your final message is the one JSON object your instructions describe, nothing else.',
  ].join('\n');
}

safe((input) => {
  const agent = runnerAgent();
  if (agent) {
    context(agentNote(agent));
    return;
  }
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
