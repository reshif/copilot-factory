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
//                  environment_repair): the diff of the commands, "approve environment" (or yes,
//                  or a) seals it, through the human-only channel. Agents never seal. The sealed
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
const inputHash = (state, rec) => sha256(stableStringify({ repair: rec ? rec.hash : null, at: rec ? rec.at : null, round: ((((state.loops || {})[LOOP]) || {}).round) || 0 }));

function unifiedCommands(a, b) {
  const lines = (e) => [...(e.setup || []).map((x) => `setup: ${x}`), ...(e.services ? ['up', 'health', 'down'].filter((k) => e.services[k]).map((k) => `services.${k}: ${e.services[k]}`) : []), ...(e.teardown ? [`teardown: ${e.teardown}`] : []), ...Object.entries(e.env || {}).map(([k, v]) => `env ${k}=${v}`)];
  const A = lines(a || {});
  const B = lines(b || {});
  return [...A.filter((x) => !B.includes(x)).map((x) => `- ${x}`), ...B.filter((x) => !A.includes(x)).map((x) => `+ ${x}`)].join('\n');
}

// Recording the repair agent's result (factory record, fanout-judge env_repair).
function record(root, state, env) {
  const envMod = require('./environment');
  const Loop = require('./loop');
  const job = require('./job');
  const g = envMod.gateProposal(root, state.id);
  const file = REPAIR(root, state.id);
  const cand = readJson(file, null);
  const inv = machine();
  const plan = readJson(jobPaths(root, state.id).plan, { tasks: [] });
  let res;
  let lint = [];
  if (!cand) res = { ok: false, problems: [`no repaired environment at ${file}`] };
  else {
    const pp = envMod.problems(envMod.essence(cand));
    lint = pp.length ? [] : envMod.lint(envMod.essence(cand), { root, base: state.base_commit || 'HEAD', plan, machine: inv });
    res = pp.length ? { ok: false, problems: pp } : lint.length ? { ok: false, problems: lint.map((l) => `${l.cmd}: ${l.message}`) } : envMod.check(root, { env: envMod.essence(cand) });
  }
  require('./events').append(root, { event: 'environment_repair', job: state.id, ok: Boolean(res.ok), ...(res.ok ? {} : { cmd: res.broken ? res.broken.cmd : null, problems: (res.problems || []).length }) });
  const fresh = job.load(root, state.id);
  fresh.loops = fresh.loops || {};
  const prev = fresh.loops[LOOP] || null;
  const d = Loop.shouldContinue(prev, res.ok ? [] : blockersOf(res, lint), loopPolicy(root, fresh));
  fresh.loops[LOOP] = { ...d.state, for_hash: g.hash, segments: (prev || {}).segments || 0, ...(d.model ? { model: d.model } : prev && prev.model ? { model: prev.model } : {}), last_failure: res.ok ? null : res.broken || { problems: res.problems } };
  if (res.ok) {
    const fixed = envMod.essence(cand);
    const diff = unifiedCommands(g.env, fixed);
    fresh.env_repair = { from: g.hash, hash: envMod.fullHash(fixed), env: fixed, diff, at: nowIso() };
    job.save(root, fresh);
    return {
      status: 'park',
      park_kind: 'environment_repair',
      park_from: 'environment',
      park_loop: null,
      park_reason: `The sealed build environment failed its check; a repaired one sets up in a scratch worktree. It needs your seal:\n${diff}`,
      park_question: { question: `Seal the repaired build environment for ${state.id}? It differs from the sealed one in:\n${diff}`, options: [{ key: 'a', text: 'Approve the repaired environment (reply "approve environment")' }, { key: 'b', text: 'Not this one: repair it again, with what I say' }, { key: 'c', text: 'I fix it myself (factory env set in my terminal), then resume' }], recommendation: 'a', cause: String(((readCheck(root, state.id) || {}).broken || {}).reason || '').slice(0, 400) },
      message: `A repaired build environment passed its check in a scratch worktree; ${state.id} waits for your seal (reply "approve environment").`,
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
      park_question: { question: `The build environment still does not set up on this machine (${last}). How should it be fixed?`, options: [{ key: 'a', text: 'I fix the machine or the environment myself (install the tool; factory env set), then resume' }, { key: 'b', text: 'Repair it again, with what I say (resume with your hint)' }, { key: 'c', text: 'Stop here (cancel job)' }], recommendation: 'a', cause: last.slice(0, 400) },
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
  const steps = require('./steps');
  const ctx = steps.context(root, state, require('./job').load);
  for (const [gate, a] of Object.entries(state.approvals || {})) {
    if (a && a.environment && a.environment === p.from) {
      const h = steps.gateHash(ctx, gate);
      state.approvals[gate] = { ...a, environment: envMod.fullHash(p.env), hash: h || a.hash, environment_repaired: { from: p.from, at: nowIso() } };
    }
  }
  fs.rmSync(REPAIR(root, state.id), { force: true });
  require('./events').append(root, { event: 'environment_set', channel, name: r.environment.name || null, hash: r.hash, job: state.id, repair: true });
  state.env_repair = null;
  if (state.loops) delete state.loops[LOOP];
  return r;
}

module.exports = { checkForJob, routerAction, brief, record, sealRepair, readCheck, inputHash, unifiedCommands, CHECK, REPAIR, LOOP };
