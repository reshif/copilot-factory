'use strict';
const fs = require('fs');
const path = require('path');

function input() {
  try {
    const t = fs.readFileSync(0, 'utf8');
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

// Best effort, never throws: one line in .factory/inspect/hook-errors.jsonl, which the
// next run reports (R10.inspector_hook_errors). The inspector never writes factory logs.
function traceError(inp, e) {
  try {
    const { findRoot, layout, nowIso } = require('../inspector/io');
    const root = findRoot((inp && inp.cwd) || process.cwd());
    if (!root) return;
    const f = layout(root).hookErrors;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ ts: nowIso(), hook: path.basename(process.argv[1] || 'unknown', '.js'), hook_event: (inp && inp.hook_event_name) || null, message: String((e && e.message) || e).slice(0, 300) }) + '\n');
  } catch {
    /* tracing never breaks the hook */
  }
}

// Hooks never break Claude Code: any failure means "do nothing" — and leaves a trace.
function safe(fn) {
  let inp = {};
  try {
    inp = input();
    fn(inp);
  } catch (e) {
    if (process.env.FACTORY_HOOK_DEBUG) process.stderr.write(`inspector hook error: ${e.stack}\n`);
    traceError(inp, e);
  }
  process.exit(0);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

module.exports = { safe, emit, traceError };
