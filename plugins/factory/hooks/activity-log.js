'use strict';
// Appends one sealed line per agent/tool/hook event to .factory/log/events.jsonl.
// Each record says how its job was found: explicit (--job in the command), worktree, or pointer.

const path = require('path');
const { findRoot } = require('./lib');

function log(input, event, extra = {}) {
  const cwd = input.cwd || process.cwd();
  const root = findRoot(cwd);
  if (!root) return;
  const events = require('../cli/core/events');
  const ti = input.tool_input || {};
  const cmd = typeof ti.command === 'string' ? ti.command : '';
  const file = ti.file_path || ti.path || '';
  const explicit = cmd.match(/--job[=\s]+(J-\d+)/);
  const wt = `${cwd} ${file}`.match(/\.factory[\\/]worktrees[\\/](J-\d+)/);
  const ctx = events.context(root, explicit ? explicit[1] : wt ? wt[1] : null);
  events.append(root, {
    event: event || input.hook_event_name,
    tool: input.tool_name || null,
    agent_id: input.agent_id || null,
    agent_type: input.agent_type || null,
    job: ctx.job,
    how: explicit ? 'explicit' : wt ? 'worktree' : ctx.how,
    decision_id: ctx.decision_id,
    target: (cmd ? cmd.slice(0, 160) : file ? path.relative(root, path.resolve(cwd, file)) : null) || null,
    ...extra,
  });
}

module.exports = { log };
