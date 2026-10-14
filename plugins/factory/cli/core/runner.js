'use strict';
// factory run <workflow> — runs the same workflows/*.js scripts the Claude Code Workflow
// tool runs, on the GitHub Copilot CLI. Copilot has no Workflow tool, so this module
// emulates the small Workflow API the scripts use (top-level await and return, globals
// args / agent / pipeline / parallel / phase / log, no Date or Math.random), and each
// agent() call spawns one non-interactive Copilot CLI session as the role's custom agent:
//
//   copilot -p <prompt> --agent factory:<role> [--model <id>] --output-format json -s
//           --no-ask-user --allow-all-tools [--add-dir <project root>] [--session-id <uuid>]
//           [policy.copilot.flags…]
//
// Flags, from the official docs (gh-docs/content/copilot/…):
//   -p, -s, --agent, --model, --no-ask-user, --output-format json (JSONL), --add-dir:
//     reference/copilot-cli-reference/cli-programmatic-reference.md "Command line options"
//   --allow-all-tools ("Required when using the CLI programmatically"), --session-id
//     (resumes an existing session id; creates one for a new valid UUID), -C, --plugin-dir:
//     reference/copilot-cli-reference/cli-command-reference.md "Command-line options"
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
const MAX_ARG_PROMPT = 96 * 1024; // Linux caps one argv string at 128 KiB; longer prompts go through a file
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

function copilotArgs({ prompt, agentType, model, cwd, root, sessionId, flags }) {
  return [
    '-p', prompt,
    '--agent', agentType,
    ...(model ? ['--model', model] : []),
    '--output-format', 'json',
    '-s',
    '--no-ask-user',
    '--allow-all-tools',
    ...(path.resolve(cwd) !== path.resolve(root) ? ['--add-dir', root] : []),
    ...(sessionId ? ['--session-id', sessionId] : []),
    ...flags,
  ];
}

function command(bin, argv) {
  return /\.c?js$/.test(bin) ? [process.execPath, [bin, ...argv]] : [bin, argv];
}

function spawnCopilot(bin, argv, { cwd, env, timeoutSec }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const [file, args] = command(bin, argv);
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
      child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  try {
    return require('./tasks').prepareWorktree(ctx.root, ctx.state, m[2]);
  } catch (e) {
    ctx.note(`could not prepare the worktree for ${m[2]} (${e.message}); starting its agent at the project root`);
    return ctx.root;
  }
}

// Long prompts go through a file so they never hit the argv size limit.
function deliverable(ctx, prompt, label) {
  if (Buffer.byteLength(prompt) <= MAX_ARG_PROMPT) return prompt;
  ctx.files += 1;
  const file = path.join(ctx.scratch, `${String(ctx.files).padStart(3, '0')}-${String(label).replace(/[^\w.-]+/g, '_').slice(0, 60)}.md`);
  writeText(file, prompt);
  return `Your full instructions for this run are in this file. Read all of it first and follow it exactly:\n  ${file}\nFinish by replying with only the JSON object it asks for.`;
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
  return ctx.limit(async () => {
    const cwd = cwdFor(ctx, o, { prepare: true });
    const sessionId = S.resumeForRetry ? crypto.randomUUID() : null;
    const env = { ...process.env, FACTORY_ROOT: ctx.root, FACTORY_RUNNER: '1', FACTORY_JOB: ctx.brief.job, FACTORY_AGENT_ROLE: role, FACTORY_AGENT_LABEL: o.label || role };
    const spawnOnce = (text) =>
      spawnCopilot(S.bin, copilotArgs({ prompt: deliverable(ctx, text, o.label || role), agentType, model, cwd, root: ctx.root, sessionId, flags: S.flags }), { cwd, env, timeoutSec: S.timeoutSec });
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
      if (!result) {
        retry = true;
        const fix = correction(o.schema, errors);
        runs.push(await spawnOnce(S.resumeForRetry ? fix : `${full}\n\n${fix}`));
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
      ...(result ? {} : { errors: (last.code !== 0 || last.timedOut ? [last.timedOut ? `timed out after ${S.timeoutSec}s` : `exit ${last.code}: ${String(last.stderr || '').trim().slice(-300)}`] : errors).slice(0, 5) }),
    };
    ctx.runs.push(rec);
    events.append(ctx.root, {
      event: 'agent_run',
      job: ctx.brief.job,
      decision_id: ctx.decisionId,
      workflow: ctx.brief.workflow,
      config: ctx.brief.config || null,
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
    items.push({ label, agent_type: spec.agent_type, model: spec.model || null, model_id: model, cwd, command: [S.bin, ...copilotArgs({ prompt: `${prompt}${replyBlock(schema)}`, agentType: spec.agent_type, model, cwd, root: ctx.root, sessionId: S.resumeForRetry ? '<uuid>' : null, flags: S.flags })] });
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

async function run(root, { jobId, workflow, config, mode, scope, lanes, threatModel, planCritique, acceptDegraded, dryRun = false, quiet = false }) {
  if (!WORKFLOWS.includes(workflow)) fail(`factory run <${WORKFLOWS.join('|')}> (got ${workflow || 'nothing'})`, 'bad_input');
  const job = require('./job');
  const state = job.resolve(root, jobId);
  const brief = require('./wfargs').build(root, { jobId: state.id, workflow, config, mode, scope, lanes, threatModel, planCritique, acceptDegraded });
  const S = settings(root, state);
  const say = (m) => {
    if (!quiet) process.stderr.write(`[factory run] ${m}\n`);
  };
  const ctx = {
    root,
    state,
    brief,
    settings: S,
    runs: [],
    phases: [],
    notes: [],
    files: 0,
    scratch: path.join(root, '.factory', 'scratch', 'runner', state.id),
    decisionId: events.context(root, state.id).decision_id,
    limit: limiter(S.maxParallel),
    say,
    note: (m) => {
      ctx.notes.push(m);
      say(m);
    },
  };
  const head = { job: state.id, workflow, config: brief.config || null, copilot: S.bin, max_parallel_agents: S.maxParallel };
  if (dryRun) return { dry_run: true, ...head, brief, agents: plannedAgents(ctx) };

  const args = {};
  for (const [k, v] of Object.entries({ config, mode, scope, lanes, 'threat-model': threatModel, 'plan-critique': planCritique, 'accept-degraded': acceptDegraded || undefined })) if (v !== undefined && v !== null) args[k] = v;
  logCli(root, { cmd: 'wfargs', sub: workflow, args, job: state.id, workflow, config: brief.config || config || null, mode: brief.mode || null, brief_hash: brief.input_hash || null });

  const api = {
    agent: (prompt, opts) => runAgent(ctx, prompt, opts),
    phase: (m) => {
      ctx.phases.push(String(m));
      say(`phase: ${m}`);
    },
    log: (m) => {
      ctx.notes.push(String(m));
      say(String(m));
    },
  };
  const t0 = Date.now();
  let envelope;
  try {
    envelope = await execute(pluginPath('workflows', `${workflow}.js`), JSON.stringify(brief), api);
  } catch (e) {
    fail(`The ${workflow} workflow failed: ${e.message}`, 'workflow_failed', { agents: ctx.runs });
  }
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
  return {
    ...head,
    status: envelope.status,
    summary: envelope.summary,
    ms: Date.now() - t0,
    envelope_file: file,
    phases: ctx.phases,
    notes: ctx.notes,
    agents: ctx.runs,
    record: rec,
  };
}

module.exports = { run, execute, extractJson, replyText, copilotArgs, modelId, settings, limiter, WORKFLOWS };
