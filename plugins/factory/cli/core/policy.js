'use strict';
// Policy = plugin defaults deep-merged with the project's .factory/policy.json.
// A job snapshots its policy at creation so later edits don't change a running job.

const { readJson, deepMerge } = require('../lib/util');
const { pluginPath, project } = require('../lib/paths');

const RISKS = ['low', 'medium', 'high'];

function defaults() {
  return readJson(pluginPath('policy', 'default-policy.json'));
}

function load(root) {
  const base = defaults();
  if (!root) return base;
  const over = readJson(project(root).policyFile, {}) || {};
  return deepMerge(base, over);
}

function floorsFile() {
  return readJson(pluginPath('policy', 'floors.json'));
}

function riskRank(r) {
  return RISKS.indexOf(r);
}

function maxRisk(a, b) {
  return riskRank(a) >= riskRank(b) ? a : b;
}

// Policy can only raise the proposed risk (e.g. hotfix and migration are floored at high).
function effectiveRisk(policy, workType, proposed) {
  const floor = (policy.risk_floor || {})[workType];
  return floor ? maxRisk(proposed, floor) : proposed;
}

module.exports = { RISKS, load, defaults, floorsFile, riskRank, maxRisk, effectiveRisk };
