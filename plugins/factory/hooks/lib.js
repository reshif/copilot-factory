'use strict';
// Shared hook plumbing. Hooks must never crash Claude Code: every entry point
// catches everything and falls back to "allow" — but a failure leaves a sealed
// hook_error line in events.jsonl, so a hook that silently stopped enforcing shows up
// in the audit.

const fs = require('fs');
const path = require('path');

function readInput() {
  try {
    const t = fs.readFileSync(0, 'utf8');
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function findRoot(...starts) {
  const { findRoot: f } = require('../cli/lib/paths');
  for (const s of starts) {
    if (!s) continue;
    const r = f(s);
    if (r) return r;
  }
  return null;
}

// Best effort, never throws: a hook that can't find its root or log just stays quiet.
function traceError(input, e) {
  try {
    const root = findRoot((input && input.cwd) || process.cwd());
    if (!root) return;
    const events = require('../cli/core/events');
    const ctx = events.context(root, null);
    events.append(root, {
      event: 'hook_error',
      hook: path.basename(process.argv[1] || 'unknown', '.js'),
      hook_event: (input && input.hook_event_name) || null,
      tool: (input && input.tool_name) || null,
      agent_type: (input && input.agent_type) || null,
      message: String((e && e.message) || e).slice(0, 300),
      at: String((e && e.stack) || '').split('\n')[1]?.trim().slice(0, 200) || null,
      job: ctx.job,
      how: ctx.how,
      decision_id: ctx.decision_id,
    });
  } catch {
    /* tracing never breaks the hook */
  }
}

function safe(fn) {
  let input = {};
  try {
    input = readInput();
    fn(input);
  } catch (e) {
    if (process.env.FACTORY_HOOK_DEBUG) process.stderr.write(`factory hook error: ${e.stack}\n`);
    traceError(input, e);
  }
  process.exit(0);
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}

module.exports = { readInput, emit, findRoot, safe, realpath, traceError };
