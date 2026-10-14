'use strict';
// Recipes are human-authored, versioned data. The CLI selects one by rule and
// refuses any recipe that would omit a floor step for a risk it applies to.

const fs = require('fs');
const path = require('path');
const { readJson, fail } = require('../lib/util');
const { pluginPath } = require('../lib/paths');
const { validate } = require('../lib/schema');
const policyMod = require('./policy');

const RUN_KINDS = /^(skill:[a-z-]+|workflow:[a-z-]+|cli:[a-z -]+|gate|merge)$/;
const GATES = ['H1', 'H2', 'H3', 'HF', 'HS', 'EH1', 'EH2', 'EH3'];

function recipesDir() {
  return process.env.FACTORY_RECIPES_DIR || pluginPath('recipes');
}

function listIds() {
  return fs
    .readdirSync(recipesDir())
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.replace(/\.json$/, ''));
}

function load(id) {
  const p = path.join(recipesDir(), `${id}.json`);
  const r = readJson(p, null);
  if (!r) fail(`Recipe not found: ${id}`, 'recipe_missing');
  const errors = check(r);
  if (errors.length) fail(`Recipe ${id} is invalid:\n- ${errors.join('\n- ')}`, 'recipe_invalid', errors);
  return r;
}

function selection() {
  return readJson(path.join(recipesDir(), '_selection.json'));
}

function select({ workType, risk, epic }) {
  for (const rule of selection().rules) {
    const w = rule.when || {};
    if (w.epic !== undefined && Boolean(w.epic) !== Boolean(epic)) continue;
    if (w.epic === undefined && epic) continue;
    if (w.work_type && !w.work_type.includes(workType)) continue;
    if (w.risk && !w.risk.includes(risk)) continue;
    return rule.recipe;
  }
  fail(`No recipe rule matches work_type=${workType} risk=${risk} epic=${Boolean(epic)}`, 'no_recipe');
}

function expandFloors(risk, floorsDoc = policyMod.floorsFile()) {
  const out = [];
  const visit = (lvl) => {
    for (const item of floorsDoc.floors[lvl] || []) {
      if (item.startsWith('@')) visit(item.slice(1));
      else if (!out.includes(item)) out.push(item);
    }
  };
  visit(risk);
  return out;
}

function stepIndex(recipe, id) {
  return recipe.steps.findIndex((s) => s.step === id);
}

function stepOf(recipe, id) {
  return recipe.steps.find((s) => s.step === id) || null;
}

function lanesIn(recipe, stepId = 'challenge') {
  const s = stepOf(recipe, stepId);
  return s ? s.lanes || [] : [];
}

// Does the recipe structurally contain what a floor requires?
function floorCovered(recipe, floor) {
  const has = (id) => stepIndex(recipe, id) !== -1;
  const lanes = lanesIn(recipe);
  const lane = (l) => lanes.includes(l) || lanes.includes('all');
  switch (floor) {
    case 'contract_approved':
      return has('H1') || has('EH1');
    case 'isolation':
      return has('realize');
    case 'prove':
      return has('prove');
    case 'challenge:code':
      return lane('code');
    case 'challenge:tests':
      return lane('tests');
    case 'challenge:security':
      return lane('security');
    case 'challenge:all_before_merge':
      return lanes.includes('all') && stepIndex(recipe, 'challenge') < stepIndex(recipe, 'H4');
    case 'finding_verifiers':
      return has('challenge');
    case 'ci_reverify':
      return has('ship') && has('H4');
    case 'human_merge':
      return has('H4');
    case 'ground':
      return has('ground');
    case 'design_record':
    case 'design_critique':
      return has('decide');
    case 'plan_validated':
      return has('decompose');
    case 'threat_model': {
      const d = stepOf(recipe, 'decide');
      return Boolean(d && d.threat_model === true);
    }
    case 'H2':
      return Boolean(stepOf(recipe, 'H2') && !stepOf(recipe, 'H2').when);
    case 'H3':
      return Boolean(stepOf(recipe, 'H3') && !stepOf(recipe, 'H3').auto);
    case 'no_trial_recipes':
      return recipe.status === 'proven';
    case 'irreversible_signoff':
      return has('HS') && stepIndex(recipe, 'HS') < stepIndex(recipe, 'ship');
    default:
      return false;
  }
}

const RECIPE_SCHEMA = {
  type: 'object',
  required: ['id', 'version', 'status', 'outcome', 'steps'],
  properties: {
    id: { type: 'string', minLength: 1 },
    version: { type: 'integer', minimum: 1 },
    status: { enum: ['candidate', 'trial', 'proven', 'retired'] },
    outcome: { enum: ['change', 'findings', 'epic'] },
    description: { type: 'string' },
    applies_to: { type: 'object' },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['step', 'run'],
        properties: {
          step: { type: 'string', minLength: 1 },
          run: { type: 'string', pattern: RUN_KINDS.source },
          config: { enum: ['clarify', 'decide', 'challenge'] },
          lanes: { type: 'array', items: { type: 'string' } },
          mode: { type: 'string' },
          when: { enum: ['adr'] },
          auto: { enum: ['plan_critique'] },
          threat_model: { type: ['boolean', 'string'] },
          plan_critique: { type: 'boolean' },
        },
      },
    },
  },
};

function check(recipe) {
  const errors = validate(RECIPE_SCHEMA, recipe);
  if (errors.length) return errors;
  const ids = recipe.steps.map((s) => s.step);
  if (new Set(ids).size !== ids.length) errors.push('duplicate step ids');
  for (const s of recipe.steps) {
    if (s.run === 'gate' && !GATES.includes(s.step)) errors.push(`gate step "${s.step}" is not a known gate (${GATES.join(', ')})`);
  }
  const before = (a, b) => stepIndex(recipe, a) === -1 || stepIndex(recipe, b) === -1 || stepIndex(recipe, a) < stepIndex(recipe, b);
  const order = [
    ['clarify', 'H1'],
    ['H1', 'ground'],
    ['decide', 'H2'],
    ['decompose', 'H3'],
    ['H3', 'realize'],
    ['realize', 'reconcile'],
    ['reconcile', 'prove'],
    ['prove', 'challenge'],
    ['challenge', 'ship'],
    ['ship', 'H4'],
  ];
  for (const [a, b] of order) if (!before(a, b)) errors.push(`step "${a}" must come before "${b}"`);

  if (recipe.outcome === 'change') {
    const risks = (recipe.applies_to && recipe.applies_to.risk) || policyMod.RISKS;
    for (const risk of risks) {
      for (const floor of expandFloors(risk)) {
        if (!floorCovered(recipe, floor)) errors.push(`omits floor "${floor}" required at ${risk} risk`);
      }
    }
  } else if (!(stepIndex(recipe, 'H1') !== -1 || stepIndex(recipe, 'EH1') !== -1)) {
    errors.push('every recipe needs a human-approved contract (H1 or EH1)');
  }
  return errors;
}

function checkAll() {
  const report = {};
  for (const id of listIds()) {
    const r = readJson(path.join(recipesDir(), `${id}.json`));
    report[id] = check(r);
  }
  return report;
}

module.exports = { listIds, load, select, selection, check, checkAll, expandFloors, floorCovered, stepIndex, stepOf, lanesIn, GATES };
