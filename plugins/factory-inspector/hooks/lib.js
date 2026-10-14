'use strict';
// Inspector hook plumbing for the GitHub Copilot CLI. Same input normaliser as the
// factory's hooks (its own copy: the inspector imports nothing from the factory), same
// flat output shapes (docs/research/hooks.md §5): deny = stdout {permissionDecision:'deny',
// permissionDecisionReason} + exit 2 with the reason on stderr; context = top-level
// additionalContext.

const fs = require('fs');
const path = require('path');

// ---- input normaliser (a copy of the factory's hooks/lib.js block: the inspector imports no factory code) -------------------

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
  // Copilot's shell-session tools. write_bash / write_powershell type input into a running
  // shell (docs: "Send input to a shell session"; CLI 1.0.62 says it is no longer supported,
  // but the docs still list it): their input is checked as a command. read/stop/list only
  // touch a session's output, under the Claude names for those (not guarded, not logged).
  write_bash: 'Bash',
  write_powershell: 'Bash',
  read_bash: 'BashOutput',
  read_powershell: 'BashOutput',
  list_bash: 'BashOutput',
  list_powershell: 'BashOutput',
  stop_bash: 'KillShell',
  stop_powershell: 'KillShell',
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
    command: tool === 'Bash' ? str(args.command, args.cmd, args.script, args.input, args.text, args.keys) || '' : '',
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
    fs.appendFileSync(f, JSON.stringify({ ts: nowIso(), hook: path.basename(process.argv[1] || 'unknown', '.js'), hook_event: (inp && inp.event) || null, message: String((e && e.message) || e).slice(0, 300) }) + '\n');
  } catch {
    /* tracing never breaks the hook */
  }
}

// Hooks never break a session: any failure means "do nothing" — and leaves a trace.
// fn gets the normalised input; the event name comes from the payload or argv[2].
// Exit 2 only after a deny; a crash exits 0 (a non-zero preToolUse exit denies in Copilot).
function safe(fn) {
  let inp = { cwd: process.cwd(), event: process.argv[2] || null };
  try {
    inp = normalise(input(), process.argv[2]);
    fn(inp);
  } catch (e) {
    if (process.env.FACTORY_HOOK_DEBUG) process.stderr.write(`inspector hook error: ${e.stack}\n`);
    traceError(inp, e);
  }
  process.exit(process.exitCode === 2 ? 2 : 0);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function context(text) {
  if (text) emit({ additionalContext: text });
}

function deny(reason) {
  emit({ permissionDecision: 'deny', permissionDecisionReason: reason });
  process.stderr.write(`${reason}\n`);
  process.exitCode = 2;
}

// Inside an agent process `factory run` started (FACTORY_RUNNER=1): the inspector's hooks
// load there too, since each agent is a full Copilot session. Inspections and reports are
// the main session's business, so those hooks do nothing in an agent.
function inAgent() {
  return process.env.FACTORY_RUNNER === '1';
}

// The inspector's CLI as an absolute command: a plugin's bin/ is not on PATH in Copilot.
function cliCommand() {
  return `node "${path.join(path.resolve(__dirname, '..'), 'bin', 'factory-inspect')}"`;
}

// A catch-up line the agentStop hook could not show (agentStop output is only
// decision/reason, hooks.md §5.5): kept here until the next hook that can show it.
function unreportedFile(root) {
  return path.join(root, '.factory', 'inspect', 'unreported.json');
}

function stashUnreported(root, line) {
  try {
    const f = unreportedFile(root);
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      list = [];
    }
    list.push(line);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(list.slice(-10)) + '\n');
  } catch {
    /* best effort */
  }
}

function takeUnreported(root) {
  try {
    const f = unreportedFile(root);
    const list = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.rmSync(f, { force: true });
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

module.exports = { safe, emit, context, deny, traceError, normalise, toolName, patchFiles, cliCommand, inAgent, stashUnreported, takeUnreported, EVENTS, TOOLS };
