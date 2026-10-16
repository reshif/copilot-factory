'use strict';
// Hard floors: evaluated from the ledger and state, on the current fingerprint.
// Used by `factory finalize`, the Stop hook, ship, and CI.

const { readJson } = require('../lib/util');
const { matchesAny } = require('../lib/glob');
const git = require('../lib/git');
const policyMod = require('./policy');
const recipes = require('./recipes');
const steps = require('./steps');
const invalidation = require('./invalidation');

function challengeRecord(ctx) {
  return steps.lastAtFingerprint(ctx, 'challenge');
}

function lanesPassed(ctx) {
  const r = challengeRecord(ctx);
  return (r && r.detail && r.detail.lanes) || {};
}

function uiChanged(ctx) {
  const { root, state } = ctx;
  if (!state.branch) return false;
  try {
    const files = git.changedFiles(root, state.base_commit, state.branch);
    return files.some((f) => matchesAny(f, state.policy.ui_paths));
  } catch {
    return false;
  }
}

// Every lane that "all lanes" means for this job right now.
function allLanes(ctx) {
  const lanes = [...(ctx.state.policy.required_lanes.high || ['code', 'tests', 'security'])];
  if (uiChanged(ctx)) lanes.push('ux');
  return [...new Set(lanes)];
}

function check(ctx, floor) {
  const { state, b, root } = ctx;
  const a = state.approvals || {};
  const lanes = lanesPassed(ctx);
  switch (floor) {
    case 'contract_approved':
      return steps.approved(ctx, state.epic ? 'EH1' : 'H1', b.contract);
    case 'intent_grounded':
      return require('./intent').floorOk(ctx);
    case 'isolation':
      return steps.allTasksDone(ctx);
    case 'prove':
      return Boolean(steps.latestAt(ctx, 'prove'));
    case 'challenge:code':
    case 'challenge:tests':
    case 'challenge:security':
      return lanes[floor.split(':')[1]] === 'pass';
    case 'challenge:all_before_merge':
      return allLanes(ctx).every((l) => lanes[l] === 'pass');
    case 'finding_verifiers': {
      const r = challengeRecord(ctx);
      if (!r) return false;
      const serious = ((r.detail && r.detail.findings) || []).filter((f) => ['blocker', 'major'].includes(f.severity));
      return serious.every((f) => ['confirmed', 'refuted', 'accepted', 'dismissed'].includes(f.status));
    }
    // No blocker/major finding left unverified by the job's latest review (whatever build it
    // ran on): a verifier timeout never turns into a pass.
    case 'no_unverified_serious':
      return openUnverifiedFindings(ctx).length === 0;
    case 'ci_reverify': {
      if (state.waivers && state.waivers.ci_reverify) return true;
      const check = state.policy.ci.required_check;
      return Boolean(state.pr && state.pr.checks && state.pr.checks[check] === 'success');
    }
    case 'human_merge':
      return Boolean(state.pr && state.pr.merged);
    case 'ground':
      return steps.isDone(ctx, { step: 'ground' });
    case 'design_record':
      return Boolean(b.design) && steps.isDone(ctx, { step: 'decide' });
    case 'design_critique': {
      const c = readJson(`${require('../lib/paths').jobPaths(root, state.id).critiquesDir}/design.json`, null);
      if (!c || !require('../lib/seal').valid(c) || c.hash !== b.design) return false;
      // approved by the critics, or stopped (ceiling or no progress) and the human approved the
      // design at its gate (H2, or the combined design + plan gate)
      const humanSaw = steps.approved(ctx, 'H2', b.design) || (Boolean(a.H3 && a.H3.design === b.design) && steps.approved(ctx, 'H3', steps.gateHash(ctx, 'H3')));
      return c.verdict === 'approve' || ((c.rounds >= state.policy.limits.max_design_critique_rounds || ['ceiling', 'no_progress', 'critic_failed'].includes(c.stop)) && humanSaw);
    }
    case 'plan_validated':
      return steps.isDone(ctx, { step: 'decompose' });
    case 'threat_model':
      return invalidation.designFiles(root, state.id).some((f) => f.endsWith('threat-model.md')) && steps.isDone(ctx, { step: 'decide' });
    case 'H2':
      return steps.approved(ctx, 'H2', b.design);
    case 'H3':
      return steps.approved(ctx, 'H3', steps.gateHash(ctx, 'H3')) && a.H3.via !== 'policy';
    case 'no_trial_recipes':
      return ctx.recipe.status === 'proven';
    case 'irreversible_signoff':
      // local mode pushes nothing outward: the human's own merge is the irreversible step
      return steps.approved(ctx, 'HS', b.fingerprint) || steps.shipsLocally(ctx);
    default:
      return false;
  }
}

function openUnverifiedFindings(ctx) {
  const all = require('./ledger').steps(ctx.root, ctx.state.id, 'challenge');
  return require('./review').openUnverified(all.length ? all[all.length - 1] : null);
}

// mode: 'before_ship' skips floors that can only be met after merge.
function evaluate(ctx, mode = 'full') {
  const { state } = ctx;
  const doc = policyMod.floorsFile();
  let required;
  if (state.epic) required = ['contract_approved'];
  else if (ctx.recipe.outcome === 'findings') required = ['contract_approved'];
  else required = recipes.expandFloors(state.risk, doc);
  if (mode === 'before_ship') required = required.filter((f) => !doc.after_merge.includes(f));
  const results = required.map((f) => ({ floor: f, ok: check(ctx, f) }));
  return { mode, risk: state.risk, ok: results.every((r) => r.ok), results, missing: results.filter((r) => !r.ok).map((r) => r.floor) };
}

module.exports = { evaluate, check, allLanes, uiChanged, openUnverifiedFindings };
