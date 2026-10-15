'use strict';
// sessionStart: tell the agent how to reach the factory CLI and, if this repo has a current
// factory job, its status, so work resumes from the CLI's state. Output: top-level
// additionalContext (honoured since CLI 1.0.11, hooks.md §5.2). Fires on resume too.
//
// A plugin's bin/ is not on PATH in Copilot (plugins-cli.md §3), and the plugin folder is
// outside the workspace: Copilot asks before every `node "<plugin>/bin/factory" …` (and
// refuses it in -p). `factory` on PATH (`factory shim` links it into ~/.local/bin) runs with
// no prompt (verified on CLI 1.0.97); so does the absolute command once the folder is allowed
// (/add-dir <plugin root>, or copilot --add-dir <plugin root>).
//
// In an agent process `factory run` started (FACTORY_RUNNER=1), the session is one factory
// agent doing one brief: it gets only a short role note — never "continue the job", which
// would invite it to drive the factory itself.

const fs = require('fs');
const path = require('path');
const { safe, context, findRoot, cliCommand, traceError, runnerAgent } = require('./lib');

// `factory` resolves on PATH (a shim, or the user's own link).
function onPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']) {
      try {
        fs.accessSync(path.join(dir, name + ext), fs.constants.X_OK);
        return true;
      } catch {
        /* next */
      }
    }
  }
  return false;
}

function agentNote(agent) {
  const cmd = cliCommand();
  const who = agent.role ? `the factory agent "${agent.role}"` : 'a factory agent';
  return [
    `[factory] You are ${who}${agent.job ? ` for job ${agent.job}` : ''}, started by \`factory run\`. Do the task in your brief and nothing else.`,
    `[factory] Run only the factory commands your brief gives you (the CLI is ${cmd}). Never run factory next, run, record, wfargs, ship, close, init, job new, amend, park, followup, epic or distill, and never a human-only command (approve, deny, resume, cancel, abandon, waive, merged, confirm, lessons accept/reject/promote, ci install): the guard refuses them. Driving the job is the main session's work.`,
  ].join('\n');
}

safe((input) => {
  const agent = runnerAgent();
  if (agent) {
    context(agentNote(agent));
    return;
  }
  const cmd = cliCommand();
  const pluginRoot = path.resolve(__dirname, '..');
  const lines = onPath('factory')
    ? ['[factory] Factory CLI: `factory` is on PATH; run `factory …` as the skills say.']
    : [
        `[factory] Factory CLI: \`factory\` is not on PATH, so run ${cmd} … instead (same arguments). The plugin folder is outside the workspace, so Copilot asks before each of those commands (and refuses them in -p mode).`,
        `[factory] Tell the user once, briefly: to stop those prompts, run ${cmd} shim in their own terminal (links \`factory\` into ~/.local/bin; keep that on PATH), or allow the folder with /add-dir "${pluginRoot}" (or start copilot with --add-dir "${pluginRoot}").`,
      ];
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
