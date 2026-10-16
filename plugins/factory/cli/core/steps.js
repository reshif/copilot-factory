'use strict';
// "Is this recipe step done, right now?" — one deterministic predicate per step,
// evaluated against current bindings. Nothing here trusts an agent's say-so.

const { readJson } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const git = require('../lib/git');
const ledger = require('./ledger');
const invalidation = require('./invalidation');
const recipes = require('./recipes');

// The recipe a job runs is the one it locked at creation (recipe.lock.json, sealed): a job in
// flight keeps its steps and gates when the plugin's recipes change (an upgrade). A job whose lock
// predates recipe locking (no recipe in it) runs the current file, as before. A lock that holds a
// recipe but is invalid (a broken seal, another recipe id or version, a recipe that fails its
// checks) is refused with a clear message, never a silent switch to the current recipe (m13).
function lockProblem(root, state) {
  const lock = readJson(jobPaths(root, state.id).recipeLock, null);
  if (!lock || !lock.recipe) return { lock: null, problem: null };
  if (!require('../lib/seal').valid(lock)) return { lock, problem: 'its seal does not match (the file was edited)', resealable: true };
  if (lock.id !== state.recipe.id || lock.version !== state.recipe.version || lock.recipe.id !== state.recipe.id) return { lock, problem: `it is for ${lock.id || lock.recipe.id} v${lock.version}, but the job runs ${state.recipe.id} v${state.recipe.version}` };
  const errs = recipes.check(lock.recipe);
  if (errs.length) return { lock, problem: `its recipe fails the recipe checks: ${errs.slice(0, 3).join('; ')}` };
  return { lock, problem: null };
}

function lockedRecipe(root, state) {
  const { lock, problem, resealable } = lockProblem(root, state);
  if (!lock) return null;
  if (problem) {
    try {
      require('./events').append(root, { event: 'recipe_lock_invalid', job: state.id, problem });
    } catch {
      /* the refusal says it */
    }
    const { fail } = require('../lib/util');
    fail(`${state.id}'s recipe lock (.factory/jobs/${state.id}/recipe.lock.json) is invalid: ${problem}. The factory does not silently run the current ${state.recipe.id} recipe instead (the job's steps and gates could change under it). Restore the file${resealable ? ', or run `factory reseal` in your own terminal to accept it as it now is' : ''}.`, 'recipe_lock_invalid');
  }
  return lock.recipe;
}

function context(root, state, loadJob) {
  const recipe = lockedRecipe(root, state) || recipes.load(state.recipe.id);
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
// no fix round has reopened it, and that evidence came after its builder's latest reply,
// which was "done" (a later builder that crashed, blocked or timed out voids an older pass).
function taskDone(ctx, taskId) {
  const t = (ctx.state.tasks || {})[taskId];
  if (!t || t.needs_work) return false;
  if (!t.evidence || !t.evidence.pass) return false;
  if (t.builder && (t.builder.outcome !== 'done' || t.builder.attempt !== (t.attempts || 0) || t.evidence.builder_at !== t.builder.at)) return false;
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

// A gate that approves more than its own document (0.10.0): the recipe step's `combined` list
// (design, plan, environment). At medium risk H3 is one gate for design + plan + the build
// environment the plan runs in; approving it seals that environment (human.approve), so
// "confirm environment" is no separate reply. null for an ordinary gate.
function combinedOf(ctx, gate) {
  const s = ctx.recipe.steps.find((x) => x.step === gate && x.run === 'gate');
  return s && Array.isArray(s.combined) && s.combined.length ? s.combined : null;
}

// The parts a combined gate binds, by name: { design, plan, environment: { status, hash, … } }.
function combinedParts(ctx, gate) {
  const list = combinedOf(ctx, gate);
  if (!list) return null;
  const out = {};
  if (list.includes('design')) out.design = ctx.b.design || null;
  if (list.includes('plan')) out.plan = ctx.b.plan || null;
  if (list.includes('environment')) out.environment = require('./environment').gateProposal(ctx.root, ctx.state.id);
  return out;
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
    case 'EH3': {
      const parts = gate === 'H3' ? combinedParts(ctx, gate) : null;
      if (!parts || !b.plan) return b.plan;
      if ('design' in parts && !parts.design) return null;
      return require('../lib/util').sha256(require('../lib/util').stableStringify({ design: parts.design, plan: parts.plan, environment: parts.environment ? parts.environment.hash : undefined }));
    }
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
      return [...(gate === 'HF' ? [jp.findings] : []), ...invalidation.designFiles(ctx.root, ctx.state.id), `${jp.critiquesDir}/design.json`, ...(require('fs').existsSync(require('./deps').LEDGER(ctx.root, ctx.state.id)) ? [require('./deps').LEDGER(ctx.root, ctx.state.id)] : [])];
    case 'H3':
    case 'EH3': {
      const list = gate === 'H3' ? combinedOf(ctx, gate) || [] : [];
      const fs = require('fs');
      const deps = require('./deps');
      return [
        ...(list.includes('design') ? [...invalidation.designFiles(ctx.root, ctx.state.id), `${jp.critiquesDir}/design.json`, deps.LEDGER(ctx.root, ctx.state.id)] : []),
        ctx.state.epic ? jp.slices : jp.plan,
        `${jp.critiquesDir}/plan.json`,
        ...(list.length ? [require('path').join(jp.dir, 'probe.json')] : []),
        ...(list.includes('environment') ? [require('path').join(jp.dir, 'environment.proposed.json')] : []),
      ].filter((f, i, a) => a.indexOf(f) === i && (fs.existsSync(f) || f.endsWith('.json') && /critiques/.test(f)));
    }
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

// Local mode: ship pushes nothing (policy ship.mode "local", or no "origin" remote), so the
// irreversible sign-off HS has nothing outward to sign off: the human's own merge (H4) is the step.
// ONE predicate for "is this a local ship?" and "may ship push?": the router (HS, the push
// approval), the floors and `factory ship` all use it, so nothing skipped as local ever pushes.
// A job already shipped counts its earlier mode only for that same build (a rebuilt job asks again).
function isLocalShip(ctx) {
  const { root, state } = ctx;
  const live = (() => {
    try {
      return require('./policy').load(root);
    } catch {
      return {};
    }
  })();
  // the repository's setting (its live policy); a job snapshot from before 0.9.0 has none
  const ship = live.ship || (state.policy && state.policy.ship) || {};
  if (ship.mode === 'local') return true;
  let remote = false;
  try {
    remote = git.hasRemote(root);
  } catch {
    remote = false;
  }
  if (!remote) return true;
  if (state.pr && state.pr.mode && state.pr.fingerprint && state.pr.fingerprint === ctx.b.fingerprint) return state.pr.mode === 'local';
  return false;
}
const shipsLocally = isLocalShip;

function isDone(ctx, stepDef) {
  const { root, state, b } = ctx;
  const id = stepDef.step;
  const fresh = (step, bound) => Boolean(ledger.freshStep(root, state.id, step, bound));
  switch (id) {
    case 'clarify': {
      // Before H1, clarify v3 is done only when its record passed the readiness check for this
      // exact contract and no denial waits to be read back; after H1 the step record decides
      // (an approved amendment carries it forward).
      const ok = fresh('clarify', { contract: b.contract });
      const approved = state.approvals && (state.approvals.H1 || state.approvals.EH1);
      return approved ? ok : ok && require('./clarify').ready(root, state);
    }
    case 'H1':
    case 'EH1':
    case 'H2':
    case 'EH2':
    case 'H3':
    case 'EH3':
    case 'HS':
    case 'HF': {
      if (id === 'H2' && stepDef.when === 'adr' && !invalidation.hasAdr(root, state.id)) return true;
      // a plan God Eye approved skips H3 at low risk, unless the gate would seal a build
      // environment: only the human accepts commands that run on this machine
      if (id === 'H3' && stepDef.auto === 'plan_critique' && fresh('plan_critique', { plan: b.plan }) && !require('./environment').needsConfirmation(root, state.id)) return true;
      if (id === 'HS' && shipsLocally(ctx)) return true;
      return approved(ctx, id, gateHash(ctx, id));
    }
    case 'deps':
      // once per contract; packages ground or the planner ask for later are fetched where they
      // are asked for (ground's factory.fetchDeps, decompose's record)
      return fresh('deps', { contract: b.contract });
    case 'ground':
      return fresh('ground', { contract: b.contract });
    case 'decide':
      return Boolean(b.design) && fresh('decide', { contract: b.contract, design: b.design });
    case 'decompose': {
      // under a gate that approves design and plan together, a revised design re-plans
      const withDesign = (combinedOf(ctx, 'H3') || []).includes('design');
      return Boolean(b.plan) && fresh('decompose', withDesign ? { plan: b.plan, design: b.design } : { plan: b.plan });
    }
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

module.exports = { lockProblem, isLocalShip, lockedRecipe, combinedOf, combinedParts, context, isDone, shipsLocally, planTasks, taskDone, allTasksDone, allTasksMerged, taskBranch, gateHash, gateDocs, approved, latestAt, lastAtFingerprint };
