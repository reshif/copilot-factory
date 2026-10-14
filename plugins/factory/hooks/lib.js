'use strict';
// Shared hook plumbing for the GitHub Copilot CLI. Hooks must never break a session:
// every entry point catches everything and falls back to "allow" — but a failure leaves
// a sealed hook_error line in events.jsonl, so a hook that silently stopped enforcing
// shows up in the audit.
//
// Input: one normaliser for every payload shape Copilot can send (docs/research/hooks.md §4):
//   camelCase events (what hooks.json registers): toolName / toolArgs (object or JSON string),
//     agentName, transcriptPath, stop_hook_active;
//   PascalCase / Claude-style events: hook_event_name, tool_name (Claude name), tool_input,
//     agent_type, transcript_path, last_assistant_message.
// Tool names are mapped to the Claude-era names the rules use (§6.2): bash→Bash, view→Read,
// create→Write, edit/str_replace_editor/apply_patch→Edit, grep/rg→Grep, glob→Glob, …
// Paths come from path / file_path / filePath / notebook_path, plus every file an
// apply_patch body touches (*** Update File: / *** Add File: / *** Delete File: / *** Move to:).
//
// Output (§5): flat fields only. Deny = stdout {permissionDecision:'deny', permissionDecisionReason}
// AND exit 2 with the reason on stderr; context = top-level additionalContext; stop block =
// top-level {decision:'block', reason}.

const fs = require('fs');
const path = require('path');

// ---- input normaliser (the inspector keeps its own copy of this block) -------------------

// Any spelling of an event → the Claude-era name the factory's logs use.
const EVENTS = {
  sessionstart: 'SessionStart',
  sessionend: 'SessionEnd',
  userpromptsubmitted: 'UserPromptSubmit',
  userpromptsubmit: 'UserPromptSubmit',
  pretooluse: 'PreToolUse',
  posttooluse: 'PostToolUse',
  posttoolusefailure: 'PostToolUseFailure',
  subagentstart: 'SubagentStart',
  subagentstop: 'SubagentStop',
  agentstop: 'Stop',
  stop: 'Stop',
};

// Copilot runtime tool names → Claude names (hooks.md §6.2). Unknown names pass through.
const TOOLS = {
  bash: 'Bash',
  powershell: 'Bash',
  shell: 'Bash',
  view: 'Read',
  read: 'Read',
  read_file: 'Read',
  create: 'Write',
  write: 'Write',
  write_file: 'Write',
  edit: 'Edit',
  edit_file: 'Edit',
  str_replace_editor: 'Edit',
  str_replace_based_edit_tool: 'Edit',
  apply_patch: 'Edit',
  multiedit: 'MultiEdit',
  grep: 'Grep',
  rg: 'Grep',
  glob: 'Glob',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  ask_user: 'AskUserQuestion',
  update_todo: 'TodoWrite',
  task: 'Task',
  agent: 'Task',
};

function toolName(raw, args) {
  const name = String(raw || '');
  if (!name) return null;
  // str_replace_editor carries its own sub-command: view / create / str_replace / insert / undo_edit.
  if (/^(str_replace_editor|str_replace_based_edit_tool)$/.test(name) && args && typeof args.command === 'string') {
    if (args.command === 'view') return 'Read';
    if (args.command === 'create') return 'Write';
    return 'Edit';
  }
  return TOOLS[name] || TOOLS[name.toLowerCase()] || name;
}

function parseArgs(x, runtimeTool) {
  if (x && typeof x === 'object') return x;
  if (typeof x !== 'string') return {};
  try {
    const v = JSON.parse(x);
    if (v && typeof v === 'object') return v;
  } catch {
    /* not JSON: a raw patch or command */
  }
  if (/apply_patch/.test(String(runtimeTool || '')) || /\*\*\* (Begin Patch|Update File:|Add File:|Delete File:)/.test(x)) return { input: x };
  return { command: x };
}

// Files an apply_patch body (or a unified diff) touches, with the text each one gains.
function patchFiles(text) {
  const s = String(text || '');
  if (!/\*\*\* (Update|Add|Delete) File:|^\+\+\+ |^diff --git /m.test(s)) return [];
  const out = [];
  const codex = /^\*\*\* (Update|Add|Delete) File:/m.test(s); // apply_patch format: ignore diff headers
  let cur = null;
  let oldPath = null;
  for (const line of s.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^\*\*\* (Update|Add|Delete) File:\s*(.+?)\s*$/))) {
      cur = { path: m[2], op: m[1].toLowerCase(), added: [] };
      out.push(cur);
    } else if ((m = line.match(/^\*\*\* Move to:\s*(.+?)\s*$/))) {
      cur = { path: m[1], op: 'move', added: cur ? cur.added : [] };
      out.push(cur);
    } else if (!codex && (m = line.match(/^--- (?:a\/)?(.+?)\s*$/)) && !cur) {
      oldPath = m[1] === '/dev/null' ? null : m[1];
    } else if (!codex && (m = line.match(/^\+\+\+ (?:b\/)?(.+?)\s*$/))) {
      if (m[1] === '/dev/null') {
        if (oldPath) out.push({ path: oldPath, op: 'delete', added: [] });
        cur = null;
      } else {
        cur = { path: m[1], op: 'update', added: [] };
        out.push(cur);
      }
      oldPath = null;
    } else if (!codex && /^diff --git /.test(line)) {
      cur = null;
    } else if (cur && line.startsWith('+')) {
      cur.added.push(line.slice(1));
    }
  }
  return out.map((f) => ({ path: f.path, op: f.op, content: f.added.join('\n') }));
}

function str(...xs) {
  for (const x of xs) if (typeof x === 'string' && x) return x;
  return null;
}

function normalise(raw, argvEvent) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const hookEvent = str(r.hook_event_name, r.hookEventName, argvEvent);
  const event = hookEvent ? EVENTS[hookEvent.toLowerCase()] || hookEvent : null;
  const runtimeTool = str(r.toolName, r.tool_name);
  const rawArgs = r.toolArgs !== undefined ? r.toolArgs : r.tool_input !== undefined ? r.tool_input : r.toolInput;
  const args = parseArgs(rawArgs, runtimeTool);
  const tool = toolName(runtimeTool, args);
  const file = str(args.file_path, args.filePath, args.path, args.notebook_path, args.notebookPath, args.file);
  // apply_patch: the patch is the argument (input / patch / a raw string), never a path.
  const isPatchTool = /patch/i.test(String(runtimeTool || ''));
  const patch = tool === 'Edit' || tool === 'Write' || isPatchTool ? patchFiles(str(args.input, args.patch, args.diff, typeof rawArgs === 'string' ? rawArgs : null)) : [];
  const content = [args.content, args.file_text, args.new_string, args.new_str, args.newString, args.new_source, ...(Array.isArray(args.edits) ? args.edits.map((e) => e && (e.new_string || e.newString)) : [])]
    .filter((x) => typeof x === 'string' && x)
    .join('\n');
  const files = [];
  if (file) files.push({ path: file, content, op: null });
  for (const p of patch) files.push(p);
  return {
    raw: r,
    event,
    hookEvent,
    cwd: str(r.cwd, r.workingDirectory) || process.cwd(),
    sessionId: str(r.sessionId, r.session_id),
    prompt: typeof r.prompt === 'string' ? r.prompt : '',
    source: str(r.source),
    tool,
    runtimeTool,
    args,
    command: tool === 'Bash' ? str(args.command, args.cmd, args.script) || '' : '',
    file,
    files,
    content,
    isPatch: isPatchTool || patch.length > 0,
    agent: str(r.agentName, r.agent_name, r.agent_type, r.agentType),
    agentKind: str(r.agentType, r.agent_type),
    agentId: str(r.agentId, r.agent_id),
    transcriptPath: str(r.transcriptPath, r.transcript_path),
    // undefined when the CLI didn't send it: callers tell "fresh stop" from "unknown"
    stopHookActive: r.stop_hook_active !== undefined ? r.stop_hook_active === true : r.stopHookActive !== undefined ? r.stopHookActive === true : undefined,
    lastMessage: str(r.last_assistant_message, r.lastAssistantMessage, r.response),
  };
}

// ---- plumbing ---------------------------------------------------------------------------

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

// preToolUse deny: the flat JSON on stdout (merged with the deny) and exit 2 with the
// reason on stderr — exit 2 denies even if the JSON were ignored (hooks.md §5.1).
function deny(reason) {
  emit({ permissionDecision: 'deny', permissionDecisionReason: reason });
  process.stderr.write(`${reason}\n`);
  process.exitCode = 2;
}

function context(text) {
  if (text) emit({ additionalContext: text });
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
      hook_event: (input && input.event) || null,
      tool: (input && input.tool) || null,
      agent_type: (input && input.agent) || null,
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

// Runs a hook: fn gets the normalised input. The event name comes from the payload
// (hook_event_name) or, for camelCase payloads that carry none, from argv[2] (hooks.json
// passes it). Exit code: 2 after a deny, else 0 — a crash is traced and fails open
// (a non-zero exit would deny every tool in Copilot, hooks.md §5.1).
function safe(fn) {
  let input = { cwd: process.cwd(), event: process.argv[2] || null };
  try {
    input = normalise(readInput(), process.argv[2]);
    fn(input);
  } catch (e) {
    if (process.env.FACTORY_HOOK_DEBUG) process.stderr.write(`factory hook error: ${e.stack}\n`);
    traceError(input, e);
  }
  process.exit(process.exitCode === 2 ? 2 : 0);
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

// The plugin's own CLI as an absolute command: a plugin's bin/ is not on PATH in Copilot.
function cliCommand() {
  return `node "${path.join(path.resolve(__dirname, '..'), 'bin', 'factory')}"`;
}

module.exports = { readInput, normalise, toolName, patchFiles, emit, deny, context, findRoot, safe, realpath, traceError, cliCommand, EVENTS, TOOLS };
