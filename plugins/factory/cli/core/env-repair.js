'use strict';
// The build environment, checked once the human has sealed it, before any task (fix 0.10.1), and
// repaired in a loop when it fails, never by a builder and never on a task's attempts.
//
// J-0001 (WSL Ubuntu 22.04) failed right after its plan gate: the approved setup ran
// `python3 -m venv` without ensurepip, read a requirements.txt the first task was to write, and
// checked Postgres once before it was up. The user's chat agent fixed it by hand. Now:
//
//   1. env.check   factory next names `factory env check --job J` while the confirmed
//                  environment has no passing check for its hash: setup (and services up, health,
//                  down) in a scratch worktree. The result is sealed in
//                  .factory/jobs/<job>/env-check.json. Realize waits for a pass.
//   2. env.repair  a failed check starts the loop (the 0.9.0 engine, state.loops.environment):
//                  factory run fanout-judge --config env_repair, the planner agent in repair mode,
//                  reads the failure, this machine's tool inventory and the lint, and writes a
//                  fixed environment to .factory/jobs/<job>/environment.repair.json. Recording it,
//                  the CLI lints it against this machine and checks it in a scratch worktree
//                  (sandboxed: it is not confirmed). Fewer problems is progress; no progress
//                  escalates to the stronger model, then stops with a specific question.
//   3. the seal    a repair that passes parks the job with ONE question (kind
//                  environment_repair): the full diff; only "approve environment <its short
//                  hash>" or the option letter "a" seals it, through the human-only channel (a
//                  bare "approve environment", ok, yes or sure seal nothing). Agents never seal. The sealed
//                  fix replaces the job's environment proposal and the combined gate's approval
//                  of the environment moves with it (the human just approved it), so the gate is
//                  not asked again; the check then runs on the sealed environment, as in 1.

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, nowIso, sha256, stableStringify } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const { seal, valid } = require('../lib/seal');

const CHECK = (root, jobId) => path.join(jobPaths(root, jobId).dir, 'env-check.json');
const REPAIR = (root, jobId) => path.join(jobPaths(root, jobId).dir, 'environment.repair.json');
const LOOP = 'environment';
const CEILING = 4;

function readCheck(root, jobId) {
  const c = readJson(CHECK(root, jobId), null);
  return c && valid(c) ? c : null;
}

function machine() {
  try {
    return require('./machine').inventory();
  } catch {
    return null;
  }
}

function loopPolicy(root, state) {
  const pol = require('../lib/util').deepMerge(require('./policy').load(root), state.policy || {});
  return require('./loop').policyFor(pol, { ceiling: CEILING, stall_rounds: 1, diagnose: false });
}

// The blockers a check (and the lint against this machine) leaves: the failing command, and each
// lint finding. Fewer of them is progress.
function blockersOf(res, lint) {
  const out = [];
  if (res && !res.ok) {
    const b = res.broken || {};
    out.push({ key: `check|${b.step || 'problems'}|${String(b.cmd || (res.problems || []).join('; ')).slice(0, 160)}` });
  }
  for (const l of lint || []) out.push({ key: `lint|${l.rule}|${String(l.cmd).slice(0, 160)}` });
  return out;
}

// `factory env check --job J`: the confirmed environment, checked and recorded for the job. A
// failure starts (or continues) the repair loop.
function checkForJob(root, state) {
  const envMod = require('./environment');
  const g = envMod.gateProposal(root, state.id);
  const r = envMod.check(root);
  const rec = seal({ version: 1, job: state.id, hash: g.hash, which: r.which || null, ok: Boolean(r.ok), at: nowIso(), ran: (r.ran || []).map((x) => ({ cmd: x.cmd, code: x.code })), ...(r.ok ? {} : { broken: r.broken ? { step: r.broken.step, cmd: r.broken.cmd, code: r.broken.code, tail: String(r.broken.tail || '').slice(-1500), reason: String(r.broken.reason || '').slice(0, 1500) } : null, problems: r.problems || (r.error ? [r.error] : []) }) });
  writeJson(CHECK(root, state.id), rec);
  require('./events').append(root, { event: 'environment_check', job: state.id, ok: rec.ok, hash: g.hash, ...(rec.ok ? {} : { cmd: rec.broken ? rec.broken.cmd : null }) });
  if (!rec.ok) {
    const job = require('./job');
    job.mutate(root, state.id, (st) => {
      st.loops = st.loops || {};
      // a new failure of a (newly) sealed environment starts a fresh loop
      const prev = st.loops[LOOP] && st.loops[LOOP].for_hash === g.hash ? st.loops[LOOP] : null;
      const d = require('./loop').shouldContinue(prev, blockersOf(rec, envMod.lint(g.env, { root, machine: machine() })), loopPolicy(root, st));
      st.loops[LOOP] = { ...d.state, for_hash: g.hash, segments: (prev || {}).segments || 0, last_failure: rec.broken || { problems: rec.problems } };
    });
  }
  return { job: state.id, ...r, recorded: CHECK(root, state.id), message: r.ok ? `The build environment sets up in a scratch worktree: the build can start.` : `The build environment does not set up${r.broken ? `: ${r.broken.reason}` : ''}. factory next repairs it (an agent proposes a fix, the CLI checks it, you seal it).` };
}

// What the router does before realize: null when the sealed environment has passed its check.
function routerAction(ctx) {
  const { root, state } = ctx;
  const envMod = require('./environment');
  const g = envMod.gateProposal(root, state.id);
  if (g.status !== 'confirmed' || envMod.isNone(g.env)) return null;
  const rec = readCheck(root, state.id);
  if (rec && rec.hash === g.hash && rec.ok) return null;
  if (!rec || rec.hash !== g.hash) return { step: 'env_check', run: 'cli:env check', action: 'cli', command: `factory env check --job ${state.id}`, reason: `The build environment ${g.env.name || ''} was sealed; it is set up once in a scratch worktree before any task is built.`.replace('  ', ' '), rule: 'env.check' };
  return { step: 'env_repair', run: 'workflow:fanout-judge', action: 'workflow', workflow: 'fanout-judge', config: 'env_repair', mode: null, reason: `The sealed build environment does not set up (${rec.broken ? rec.broken.cmd : (rec.problems || []).join('; ')}): an agent proposes a repair, the CLI checks it, you seal it. No builder starts on it.`, rule: 'env.repair' };
}

// The repair agent's brief (wfargs fanout-judge --config env_repair).
function brief(root, state, { agentSpec, prompt, schema, jobContext }) {
  const envMod = require('./environment');
  const g = envMod.gateProposal(root, state.id);
  const rec = readCheck(root, state.id);
  if (!rec || rec.ok) require('../lib/util').fail('The build environment has no failing check to repair.', 'bad_input');
  const L = ((state.loops || {})[LOOP]) || {};
  const inv = machine();
  const plan = readJson(jobPaths(root, state.id).plan, { tasks: [] });
  const input = {
    environment: g.env,
    failure: L.last_failure || rec.broken || { problems: rec.problems },
    lint: envMod.lint(g.env, { root, base: state.base_commit || 'HEAD', plan, machine: inv }),
    machine: require('./machine').summary(inv),
    earlier_repairs: (L.history || []).map((h) => ({ round: h.round, open: h.open })),
    plan_tasks: (plan.tasks || []).map((t) => ({ id: t.id, bootstrap: Boolean(t.bootstrap), allowed_paths: t.allowed_paths })),
  };
  const out = REPAIR(root, state.id);
  const text = `${jobContext}\n- Mode: **environment repair**. The build environment the human sealed does not set up on this machine (the CLI ran it in a scratch worktree). Write a repaired environment to ${out} (the fields of .factory/environment.json: name, setup, cache_key, env, prefix, services {up, health, down}, teardown, ignore, timeout_seconds, notes) and return its path. Fix the cause the failure shows; change nothing else. Rules: use only tools the machine has (uv > poetry for a poetry repo > virtualenv > python3 -m venv only when it works), never sudo; every pip install gets --retries 5 --timeout 60 (uv retries itself); setup reads only files the base commit has or the bootstrap task creates (install from pins directly otherwise); a service health check waits with a deadline (a retry loop, docker compose up --wait), never runs once. The CLI checks your file in a scratch worktree; the human seals it. Never edit .factory/environment.json.\n\nREPAIR INPUT (JSON):\n${JSON.stringify(input, null, 1)}`;
  return {
    config: 'env_repair',
    mode: null,
    input_hash: inputHash(state, rec),
    fanout: [],
    judge: { ...agentSpec(state, 'planner'), prompt: prompt('planner', text), schema: schema('env-repair'), ...(L.model ? { model: L.model } : {}) },
    critique: null,
    verifier: null,
  };
}
// bound to the routing decision that asked for the repair (B2)
const inputHash = (state, rec) => sha256(stableStringify({ repair: rec ? rec.hash : null, at: rec ? rec.at : null, round: ((((state.loops || {})[LOOP]) || {}).round) || 0, decision: state.last_decision_id || null }));

// The full difference between two environments, every field the schema has (and any other key
// either one carries), never a hand-picked list (release review B2): lists element by element,
// maps key by key, scalars as - old / + new. Fields that act outside setup are called out.
const SENSITIVE = {
  prefix: 'prefix runs in front of EVERY verify command, with your full environment',
  ignore: 'ignore is appended to the repository\'s .git/info/exclude: matching files disappear from git status and the drift check',
  cache_key: 'cache_key decides when setup runs again',
  env: 'env is set for every setup, build and verify command',
};
function fullDiff(a, b) {
  const A = a || {};
  const B = b || {};
  const keys = [...new Set([...require('./environment').KEYS, ...Object.keys(A), ...Object.keys(B)])].filter((k) => !['version', 'seal', 'confirmed', 'source', 'evidence', 'hash', 'problems'].includes(k));
  const lines = [];
  const notes = [];
  const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  for (const k of keys) {
    const x = A[k];
    const y = B[k];
    if (stableStringify(x === undefined ? null : x) === stableStringify(y === undefined ? null : y)) continue;
    if (SENSITIVE[k]) notes.push(`! ${SENSITIVE[k]}: it changes here.`);
    if (Array.isArray(x) || Array.isArray(y)) {
      const X = (x || []).map(show);
      const Y = (y || []).map(show);
      for (const v of X.filter((v) => !Y.includes(v))) lines.push(`- ${k}: ${v}`);
      for (const v of Y.filter((v) => !X.includes(v))) lines.push(`+ ${k}: ${v}`);
      if (!lines.some((l) => l.slice(2).startsWith(`${k}:`))) lines.push(`~ ${k}: order changed`);
    } else if ((x && typeof x === 'object') || (y && typeof y === 'object')) {
      const X = x || {};
      const Y = y || {};
      for (const kk of [...new Set([...Object.keys(X), ...Object.keys(Y)])]) {
        if (stableStringify(X[kk]) === stableStringify(Y[kk])) continue;
        if (X[kk] !== undefined) lines.push(`- ${k}.${kk}: ${show(X[kk])}`);
        if (Y[kk] !== undefined) lines.push(`+ ${k}.${kk}: ${show(Y[kk])}`);
      }
    } else {
      if (x !== undefined && x !== null) lines.push(`- ${k}: ${show(x)}`);
      if (y !== undefined && y !== null) lines.push(`+ ${k}: ${show(y)}`);
    }
  }
  return [...notes, ...lines].join('\n');
}
const unifiedCommands = fullDiff;

// Other jobs that build in the repository environment this seal replaces (release review m5).
function otherJobs(root, jobId) {
  const job = require('./job');
  const out = [];
  for (const id of job.listJobIds(root)) {
    if (id === jobId) continue;
    const st = readJson(jobPaths(root, id).state, null);
    if (st && ['active', 'parked'].includes(st.status)) out.push(id);
  }
  return out;
}

// Is a repair open for this job: the sealed environment's check failed for its current hash, the
// loop has not stopped, and the router's last decision for the job was the repair (B2: an
// env_repair result is recorded only for a repair the router asked for).
function repairOpen(root, state) {
  const r = routerAction({ root, state });
  if (!r || r.step !== 'env_repair') return 'the sealed build environment has no failing check to repair';
  if (!String(state.last_decision || '').startsWith('workflow:env_repair')) return 'factory next did not route an environment repair';
  return null;
}

// The repair policy (M3): the plan probe's switch applies to repair candidates too. false: nothing
// runs (the lint is shown, the human decides); 'lint': lint only; otherwise the candidate runs in
// a scratch worktree, sandboxed.
function repairMode(root, state) {
  let live = {};
  try {
    live = (require('./policy').load(root) || {}).decompose || {};
  } catch {
    live = {};
  }
  const snap = ((state && state.policy) || {}).decompose || {};
  const flag = live.plan_probe !== undefined ? live.plan_probe : snap.plan_probe;
  return flag === false ? 'off' : flag === 'lint' ? 'lint' : 'run';
}

// Recording the repair agent's result (factory record, fanout-judge env_repair).
function record(root, state, env) {
  const envMod = require('./environment');
  const Loop = require('./loop');
  const job = require('./job');
  const open = repairOpen(root, state);
  if (open) require('../lib/util').fail(`No environment repair is open for ${state.id} (${open}): nothing recorded. Run factory next.`, 'no_repair_open');
  const g = envMod.gateProposal(root, state.id);
  const file = REPAIR(root, state.id);
  const cand = readJson(file, null);
  const inv = machine();
  const plan = readJson(jobPaths(root, state.id).plan, { tasks: [] });
  const mode = repairMode(root, state);
  let res;
  let lint = [];
  let notRun = null;
  if (!cand) res = { ok: false, problems: [`no repaired environment at ${file}`] };
  else {
    const pp = envMod.problems(envMod.essence(cand));
    lint = pp.length ? [] : envMod.lint(envMod.essence(cand), { root, base: state.base_commit || 'HEAD', plan, machine: inv });
    if (pp.length) res = { ok: false, problems: pp };
    else if (mode === 'off') {
      // nothing runs: the human sees the candidate and its lint and decides
      notRun = `NOT run: policy decompose.plan_probe is false, so the CLI did not execute this candidate${lint.length ? `; the lint found:\n${lint.map((l) => `  - ${l.cmd}: ${l.message}`).join('\n')}` : ' (its lint is clean)'}`;
      res = { ok: true, not_run: true };
    } else if (lint.length) res = { ok: false, problems: lint.map((l) => `${l.cmd}: ${l.message}`) };
    else if (mode === 'lint') {
      notRun = 'NOT run: policy decompose.plan_probe is "lint", so the CLI only linted this candidate (clean)';
      res = { ok: true, not_run: true };
    } else res = envMod.check(root, { env: envMod.essence(cand) });
  }
  require('./events').append(root, { event: 'environment_repair', job: state.id, ok: Boolean(res.ok), ...(res.ok ? {} : { cmd: res.broken ? res.broken.cmd : null, problems: (res.problems || []).length }) });
  const fresh = job.load(root, state.id);
  fresh.loops = fresh.loops || {};
  const prev = fresh.loops[LOOP] || null;
  const d = Loop.shouldContinue(prev, res.ok ? [] : blockersOf(res, lint), loopPolicy(root, fresh));
  fresh.loops[LOOP] = { ...d.state, for_hash: g.hash, segments: (prev || {}).segments || 0, ...(d.model ? { model: d.model } : prev && prev.model ? { model: prev.model } : {}), last_failure: res.ok ? null : res.broken || { problems: res.problems } };
  if (res.ok) {
    const fixed = envMod.essence(cand);
    const diff = fullDiff(g.env, fixed) || '(no difference)';
    const short = envMod.short(fixed);
    const others = otherJobs(root, state.id);
    fresh.env_repair = { from: g.hash, hash: envMod.fullHash(fixed), short, env: fixed, diff, at: nowIso(), ...(notRun ? { not_run: true } : {}) };
    job.save(root, fresh);
    const how = notRun || 'It set up in a scratch worktree (sandboxed: no tokens, no login shell).';
    const replaces = `Sealing it replaces the repository's build environment (.factory/environment.json)${others.length ? `, which the other active jobs ${others.join(', ')} also build in` : ''}.`;
    const question = `Seal the repaired build environment ${short} for ${state.id}? ${how} ${replaces}\nWhat changes:\n${diff}\nThe whole repaired environment:\n${JSON.stringify(fixed, null, 1)}`;
    return {
      status: 'park',
      park_kind: 'environment_repair',
      park_from: 'environment',
      park_loop: null,
      park_reason: `The sealed build environment failed its check; a repaired one (${short}) waits for your seal. ${how}\n${diff}`,
      park_question: { question, options: [{ key: 'a', text: `Seal the repaired environment ${short} (reply "approve environment ${short}" or "a")` }, { key: 'b', text: 'Not this one: repair it again, with what I say' }, { key: 'c', text: `I fixed it on my machine: re-check the sealed environment (factory env check --job ${state.id} runs again)` }], recommendation: notRun ? null : 'a', cause: String(((readCheck(root, state.id) || {}).broken || {}).reason || '').slice(0, 400), seal: short },
      message: `A repaired build environment ${short} ${notRun ? 'was proposed (not run)' : 'passed its check in a scratch worktree'}; ${state.id} waits for your seal (reply "approve environment ${short}").`,
    };
  }
  job.save(root, fresh);
  if (d.action === 'stop') {
    const last = res.broken ? `${res.broken.cmd}: ${String(res.broken.reason || '').slice(0, 300)}` : (res.problems || []).slice(0, 3).join('; ');
    return {
      status: 'park',
      park_kind: 'environment_broken',
      park_from: 'environment',
      park_loop: null,
      park_reason: `The build environment does not set up, and ${d.round || (prev && prev.round) || CEILING} repair round(s) did not fix it (${d.rule}). Last: ${last}`,
      park_question: { question: `The build environment still does not set up on this machine (${last}). How should it be fixed?`, options: [{ key: 'a', text: `I fixed it on my machine (installed the tool, or factory env set): re-check (factory env check --job ${state.id} runs again with a fresh machine inventory)` }, { key: 'b', text: 'Repair it again, with what I say (resume with your hint)' }, { key: 'c', text: 'Stop here (cancel job)' }], recommendation: 'a', cause: last.slice(0, 400) },
      message: 'The environment repair stopped without a fix: the job asks you how to go on.',
    };
  }
  return { status: 'retry', errors: res.problems || [res.broken && res.broken.reason].filter(Boolean), message: `The repaired environment does not pass yet (${d.rule}${d.model ? `, next on ${d.model}` : ''}): factory next repairs it again.` };
}

// The human's seal of a repair that passed (park environment_repair, option a: "approve
// environment", yes, a). Called from human.applyResume, which already required the human channel.
function sealRepair(root, state, channel) {
  const p = state.env_repair;
  if (!p || !p.env) require('../lib/util').fail('No repaired environment waits for your seal.', 'bad_input');
  const envMod = require('./environment');
  const r = envMod.confirm(root, { env: p.env, channel, via: `${state.id} environment repair` });
  // the job's environment is the repaired one now; a combined gate that approved the old one
  // moves with it (this seal is the human's approval of the change)
  writeJson(envMod.JOB_PROPOSED(root, state.id), p.env);
  // Only the environment component moves, and only when everything else the gate bound is as it
  // was approved: the gate hash recomputed with the OLD environment must equal the approved hash.
  // A plan or design edited since the gate keeps the approval stale: the gate is asked again
  // (release review B1).
  const steps = require('./steps');
  const ctx = steps.context(root, state, require('./job').load);
  const newHash = envMod.fullHash(p.env);
  for (const [gate, a] of Object.entries(state.approvals || {})) {
    if (!a || !a.environment || a.environment !== p.from) continue;
    const parts = steps.combinedParts(ctx, gate);
    if (!parts || !('environment' in parts) || ('design' in parts && !parts.design) || !parts.plan) continue;
    const withEnv = (h) => sha256(stableStringify({ design: parts.design, plan: parts.plan, environment: h }));
    if (withEnv(p.from) !== a.hash) {
      require('./events').append(root, { event: 'environment_repair_gate_stale', job: state.id, gate });
      continue;
    }
    state.approvals[gate] = { ...a, environment: newHash, hash: withEnv(newHash), environment_repaired: { from: p.from, at: nowIso() } };
  }
  fs.rmSync(REPAIR(root, state.id), { force: true });
  require('./events').append(root, { event: 'environment_set', channel, name: r.environment.name || null, hash: r.hash, job: state.id, repair: true });
  state.env_repair = null;
  if (state.loops) delete state.loops[LOOP];
  return r;
}

// The human's "I fixed it on my machine" (M4): the sealed environment is checked again, with its
// real execution context and a fresh machine inventory, before any agent repair.
function recheck(root, state) {
  fs.rmSync(CHECK(root, state.id), { force: true });
  try {
    require('./machine').invalidate();
  } catch {
    /* no cache */
  }
  if (state.loops) delete state.loops[LOOP];
  state.env_repair = null;
}

module.exports = { recheck, fullDiff, repairOpen, repairMode, otherJobs, checkForJob, routerAction, brief, record, sealRepair, readCheck, inputHash, unifiedCommands, CHECK, REPAIR, LOOP };
