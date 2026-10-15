'use strict';
// factory run <workflow> — runs the same workflows/*.js scripts the Claude Code Workflow
// tool runs, on the GitHub Copilot CLI. Copilot has no Workflow tool, so this module
// emulates the small Workflow API the scripts use (top-level await and return, globals
// args / agent / pipeline / parallel / phase / log, no Date or Math.random), and each
// agent() call spawns one non-interactive Copilot CLI session as the role's custom agent:
//
//   copilot -p <pointer to the prompt file> --agent factory:<role> [--model <id>]
//           --output-format json -s --no-ask-user
//           --allow-tool=<the role's kinds> --deny-tool=<the rest>   (toolPermissions below)
//           --add-dir <project root> --add-dir <plugin root> [--session-id <uuid>]
//           [policy.copilot.flags…]
//
// Every agent's full prompt is written to a file in the run's scratch folder
// (.factory/scratch/runner/<job>/<run>/) and -p only tells the agent to read it: Windows
// caps a whole command line at 32,767 characters. --add-dir <plugin root> lets an agent
// run `node "<plugin root>/bin/factory" …` headless: Copilot's path permissions apply to
// shell commands too, and -p cannot ask (verified against Copilot CLI 1.0.97).
//
// Flags, from the official docs (gh-docs/content/copilot/…):
//   -p, -s, --agent, --model, --no-ask-user, --output-format json (JSONL), --add-dir:
//     reference/copilot-cli-reference/cli-programmatic-reference.md "Command line options"
//   --session-id (resumes an existing session id; creates one for a new valid UUID), -C,
//     --plugin-dir: reference/copilot-cli-reference/cli-command-reference.md "Command-line options"
//   --allow-tool / --deny-tool with Kind(argument) patterns (shell, write, url, memory; deny
//     always beats allow, repeated flags add up): cli-command-reference.md "Tool permission
//     patterns", cli-programmatic-reference.md "Tools for the --allow-tool option". -p can't
//     ask, so a tool call nothing pre-approves is refused ("Permission denied because no
//     interactive user response was available"). Verified on CLI 1.0.97 with a mock model:
//     a builder edits, creates and runs tests; a reviewer's shell can't commit, touch or
//     sed -i and has no write tool; web_fetch needs url; git push is refused for every role.
//   --agent <plugin>:<agent> works headless for installed plugins: copilot-cli/changelog.md
//     (1.0.81). A custom agent's frontmatter `model` beats --model (programmatic reference,
//     "Model precedence"), so agents/*.md must not pin a model for escalation to work.
//   The JSONL record shape of `-p --output-format json` is not documented; replies are read
//     from `assistant.message` events ({type, data:{content}}), the SDK's session event shape
//     (how-tos/copilot-sdk/features/streaming-events.md), falling back to plain stdout.
//
// The reply is parsed as one JSON object, validated against the item's schema
// (cli/lib/schema.js), corrected once in the same session if it doesn't match, and
// otherwise returned as null — exactly like an agent that returned nothing, so the
// workflow's own retry and degraded handling apply. The envelope goes straight to
// `factory record` in-process.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { fail, deepMerge, exists, writeJson, writeText } = require('../lib/util');
const { pluginPath, taskWorktree, PLUGIN_ROOT } = require('../lib/paths');
const { validate } = require('../lib/schema');
const events = require('./events');

const WORKFLOWS = ['ground', 'fanout-judge', 'decompose', 'realize', 'reconcile'];
const MAX_OUTPUT = 32 * 1024 * 1024;

// Aliases used by policy.agents.models / builder_escalation → Copilot model ids. Defaults
// (policy/default-policy.json agents.model_ids) come from the "Supported models" table in
// gh-docs/content/copilot/reference/copilot-cli-reference/cli-command-reference.md
// (claude-opus-5.5, claude-sonnet-5.5 — the CLI default —, claude-haiku-5.5).
function modelId(map, alias) {
  if (!alias) return null;
  return (map && map[alias]) || alias; // an unknown alias is taken as a Copilot model id already
}

function settings(root, state) {
  const live = require('./policy').load(root);
  const pol = deepMerge(live, state.policy || {}); // the job's snapshot wins; new keys come from the live policy
  const num = (v, d) => (typeof v === 'number' && v > 0 ? v : d);
  const cp = pol.copilot || {};
  return {
    bin: process.env.COPILOT_BIN || 'copilot',
    maxParallel: num((pol.limits || {}).max_parallel_agents, 4),
    modelIds: (pol.agents || {}).model_ids || {},
    timeoutSec: num(cp.agent_timeout_seconds, 1800),
    resumeForRetry: cp.resume_for_retry !== false,
    copilot: cp,
    flags: (Array.isArray(cp.flags) ? cp.flags : []).map((f) => String(f).replace(/\{plugin_root\}/g, PLUGIN_ROOT).replace(/\{root\}/g, root)),
  };
}

// ---------------------------------------------------------------- the Workflow API

function loadScript(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/^export const meta =/m, 'const meta =');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('args', 'agent', 'pipeline', 'parallel', 'phase', 'log', 'Date', 'Math', 'require', 'process', src);
}

function mathNoRandom() {
  const m = {};
  for (const k of Object.getOwnPropertyNames(Math)) m[k] = Math[k];
  m.random = () => {
    throw new Error('Math.random is not allowed in workflows');
  };
  return m;
}

async function execute(file, args, api) {
  const fn = loadScript(file);
  const forbidden = new Proxy(function () {}, {
    get: () => () => {
      throw new Error('Date is not allowed in workflows');
    },
    construct: () => {
      throw new Error('Date is not allowed in workflows');
    },
  });
  const noFs = () => {
    throw new Error('Workflows cannot require modules (no fs, no shell)');
  };
  const pipeline = async (items, f) => Promise.all(items.map((it, i) => f(it, i)));
  const parallel = async (thunks) => Promise.all(thunks.map((t) => (typeof t === 'function' ? t() : t)));
  return fn(args, api.agent, pipeline, parallel, api.phase, api.log, forbidden, mathNoRandom(), noFs, undefined);
}

// ---------------------------------------------------------------- replies

// The final assistant text from `--output-format json` JSONL, or the plain stdout.
function replyText(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const evs = [];
  for (const l of lines) {
    if (l[0] !== '{') continue;
    try {
      const o = JSON.parse(l);
      if (o && typeof o === 'object' && typeof o.type === 'string') evs.push(o);
    } catch {
      /* not a JSONL record */
    }
  }
  if (!evs.length) return String(stdout || '');
  const content = (e) => (e.data && typeof e.data.content === 'string' ? e.data.content : typeof e.content === 'string' ? e.content : null);
  const top = (e) => !(e.agentId || (e.data && (e.data.agentId || e.data.parentToolCallId)));
  const msgs = evs.filter((e) => e.type === 'assistant.message' && top(e) && content(e) && content(e).trim());
  if (msgs.length) return content(msgs[msgs.length - 1]);
  const any = evs.filter((e) => content(e) && content(e).trim());
  if (any.length) return content(any[any.length - 1]);
  return String(stdout || '');
}

// Balanced {...} spans, string-aware, in order of appearance.
function objectSpans(text) {
  const spans = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (c === '\\') j += 1;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          spans.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return spans;
}

// One JSON object from a reply: the whole text, else the last fenced block, else the last
// balanced object that parses. Null when there is none.
function extractJson(text) {
  const t = String(text || '').trim();
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return isObj(v) ? v : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(t);
  if (whole) return whole;
  const fences = [...t.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (let i = fences.length - 1; i >= 0; i--) {
    const v = tryParse(fences[i].trim());
    if (v) return v;
  }
  const spans = objectSpans(t);
  for (let i = spans.length - 1; i >= 0; i--) {
    const v = tryParse(spans[i]);
    if (v) return v;
  }
  return null;
}

function check(schema, text) {
  const obj = extractJson(text);
  if (!obj) return { obj: null, errors: ['the reply contains no JSON object'] };
  const errors = schema ? validate(schema, obj) : [];
  return { obj: errors.length ? null : obj, errors };
}

const replyBlock = (schema) =>
  ['', '', '## Reply format (strict)', 'Reply with only one JSON object that matches this JSON Schema: no prose, no markdown fences, nothing before or after it.', JSON.stringify(schema || { type: 'object' })].join('\n');

const correction = (schema, errors) =>
  [
    'Your last reply was not one JSON object matching the required schema:',
    ...errors.slice(0, 12).map((e) => `- ${e}`),
    '',
    'Do not redo the work. Reply again with only the corrected JSON object — no prose, no markdown fences — matching this JSON Schema:',
    JSON.stringify(schema || { type: 'object' }),
  ].join('\n');

// ---------------------------------------------------------------- spawning Copilot

// The folders an agent may touch besides its cwd: the project (job folder, briefs, prompt
// files) and the plugin (bin/factory, templates). Copilot also allows the system temp dir.
function addDirs(root) {
  const dirs = [path.resolve(root)];
  const plugin = path.resolve(PLUGIN_ROOT);
  if (!dirs.includes(plugin)) dirs.push(plugin);
  return dirs;
}

// ---------------------------------------------------------------- tool permissions

// Each agent gets pre-approval only for the kinds of tool its `tools:` list gives it, derived
// from agents/<role>.agent.md at run time (so a change to a role's tools changes its flags):
//   execute → shell          edit → write          web / web_fetch → url
// and an explicit deny for every kind it does not have. Shell is the hole in "read-only":
// a reviewer runs tests, and a test runner can write. So read-only roles also get a deny
// list of the shell commands that change the repo or its history; that is defence in depth
// (with the guard hook and `factory record` re-checking everything), not a sandbox.
const NEVER_SHELL = ['git push', 'gh']; // no agent pushes or talks to GitHub: ship is the CLI's
const READ_ONLY_SHELL = [
  'git commit', 'git add', 'git rm', 'git mv', 'git reset', 'git checkout', 'git switch', 'git restore',
  'git merge', 'git rebase', 'git cherry-pick', 'git revert', 'git stash', 'git clean', 'git apply', 'git am',
  'git tag', 'git worktree', 'git update-ref', 'git config',
  'rm', 'rmdir', 'mv', 'cp', 'touch', 'mkdir', 'tee', 'truncate', 'dd', 'chmod', 'chown', 'ln',
  'sed -i', 'perl -i', 'npm install', 'npm i', 'npm uninstall', 'npm publish', 'yarn add', 'pnpm add', 'pip install',
];
const shellRule = (stem) => [`shell(${stem})`, `shell(${stem}:*)`]; // the bare command, and with arguments

function agentTools(role) {
  for (const f of [pluginPath('agents', `${role}.agent.md`), pluginPath('agents', `${role}.md`)]) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const line = fm && /^tools:\s*(.+)$/m.exec(fm[1]);
    if (!line) return [];
    try {
      const v = JSON.parse(line[1].trim());
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return line[1].replace(/[[\]"']/g, '').split(',').map((t) => t.trim()).filter(Boolean);
    }
  }
  return [];
}

// { allow: [...], deny: [...] } for one role. policy.copilot.allow_tools / deny_tools
// ({ "<role>" | "*": [pattern…] }) add patterns; policy.copilot.permissions "allow-all"
// restores the old --allow-all-tools (deny patterns from the policy still apply).
function toolPermissions(role, tools, cp = {}) {
  const has = (...names) => names.some((n) => tools.includes(n));
  const extra = (key) => {
    const m = cp[key] && typeof cp[key] === 'object' ? cp[key] : {};
    return [...(Array.isArray(m['*']) ? m['*'] : []), ...(Array.isArray(m[role]) ? m[role] : [])].map(String);
  };
  const shell = has('execute', 'shell', 'bash');
  const write = has('edit', 'write', 'create');
  const web = has('web', 'web_fetch');
  if (cp.permissions === 'allow-all') return { allowAll: true, allow: extra('allow_tools'), deny: extra('deny_tools'), shell, write, web };
  const allow = [...(shell ? ['shell'] : []), ...(write ? ['write'] : []), ...(web ? ['url'] : []), ...extra('allow_tools')];
  const deny = [
    'memory',
    ...(shell ? NEVER_SHELL.flatMap(shellRule) : ['shell']),
    ...(write ? [] : ['write']),
    ...(web ? [] : ['url']),
    ...(shell && !write ? READ_ONLY_SHELL.flatMap(shellRule) : []),
    ...extra('deny_tools'),
  ];
  return { allowAll: false, allow: [...new Set(allow)], deny: [...new Set(deny)], shell, write, web };
}

const permissionArgs = (perm) =>
  !perm
    ? ['--allow-all-tools'] // no role given (only a caller outside the runner): the old behaviour
    : [
        ...(perm.allowAll ? ['--allow-all-tools'] : []),
        ...perm.allow.map((p) => `--allow-tool=${p}`),
        ...perm.deny.map((p) => `--deny-tool=${p}`),
      ];

function copilotArgs({ prompt, agentType, model, root, sessionId, flags, permissions }) {
  return [
    '-p', prompt,
    '--agent', agentType,
    ...(model ? ['--model', model] : []),
    '--output-format', 'json',
    '-s',
    '--no-ask-user',
    ...permissionArgs(permissions),
    ...addDirs(root).flatMap((d) => ['--add-dir', d]),
    ...(sessionId ? ['--session-id', sessionId] : []),
    ...flags,
  ];
}

// How to start the Copilot CLI: [file, leading args, shell]. A .js entry point runs on this
// Node. On Windows, `npm install -g @github/copilot` installs copilot.cmd, which Node can't
// spawn without a shell (ENOENT through PATHEXT, EINVAL for .cmd since Node 18.20.2/20.12.2):
// the npm shim's JavaScript target (npm-loader.js) is run with Node instead, and only an
// unknown .cmd/.bat falls back to a shell. copilot.exe (WinGet) is spawned directly.
function resolveBin(bin, { platform = process.platform, env = process.env, existsFn = exists, readFn = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const b = String(bin || 'copilot');
  if (/\.[cm]?js$/i.test(b)) return { file: process.execPath, pre: [b], shell: false };
  if (platform !== 'win32') return { file: b, pre: [], shell: false };
  const P = path.win32;
  const exts = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const hasDir = /[\\/]/.test(b);
  const hasExt = Boolean(P.extname(b));
  const dirs = hasDir ? [''] : String(env.PATH || env.Path || '').split(';').filter(Boolean);
  let found = null;
  for (const d of dirs) {
    const base = d ? P.join(d, b) : b;
    const cands = hasExt ? [base] : exts.map((e) => base + e);
    found = cands.find((c) => existsFn(c)) || null;
    if (found) break;
  }
  if (!found) return { file: b, pre: [], shell: false }; // spawn reports ENOENT → copilot_unavailable
  if (!/\.(cmd|bat)$/i.test(found)) return { file: found, pre: [], shell: false };
  const dir = P.dirname(found);
  let js = null;
  try {
    const m = /"%~?dp0%?\\?([^"%]+?\.[cm]?js)"/i.exec(readFn(found));
    if (m && existsFn(P.join(dir, m[1]))) js = P.join(dir, m[1]);
  } catch {
    js = null;
  }
  const loader = P.join(dir, 'node_modules', '@github', 'copilot', 'npm-loader.js');
  if (!js && existsFn(loader)) js = loader;
  if (js) return { file: process.execPath, pre: [js], shell: false };
  return { file: found, pre: [], shell: true };
}

// cmd.exe quoting for the shell fallback (the prompt is a short pointer, never the prompt).
const cmdQuote = (a) => `"${String(a).replace(/"/g, '""')}"`;

function command(bin, argv, opts) {
  const r = resolveBin(bin, opts);
  if (r.shell) return [[r.file, ...r.pre, ...argv].map((a) => cmdQuote(String(a).replace(/\r?\n/g, ' '))).join(' '), [], true]; // cmd.exe ends a command at a newline
  return [r.file, [...r.pre, ...argv], false];
}

function spawnCopilot(bin, argv, { cwd, env, timeoutSec }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const [file, args, shell] = command(bin, argv);
    let out = '';
    let err = '';
    let timedOut = false;
    let done = false;
    let child;
    const finish = (code, signal, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code === null || code === undefined ? -1 : code, signal: signal || null, stdout: out, stderr: err + extra, ms: Date.now() - started, timedOut });
    };
    try {
      child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], ...(shell ? { shell: true, windowsVerbatimArguments: true } : {}) });
    } catch (e) {
      resolve({ code: -1, signal: null, stdout: '', stderr: e.message, ms: 0, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutSec * 1000);
    child.stdout.on('data', (d) => {
      if (out.length < MAX_OUTPUT) out += d;
    });
    child.stderr.on('data', (d) => {
      if (err.length < MAX_OUTPUT) err += d;
    });
    child.on('error', (e) => finish(-1, null, `\n${e.message}`));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active += 1;
    const { fn, res, rej } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(res, rej)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((res, rej) => {
      queue.push({ fn, res, rej });
      next();
    });
}

const roleOf = (agentType) => String(agentType || '').replace(/^factory:/, '');

function agentFileExists(role) {
  return exists(pluginPath('agents', `${role}.agent.md`)) || exists(pluginPath('agents', `${role}.md`));
}

// Builders and testers work in their task's worktree (realize labels: "build T1 #2", "test T1").
function cwdFor(ctx, opts, { prepare }) {
  const b = ctx.brief;
  if (b.workflow !== 'realize') return ctx.root;
  const m = /^(build|test) (\S+)/.exec(opts.label || '');
  if (!m || !b.tasks || !b.tasks[m[2]]) return ctx.root;
  const wt = b.tasks[m[2]].worktree || taskWorktree(ctx.root, b.job, m[2]);
  if (!prepare || exists(path.join(wt, '.git'))) return wt;
  // Never fall back to the project root: a builder there would build in the root checkout.
  try {
    return require('./tasks').prepareWorktree(ctx.root, ctx.state, m[2]);
  } catch (e) {
    return { error: `could not prepare the worktree for ${m[2]}: ${e.message}` };
  }
}

// Every prompt goes through a file in the run's scratch folder (inside the project, which
// every agent may read); -p carries only this pointer, so no command line gets long.
function promptFile(ctx, label) {
  ctx.files += 1;
  return path.join(ctx.scratch, `${String(ctx.files).padStart(3, '0')}-${String(label).replace(/[^\w.-]+/g, '_').slice(0, 60)}.md`);
}

const pointer = (file, retry) =>
  retry
    ? `Your last reply did not have the required format. Read this file and follow it exactly:\n  ${file}\nReply with only the corrected JSON object.`
    : `Your full instructions for this run are in this file. Read all of it first and follow it exactly:\n  ${file}\nFinish by replying with only the JSON object it asks for.`;

function deliverable(ctx, prompt, label, retry = false) {
  const file = promptFile(ctx, label);
  writeText(file, prompt);
  return pointer(file, retry);
}

// Copilot can't run at all: not installed (spawn ENOENT/EACCES/EINVAL) or not signed in.
// Its first such failure aborts the run instead of being recorded as a degraded result.
const AUTH_TEXT = /No authentication information found|Authentication token found but could not be validated|To authenticate, you can use any of the following methods|not (?:logged|signed) in to (?:GitHub )?Copilot/i;
function unavailable(r) {
  const text = `${r.stderr || ''}\n${r.stdout || ''}`;
  if (r.code === -1 && !r.timedOut && /\b(ENOENT|EACCES|EINVAL|EPERM)\b/.test(text)) return { why: 'not_found', detail: text.trim().split('\n').pop().slice(0, 200) };
  if (r.code !== 0 && AUTH_TEXT.test(text)) return { why: 'not_signed_in', detail: (text.match(AUTH_TEXT) || [''])[0] };
  return null;
}

async function runAgent(ctx, prompt, opts) {
  const o = opts || {};
  const agentType = o.agentType;
  const role = roleOf(agentType);
  if (!/^factory:[a-z-]+$/.test(agentType || '') || !agentFileExists(role)) {
    throw new Error(`agent() called without a real factory agentType (got ${JSON.stringify(agentType)}) for "${o.label}"`);
  }
  const S = ctx.settings;
  const model = modelId(S.modelIds, o.model);
  // the workflow run and the step (phase) in force when agent() was called, for the console's step list
  const wf = ctx.wfRun ? { wf_run: ctx.wfRun, step: typeof ctx.phaseIndex === 'number' ? ctx.phaseIndex : -1 } : {};
  // A time cap from the workflow (opts.timeoutSec: clarify's scout budget) counts from the
  // call, not from the spawn: time spent waiting for a free slot is part of the budget, and
  // an agent whose budget ran out while it waited is not started at all (outcome timeout).
  const capSec = typeof o.timeoutSec === 'number' && o.timeoutSec > 0 ? Math.min(o.timeoutSec, S.timeoutSec) : null;
  const deadline = capSec ? Date.now() + capSec * 1000 : null;
  const left = () => (deadline ? Math.floor((deadline - Date.now()) / 1000) : S.timeoutSec);
  return ctx.limit(async () => {
    const cwd = cwdFor(ctx, o, { prepare: true });
    if (cwd && cwd.error) {
      const rec = { label: o.label || role, role, agent_type: agentType, model: o.model || null, model_id: model, cwd: null, ms: 0, exit: null, retry: false, spawns: 0, outcome: 'error', code: 'no_worktree', errors: [`${cwd.error}; not started (a task agent never runs at the project root)`] };
      ctx.runs.push(rec);
      events.append(ctx.root, { event: 'agent_run', job: ctx.brief.job, decision_id: ctx.decisionId, workflow: ctx.brief.workflow, config: ctx.brief.config || null, ...wf, ...rec });
      ctx.note(`${rec.label} (${agentType}) not started: ${cwd.error}`);
      return null;
    }
    if (deadline && left() < 5) {
      const rec = { label: o.label || role, role, agent_type: agentType, model: o.model || null, model_id: model, cwd, ms: 0, exit: null, retry: false, spawns: 0, outcome: 'timeout', time_cap_sec: capSec, errors: [`its ${capSec}s time budget ran out before a slot was free; not started`] };
      ctx.runs.push(rec);
      events.append(ctx.root, { event: 'agent_run', job: ctx.brief.job, decision_id: ctx.decisionId, workflow: ctx.brief.workflow, config: ctx.brief.config || null, ...wf, ...rec });
      ctx.say(`${rec.label} (${agentType}) not started: time budget spent while queued`);
      return null;
    }
    const sessionId = S.resumeForRetry ? crypto.randomUUID() : null;
    const perm = toolPermissions(role, agentTools(role), S.copilot);
    // agent_start now, agent_run (same run_id) when it ends: the console shows the agent as
    // at work in between. No hook does this: each agent is its own `copilot -p` process, not a
    // subagent, so SubagentStart/SubagentStop never fire for it.
    const runId = crypto.randomUUID();
    const env = { ...process.env, FACTORY_ROOT: ctx.root, FACTORY_RUNNER: '1', FACTORY_JOB: ctx.brief.job, FACTORY_AGENT_ROLE: role, FACTORY_AGENT_LABEL: o.label || role };
    const closeUnavailable = (detail, r) => events.append(ctx.root, { event: 'agent_run', run_id: runId, job: ctx.brief.job, decision_id: ctx.decisionId, workflow: ctx.brief.workflow, config: ctx.brief.config || null, ...wf, agent_type: agentType, label: o.label || role, role, cwd, ms: r ? r.ms : 0, exit: r ? r.code : null, outcome: 'copilot_unavailable', code: 'copilot_unavailable', errors: [detail] });
    const spawnOnce = async (text, retryTurn = false) => {
      if (ctx.unavailable) {
        if (retryTurn) closeUnavailable(ctx.unavailable.detail); // its first turn already started it
        throw new Error(`Copilot CLI unavailable: ${ctx.unavailable.detail}`);
      }
      if (!retryTurn) events.append(ctx.root, { event: 'agent_start', run_id: runId, job: ctx.brief.job, decision_id: ctx.decisionId, workflow: ctx.brief.workflow, config: ctx.brief.config || null, ...wf, agent_type: agentType, label: o.label || role, role, model: o.model || null, model_id: model, pid: process.pid });
      const r = await spawnCopilot(S.bin, copilotArgs({ prompt: deliverable(ctx, text, `${o.label || role}${retryTurn ? ' (format)' : ''}`, retryTurn), agentType, model, cwd, root: ctx.root, sessionId, flags: S.flags, permissions: perm }), { cwd, env, timeoutSec: Math.max(1, left()) });
      const u = unavailable(r);
      if (u) {
        closeUnavailable(u.detail, r); // closes this agent's agent_start
        ctx.unavailable = ctx.unavailable || { ...u, label: o.label || role };
        throw new Error(`Copilot CLI unavailable: ${u.detail}`);
      }
      return r;
    };
    const full = `${prompt}${replyBlock(o.schema)}`;
    const runs = [await spawnOnce(full)];
    let result = null;
    let errors = [];
    let retry = false;
    const ok = (r) => r.code === 0 && !r.timedOut;
    if (ok(runs[0])) {
      const c = check(o.schema, replyText(runs[0].stdout));
      result = c.obj;
      errors = c.errors;
      if (!result && (!deadline || left() >= 5)) {
        retry = true;
        const fix = correction(o.schema, errors);
        runs.push(await spawnOnce(S.resumeForRetry ? fix : `${full}\n\n${fix}`, true));
        const last = runs[1];
        if (ok(last)) {
          const c2 = check(o.schema, replyText(last.stdout));
          result = c2.obj;
          errors = c2.errors;
        }
      }
    }
    const last = runs[runs.length - 1];
    const outcome = result ? 'ok' : last.timedOut ? 'timeout' : last.code !== 0 ? 'failed' : 'invalid';
    const rec = {
      label: o.label || role,
      role,
      agent_type: agentType,
      model: o.model || null,
      model_id: model,
      cwd,
      ms: runs.reduce((s, r) => s + r.ms, 0),
      exit: last.code,
      retry,
      spawns: runs.length,
      outcome,
      ...(capSec ? { time_cap_sec: capSec } : {}),
      ...(result && typeof result.verdict === 'string' ? { verdict: result.verdict } : {}), // god-eye's approve/revise, for telemetry
      ...(result ? {} : { errors: (last.code !== 0 || last.timedOut ? [last.timedOut ? `timed out after ${capSec || S.timeoutSec}s` : `exit ${last.code}: ${String(last.stderr || '').trim().slice(-300)}`] : errors).slice(0, 5) }),
    };
    ctx.runs.push(rec);
    events.append(ctx.root, {
      event: 'agent_run',
      run_id: runId,
      job: ctx.brief.job,
      decision_id: ctx.decisionId,
      workflow: ctx.brief.workflow,
      config: ctx.brief.config || null,
      ...wf,
      agent_type: agentType,
      ...rec,
    });
    ctx.say(`${rec.label} (${agentType}${model ? `, ${model}` : ''}) ${outcome}${retry ? ' after a format retry' : ''} in ${(rec.ms / 1000).toFixed(1)}s`);
    return result;
  });
}

// ---------------------------------------------------------------- dry run

// Every agent the brief names, with the command the first attempt would run.
function plannedAgents(ctx) {
  const b = ctx.brief;
  const S = ctx.settings;
  const items = [];
  const add = (label, spec, prompt, schema) => {
    const model = modelId(S.modelIds, spec.model);
    const cwd = cwdFor(ctx, { label }, { prepare: false });
    const full = `${prompt}${replyBlock(schema)}`;
    const file = promptFile(ctx, label); // the path the real run would write; nothing is written here
    const role = roleOf(spec.agent_type);
    const tools = agentTools(role);
    const perm = toolPermissions(role, tools, S.copilot);
    const argv0 = copilotArgs({ prompt: pointer(file), agentType: spec.agent_type, model, cwd, root: ctx.root, sessionId: S.resumeForRetry ? '<uuid>' : null, flags: S.flags, permissions: perm });
    const [exe, argv] = command(S.bin, argv0);
    items.push({ label, agent_type: spec.agent_type, model: spec.model || null, model_id: model, cwd, prompt_file: file, prompt: full, tools, permissions: { allow: perm.allow, deny: perm.deny, allow_all: perm.allowAll }, command: [S.bin, ...argv0], spawn: [exe, ...argv] });
  };
  if (b.workflow === 'realize') {
    for (const id of Object.keys(b.tasks || {})) {
      const t = b.tasks[id];
      add(`build ${id} #1`, t.builder, t.builder_prompt.replace('{{attempt}}', '1').replace('{{failures}}', '  - (none)'), b.builder_schema);
      add(`test ${id}`, t.tester, t.tester_prompt.replace('{{swept}}', '(from the builder)'), b.tester_schema);
    }
    return items;
  }
  const walk = (v, key) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${key}[${i}]`));
    if (typeof v.agent_type === 'string' && (typeof v.prompt === 'string' || typeof v.prompt_template === 'string')) add(v.label || v.id || key, v, v.prompt || v.prompt_template, v.schema);
    for (const [k, x] of Object.entries(v)) if (k !== 'schema' && x && typeof x === 'object') walk(x, key ? `${key}.${k}` : k);
  };
  walk(b, '');
  return items;
}

// ---------------------------------------------------------------- run

function logCli(root, rec) {
  const ctx = events.context(root, rec.job);
  events.append(root, { event: 'cli', arg: null, how: ctx.how, decision_id: ctx.decision_id, ok: true, code: null, via: 'run', ...rec });
}

function readEvents(root) {
  try {
    return fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// What the router last asked for, as `factory run` arguments: { workflow, config } or null.
function askedFor(d) {
  if (!d) return null;
  if (d.action === 'workflow' && d.workflow) return { workflow: d.workflow, config: d.config || null };
  if (d.action === 'skill' && d.skill === 'clarify') return { workflow: 'fanout-judge', config: 'clarify' }; // the clarify skill's round
  return null;
}

// A workflow runs only when `factory next` asked for exactly it, on an active job with no
// gate pending, and its result hasn't been recorded for that decision yet (a degraded or
// stale result may be run again, e.g. with --accept-degraded).
function preflight(root, state, workflow, config) {
  const refuse = (message, reason, extra = {}) => fail(`${message} Nothing was started.`, 'not_waiting_for_workflow', { reason, job: state.id, ...extra });
  if (state.status !== 'active') {
    refuse(state.status === 'parked' ? `${state.id} is parked (${(state.park && state.park.reason) || 'see factory next'}); only your reply ("resume", "cancel job", "abandon job") moves it.` : `${state.id} is ${state.status}.`, state.status);
  }
  if (state.pending_gate) {
    refuse(`${state.id} is waiting at gate ${state.pending_gate.id} for your reply; run factory next and present the gate instead.`, 'gate_pending', { gate: state.pending_gate.id });
  }
  const d = state.last_decision_id ? require('./decisions').forJob(root, state.id).find((x) => x.id === state.last_decision_id) : null;
  const want = askedFor(d);
  const got = { workflow, config: config || null };
  if (!want || want.workflow !== got.workflow || want.config !== got.config) {
    const said = !d ? 'nothing yet' : want ? `factory run ${want.workflow}${want.config ? ` --config ${want.config}` : ''}` : `${d.action} "${d.step || d.skill || d.command || ''}"`;
    refuse(`factory next did not ask for factory run ${workflow}${config ? ` --config ${config}` : ''} (its last decision${d ? ` ${d.id}` : ''} says ${said}). Run factory next and do what it says.`, 'not_asked', { decision_id: d ? d.id : null, expected: want });
  }
  const done = readEvents(root).filter((e) => e.event === 'cli' && e.cmd === 'record' && e.decision_id === d.id && e.ok !== false && !['degraded', 'stale'].includes(e.status));
  if (done.length) {
    refuse(`This workflow's result is already recorded for decision ${d.id} (status ${done[done.length - 1].status || 'unknown'}). Run factory next for the next step.`, 'already_recorded', { decision_id: d.id });
  }
  return d;
}

// One `factory run` per job at a time: .factory/jobs/<J>/run.lock holds the pid and start
// time; a lock whose process is gone (or is no longer a factory process) is stale.
function lockAlive(lock) {
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return false;
  if (lock.host && lock.host !== require('os').hostname()) return true; // another machine: can't tell, assume live
  try {
    process.kill(lock.pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${lock.pid}/cmdline`, 'utf8');
    if (cmdline && !/factory|node/.test(cmdline)) return false; // the pid was reused
  } catch {
    /* no /proc (macOS, Windows): trust the pid */
  }
  return true;
}

function acquireLock(root, state, info) {
  const file = path.join(require('../lib/paths').jobPaths(root, state.id).dir, 'run.lock');
  const body = JSON.stringify({ pid: process.pid, host: require('os').hostname(), started_at: new Date().toISOString(), ...info });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return {
        file,
        release: () => {
          try {
            if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file, { force: true });
          } catch {
            /* already gone */
          }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let held = null;
    try {
      held = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      held = null;
    }
    if (held && lockAlive(held)) {
      fail(`Another factory run (${held.workflow || 'workflow'}${held.config ? ` --config ${held.config}` : ''}, pid ${held.pid}, started ${held.started_at}) is still running for ${state.id}. Wait for it to finish and read its output; don't start it again.`, 'run_in_progress', { lock: file, ...held });
    }
    fs.rmSync(file, { force: true }); // stale: its process is gone
  }
  fail(`Could not take the run lock ${file}.`, 'run_in_progress', { lock: file });
}

function copilotUnavailable(ctx) {
  const u = ctx.unavailable;
  const how = u.why === 'not_signed_in'
    ? 'The Copilot CLI is not signed in. Run `copilot` in a terminal and use /login (or set COPILOT_GITHUB_TOKEN), then run factory next.'
    : `The Copilot CLI could not be started as "${ctx.settings.bin}". Install it (npm install -g @github/copilot, or see the Copilot CLI docs), make sure it is on PATH or set COPILOT_BIN, then run factory next.`;
  fail(`${how} (${u.detail}) Nothing was recorded.`, 'copilot_unavailable', { why: u.why, detail: u.detail, copilot: ctx.settings.bin, agents: ctx.runs });
}

async function run(root, { jobId, workflow, config, mode, scope, lanes, threatModel, planCritique, acceptDegraded, dryRun = false, quiet = false }) {
  if (!WORKFLOWS.includes(workflow)) fail(`factory run <${WORKFLOWS.join('|')}> (got ${workflow || 'nothing'})`, 'bad_input');
  const job = require('./job');
  let state = job.resolve(root, jobId);
  const say = (m) => {
    if (!quiet) process.stderr.write(`[factory run] ${m}\n`);
  };
  if (dryRun) {
    let check = { ok: true };
    try {
      preflight(root, state, workflow, config);
    } catch (e) {
      check = { ok: false, code: e.code, message: e.message };
    }
    const brief = require('./wfargs').build(root, { jobId: state.id, workflow, config, mode, scope, lanes, threatModel, planCritique, acceptDegraded });
    const S = settings(root, state);
    const ctx = { root, state, brief, settings: S, files: 0, scratch: path.join(root, '.factory', 'scratch', 'runner', state.id, '<run>') };
    return { dry_run: true, job: state.id, workflow, config: brief.config || null, copilot: S.bin, max_parallel_agents: S.maxParallel, preflight: check, brief, agents: plannedAgents(ctx) };
  }

  const lock = acquireLock(root, state, { workflow, config: config || null });
  try {
    state = job.resolve(root, state.id);
    const decision = preflight(root, state, workflow, config);
    const brief = require('./wfargs').build(root, { jobId: state.id, workflow, config, mode, scope, lanes, threatModel, planCritique, acceptDegraded });
    const S = settings(root, state);
    const t0 = Date.now();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    const ctx = {
      root,
      state,
      brief,
      settings: S,
      runs: [],
      phases: [],
      notes: [],
      files: 0,
      unavailable: null,
      scratch: path.join(root, '.factory', 'scratch', 'runner', state.id, `${stamp}-${workflow}${brief.config ? `-${brief.config}` : ''}-${process.pid}`),
      decisionId: decision.id,
      limit: limiter(S.maxParallel),
      say,
      note: (m) => {
        ctx.notes.push(m);
        say(m);
      },
    };

    const args = {};
    for (const [k, v] of Object.entries({ config, mode, scope, lanes, 'threat-model': threatModel, 'plan-critique': planCritique, 'accept-degraded': acceptDegraded || undefined })) if (v !== undefined && v !== null) args[k] = v;
    logCli(root, { cmd: 'wfargs', sub: workflow, args, job: state.id, workflow, config: brief.config || config || null, mode: brief.mode || null, brief_hash: brief.input_hash || null });

    // The run's boundaries and each step as it starts, in the event log while the run is live, so
    // the console can show where the workflow is (run-steps.js). Observation only: append never throws.
    ctx.wfRun = crypto.randomUUID();
    ctx.phaseIndex = -1;
    const wfBase = { wf_run: ctx.wfRun, job: state.id, decision_id: decision.id, workflow, config: brief.config || null };
    events.append(root, { event: 'workflow_start', ...wfBase, mode: brief.mode || null, round: typeof brief.round === 'number' ? brief.round : null, pid: process.pid });
    const wfEnd = (rec) => events.append(root, { event: 'workflow_end', ...wfBase, ms: Date.now() - t0, phases: ctx.phases.length, agents: ctx.runs.length, ...rec });
    const api = {
      agent: (prompt, opts) => runAgent(ctx, prompt, opts),
      phase: (m) => {
        ctx.phases.push(String(m));
        ctx.phaseIndex = ctx.phases.length - 1;
        events.append(root, { event: 'workflow_phase', ...wfBase, text: String(m), index: ctx.phaseIndex });
        say(`phase: ${m}`);
      },
      log: (m) => {
        ctx.notes.push(String(m));
        say(String(m));
      },
    };
    let envelope;
    try {
      envelope = await execute(pluginPath('workflows', `${workflow}.js`), JSON.stringify(brief), api);
    } catch (e) {
      wfEnd({ outcome: 'failed', status: null, error: ctx.unavailable ? `copilot unavailable: ${ctx.unavailable.detail}` : String(e.message).slice(0, 300) });
      if (ctx.unavailable) copilotUnavailable(ctx);
      fail(`The ${workflow} workflow failed: ${e.message}`, 'workflow_failed', { agents: ctx.runs });
    }
    if (ctx.unavailable) {
      wfEnd({ outcome: 'failed', status: null, error: `copilot unavailable: ${ctx.unavailable.detail}` });
      copilotUnavailable(ctx);
    }
    wfEnd({ outcome: 'ok', status: (envelope && envelope.status) || null });
    const file = path.join(root, '.factory', 'scratch', 'runs', `${state.id}-${workflow}${brief.config ? `-${brief.config}` : ''}-${Date.now()}.json`);
    writeJson(file, envelope);

    let rec;
    try {
      rec = require('./record').apply(root, { jobId: state.id, envelope });
    } catch (e) {
      logCli(root, { cmd: 'record', sub: null, args: { file }, job: state.id, ok: false, code: e.code || 'internal', workflow: envelope && envelope.workflow, config: (envelope && envelope.config) || null, status: null });
      throw e;
    }
    logCli(root, { cmd: 'record', sub: null, args: { file }, job: state.id, workflow: envelope.workflow, config: envelope.config || null, status: rec.status || null });
    // The recorded result is what to act on (its status, questions, critique, problems…);
    // the workflow's own envelope status and summary are nested under `workflow`.
    const { job: _j, workflow: _w, config: _c, ...result } = rec;
    const out = {
      job: state.id,
      ...result,
      workflow: { name: workflow, config: brief.config || null, mode: brief.mode || null, status: envelope.status, summary: envelope.summary, ms: Date.now() - t0, envelope_file: file, phases: ctx.phases, notes: ctx.notes },
      decision_id: decision.id,
      copilot: S.bin,
      max_parallel_agents: S.maxParallel,
      agents: ctx.runs,
    };
    const resultFile = file.replace(/\.json$/, '.result.json');
    out.result_file = resultFile;
    writeJson(resultFile, out);
    return out;
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------- factory distill write

// The lesson-writer's reply when `factory distill write` starts it.
const LESSON_REPLY = require('../../schemas/agent-outputs/lessons.json');

// `factory distill write`: runs the lesson-writer as its own Copilot session (copilot -p
// --agent factory:lesson-writer, the same flags, add-dirs, model mapping and FACTORY_*
// environment as `factory run`), so distill works from any harness — VS Code's Local
// harness can't start a plugin agent through the task tool. Only when `factory next` asked
// for the distill step; skipped (no agent) when the job left nothing to learn from. The
// lessons are recorded by the agent itself (`factory lessons add`, the one write its role
// may make); this command reports the ones that appeared and logs a distill_write event.
async function distillWrite(root, { jobId, quiet = false } = {}) {
  const job = require('./job');
  const lessons = require('./lessons');
  let state = job.resolve(root, jobId);
  const say = (m) => {
    if (!quiet) process.stderr.write(`[factory distill] ${m}\n`);
  };
  if (state.status !== 'active') fail(`${state.id} is ${state.status}; nothing to distill. Nothing was started.`, 'not_waiting_for_distill');
  const d = state.last_decision_id ? require('./decisions').forJob(root, state.id).find((x) => x.id === state.last_decision_id) : null;
  if (!d || d.action !== 'skill' || d.skill !== 'distill') fail(`factory next did not ask for distill (its last decision${d ? ` ${d.id}` : ''} says ${d ? `${d.action} "${d.step || d.skill || d.command || ''}"` : 'nothing yet'}). Run factory next and do what it says. Nothing was started.`, 'not_waiting_for_distill', { decision_id: d ? d.id : null });
  const context = require('./lifecycle').distillContext(root, { jobId: state.id });
  const before = new Set(lessons.load(root).lessons.map((l) => l.id));
  const worth = context.confirmed.length || context.verify_fix_rounds || (context.minor.length && context.minor_in_other_jobs.length);
  const left = Math.max(0, (context.cap || 0) - context.already_proposed.length);
  const log = (rec) => events.append(root, { event: 'distill_write', job: state.id, decision_id: d.id, ...rec });
  if (!worth || !left) {
    const why = !left ? `the cap of ${context.cap} lessons is already used` : 'no confirmed findings, no verify-fix rounds, no minor findings repeated in other jobs';
    log({ outcome: 'skipped', reason: why, lessons: [] });
    return { job: state.id, skipped: true, reason: `Nothing to learn from: ${why}. No agent was started. Run factory distill done.`, lessons: [], agents: [] };
  }
  const lock = acquireLock(root, state, { workflow: 'distill-write', config: null });
  try {
    state = job.resolve(root, state.id);
    const S = settings(root, state);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    const ctx = {
      root,
      state,
      brief: { job: state.id, workflow: 'distill', config: null },
      settings: S,
      runs: [],
      notes: [],
      files: 0,
      unavailable: null,
      scratch: path.join(root, '.factory', 'scratch', 'runner', state.id, `${stamp}-distill-${process.pid}`),
      decisionId: d.id,
      limit: limiter(1),
      say,
      note: (m) => {
        ctx.notes.push(m);
        say(m);
      },
    };
    const cli = `node "${path.join(PLUGIN_ROOT, 'bin', 'factory')}" --root "${root}"`;
    const role = 'lesson-writer';
    const model = ((state.policy && state.policy.agents) || {}).models ? state.policy.agents.models[role] || null : null;
    const prompt = [
      `# Distill job ${state.id}: ${state.title}`,
      '',
      `You may write at most ${left} lesson(s) from this job. Lessons that already exist: already_proposed below, and ${path.join(root, '.factory', 'lessons', 'lessons.json')}.`,
      'Record each lesson with exactly this command (one per lesson):',
      `  ${cli} lessons add --job ${state.id} --text "<lesson>" --scope "<glob>,<glob>" --why "<finding id: what went wrong>"`,
      'The command prints the lesson with its id (L<n>). Run no other factory command.',
      '',
      '## Distill context',
      '```json',
      JSON.stringify(context, null, 2),
      '```',
    ].join('\n');
    // one step, logged like a workflow run's, so the console's Learn bank shows it while it runs
    const t0 = Date.now();
    ctx.wfRun = crypto.randomUUID();
    const wfBase = { wf_run: ctx.wfRun, job: state.id, decision_id: d.id, workflow: 'distill', config: null };
    events.append(root, { event: 'workflow_start', ...wfBase, mode: null, round: null, pid: process.pid });
    events.append(root, { event: 'workflow_phase', ...wfBase, text: 'distill: write lessons', index: 0 });
    ctx.phaseIndex = 0;
    const wfEnd = (rec) => events.append(root, { event: 'workflow_end', ...wfBase, ms: Date.now() - t0, phases: 1, agents: ctx.runs.length, ...rec });
    let reply;
    try {
      reply = await runAgent(ctx, prompt, { agentType: `factory:${role}`, label: 'lesson-writer', schema: LESSON_REPLY, ...(model ? { model } : {}) });
    } catch (e) {
      wfEnd({ outcome: 'failed', status: null, error: ctx.unavailable ? `copilot unavailable: ${ctx.unavailable.detail}` : String(e.message).slice(0, 300) });
      if (ctx.unavailable) copilotUnavailable(ctx);
      throw e;
    }
    if (ctx.unavailable) {
      wfEnd({ outcome: 'failed', status: null, error: `copilot unavailable: ${ctx.unavailable.detail}` });
      copilotUnavailable(ctx);
    }
    wfEnd({ outcome: 'ok', status: reply ? 'ok' : 'no_result' });
    const added = lessons.load(root).lessons.filter((l) => !before.has(l.id) && l.source_job === state.id);
    const claimed = reply && Array.isArray(reply.lessons) ? reply.lessons.map((l) => String(l.id || '').toUpperCase()) : [];
    const unrecorded = claimed.filter((id) => !added.some((l) => l.id === id));
    const run = ctx.runs[ctx.runs.length - 1] || {};
    const outcome = run.outcome || (reply ? 'ok' : 'invalid');
    log({ outcome, lessons: added.map((l) => l.id), claimed, unrecorded, agent_ms: run.ms || null });
    const out = {
      job: state.id,
      outcome,
      lessons: added.map((l) => ({ id: l.id, text: l.text, scope: l.scope, why: l.why || null })),
      ...(unrecorded.length ? { unrecorded, warning: `The lesson-writer named ${unrecorded.join(', ')} but no such lesson was recorded for ${state.id}; only the lessons listed were recorded.` } : {}),
      ...(reply && reply.note ? { note: reply.note } : {}),
      message: added.length ? `${added.length} lesson(s) proposed: ${added.map((l) => l.id).join(', ')}. The user can reply "accept lesson Ln" or "reject lesson Ln <why>". Run factory distill done.` : outcome === 'ok' ? 'The lesson-writer found nothing worth a lesson. Run factory distill done.' : `The lesson-writer did not finish (${outcome}); no lessons were recorded. Run factory distill done to move on, or factory distill write to try again.`,
      copilot: S.bin,
      agents: ctx.runs,
    };
    return out;
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------- printed summary

const one = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

// The default `factory run` output: the recorded result in a few lines (the full JSON is
// in result_file, or printed with --json).
function summaryText(r) {
  const L = [];
  L.push(`status: ${r.status}`);
  if (r.message) L.push(`message: ${r.message}`);
  if (r.next_gate) L.push(`next_gate: ${r.next_gate}`);
  if (r.restatement) L.push(`restatement: ${one(r.restatement)}`);
  if (r.park_reason) L.push(`park_reason: ${r.park_reason}`);
  if (Array.isArray(r.questions) && r.questions.length) {
    L.push(`questions (${r.questions.length})${r.intent_first ? ' — intent first: other questions wait' : ''}:`);
    r.questions.forEach((q, i) => {
      const opts = Array.isArray(q.options) && q.options.length ? ` | options: ${q.options.map(one).join(' / ')}` : '';
      const ground = `${q.unknown ? ` | unknown: ${q.unknown}${q.kind ? ` (${q.kind})` : ''}` : ''}${Array.isArray(q.evidence) && q.evidence.length ? ` | evidence: ${q.evidence.join(', ')}` : q.preference ? ' | your call' : ''}${q.researchable ? ` | researchable, asked because: ${q.note || 'research did not settle it'}` : ''}`;
      L.push(`  ${i + 1}. ${q.id ? `${q.id} ` : ''}${q.category ? `[${q.category}] ` : ''}${q.question}${q.why ? ` | why: ${q.why}` : ''}${opts}${q.default !== undefined && q.default !== null ? ` | default: ${one(q.default)}` : ''}${ground}`);
    });
  }
  if (r.intent_first !== undefined) L.push(`intent_first: ${r.intent_first}`);
  // Grounded intent (clarify): what research found, what the factory assumes, and where it all is.
  if (Array.isArray(r.findings) && r.findings.length) {
    L.push(`findings (${r.findings.length}):`);
    for (const f of r.findings) L.push(`  - ${f.id} [${f.verdict}${f.confidence ? `, ${f.confidence}` : ''}] ${f.claim} — ${f.source}${f.retrieved_at ? ` (${f.retrieved_at})` : ''}`);
  }
  if (Array.isArray(r.assumptions) && r.assumptions.length) {
    L.push(`assumptions (${r.assumptions.length}) — reply "change A-n <value>" or "drop A-n" to override:`);
    for (const a of r.assumptions) L.push(`  - ${a.id}: ${a.statement}${a.overridden ? ' (overridden by user)' : ` (evidence: ${(a.evidence || []).join(', ')})`}`);
  }
  if (r.research) {
    const x = r.research;
    L.push(`research: ${x.unknowns || 0} unknown(s), ${x.evidence || 0} finding(s) (${x.confirmed || 0} confirmed), web ${x.web || 'n/a'}${x.researchable_dropped ? `, ${x.researchable_dropped} researchable question(s) not asked` : ''}${(x.degraded || []).length ? `, degraded: ${x.degraded.join(', ')}` : ''}`);
  }
  if (r.intent_findings) L.push(`intent_findings: ${r.intent_findings}`);
  if (Array.isArray(r.warnings) && r.warnings.length) {
    L.push('warnings:');
    for (const w of r.warnings.slice(0, 10)) L.push(`  - ${one(w)}`);
  }
  if (r.held) L.push(`held: ${r.held}`);
  if (r.critique) {
    const c = r.critique;
    L.push(`critique: verdict ${c.verdict}${c.intent_confirmed === false ? ', intent NOT confirmed' : ''}${c.restatement ? ` | restatement: ${one(c.restatement)}` : ''}`);
    for (const it of c.items || []) L.push(`  - ${one(it)}`);
    for (const q of c.researchable_questions || []) L.push(`  - researchable (${q.kind}): ${q.question}`);
  }
  for (const k of ['problems', 'doc_problems', 'errors', 'missing', 'degraded', 'confirmed', 'unverified']) {
    if (Array.isArray(r[k]) && r[k].length) {
      L.push(`${k}:`);
      for (const p of r[k].slice(0, 20)) L.push(`  - ${one(p)}`);
    }
  }
  if (Array.isArray(r.tasks) && r.tasks.length) {
    L.push('tasks:');
    for (const t of r.tasks) L.push(`  - ${t.id}: ${t.outcome}${t.attempts ? ` (${t.attempts} attempt(s))` : ''}${t.summary ? ` — ${t.summary}` : ''}`);
  }
  if (r.followup) L.push(`followup: ${r.followup}`);
  const w = r.workflow || {};
  const agents = r.agents || [];
  const by = {};
  for (const a of agents) by[a.outcome] = (by[a.outcome] || 0) + 1;
  L.push(`workflow: ${w.name}${w.config ? ` --config ${w.config}` : ''} → ${w.status}${w.summary ? ` — ${w.summary}` : ''} (${((w.ms || 0) / 1000).toFixed(0)}s)`);
  L.push(`agents: ${agents.length} (${Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'})`);
  for (const a of agents.filter((x) => x.outcome !== 'ok')) L.push(`  - ${a.label} (${a.agent_type}) ${a.outcome}${a.errors && a.errors.length ? `: ${String(a.errors[0]).slice(0, 160)}` : ''}`);
  L.push(`full result: ${r.result_file} (or run with --json)`);
  return L.join('\n');
}

module.exports = { run, distillWrite, runAgent, execute, extractJson, replyText, copilotArgs, toolPermissions, agentTools, resolveBin, command, modelId, settings, limiter, preflight, summaryText, lockAlive, WORKFLOWS };
