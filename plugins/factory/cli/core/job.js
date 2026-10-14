'use strict';
// Job lifecycle storage: create, load, save, current pointer.

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, writeText, readText, exists, mkdirp, nowIso, fail } = require('../lib/util');
const { project, jobPaths } = require('../lib/paths');
const git = require('../lib/git');
const policyMod = require('./policy');
const recipes = require('./recipes');
const contract = require('./contract');
const sealMod = require('../lib/seal');

function listJobIds(root) {
  const dir = project(root).jobsDir;
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => /^J-\d+$/.test(d))
    .sort();
}

function nextJobId(root) {
  const ids = listJobIds(root).map((d) => parseInt(d.slice(2), 10));
  const n = ids.length ? Math.max(...ids) + 1 : 1;
  return `J-${String(n).padStart(4, '0')}`;
}

function load(root, jobId) {
  const s = readJson(jobPaths(root, jobId).state, null);
  if (!s) fail(`Job ${jobId} not found`, 'job_missing');
  if (!sealMod.valid(s)) {
    fail(`${jobId}/state.json was changed outside the factory CLI (its seal doesn't match). Restore it, or if you edited it on purpose, run \`factory reseal --job ${jobId}\` from your own terminal.`, 'tampered');
  }
  return s;
}

function save(root, state) {
  state.updated_at = nowIso();
  const sealed = sealMod.seal(state);
  state.seal = sealed.seal;
  writeJson(jobPaths(root, state.id).state, sealed);
  return state;
}

// Human-only: accept a hand-edited state.json.
function reseal(root, jobId) {
  const s = readJson(jobPaths(root, jobId).state, null);
  if (!s) fail(`Job ${jobId} not found`, 'job_missing');
  save(root, s);
  return { job: jobId, resealed: true };
}

function current(root) {
  const t = readText(project(root).currentFile, '');
  return t && t.trim() ? t.trim() : null;
}

function setCurrent(root, jobId) {
  writeText(project(root).currentFile, `${jobId}\n`);
}

function resolve(root, jobId) {
  const id = jobId || current(root);
  if (!id) fail('No job given and no current job. Start one with `factory job new` or pick one with `factory use <job>`.', 'no_job');
  return load(root, id);
}

// The rulebook a job promises to follow, frozen and sealed at creation: the full recipe,
// the floors, the selection rules and inputs that chose it, and a hash of the plugin's
// behaviour-shaping text (skills, agents, workflows). The inspector audits against this.
function rulebookSnapshot({ recipe, policy, workType, risk, effRisk, epic }) {
  const fs = require('fs');
  const path = require('path');
  const { pluginPath, PLUGIN_ROOT } = require('../lib/paths');
  const { sha256, stableStringify } = require('../lib/util');
  const behaviour = [];
  for (const dir of ['skills', 'agents', 'workflows']) {
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const f of fs.readdirSync(d).sort()) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else behaviour.push(`${path.relative(PLUGIN_ROOT, p)}:${sha256(fs.readFileSync(p))}`);
      }
    };
    walk(pluginPath(dir));
  }
  const manifest = readJson(pluginPath('.claude-plugin', 'plugin.json'), {});
  const floors = policyMod.floorsFile();
  const selection = recipes.selection();
  return sealMod.seal({
    id: recipe.id,
    version: recipe.version,
    selected_at: nowIso(),
    inputs: { work_type: workType, risk_proposed: risk, risk: effRisk, epic: Boolean(epic) },
    recipe,
    recipe_hash: sha256(stableStringify(recipe)),
    floors,
    floors_hash: sha256(stableStringify(floors)),
    selection,
    selection_hash: sha256(stableStringify(selection)),
    risk_floor: policy.risk_floor || {},
    limits: policy.limits,
    required_lanes: policy.required_lanes,
    plugin: { name: manifest.name || 'factory', version: manifest.version || null, root: PLUGIN_ROOT, behaviour_hash: sha256(behaviour.join('\n')) },
  });
}

function create(root, { title, workType, risk, epic = false, parent = null, sliceId = null, contractText = null, followupOf = null }) {
  const policy = policyMod.load(root);
  if (!policy.work_types.includes(workType)) fail(`Unknown work type "${workType}". Use one of: ${policy.work_types.join(', ')}`, 'bad_input');
  if (!policyMod.RISKS.includes(risk)) fail(`Unknown risk "${risk}". Use low, medium or high.`, 'bad_input');
  const effRisk = policyMod.effectiveRisk(policy, workType, risk);
  if (parent) {
    const p = load(root, parent);
    if (p.parent) fail(`Tree depth cap: ${parent} is already a child; max depth is ${policy.limits.max_tree_depth}.`, 'depth_cap');
  }

  const id = nextJobId(root);
  const recipeId = recipes.select({ workType, risk: effRisk, epic });
  const recipe = recipes.load(recipeId);
  if (effRisk === 'high' && recipe.status !== 'proven') fail(`Recipe ${recipeId} is ${recipe.status}; high-risk jobs only run proven recipes.`, 'floor');

  const proj = readJson(project(root).projectFile);
  const base = policy.base_branch || proj.base_branch || git.currentBranch(root);
  const baseCommit = git.revParse(root, base);
  const branch = `factory/${id}`;
  if (!epic) git.run(root, ['branch', branch, baseCommit]);

  const jp = jobPaths(root, id);
  mkdirp(jp.dir);
  writeText(jp.contract, contractText || contract.template({ title, workType, risk: effRisk, epic }));
  writeJson(jp.recipeLock, rulebookSnapshot({ recipe, policy, workType, risk, effRisk, epic }));

  const state = {
    id,
    title,
    created_at: nowIso(),
    work_type: workType,
    risk: effRisk,
    risk_proposed: risk,
    epic,
    parent,
    slice_id: sliceId,
    followup_of: followupOf,
    recipe: { id: recipe.id, version: recipe.version },
    policy,
    base_branch: base,
    base_commit: baseCommit,
    branch: epic ? null : branch,
    status: 'active',
    park: null,
    pending_gate: null,
    approvals: {},
    denials: [],
    waivers: {},
    counters: {
      clarify_rounds: 0,
      intent_rounds: 0,
      decide_rounds: 0,
      decompose_rounds: 0,
      review_rounds: 0,
      verify_fix_rounds: 0,
      agent_runs: 0,
      post_merge_rounds: 0,
    },
    asked_questions: [],
    question_log: [],
    tasks: {},
    integration: null,
    pr: null,
    amendment: null,
    children: [],
    last_decision: null,
    repeat: { key: null, count: 0 },
  };
  save(root, state);
  if (parent) {
    const p = load(root, parent);
    p.children = [...new Set([...(p.children || []), id])];
    save(root, p);
  }
  setCurrent(root, id);
  return state;
}

function tasksOf(root, state) {
  const plan = readJson(jobPaths(root, state.id).plan, null);
  return plan && Array.isArray(plan.tasks) ? plan.tasks : [];
}

module.exports = { reseal, listJobIds, nextJobId, load, save, current, setCurrent, resolve, create, tasksOf, path };
