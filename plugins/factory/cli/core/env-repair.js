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

// The machine's inventory. A cold scan runs only in a long step (the env check, foreground or its
// detached child: port review m-7); the brief and the record read the cache, so a drive step that
// is not long never waits on a scan.
function machine({ scan = false } = {}) {
  try {
    return require('./machine').inventory(scan ? {} : { cacheOnly: true });
  } catch {
    return null;
  }
}
// what a check printed, before it reaches a record, a brief, a park, the inbox or a drive stop:
// the confirmed environment's check runs with the user's own environment (port review m-3)
const redact = (t) => require('./probe').redact(String(t || ''));
const cleanBroken = (b) => (b ? { step: b.step, cmd: redact(b.cmd), code: b.code === undefined ? null : b.code, tail: redact(String(b.tail || '').slice(-1500)), reason: redact(String(b.reason || '').slice(0, 1500)) } : null);

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
  const r0 = envMod.check(root);
  const r = r0.ok ? r0 : { ...r0, ...(r0.broken ? { broken: cleanBroken(r0.broken) } : {}), ...(r0.message ? { message: redact(r0.message) } : {}), ...(r0.problems ? { problems: r0.problems.map(redact) } : {}), ...(r0.error ? { error: redact(r0.error) } : {}) };
  const rec = seal({ version: 1, job: state.id, hash: g.hash, which: r.which || null, ok: Boolean(r.ok), at: nowIso(), ran: (r.ran || []).map((x) => ({ cmd: redact(x.cmd), code: x.code })), ...(r.ok ? {} : { broken: r.broken || null, problems: r.problems || (r.error ? [r.error] : []) }) });
  writeJson(CHECK(root, state.id), rec);
  require('./events').append(root, { event: 'environment_check', job: state.id, ok: rec.ok, hash: g.hash, ...(rec.ok ? {} : { cmd: rec.broken ? rec.broken.cmd : null }) });
  if (!rec.ok) {
    const job = require('./job');
    job.mutate(root, state.id, (st) => {
      st.loops = st.loops || {};
      // a new failure of a (newly) sealed environment starts a fresh loop
      const prev = st.loops[LOOP] && st.loops[LOOP].for_hash === g.hash ? st.loops[LOOP] : null;
      const d = require('./loop').shouldContinue(prev, blockersOf(rec, envMod.lint(g.env, { root, machine: machine({ scan: true }) })), loopPolicy(root, st));
      st.loops[LOOP] = { ...d.state, for_hash: g.hash, segments: (prev || {}).segments || 0, last_failure: rec.broken || { problems: rec.problems } };
    });
  }
  return { job: state.id, ...r, ran: (r.ran || []).map((x) => ({ ...x, cmd: redact(x.cmd) })), recorded: CHECK(root, state.id), message: r.ok ? `The build environment sets up in a scratch worktree: the build can start.` : `The build environment does not set up${r.broken ? `: ${r.broken.reason}` : ''}. factory next repairs it (an agent proposes a fix, the CLI checks it, you seal it).` };
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
  // a recorded repair candidate waits for its check: a long CLI step of its own (port review M-1),
  // never inside factory record
  const p = state.env_repair_pending;
  if (p && p.for_hash === g.hash) return { step: 'env_repair_check', run: 'cli:env check --repair', action: 'cli', command: `factory env check --repair --job ${state.id}`, reason: `The repair candidate ${p.short} is checked in a scratch worktree (sandboxed), then waits for your seal.`, rule: 'env.repair_check' };
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
  const text = `${jobContext}\n- Mode: **environment repair**. The build environment the human sealed does not set up on this machine (the CLI ran it in a scratch worktree). Write a repaired environment to ${out} (the fields of .factory/environment.json, in the schema version the failing one uses — version 2 adds tool, reason and cache — : name, setup (run in every worktree, building its own environment), cache_key, env, prefix, services {up, health, down}, teardown, ignore, timeout_seconds, notes) and return its path. Fix the cause the failure shows; change nothing else, and say in reason why the tool is the right one. Rules: use only tools the machine has (poetry for a poetry repo with poetry.lock when installed, else uv, else virtualenv, else python3 -m venv only when it works), never sudo, never the repository's own .venv; every pip install from the index gets --retries 5 --timeout 60 (uv retries itself); setup reads only files the base commit has or the bootstrap task creates (install from pins directly otherwise); a service health check waits with a deadline (a retry loop, docker compose up --wait), never runs once. The CLI checks your file in a scratch worktree; the human seals it. Never edit .factory/environment.json.\n\nREPAIR INPUT (JSON):\n${JSON.stringify(input, null, 1)}`;
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
  cache: 'cache decides which shared package cache (and, for pip, which wheelhouse) the setup installs from',
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
      // ordered (a longest-common-subsequence walk), so a repeated or moved command shows as
      // what it is, with its position (port review m-4)
      lines.push(...listDiff(k, (x || []).map(show), (y || []).map(show)));
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
// "- key: old (#i)" / "+ key: new (#j)" for two ordered lists (positions are 1-based, in the old
// list for removals and the new list for additions)
function listDiff(k, X, Y) {
  const n = X.length;
  const m = Y.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = X[i] === Y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && X[i] === Y[j]) {
      i += 1;
      j += 1;
    } else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) {
      out.push(`- ${k}: ${X[i]} (#${i + 1})`);
      i += 1;
    } else {
      out.push(`+ ${k}: ${Y[j]} (#${j + 1})`);
      j += 1;
    }
  }
  return out;
}

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

// The repair policy: the same decision as the plan probe's (port review M-2, release review M3).
// Not run ('off') when the probe is off for the job (policy decompose.plan_probe false, or the
// human's "no probe for this job"); lint only ('lint') under policy "lint" or the
// human's "lint only"; and, as the probe treats an unconfirmed environment, lint only when the
// candidate installs from the network and the policy is not "full" (nobody has seen it yet).
// Otherwise ('run') it is checked in a scratch worktree, sandboxed.
function repairMode(root, state, candidate = null) {
  const P = require('./probe');
  let live = {};
  try {
    live = (require('./policy').load(root) || {}).decompose || {};
  } catch {
    live = {};
  }
  const snap = ((state && state.policy) || {}).decompose || {};
  const flag = live.plan_probe !== undefined ? live.plan_probe : snap.plan_probe;
  // the probe's own switches (probe.enabled / probe.mode): policy, and the human's answer to an
  // interrupted probe for this job (c: no probe; a: lint only). Not the recipe's: a job without a
  // planner (no plan probe) still has its repair candidates checked.
  if (flag === false || (state && state.probe_override === false)) return 'off';
  if (flag === 'lint' || (state && state.probe_override === 'lint')) return 'lint';
  // the probe's rule for an environment nobody confirmed (mode auto): one that installs from the
  // network is linted, not run; policy "full" runs it
  const c = candidate || {};
  const text = [...require('./environment').commandsOf(c), (c.services || {}).up, (c.services || {}).health, c.prefix].filter(Boolean).join('\n');
  if (flag !== 'full' && P.NETWORK_SETUP.test(text)) return 'network';
  return 'run';
}
const NOT_RUN = {
  off: 'NOT run: the plan probe is off for this job (policy decompose.plan_probe false, or your "no probe for this job" answer), so the CLI did not execute this candidate',
  lint: 'NOT run: the plan probe is lint-only for this job (policy decompose.plan_probe "lint", or your "lint only" answer), so the CLI only linted this candidate',
  network: 'NOT run: this candidate installs from the network and nobody has seen it yet (the plan probe\'s rule for an unconfirmed environment; policy decompose.plan_probe "full" runs it), so the CLI only linted it',
};

// Recording the repair agent's result (factory record, fanout-judge env_repair). The candidate is
// validated and linted here; running it is a long CLI step of its own (factory env check --repair,
// port review M-1), never part of factory record.
function record(root, state, env) {
  const envMod = require('./environment');
  const job = require('./job');
  const open = repairOpen(root, state);
  if (open) require('../lib/util').fail(`No environment repair is open for ${state.id} (${open}): nothing recorded. Run factory next.`, 'no_repair_open');
  const g = envMod.gateProposal(root, state.id);
  const file = REPAIR(root, state.id);
  const cand = readJson(file, null);
  const inv = machine();
  const plan = readJson(jobPaths(root, state.id).plan, { tasks: [] });
  void env;
  if (!cand) return finishRound(root, state.id, { ok: false, problems: [`no repaired environment at ${file}`] }, [], null);
  const fixed = envMod.essence(cand);
  const pp = envMod.problems(fixed);
  if (pp.length) return finishRound(root, state.id, { ok: false, problems: pp }, [], null);
  const lint = envMod.lint(fixed, { root, base: state.base_commit || 'HEAD', plan, machine: inv });
  const mode = repairMode(root, state, fixed);
  const lintText = lint.length ? `; the lint found:\n${lint.map((l) => `  - ${l.cmd}: ${l.message}`).join('\n')}` : ' (its lint is clean)';
  if (mode === 'off') return finishRound(root, state.id, { ok: true, not_run: true }, lint, `${NOT_RUN.off}${lintText}`, fixed);
  if (lint.length) return finishRound(root, state.id, { ok: false, problems: lint.map((l) => `${l.cmd}: ${l.message}`) }, lint, null);
  if (mode !== 'run') return finishRound(root, state.id, { ok: true, not_run: true }, lint, `${NOT_RUN[mode]}${lintText}`, fixed);
  // to be run: kept in the sealed state (the file can change; what is checked is what was recorded)
  const short = envMod.short(fixed);
  job.mutate(root, state.id, (st) => {
    st.env_repair_pending = { env: fixed, hash: envMod.fullHash(fixed), short, for_hash: g.hash, at: nowIso() };
  });
  require('./events').append(root, { event: 'environment_repair_recorded', job: state.id, short });
  return { status: 'ok', pending_check: true, message: `The repair candidate ${short} passes its lint; factory next checks it in a scratch worktree (factory env check --repair --job ${state.id}, a long step), then it waits for your seal.` };
}

// The candidate's check (factory env check --repair --job J; in the foreground or the detached
// child): lint against a fresh inventory, then setup, prefix and services in a scratch worktree,
// sandboxed. Ends the round: the seal question, a new round, or the loop's stop. A park is made
// here (the CLI step's own result, not a workflow's).
function checkRepair(root, state) {
  const envMod = require('./environment');
  const p = state.env_repair_pending;
  if (!p) require('../lib/util').fail(`${state.id} has no repair candidate waiting for its check.`, 'bad_input');
  const plan = readJson(jobPaths(root, state.id).plan, { tasks: [] });
  const lint = envMod.lint(p.env, { root, base: state.base_commit || 'HEAD', plan, machine: machine({ scan: true }) });
  let res;
  if (lint.length) res = { ok: false, problems: lint.map((l) => `${l.cmd}: ${l.message}`) };
  else {
    const r = envMod.check(root, { env: p.env });
    res = r.ok ? r : { ...r, ...(r.broken ? { broken: cleanBroken(r.broken) } : {}), ...(r.problems ? { problems: r.problems.map(redact) } : {}) };
  }
  const out = finishRound(root, state.id, res, lint, null, p.env);
  if (out.status === 'park') {
    const job = require('./job');
    const now = job.load(root, state.id);
    const pk = require('./decision-table').park(root, now, out.park_reason, 'environment', { kind: out.park_kind, question: out.park_question, loop: 'environment' });
    return { job: state.id, ok: Boolean(res.ok), status: 'park', park: { kind: pk.kind, next: pk.next }, message: out.message };
  }
  return { job: state.id, ok: false, status: out.status, errors: out.errors, message: out.message };
}

// The end of a repair round: the loop moves (progress, escalation, stop); a candidate that passed
// (or that policy kept from running) becomes the seal question.
function finishRound(root, jobId, res, lint, notRun, fixed = null) {
  const envMod = require('./environment');
  const Loop = require('./loop');
  const job = require('./job');
  const fresh = job.load(root, jobId);
  const g = envMod.gateProposal(root, jobId);
  require('./events').append(root, { event: 'environment_repair', job: jobId, ok: Boolean(res.ok), ...(notRun ? { not_run: true } : {}), ...(res.ok ? {} : { cmd: res.broken ? res.broken.cmd : null, problems: (res.problems || []).length }) });
  fresh.loops = fresh.loops || {};
  fresh.env_repair_pending = null;
  const prev = fresh.loops[LOOP] || null;
  const d = Loop.shouldContinue(prev, res.ok ? [] : blockersOf(res, lint), loopPolicy(root, fresh));
  fresh.loops[LOOP] = { ...d.state, for_hash: g.hash, segments: (prev || {}).segments || 0, ...(d.model ? { model: d.model } : prev && prev.model ? { model: prev.model } : {}), last_failure: res.ok ? null : res.broken || { problems: res.problems } };
  if (res.ok) {
    const diff = fullDiff(g.env, fixed) || '(no difference)';
    const short = envMod.short(fixed);
    const others = otherJobs(root, jobId);
    fresh.env_repair = { from: g.hash, hash: envMod.fullHash(fixed), short, env: fixed, diff, at: nowIso(), ...(notRun ? { not_run: true } : {}) };
    job.save(root, fresh);
    const how = notRun || 'It set up in a scratch worktree (sandboxed: no tokens, no login shell).';
    const replaces = `Sealing it replaces the repository's build environment (.factory/environment.json)${others.length ? `, which the other active jobs ${others.join(', ')} also build in` : ''}.`;
    const question = `Seal the repaired build environment ${short} for ${jobId}? ${how} ${replaces}\nWhat changes:\n${diff}\nThe whole repaired environment:\n${JSON.stringify(fixed, null, 1)}`;
    return {
      status: 'park',
      park_kind: 'environment_repair',
      park_from: 'environment',
      park_loop: null,
      park_reason: `The sealed build environment failed its check; a repaired one (${short}) waits for your seal. ${how}\n${diff}`,
      park_question: { question, options: [{ key: 'a', text: `Seal the repaired environment ${short} (reply "approve environment ${short}" or "a")` }, { key: 'b', text: 'Not this one: repair it again, with what I say' }, { key: 'c', text: `I fixed it on my machine: re-check the sealed environment (factory env check --job ${jobId} runs again)` }], recommendation: notRun ? null : 'a', cause: String(((readCheck(root, jobId) || {}).broken || {}).reason || '').slice(0, 400), seal: short },
      message: `A repaired build environment ${short} ${notRun ? 'was proposed (not run)' : 'passed its check in a scratch worktree'}; ${jobId} waits for your seal (reply "approve environment ${short}").`,
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
      park_question: { question: `The build environment still does not set up on this machine (${last}). How should it be fixed?`, options: [{ key: 'a', text: `I fixed it on my machine (installed the tool, or factory env set): re-check (factory env check --job ${jobId} runs again with a fresh machine inventory)` }, { key: 'b', text: 'Repair it again, with what I say (resume with your hint)' }, { key: 'c', text: 'Stop here (cancel job)' }], recommendation: 'a', cause: last.slice(0, 400) },
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
  state.env_repair_pending = null;
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
  state.env_repair_pending = null;
}

// ---------------------------------------------------------------- the check as a long step
// Both checks (the sealed environment's, `factory env check --job J`, and a repair candidate's,
// `factory env check --repair --job J`) run what can take long (an install, a docker pull, WSL
// I/O). Under factory drive the Bash tool has a ceiling, so they run like the plan probe (port
// review M-1): a detached child in its own session, its state sealed in
// jobs/<J>/env-check.started.json (what it checks, pid and start time, deadline, interrupted runs),
// waited for until the caller's deadline (FACTORY_DRIVE_DEADLINE, below the ceiling), and picked
// up by the next call when it ends later. A run that died (or ran far past its deadline) is killed
// and counted; after MAX_INTERRUPTED the step goes to the user's terminal (step_too_long, with
// --foreground: it runs there in the foreground, unbounded by any tool).
const STARTED = (root, jobId) => path.join(jobPaths(root, jobId).dir, 'env-check.started.json');
const RESULT = (root, jobId) => path.join(jobPaths(root, jobId).dir, 'env-check.result.json');
const MAX_INTERRUPTED = 2;
// the least of the caller's time a run needs to start in this call (tests set it lower)
const MIN_START_MS = () => (Number(process.env.FACTORY_ENVCHECK_MIN_START_MS) > 0 ? Number(process.env.FACTORY_ENVCHECK_MIN_START_MS) : 20000);

function readStarted(root, jobId) {
  const s0 = readJson(STARTED(root, jobId), null);
  return s0 && valid(s0) ? s0 : null;
}
// What this kind of check would check now: { key } (unsealed: nothing to do -> done).
function target(root, state, kind) {
  const envMod = require('./environment');
  if (kind === 'repair') {
    const p = state.env_repair_pending;
    if (!p) return { done: true };
    return { key: `repair:${p.hash}:${p.at}`, timeout: p.env.timeout_seconds, steps: envMod.commandsOf(p.env).length };
  }
  const g = envMod.gateProposal(root, state.id);
  const rec = readCheck(root, state.id);
  if (rec && rec.hash === g.hash) return { done: true, rec };
  return { key: `sealed:${g.hash}`, timeout: (g.env || {}).timeout_seconds, steps: envMod.commandsOf(g.env || {}).length };
}
function summaryOf(root, state, kind) {
  const res = readJson(RESULT(root, state.id), null);
  if (res && valid(res) && res.kind === kind) return { job: state.id, ...res.result };
  const rec = readCheck(root, state.id);
  if (kind === 'sealed' && rec) return { job: state.id, ok: rec.ok, recorded: CHECK(root, state.id), ...(rec.ok ? {} : { broken: rec.broken, problems: rec.problems }) };
  return { job: state.id, done: true };
}
function runInline(root, jobId, kind) {
  const job = require('./job');
  const state = job.load(root, jobId);
  const r = kind === 'repair' ? checkRepair(root, state) : checkForJob(root, state);
  writeJson(RESULT(root, jobId), seal({ kind, at: nowIso(), result: r }));
  return r;
}
const sleepMs = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no wait */
  }
};
function killRun(root, st) {
  const P = require('./probe');
  if (st && st.pid && P.sameProcess(st.pid, st.pid_start)) {
    try {
      process.kill(-Number(st.pid), 'SIGKILL');
    } catch {
      try {
        process.kill(Number(st.pid), 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  require('./environment').sweepChecks(root, { force: st && st.pid ? [Number(st.pid)] : [] });
}
function terminalCommand(jobId, kind) {
  return `factory env check ${kind === 'repair' ? '--repair ' : ''}--job ${jobId} --foreground`;
}

// The managed run (factory env check --job J [--repair]): { ...result } when it finished in this
// call, { pending: true } when it goes on in the background (the next call picks it up).
function runManaged(root, jobId, kind, { deadline = null, foreground = false } = {}) {
  const job = require('./job');
  const P = require('./probe');
  const until = deadline || P.callerDeadline();
  const state = job.resolve(root, jobId);
  const t = target(root, state, kind);
  if (t.done) return { ...summaryOf(root, state, kind), reused: true };
  require('./environment').sweepChecks(root);
  let st = readStarted(root, state.id);
  const same = st && st.kind === kind && st.key === t.key;
  let interrupted = same ? st.interrupted || 0 : 0;
  if (same && !st.finished) {
    // a run whose pid is not recorded yet is starting (review m-9)
    const alive = P.sameProcess(st.pid, st.pid_start) || (!st.pid && Date.now() - Date.parse(st.at) < 30000);
    const overdue = Date.now() > Date.parse(st.deadline_at) + 120000;
    if (alive && !overdue && !foreground) return waitFor(root, state.id, kind, st, until);
    killRun(root, st);
    interrupted += 1;
    require('./events').append(root, { event: 'environment_check_interrupted', job: state.id, kind, interrupted, overdue });
    writeJson(STARTED(root, state.id), seal({ ...st, finished: true, outcome: overdue ? 'overdue' : 'died', interrupted, ended_at: nowIso() }));
  }
  // the user's terminal: in the foreground, no tool ceiling
  if (foreground) {
    const r = runInline(root, state.id, kind);
    writeJson(STARTED(root, state.id), seal({ version: 1, job: state.id, kind, key: t.key, pid: process.pid, pid_start: P.procStat(process.pid) ? P.procStat(process.pid).start : null, at: nowIso(), deadline_at: nowIso(), interrupted: 0, finished: true, outcome: 'foreground' }));
    return r;
  }
  if (interrupted >= MAX_INTERRUPTED) {
    const command = terminalCommand(state.id, kind);
    require('../lib/util').fail(`The ${kind === 'repair' ? 'repair candidate\'s' : 'build environment\'s'} check was cut off ${interrupted} times before it finished. Run it in your own terminal, in the foreground (it is not human-only, it is just long): ${command}`, 'step_too_long', { step: `env check ${kind === 'repair' ? '--repair ' : ''}--job ${state.id}`, command, why: `was cut off ${interrupted} times while running` });
  }
  if (until - Date.now() < MIN_START_MS()) return { job: state.id, pending: true, started: false, ok: false, message: 'The environment check needs a fresh call to start (too little of this call\'s time is left): run it again (factory drive does).' };
  const id = require('crypto').randomBytes(8).toString('hex');
  // its own deadline: every command's cap (setup, services, prefix, teardown), plus a margin
  const per = Number(t.timeout) > 0 ? Number(t.timeout) : 1200;
  const cap = Math.min(4 * 3600, (Math.max(1, t.steps) + 5) * per + 120);
  // the record names the run before the child starts (review m-9: a child that read the file
  // first would refuse as stale); its pid follows right after the spawn
  writeJson(STARTED(root, state.id), seal({ version: 1, job: state.id, kind, key: t.key, id, pid: null, pid_start: null, at: nowIso(), deadline_at: new Date(Date.now() + cap * 1000).toISOString(), interrupted, finished: false }));
  const logFile = path.join(jobPaths(root, state.id).dir, 'env-check.log');
  const out = fs.openSync(logFile, 'w');
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'factory'), '--root', root, 'env', 'check', '--job', state.id, ...(kind === 'repair' ? ['--repair'] : []), '--child', id], { cwd: root, detached: true, stdio: ['ignore', out, out], env: { ...process.env, FACTORY_ENVCHECK_CHILD: id }, windowsHide: true });
  fs.closeSync(out);
  child.unref();
  const ps = P.procStat(child.pid);
  st = seal({ version: 1, job: state.id, kind, key: t.key, id, pid: child.pid, pid_start: ps ? ps.start : null, at: nowIso(), deadline_at: new Date(Date.now() + cap * 1000).toISOString(), interrupted, finished: false });
  const cur = readStarted(root, state.id);
  if (!cur || (cur.id === id && !cur.finished)) writeJson(STARTED(root, state.id), st);
  require('./events').append(root, { event: 'environment_check_started', job: state.id, kind, pid: child.pid, interrupted });
  return waitFor(root, state.id, kind, st, until);
}
function waitFor(root, jobId, kind, st, until) {
  const job = require('./job');
  const P = require('./probe');
  while (Date.now() < until - Math.min(3000, MIN_START_MS() / 2)) {
    const now = readStarted(root, jobId);
    if (now && now.id === st.id && now.finished) return summaryOf(root, job.load(root, jobId), kind);
    if (!P.sameProcess(st.pid, st.pid_start)) {
      sleepMs(300);
      const again = readStarted(root, jobId);
      if (again && again.id === st.id && again.finished) return summaryOf(root, job.load(root, jobId), kind);
      return runManaged(root, jobId, kind, { deadline: until });
    }
    sleepMs(250);
  }
  return { job: jobId, pending: true, started: true, ok: false, message: `The environment check is still running (its own process, pid ${st.pid}, until ${st.deadline_at} at most): run it again (factory drive does) to pick up its result; it is not started again.` };
}
// The detached child: runs the check, records it, marks its run finished.
function runChild(root, jobId, kind, id) {
  const st = readStarted(root, jobId);
  if (!st || st.id !== id) require('../lib/util').fail('This environment check run is not the current one.', 'stale');
  let r;
  try {
    r = runInline(root, jobId, kind);
  } finally {
    const now = readStarted(root, jobId);
    if (now && now.id === id) writeJson(STARTED(root, jobId), seal({ ...now, finished: true, outcome: 'finished', interrupted: 0, ended_at: nowIso() }));
  }
  return r;
}

module.exports = { runManaged, runChild, readStarted, checkRepair, finishRound, STARTED, RESULT, MAX_INTERRUPTED, recheck, fullDiff, repairOpen, repairMode, otherJobs, checkForJob, routerAction, brief, record, sealRepair, readCheck, inputHash, unifiedCommands, CHECK, REPAIR, LOOP };
