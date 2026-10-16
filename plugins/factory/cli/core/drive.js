'use strict';
// factory drive — the deterministic driver (P3.1). A loop over `factory next` that does what it
// says for every step a program can do: workflows (`factory run`, clarify's agent stages
// included), CLI steps, ship, distill, and evidence records the CLI can check. It stops only
// where a person is needed:
//   gate        a human gate (H1, H2, H3, HF, HS, EH*, A): the human approves or denies
//   clarify     clarify waits on the user (read-back, decision sheet, redirect read-back)
//   questions   ground's blocking questions for the user
//   degraded    a workflow ran without an angle: re-run, or go on without it
//   parked      the job parked (typed: kind and the suggested next step)
//   wait        the merge, a PR, a human check of a criterion
//   amend       an amendment needs the main session (what changed, and the edit)
//   evidence    a doc/diff record the CLI cannot pick a file for
//   done        the job is closed (or cancelled/abandoned)
//   error, copilot_unavailable, transient, interrupted, limit
// It never answers a gate or a clarify turn itself: the human-only verbs stay the human's
// (chat replies through the prompt hook, or their own terminal with its typed code), and the
// drive runs none of them. Every stop is written to the event log (`drive_stop`, typed), to
// .factory/drive.json, as one line on stderr, and as a desktop notification (notify.js).
//
// Every step runs as its own `factory` child process (the same commands the main session would
// run, logged the same way, with via "drive"), so the router, the run lock and the inspector
// see exactly what a hand-driven job shows. The drive keeps no state of its own beyond
// .factory/drive.json: rerun it after a crash or a stop and it continues from `factory next`.
// One drive per repository at a time (drive.json holds its pid and a heartbeat); while it runs,
// `factory next` and `factory run` from anyone else say so instead of racing it.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { fail, nowIso } = require('../lib/util');
const { PLUGIN_ROOT, project, jobPaths } = require('../lib/paths');
const events = require('./events');

const HEARTBEAT_SEC = 10;
const STALE_BEATS = 6;
const MAX_STEPS = 400;

const driveFile = (root) => path.join(project(root).dir, 'drive.json');
const logFile = (root) => path.join(project(root).dir, 'drive.log');

function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(driveFile(root), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(root, st) {
  try {
    fs.mkdirSync(path.dirname(driveFile(root)), { recursive: true });
    const tmp = `${driveFile(root)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n');
    fs.renameSync(tmp, driveFile(root));
  } catch {
    /* the drive goes on; status shows less */
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// A running drive: its process is alive and its heartbeat recent.
function alive(st) {
  if (!st || st.status !== 'running') return false;
  if (st.host && st.host !== require('os').hostname()) return true;
  if (!pidAlive(st.pid)) return false;
  const beat = Date.parse(st.heartbeat_at || st.started_at || '') || 0;
  return Date.now() - beat <= HEARTBEAT_SEC * STALE_BEATS * 1000;
}

// The live drive for this job (or any job when jobId is null), or null.
function liveFor(root, jobId = null) {
  const st = readState(root);
  if (!alive(st)) return null;
  if (jobId && st.job && st.job !== jobId) return null;
  return st;
}

// Am I (this process) running under that drive? Its children carry FACTORY_DRIVE=<pid>.
function isDriveChild(st) {
  return Boolean(st && String(process.env.FACTORY_DRIVE || '') === String(st.pid));
}

// What `factory next` returns while a drive runs the job (anyone but the drive asking).
function drivingAnswer(st, jobId) {
  return {
    job: jobId || st.job,
    action: 'driving',
    reason: `factory drive (pid ${st.pid}, since ${st.started_at}) is running ${st.job}: it steps the job itself and stops where you are needed.`,
    drive: { pid: st.pid, job: st.job, started_at: st.started_at, step: st.step || null, log: st.log || null },
    instructions: 'Wait for it: factory drive status --wait 600 (returns when it stops, or after the wait). Don\'t run factory next or factory run alongside it.',
  };
}

// ---------------------------------------------------------------- one factory command

function cliArgs(root, args, jobId) {
  const a = [path.join(PLUGIN_ROOT, 'bin', 'factory'), '--root', root, ...args];
  if (jobId && !args.includes('--job')) a.push('--job', jobId);
  return a;
}

// Run `factory <args>` as a child; resolves to { code, json, stdout }. Its stderr (factory run's
// progress lines) goes to ours, so a foreground drive shows the work as it happens.
function runChild(ctx, args, { jobId = ctx.job } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, FACTORY_ROOT: ctx.root, FACTORY_DRIVE: String(process.pid) };
    for (const k of ['FACTORY_RUNNER', 'FACTORY_VIA', 'FACTORY_AGENT_ROLE', 'FACTORY_AGENT_LABEL']) delete env[k];
    let out = '';
    let child;
    try {
      child = spawn(process.execPath, cliArgs(ctx.root, args, jobId), { cwd: ctx.root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ code: -1, json: { error: true, code: 'internal', message: e.message }, stdout: '' });
      return;
    }
    ctx.child = child;
    child.stdout.on('data', (d) => {
      if (out.length < 16 * 1024 * 1024) out += d;
    });
    child.stderr.on('data', (d) => ctx.err(String(d)));
    const done = (code) => {
      if (ctx.child === child) ctx.child = null;
      let json = null;
      try {
        json = JSON.parse(out);
      } catch {
        json = null;
      }
      resolve({ code: code === null ? -1 : code, json, stdout: out });
    };
    child.on('error', (e) => {
      out = JSON.stringify({ error: true, code: 'internal', message: e.message });
      done(-1);
    });
    child.on('close', (code) => done(code));
  });
}

// "factory ci verify --job J-0001" → ['ci', 'verify', '--job', 'J-0001'] (quotes kept together)
function words(command) {
  return (String(command || '').replace(/^\s*factory\s+/, '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^(["'])([\s\S]*)\1$/, '$2'));
}

// The `factory run` arguments for a workflow action, exactly the fields `factory next` gave.
function runArgs(n) {
  const a = ['run', n.workflow || 'clarify'];
  if (n.config) a.push('--config', n.config);
  if (n.mode) a.push('--mode', n.mode);
  if (n.scope) a.push('--scope', n.scope);
  if (n.lanes && [].concat(n.lanes).length) a.push('--lanes', [].concat(n.lanes).join(','));
  if (n.threat_model === true) a.push('--threat-model');
  if (n.threat_model === false) a.push('--no-threat-model');
  if (n.plan_critique) a.push('--plan-critique');
  a.push('--json');
  return a;
}

// ---------------------------------------------------------------- evidence the CLI can check

// A doc/diff record the drive may make itself: exactly one file of that kind among the files
// the tasks covering the criterion changed. Anything else (none, several) is the main session's
// judgement and a stop.
const DOC_FILE = /(^|\/)(docs?|documentation)\/|\.(md|mdx|markdown|rst|adoc|txt)$|(^|\/)README[^/]*$/i;
function evidencePath(root, jobId, ac, type) {
  try {
    const job = require('./job');
    const git = require('../lib/git');
    const steps = require('./steps');
    const { matchesAny } = require('../lib/glob');
    const state = job.load(root, jobId);
    const plan = require('../lib/util').readJson(jobPaths(root, jobId).plan, { tasks: [] }) || { tasks: [] };
    const tasks = (plan.tasks || []).filter((t) => (t.criteria_ids || []).includes(ac));
    if (!tasks.length) return null;
    const changed = new Set();
    for (const t of tasks) {
      const br = steps.taskBranch(state, t.id);
      if (!git.branchExists(root, br)) continue;
      for (const f of git.changedFiles(root, state.base_commit, br)) if (matchesAny(f, t.allowed_paths || [])) changed.add(f);
    }
    const inBuild = new Set(git.changedFiles(root, state.base_commit, state.branch));
    const cands = [...changed].filter((f) => inBuild.has(f) && (type !== 'doc' || DOC_FILE.test(f)));
    return cands.length === 1 ? { path: cands[0], tasks: tasks.map((t) => t.id) } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- stops

const STOP_TITLE = {
  gate: 'gate waits for you',
  clarify: 'clarify waits for your reply',
  questions: 'questions for you',
  degraded: 'a run came back degraded',
  parked: 'job parked',
  wait: 'waiting on you',
  amend: 'an amendment needs you',
  evidence: 'evidence needs a look',
  skill: 'a step needs the main session',
  done: 'job done',
  error: 'drive stopped on an error',
  copilot_unavailable: 'Copilot unavailable',
  transient: 'Copilot rate-limited or offline',
  interrupted: 'drive interrupted',
  limit: 'drive step limit reached',
};

// What the human (or the main session) does next, for each kind of stop.
function stopDetail(kind, n, extra = {}) {
  const J = (n && n.job) || extra.job;
  const g = n && n.gate;
  switch (kind) {
    case 'gate':
      return {
        gate: g ? { id: g.id, hash: g.hash, docs: g.docs || [] } : null,
        summary: `${J} waits at gate ${g ? g.id : n.step}${g && g.hash ? ` (hash ${String(g.hash).slice(0, 12)})` : ''}${n.resumes_park ? '; approving it also resumes the parked job' : ''}.`,
        reply: 'approve | deny <what must change>',
        command: g && g.id === 'A' ? `factory approve --job ${J}` : `factory approve ${g ? g.id : ''} --job ${J}`.replace('  ', ' '),
        alt_command: `factory deny --job ${J} --reason "<what must change>"`,
      };
    case 'clarify': {
      const c = (n && n.clarify) || {};
      const stage = extra.stage || c.stage || null;
      const what = { readback_wait: 'the read-back: ok, or what to change', sheet_wait: 'the decision sheet: your answers', redirect_wait: 'how your redirect was read: ok, or what to change' }[stage] || stage || 'clarify';
      return { stage, screen: extra.screen || c.screen || null, summary: `${J}: clarify waits on your reply (${what}).`, reply: 'ok, or your corrections / sheet answers in your own words', command: `factory clarify reply "<your words>" --job ${J}` };
    }
    case 'questions':
      return { questions: extra.questions || [], summary: `${J}: ${(extra.questions || []).length} question(s) block the design.`, reply: 'answer each question', command: `factory answer --job ${J} --question "<question>" --answer "<answer>"` };
    case 'degraded':
      return { degraded: extra.degraded || [], summary: `${J}: ${n.workflow || 'a workflow'} ran without ${(extra.degraded || []).join(', ') || 'an angle'}: re-run it, or go on without it (recorded under Assumptions, then run with --accept-degraded).`, reply: 're-run | go on without it' };
    case 'parked': {
      const p = n.park || {};
      return { park: { kind: p.kind || null, next: p.next || null }, summary: `${J} parked${p.kind ? ` (${p.kind})` : ''}: ${String(n.reason || '').split('\n')[0].slice(0, 300)}${p.next ? ` Next: ${p.next}` : ''}`, reply: 'resume | cancel job | abandon job | what to change', command: `factory resume --job ${J}`, alt_command: `factory cancel --job ${J}` };
    }
    case 'wait': {
      const merged = /merged/.test(n.reason || '');
      return { summary: `${J}: ${n.reason || 'waiting on you'}`, reply: merged ? 'merged <commit>' : (n.acs || []).length ? (n.acs || []).map((a) => `confirm ${a}`).join(' | ') : 'continue', ...(merged ? { command: `factory merged <commit> --job ${J}` } : (n.acs || []).length ? { command: `factory confirm ${n.acs[0]} --job ${J}` } : {}) };
    }
    case 'amend':
      return { summary: `${J}: ${n.reason || 'an amendment is needed'} The main session follows the amend skill (what changed and who asked), then factory drive continues.` };
    case 'evidence':
      return { commands: n.commands || [], acs: n.acs || [], summary: `${J}: ${(n.acs || []).join(', ')} need${(n.acs || []).length === 1 ? 's' : ''} a doc/diff record the drive could not pick a file for: check the build and run the command with the real path, then factory drive.` };
    case 'done':
      return { summary: `${J} is done: ${n.reason || 'closed'}${extra.lessons && extra.lessons.length ? ` Lessons proposed: ${extra.lessons.map((l) => l.id).join(', ')} (reply "accept lesson Ln" or "reject lesson Ln <why>").` : ''}`, ...(extra.lessons && extra.lessons.length ? { lessons: extra.lessons } : {}) };
    default:
      return { summary: `${J || 'drive'}: ${extra.message || n.reason || kind}` };
  }
}

// ---------------------------------------------------------------- the loop

async function loop(ctx) {
  const job = require('./job');
  const fails = {};
  let requeries = 0;
  for (;;) {
    ctx.steps += 1;
    if (ctx.steps > ctx.maxSteps) return ctx.stop('limit', { job: ctx.job }, { message: `stopped after ${ctx.maxSteps} steps without reaching a stop (a loop?): read factory why --format md` });
    ctx.beat({ step: 'next' });
    const r = await runChild(ctx, ['next']);
    const n = r.json;
    if (!n || n.error) return ctx.stop('error', { job: ctx.job }, { message: `factory next failed: ${(n && n.message) || r.stdout.slice(0, 300) || `exit ${r.code}`}`, code: n && n.code });
    ctx.lastNext = n;
    ctx.job = n.job || ctx.job;
    const say = (m) => ctx.err(`[factory drive] ${ctx.job}: ${m}\n`);
    switch (n.action) {
      case 'workflow':
      case 'skill': {
        if (n.action === 'skill' && n.skill !== 'clarify') {
          if (n.skill === 'ship') {
            say('ship');
            ctx.beat({ step: 'ship' });
            const s = await runChild(ctx, ['ship']);
            if (!s.json || s.json.error) return ctx.stop('error', n, { message: `factory ship failed: ${(s.json && s.json.message) || `exit ${s.code}`}` });
            ctx.shipped = s.json;
            continue;
          }
          if (n.skill === 'distill') {
            say('distill');
            ctx.beat({ step: 'distill write' });
            const w = await runChild(ctx, ['distill', 'write']);
            if (w.json && Array.isArray(w.json.lessons)) ctx.lessons.push(...w.json.lessons);
            const d = await runChild(ctx, ['distill', 'done']);
            if (!d.json || d.json.error) return ctx.stop('error', n, { message: `factory distill done failed: ${(d.json && d.json.message) || `exit ${d.code}`}` });
            continue;
          }
          return ctx.stop(n.skill === 'amend' ? 'amend' : 'skill', n);
        }
        if (n.action === 'skill') {
          const c = n.clarify || {};
          if (c.error) return ctx.stop('error', n, { message: c.error });
          if (c.waiting_for_user || !c.run) return ctx.stop('clarify', n);
        }
        const args = runArgs(n.action === 'skill' ? { workflow: 'clarify' } : n);
        say(args.slice(0, -1).join(' '));
        ctx.beat({ step: args.slice(0, -1).join(' ') });
        const res = await runChild(ctx, args);
        const j = res.json || {};
        if (!res.json) return ctx.stop('error', n, { message: `factory ${args.join(' ')} printed no result (exit ${res.code})` });
        if (j.error) {
          if (j.code === 'run_in_progress') {
            // a run from before (a drive that crashed, or one started by hand) still holds the
            // job's lock: wait for it to end, then ask factory next again
            say(`another factory run holds the lock (pid ${(j.details && j.details.pid) || '?'}): waiting for it`);
            await ctx.waitLock(j.details && j.details.lock);
            continue;
          }
          if (j.code === 'not_waiting_for_workflow') {
            fails.not_waiting = (fails.not_waiting || 0) + 1;
            if (fails.not_waiting > 3) return ctx.stop('error', n, { message: j.message });
            continue;
          }
          if (j.code === 'copilot_unavailable') return ctx.stop('copilot_unavailable', n, { message: j.message });
          if (j.code === 'copilot_transient') return ctx.stop('transient', n, { message: j.message });
          return ctx.stop('error', n, { message: `factory ${args.slice(0, -1).join(' ')}: ${j.message}`, code: j.code });
        }
        fails.not_waiting = 0;
        say(`${args[1]} → ${j.status}`);
        if (j.status === 'needs_user') {
          if (args[1] === 'clarify') return ctx.stop('clarify', n, { stage: j.stage, screen: j.screen });
          return ctx.stop('questions', n, { questions: (j.questions || []).map((q) => q.question || q) });
        }
        if (j.status === 'degraded') return ctx.stop('degraded', n, { degraded: j.degraded || (j.workflow && j.workflow.degraded) || [] });
        continue;
      }
      case 'cli': {
        const w = words(n.command);
        say(w.join(' '));
        ctx.beat({ step: w.join(' ') });
        const res = await runChild(ctx, w);
        const key = n.command;
        if (res.code !== 0 || !res.json || res.json.error) {
          fails[key] = (fails[key] || 0) + 1;
          // a failing check (ci verify) is routed again by factory next; the same command
          // failing twice in a row with nothing else happening is a stop
          if (fails[key] >= 2 || !res.json) return ctx.stop('error', n, { message: `${n.command} failed: ${(res.json && (res.json.message || JSON.stringify(res.json).slice(0, 300))) || `exit ${res.code}`}` });
        } else fails[key] = 0;
        continue;
      }
      case 'evidence': {
        const types = {};
        for (const c of n.commands || []) {
          const m = /evidence add (AC-\d+) --type (doc|diff)/.exec(c);
          if (m) types[m[1]] = m[2];
        }
        let all = true;
        for (const ac of n.acs || []) {
          const pick = types[ac] && evidencePath(ctx.root, ctx.job, ac, types[ac]);
          if (!pick) {
            all = false;
            break;
          }
          say(`evidence ${ac}: ${types[ac]} ${pick.path} (the only ${types[ac] === 'doc' ? 'doc ' : ''}file ${pick.tasks.join(', ')} changed)`);
          const res = await runChild(ctx, ['evidence', 'add', ac, '--type', types[ac], '--path', pick.path, '--note', `factory drive: the only ${types[ac] === 'doc' ? 'documentation ' : ''}file changed by ${pick.tasks.join(', ')}, the task(s) covering ${ac}`]);
          if (!res.json || res.json.error) {
            all = false;
            break;
          }
        }
        if (!all) return ctx.stop('evidence', n);
        continue;
      }
      case 'gate':
        return ctx.stop('gate', n);
      case 'wait':
        if ((n.ready || []).length) {
          say(`slice ${n.ready[0]} is ready: factory use ${n.ready[0]}`);
          await runChild(ctx, ['use', n.ready[0]], { jobId: null });
          ctx.job = n.ready[0];
          continue;
        }
        return ctx.stop('wait', n);
      case 'parked':
        return ctx.stop('parked', n);
      case 'done': {
        // a slice job of an epic is done: back to the epic
        let parent = null;
        try {
          const s = job.load(ctx.root, ctx.job);
          parent = s.parent && job.load(ctx.root, s.parent).status === 'active' ? s.parent : null;
        } catch {
          parent = null;
        }
        if (parent && ctx.followParents) {
          say(`done; back to the epic ${parent}`);
          await runChild(ctx, ['use', parent], { jobId: null });
          ctx.job = parent;
          continue;
        }
        return ctx.stop('done', n, { lessons: ctx.lessons });
      }
      case 'driving':
        return ctx.stop('error', n, { message: 'another factory drive runs this job' });
      default:
        requeries += 1;
        if (requeries > 3) return ctx.stop('error', n, { message: `factory next returned "${n.action}", which the drive does not know` });
    }
  }
}

// ---------------------------------------------------------------- the lock and the run

function acquire(root, jobId, info) {
  const prev = readState(root);
  if (alive(prev) && prev.pid !== process.pid) {
    fail(`factory drive is already running (pid ${prev.pid}, ${prev.job}, since ${prev.started_at}). Watch it with factory drive status --wait 600, or stop it with factory drive stop.`, 'drive_in_progress', { pid: prev.pid, job: prev.job });
  }
  const st = {
    pid: process.pid,
    host: require('os').hostname(),
    job: jobId,
    status: 'running',
    started_at: nowIso(),
    heartbeat_at: nowIso(),
    detached: Boolean(info.detached),
    log: info.detached ? logFile(root) : null,
    step: null,
    steps: 0,
    ...(prev && prev.status === 'running' ? { recovered_from: { pid: prev.pid, started_at: prev.started_at, step: prev.step || null } } : {}),
    last: prev ? prev.last || null : null,
    stops: prev ? (prev.stops || []).slice(-20) : [],
  };
  writeState(root, st);
  // another drive raced us between the read and the write: the last writer wins, the other sees it
  const now = readState(root);
  if (!now || now.pid !== process.pid) fail('Another factory drive started at the same moment; watch it with factory drive status.', 'drive_in_progress');
  return st;
}

async function drive(root, { jobId, maxSteps = MAX_STEPS, detached = false, quiet = false, followParents = true } = {}) {
  const job = require('./job');
  const state = job.resolve(root, jobId);
  const st = acquire(root, state.id, { detached });
  const ctx = {
    root,
    job: state.id,
    steps: 0,
    maxSteps,
    followParents,
    lessons: [],
    child: null,
    stopped: null,
    err: (m) => {
      if (!quiet) process.stderr.write(m);
    },
  };
  events.append(root, { event: 'drive_start', job: state.id, pid: process.pid, detached, ...(st.recovered_from ? { recovered_from: st.recovered_from } : {}) });
  let current = st;
  const save = (patch) => {
    current = { ...current, ...patch, heartbeat_at: nowIso() };
    writeState(root, current);
  };
  ctx.beat = (patch = {}) => save({ job: ctx.job, steps: ctx.steps, ...patch });
  const beat = setInterval(() => save({}), HEARTBEAT_SEC * 1000);
  beat.unref();
  ctx.waitLock = async (lock) => {
    const runner = require('./runner');
    const file = lock || path.join(jobPaths(root, ctx.job).dir, 'run.lock');
    for (let i = 0; i < 24 * 3600 && runner.lockFileAlive(file); i++) await new Promise((r) => setTimeout(r, 1000));
  };
  ctx.stop = (kind, n, extra = {}) => {
    const d = stopDetail(kind, n || {}, { job: ctx.job, ...extra });
    const rec = {
      at: nowIso(),
      job: ctx.job,
      kind,
      summary: d.summary,
      action: (n && n.action) || null,
      step: (n && n.step) || null,
      decision_id: (n && n.decision_id) || null,
      ...d,
      ...(extra.code ? { code: extra.code } : {}),
      ...(n && n.notice ? { notice: n.notice } : {}),
      ...(n && n.last_reply ? { last_reply: n.last_reply } : {}),
      ...(n && n.environment ? { environment: n.environment } : {}),
      ...(n && n.autopilot ? { autopilot: n.autopilot } : {}),
      steps: ctx.steps,
    };
    ctx.stopped = rec;
    const title = `Factory ${ctx.job}: ${STOP_TITLE[kind] || kind}`;
    const sent = require('./notify').notify(root, { title, body: rec.summary, job: ctx.job, kind });
    rec.notified = sent.method;
    events.append(root, { event: 'drive_stop', job: ctx.job, kind, summary: String(rec.summary).slice(0, 500), gate: rec.gate ? rec.gate.id : null, park_kind: rec.park ? rec.park.kind : null, stage: rec.stage || null, decision_id: rec.decision_id, steps: ctx.steps, notified: sent.method, pid: process.pid });
    save({ status: 'stopped', step: null, stopped_at: rec.at, last: rec, stops: [...(current.stops || []), { at: rec.at, job: ctx.job, kind, summary: rec.summary }].slice(-20) });
    ctx.err(`[factory drive] stop (${kind}): ${rec.summary}\n`);
    return rec;
  };
  // Stopped from outside (factory drive stop, Ctrl-C, a closed terminal): stop the step in
  // progress too (a `factory run` stops its agents and releases its lock on SIGTERM), record
  // the stop, and exit. A rerun continues from factory next.
  const SIG = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
  const handlers = {};
  for (const sig of Object.keys(SIG)) {
    if (process.platform === 'win32' && sig === 'SIGHUP') continue;
    handlers[sig] = () => {
      try {
        if (ctx.child) {
          try {
            ctx.child.kill('SIGTERM');
          } catch {
            /* gone */
          }
          const until = Date.now() + 8000;
          while (Date.now() < until && ctx.child && ctx.child.exitCode === null && pidAlive(ctx.child.pid)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
        if (!ctx.stopped) ctx.stop('interrupted', ctx.lastNext || { job: ctx.job }, { message: `drive stopped (${sig}); run factory drive again to continue from where the job is` });
      } finally {
        clearInterval(beat);
        process.exit(128 + SIG[sig]);
      }
    };
    process.on(sig, handlers[sig]);
  }
  try {
    return await loop(ctx);
  } catch (e) {
    return ctx.stop('error', ctx.lastNext || { job: ctx.job }, { message: `drive failed: ${e.message}` });
  } finally {
    clearInterval(beat);
    for (const [sig, h] of Object.entries(handlers)) process.removeListener(sig, h);
  }
}

// factory drive --detach: the same drive in the background, its output in .factory/drive.log
// and its pid in .factory/drive.json. Returns once the background drive holds the lock.
function detach(root, { jobId } = {}) {
  const job = require('./job');
  const state = job.resolve(root, jobId);
  const prev = readState(root);
  if (alive(prev)) fail(`factory drive is already running (pid ${prev.pid}, ${prev.job}, since ${prev.started_at}). Watch it with factory drive status --wait 600.`, 'drive_in_progress', { pid: prev.pid, job: prev.job });
  fs.mkdirSync(path.dirname(logFile(root)), { recursive: true });
  const fd = fs.openSync(logFile(root), 'a');
  fs.writeSync(fd, `\n=== factory drive ${state.id} detached at ${nowIso()} ===\n`);
  const env = { ...process.env, FACTORY_ROOT: root };
  delete env.FACTORY_DRIVE;
  const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'factory'), '--root', root, 'drive', '--job', state.id, '--detached-child'], { cwd: root, env, stdio: ['ignore', fd, fd], detached: true, windowsHide: true });
  child.unref();
  fs.closeSync(fd);
  const until = Date.now() + 10000;
  let st = null;
  while (Date.now() < until) {
    st = readState(root);
    if (st && st.pid === child.pid) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return {
    job: state.id,
    detached: true,
    pid: child.pid,
    log: logFile(root),
    state_file: driveFile(root),
    message: `factory drive runs ${state.id} in the background (pid ${child.pid}); it stops, and notifies you, where you are needed. factory drive status --wait 600 waits for that stop; factory drive stop stops it.`,
  };
}

function tailOf(file, n = 8) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    return t.split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

function statusView(root) {
  const st = readState(root);
  if (!st) return { status: 'none', message: 'No factory drive has run in this repository. Start one with factory drive (or factory drive --detach).' };
  const live = alive(st);
  const status = st.status === 'running' && !live ? 'crashed' : st.status;
  return {
    status,
    job: st.job,
    pid: st.pid,
    alive: live,
    started_at: st.started_at,
    step: live ? st.step || null : null,
    steps: st.steps || 0,
    detached: Boolean(st.detached),
    log: st.log || null,
    last: st.last || null,
    ...(st.log ? { log_tail: tailOf(st.log) } : {}),
    message: status === 'running'
      ? `Running ${st.job}${st.step ? `: ${st.step}` : ''}.`
      : status === 'crashed'
        ? `The drive for ${st.job} (pid ${st.pid}) is gone without a stop (crashed or killed). Run factory drive again: it continues from where the job is.`
        : st.last ? `Stopped: ${st.last.summary}` : 'Stopped.',
  };
}

// factory drive status [--wait N]: where the drive is; with --wait, block until it stops or N
// seconds pass (under a tool's time limit), then report.
async function status(root, { wait = 0 } = {}) {
  const until = Date.now() + Math.max(0, Number(wait) || 0) * 1000;
  while (Date.now() < until && alive(readState(root))) await new Promise((r) => setTimeout(r, 1000));
  return statusView(root);
}

// factory drive stop: SIGTERM the drive (it stops its step, records the stop and exits).
function stopDrive(root) {
  const st = readState(root);
  if (!alive(st)) return { stopped: false, ...statusView(root), message: 'No factory drive is running.' };
  try {
    process.kill(st.pid, 'SIGTERM');
  } catch (e) {
    return { stopped: false, pid: st.pid, message: `Could not signal the drive (pid ${st.pid}): ${e.message}` };
  }
  const until = Date.now() + 15000;
  while (Date.now() < until && pidAlive(st.pid)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  const after = readState(root);
  if (after && after.status === 'running' && after.pid === st.pid) writeState(root, { ...after, status: 'stopped', stopped_at: nowIso(), last: { at: nowIso(), job: after.job, kind: 'interrupted', summary: 'stopped with factory drive stop' } });
  return { stopped: true, pid: st.pid, job: st.job, message: `Stopped the drive for ${st.job}. Run factory drive to continue from where the job is.` };
}

module.exports = { drive, detach, status, statusView, stopDrive, liveFor, isDriveChild, drivingAnswer, readState, runArgs, words, evidencePath, stopDetail, alive, driveFile, logFile };
