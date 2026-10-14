'use strict';
// "Is this recipe step done, right now?" — one deterministic predicate per step,
// evaluated against current bindings. Nothing here trusts an agent's say-so.

const { readJson } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const git = require('../lib/git');
const ledger = require('./ledger');
const invalidation = require('./invalidation');
const recipes = require('./recipes');

function context(root, state, loadJob) {
  const recipe = recipes.load(state.recipe.id);
  const b = invalidation.current(root, state, loadJob);
  return { root, state, recipe, b, loadJob };
}

function planTasks(ctx) {
  const plan = readJson(jobPaths(ctx.root, ctx.state.id).plan, null);
  return plan && Array.isArray(plan.tasks) ? plan.tasks : [];
}

function taskBranch(state, taskId) {
  return `${state.branch}-${taskId}`;
}

function branchTree(root, branch) {
  try {
    return git.fingerprint(root, branch);
  } catch {
    return null;
  }
}

// A task is done when its latest evidence passed on the exact tree its branch now has,
// and no fix round has reopened it.
function taskDone(ctx, taskId) {
  const t = (ctx.state.tasks || {})[taskId];
  if (!t || t.needs_work) return false;
  if (!t.evidence || !t.evidence.pass) return false;
  const tree = branchTree(ctx.root, taskBranch(ctx.state, taskId));
  return Boolean(tree && tree === t.evidence.tree);
}

function allTasksDone(ctx) {
  const tasks = planTasks(ctx);
  return tasks.length > 0 && tasks.every((t) => taskDone(ctx, t.id));
}

function allTasksMerged(ctx) {
  const tasks = planTasks(ctx);
  if (!tasks.length) return false;
  return tasks.every((t) => {
    const br = taskBranch(ctx.state, t.id);
    return git.branchExists(ctx.root, br) && git.isAncestor(ctx.root, br, ctx.state.branch);
  });
}

function approved(ctx, gate, hash) {
  const a = (ctx.state.approvals || {})[gate];
  return Boolean(a && hash && a.hash === hash);
}

function gateHash(ctx, gate) {
  const { b } = ctx;
  switch (gate) {
    case 'H1':
    case 'EH1':
      return b.contract;
    case 'H2':
    case 'EH2':
      return b.design;
    case 'H3':
    case 'EH3':
      return b.plan;
    case 'HS':
      return b.fingerprint;
    case 'HF':
      return b.findings && b.design ? require('../lib/util').sha256(`${b.findings}:${b.design}`) : null;
    default:
      return null;
  }
}

function gateDocs(ctx, gate) {
  const jp = jobPaths(ctx.root, ctx.state.id);
  switch (gate) {
    case 'H1':
    case 'EH1':
      return [jp.contract];
    case 'H2':
    case 'EH2':
    case 'HF':
      return [...(gate === 'HF' ? [jp.findings] : []), ...invalidation.designFiles(ctx.root, ctx.state.id), `${jp.critiquesDir}/design.json`];
    case 'H3':
    case 'EH3':
      return [ctx.state.epic ? jp.slices : jp.plan, `${jp.critiquesDir}/plan.json`];
    case 'HS':
      return [jp.report];
    default:
      return [];
  }
}

function latestAt(ctx, step) {
  return ledger.freshStep(ctx.root, ctx.state.id, step, { fingerprint: ctx.b.fingerprint });
}

// Latest record of a step at the current fingerprint, successful or not.
function lastAtFingerprint(ctx, step) {
  const s = ledger.steps(ctx.root, ctx.state.id, step).filter((e) => (e.bound || {}).fingerprint === ctx.b.fingerprint);
  return s.length ? s[s.length - 1] : null;
}

function isDone(ctx, stepDef) {
  const { root, state, b } = ctx;
  const id = stepDef.step;
  const fresh = (step, bound) => Boolean(ledger.freshStep(root, state.id, step, bound));
  switch (id) {
    case 'clarify':
      return fresh('clarify', { contract: b.contract });
    case 'H1':
    case 'EH1':
    case 'H2':
    case 'EH2':
    case 'H3':
    case 'EH3':
    case 'HS':
    case 'HF': {
      if (id === 'H2' && stepDef.when === 'adr' && !invalidation.hasAdr(root, state.id)) return true;
      if (id === 'H3' && stepDef.auto === 'plan_critique' && fresh('plan_critique', { plan: b.plan })) return true;
      return approved(ctx, id, gateHash(ctx, id));
    }
    case 'ground':
      return fresh('ground', { contract: b.contract });
    case 'decide':
      return Boolean(b.design) && fresh('decide', { contract: b.contract, design: b.design });
    case 'decompose':
      return Boolean(b.plan) && fresh('decompose', { plan: b.plan });
    case 'realize':
      return allTasksDone(ctx);
    case 'reconcile':
      return allTasksMerged(ctx) && fresh('reconcile', { fingerprint: b.fingerprint });
    case 'prove':
      return fresh('prove', { fingerprint: b.fingerprint });
    case 'challenge':
      return fresh('challenge', state.epic ? { children: b.children } : { fingerprint: b.fingerprint });
    case 'ship':
      return Boolean(state.pr && state.pr.fingerprint === b.fingerprint);
    case 'H4':
      return Boolean(state.pr && state.pr.merged);
    case 'post_merge_challenge':
      return fresh('post_merge_challenge', {});
    case 'children':
      return Boolean(state.children && state.children.length) && state.children.every((c) => {
        try {
          return ctx.loadJob(root, c).status === 'closed';
        } catch {
          return false;
        }
      });
    case 'epic_gate':
      return fresh('epic_gate', { children: b.children });
    case 'distill':
      return fresh('distill', {});
    case 'close':
      return state.status === 'closed';
    default:
      return false;
  }
}

module.exports = { context, isDone, planTasks, taskDone, allTasksDone, allTasksMerged, taskBranch, gateHash, gateDocs, approved, latestAt, lastAtFingerprint };
