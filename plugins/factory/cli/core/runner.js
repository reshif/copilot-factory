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
const transcripts = require('./transcripts');

const WORKFLOWS = ['clarify', 'ground', 'fanout-judge', 'decompose', 'realize', 'reconcile'];
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
    // the live switch (models.js): every role on the Copilot session default, running jobs included
    modelsOff: require('./models').modelsOff(live),
    timeoutSec: num(cp.agent_timeout_seconds, 1800),
    resumeForRetry: cp.resume_for_retry !== false,
    // P3.3 transient failures (rate limit, 5xx, network): re-spawned with backoff and jitter
    // inside the same agent call, so no workflow attempt is spent on them.
    transientRetries: typeof cp.transient_retries === 'number' && cp.transient_retries >= 0 ? Math.floor(cp.transient_retries) : 4,
    transientBackoffSec: typeof cp.transient_backoff_seconds === 'number' && cp.transient_backoff_seconds >= 0 ? cp.transient_backoff_seconds : 10,
    transcripts: transcripts.limits(cp),
    // runs in a row that stopped on transient failures before the job parks (kind transient):
    // a failure that persists across reruns is not transient any more
    transientParkAfter: typeof cp.transient_park_after === 'number' && cp.transient_park_after >= 1 ? Math.floor(cp.transient_park_after) : 3,
    copilot: cp,
    flags: (Array.isArray(cp.flags) ? cp.flags : []).map((f) => String(f).replace(/\{plugin_root\}/g, PLUGIN_ROOT).replace(/\{root\}/g, root)),
  };
}

// ---------------------------------------------------------------- the Workflow API

function loadScript(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/^export const meta =/m, 'const meta =');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('args', 'agent', 'pipeline', 'parallel', 'phase', 'log', 'factory', 'Date', 'Math', 'require', 'process', src);
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
  return fn(args, api.agent, pipeline, parallel, api.phase, api.log, api.factory || {}, forbidden, mathNoRandom(), noFs, undefined);
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
// The job's fetched dependency source (.factory/deps/<job>/, read-only) is inside the project
// and so covered already; it is named on its own too, so a role that reads it (researchers,
// option generators, the architect, God Eye, the API-conformance critic, the finding verifier)
// can never be refused it by a narrower project dir.
function addDirs(root, jobId = null) {
  const dirs = [path.resolve(root)];
  const plugin = path.resolve(PLUGIN_ROOT);
  if (!dirs.includes(plugin)) dirs.push(plugin);
  if (jobId) {
    const deps = path.join(path.resolve(root), '.factory', 'deps', String(jobId));
    if (exists(deps)) dirs.push(deps);
  }
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

function copilotArgs({ prompt, agentType, model, root, sessionId, flags, permissions, jobId = null }) {
  return [
    '-p', prompt,
    '--agent', agentType,
    ...(model ? ['--model', model] : []),
    '--output-format', 'json',
    '-s',
    '--no-ask-user',
    ...permissionArgs(permissions),
    ...addDirs(root, jobId).flatMap((d) => ['--add-dir', d]),
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

// Every agent process this `factory run` started and that is still running. Each agent runs in
// its own process group (detached on POSIX), so the whole tree it starts (shells, test runners,
// servers) can be killed with it: on a timeout, and when `factory run` itself is stopped.
const LIVE = new Set();
let lockFile = null; // the run.lock this process holds: it lists the live agents' pids

// The lock names the live agents, so a later run that finds the lock stale (this process was
// killed with SIGKILL, no handler ran) can stop the agents it left behind.
function noteAgents() {
  if (!lockFile) return;
  try {
    const held = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (held.pid !== process.pid) return;
    held.agents = [...LIVE].map((c) => c.pid);
    fs.writeFileSync(lockFile, JSON.stringify(held));
  } catch {
    /* no lock (dry run, distill) or released */
  }
}

function killTree(child, sig = 'SIGTERM') {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      require('child_process').spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-child.pid, sig); // the agent's whole process group
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const groupAlive = (pid) => {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// Stop every live agent tree: SIGTERM, up to `graceMs` for them to go, then SIGKILL.
function killAgents(graceMs = 1500) {
  const kids = [...LIVE];
  if (!kids.length) return 0;
  for (const c of kids) killTree(c, 'SIGTERM');
  const until = Date.now() + graceMs;
  while (Date.now() < until && kids.some((c) => groupAlive(c.pid))) sleepSync(50);
  for (const c of kids) if (groupAlive(c.pid)) killTree(c, 'SIGKILL');
  return kids.length;
}

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

// While a workflow runs, a signal to `factory run` (Ctrl+C, a closed terminal, a cancelled tool
// call) stops its agents too, logs the run's end as interrupted and releases the lock, instead
// of leaving agents editing worktrees with a lock a second run would ignore. Returns the undo.
function onInterrupt(cleanup) {
  const handlers = {};
  for (const sig of Object.keys(SIGNALS)) {
    if (process.platform === 'win32' && sig === 'SIGHUP') continue;
    handlers[sig] = () => {
      try {
        killAgents();
        cleanup(sig);
      } finally {
        process.exit(128 + SIGNALS[sig]);
      }
    };
    process.on(sig, handlers[sig]);
  }
  const atExit = () => killAgents(0);
  process.on('exit', atExit);
  return () => {
    for (const [sig, h] of Object.entries(handlers)) process.removeListener(sig, h);
    process.removeListener('exit', atExit);
  };
}

// `sink` (optional): the agent's transcript (transcripts.open), fed stdout as it arrives.
function spawnCopilot(bin, argv, { cwd, env, timeoutSec, sink = null }) {
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
      LIVE.delete(child);
      noteAgents();
      if (sink) sink.flush();
      resolve({ code: code === null || code === undefined ? -1 : code, signal: signal || null, stdout: out, stderr: err + extra, ms: Date.now() - started, timedOut });
    };
    try {
      child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true, ...(shell ? { shell: true, windowsVerbatimArguments: true } : {}) });
      if (child.pid) {
        LIVE.add(child);
        noteAgents();
      }
    } catch (e) {
      resolve({ code: -1, signal: null, stdout: '', stderr: e.message, ms: 0, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 5000).unref();
    }, timeoutSec * 1000);
    child.stdout.on('data', (d) => {
      if (out.length < MAX_OUTPUT) out += d;
      if (sink) sink.write(d);
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

// Builders and sweep checkers work in their task's worktree (realize labels: "build T1 #2", "sweep T1").
function cwdFor(ctx, opts, { prepare }) {
  const b = ctx.brief;
  if (b.workflow !== 'realize') return ctx.root;
  const m = /^(build|test|sweep) (\S+)/.exec(opts.label || '');
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

// A transient failure: the Copilot CLI itself reported a rate limit, a 5xx or a dropped network
// connection. Only its own error lines on stderr count (a line that starts "Error:", "TypeError:",
// "CAPIError …", "✗ …"), and a number counts only as an HTTP status in context ("status code
// 429", "HTTP 503", "502 Bad Gateway"). Never stdout (the agent's reply and tool output), never a
// bare number ("Tokens used: 1,429"), never ECONNREFUSED (a local service the agent's own tests
// needed). Returns the matching text, or null.
const ERROR_LINE = /^(?:[✗×!]\s*)?(?:error\b|[A-Za-z]*Error\b|request failed\b)/i;
const TRANSIENT_SIGNALS = [
  /\b(?:status(?: code)?|HTTP(?:\/\d(?:\.\d)?)?)\s*[:=]?\s*(?:429|5\d\d)\b/i,
  /\b(?:429|5\d\d) (?:Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i,
  /\brate limit(?:ed| exceeded)\b|\btoo many requests\b/i,
  /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH)\b|\bsocket hang up\b|\bfetch failed\b/i,
];
function transient(r) {
  if (!r || r.code === 0 || r.timedOut) return null;
  for (const raw of String(r.stderr || '').split('\n')) {
    const l = raw.trim();
    if (!ERROR_LINE.test(l)) continue;
    for (const re of TRANSIENT_SIGNALS) {
      const m = re.exec(l);
      if (m) return m[0];
    }
  }
  return null;
}
// The wait before transient retry n (0-based): exponential from the base, capped at 2 min,
// with ±50% jitter so parallel agents don't retry in step.
const transientWaitMs = (n, baseSec) => Math.round(Math.min(120, baseSec * 2 ** n) * 1000 * (0.5 + Math.random()));

// The time-up turn a builder gets in its own session when its time cap is reached.
const GRACE_TURN = (sec) => [
  `Time is up for this attempt. You have about ${sec} seconds left: do not start anything new.`,
  'Commit what works now on the task branch (`git add -A && git commit -m "wip: <what is done, what is left>"`), then reply with the JSON object:',
  'status "done" only if the task is finished and its verify commands passed; otherwise status "blocked" with a summary of what is done, what is left and what you would try next (the next attempt continues from your commits and that summary).',
].join('\n');

// The first line that says what went wrong (an error code or message), not the stack tail.
function errorLine(stderr) {
  const lines = String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /\b(error|refused|denied|conflict|failed|not found|cannot|unable)\b|^[A-Z][A-Za-z]*Error\b|"code":/i.test(l) && !/^at\s/.test(l));
  return (hit || lines[lines.length - 1] || '').slice(0, 300);
}

// Commit what a builder left uncommitted in its task worktree: "wip:" on the task branch, so a
// timed-out or crashed attempt's work survives for the next attempt. Returns the commit or null.
function commitWip(wt, label, why) {
  const git = require('../lib/git');
  try {
    if (!exists(path.join(wt, '.git')) || !git.status(wt)) return null;
    if (git.ok(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) git.run(wt, ['merge', '--abort'], { allowFail: true });
    git.run(wt, ['add', '-A']);
    const r = git.run(wt, ['commit', '-q', '-m', `wip: ${label} (${why}; uncommitted work saved by factory run)`], { allowFail: true });
    return r.code === 0 ? git.revParse(wt, 'HEAD') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- deterministic steps

// The factory CLI run as a child of `factory run` (async, so running agents and their timers
// are not blocked while a test suite runs), in its own process group like an agent so a stopped
// run stops it too. It is the runner's own step, not an agent's: no FACTORY_RUNNER, and its
// event line carries via "run". Resolves to the command's JSON (refusals included) and exit code.
function cliChild(ctx, args, { timeoutSec = 3600 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, FACTORY_ROOT: ctx.root, FACTORY_VIA: 'run', FACTORY_JOB: ctx.brief.job };
    for (const k of ['FACTORY_RUNNER', 'FACTORY_AGENT_ROLE', 'FACTORY_AGENT_LABEL']) delete env[k];
    const started = Date.now();
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'factory'), '--root', ctx.root, ...args, '--job', ctx.brief.job], { cwd: ctx.root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    } catch (e) {
      resolve({ code: -1, json: { error: true, code: 'internal', message: e.message }, ms: 0 });
      return;
    }
    if (child.pid) LIVE.add(child);
    const timer = setTimeout(() => killTree(child, 'SIGKILL'), timeoutSec * 1000);
    child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT) out += d; });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUTPUT) err += d; });
    const done = (code) => {
      clearTimeout(timer);
      LIVE.delete(child);
      let json = null;
      try {
        json = JSON.parse(out);
      } catch {
        json = { error: true, code: 'internal', message: `${String(err || out).trim().slice(-500) || 'no output'}` };
      }
      resolve({ code: code === null ? -1 : code, json, ms: Date.now() - started });
    };
    child.on('error', (e) => { err += e.message; done(-1); });
    child.on('close', (code) => done(code));
  });
}

// factory.verify(taskId) for realize: `task verify` decides pass or fail by its exit code and
// evidence; no agent reads it back. Returns { pass, evidence_id, failures, scope_violations,
// no_changes } or { pass: false, error: { code, message } } when verify refused.
async function verifyTask(ctx, taskId) {
  const r = await cliChild(ctx, ['task', 'verify', taskId]);
  const j = r.json || {};
  const v = j.error
    ? { task: taskId, pass: false, error: { code: j.code || 'internal', message: String(j.message || '').slice(0, 2000) } }
    : { task: taskId, pass: r.code === 0 && j.pass === true, evidence_id: j.evidence_id || null, failures: j.failures || [], scope_violations: j.scope_violations || [], no_changes: Boolean(j.no_changes), ...(j.legacy ? { legacy: j.legacy } : {}) };
  if (v.error) {
    // a refusal (dirty worktree, missing dependency, no builder result) is this attempt's result too
    try {
      require('./job').mutate(ctx.root, ctx.brief.job, (st) => {
        const t = st.tasks[taskId] || {};
        st.tasks[taskId] = { ...t, history: require('./tasks').noteAttempt(t.history, t.attempts || 0, { verify: { pass: false, refused: v.error.code, message: v.error.message.slice(0, 1500), at: new Date().toISOString() } }) };
      });
    } catch {
      /* the history is a convenience; the refusal is in the result either way */
    }
  }
  ctx.checks.push({ step: 'verify', task: taskId, pass: v.pass, code: v.error ? v.error.code : null, ms: r.ms });
  ctx.say(`verify ${taskId}: ${v.pass ? 'pass' : v.error ? `refused (${v.error.code})` : 'fail'} in ${(r.ms / 1000).toFixed(1)}s`);
  return v;
}

// factory.prepare(taskId) for realize, before a wave's builders: the build environment in the
// task's worktree (setup cached by its lockfiles, job services up and healthy). Returns
// { ok: true } or { ok: false, broken: { reason, cmd, code, tail } }; the env it reports is
// what the task's builder is started with.
async function prepareTask(ctx, taskId) {
  const r = await cliChild(ctx, ['env', 'prepare', taskId]);
  const j = r.json || {};
  const out = j.error ? { task: taskId, ok: false, broken: { reason: `could not prepare the worktree and build environment for ${taskId}: ${j.message || j.code}`, code: j.code } } : { task: taskId, ok: Boolean(j.ok), ...(j.ok ? { cached: Boolean(j.cached), name: j.name || null } : { broken: j.broken }) };
  if (j.ok && j.env && Object.keys(j.env).length) ctx.taskEnv[taskId] = j.env;
  const ca = j.cache || null;
  ctx.checks.push({ step: 'environment', task: taskId, ok: out.ok, cached: out.cached || false, ms: r.ms, ...(ca ? { cache: ca } : {}) });
  if (!out.ok || (j.ran || []).length) ctx.say(`environment ${taskId}: ${out.ok ? `ready (${(j.ran || []).length} setup step(s)${ca ? `, ${ca.kind} cache${ca.offline ? ', offline from the wheelhouse/cache' : ''}${ca.fallback ? ', index fallback' : ''}` : ''})` : out.broken.reason}`);
  return out;
}

// factory.integrate(taskIds, wave) for realize, after a wave: `factory reconcile wave` merges
// the wave's done tasks into the job branch and runs the job's checks there (P2.3).
async function integrateWave(ctx, ids, wave) {
  const r = await cliChild(ctx, ['reconcile', 'wave', '--tasks', ids.join(','), ...(wave ? ['--wave', String(wave)] : [])]);
  const j = r.json || {};
  const out = j.error ? { ok: false, kind: 'error', message: j.message || j.code, route: {} } : j;
  ctx.checks.push({ step: 'integrate', wave: wave || null, tasks: ids, ok: Boolean(out.ok), kind: out.kind || null, ms: r.ms });
  ctx.say(`integrate wave ${wave || '?'} (${ids.join(', ')}): ${out.ok ? `ok${out.reconciled ? ', every task integrated' : ''}` : `${out.kind}${out.route ? ` → ${Object.keys(out.route).join(', ')}` : ''}${out.message ? `: ${String(out.message).slice(0, 200)}` : ''}`}`);
  return out;
}

// 0.10.0 deterministic steps a workflow asks the CLI for (critics with evidence):
//   factory.fetchDeps(specs)     ground: download pinned packages a probe asked for (never run;
//                                a failure is a gap) → { packages }
//   factory.checkLedger(entries) ground: each API ledger quote against the fetched source
//                                → { ok, verified, rejected: [{ probe, symbol, file, line, why }] }
//   factory.probe()              decompose: lint + dry-run every verify command in a scratch
//                                worktree inside the proposed environment → the probe record
//   factory.grant(taskId, paths) realize: give a blocked task paths inside the contract's
//                                allowed paths that no other task owns (never widening)
let ledgerFiles = 0;
async function fetchDepsStep(ctx, specs) {
  const r = await cliChild(ctx, ['deps', 'fetch', '--add', (specs || []).map(String).join(',')]);
  const j = r.json || {};
  ctx.checks.push({ step: 'deps', ok: !j.error, ms: r.ms });
  return j.error ? { packages: [], error: j.message || j.code } : j;
}
async function checkLedgerStep(ctx, entries) {
  ledgerFiles += 1;
  const f = path.join(ctx.scratch, `ledger-${process.pid}-${ledgerFiles}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(entries || []));
  const r = await cliChild(ctx, ['deps', 'check', '--file', f]);
  const j = r.json || {};
  ctx.checks.push({ step: 'ledger', ok: Boolean(j.ok), rejected: (j.rejected || []).length, ms: r.ms });
  if (j.error) return { ok: false, verified: 0, rejected: [], error: j.message || j.code };
  ctx.say(`API ledger: ${j.verified} verified, ${(j.rejected || []).length} rejected`);
  return j;
}
async function probeStep(ctx) {
  const r = await cliChild(ctx, ['plan', 'probe'], { timeoutSec: 3600 });
  const j = r.json || {};
  ctx.checks.push({ step: 'probe', ok: Boolean(j.ok), problems: (j.problems || []).length, ms: r.ms });
  ctx.say(`plan probe: ${j.error ? `refused (${j.code})` : j.ok ? 'every verify command can run' : `${(j.problems || []).length} problem(s)`}`);
  return j.error ? { ok: false, problems: [`the plan probe could not run: ${j.message || j.code}`], commands: [], error: j.code } : j;
}
async function grantStep(ctx, taskId, paths) {
  const r = await cliChild(ctx, ['task', 'grant', String(taskId), '--paths', (paths || []).map(String).join(',')]);
  const j = r.json || {};
  ctx.checks.push({ step: 'grant', task: taskId, ok: Boolean(j.ok), ms: r.ms });
  if (!j.error) ctx.say(`grant ${taskId}: ${j.ok ? `granted ${(j.granted || []).join(', ')}` : `refused: ${(j.refused || []).map((x) => `${x.path} (${x.why})`).join('; ')}`}`);
  return j.error ? { ok: false, granted: [], refused: (paths || []).map((p) => ({ path: p, why: j.message || j.code })) } : j;
}

function workflowApi(ctx) {
  return {
    verify: (taskId) => verifyTask(ctx, String(taskId)),
    prepare: (taskId) => prepareTask(ctx, String(taskId)),
    integrate: (ids, wave) => integrateWave(ctx, (ids || []).map(String), wave),
    fetchDeps: (specs) => fetchDepsStep(ctx, specs),
    checkLedger: (entries) => checkLedgerStep(ctx, entries),
    probe: () => probeStep(ctx),
    grant: (taskId, paths) => grantStep(ctx, taskId, paths),
    // 0.9.0's shared loop engine, for the workflows' own loops (design and plan critique, the
    // plan probe): pure functions, run in-process
    loop: (state, blockers, policy) => require('./loop').shouldContinue(state, blockers, policy),
    recordDiagnosis: (state, d) => require('./loop').recordDiagnosis(state, d),
    loopQuestion: (state, opts) => require('./loop').question(state, opts),
  };
}

async function runAgent(ctx, prompt, opts) {
  const o = opts || {};
  const agentType = o.agentType;
  const role = roleOf(agentType);
  if (!/^factory:[a-z-]+$/.test(agentType || '') || !agentFileExists(role)) {
    throw new Error(`agent() called without a real factory agentType (got ${JSON.stringify(agentType)}) for "${o.label}"`);
  }
  const S = ctx.settings;
  // the role's model id, unless models are switched off or the CLI refused that id earlier in
  // this run or recently (models.js): then the session default, with the skip on the record
  if (!ctx.rejectedModels) ctx.rejectedModels = require('./models').loadRejected(ctx.root);
  let model = S.modelsOff ? null : modelId(S.modelIds, o.model);
  let modelSkipped = null;
  if (model && ctx.rejectedModels.has(model)) {
    modelSkipped = model;
    model = null;
  }
  let modelFallback = null;
  // the workflow run and the step (phase) in force when agent() was called, for the console's step list
  const wf = ctx.wfRun ? { wf_run: ctx.wfRun, step: typeof ctx.phaseIndex === 'number' ? ctx.phaseIndex : -1 } : {};
  // A time cap from the workflow (opts.timeoutSec: clarify's scout budget) counts from the
  // call, not from the spawn: time spent waiting for a free slot is part of the budget, and
  // an agent whose budget ran out while it waited is not started at all (outcome timeout).
  // opts.timeoutScale (1–4): this agent may take that multiple of the agent cap (a verifier
  // re-checking a finding that ran out of time before).
  const scale = typeof o.timeoutScale === 'number' && o.timeoutScale > 1 ? Math.min(4, o.timeoutScale) : 1;
  const maxSec = S.timeoutSec * scale;
  const capSec = typeof o.timeoutSec === 'number' && o.timeoutSec > 0 ? Math.min(o.timeoutSec, maxSec) : scale > 1 ? maxSec : null;
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
    // (a short cap from the brief, e.g. a time-boxed clarify researcher, still starts: the floor is
    // half its budget, at most 5 s)
    if (deadline && deadline - Date.now() < Math.min(5000, capSec * 500)) {
      const rec = { label: o.label || role, role, agent_type: agentType, model: o.model || null, model_id: model, cwd, ms: 0, exit: null, retry: false, spawns: 0, outcome: 'timeout', time_cap_sec: capSec, errors: [`its ${capSec}s time budget ran out before a slot was free; not started`] };
      ctx.runs.push(rec);
      events.append(ctx.root, { event: 'agent_run', job: ctx.brief.job, decision_id: ctx.decisionId, workflow: ctx.brief.workflow, config: ctx.brief.config || null, ...wf, ...rec });
      ctx.say(`${rec.label} (${agentType}) not started: time budget spent while queued`);
      return null;
    }
    // A task's builder (realize "build T1 #n"). Attempt 2+ (o.resume) continues the previous
    // attempt's Copilot session: `--session-id <id>` resumes a session that exists (Copilot CLI
    // reference, "--session-id ID": "If the ID matches an existing session or task, that
    // session or task is resumed"), the same mechanism the format-correction turn uses. The id
    // is kept in the task's state, so a later `factory run` continues it too.
    const bt = ctx.brief.workflow === 'realize' && /^build (\S+)/.exec(o.label || '');
    const taskId = bt && ctx.brief.tasks && ctx.brief.tasks[bt[1]] ? bt[1] : null;
    let resumedFrom = null;
    if (taskId && o.resume && S.resumeForRetry) {
      try {
        const prev = ((require('./job').load(ctx.root, ctx.brief.job).tasks || {})[taskId] || {}).builder;
        if (prev && prev.session_id) resumedFrom = prev.session_id;
      } catch {
        resumedFrom = null;
      }
    }
    const sessionId = resumedFrom || (S.resumeForRetry ? crypto.randomUUID() : null);
    const perm = toolPermissions(role, agentTools(role), S.copilot);
    // The agent's Copilot JSONL, streamed to its transcript as it arrives (P4.1), and what the
    // CLI reported about the run (tool calls, usage) counted from the same stream.
    const tfile = ctx.transcripts ? transcripts.fileFor(ctx.transcripts, o.label || role, ctx.transcriptNames || (ctx.transcriptNames = new Set())) : null;
    const tRel = tfile ? path.relative(ctx.root, tfile).split(path.sep).join('/') : null;
    const sink = transcripts.open(tfile, { maxBytes: (S.transcripts || {}).maxBytes });
    // agent_start now, agent_run (same run_id) when it ends: the console shows the agent as
    // at work in between. No hook does this: each agent is its own `copilot -p` process, not a
    // subagent, so SubagentStart/SubagentStop never fire for it.
    const runId = crypto.randomUUID();
    // A task agent runs inside the task's build environment (its venv on PATH, …), set up by
    // factory.prepare before the wave.
    const tm = /^(?:build|sweep) (\S+)/.exec(o.label || '');
    const buildEnv = ctx.brief.workflow === 'realize' && tm && ctx.taskEnv ? ctx.taskEnv[tm[1]] || {} : {};
    const env = { ...process.env, ...buildEnv, FACTORY_DRIVE: '', FACTORY_ROOT: ctx.root, FACTORY_RUNNER: '1', FACTORY_JOB: ctx.brief.job, FACTORY_AGENT_ROLE: role, FACTORY_AGENT_LABEL: o.label || role };
    // every spawn's stderr, as it ended, into <label>.stderr.log (transient re-spawns included)
    const stderrFile = tfile ? tfile.replace(/\.jsonl$/, '.stderr.log') : null;
    const stderrRel = stderrFile ? path.relative(ctx.root, stderrFile).split(path.sep).join('/') : null;
    let stderrSeen = '';
    const logStderr = (r) => {
      if (!r || !String(r.stderr || '').trim()) return;
      stderrSeen += `${stderrSeen ? '\n' : ''}${r.stderr}`;
      if (stderrFile) transcripts.writeStderr(stderrFile, `${r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`}`, { maxBytes: (S.transcripts || {}).maxBytes });
    };
    const failedTrail = () => ({ ...(tRel ? { transcript: tRel } : {}), ...(stderrSeen ? { stderr_tail: transcripts.stderrTail(stderrSeen), ...(stderrRel && fs.existsSync(stderrFile) ? { stderr_file: stderrRel } : {}) } : {}), usage: sink.result().usage });
    const closeUnavailable = (detail, r) => events.append(ctx.root, { event: 'agent_run', run_id: runId, job: ctx.brief.job, decision_id: ctx.decisionId, workflow: ctx.brief.workflow, config: ctx.brief.config || null, ...wf, agent_type: agentType, label: o.label || role, role, cwd, ms: r ? r.ms : 0, exit: r ? r.code : null, outcome: 'copilot_unavailable', code: 'copilot_unavailable', errors: [detail], ...failedTrail() });
    const spawnOnce = async (text, retryTurn = false, capSecOverride = null) => {
      if (ctx.unavailable) {
        if (retryTurn) closeUnavailable(ctx.unavailable.detail); // its first turn already started it
        throw new Error(`Copilot CLI unavailable: ${ctx.unavailable.detail}`);
      }
      if (!retryTurn) events.append(ctx.root, { event: 'agent_start', run_id: runId, job: ctx.brief.job, decision_id: ctx.decisionId, workflow: ctx.brief.workflow, config: ctx.brief.config || null, ...wf, agent_type: agentType, label: o.label || role, role, model: o.model || null, model_id: model, session_id: sessionId, ...(resumedFrom ? { resumed_session: true } : {}), ...(tRel ? { transcript: tRel } : {}), pid: process.pid });
      let argv = copilotArgs({ prompt: deliverable(ctx, text, `${o.label || role}${retryTurn ? (capSecOverride ? ' (time up)' : ' (format)') : ''}`, retryTurn && !capSecOverride), agentType, model, cwd, root: ctx.root, sessionId, flags: S.flags, permissions: perm, jobId: ctx.brief && ctx.brief.job });
      let r = await spawnCopilot(S.bin, argv, { cwd, env, timeoutSec: capSecOverride || Math.max(1, left()), sink });
      logStderr(r);
      // The CLI refused the turn because of its --model (an id this CLI, plan or org can't use):
      // the same turn once more on the session default, no attempt spent, and the id skipped for
      // the rest of this run and remembered for later runs (models.js).
      const refused = model ? require('./models').rejection(r, model) : null;
      if (refused) {
        modelFallback = { model_id: model, detail: refused };
        if (!ctx.rejectedModels.has(model)) ctx.note(`Copilot refused the model ${model} (${refused}); ${o.label || role} and the rest of this run use the session default model. Set policy.agents.model_ids or policy.agents.models_enabled: false to change it.`);
        ctx.rejectedModels.set(model, { at: new Date().toISOString(), detail: refused });
        require('./models').noteRejected(ctx.root, model, refused);
        events.append(ctx.root, { event: 'agent_model_fallback', run_id: runId, job: ctx.brief.job, decision_id: ctx.decisionId, workflow: ctx.brief.workflow, label: o.label || role, role, model: o.model || null, model_id: model, detail: refused, exit: r.code });
        model = null;
        argv = copilotArgs({ prompt: argv[argv.indexOf('-p') + 1], agentType, model: null, cwd, root: ctx.root, sessionId, flags: S.flags, permissions: perm, jobId: ctx.brief && ctx.brief.job });
        r = await spawnCopilot(S.bin, argv, { cwd, env, timeoutSec: capSecOverride || Math.max(1, left()), sink });
        logStderr(r);
      }
      // Transient (429, 5xx, network): back off with jitter and spawn the same turn again; the
      // workflow never sees the failure, so no attempt is spent. After transient_retries the run
      // stops (nothing recorded) with copilot_transient: the service is down, not the agent wrong.
      for (let n = 0, why = transient(r); why; why = transient(r), n += 1) {
        const waitMs = transientWaitMs(n, typeof S.transientBackoffSec === 'number' ? S.transientBackoffSec : 10);
        const room = capSecOverride ? null : deadline ? deadline - Date.now() : null;
        if (n >= (Number.isInteger(S.transientRetries) ? S.transientRetries : 4) || (room !== null && room < waitMs + 5000)) {
          if (!ctx.unavailable) ctx.unavailable = { why: 'transient', detail: `${why} (after ${n} retr${n === 1 ? 'y' : 'ies'}): ${errorLine(r.stderr) || why}`, label: o.label || role };
          closeUnavailable(ctx.unavailable.detail, r);
          throw new Error(`Copilot CLI transient failure: ${ctx.unavailable.detail}`);
        }
        transientRetries += 1;
        events.append(ctx.root, { event: 'agent_transient', run_id: runId, job: ctx.brief.job, decision_id: ctx.decisionId, workflow: ctx.brief.workflow, label: o.label || role, retry: n + 1, wait_ms: waitMs, match: String(why).slice(0, 80), exit: r.code });
        ctx.say(`${o.label || role}: transient failure (${why}); retry ${n + 1} in ${(waitMs / 1000).toFixed(1)}s (no attempt spent)`);
        await new Promise((res) => setTimeout(res, waitMs));
        r = await spawnCopilot(S.bin, argv, { cwd, env, timeoutSec: capSecOverride || Math.max(1, left()), sink });
        logStderr(r);
      }
      const u = unavailable(r);
      if (u) {
        closeUnavailable(u.detail, r); // closes this agent's agent_start
        ctx.unavailable = ctx.unavailable || { ...u, label: o.label || role };
        throw new Error(`Copilot CLI unavailable: ${u.detail}`);
      }
      return r;
    };
    const full = `${prompt}${replyBlock(o.schema)}`;
    const startedAt = new Date().toISOString();
    let transientRetries = 0;
    const runs = [await spawnOnce(full)];
    let result = null;
    let errors = [];
    let retry = false;
    let grace = false;
    const ok = (r) => r.code === 0 && !r.timedOut;
    // A builder that ran out of time gets one short turn in the same session to commit what
    // works and reply, instead of losing the attempt's work and its reasoning.
    if (taskId && runs[0].timedOut && sessionId) {
      grace = true;
      const graceSec = Math.max(30, Math.min(180, Math.round(S.timeoutSec / 10)));
      runs.push(await spawnOnce(`${GRACE_TURN(graceSec)}${replyBlock(o.schema)}`, true, graceSec));
    }
    if (ok(runs[runs.length - 1])) {
      const c = check(o.schema, replyText(runs[runs.length - 1].stdout));
      result = c.obj;
      errors = c.errors;
      if (!result && !grace && (!deadline || left() >= 5)) {
        retry = true;
        const fix = correction(o.schema, errors);
        runs.push(await spawnOnce(S.resumeForRetry ? fix : `${full}\n\n${fix}`, true));
        const last = runs[runs.length - 1];
        if (ok(last)) {
          const c2 = check(o.schema, replyText(last.stdout));
          result = c2.obj;
          errors = c2.errors;
        }
      }
    }
    const last = runs[runs.length - 1];
    const rawOutcome = result ? 'ok' : runs[0].timedOut || last.timedOut ? 'timeout' : last.code !== 0 ? 'failed' : 'invalid';
    // A task's builder: record what this attempt returned (task verify and taskDone need it);
    // an empty reply after a dependency_conflict becomes the typed blocked result. Work it left
    // uncommitted (it timed out, crashed or never replied) is committed as "wip:" on the task
    // branch, so the next attempt continues from it instead of losing it.
    let wip = null;
    if (taskId) {
      if (rawOutcome !== 'ok' && typeof cwd === 'string') wip = commitWip(cwd, o.label || role, rawOutcome);
      if (wip) ctx.note(`${o.label}: its uncommitted work was saved as ${wip.slice(0, 10)} (wip:) on the task branch`);
      try {
        result = require('./tasks').afterBuilder(ctx.root, ctx.brief.job, taskId, result, { startedAt: startedAt, label: o.label, sessionId, resumed: Boolean(resumedFrom), wip, outcome: rawOutcome });
      } catch (e) {
        ctx.note(`could not record ${o.label}'s result: ${e.message}`);
      }
    }
    const outcome = rawOutcome === 'ok' || !result ? rawOutcome : 'blocked';
    const seen = sink.result();
    // A failed run keeps its stderr: the tail in the record, every spawn's (to the cap) beside the transcript.
    const stderrAll = rawOutcome === 'ok' ? '' : stderrSeen;
    const rec = {
      label: o.label || role,
      role,
      agent_type: agentType,
      model: o.model || null,
      model_id: model,
      ...(modelFallback ? { model_fallback: modelFallback } : {}),
      ...(modelSkipped ? { model_skipped: modelSkipped } : {}),
      cwd,
      ms: runs.reduce((s, r) => s + r.ms, 0),
      exit: last.code,
      retry,
      spawns: runs.length,
      outcome,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(resumedFrom ? { resumed_session: true } : {}),
      ...(grace ? { grace_turn: true } : {}),
      ...(transientRetries ? { transient_retries: transientRetries } : {}),
      ...(wip ? { wip_commit: wip } : {}),
      ...(capSec ? { time_cap_sec: capSec } : {}),
      ...(result && typeof result.verdict === 'string' ? { verdict: result.verdict } : {}), // god-eye's approve/revise, for telemetry
      ...(tRel ? { transcript: tRel } : {}),
      tool_calls: seen.tool_calls,
      ...(seen.last_tool ? { last_tool: seen.last_tool } : {}),
      usage: seen.usage,
      ...(stderrAll ? { stderr_tail: transcripts.stderrTail(stderrAll), ...(stderrRel && fs.existsSync(stderrFile) ? { stderr_file: stderrRel } : {}) } : {}),
      ...(rawOutcome === 'ok' ? {} : { errors: (runs[0].timedOut ? [`timed out after ${capSec || S.timeoutSec}s${grace ? `; its time-up turn ${last.timedOut ? 'timed out too' : ok(last) ? 'replied without a valid result' : `failed (exit ${last.code})`}` : ''}`] : last.code !== 0 || last.timedOut ? [last.timedOut ? `timed out after ${capSec || S.timeoutSec}s` : `exit ${last.code}: ${errorLine(last.stderr)}`] : errors).slice(0, 5) }),
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
    const model = S.modelsOff ? null : modelId(S.modelIds, spec.model);
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
      if (t.sweep) add(`sweep ${id}`, t.sweep, t.sweep_prompt.replace('{{swept}}', '(from the builder)'), b.sweep_schema);
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
  if (d.action === 'skill' && d.skill === 'clarify') return { workflow: 'clarify', config: null }; // the clarify skill's stage
  return null;
}

// A workflow runs only when `factory next` asked for exactly it, on an active job with no
// gate pending, and its result hasn't been recorded for that decision yet (a degraded or
// stale result may be run again).
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
// time, and its holder touches it every heartbeat_sec. A lock is stale when its heartbeat
// stopped (LOCK_STALE_BEATS beats missed: the holder hung, or died and its pid was reused), or
// its process is gone (or is no longer a factory process).
const HEARTBEAT_SEC = 15;
const LOCK_STALE_BEATS = 8;
function lockAlive(lock, stat = null) {
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return false;
  if (lock.heartbeat_sec > 0 && stat && Date.now() - stat.mtimeMs > lock.heartbeat_sec * LOCK_STALE_BEATS * 1000) return false;
  if (lock.host && lock.host !== require('os').hostname()) return true; // another machine with a live heartbeat (or none): assume live
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

// Agents a dead run left running (its lock's `agents`): stopped before a new run starts, so two
// runs never write one worktree. Only processes that are still factory agents (Linux: their
// command line names a factory agent) are touched; elsewhere a reused pid can't be told apart.
function stopOrphans(held) {
  if (!held.host || held.host !== require('os').hostname()) return;
  for (const pid of Array.isArray(held.agents) ? held.agents : []) {
    if (!Number.isInteger(pid) || pid <= 1 || !groupAlive(pid)) continue;
    let cmd = null;
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch {
      cmd = null;
    }
    if (cmd && /--agent\s+factory:/.test(cmd)) killTree({ pid }, 'SIGKILL');
  }
}

// The lock file's holder still at work (its process alive and its heartbeat recent)?
function lockFileAlive(file) {
  try {
    return lockAlive(JSON.parse(fs.readFileSync(file, 'utf8')), fs.statSync(file));
  } catch {
    return false;
  }
}

function acquireLock(root, state, info) {
  const file = path.join(require('../lib/paths').jobPaths(root, state.id).dir, 'run.lock');
  const body = JSON.stringify({ pid: process.pid, host: require('os').hostname(), started_at: new Date().toISOString(), heartbeat_sec: HEARTBEAT_SEC, ...info });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      const beat = setInterval(() => {
        try {
          const now = new Date();
          fs.utimesSync(file, now, now);
        } catch {
          /* released */
        }
      }, HEARTBEAT_SEC * 1000);
      beat.unref();
      lockFile = file;
      return {
        file,
        release: () => {
          clearInterval(beat);
          if (lockFile === file) lockFile = null;
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
    let stat = null;
    try {
      held = JSON.parse(fs.readFileSync(file, 'utf8'));
      stat = fs.statSync(file);
    } catch {
      held = null;
    }
    if (held && lockAlive(held, stat)) {
      fail(`Another factory run (${held.workflow || 'workflow'}${held.config ? ` --config ${held.config}` : ''}, pid ${held.pid}, started ${held.started_at}) is still running for ${state.id}. Wait for it to finish and read its output; don't start it again.`, 'run_in_progress', { lock: file, ...held });
    }
    if (held) stopOrphans(held);
    fs.rmSync(file, { force: true }); // stale: its process is gone or its heartbeat stopped
  }
  fail(`Could not take the run lock ${file}.`, 'run_in_progress', { lock: file });
}

function copilotUnavailable(ctx) {
  const u = ctx.unavailable;
  if (u.why === 'transient') {
    // count it; after transient_park_after such runs in a row the job parks (kind transient)
    let n = 0;
    let parked = false;
    try {
      const job = require('./job');
      const st = job.mutate(ctx.root, ctx.state.id, (s) => {
        s.transient_aborts = (s.transient_aborts || 0) + 1;
      });
      n = st.transient_aborts;
      if (n >= ctx.settings.transientParkAfter && st.status === 'active') {
        require('./decision-table').park(ctx.root, job.load(ctx.root, ctx.state.id), `Copilot failed with rate limits, server or network errors in ${n} runs in a row (last: ${u.detail}).`, 'transient');
        parked = true;
      }
    } catch {
      /* the count is advice; the run stops either way */
    }
    fail(parked
      ? `Copilot kept failing with a rate limit, a server error or a network error (${u.detail}) in ${n} runs in a row, so the job is parked (transient). Nothing was recorded and no attempt was spent. Reply "resume" once Copilot works again.`
      : `Copilot kept failing with a rate limit, a server error or a network error (${u.detail}), so the run stopped after its retries (${n} such run(s) in a row; the job parks after ${ctx.settings.transientParkAfter}). Nothing was recorded and no attempt was spent. Wait a few minutes, then run factory next (or factory drive) again.`, 'copilot_transient', { why: u.why, detail: u.detail, copilot: ctx.settings.bin, agents: ctx.runs, transient_runs: n, parked });
  }
  const how = u.why === 'not_signed_in'
    ? 'The Copilot CLI is not signed in. Run `copilot` in a terminal and use /login (or set COPILOT_GITHUB_TOKEN), then run factory next.'
    : `The Copilot CLI could not be started as "${ctx.settings.bin}". Install it (npm install -g @github/copilot, or see the Copilot CLI docs), make sure it is on PATH or set COPILOT_BIN, then run factory next.`;
  fail(`${how} (${u.detail}) Nothing was recorded.`, 'copilot_unavailable', { why: u.why, detail: u.detail, copilot: ctx.settings.bin, agents: ctx.runs });
}

async function run(root, { jobId, workflow, config, mode, scope, lanes, threatModel, planCritique, dryRun = false, quiet = false }) {
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
    const brief = require('./wfargs').build(root, { jobId: state.id, workflow, config, mode, scope, lanes, threatModel, planCritique });
    const S = settings(root, state);
    const ctx = { root, state, brief, settings: S, files: 0, scratch: path.join(root, '.factory', 'scratch', 'runner', state.id, '<run>') };
    return { dry_run: true, job: state.id, workflow, config: brief.config || null, copilot: S.bin, max_parallel_agents: S.maxParallel, preflight: check, brief, agents: plannedAgents(ctx) };
  }

  const lock = acquireLock(root, state, { workflow, config: config || null });
  let undoInterrupt = () => {};
  try {
    state = job.resolve(root, state.id);
    const decision = preflight(root, state, workflow, config);
    const brief = require('./wfargs').build(root, { jobId: state.id, workflow, config, mode, scope, lanes, threatModel, planCritique });
    const S = settings(root, state);
    // the disk budget (transcripts.pruneAll): this job's older runs per workflow, ended jobs, the total;
    // this run's folder does not exist yet, and other jobs' live runs are never touched
    transcripts.pruneAll(root, { ...S.transcripts, keepRuns: Math.max(1, S.transcripts.keepRuns - 1) }, { ownJob: state.id });
    const t0 = Date.now();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    const ctx = {
      root,
      state,
      brief,
      settings: S,
      runs: [],
      checks: [],
      taskEnv: {},
      phases: [],
      notes: [],
      files: 0,
      unavailable: null,
      scratch: path.join(root, '.factory', 'scratch', 'runner', state.id, `${stamp}-${workflow}${brief.config ? `-${brief.config}` : ''}-${process.pid}`),
      transcripts: path.join(transcripts.runsDir(root, state.id), `${stamp}-${workflow}${brief.config ? `-${brief.config}` : ''}-${process.pid}`),
      decisionId: decision.id,
      limit: limiter(S.maxParallel),
      say,
      note: (m) => {
        ctx.notes.push(m);
        say(m);
      },
    };

    const args = {};
    for (const [k, v] of Object.entries({ config, mode, scope, lanes, 'threat-model': threatModel, 'plan-critique': planCritique })) if (v !== undefined && v !== null) args[k] = v;
    logCli(root, { cmd: 'wfargs', sub: workflow, args, job: state.id, workflow, config: brief.config || config || null, mode: brief.mode || null, brief_hash: brief.input_hash || null });

    // The run's boundaries and each step as it starts, in the event log while the run is live, so
    // the console can show where the workflow is (run-steps.js). Observation only: append never throws.
    ctx.wfRun = crypto.randomUUID();
    ctx.phaseIndex = -1;
    const wfBase = { wf_run: ctx.wfRun, job: state.id, decision_id: decision.id, workflow, config: brief.config || null };
    events.append(root, { event: 'workflow_start', ...wfBase, mode: brief.mode || null, round: typeof brief.round === 'number' ? brief.round : null, pid: process.pid });
    const wfEnd = (rec) => events.append(root, { event: 'workflow_end', ...wfBase, ms: Date.now() - t0, phases: ctx.phases.length, agents: ctx.runs.length, ...rec });
    undoInterrupt = onInterrupt((sig) => {
      wfEnd({ outcome: 'interrupted', status: null, signal: sig, error: `factory run was stopped (${sig}); its agents were stopped too` });
      lock.release();
    });
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
      factory: workflowApi(ctx),
    };
    let envelope;
    try {
      envelope = await execute(pluginPath('workflows', `${workflow}.js`), JSON.stringify(brief), api);
    } catch (e) {
      wfEnd({ outcome: 'failed', status: null, error: ctx.unavailable ? `copilot unavailable: ${ctx.unavailable.detail}` : String(e.message).slice(0, 300) });
      if (ctx.unavailable) copilotUnavailable(ctx);
      // a loop's diagnosis that failed (not a Copilot outage, which is retried): the loop records a
      // fallback diagnosis that asks the human, so the router does not ask for it forever
      else if (brief.config === 'diagnose' && brief.mode) {
        try {
          require('./loop').fallbackDiagnosis(root, brief.job, brief.mode, `the diagnosis workflow failed: ${String(e.message).slice(0, 200)}`);
        } catch {
          /* the repeat guard still ends it */
        }
      }
      fail(`The ${workflow} workflow failed: ${e.message}`, 'workflow_failed', { agents: ctx.runs });
    }
    if (ctx.unavailable) {
      wfEnd({ outcome: 'failed', status: null, error: `copilot unavailable: ${ctx.unavailable.detail}` });
      copilotUnavailable(ctx);
    }
    wfEnd({ outcome: 'ok', status: (envelope && envelope.status) || null });
    // clarify lists every failure explicitly: it gets how each agent came back (timeout, exit …)
    if (workflow === 'clarify' && envelope && envelope.data) envelope.data.runs = ctx.runs.map((r) => ({ label: r.label, role: r.role, outcome: r.outcome, ms: r.ms, ...(r.time_cap_sec ? { time_cap_sec: r.time_cap_sec } : {}), ...(r.errors ? { errors: r.errors.slice(0, 2) } : {}) }));
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
    // a run that got through: transient failures before it were transient after all
    try {
      if (job.load(root, state.id).transient_aborts) job.mutate(root, state.id, (s) => { delete s.transient_aborts; });
    } catch {
      /* advice only */
    }
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
      ...(ctx.checks.length ? { checks: ctx.checks } : {}),
    };
    const resultFile = file.replace(/\.json$/, '.result.json');
    out.result_file = resultFile;
    writeJson(resultFile, out);
    return out;
  } finally {
    undoInterrupt();
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
  // build trouble counts too (P4.4): parks, retries, scope violations, a broken environment,
  // timeouts and integration failures are what a process or environment lesson comes from
  const worth = context.confirmed.length || context.verify_fix_rounds || (context.minor.length && context.minor_in_other_jobs.length) || (context.trouble && context.trouble.count);
  const left = Math.max(0, (context.cap || 0) - context.already_proposed.length);
  const log = (rec) => events.append(root, { event: 'distill_write', job: state.id, decision_id: d.id, ...rec });
  if (!worth || !left) {
    const why = !left ? `the cap of ${context.cap} lessons is already used` : 'no confirmed findings, no verify-fix rounds, no minor findings repeated in other jobs, no build trouble (parks, retries, scope violations, environment, timeouts, integration failures)';
    log({ outcome: 'skipped', reason: why, lessons: [] });
    return { job: state.id, skipped: true, reason: `Nothing to learn from: ${why}. No agent was started. Run factory distill done.`, lessons: [], agents: [] };
  }
  const lock = acquireLock(root, state, { workflow: 'distill-write', config: null });
  let undoInterrupt = () => {};
  try {
    state = job.resolve(root, state.id);
    const S = settings(root, state);
    transcripts.pruneAll(root, { ...S.transcripts, keepRuns: Math.max(1, S.transcripts.keepRuns - 1) }, { ownJob: state.id });
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
      transcripts: path.join(transcripts.runsDir(root, state.id), `${stamp}-distill-${process.pid}`),
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
    const model = require('./wfargs').roleModel(state.policy, role);
    const prompt = [
      `# Distill job ${state.id}: ${state.title}`,
      '',
      `You may write at most ${left} lesson(s) from this job. Lessons that already exist: already_proposed below, and ${path.join(root, '.factory', 'lessons', 'lessons.json')}.`,
      'Learn from the build trouble too (`trouble` below: parks, resumes, retries, scope violations, a broken environment, timeouts, integration failures, blocked or exhausted tasks, manual repairs): a process or environment lesson ("Run the services health check before the first wave", "Tasks that touch src/cli.js are one wiring task") is as good as a code lesson. Scope such a lesson to the paths it is about, or `**` when it is about the whole project.',
      'Record each lesson with exactly this command (one per lesson):',
      `  ${cli} lessons add --job ${state.id} --text "<lesson>" --scope "<glob>,<glob>" --why "<finding id: what went wrong>"`,
      'The command prints the lesson with its id (L<n>). Run no other factory command.',
      '',
      '## Distill context',
      '```json',
      JSON.stringify(context, null, 2),
      '```',
      ...(() => {
        // the project brief, for the edits the lesson-writer may propose (the CLI applies them)
        const pb = require('./project-brief');
        pb.ensure(root, state.policy);
        const text = pb.read(root);
        return text ? ['', `## Project brief (${pb.file(root)}): propose edits in your reply's project_brief (the user accepts or rejects them), never edit the file`, '```markdown', text.trim(), '```'] : [];
      })(),
    ].join('\n');
    // one step, logged like a workflow run's, so the console's Learn bank shows it while it runs
    const t0 = Date.now();
    ctx.wfRun = crypto.randomUUID();
    const wfBase = { wf_run: ctx.wfRun, job: state.id, decision_id: d.id, workflow: 'distill', config: null };
    events.append(root, { event: 'workflow_start', ...wfBase, mode: null, round: null, pid: process.pid });
    events.append(root, { event: 'workflow_phase', ...wfBase, text: 'distill: write lessons', index: 0 });
    ctx.phaseIndex = 0;
    const wfEnd = (rec) => events.append(root, { event: 'workflow_end', ...wfBase, ms: Date.now() - t0, phases: 1, agents: ctx.runs.length, ...rec });
    undoInterrupt = onInterrupt((sig) => {
      wfEnd({ outcome: 'interrupted', status: null, signal: sig, error: `factory distill write was stopped (${sig})` });
      lock.release();
    });
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
    // the lesson-writer's proposed diff to the project brief, applied by the CLI (never by the agent)
    // the lesson-writer's diff to the project brief is a proposal for the user (P<n>), applied
    // only on their "accept brief P<n>", like a lesson; never applied here
    const brief = reply && reply.project_brief && Array.isArray(reply.project_brief.edits) ? require('./project-brief').propose(root, reply.project_brief.edits, { job: state.id, why: reply.project_brief.why }) : null;
    log({ outcome, lessons: added.map((l) => l.id), claimed, unrecorded, agent_ms: run.ms || null, ...(brief ? { project_brief: { proposal: brief.id, edits: brief.edits.length, refused: brief.refused.length } } : {}) });
    const out = {
      job: state.id,
      outcome,
      lessons: added.map((l) => ({ id: l.id, text: l.text, scope: l.scope, why: l.why || null })),
      ...(unrecorded.length ? { unrecorded, warning: `The lesson-writer named ${unrecorded.join(', ')} but no such lesson was recorded for ${state.id}; only the lessons listed were recorded.` } : {}),
      ...(reply && reply.note ? { note: reply.note } : {}),
      ...(brief ? { project_brief: { file: require('./project-brief').file(root), proposal: brief.id, edits: brief.edits, refused: brief.refused, why: reply.project_brief.why || null, ...(brief.id ? { reply: [`accept brief ${brief.id}`, `reject brief ${brief.id} <why>`] } : {}) } } : {}),
      message: `${brief && brief.id ? `Project brief change proposed: ${brief.id} (the user can reply "accept brief ${brief.id}" or "reject brief ${brief.id} <why>"). ` : ''}${added.length ? `${added.length} lesson(s) proposed: ${added.map((l) => l.id).join(', ')}. The user can reply "accept lesson Ln" or "reject lesson Ln <why>". Run factory distill done.` : outcome === 'ok' ? 'The lesson-writer found nothing worth a lesson. Run factory distill done.' : `The lesson-writer did not finish (${outcome}); no lessons were recorded. Run factory distill done to move on, or factory distill write to try again.`}`,
      copilot: S.bin,
      agents: ctx.runs,
    };
    return out;
  } finally {
    undoInterrupt();
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
  if (r.park && r.park.kind) L.push(`park: ${r.park.kind} — next: ${r.park.next}`);
  if (Array.isArray(r.questions) && r.questions.length) {
    L.push(`questions (${r.questions.length})${r.intent_first ? ' — intent first: other questions wait' : ''}:`);
    r.questions.forEach((q, i) => {
      const opts = Array.isArray(q.options) && q.options.length ? ` | options: ${q.options.map(one).join(' / ')}` : '';
      const ground = `${q.unknown ? ` | unknown: ${q.unknown}${q.kind ? ` (${q.kind})` : ''}` : ''}${Array.isArray(q.evidence) && q.evidence.length ? ` | evidence: ${q.evidence.join(', ')}` : q.preference ? ' | your call' : ''}${q.researchable ? ` | researchable, asked because: ${q.note || 'research did not settle it'}` : ''}`;
      L.push(`  ${i + 1}. ${q.id ? `${q.id} ` : ''}${q.category ? `[${q.category}] ` : ''}${q.question}${q.why ? ` | why: ${q.why}` : ''}${opts}${q.default !== undefined && q.default !== null ? ` | default: ${one(q.default)}` : ''}${ground}`);
    });
  }
  // clarify v3: the stage it moved to, and the screen to show the user as it is
  if (r.stage) L.push(`clarify stage: ${r.stage}`);
  if (r.research && Array.isArray(r.research.failures) && r.research.failures.length) {
    L.push('research failures:');
    for (const f of r.research.failures.slice(0, 10)) L.push(`  - ${f.what}: ${f.reason}`);
  }
  if (r.refused) L.push(`refused: ${r.refused}`);
  if (r.screen) L.push('screen (show it to the user as it is):', r.screen);
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
  for (const a of agents.filter((x) => x.outcome !== 'ok')) L.push(`  - ${a.label} (${a.agent_type}) ${a.outcome}${a.errors && a.errors.length ? `: ${String(a.errors[0]).slice(0, 160)}` : ''}${a.transcript ? ` [transcript: ${a.transcript}${a.stderr_file ? `, stderr: ${a.stderr_file}` : ''}]` : ''}`);
  const cost = transcripts.totals(agents);
  if (agents.length) L.push(`usage: ${cost.tool_calls ?? "?"} tool call(s)${cost.reported_runs ? `, ${cost.input_tokens ?? '?'} input / ${cost.output_tokens ?? '?'} output tokens${cost.premium_requests !== null ? `, ${cost.premium_requests} premium request(s)` : ''}` : ''}${cost.unreported_runs ? ` (${cost.unreported_runs} run(s) without usage records from the CLI: unknown)` : ''}`);
  L.push(`full result: ${r.result_file} (or run with --json)`);
  return L.join('\n');
}

module.exports = { transient, run, distillWrite, runAgent, workflowApi, cliChild, killAgents, HEARTBEAT_SEC, execute, extractJson, replyText, copilotArgs, toolPermissions, agentTools, resolveBin, command, modelId, settings, limiter, preflight, summaryText, lockAlive, lockFileAlive, WORKFLOWS };
