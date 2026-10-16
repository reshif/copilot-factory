'use strict';
// prove: `factory verify run`. Re-runs every task command, the contract's verify
// commands and the policy checks on the integrated build, then maps results to
// acceptance criteria. No agent involved.

const path = require('path');
const { readJson, writeJson, nowIso, fail } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const git = require('../lib/git');
const { runCommand } = require('../lib/run');
const job = require('./job');
const steps = require('./steps');
const ledger = require('./ledger');
const contractMod = require('./contract');
const planMod = require('./plan');
const tasks = require('./tasks');

function collectCommands(root, state) {
  const plan = readJson(jobPaths(root, state.id).plan, { tasks: [] });
  const parsed = contractMod.parse(contractMod.read(root, state.id));
  const map = new Map(); // cmd -> Set(AC)
  const add = (cmd, acs) => {
    if (!cmd) return;
    if (!map.has(cmd)) map.set(cmd, new Set());
    (acs || []).forEach((a) => map.get(cmd).add(a));
  };
  for (const t of plan.tasks || []) {
    for (const c of t.verify_commands || []) {
      const covers = typeof c === 'object' && c.covers && c.covers.length ? c.covers : t.criteria_ids;
      add(planMod.cmdOf(c), covers);
    }
  }
  for (const v of parsed.verifyCommands) add(v.cmd, v.covers.length ? v.covers : []);
  for (const c of state.policy.checks || []) add(typeof c === 'string' ? c : c.cmd, []);
  return { parsed, commands: [...map.entries()].map(([cmd, acs]) => ({ cmd, acs: [...acs] })) };
}

function run(root, jobId) {
  const state = job.resolve(root, jobId);
  if (!state.branch) fail('This job has no build to verify.', 'bad_input');
  const ctx = steps.context(root, state, job.load);
  if (!steps.isDone(ctx, { step: 'reconcile' })) fail('Reconcile has not produced the current build yet; run reconcile first.', 'not_ready');
  const wt = tasks.ensureJobWorktree(root, state);
  if (git.status(wt)) fail(`The job worktree has uncommitted changes:\n${git.status(wt)}`, 'dirty_worktree');
  const fingerprint = ctx.b.fingerprint;
  const L = state.policy.limits;
  const { parsed, commands } = collectCommands(root, state);
  // inside the build environment, set up in the job worktree like in each task's
  const envMod = require('./environment');
  const E = envMod.ensure(root, state, { taskId: null, wt });
  if (!E.ok) fail(`${E.broken.reason}\nThe environment is broken, not the build: fix it (factory env check, factory env set), then run factory next.`, 'environment_broken', E.broken);
  const results = commands.map((c) => ({ ...runCommand(envMod.wrap(E.env, E.vars, c.cmd), wt, { timeoutSec: L.command_timeout_seconds, reruns: L.flaky_reruns }), cmd: c.cmd, acs: c.acs }));

  const evidence = ledger.evidence(root, state.id, fingerprint);
  const anyEvidence = ledger.evidence(root, state.id);
  let changed = [];
  try {
    changed = git.changedFiles(root, state.base_commit, state.branch);
  } catch {
    changed = [];
  }
  const acs = {};
  const why = {};
  const missing = {}; // AC -> evidence types still unproven (factory next routes on them)
  for (const ac of parsed.acs) {
    const covering = results.filter((r) => r.acs.includes(ac.id));
    const ok = [];
    const bad = [];
    for (const type of ac.evidence) {
      if (type === 'test' || type === 'run') {
        if (!covering.length) bad.push(`${type}: no command covers it`);
        else if (covering.every((r) => r.pass)) ok.push(type);
        else bad.push(`${type}: ${covering.filter((r) => !r.pass).map((r) => `${r.cmd}${r.flaky ? ' (flaky)' : ''}`).join(', ')} failed`);
      } else if (type === 'human') {
        if (evidence.some((e) => e.ac === ac.id && e.type === 'human' && e.pass) || anyEvidence.some((e) => e.ac === ac.id && e.type === 'human' && e.pass && humanStillHolds(root, state, e))) ok.push('human');
        else bad.push(`human: reply "confirm ${ac.id}" after checking it yourself`);
      } else if (type === 'diff' || type === 'doc') {
        const valid = anyEvidence.filter((e) => e.ac === ac.id && e.type === type && e.pass && recordStillHolds(root, state, e, fingerprint, changed));
        if (valid.length) ok.push(type);
        else bad.push(`${type}: record it with factory evidence add ${ac.id} --type ${type} --path <${type === 'doc' ? 'file that documents it' : 'changed file'}>`);
      }
    }
    const failedCmd = covering.some((r) => !r.pass);
    acs[ac.id] = ok.length && !failedCmd ? 'proven' : failedCmd ? 'failed' : 'unproven';
    why[ac.id] = ok.length && !failedCmd ? ok : bad;
    if (acs[ac.id] !== 'proven') missing[ac.id] = bad.map((w) => w.split(':')[0]);
  }
  const policyFailures = results.filter((r) => !r.acs.length && !r.pass);
  const ok = Object.values(acs).every((s) => s === 'proven') && policyFailures.length === 0;
  const file = path.join(jobPaths(root, state.id).evidenceDir, `verify-${fingerprint.slice(0, 12)}-${Date.now()}.json`);
  const detail = { acs, why, missing, commands: results.map(({ output, ...r }) => ({ ...r, output: r.pass ? '' : output })), file };
  writeJson(file, { at: nowIso(), fingerprint, ...detail, commands: results });
  ledger.append(root, state.id, { kind: 'step', step: 'prove', ok, bound: { fingerprint }, detail });
  for (const [ac, s] of Object.entries(acs)) {
    if (s === 'proven') ledger.append(root, state.id, { kind: 'evidence', ac, type: 'verify', fingerprint, pass: true, source: file });
  }
  return { job: state.id, ok, fingerprint, acs, why, failed_commands: results.filter((r) => !r.pass).map((r) => ({ cmd: r.cmd, code: r.code, flaky: r.flaky, output: r.output })) };
}

// What a human check of a criterion rests on: the files the job changed inside the allowed paths
// of the tasks that cover it, with their blobs on the job branch. null when no task covers it.
function humanScope(root, state, ac) {
  const plan = readJson(jobPaths(root, state.id).plan, { tasks: [] });
  const paths = [...new Set((plan.tasks || []).filter((t) => (t.criteria_ids || []).includes(ac) || (t.verify_commands || []).some((c) => typeof c === 'object' && (c.covers || []).includes(ac))).flatMap((t) => t.allowed_paths || []))];
  if (!paths.length || !state.branch) return null;
  let changed = [];
  try {
    changed = git.changedFiles(root, state.base_commit, state.branch);
  } catch {
    return null;
  }
  const { matchesAny } = require('../lib/glob');
  const files = {};
  for (const f of changed.filter((x) => matchesAny(x, paths))) files[f] = blobAt(root, state, f);
  return { paths, files };
}

// A human check from an earlier build still holds when none of the files it rests on changed
// since (same blobs, no file added or removed under those paths): a fix round elsewhere leaves it.
function humanStillHolds(root, state, e) {
  if (!e.files || !Array.isArray(e.scope) || !e.scope.length) return false;
  const now = humanScope(root, state, e.ac);
  if (!now) return false;
  const a = Object.keys(e.files).sort();
  const b = Object.keys(now.files).sort();
  if (a.length !== b.length || a.some((f, i) => f !== b[i])) return false;
  return a.every((f) => e.files[f] === now.files[f]);
}

// The file's blob on the job branch (null when the build has no such file).
function blobAt(root, state, p) {
  const r = git.run(root, ['rev-parse', '--verify', '--quiet', `${state.branch}:${String(p).replace(/^\.\//, '')}`], { allowFail: true });
  return r.code === 0 && r.stdout ? r.stdout : null;
}

// A doc/diff record with a path stays valid on any build while that file's content (blob) is
// unchanged; a diff record also needs the file among the job's changes. A record without a
// path (or from before blobs were stored) holds only for the build it was made on.
function recordStillHolds(root, state, e, fingerprint, changed) {
  if (e.path && e.blob) {
    if (blobAt(root, state, e.path) !== e.blob) return false;
    return e.type !== 'diff' || changed.includes(e.path);
  }
  if (e.fingerprint !== fingerprint) return false;
  return !e.path || e.type === 'doc' || changed.includes(e.path);
}

function addEvidence(root, { jobId, ac, type, path: p, note }) {
  const state = job.resolve(root, jobId);
  if (!['diff', 'doc'].includes(type)) fail('Only diff or doc evidence can be recorded this way; test/run come from verify, human from your reply.', 'bad_input');
  const ctx = steps.context(root, state, job.load);
  if (!ctx.b.fingerprint) fail('Nothing built yet.', 'bad_input');
  let blob = null;
  if (p) {
    p = String(p).replace(/^\.\//, '');
    blob = blobAt(root, state, p);
    if (!blob) fail(`${p} is not in the build (the job branch ${state.branch}); give a path relative to the repository root.`, 'bad_input');
    if (type === 'diff') {
      let changed = [];
      try {
        changed = git.changedFiles(root, state.base_commit, state.branch);
      } catch {
        changed = [];
      }
      if (!changed.includes(p)) fail(`${p} is not changed by this job; diff evidence must point at a changed file (doc evidence may point at any file).`, 'bad_input');
    }
  }
  return ledger.append(root, state.id, { kind: 'evidence', ac: ac.toUpperCase(), type, path: p || null, blob, note: note || '', fingerprint: ctx.b.fingerprint, pass: true, source: 'agent' });
}

module.exports = { humanScope, humanStillHolds, run, addEvidence, collectCommands };
