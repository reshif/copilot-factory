'use strict';
// The expected behaviour, derived only from what the job declared in its sealed
// recipe.lock (the rulebook it promised to follow) — never from the factory's code.

const { sha256, canonical } = require('./io');

const RISKS = ['low', 'medium', 'high'];
const GATES = ['H1', 'H2', 'H3', 'HF', 'HS', 'EH1', 'EH2', 'EH3'];
// Steps a router may legitimately choose that are not recipe steps.
const SPECIAL_STEPS = new Set(['amend', 'A']);
// Steps whose completion the ledger records.
const LEDGER_STEPS = new Set(['clarify', 'deps', 'ground', 'decide', 'decompose', 'reconcile', 'prove', 'challenge', 'ship', 'distill', 'close', 'epic_gate', 'post_merge_challenge']);
// Decision rules that legitimately send the job backwards.
const REWIND_RULES = /^(row1|row2|row3|row4|row5|row6|cap)\./;

// Own implementation of the selection table: first matching rule wins.
function selectRecipe(selection, inputs) {
  for (const rule of (selection && selection.rules) || []) {
    const w = rule.when || {};
    if (w.epic !== undefined && Boolean(w.epic) !== Boolean(inputs.epic)) continue;
    if (w.epic === undefined && inputs.epic) continue;
    if (w.work_type && !w.work_type.includes(inputs.work_type)) continue;
    if (w.risk && !w.risk.includes(inputs.risk)) continue;
    return rule.recipe;
  }
  return null;
}

function effectiveRisk(riskFloor, workType, proposed) {
  const floor = (riskFloor || {})[workType];
  if (!floor) return proposed;
  return RISKS.indexOf(floor) > RISKS.indexOf(proposed) ? floor : proposed;
}

function recipeHash(recipe) {
  return sha256(canonical(recipe));
}

// The key that says "same rules": recipe, floors, selection and the behaviour-shaping text.
function rulebookKey(lock) {
  if (!lock) return null;
  return sha256([lock.recipe_hash, lock.floors_hash, lock.selection_hash, lock.plugin && lock.plugin.behaviour_hash].join(':'));
}

function stepIndex(recipe, step) {
  return ((recipe && recipe.steps) || []).findIndex((s) => s.step === step);
}

// Evidence, from the records, that a recipe step had been completed by time `ts`.
// Returns true / false, or null when the records can't tell (the step leaves no trace of its own).
function completedBy(job, stepDef, ts) {
  const id = stepDef.step;
  const before = (x) => !ts || x <= ts;
  const ledgerOk = (step) => job.ledger.some((e) => e.kind === 'step' && e.step === step && e.ok && before(e.at));
  if (GATES.includes(id)) {
    const approved = job.decisions.some((d) => d.action === 'human.approve' && d.gate === id && before(d.ts));
    if (approved) return true;
    if (id === 'H3' && stepDef.auto === 'plan_critique' && ledgerOk('plan_critique')) return true;
    if (id === 'H2' && stepDef.when === 'adr') {
      const decided = job.ledger.filter((e) => e.kind === 'step' && e.step === 'decide' && e.ok && before(e.at));
      const last = decided[decided.length - 1];
      if (last && last.detail && last.detail.kind !== 'adr') return true;
    }
    return false;
  }
  if (LEDGER_STEPS.has(id)) return ledgerOk(id);
  if (id === 'H4') return job.state && job.state.pr ? Boolean(job.state.pr.merged) : false;
  return null; // realize, children: proven indirectly (reconcile / epic gate require them)
}

module.exports = { RISKS, GATES, SPECIAL_STEPS, LEDGER_STEPS, REWIND_RULES, selectRecipe, effectiveRisk, recipeHash, rulebookKey, stepIndex, completedBy };
