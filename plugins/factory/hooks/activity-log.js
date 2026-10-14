'use strict';
// Appends one sealed line per agent/tool/hook event to .factory/log/events.jsonl.
// Each record says how its job was found: explicit (--job in the command), worktree, or pointer.
// Takes the normalised input (lib.normalise): event names are the Claude-era ones
// (PostToolUse, SubagentStart, SubagentStop) and tool names are normalised (bash → Bash),
// so the log reads the same whichever casing Copilot sent.

const path = require('path');
const { findRoot, runnerAgent } = require('./lib');

function log(input, event, extra = {}) {
  const cwd = input.cwd || process.cwd();
  // In an agent process `factory run` started, the line belongs to that agent, not to the
  // main session (the console shows lines with no agent_type as the main session).
  const agent = runnerAgent();
  const root = findRoot(cwd) || (agent && agent.root && findRoot(agent.root));
  if (!root) return;
  const events = require('../cli/core/events');
  const cmd = input.command || '';
  const file = input.file || (input.files && input.files[0] && input.files[0].path) || '';
  const explicit = cmd.match(/--job[=\s]+(J-\d+)/);
  const wt = `${cwd} ${file}`.match(/\.factory[\\/]worktrees[\\/](J-\d+)/);
  const ctx = events.context(root, explicit ? explicit[1] : wt ? wt[1] : agent && agent.job ? agent.job : null);
  events.append(root, {
    event: event || input.event,
    tool: input.tool || null,
    agent_id: input.agentId || null,
    agent_type: input.agent || (agent && agent.role ? `factory:${agent.role}` : null),
    ...(agent ? { runner: true } : {}),
    job: ctx.job,
    how: explicit ? 'explicit' : wt ? 'worktree' : agent && agent.job ? 'runner' : ctx.how,
    decision_id: ctx.decision_id,
    target: (cmd ? cmd.slice(0, 160) : file ? path.relative(root, path.resolve(cwd, file)) : null) || null,
    ...extra,
  });
}

module.exports = { log };
