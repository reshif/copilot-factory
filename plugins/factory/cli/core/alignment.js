'use strict';
// The alignment vector: six checks evaluated in order. The first failing one decides
// where the job goes next. It gates and routes; nothing learns from it.
//
//   1 contract_approved        the contract has ever been approved (H1 / EH1)
//   2 no_drift                 approved contract/plan unchanged; no files outside allowed or into protected paths
//   3 floors_satisfied_so_far  no pre-build floor step undone once building started; no pre-merge floor undone once shipped
//   4 no_confirmed_serious     no confirmed blocker/major finding on the current fingerprint (not already scheduled)
//   5 acs_proven               the latest proof on the current fingerprint passed (or none yet)
//   6 no_stale_evidence        no proof recorded only for an older fingerprint

const { readJson } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const { matchesAny } = require('../lib/glob');
const git = require('../lib/git');
const ledger = require('./ledger');
const steps = require('./steps');

const PRE_BUILD = ['H1', 'EH1', 'ground', 'decide', 'H2', 'EH2', 'decompose', 'H3', 'EH3'];
const PRE_MERGE = ['prove', 'challenge', 'HS'];

function buildStarted(state) {
  return Object.values(state.tasks || {}).some((t) => t.started_at);
}

function recordKey(rec) {
  return rec ? `${rec.step}@${rec.at}` : null;
}

function seriousConfirmed(rec) {
  const findings = (rec && rec.detail && rec.detail.findings) || [];
  return findings.filter((f) => ['blocker', 'major'].includes(f.severity) && f.status === 'confirmed');
}

function evaluate(ctx) {
  const { root, state, recipe, b } = ctx;
  const v = {
    contract_approved: true,
    no_drift: true,
    floors_satisfied_so_far: true,
    no_confirmed_serious: true,
    acs_proven: null,
    no_stale_evidence: true,
  };
  const detail = {};
  const gate0 = state.epic ? 'EH1' : 'H1';
  const approvals = state.approvals || {};

  // 1
  if (!approvals[gate0]) v.contract_approved = false;

  // 2
  if (approvals[gate0] && approvals[gate0].hash !== b.contract) {
    v.no_drift = false;
    detail.drift = 'contract';
  }
  const planGate = state.epic ? 'EH3' : 'H3';
  if (v.no_drift && approvals[planGate] && b.plan && approvals[planGate].hash !== b.plan && (buildStarted(state) || (state.children || []).length)) {
    v.no_drift = false;
    detail.drift = 'plan';
  }
  if (v.no_drift && state.branch && ledger.lastStep(root, state.id, 'reconcile')) {
    const plan = readJson(jobPaths(root, state.id).plan, { tasks: [] });
    const allowed = (plan.tasks || []).flatMap((t) => t.allowed_paths || []);
    let changed = [];
    try {
      changed = git.changedFiles(root, state.base_commit, state.branch).filter((f) => !f.startsWith('.factory-ship/'));
    } catch {
      changed = [];
    }
    const outside = changed.filter((f) => !matchesAny(f, allowed));
    const prot = changed.filter((f) => matchesAny(f, state.policy.protected_paths));
    if (outside.length || prot.length) {
      v.no_drift = false;
      detail.drift = 'scope';
      detail.outside = [...new Set([...outside, ...prot])].slice(0, 20);
    }
  }

  // 3
  const isDone = (id) => steps.isDone(ctx, steps_def(recipe, id));
  if (buildStarted(state)) {
    const missing = recipe.steps.find((s) => PRE_BUILD.includes(s.step) && !steps.isDone(ctx, s));
    if (missing) {
      v.floors_satisfied_so_far = false;
      detail.missing_step = missing.step;
    }
  }
  if (v.floors_satisfied_so_far && state.pr && state.pr.fingerprint === b.fingerprint) {
    const missing = recipe.steps.find((s) => PRE_MERGE.includes(s.step) && !steps.isDone(ctx, s));
    if (missing) {
      v.floors_satisfied_so_far = false;
      detail.missing_step = missing.step;
    }
  }

  // 4
  const ch = steps.lastAtFingerprint(ctx, 'challenge');
  const serious = seriousConfirmed(ch);
  if (serious.length && !(state.fix && state.fix.source === recordKey(ch))) {
    v.no_confirmed_serious = false;
    detail.challenge_record = recordKey(ch);
    detail.serious = serious;
  }

  // 5
  const pr = steps.lastAtFingerprint(ctx, 'prove');
  if (pr) {
    const acs = (pr.detail && pr.detail.acs) || {};
    const ids = Object.keys(acs);
    v.acs_proven = ids.length ? ids.filter((k) => acs[k] === 'proven').length / ids.length : pr.ok ? 1 : 0;
    if (!pr.ok && !(state.fix && state.fix.source === recordKey(pr))) {
      detail.prove_record = recordKey(pr);
      detail.prove_failures = pr.detail || {};
    }
  }

  // 6
  const anyProve = ledger.steps(root, state.id, 'prove').filter((e) => e.ok);
  if (anyProve.length && b.fingerprint && !steps.latestAt(ctx, 'prove') && isDone('reconcile')) {
    v.no_stale_evidence = false;
  }

  const order = ['contract_approved', 'no_drift', 'floors_satisfied_so_far', 'no_confirmed_serious', 'acs_proven', 'no_stale_evidence'];
  let firstFailing = null;
  for (const k of order) {
    if (k === 'acs_proven') {
      if (detail.prove_record) {
        firstFailing = k;
        break;
      }
      continue;
    }
    if (v[k] === false) {
      firstFailing = k;
      break;
    }
  }
  return { vector: v, first_failing: firstFailing, detail };
}

function steps_def(recipe, id) {
  return recipe.steps.find((s) => s.step === id) || { step: id };
}

module.exports = { evaluate, recordKey, seriousConfirmed, PRE_BUILD };
